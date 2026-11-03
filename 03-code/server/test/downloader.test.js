/**
 * 下载状态机（离线部分，§9.1.2 / §15.2）。
 * 不起网络：只覆盖幂等检查、needs_manual 判定、状态冲突，不发真实下载请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlit-dl-'));
process.env.AGENTLIT_DB = path.join(tmp, 'app.db');
process.env.AGENTLIT_DOWNLOAD_DIR = path.join(tmp, 'pdfs');

const { loadConfig, ensureDirs, applyDbSettings, config } = await import('../config.js');
const db = await import('../db.js');
const { migrate } = await import('../migrate.js');
const { createDownload, getJob, listJobs, retryJob } = await import('../services/downloader.js');

loadConfig();
ensureDirs();
db.openDb(config.server.dbPath);
migrate();
applyDbSettings(db.all);

function insertWork(no, extra = {}) {
  const now = Date.now();
  const row = {
    no,
    section_no: 9,
    section: '9 测试专题',
    authors: '',
    title: `测试条目 ${no}`,
    year: 2024,
    venue: '',
    type: '预印本',
    note: '',
    arxiv_id: null,
    doi: null,
    isbn: null,
    link: null,
    source_note: '',
    ...extra,
  };
  db.run(
    `INSERT INTO works(no, section_no, section, authors, title, year, venue, type, note, arxiv_id, doi, isbn, link,
                       source_note, origin, fields_locked, retired, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'import', '[]', 0, ?, ?)`,
    [
      row.no, row.section_no, row.section, row.authors, row.title, row.year, row.venue, row.type, row.note,
      row.arxiv_id, row.doi, row.isbn, row.link, row.source_note, now, now,
    ],
  );
  return db.get('SELECT id FROM works WHERE no = ?', [no]).id;
}

test('三无条目（无 arxiv/doi/link）→ needs_manual，不假装成功', () => {
  insertWork('9.1');
  const out = createDownload('9.1', {});
  assert.equal(out.code, 202);
  assert.equal(out.body.status, 'needs_manual');
  const job = getJob(out.body.jobId);
  assert.equal(job.status, 'needs_manual');
  assert.equal(job.errorCode, 'E_NO_SOURCE');
  assert.equal(job.url, null); // 无 DOI → 没有跳转链接
});

test('已下载且文件在位 → 200 alreadyDownloaded（不重复入队）', () => {
  const workId = insertWork('9.2', { arxiv_id: '2308.11432' });
  const rel = '9.2__test.pdf';
  const abs = path.join(config.download.downloadDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from('%PDF-1.4 stub'));
  const now = Date.now();
  const assetId = db.run(
    `INSERT INTO assets(work_id, kind, storage_rel_path, file_size, file_state, extract_status, extract_version,
                        created_at, updated_at) VALUES(?, 'pdf', ?, ?, 'present', 'pending', 0, ?, ?)`,
    [workId, rel, 13, now, now],
  ).lastInsertRowid;
  const out = createDownload('9.2', {});
  assert.equal(out.code, 200);
  assert.equal(out.body.alreadyDownloaded, true);
  assert.equal(out.body.assetId, assetId);
  // force=true 时不应返回 alreadyDownloaded（这里只检查它不再走 alreadyDownloaded 分支：
  // 会因为真实网络请求而入队，故不在此断言下载结果）
});

test('已有活跃 job → 200 reused（部分唯一索引兜底并发）', () => {
  const workId = insertWork('9.3', { arxiv_id: '2308.11432' });
  const now = Date.now();
  const jobId = db.run(
    `INSERT INTO download_jobs(work_id, status, source, attempts, force, created_at) VALUES(?, 'queued', NULL, 0, 0, ?)`,
    [workId, now],
  ).lastInsertRowid;
  const out = createDownload('9.3', {});
  assert.equal(out.code, 200);
  assert.equal(out.body.reused, true);
  assert.equal(out.body.jobId, jobId);
});

test('retry：done 状态不允许重试（E_CONFLICT）', () => {
  const out = createDownload('9.1', { force: true });
  assert.equal(out.body.status, 'needs_manual');
  db.run("UPDATE download_jobs SET status='done' WHERE id = ?", [out.body.jobId]);
  assert.throws(() => retryJob(out.body.jobId), (e) => e.code === 'E_CONFLICT');
});

test('listJobs：状态过滤与 limit 生效', () => {
  const all = listJobs({ limit: 50 });
  assert.ok(all.length >= 3);
  const manual = listJobs({ status: 'needs_manual', limit: 50 });
  assert.ok(manual.every((j) => j.status === 'needs_manual'));
  const limited = listJobs({ limit: 1 });
  assert.equal(limited.length, 1);
});

test('不存在的编号 → E_NOT_FOUND', () => {
  assert.throws(() => createDownload('88.88', {}), (e) => e.code === 'E_NOT_FOUND');
});

test.after(() => {
  db.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
