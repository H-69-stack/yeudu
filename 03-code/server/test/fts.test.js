/**
 * FTS 中英混查（§10.3 / D10 / 自测第 8 项）。
 * 关键：入库与查询共用 toFtsText，否则中文永远命不中。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlit-fts-'));
process.env.AGENTLIT_DB = path.join(tmp, 'app.db');
process.env.AGENTLIT_DOWNLOAD_DIR = path.join(tmp, 'pdfs');

const { loadConfig, ensureDirs, applyDbSettings, config } = await import('../config.js');
const db = await import('../db.js');
const { migrate } = await import('../migrate.js');
const { toFtsText, indexSegments, searchSegments, deleteIndexForAsset } = await import('../services/fts.js');

loadConfig();
ensureDirs();
db.openDb(config.server.dbPath);
migrate();
applyDbSettings(db.all);

const now = Date.now();
const workId = db.run(
  `INSERT INTO works(no, section_no, section, authors, title, venue, type, note, origin, fields_locked, retired, created_at, updated_at)
   VALUES('1.99', 1, '1 测试', '', '测试文献', '', '预印本', '', 'import', '[]', 0, ?, ?)`,
  [now, now],
).lastInsertRowid;
const assetId = db.run(
  `INSERT INTO assets(work_id, kind, storage_rel_path, file_size, file_state, extract_status, extract_version, created_at, updated_at)
   VALUES(?, 'pdf', '1.99__t.pdf', 100, 'present', 'ready', 1, ?, ?)`,
  [workId, now, now],
).lastInsertRowid;

function addSegment(pageNo, ord, text) {
  return db.run(
    `INSERT INTO segments(asset_id, page_no, ord, text, char_len, is_math, is_label, is_heading, bbox, extract_version)
     VALUES(?,?,?,?,?,0,0,0,NULL,1)`,
    [assetId, pageNo, ord, text, text.length],
  ).lastInsertRowid;
}

const segs = [
  { id: addSegment(1, 0, 'Agent workflows combine planning, tool use and memory.'), text: 'Agent workflows combine planning, tool use and memory.' },
  { id: addSegment(1, 1, '工作流编排是多智能体系统的核心问题之一。'), text: '工作流编排是多智能体系统的核心问题之一。' },
  { id: addSegment(1, 2, 'We describe an agentic workflow that orchestrates sub-agents.'), text: 'We describe an agentic workflow that orchestrates sub-agents.' },
  { id: addSegment(2, 0, '多智能体 协作（multi-agent collaboration）需要明确的通信协议。'), text: '多智能体 协作（multi-agent collaboration）需要明确的通信协议。' },
];
indexSegments(assetId, segs);

test('toFtsText：CJK 展开为 2-gram，英文按词保留', () => {
  assert.equal(toFtsText('工作流 abc'), '工作 作流 abc');
  assert.equal(toFtsText('a工作流'), 'a 工作 作流');
  assert.equal(toFtsText('单'), '单');
});

test('中文查询「工作流」命中中文段（2-gram 生效）', () => {
  const hits = searchSegments(assetId, '工作流', { topK: 10 });
  assert.ok(hits.length >= 1, '至少命中 1 段');
  assert.ok(hits.some((h) => h.text.includes('工作流')));
});

test('英文查询「agentic workflow」命中英文段', () => {
  const hits = searchSegments(assetId, 'agentic workflow', { topK: 10 });
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.text.toLowerCase().includes('agentic workflow')));
});

test('中文查询「多智能体」命中两处（其中一段是中英混排）', () => {
  const hits = searchSegments(assetId, '多智能体', { topK: 10 });
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.text.includes('多智能体')));
});

test('中英混排段：中文词与英文词都能召回同一段', () => {
  const cn = searchSegments(assetId, '协作', { topK: 10 });
  const en = searchSegments(assetId, 'collaboration', { topK: 10 });
  const cnIds = new Set(cn.map((h) => h.segmentId));
  const enIds = new Set(en.map((h) => h.segmentId));
  assert.ok([...cnIds].some((id) => enIds.has(id)), '中英两路查询应命中同一混排段');
});

test('查不到的词返回空数组而不是抛错', () => {
  assert.deepEqual(searchSegments(assetId, 'zzzzz-not-exist', { topK: 5 }), []);
  assert.deepEqual(searchSegments(assetId, '', { topK: 5 }), []);
});

test('索引可重建：重复 indexSegments 不会产生重复行', () => {
  indexSegments(assetId, segs);
  const n = db.get('SELECT count(*) AS n FROM segments_fts').n;
  assert.equal(n, segs.length);
});

test('deleteIndexForAsset：删索引后查不到', () => {
  deleteIndexForAsset(assetId);
  assert.equal(db.get('SELECT count(*) AS n FROM segments_fts').n, 0);
  assert.deepEqual(searchSegments(assetId, '工作流', { topK: 5 }), []);
  indexSegments(assetId, segs); // 复原，供后续用例
});

test.after(() => {
  db.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
