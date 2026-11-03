/**
 * tools 引擎的一轮对话（SSE 编排）。
 *
 * 事件序列（前四个与 legacy 完全一致，新增 tool / tool_result）：
 *   meta → [ tool → tool_result ]* → delta* → citation → done
 *
 * 与 legacy 的差别只有三处：
 *   ① 不再把检索结果预先拼进 prompt，改由模型调工具取；
 *   ② 多推两种事件（工具调用开始/结束），前端渲染成过程卡片；
 *   ③ 落库时多写一列 `tool_calls`（本轮调了哪些工具、参数、耗时、字符数）。
 *
 * 其余（SSE 头、心跳、90s 整轮上限、客户端断开→中止、部分产出保留并标 truncated、
 * 引用程序装配）全部与 legacy 同构 —— 前端与运维不需要学两套。
 */
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { assembleCitations } from './citations.js';
import { runToolLoop } from './loop.js';
import { readAttachment, readAttachmentMeta } from './attachments.js';
import { buildToolsPersona, lastTurns, parseCitations } from './prompts.js';
import { personaText } from './persona/lit-research.js';
import { createRegistry } from './registry.js';
import * as rt from './runtime.js';
import {
  countToolCalls,
  insertAssistantMessage,
  insertUserMessage,
  loadChat,
  loadHistory,
  normalizeSelection,
} from './session.js';
import { buildTools } from './tools/index.js';

const log = createLogger('chat');

/** 当前配置下实际会注册的工具名（含「视觉通道是否开着」这类条件披露） */
function registryNamesFromConfig() {
  const { tools } = buildTools(config.chat.tools);
  return tools.map((t) => t.name);
}

/** 附件回源路径（前端按它取图；只暴露本项目内的相对路径，不暴露磁盘绝对路径） */
function buildAttachmentUrl(chatId, attachmentId) {
  return `/api/chats/${chatId}/attachments/${encodeURIComponent(String(attachmentId))}`;
}

/**
 * 解析用户上传的附件引用：校验存在性、区分 image/file、读回图片字节供注入。
 * @param {string[]} ids 来自请求体 body.attachmentIds
 * @returns {{refs:Array, images:Array, skipped:Array}}
 *   refs   —— 落库用的完整 AttachmentRef（source:'user'）
 *   images —— 进模型的图片（带 base64 字节）
 *   skipped —— 不存在/越界的 id（调用方据其报错）
 */
export function resolveUserAttachments(ids) {
  const maxPer = config.chat.attachments?.maxPerMessage ?? 4;
  const list = Array.isArray(ids) ? ids.filter(Boolean).slice(0, maxPer) : [];
  const refs = [];
  const images = [];
  const skipped = [];
  for (const id of list) {
    const meta = readAttachmentMeta(id);
    if (!meta) {
      skipped.push({ attachmentId: id, reason: '附件不存在或已损坏' });
      continue;
    }
    const kind = meta.mediaType.startsWith('image/') ? 'image' : 'file';
    refs.push({
      attachmentId: id,
      source: 'user',
      kind,
      mediaType: meta.mediaType,
      width: meta.width ?? null,
      height: meta.height ?? null,
      bytes: meta.bytes ?? 0,
      toolName: null,
      pageNo: null,
    });
    if (kind === 'image') {
      const data = readAttachment(id);
      if (data && data.bytes && data.bytes.length) {
        images.push({ attachmentId: id, mediaType: meta.mediaType, bytes: data.bytes });
      }
    }
  }
  return { refs, images, skipped };
}

/**
 * 把用户文本 + 上传图片组装成一条 user 消息的 content（可变尾部）。
 * 无图 → 返回纯文本字符串（保持历史行为，不扰动 system+tools 稳定前缀）；
 * 有图 → 返回 content parts 数组（text + image_url(data URI)），超上限/超字节的图降级为文字说明。
 * @see 02-design/多模态输入输出设计.md §4.3 / §11
 */
export function buildUserContent({ text, imageAttachments = [], maxBytes, maxPerTurn }) {
  const imgs = Array.isArray(imageAttachments) ? imageAttachments : [];
  if (!imgs.length) return String(text || '');
  const maxB = maxBytes ?? config.chat.attachments?.maxInjectBytes ?? 5242880;
  const maxP = maxPerTurn ?? config.chat.attachments?.maxInjectPerTurn ?? 4;
  const parts = [{ type: 'text', text: String(text || '') }];
  for (const img of imgs) {
    if (parts.length - 1 >= maxP) {
      parts.push({ type: 'text', text: `[系统提示] 用户上传图片已达本轮上限 ${maxP} 张，其余未送入模型` });
      break;
    }
    if (!img.bytes || img.bytes.length === 0) continue;
    if (img.bytes.length > maxB) {
      parts.push({ type: 'text', text: `[系统提示] 你上传的图（${img.bytes.length} 字节）超过单张上限，未送入模型，请改用更小的图` });
      continue;
    }
    const mt = String(img.mediaType || 'image/jpeg');
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mt};base64,${Buffer.from(img.bytes).toString('base64')}` },
    });
  }
  return parts;
}

/**
 * 组装 tools 引擎的消息数组：system(persona) + 最近 N 轮原文 + 本轮问题（可选带选区/上传图）。
 * 与 legacy 的区别：历史用真实 role（user/assistant），不是压成一段文本。
 */
export function buildToolMessages({ work, history, content, selection, assetId, userImageAttachments }) {
  const names = registryNamesFromConfig();
  const system = buildToolsPersona({
    work,
    sections: [
      personaText({
        canSeeImages: Boolean(names.includes('lit_page_image')),
        canWrite: Boolean(names.includes('lit_update_note')),
      }),
    ],
  });
  const messages = [{ role: 'system', content: system }];
  const turns = config.chat.historyTurns ?? 4;
  for (const m of lastTurns(history, turns)) {
    const text = String(m.content || '');
    if (!text.trim()) continue;
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
  }

  let userText = content;
  if (selection && (selection.text || selection.segmentIds.length)) {
    const where = selection.pageNo == null ? '' : `（第 ${selection.pageNo} 页）`;
    const picked = String(selection.text || '').slice(0, 1600);
    userText = `${content}\n\n【用户选中的原文${where}】\n${picked || `（选中了 ${selection.segmentIds.length} 个段落，可用 lit_read 读第 ${selection.pageNo ?? 1} 页）`}`;
  }

  // 用户上传图以 content parts 嵌在**本条 user 消息**（可变尾部），不扰动 system+tools 稳定前缀
  const userContent = userImageAttachments && userImageAttachments.length
    ? buildUserContent({
      text: userText,
      imageAttachments: userImageAttachments,
      maxBytes: config.chat.attachments?.maxInjectBytes,
      maxPerTurn: config.chat.attachments?.maxInjectPerTurn,
    })
    : userText;
  messages.push({ role: 'user', content: userContent });
  return { messages, assetId };
}

/**
 * @param {number} chatId
 * @param {{content:string, selection?:Object|null}} body
 * @param {import('express').Response} res
 */
export async function postMessageTools(chatId, body, res) {
  const { chat, work, asset } = loadChat(chatId);
  const content = String((body && body.content) || '').trim();
  const attachmentIds = Array.isArray(body && body.attachmentIds)
    ? body.attachmentIds.filter(Boolean)
    : [];
  // 图片/文件携带时允许纯图提问；既无文字也无附件才报错
  if (!content && !attachmentIds.length) {
    throw new AppError('E_BAD_REQUEST', '缺少 content 或 attachmentIds', { field: 'content' });
  }
  if (content.length > 4000) throw new AppError('E_BAD_REQUEST', 'content 超过 4000 字符', { field: 'content' });

  const maxPer = config.chat.attachments?.maxPerMessage ?? 4;
  if (attachmentIds.length > maxPer) {
    throw new AppError('E_BAD_REQUEST', `本次附件 ${attachmentIds.length} 个，超过每消息上限 ${maxPer} 个`);
  }
  // 解析附件引用（校验存在性、区分 image/file、读回图片字节）；不存在的引用直接拒绝，防越权探测
  const { refs: userAttachmentRefs, images: userImageAttachments, skipped: userAttSkipped } =
    resolveUserAttachments(attachmentIds);
  if (userAttSkipped.length) {
    throw new AppError('E_NOT_FOUND', `附件不存在：${userAttSkipped.map((s) => s.attachmentId).join(', ')}`, {
      skipped: userAttSkipped,
    });
  }

  const selection = normalizeSelection(body && body.selection, asset);
  const history = loadHistory(chat.id); // 不含本轮问题（与 legacy 同序）
  const userMsgId = insertUserMessage(chat, content, userAttachmentRefs);

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
  rt.registerTurn(chat.id, { messageId: userMsgId, ctl, engine: 'tools' });
  const turnTimer = setTimeout(() => ctl.abort(), config.chat.timeoutMs || 90000);
  const cleanup = () => {
    clearInterval(heartbeat);
    clearTimeout(turnTimer);
    rt.clearTurn(chat.id);
  };

  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      ctl.abort();
    }
  });

  let assistantText = '';
  /** 本轮已发生的工具调用（出错/取消时也要落库，否则回看历史会丢掉「它看过什么」） */
  const toolLog = [];
  /** 本轮产出的附件引用（图片）；只存引用，不把字节写进消息 */
  const attachments = [];
  try {
    const { tools, unknown } = buildTools(config.chat.tools);
    if (unknown.length) log.warn('chat.tools_unknown', { unknown });
    if (!tools.length) {
      throw new AppError('E_INTERNAL', 'tools 引擎没有可用工具：检查 config.chat.tools', { tools: config.chat.tools });
    }
    const registry = createRegistry(tools, {
      maxCalls: config.chat.maxToolCallsPerTurn ?? 8,
      // 跨轮配额（每会话每工具）：数据源是落库的工具调用日志，不是进程内存
      sessionCounts: countToolCalls(chat.id),
      maxCallsPerName: config.chat.maxCallsPerSession || {},
    });
    const { messages } = buildToolMessages({
      work,
      history,
      content,
      selection,
      assetId: asset ? asset.id : null,
      userImageAttachments,
    });

    send('meta', {
      messageId: userMsgId,
      engine: 'tools',
      tools: registry.names(),
      contextChars: messages.reduce(
        (n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.reduce((s, p) => s + (p.text ? p.text.length : 0), 0)),
        0,
      ),
      citationsPreview: 0,
      retrievalMiss: false,
    });

    const result = await runToolLoop({
      provider: chat.provider,
      model: chat.model,
      messages,
      registry,
      signal: ctl.signal,
      maxTokens: config.chat.maxTokens,
      temperature: config.chat.temperature,
      timeoutMs: config.chat.timeoutMs,
      toolCtx: { assetId: asset ? asset.id : null, workNo: work ? work.no : null, selection },
      onDelta: (d) => {
        assistantText += d;
        send('delta', { text: d });
      },
      onTool: (info) => send('tool', { id: info.id, name: info.name, args: info.args }),
      onToolResult: (info) => {
        toolLog.push(info);
        send('tool_result', {
          id: info.id,
          name: info.name,
          ok: info.ok,
          ms: info.ms,
          chars: info.chars,
          error: info.error,
          errorCode: info.errorCode || null,
        });
        // 图片走引用：前端按 attachmentId 回源，不把 base64 塞进 SSE。
        // 富集统一形状（source/kind/toolName/pageNo），向后兼容 appendImage（只读安全子集）
        for (const a of info.attachments || []) {
          attachments.push({
            ...a,
            source: 'tool',
            kind: 'image',
            toolName: info.name,
            pageNo: info.args?.pageNo ?? null,
          });
          send('image', {
            id: info.id,
            name: info.name,
            attachmentId: a.attachmentId,
            mediaType: a.mediaType,
            bytes: a.bytes,
            width: a.width,
            height: a.height,
            url: buildAttachmentUrl(chat.id, a.attachmentId),
          });
        }
      },
    });

    assistantText = result.text || assistantText;
    const citations = assembleCitations(asset ? asset.id : null, parseCitations(assistantText));
    if (citations.length) send('citation', { citations });

    const assistantMsgId = insertAssistantMessage(chat, {
      content: assistantText,
      citations,
      contextMeta: {
        engine: 'tools',
        rounds: result.rounds,
        tools: toolLog.map((t) => ({ name: t.name, ok: t.ok, ms: t.ms, chars: t.chars })),
        chars: { totalOutput: assistantText.length },
      },
      usage: result.usage,
      latencyMs: result.latencyMs,
      toolCalls: toolLog,
      attachments,
    });

    send('done', {
      messageId: assistantMsgId,
      engine: 'tools',
      usage: result.usage || { promptTokens: null, completionTokens: null },
      latencyMs: result.latencyMs,
      citations: citations.length,
      noCitation: citations.length === 0,
      toolCalls: toolLog.length,
      images: attachments.length,
      retrievalMiss: false,
      truncated: false,
    });
    cleanup();
    res.end();
    log.info('chat.turn_tools', {
      chatId: chat.id,
      rounds: result.rounds,
      tools: toolLog.length,
      chars: assistantText.length,
    });
  } catch (e) {
    const code = e.code || (clientClosed ? 'E_CANCELED' : 'E_UPSTREAM');
    const truncated = clientClosed || code === 'E_CANCELED';
    const citations = assembleCitations(asset ? asset.id : null, parseCitations(assistantText));
    insertAssistantMessage(chat, {
      content: assistantText,
      citations,
      contextMeta: { engine: 'tools', partial: true },
      errorCode: truncated ? 'E_CANCELED' : code,
      truncated,
      toolCalls: toolLog,
      attachments,
    });
    if (!clientClosed) send('error', { code, message: e.message });
    cleanup();
    if (!res.writableEnded) res.end();
    log.warn('chat.turn_tools_failed', {
      chatId: chat.id,
      code,
      message: e.message,
      keptChars: assistantText.length,
    });
  }
}
