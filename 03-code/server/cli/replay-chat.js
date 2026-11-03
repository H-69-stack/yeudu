/**
 * 会话回放（对齐 dsh 的「会话日志即真相 → 可完整回放」，但数据源换成我们的落库事件）。
 *
 * 我们的会话日志 = `messages` 表（含 `tool_calls` / `citations` / `attachments` / usage / latency），
 * 与 dsh 的 `session.v4.jsonl.zstd` 是两种载体，但**回放出的信息面一致**：
 *   谁问了什么 → 模型调了哪些工具（参数/成功与否/耗时/字符数）→ 最终回答与引用 → token 与耗时。
 *
 * 用法：
 *   node --no-warnings server/cli/replay-chat.js --chat 9
 *   node --no-warnings server/cli/replay-chat.js --latest 2.4       # 该文献最近一个会话
 *   node --no-warnings server/cli/replay-chat.js --chat 9 --json    # 机读
 */
import { loadConfig } from '../config.js';
import { all, closeDb, get, openDb } from '../db.js';

const cfg = loadConfig();
openDb(cfg.server.dbPath);

const argv = process.argv.slice(2);
const pick = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const asJson = argv.includes('--json');

let chat = null;
const chatIdArg = pick('chat');
if (chatIdArg) {
  chat = get('SELECT * FROM chats WHERE id = ?', [Number(chatIdArg)]);
  if (!chat) {
    console.error(`会话不存在：${chatIdArg}`);
    process.exit(2);
  }
} else {
  const no = pick('latest');
  const where = no ? 'WHERE w.no = ?' : '';
  const params = no ? [String(no)] : [];
  chat = get(`SELECT c.* FROM chats c JOIN works w ON w.id = c.work_id ${where} ORDER BY c.updated_at DESC LIMIT 1`, params);
  if (!chat) {
    console.error(no ? `文献 ${no} 没有会话` : '库里没有任何会话');
    process.exit(2);
  }
}

const work = get('SELECT no, title FROM works WHERE id = ?', [chat.work_id]);
const rows = all('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC', [chat.id]);
const safeJson = (t, f) => {
  try {
    return t ? JSON.parse(t) : f;
  } catch {
    return f;
  }
};

const turns = [];
let cur = null;
for (const m of rows) {
  if (m.role === 'user') {
    cur = { user: m, assistant: null, toolCalls: [], attachments: [] };
    turns.push(cur);
  } else if (m.role === 'assistant' && cur) {
    cur.assistant = m;
    cur.toolCalls = safeJson(m.tool_calls, []);
    cur.attachments = safeJson(m.attachments, []);
  }
}

const summary = {
  chatId: chat.id,
  work: work ? { no: work.no, title: work.title } : null,
  provider: chat.provider,
  model: chat.model,
  engine: null,
  turns: turns.length,
  toolCallsByName: {},
  images: 0,
  citations: 0,
  promptTokens: 0,
  completionTokens: 0,
  latencyMs: 0,
  errors: [],
};

for (const t of turns) {
  for (const c of t.toolCalls) {
    summary.toolCallsByName[c.name] = (summary.toolCallsByName[c.name] || 0) + 1;
  }
  summary.images += t.attachments.length;
  if (t.assistant) {
    summary.citations += safeJson(t.assistant.citations, []).length;
    summary.promptTokens += Number(t.assistant.prompt_tokens || 0);
    summary.completionTokens += Number(t.assistant.completion_tokens || 0);
    summary.latencyMs += Number(t.assistant.latency_ms || 0);
    const meta = safeJson(t.assistant.context_meta, {});
    if (meta.engine) summary.engine = meta.engine;
    if (t.assistant.error_code) summary.errors.push({ id: t.assistant.id, code: t.assistant.error_code });
  }
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        summary,
        turns: turns.map((t, i) => ({
          turn: i + 1,
          user: { id: t.user.id, chars: String(t.user.content || '').length, text: t.user.content },
          toolCalls: t.toolCalls.map((c) => ({
            name: c.name,
            args: c.args,
            ok: c.ok,
            ms: c.ms,
            chars: c.chars,
            error: c.error || null,
          })),
          images: t.attachments.map((a) => ({ attachmentId: a.attachmentId, mediaType: a.mediaType, bytes: a.bytes })),
          assistant: t.assistant
            ? {
                id: t.assistant.id,
                chars: String(t.assistant.content || '').length,
                citations: safeJson(t.assistant.citations, []).length,
                usage: { promptTokens: t.assistant.prompt_tokens, completionTokens: t.assistant.completion_tokens },
                latencyMs: t.assistant.latency_ms,
                errorCode: t.assistant.error_code || null,
                text: t.assistant.content,
              }
            : null,
        })),
      },
      null,
      1,
    ),
  );
} else {
  console.log(`会话 #${chat.id}｜文献 ${summary.work ? `${summary.work.no} ${summary.work.title}` : '（缺失）'}`);
  console.log(`模型 ${chat.provider}/${chat.model}｜引擎 ${summary.engine || 'legacy'}｜共 ${turns.length} 轮`);
  console.log('');
  turns.forEach((t, i) => {
    console.log(`── 第 ${i + 1} 轮 ──`);
    console.log(`  用户(${String(t.user.content || '').length}字): ${String(t.user.content || '').slice(0, 120)}`);
    for (const c of t.toolCalls) {
      const arg = Object.keys(c.args || {}).length ? JSON.stringify(c.args).slice(0, 80) : '';
      console.log(`  · 工具 ${c.name}${arg ? ` ${arg}` : ''} → ${c.ok ? 'ok' : 'fail'} ${c.ms}ms ${c.chars}字${c.error ? ` (${c.error})` : ''}`);
    }
    for (const a of t.attachments) {
      console.log(`  · 图片 ${a.attachmentId} ${a.mediaType} ${Math.round((a.bytes || 0) / 1024)}KB`);
    }
    if (t.assistant) {
      const cites = safeJson(t.assistant.citations, []);
      console.log(
        `  助手(${String(t.assistant.content || '').length}字, 引用${cites.length}条, ${t.assistant.prompt_tokens || 0}+${t.assistant.completion_tokens || 0} tokens, ${t.assistant.latency_ms || 0}ms)${t.assistant.error_code ? ` [${t.assistant.error_code}]` : ''}`,
      );
    }
    console.log('');
  });
  console.log('── 汇总 ──');
  console.log(`  工具调用：${JSON.stringify(summary.toolCallsByName)}`);
  console.log(`  图片：${summary.images}｜引用：${summary.citations}｜tokens：${summary.promptTokens}+${summary.completionTokens}｜耗时：${summary.latencyMs}ms`);
  if (summary.errors.length) console.log(`  异常：${JSON.stringify(summary.errors)}`);
}

closeDb();
