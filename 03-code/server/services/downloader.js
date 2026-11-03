/**
 * 下载器（§9.1.2 状态机 / §15.2 时序）。
 *
 * 形态：确定性状态机 —— 固定源链（arxiv → link），无模型参与。
 * 真相：`download_jobs` 表是唯一事实源，内存队列只是它的投影（§9.4）。
 * 校验三连（三者同时成立才算成功，HTTP 200 不算成功）：
 *   ① 响应体前 5 字节 = `%PDF-`
 *   ② 页数 ≥ 1
 *   ③ 体积 ≥ download.minPdfBytes（默认 8KB）
 */
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { all, get, run, tx } from '../db.js';
import { AppError, toAppError } from '../errors.js';
import { createLogger } from '../logger.js';
import { assertUrlSafe } from '../middleware/security.js';
import { resolveSources, hasNoAutoSource, buildDoiJumpUrl } from './resolvers/index.js';
import { assertInScope, buildRelPath, commitAtomic, tmpDir } from './storage.js';
import { hasPdfMagic, assertPdfFile } from './pdf/meta.js';

const log = createLogger('downloader');

const ACTIVE_STATUSES = ['queued', 'resolving', 'downloading', 'verifying'];

/** @type {number[]} 内存队列（job id，按 FIFO；用户刚点的插队到队首） */
const queue = [];
/** @type {Map<number, AbortController>} */
const controllers = new Map();
/** @type {Map<number, {bytesDone:number,bytesTotal:number|null,lastFlush:number}>} */
const progress = new Map();
let activeCount = 0;
/** 每个 host 的上次请求时间（arXiv 要求请求间隔 ≥3s，§23.2） */
const lastRequestAt = new Map();
let booted = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** works 行（DB snake_case）→ resolver 需要的 camelCase 视图 */
export function toWorkView(row) {
  return {
    ...row,
    sectionNo: row.section_no,
    arxivId: row.arxiv_id,
    sourceNote: row.source_note,
    fieldsLocked: safeParse(row.fields_locked, []),
  };
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 启动恢复：悬挂状态重置为 queued（§9.4 恢复策略 ①） */
export function bootDownloader() {
  const now = Date.now();
  const reset = run(
    `UPDATE download_jobs SET status='queued', next_retry_at=NULL WHERE status IN ('resolving','downloading','verifying')`,
  );
  // 清掉上次进程留下的 .part 残片
  try {
    const dir = tmpDir();
    return fsp
      .readdir(dir)
      .then((files) => Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true }))))
      .then(() => {
        for (const j of all("SELECT id FROM download_jobs WHERE status='queued' ORDER BY created_at ASC")) queue.push(j.id);
        booted = true;
        if (reset.changes) log.warn('download.reset_hanging', { count: reset.changes, at: now });
        pump();
      });
  } catch {
    booted = true;
  }
  return Promise.resolve();
}

/**
 * POST /api/works/:no/download 的服务层（幂等检查顺序见 §15.2）。
 * @param {string} no
 * @param {{force?:boolean, source?:string}} [opts]
 * @returns {{code:number, body:Object}}
 */
export function createDownload(no, opts = {}) {
  const work = get('SELECT * FROM works WHERE no = ?', [no]);
  if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });
  const workView = toWorkView(work);
  const force = Boolean(opts.force);
  const source = ['auto', 'arxiv', 'link'].includes(opts.source) ? opts.source : 'auto';

  // ① 文件已在位且未强制 → 200 alreadyDownloaded
  const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind='pdf'", [work.id]);
  if (!force && asset && asset.file_state === 'present' && asset.storage_rel_path) {
    let exists = false;
    try {
      exists = awaitExists(asset.storage_rel_path);
    } catch {
      exists = false;
    }
    if (exists) return { code: 200, body: { alreadyDownloaded: true, assetId: asset.id } };
  }

  // ② 已有活跃 job → 200 reused（部分唯一索引兜底并发，这里是友好返回）
  const active = get(
    `SELECT * FROM download_jobs WHERE work_id = ? AND status IN ('queued','resolving','downloading','verifying') ORDER BY id DESC LIMIT 1`,
    [work.id],
  );
  if (active) return { code: 200, body: { jobId: active.id, status: active.status, reused: true } };

  const now = Date.now();

  // ③ 无任何自动源 → 直接落 needs_manual（正常路径，不是错误；§15.2）
  if (source === 'auto' && hasNoAutoSource(workView)) {
    const jobId = run(
      `INSERT INTO download_jobs(work_id, status, source, url, attempts, error_code, error_message, force, created_at, finished_at)
       VALUES(?,?,?,?,0,?,?,?,?,?)`,
      [
        work.id,
        'needs_manual',
        'manual',
        buildDoiJumpUrl(workView),
        'E_NO_SOURCE',
        '该条目没有 arXiv 编号也没有可用链接，只能人工获取',
        force ? 1 : 0,
        now,
        now,
      ],
    ).lastInsertRowid;
    log.info('download.needs_manual', { jobId, no });
    return { code: 202, body: { jobId, status: 'needs_manual', reason: 'E_NO_SOURCE' } };
  }

  const jobId = run(
    `INSERT INTO download_jobs(work_id, status, source, attempts, force, created_at) VALUES(?,?,?,0,?,?)`,
    [work.id, 'queued', source === 'auto' ? null : source, force ? 1 : 0, now],
  ).lastInsertRowid;

  queue.unshift(jobId); // 用户刚点的插队到队首（§9.1.2 并发与排序）
  log.info('download.queued', { jobId, no, source, force });
  pump();
  return { code: 202, body: { jobId, status: 'queued' } };
}

function awaitExists(relPath) {
  try {
    const abs = assertInScope(path.resolve(config.download.downloadDir, relPath));
    return fsSync.existsSync(abs);
  } catch {
    return false;
  }
}

/** 队列调度（有界并发，默认 config.download.concurrency=2） */
function pump() {
  while (activeCount < Math.max(1, config.download.concurrency) && queue.length) {
    const jobId = queue.shift();
    if (!jobId) break;
    activeCount += 1;
    processJob(jobId)
      .catch((e) => log.error('download.crash', { jobId, message: e.message, stack: e.stack }))
      .finally(() => {
        activeCount -= 1;
        pump();
      });
  }
}

function isCanceled(jobId) {
  const job = get('SELECT status FROM download_jobs WHERE id = ?', [jobId]);
  return !job || job.status === 'canceled';
}

function markStatus(jobId, status, extra = {}) {
  const cols = ['status', ...Object.keys(extra)];
  const vals = [status, ...Object.values(extra)];
  run(`UPDATE download_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...vals, jobId]);
}

async function processJob(jobId) {
  const job = get('SELECT * FROM download_jobs WHERE id = ?', [jobId]);
  if (!job || job.status !== 'queued') return;
  const work = get('SELECT * FROM works WHERE id = ?', [job.work_id]);
  if (!work) {
    markStatus(jobId, 'failed', { error_code: 'E_NOT_FOUND', error_message: '条目已不存在', finished_at: Date.now() });
    return;
  }
  const workView = toWorkView(work);
  const ctl = new AbortController();
  controllers.set(jobId, ctl);

  markStatus(jobId, 'resolving', { started_at: Date.now(), attempts: job.attempts + 1, error_code: null, error_message: null });

  let candidates = [];
  try {
    candidates = await resolveSources(workView, { source: job.source || 'auto' });
  } catch (e) {
    const err = toAppError(e);
    markStatus(jobId, 'failed', { error_code: err.code, error_message: err.message, finished_at: Date.now() });
    controllers.delete(jobId);
    return;
  }

  if (!candidates.length) {
    markStatus(jobId, 'needs_manual', {
      source: 'manual',
      url: buildDoiJumpUrl(workView),
      error_code: 'E_NO_SOURCE',
      error_message: '该条目没有可直连的开放 PDF（无 arXiv 编号 / 无可用链接）',
      finished_at: Date.now(),
    });
    log.info('download.needs_manual', { jobId, no: work.no });
    controllers.delete(jobId);
    return;
  }

  const errors = [];
  for (const cand of candidates) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (isCanceled(jobId) || ctl.signal.aborted) {
        controllers.delete(jobId);
        return;
      }
      markStatus(jobId, 'downloading', { source: cand.source, url: cand.url });
      try {
        const relPath = buildRelPath(workView);
        const result = await fetchPdf(cand.url, {
          targetRelPath: relPath,
          maxBytes: config.download.maxBytes,
          timeoutMs: config.download.timeoutMs,
          maxRedirects: config.download.maxRedirects,
          signal: ctl.signal,
          jobId,
        });
        const assetId = commitAsset({ workId: work.id, relPath, result, source: cand.source, sourceUrl: cand.url });
        progress.delete(jobId);
        markStatus(jobId, 'done', {
          http_status: result.httpStatus,
          bytes_done: result.bytes,
          bytes_total: result.bytesTotal ?? result.bytes,
          error_code: null,
          error_message: null,
          next_retry_at: null,
          finished_at: Date.now(),
        });
        log.info('download.done', {
          jobId,
          no: work.no,
          source: cand.source,
          bytes: result.bytes,
          pageCount: result.pageCount,
          assetId,
        });
        controllers.delete(jobId);
        return;
      } catch (e) {
        const err = toAppError(e);
        errors.push({ url: cand.url, source: cand.source, code: err.code, message: err.message });
        log.warn('download.attempt_failed', { jobId, source: cand.source, code: err.code, message: err.message });
        if (err.code === 'E_CANCELED') {
          controllers.delete(jobId);
          return;
        }
        if (isPermanent(err.code)) break; // 该源结论明确，换下一个源
        await sleep(700);
      }
    }
  }

  controllers.delete(jobId);
  const summary = errors.slice(-3).map((e) => `${e.source}: ${e.code} ${e.message}`).join(' | ');
  const reachableButNotPdf = errors.length > 0 && errors.every((e) => e.code === 'E_NOT_PDF' || e.code === 'E_UPSTREAM');
  if (reachableButNotPdf) {
    // 有源但拿不到 PDF（典型：link 指向出版商落地页）→ 人工路径
    markStatus(jobId, 'needs_manual', {
      error_code: errors.some((e) => e.code === 'E_NOT_PDF') ? 'E_NOT_PDF' : 'E_UPSTREAM',
      error_message: `自动源都没有返回可用 PDF。${summary}`,
      finished_at: Date.now(),
    });
    log.info('download.needs_manual', { jobId, no: work.no, reason: 'not_pdf' });
    return;
  }

  const attemptsUsed = job.attempts + 1;
  if (attemptsUsed < config.download.maxAttempts) {
    scheduleRetry(jobId, attemptsUsed, errors[errors.length - 1]);
    return;
  }
  markStatus(jobId, 'failed', {
    error_code: (errors[errors.length - 1] || {}).code || 'E_NETWORK',
    error_message: `重试 ${attemptsUsed} 次仍失败。${summary}`,
    finished_at: Date.now(),
  });
  log.warn('download.failed', { jobId, no: work.no, attempts: attemptsUsed, summary });
}

function isPermanent(code) {
  return ['E_NOT_PDF', 'E_TOO_LARGE', 'E_SSRF_BLOCKED', 'E_NO_SOURCE', 'E_UPSTREAM', 'E_PATH_OUT_OF_SCOPE'].includes(code);
}

function scheduleRetry(jobId, attemptCount, lastError) {
  const backoff = [1000, 4000, 15000][Math.min(attemptCount - 1, 2)];
  const jittered = Math.round(backoff * (0.8 + Math.random() * 0.4));
  markStatus(jobId, 'queued', {
    next_retry_at: Date.now() + jittered,
    error_code: (lastError || {}).code || 'E_NETWORK',
    error_message: `${(lastError || {}).message || '网络失败'}（${Math.round(jittered / 1000)}s 后重试）`,
  });
  log.info('download.retry_scheduled', { jobId, inMs: jittered, attempt: attemptCount });
  const t = setTimeout(() => {
    queue.push(jobId);
    pump();
  }, jittered);
  if (typeof t.unref === 'function') t.unref();
}

/**
 * 带逐跳 SSRF 校验与三连校验的 PDF 抓取（§12.2 fetchPdf）。
 * @param {string} url
 * @param {{targetRelPath:string, maxBytes:number, timeoutMs:number, maxRedirects?:number,
 *          signal?:AbortSignal, jobId?:number, onProgress?:(p:{bytesDone:number,bytesTotal:number|null})=>void}} opts
 * @returns {Promise<{absPath:string, relPath:string, bytes:number, bytesTotal:number|null, sha256:string,
 *                    pageCount:number, contentType:string, httpStatus:number, redirectChain:string[]}>}
 */
export async function fetchPdf(url, opts) {
  const maxRedirects = opts.maxRedirects ?? config.download.maxRedirects;
  const relPath = opts.targetRelPath;
  const finalAbs = assertInScope(path.resolve(config.download.downloadDir, relPath));
  const partAbs = assertInScope(path.join(tmpDir(), `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.part`));

  let current = url;
  const chain = [];
  let lastErr = null;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safe = await assertUrlSafe(current);
    chain.push(safe.toString());
    await throttleHost(safe.hostname);
    let res;
    try {
      res = await fetchWithTimeout(current, opts.timeoutMs, opts.signal);
    } catch (e) {
      lastErr = e;
      throw e;
    }
    try {
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new AppError('E_UPSTREAM', `重定向缺少 Location（HTTP ${res.status}）`, { url: current });
        current = new URL(loc, current).toString();
        continue;
      }
      if (res.status === 429) {
        throw new AppError('E_RATE_LIMITED', '上游限流（HTTP 429）', { url: current, httpStatus: 429 });
      }
      if (res.status >= 400) {
        throw new AppError('E_UPSTREAM', `上游返回 HTTP ${res.status}`, {
          url: current,
          httpStatus: res.status,
          contentType: res.headers.get('content-type') || '',
        });
      }
      if (res.status !== 200 && res.status !== 206) {
        throw new AppError('E_UPSTREAM', `未预期的 HTTP ${res.status}`, { url: current, httpStatus: res.status });
      }
      return await drainPdf(res, {
        partAbs,
        finalAbs,
        relPath,
        url: current,
        maxBytes: opts.maxBytes,
        jobId: opts.jobId,
        onProgress: opts.onProgress,
        signal: opts.signal,
        chain,
      });
    } finally {
      // 已在 drainPdf 里消费完 body；重定向/错误分支要显式取消
      if (res.body && !res.bodyUsed) {
        try {
          await res.body.cancel();
        } catch {
          /* 忽略：连接可能已关闭 */
        }
      }
    }
  }
  throw lastErr || new AppError('E_UPSTREAM', `重定向超过 ${maxRedirects} 跳`, { url, chain });
}

async function fetchWithTimeout(url, timeoutMs, outerSignal) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (outerSignal) signals.push(outerSignal);
  const signal = AbortSignal.any(signals);
  try {
    return await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        // arXiv 官方要求可识别的 UA；不带 UA 也可，但带上更礼貌（§23.2）
        'User-Agent': 'agentlit-local/1.0 (single-user literature manager)',
        Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
      },
    });
  } catch (e) {
    if (outerSignal && outerSignal.aborted) throw new AppError('E_CANCELED', '下载已被取消');
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new AppError('E_TIMEOUT', `请求超时（${timeoutMs}ms）`, { url });
    }
    throw new AppError('E_NETWORK', `网络请求失败：${e.message}`, { url, reason: e.code || e.name });
  }
}

async function throttleHost(hostname) {
  const gap = config.download.requestIntervalMs || 0;
  if (!gap) return;
  const key = /arxiv\.org$/i.test(hostname) ? 'arxiv' : hostname;
  if (key !== 'arxiv') return; // 只对 arXiv 做礼貌间隔（§23.2）
  const last = lastRequestAt.get(key) || 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(key, Date.now());
}

async function drainPdf(res, ctx) {
  const { partAbs, finalAbs, relPath, url, maxBytes, onProgress, jobId } = ctx;
  const contentType = res.headers.get('content-type') || '';
  const lenHeader = res.headers.get('content-length');
  const bytesTotal = lenHeader ? Number(lenHeader) : null;
  if (bytesTotal && bytesTotal > maxBytes) {
    throw new AppError('E_TOO_LARGE', `响应体 ${bytesTotal} 字节，超过上限 ${maxBytes}`, { url, bytesTotal });
  }

  const hash = crypto.createHash('sha256');
  let written = 0;
  let head = Buffer.alloc(0);
  const fh = await fsp.open(partAbs, 'w');
  try {
    const stream = Readable.fromWeb(res.body);
    for await (const chunk of stream) {
      if (ctx.signal && ctx.signal.aborted) throw new AppError('E_CANCELED', '下载已被取消');
      written += chunk.length;
      if (written > maxBytes) {
        throw new AppError('E_TOO_LARGE', `下载字节数超过上限 ${maxBytes}`, { url, maxBytes });
      }
      if (head.length < 5) {
        head = Buffer.concat([head, chunk]).subarray(0, 5);
        if (head.length >= 5 && !hasPdfMagic(head)) {
          throw new AppError('E_NOT_PDF', `目标返回的不是 PDF（前 5 字节：${JSON.stringify(head.toString('latin1'))}）`, {
            url,
            contentType,
            firstBytes: head.toString('latin1'),
          });
        }
      }
      hash.update(chunk);
      await fh.write(chunk);
      if (onProgress) onProgress({ bytesDone: written, bytesTotal });
      if (jobId) flushProgress(jobId, written, bytesTotal);
    }
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.rm(partAbs, { force: true }).catch(() => {});
    throw e;
  }
  await fh.close();

  // 三连校验：魔数（已在流中逐字节判过）+ 体积 + 页数（唯一实现见 pdf/meta.js）
  let verdict;
  try {
    verdict = await assertPdfFile(partAbs, { minBytes: config.download.minPdfBytes || 8192, url });
  } catch (e) {
    await fsp.rm(partAbs, { force: true }).catch(() => {});
    throw e;
  }
  const { size, pageCount } = verdict;

  const finalPath = await commitAtomic(partAbs, finalAbs);
  return {
    absPath: finalPath,
    relPath,
    bytes: size,
    bytesTotal: bytesTotal ?? size,
    sha256: hash.digest('hex'),
    pageCount,
    contentType,
    httpStatus: res.status,
    redirectChain: ctx.chain,
  };
}

function flushProgress(jobId, bytesDone, bytesTotal) {
  const p = progress.get(jobId) || { bytesDone: 0, bytesTotal: null, lastFlush: 0 };
  p.bytesDone = bytesDone;
  p.bytesTotal = bytesTotal;
  progress.set(jobId, p);
  const now = Date.now();
  if (now - p.lastFlush >= 1000) {
    p.lastFlush = now;
    run('UPDATE download_jobs SET bytes_done = ?, bytes_total = ? WHERE id = ?', [bytesDone, bytesTotal, jobId]);
  }
}

/**
 * 把已校验通过的 PDF 登记为 assets 行（下载与手动上传共用）。
 * @param {{workId:number, relPath:string, result:Object, source:string, sourceUrl?:string|null}} p
 * @returns {number} assetId
 */
export function commitAsset({ workId, relPath, result, source, sourceUrl = null }) {
  const now = Date.now();
  return tx(() => {
    const existing = get("SELECT * FROM assets WHERE work_id = ? AND kind='pdf'", [workId]);
    if (existing) {
      const shaChanged = Boolean(existing.file_sha256) && existing.file_sha256 !== result.sha256;
      const nextVersion = shaChanged ? existing.extract_version + 1 : existing.extract_version;
      run(
        `UPDATE assets SET storage_rel_path=?, file_size=?, file_sha256=?, page_count=?, file_state='present',
                           missing_since=NULL, last_verified_at=?, source=?, source_url=?, downloaded_at=?,
                           extract_status='pending', extract_version=?, extract_error=NULL, updated_at=?
          WHERE id = ?`,
        [
          relPath,
          result.bytes,
          result.sha256,
          result.pageCount,
          now,
          source,
          sourceUrl,
          now,
          nextVersion,
          now,
          existing.id,
        ],
      );
      return existing.id;
    }
    return run(
      `INSERT INTO assets(work_id, kind, storage_rel_path, file_size, file_sha256, page_count, file_state,
                          extract_status, extract_version, source, source_url, downloaded_at,
                          last_verified_at, created_at, updated_at)
       VALUES(?, 'pdf', ?,?,?,?, 'present', 'pending', 0, ?,?,?,?,?,?)`,
      [workId, relPath, result.bytes, result.sha256, result.pageCount, source, sourceUrl, now, now, now, now],
    ).lastInsertRowid;
  });
}

/** @returns {{jobId:number,no:string,title:string,status:string,source:string|null,bytesDone:number,
 *             bytesTotal:number|null,attempts:number,errorCode:string|null,errorMessage:string|null,updatedAt:number}} */
function mapJob(row) {
  return {
    jobId: row.id,
    no: row.no,
    title: row.title,
    status: row.status,
    source: row.source,
    url: row.url,
    httpStatus: row.http_status,
    bytesDone: row.bytes_done,
    bytesTotal: row.bytes_total,
    attempts: row.attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.finished_at || row.started_at || row.created_at,
  };
}

const JOB_SELECT = `SELECT j.*, w.no AS no, w.title AS title FROM download_jobs j JOIN works w ON w.id = j.work_id`;

/** GET /api/jobs/download */
export function listJobs({ status, limit = 20 } = {}) {
  const params = [];
  let where = '';
  if (status) {
    where = 'WHERE j.status = ?';
    params.push(status);
  }
  params.push(Math.min(Number(limit) || 20, 200));
  const rows = all(`${JOB_SELECT} ${where} ORDER BY j.id DESC LIMIT ?`, params);
  const live = new Map([...progress.entries()].map(([id, p]) => [id, p]));
  return rows.map((r) => {
    const job = mapJob(r);
    const p = live.get(r.id);
    if (p && ACTIVE_STATUSES.includes(r.status)) {
      job.bytesDone = p.bytesDone;
      job.bytesTotal = p.bytesTotal ?? job.bytesTotal;
    }
    return job;
  });
}

/** GET /api/jobs/download/:id */
export function getJob(id) {
  const row = get(`${JOB_SELECT} WHERE j.id = ?`, [Number(id)]);
  if (!row) throw new AppError('E_NOT_FOUND', `下载任务不存在：${id}`, { jobId: id });
  return mapJob(row);
}

/** POST /api/jobs/download/:id/retry */
export function retryJob(id) {
  const job = get('SELECT * FROM download_jobs WHERE id = ?', [Number(id)]);
  if (!job) throw new AppError('E_NOT_FOUND', `下载任务不存在：${id}`, { jobId: id });
  if (!['failed', 'needs_manual', 'canceled'].includes(job.status)) {
    throw new AppError('E_CONFLICT', `只有 failed/needs_manual/canceled 的任务能重试（当前 ${job.status}）`, {
      jobId: id,
      status: job.status,
    });
  }
  // needs_manual 重试：如果依然没有自动源，会立刻回到 needs_manual（不假装成功）
  run(
    `UPDATE download_jobs SET status='queued', next_retry_at=NULL, error_code=NULL, error_message=NULL,
            finished_at=NULL, attempts=0 WHERE id = ?`,
    [Number(id)],
  );
  queue.unshift(Number(id));
  pump();
  return { jobId: Number(id), status: 'queued' };
}

/** POST /api/jobs/download/:id/cancel */
export async function cancelJob(id) {
  const job = get('SELECT * FROM download_jobs WHERE id = ?', [Number(id)]);
  if (!job) throw new AppError('E_NOT_FOUND', `下载任务不存在：${id}`, { jobId: id });
  const ctl = controllers.get(Number(id));
  if (ctl) ctl.abort();
  const idx = queue.indexOf(Number(id));
  if (idx >= 0) queue.splice(idx, 1);
  run(
    `UPDATE download_jobs SET status='canceled', error_code='E_CANCELED', error_message='用户取消',
            finished_at=? WHERE id = ?`,
    [Date.now(), Number(id)],
  );
  // 清理 .part 残片（同盘 .tmp 下所有该进程的残片都是可丢弃的）
  try {
    const dir = tmpDir();
    const files = await fsp.readdir(dir);
    await Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true })));
  } catch {
    /* 清理失败不影响状态机 */
  }
  progress.delete(Number(id));
  return { canceled: true };
}

/** 是否有活跃下载（/api/health 用） */
export function activeDownloadCount() {
  return get(
    `SELECT count(*) AS n FROM download_jobs WHERE status IN ('queued','resolving','downloading','verifying')`,
  ).n;
}

export { booted };
