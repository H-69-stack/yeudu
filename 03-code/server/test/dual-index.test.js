/**
 * 双索引检索（D22）：原文 + 译文两侧都要能命中，且按 segmentId 合并去重。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlit-dual-'));
process.env.AGENTLIT_DB = path.join(tmp, 'app.db');
process.env.AGENTLIT_DOWNLOAD_DIR = path.join(tmp, 'pdfs');

const { loadConfig, ensureDirs, applyDbSettings, config } = await import('../config.js');
const db = await import('../db.js');
const { migrate } = await import('../migrate.js');
const fts = await import('../services/fts.js');

loadConfig();
ensureDirs();
db.openDb(config.server.dbPath);
migrate();
applyDbSettings(db.all);

const now = Date.now();
const workId = db.run(
  `INSERT INTO works(no, section_no, section, authors, title, venue, type, note, origin, fields_locked, retired, created_at, updated_at)
   VALUES('1.98', 1, '1 测试', '', '双索引测试', '', '预印本', '', 'import', '[]', 0, ?, ?)`,
  [now, now],
).lastInsertRowid;
const assetId = db.run(
  `INSERT INTO assets(work_id, kind, storage_rel_path, file_size, file_state, extract_status, extract_version, created_at, updated_at)
   VALUES(?, 'pdf', '1.98__t.pdf', 100, 'present', 'ready', 1, ?, ?)`,
  [workId, now, now],
).lastInsertRowid;

function seg(pageNo, ord, text) {
  const id = db.run(
    `INSERT INTO segments(asset_id, page_no, ord, text, char_len, is_math, is_label, is_heading, bbox, extract_version)
     VALUES(?,?,?,?,?,0,0,0,NULL,1)`,
    [assetId, pageNo, ord, text, text.length],
  ).lastInsertRowid;
  return { id, pageNo, ord, text };
}

// 原文只有英文；中文译文是「另一套说法」，两边的检索词刻意不同
const s1 = seg(1, 0, 'Agentic workflow orchestration with tool use and memory.');
const s2 = seg(1, 1, 'We describe levels of generality for AI systems.');
const s3 = seg(2, 0, 'Multi-agent collaboration requires a communication protocol.');
fts.indexSegments(assetId, [s1, s2, s3].map((s) => ({ id: s.id, text: s.text })));

// 译文索引：只译了 s1 与 s2（s3 未译）。
// 真实路径下 pipeline 会在同一事务里写 translations + translations_fts，这里两者都写，
// 否则检索能命中但取不回可读译文（textDst=null，那是 bug 而不是预期）。
function addTranslation(seg, dst) {
  db.run(
    `INSERT INTO translations(cache_key, asset_id, segment_id, page_no, ord, src_text, dst_text, engine, model,
                              src_lang, tgt_lang, prompt_fp, extract_version, created_at, last_hit_at, hits)
     VALUES(?,?,?,?,?,?,?,?,?, 'auto', 'zh-CN', 'fp', 1, ?, ?, 0)`,
    [`k-${seg.id}`, assetId, seg.id, seg.pageNo, seg.ord, seg.text, dst, 'mock', 'mock-v2', now, now],
  );
  fts.indexTranslation(seg.id, { engine: 'mock', tgtLang: 'zh-CN', text: dst });
}
addTranslation(s1, '智能体工作流的编排需要工具调用与记忆。');
addTranslation(s2, '我们描述了智能系统的通用性等级。');

test('原文侧命中：英文词走 segments_fts', () => {
  const hits = fts.searchSegments(assetId, 'orchestration', { topK: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].segmentId, s1.id);
  assert.equal(hits[0].hitLang, 'src');
});

test('译文侧命中：中文词走 translations_fts（这条是 D22 的核心）', () => {
  const hits = fts.searchSegments(assetId, '工作流', { topK: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].segmentId, s1.id);
  assert.equal(hits[0].hitLang, 'dst');
  assert.ok(hits[0].textDst.includes('工作流'), '必须带回可读的中文译文');
});

test('中文词命中未翻译的段落则不会出现（不无中生有）', () => {
  const hits = fts.searchSegments(assetId, '通信协议', { topK: 10 });
  assert.equal(hits.length, 0);
});

test('两侧都命中同一段时按 segmentId 去重（不出现两条）', () => {
  // 'agent' 在原文 s1 与译文「智能体」无关，但 'workflow' 与译文「工作流」命中同一段
  const src = fts.searchSegments(assetId, 'workflow', { topK: 10, side: 'src' });
  const dst = fts.searchSegments(assetId, '工作流', { topK: 10, side: 'dst' });
  assert.equal(src[0].segmentId, dst[0].segmentId);
  const merged = fts.mergeHits(src, dst, 10);
  assert.equal(merged.filter((h) => h.segmentId === s1.id).length, 1, '合并后同段只保留一条');
});

test('mergeHits：保留 bm25 更优（更小）的一侧，并带上 textDst', () => {
  const src = [{ segmentId: 7, pageNo: 1, ord: 0, text: 'src text', score: -2.0, hitLang: 'src', textDst: null }];
  const dst = [{ segmentId: 7, pageNo: 1, ord: 0, text: 'src text', score: -1.0, hitLang: 'dst', textDst: '中文' }];
  const merged = fts.mergeHits(src, dst, 5);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].hitLang, 'src', 'src 分数更优则命中语言为 src');
  assert.equal(merged[0].textDst, '中文', '但仍带回中文，便于双语上下文');

  const merged2 = fts.mergeHits(
    [{ segmentId: 7, pageNo: 1, ord: 0, text: 'src text', score: -1.0, hitLang: 'src', textDst: null }],
    [{ segmentId: 7, pageNo: 1, ord: 0, text: 'src text', score: -2.0, hitLang: 'dst', textDst: '中文' }],
    5,
  );
  assert.equal(merged2[0].hitLang, 'dst');
});

test('索引按 rowid(=segments.id) 替换：重译不会堆积多份', () => {
  const before = db.get('SELECT count(*) AS n FROM translations_fts WHERE rowid = ?', [s1.id]).n;
  assert.equal(before, 1);
  fts.indexTranslation(s1.id, { engine: 'deepseek', tgtLang: 'zh-CN', text: '另一版译文：工作流编排。' });
  const after = db.get('SELECT count(*) AS n FROM translations_fts WHERE rowid = ?', [s1.id]).n;
  assert.equal(after, 1, '同段只有一行');
  const hits = fts.searchSegments(assetId, '工作流', { topK: 5 });
  assert.ok(hits[0].textDst === null || hits[0].textDst.includes('工作流'));
});

test('deleteTranslationIndexForAsset：清空后中文查不到，英文仍在', () => {
  fts.deleteTranslationIndexForAsset(assetId);
  assert.equal(fts.searchSegments(assetId, '工作流', { topK: 5 }).length, 0);
  assert.ok(fts.searchSegments(assetId, 'orchestration', { topK: 5 }).length >= 1);
});

test('buildMatchExpr：拉丁词加前缀通配，CJK 不加', () => {
  assert.equal(fts.buildMatchExpr(['agent', '工作', '作流']), '"agent"* OR "工作" OR "作流"');
});

test.after(() => {
  db.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
