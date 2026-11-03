// A14 只读探针：DB 体积/行数/pragma/EXPLAIN QUERY PLAN
import { DatabaseSync } from 'node:sqlite';
const P = 'D:\\A-knowledge\\agent工作流优化\\03-code\\data\\app.db';
const db = new DatabaseSync(P, { readOnly: true });
const one = (s) => db.prepare(s).get();
const all = (s) => db.prepare(s).all();

console.log('--- pragmas ---');
for (const p of ['page_size', 'page_count', 'freelist_count', 'journal_mode', 'wal_autocheckpoint', 'auto_vacuum', 'cache_size', 'user_version', 'synchronous']) {
  try { console.log(p, '=', JSON.stringify(one(`PRAGMA ${p}`))); } catch (e) { console.log(p, 'ERR', e.message); }
}

console.log('--- row counts ---');
for (const t of ['works', 'assets', 'download_jobs', 'segments', 'translations', 'translate_jobs', 'chats', 'messages', 'settings']) {
  console.log(t, '=', one(`SELECT count(*) AS n FROM ${t}`).n);
}

console.log('--- per-asset segment density (top 6) ---');
console.log(all(`SELECT asset_id, count(*) n, sum(char_len) chars, max(page_no) pages
  FROM segments GROUP BY asset_id ORDER BY n DESC LIMIT 6`));
console.log('--- translations size ---');
console.log(one(`SELECT count(*) n, sum(length(src_text)) src, sum(length(dst_text)) dst, sum(length(cache_key)) keys FROM translations`));
console.log('--- segments size ---');
console.log(one(`SELECT count(*) n, sum(length(text)) textbytes, sum(char_len) chars FROM segments`));

console.log('--- dbstat top objects (if available) ---');
try {
  for (const r of all(`SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 14`)) {
    console.log(String(r.bytes).padStart(9), (r.bytes / 1048576).toFixed(2) + 'MB', r.name);
  }
} catch (e) { console.log('dbstat unavailable:', e.message); }

console.log('--- EXPLAIN: listWorks BASE_SELECT + count() wrapper ---');
const BASE = `SELECT w.id, w.no, w.title, a.id AS asset_id, a.file_state,
   (SELECT count(*) FROM segments s WHERE s.asset_id = a.id AND s.is_math = 0 AND s.is_label = 0) AS seg_total,
   (SELECT count(*) FROM translations t WHERE t.asset_id = a.id AND t.extract_version = a.extract_version) AS tr_done
  FROM works w
  LEFT JOIN assets a ON a.work_id = w.id AND a.kind = 'pdf'
  LEFT JOIN download_jobs dj ON dj.id = (
    SELECT j.id FROM download_jobs j WHERE j.work_id = w.id
     ORDER BY (CASE WHEN j.status IN ('queued','resolving','downloading','verifying') THEN 0 ELSE 1 END), j.id DESC
     LIMIT 1)`;
const eqp = (label, sql) => {
  console.log('### ' + label);
  try { for (const r of all(`EXPLAIN QUERY PLAN ${sql}`)) console.log('   ', r.id, r.parent, r.detail); }
  catch (e) { console.log('   ERR', e.message); }
};
eqp('count(*) over wrapper (pageSize=50 也跑全量)', `SELECT count(*) AS n FROM (${BASE} WHERE w.retired = 0)`);
eqp('page query 50 rows with ORDER BY expression', `${BASE} WHERE w.retired = 0 ORDER BY CAST(substr(no,1,instr(no,'.')-1) AS INTEGER), CAST(substr(no,instr(no,'.')+1) AS INTEGER) ASC LIMIT 50 OFFSET 0`);
eqp('q LIKE 8-column search', `${BASE} WHERE w.retired = 0 AND (w.no LIKE '%agent%' OR w.title LIKE '%agent%' OR w.authors LIKE '%agent%' OR w.venue LIKE '%agent%' OR w.note LIKE '%agent%' OR IFNULL(w.arxiv_id,'') LIKE '%agent%' OR IFNULL(w.doi,'') LIKE '%agent%' OR w.section LIKE '%agent%') ORDER BY w.no LIMIT 50`);
eqp('segments by asset order page/ord', `SELECT id,page_no,ord,text FROM segments WHERE asset_id = 1 AND is_math=0 AND is_label=0 AND coalesce(role,'') NOT IN ('header','footer','page-number') ORDER BY page_no ASC, ord ASC`);
eqp('translations by cache_key (主键)', `SELECT 1 FROM translations WHERE cache_key = 'abc'`);
eqp('translations by asset+engine+tgt+ver', `SELECT cache_key FROM translations WHERE asset_id = 1 AND engine='x' AND tgt_lang='y' AND extract_version=1`);
eqp('translations count by asset (BASE_SELECT 子查询)', `SELECT count(*) FROM translations t WHERE t.asset_id = 1 AND t.extract_version = 1`);
eqp('chats by work_id', `SELECT id FROM chats WHERE work_id = 1 ORDER BY updated_at DESC LIMIT 1`);

console.log('--- 计时：真实查询重复执行 ---');
const t = (label, sql, args = [], reps = 30) => {
  const st = db.prepare(sql);
  for (let i = 0; i < 3; i++) st.all(...args);
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) st.all(...args);
  console.log(label, ((performance.now() - t0) / reps).toFixed(3) + ' ms/call');
};
t('count(*) wrapper 全 424 行', `SELECT count(*) AS n FROM (${BASE} WHERE w.retired = 0)`);
t('page 50 行', `${BASE} WHERE w.retired = 0 ORDER BY CAST(substr(no,1,instr(no,'.')-1) AS INTEGER), CAST(substr(no,instr(no,'.')+1) AS INTEGER) ASC LIMIT 50 OFFSET 0`);
t('segments 全表读 1752 行', `SELECT id,page_no,ord,text FROM segments`);
t('segments 单 asset', `SELECT id,page_no,ord,text FROM segments WHERE asset_id = 1 ORDER BY page_no, ord`);
t('translations 全表 cache_key', `SELECT cache_key FROM translations`);
db.close();
