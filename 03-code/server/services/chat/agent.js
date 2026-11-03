/**
 * 对话入口（薄层）。两种引擎由 `config.chat.engine` 分派：
 *
 *   legacy —— 原实现，一字未改地保留在下半部分。每问 1 次上游请求 +（0 或 1）次检索，
 *             不给模型 tool calling（D12 定案），检索时机由确定性规则决定。
 *   tools  —— 参照 dsh harness 重写：模型用工具自己决定看什么（见 pipeline.js / loop.js / registry.js），
 *             事件流多 `tool` / `tool_result` 两种。
 *
 * 之所以两种并存：legacy 是**回退通道**。改 `config.chat.engine = 'legacy'` 就能退回旧行为，
 * 不用回滚代码，也不用动数据库。
 *
 * 本文件只保留三件事：入口分派、legacy 引擎、滚动摘要。会话读写搬到 session.js，
 * 引用装配搬到 citations.js，取消的进行中表搬到 runtime.js。
 */
import { config } from '../../config.js';
import { all, get, run } from '../../db.js';
import { AppError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { hasKey, streamChat } from '../llm/client.js';
import { mockEnabled, resolveModel } from '../translate/engines/registry.js';
import { assembleCitations } from './citations.js';
import { buildBlocks, buildContext, budget } from './context.js';
import { postMessageTools } from './pipeline.js';
import { parseCitations, CHAT_SYSTEM_TEMPLATE } from './prompts.js';
import { retrieve, decideRetrieval, retrievalFingerprint } from './retrieval.js';
import * as rt from './runtime.js';
import {
  createChat,
  deleteChat,
  insertAssistantMessage,
  insertUserMessage,
  lastContextMeta,
  listChats,
  listMessages,
  loadChat,
  loadHistory,
  loadSelectionContext,
  normalizeSelection,
  setFeedback,
} from './session.js';

const log = createLogger('chat');

export { createChat, listChats, listMessages, setFeedback, deleteChat, assembleCitations, CHAT_SYSTEM_TEMPLATE };

/** 当前生效的引擎（配置写错时安全回落到 legacy） */
export function activeEngine() {
  const v = String((config.chat && config.chat.engine) || 'legacy');
  return v === 'tools' ? 'tools' : 'legacy';
}

// ── 一轮对话（入口） ─────────────────────────────────────────────────────────

/**
 * @param {number} chatId
 * @param {{content:string, selection?:{pageNo:number, segmentIds:number[], text:string}|null}} body
 * @param {import('express').Response} res
 */
export async function postMessage(chatId, body, res) {
  if (activeEngine() === 'tools') return postMessageTools(chatId, body, res);
  return postMessageLegacy(chatId, body, res);
}

/**
 * 取消：中断上游，已产出部分保留并标 truncated=1。两个引擎共用。
 * @param {number} chatId
 */
export function cancelTurn(chatId) {
  const cur = rt.getTurn(chatId);
  if (!cur) return { canceled: false, reason: 'no-inflight' };
  cur.ctl.abort();
  log.info('chat.cancel', { chatId, engine: cur.engine || 'legacy' });
  return { canceled: true, engine: cur.engine || 'legacy' };
}

// ── legacy 引擎（原实现，行为不变） ──────────────────────────────────────────

async function postMessageLegacy(chatId, body, res) {
  const { chat, work, asset } = loadChat(chatId);
  const content = String((body && body.content) || '').trim();
  if (!content) throw new AppError('E_BAD_REQUEST', '缺少 content', { field: 'content' });
  if (content.length > 4000) throw new AppError('E_BAD_REQUEST', 'content 超过 4000 字符', { field: 'content' });

  const selection = normalizeSelection(body && body.selection, asset);
  const history = loadHistory(chat.id);

  // 先落用户消息（即使后续失败也能看到自己问了什么）
  const userMsgId = insertUserMessage(chat, content);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15000);

  const ctl = new AbortController();
  rt.registerTurn(chat.id, { messageId: userMsgId, ctl, engine: 'legacy' });
  // 整轮 90s 上限（§9.1.4 防跑飞）
  const turnTimer = setTimeout(() => ctl.abort(), config.chat.timeoutMs || 90000);
  const cleanup = () => {
    clearInterval(heartbeat);
    clearTimeout(turnTimer);
    rt.clearTurn(chat.id);
  };

  // 客户端断开 → 中止上游；已产出部分落库并标 truncated
  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      ctl.abort();
    }
  });

  let assistantText = '';
  let persisted = false;
  let assistantMsgId = null;

  const persistAssistant = ({ truncated, errorCode = null, citations = [], contextMeta = null, usage = null, latencyMs = null, retrievalMiss = false }) => {
    if (persisted) return assistantMsgId;
    persisted = true;
    assistantMsgId = insertAssistantMessage(chat, {
      content: assistantText,
      citations,
      contextMeta,
      usage,
      latencyMs,
      errorCode,
      truncated,
      retrievalMiss,
    });
    return assistantMsgId;
  };

  try {
    const assetId = asset ? asset.id : null;
    let hits = [];
    let retrievalMeta = { rewritten: false, keywords: null, mocked: false, reason: 'no-asset' };

    if (assetId) {
      // 检索决策（确定性）：无块 → 必须检索；否则看关键词命中率；同指纹跳过（打转检测）
      const lastMeta = lastContextMeta(chat.id);
      const fingerprint = retrievalFingerprint(content, selection ? selection.segmentIds : []);
      const decision = decideRetrieval({
        query: selection && selection.text ? `${content} ${selection.text}` : content,
        blocks: lastMeta.blocks || [],
        fingerprint,
        lastFingerprint: lastMeta.fingerprint || null,
      });
      if (decision.need) {
        const r = await retrieve({ assetId, query: selection && selection.text ? `${content} ${selection.text}` : content });
        hits = r.hits;
        retrievalMeta = { ...r, decision: decision.reason, fingerprint };
      } else {
        hits = lastMeta.hits || [];
        retrievalMeta = { rewritten: false, keywords: null, mocked: false, reason: `skip:${decision.reason}`, fingerprint, decision: decision.reason };
      }
    }

    const selectionContext = selection ? loadSelectionContext(assetId, selection) : [];
    const { blocks } = buildBlocks(hits, budget().retrieve);
    const { messages, meta } = buildContext({
      work,
      summary: chat.summary,
      blocks,
      history,
      question: content,
      selection,
      selectionContext,
    });
    meta.retrieval = { ...retrievalMeta, hits: hits.length, hitLangs: hits.slice(0, 8).map((h) => h.hitLang) };
    meta.fingerprint = retrievalMeta.fingerprint || null;
    meta.hits = hits.slice(0, 12).map((h) => ({ segmentId: h.segmentId, pageNo: h.pageNo, ord: h.ord, text: h.text, textDst: h.textDst || null, hitLang: h.hitLang }));

    // 两侧索引全空（含改写兜底重试后）→ 这是硬事实，落库 + 推给前端（不能只靠提示词让模型自觉）
    const retrievalMiss = assetId ? hits.length === 0 : false;
    meta.retrieval = { ...meta.retrieval, retrievalMiss };

    // 先发 meta（前端据此建气泡），再推 delta —— 顺序不能反（§8.7）
    send('meta', { messageId: userMsgId, citationsPreview: 0, retrieval: meta.retrieval, contextChars: meta.chars, retrievalMiss });

    const result = await runMockOrReal({
      chat,
      messages,
      signal: ctl.signal,
      hits,
      onDelta: (d) => {
        assistantText += d;
        send('delta', { text: d });
      },
    });

    assistantText = result.text || assistantText;
    const parsed = parseCitations(assistantText);
    const citations = assembleCitations(assetId, parsed);
    if (citations.length) send('citation', { citations });
    persistAssistant({
      truncated: false,
      citations,
      contextMeta: meta,
      usage: result.usage,
      latencyMs: result.latencyMs,
      retrievalMiss,
    });
    send('done', {
      messageId: assistantMsgId,
      usage: result.usage || { promptTokens: null, completionTokens: null },
      latencyMs: result.latencyMs,
      citations: citations.length,
      noCitation: citations.length === 0,
      retrievalMiss,
      truncated: false,
    });
    cleanup();
    res.end();

    // 轮次结束再做摘要压缩（一次压缩 + 增量追加）
    try {
      maybeCompressSummary(chat.id);
    } catch (e) {
      log.warn('chat.summary_failed', { chatId: chat.id, message: e.message });
    }
  } catch (e) {
    const code = e.code || (clientClosed ? 'E_CANCELED' : 'E_UPSTREAM');
    const truncated = clientClosed || code === 'E_CANCELED';
    const parsed = parseCitations(assistantText);
    const citations = assembleCitations(asset ? asset.id : null, parsed);
    persistAssistant({ truncated, errorCode: truncated ? 'E_CANCELED' : code, citations, latencyMs: null });
    if (!clientClosed) {
      send('error', { code, message: e.message });
    }
    cleanup();
    if (!res.writableEnded) res.end();
    log.warn('chat.turn_failed', { chatId: chat.id, code, message: e.message, keptChars: assistantText.length });
  }
}

async function runMockOrReal({ chat, messages, signal, onDelta, hits }) {
  if (mockEnabled()) {
    // 假引擎：固定文本 + **一个合法引用**（有命中引用第一条，无命中则不引用）
    const cite = hits && hits.length ? `[p${hits[0].pageNo}#${hits[0].ord}]` : '';
    const text = hits && hits.length
      ? `（mock 引擎）根据检索到的段落，这篇文献讨论了该问题 ${cite}。这是测试用固定回答，未调用真实模型。`
      : '（mock 引擎）未检索到相关段落，因此无法依据原文回答。这是测试用固定回答，未调用真实模型。';
    // 切细一点（默认 8 块），便于验证「流式 + 中途取消」；延迟可配（chat.mockChunkDelayMs）
    const size = Math.ceil(text.length / 8);
    const chunks = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const delay = Number(config.chat.mockChunkDelayMs ?? 260);
    for (const c of chunks) {
      if (signal.aborted) throw new AppError('E_CANCELED', '已取消');
      if (c) onDelta(c);
      await new Promise((r) => setTimeout(r, delay));
    }
    return { text, usage: { promptTokens: null, completionTokens: null }, latencyMs: chunks.length * delay };
  }
  const out = await streamChat({
    provider: chat.provider,
    model: chat.model,
    messages,
    maxTokens: config.chat.maxTokens,
    temperature: config.chat.temperature,
    timeoutMs: config.chat.timeoutMs,
    signal,
    onDelta,
  });
  return {
    text: out.text,
    usage: { promptTokens: out.promptTokens, completionTokens: out.completionTokens },
    latencyMs: out.latencyMs,
  };
}

// ── 滚动摘要（两个引擎共用；确定性压缩，不调模型） ──────────────────────────

/**
 * 滚动摘要（D13 定案）：消息超过 4 轮（8 条）时，把「早于最近 4 轮」的部分压成摘要，
 * **一次压缩、之后增量追加**（每次都重压会让前缀永远不稳）。
 * @returns {{compressed:boolean, appended:number, summaryChars:number}}
 */
export function maybeCompressSummary(chatId) {
  const chat = get('SELECT * FROM chats WHERE id = ?', [Number(chatId)]);
  if (!chat) return { compressed: false, appended: 0, summaryChars: 0 };
  const rows = all('SELECT id, role, content FROM messages WHERE chat_id = ? ORDER BY id ASC', [Number(chatId)]);
  const keep = (config.chat.historyTurns ?? 4) * 2; // 保留最近 4 轮原文
  if (rows.length <= keep) return { compressed: false, appended: 0, summaryChars: chat.summary.length };
  const boundary = rows[rows.length - keep].id;
  const candidates = rows.filter((m) => m.id < boundary && m.id > chat.summary_upto);
  if (!candidates.length) return { compressed: false, appended: 0, summaryChars: chat.summary.length };

  const digest = buildDigest(candidates);
  const next = [chat.summary, digest].filter(Boolean).join(' ').slice(-400);
  run('UPDATE chats SET summary = ?, summary_upto = ? WHERE id = ?', [next, candidates[candidates.length - 1].id, chat.id]);
  log.info('chat.summary', { chatId: chat.id, appendedFrom: candidates.length, summaryChars: next.length, upto: candidates[candidates.length - 1].id });
  return { compressed: true, appended: candidates.length, summaryChars: next.length };
}

/**
 * 摘要素材（确定性压缩，不调模型）：
 * 取每条消息的前 40 字符拼成一行。理由：这一步的目的只是「别丢话题」，不是「写好摘要」；
 * 用确定性规则可以保证同一输入产生同样字节（前缀稳定），也省一次调用。
 */
function buildDigest(messages) {
  return messages
    .map((m) => `${m.role === 'user' ? '问' : '答'}：${String(m.content).replace(/\s+/g, ' ').slice(0, 40)}`)
    .join('；');
}

/** 供 verify-agent 探针/单测用：当前配置下工具是否可用（不建会话、不调模型） */
export function describeEngine() {
  return {
    engine: activeEngine(),
    tools: Array.isArray(config.chat.tools) ? config.chat.tools : [],
    maxToolCallsPerTurn: config.chat.maxToolCallsPerTurn ?? 8,
    maxToolRounds: config.chat.maxToolRounds ?? 5,
    hasKey: hasKey(config.chat.provider || 'deepseek'),
    model: resolveModel(config.chat.provider || 'deepseek') || config.chat.model,
  };
}
