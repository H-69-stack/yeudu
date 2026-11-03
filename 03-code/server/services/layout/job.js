/**
 * AI 精排任务（异步 + SSE，参照 translate 任务的 runner 模式，但纯内存、不落库）。
 *
 * 精排本身只把分类结果写回 segments 表（已持久化），所以任务状态只需留在内存：
 *  - startLayout 立刻返回 202 + jobId；
 *  - 客户端用 /jobs/layout/:id/events 订阅 SSE 拿进度 / 完成 / 错误；
 *  - 断线即中止（已写回的段保留，可再次点「精排」覆盖）。
 */
import { get } from '../../db.js';
import { AppError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { refineWork } from './refine.js';

const log = createLogger('layout.job');

/** jobId -> { listeners:Set, ctl:AbortController, canceled:bool, status:string } */
const runners = new Map();
let nextJobId = 1;

function ensureRunner(jobId) {
  let r = runners.get(jobId);
  if (!r) {
    r = { listeners: new Set(), ctl: new AbortController(), canceled: false, status: 'queued', lastError: null, result: null };
    runners.set(jobId, r);
  }
  return r;
}

function emit(jobId, event, payload) {
  const r = runners.get(jobId);
  if (!r) return;
  for (const fn of r.listeners) {
    try {
      fn(event, payload);
    } catch {
      /* 单个订阅者出错不影响其它订阅者 */
    }
  }
}

/**
 * 创建精排任务。
 * @param {string} no works.no
 * @param {{engine?:string, model?:string, maxPages?:number}} opts
 * @returns {{jobId:number, status:string}}
 */
export function startLayout(no, opts = {}) {
  const work = get('SELECT * FROM works WHERE no = ?', [no]);
  if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });
  const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
  if (!asset) throw new AppError('E_NOT_FOUND', '该条目还没有本地 PDF，无法精排', { no });
  if (asset.extract_status === 'failed') {
    throw new AppError('E_EXTRACT_FAILED', `文本抽取失败，无法精排：${asset.extract_error || ''}`, { assetId: asset.id });
  }
  if (asset.extract_status !== 'ready') {
    throw new AppError('E_EXTRACT_FAILED', '文本尚未抽取完成，请先调用 POST /api/assets/:id/extract', { assetId: asset.id });
  }

  const jobId = nextJobId;
  nextJobId += 1;
  const runner = ensureRunner(jobId);
  runner.status = 'running';

  runLayoutJob(jobId, asset.id, {
    engine: opts.engine,
    model: opts.model,
    maxPages: Number.isFinite(opts.maxPages) ? opts.maxPages : undefined,
    signal: runner.ctl.signal,
  }).catch((e) => {
    log.error('layout.crash', { jobId, message: e.message, stack: e.stack });
    runner.status = 'failed';
    emit(jobId, 'error', { code: e.code || 'E_INTERNAL', message: e.message });
  });

  return { jobId, status: 'running' };
}

async function runLayoutJob(jobId, assetId, opts) {
  const runner = ensureRunner(jobId);
  const onProgress = (message) => emit(jobId, 'progress', { jobId, message, at: Date.now() });
  onProgress('AI 精排开始…');
  const out = await refineWork(assetId, {
    engine: opts.engine,
    model: opts.model,
    maxPages: opts.maxPages,
    signal: opts.signal,
    onProgress,
  });
  // 一个改动都没落下却攒了错误（最常见：引擎没配 apiKey，每批都失败）——
  // 这种情况必须报失败，否则用户点完「精排」只会看到"完成"，排版却毫无变化。
  if (!out.applied && out.errors && out.errors.length) {
    const message = out.errors[0] || '精排未产生任何改动';
    runner.status = 'failed';
    runner.lastError = message;
    runner.result = out;
    log.warn('layout.noop', { jobId, errors: out.errors.length });
    emit(jobId, 'error', { jobId, code: 'E_LAYOUT_FAILED', message, ...out, at: Date.now() });
    return;
  }
  runner.status = 'done';
  runner.result = out;
  emit(jobId, 'done', { jobId, ...out, at: Date.now() });
}

export function getLayoutJob(id) {
  const n = Number(id);
  const r = runners.get(n);
  return {
    jobId: n,
    status: r ? r.status : 'unknown',
    error: r && r.lastError ? r.lastError : null,
    result: r && r.result ? r.result : null,
  };
}

export function streamLayoutEvents(id, res) {
  const jobId = Number(id);
  const runner = ensureRunner(jobId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send('progress', { jobId, status: runner.status, at: Date.now() });

  const listener = (event, payload) => send(event, payload);
  runner.listeners.add(listener);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    runner.listeners.delete(listener);
    // 客户端断开 → 中止上游（已写回的段保留，可再次精排覆盖）
    if (runner.listeners.size === 0 && ['running', 'queued'].includes(runner.status)) {
      runner.ctl.abort();
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

export function cancelLayoutJob(id) {
  const jobId = Number(id);
  const runner = ensureRunner(jobId);
  runner.ctl.abort();
  if (runner.status !== 'done') runner.status = 'canceled';
  return { canceled: true, jobId };
}
