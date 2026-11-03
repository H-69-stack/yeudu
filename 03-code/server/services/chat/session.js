/**
 * 会话与消息的持久化（从 agent.js 抽出，行为与抽前逐字一致）。
 *
 * 参照 dsh 的 session seam：**只有这一层碰 chats/messages 表**，pipeline / loop / 工具层都不直接写库。
 * tools 引擎新增两列（v3）：`tool_calls`（本轮工具调用日志）与 `attachments`（图片/文件引用，R3 用）。
 */
import { config } from '../../config.js';
import { all, get, run } from '../../db.js';
import { AppError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { hasKey } from '../llm/client.js';
import { mockEnabled, resolveModel } from '../translate/engines/registry.js';

const log = createLogger('chat');

// ── 会话 CRUD ────────────────────────────────────────────────────────────────

export function createChat({ workNo, provider, model, title } = {}) {
  const work = get('SELECT * FROM works WHERE no = ?', [workNo]);
  if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${workNo}`, { no: workNo });
  const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
  const providerId = String(provider || config.chat.provider || 'deepseek');
  const modelId = String(model || resolveModel(providerId) || config.chat.model || 'deepseek-chat');
  // provider/model 在创建时固定：中途换模型 = 前缀全失效（§9.3.4）
  if (!mockEnabled() && !hasKey(providerId)) {
    throw new AppError('E_LLM_KEY_MISSING', `provider「${providerId}」未配置 apiKey`, { provider: providerId });
  }
  const now = Date.now();
  const chatId = run(
    `INSERT INTO chats(work_id, asset_id, title, provider, model, archived, summary, summary_upto, created_at, updated_at)
     VALUES(?,?,?,?,?,0,'',0,?,?)`,
    [work.id, asset ? asset.id : null, String(title || '').slice(0, 120), providerId, modelId, now, now],
  ).lastInsertRowid;
  log.info('chat.created', { chatId, no: workNo, provider: providerId, model: modelId });
  return { chatId, provider: providerId, model: modelId, workNo };
}

export function listChats(workNo) {
  const params = [];
  let where = '';
  if (workNo) {
    const work = get('SELECT id FROM works WHERE no = ?', [workNo]);
    if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${workNo}`, { no: workNo });
    where = 'WHERE c.work_id = ?';
    params.push(work.id);
  }
  return all(
    `SELECT c.id AS chatId, c.title, c.provider, c.model, c.updated_at AS updatedAt,
            (SELECT count(*) FROM messages m WHERE m.chat_id = c.id) AS messageCount
       FROM chats c ${where} ORDER BY c.updated_at DESC LIMIT 50`,
    params,
  );
}

export function loadChat(chatId) {
  const chat = get('SELECT * FROM chats WHERE id = ?', [Number(chatId)]);
  if (!chat) throw new AppError('E_NOT_FOUND', `会话不存在：${chatId}`, { chatId });
  const work = get('SELECT * FROM works WHERE id = ?', [chat.work_id]);
  const asset = chat.asset_id ? get('SELECT * FROM assets WHERE id = ?', [chat.asset_id]) : null;
  return { chat, work, asset };
}

function safeJson(t, fallback) {
  try {
    return t ? JSON.parse(t) : fallback;
  } catch {
    return fallback;
  }
}

export function listMessages(chatId, { limit = 50, before } = {}) {
  loadChat(chatId);
  const params = [Number(chatId)];
  let where = 'chat_id = ?';
  if (before) {
    where += ' AND id < ?';
    params.push(Number(before));
  }
  params.push(Math.min(Number(limit) || 50, 200));
  const rows = all(`SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`, params);
  return {
    messages: rows.reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      citations: safeJson(m.citations, []),
      contextMeta: safeJson(m.context_meta, {}),
      toolCalls: safeJson(m.tool_calls, []),
      attachments: safeJson(m.attachments, []),
      provider: m.provider,
      model: m.model,
      promptTokens: m.prompt_tokens,
      completionTokens: m.completion_tokens,
      latencyMs: m.latency_ms,
      errorCode: m.error_code,
      truncated: Boolean(m.truncated),
      retrievalMiss: Boolean(m.retrieval_miss),
      feedback: m.feedback,
      createdAt: m.created_at,
    })),
  };
}

export function setFeedback(messageId, score) {
  if (![-1, 0, 1].includes(score)) throw new AppError('E_BAD_REQUEST', 'score 只能是 -1/0/1', { score });
  const m = get('SELECT id FROM messages WHERE id = ?', [Number(messageId)]);
  if (!m) throw new AppError('E_NOT_FOUND', `消息不存在：${messageId}`, { messageId });
  run('UPDATE messages SET feedback = ? WHERE id = ?', [score, Number(messageId)]);
  return { ok: true };
}

export function deleteChat(chatId) {
  const { chat } = loadChat(chatId);
  run('DELETE FROM chats WHERE id = ?', [chat.id]);
  return { ok: true };
}

// ── 消息写入（两个引擎共用） ────────────────────────────────────────────────

/** 先落用户消息：即使后续失败也能看到自己问了什么（可带上传的附件引用） */
export function insertUserMessage(chat, content, attachments = []) {
  return run(
    `INSERT INTO messages(chat_id, role, content, citations, context_meta, provider, model, attachments, created_at)
     VALUES(?, 'user', ?, '[]', '{}', ?, ?, ?, ?)`,
    [chat.id, content, chat.provider, chat.model, JSON.stringify(attachments || []), Date.now()],
  ).lastInsertRowid;
}

/**
 * 落助手消息（一次性写入，宁可整条后置也不写两条）。
 * @param {Object} chat
 * @param {{content:string, citations?:Array, contextMeta?:Object, usage?:Object|null,
 *          latencyMs?:number|null, errorCode?:string|null, truncated?:boolean, retrievalMiss?:boolean,
 *          toolCalls?:Array}} p
 */
export function insertAssistantMessage(chat, p = {}) {
  const t = Date.now();
  const id = run(
    `INSERT INTO messages(chat_id, role, content, citations, context_meta, provider, model,
                          prompt_tokens, completion_tokens, latency_ms, error_code, truncated, retrieval_miss,
                          tool_calls, attachments, created_at)
     VALUES(?, 'assistant', ?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      chat.id,
      String(p.content || ''),
      JSON.stringify(p.citations || []),
      JSON.stringify(p.contextMeta || {}),
      chat.provider,
      chat.model,
      p.usage ? p.usage.promptTokens ?? null : null,
      p.usage ? p.usage.completionTokens ?? null : null,
      p.latencyMs == null ? null : p.latencyMs,
      p.errorCode || null,
      p.truncated ? 1 : 0,
      p.retrievalMiss ? 1 : 0,
      JSON.stringify(p.toolCalls || []),
      JSON.stringify(p.attachments || []),
      t,
    ],
  ).lastInsertRowid;
  run('UPDATE chats SET updated_at = ? WHERE id = ?', [t, chat.id]);
  return id;
}

// ── 读辅助 ──────────────────────────────────────────────────────────────────

export function loadHistory(chatId) {
  return all('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id ASC', [Number(chatId)]);
}

export function lastContextMeta(chatId) {
  const m = get(
    "SELECT context_meta FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
    [Number(chatId)],
  );
  if (!m) return {};
  return safeJson(m.context_meta, {});
}

/**
 * 选区规整：没有 asset 或选区为空 → null。
 * @param {{pageNo?:number, segmentIds?:number[], text?:string}|null} selection
 * @param {Object|null} asset
 */
export function normalizeSelection(selection, asset) {
  if (!selection || !asset) return null;
  const text = String(selection.text || '').trim();
  const pageNo = Number(selection.pageNo);
  const segmentIds = Array.isArray(selection.segmentIds)
    ? selection.segmentIds.map(Number).filter((n) => Number.isInteger(n))
    : [];
  if (!text && !segmentIds.length) return null;
  return { pageNo: Number.isInteger(pageNo) ? pageNo : null, segmentIds, text: text.slice(0, 4000) };
}

/**
 * 本会话已发生的工具调用计数（跨轮配额的数据源）。
 * 对齐 dsh「配额从会话日志投影出来，而不是进程内计数」（`page-image-usage.ts:82-84`）的**意图**：
 * 这里的数据源是落库的 `messages.tool_calls`，进程重启不丢、换进程也一致。
 * @returns {Record<string, number>}
 */
export function countToolCalls(chatId) {
  const rows = all(
    "SELECT tool_calls FROM messages WHERE chat_id = ? AND tool_calls IS NOT NULL AND tool_calls <> '[]'",
    [Number(chatId)],
  );
  const out = {};
  for (const r of rows) {
    let list = [];
    try {
      list = JSON.parse(r.tool_calls || '[]');
    } catch {
      list = [];
    }
    for (const c of list) {
      if (!c || !c.name) continue;
      out[c.name] = (out[c.name] || 0) + 1;
    }
  }
  return out;
}

/** 选中段 + 前后的相邻段（§9.3 尾部优先级） */
export function loadSelectionContext(assetId, selection) {
  if (!assetId || !selection || !selection.segmentIds.length) return [];
  const first = get('SELECT page_no, ord FROM segments WHERE id = ?', [selection.segmentIds[0]]);
  if (!first) return [];
  const rows = all(
    `SELECT id, page_no, ord, text FROM segments
      WHERE asset_id = ? AND (page_no > ? OR (page_no = ? AND ord BETWEEN ? AND ?))
      ORDER BY page_no, ord LIMIT 6`,
    [assetId, first.page_no - 1, first.page_no, Math.max(0, first.ord - 1), first.ord + 1],
  );
  return rows.map((r) => ({ segmentId: r.id, pageNo: r.page_no, ord: r.ord, text: r.text }));
}
