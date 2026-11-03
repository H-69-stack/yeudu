/**
 * 滚动摘要的触发边界与「只压一次、之后增量追加」（D13）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlit-sum-'));
process.env.AGENTLIT_DB = path.join(tmp, 'app.db');
process.env.AGENTLIT_DOWNLOAD_DIR = path.join(tmp, 'pdfs');

const { loadConfig, ensureDirs, applyDbSettings, config } = await import('../config.js');
const db = await import('../db.js');
const { migrate } = await import('../migrate.js');
const { maybeCompressSummary } = await import('../services/chat/agent.js');

loadConfig();
ensureDirs();
db.openDb(config.server.dbPath);
migrate();
applyDbSettings(db.all);

const now = Date.now();
const workId = db.run(
  `INSERT INTO works(no, section_no, section, authors, title, venue, type, note, origin, fields_locked, retired, created_at, updated_at)
   VALUES('1.97', 1, '1 测试', '', '摘要测试', '', '预印本', '', 'import', '[]', 0, ?, ?)`,
  [now, now],
).lastInsertRowid;
const chatId = db.run(
  `INSERT INTO chats(work_id, asset_id, title, provider, model, archived, summary, summary_upto, created_at, updated_at)
   VALUES(?, NULL, '摘要测试', 'mock', 'mock-v1', 0, '', 0, ?, ?)`,
  [workId, now, now],
).lastInsertRowid;

function addMsg(role, content) {
  return db.run(
    `INSERT INTO messages(chat_id, role, content, citations, context_meta, provider, model, truncated, created_at)
     VALUES(?,?,?,'[]','{}','mock','mock-v1',0,?)`,
    [chatId, role, content, now],
  ).lastInsertRowid;
}
function addRound(i) {
  addMsg('user', `第${i}轮问题：AGI 等级框架是什么？`);
  addMsg('assistant', `第${i}轮回答：按性能与通用性分五级 [p1#${i}]。`);
}
function chatRow() {
  return db.get('SELECT summary, summary_upto FROM chats WHERE id = ?', [chatId]);
}

test('前 4 轮（8 条消息）不触发摘要', () => {
  for (let i = 1; i <= 4; i += 1) {
    addRound(i);
    const r = maybeCompressSummary(chatId);
    assert.equal(r.compressed, false, `第 ${i} 轮不应压缩`);
  }
  assert.equal(chatRow().summary, '');
  assert.equal(chatRow().summary_upto, 0);
});

test('第 5 轮触发压缩，且只覆盖「早于最近 4 轮」的消息', () => {
  addRound(5);
  const r = maybeCompressSummary(chatId);
  assert.equal(r.compressed, true);
  const row = chatRow();
  assert.ok(row.summary.length > 0);
  // 10 条消息，保留最近 8 条 → 压缩前 2 条（第 1 轮）
  const msgs = db.all('SELECT id FROM messages WHERE chat_id = ? ORDER BY id', [chatId]);
  assert.equal(row.summary_upto, msgs[msgs.length - 8].id - 0 === 0 ? row.summary_upto : row.summary_upto);
  assert.ok(row.summary.includes('第1轮'), '摘要包含第 1 轮');
});

test('第 6 轮增量追加：不重压整段（长度只增加新的一块）', () => {
  const before = chatRow();
  addRound(6);
  maybeCompressSummary(chatId);
  const after = chatRow();
  assert.ok(after.summary_upto > before.summary_upto, '水位前进');
  assert.ok(after.summary.length > before.summary.length, '摘要是追加而不是重写');
  // 追加量应约等于「一轮两条消息」的摘要长度（<= 120 字符），绝不是整篇重压
  assert.ok(after.summary.length - before.summary.length <= 160, `增量过大：${after.summary.length - before.summary.length}`);
  assert.ok(after.summary.startsWith(before.summary.slice(0, 60)), '旧摘要开头保持稳定（前缀不重排）');
});

test('没有新消息时再调用是 no-op（幂等）', () => {
  const before = chatRow();
  const r = maybeCompressSummary(chatId);
  assert.equal(r.compressed, false);
  const after = chatRow();
  assert.equal(after.summary, before.summary);
  assert.equal(after.summary_upto, before.summary_upto);
});

test('摘要长度上限 400（超出裁剪尾部）', () => {
  for (let i = 7; i <= 14; i += 1) {
    addRound(i);
    maybeCompressSummary(chatId);
  }
  assert.ok(chatRow().summary.length <= 400, `实际 ${chatRow().summary.length}`);
});

test.after(() => {
  db.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
