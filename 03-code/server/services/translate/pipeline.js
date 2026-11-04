/**
 * 翻译管线（§9.1.3 / §15.3）。固定步骤，不是 agent 循环：
 *   前置校验 → 取段 → 算 key → 查缓存 → 排序（可见页优先）→ 分批 → 有界并发 →
 *   引擎链回退（每引擎 2 次）→ 逐段 upsert → 记账 + SSE 推进 → 终止。
 *
 * 三条设计约束：
 *  ① 单批失败**不中断**整个 job：记 failed_segments 后继续（一篇 30 页里个别段反复失败很常见，
 *     整体失败会让用户白等十几分钟）。
 *  ② 进度由 `translations` 命中数反推 → 天然断点续译（重启/续译不需要额外状态）。
 *  ③ 打转检测：同一批指纹连续失败 2 次就放弃该批，不再无限退避。
 */
import { config } from '../../config.js';
import { all, get, run, tx } from '../../db.js';
import { AppError } from '../../errors.js';
import { createLogger } from '../../logger.js';
import { indexTranslation } from '../fts.js';
import { requireEngine, engineChain, resolveModel } from './engines/registry.js';
import { buildCacheKey } from './cacheKey.js';
import { promptFingerprint, resolveTemplate, STRICT_TEMPERATURE } from './prompts.js';
import {
  alignBatchOutput,
  assessSource,
  CAPTION_ROLES,
  chunkSegments,
  isCaptionLike,
  screenTranslation,
  translatableSql,
} from './quality.js';

const log = createLogger('translate');

/**
 * 「值得翻译」的段落口径（四条 SQL 共用，避免各处漏改）。
 * 判定规则与理由见 `quality.js` 的 NEVER_TRANSLATE_ROLES：
 * 图内文字是符号碎片（误翻即 EVRNKSHUHO 式大写垃圾）、页眉页脚是跨页重复的栏目信息
 * （模型经常半翻半留，实测 `18 SEEE JOURNAL OF ROBOTICS…`）、页码只是分页标记、
 * 公式是符号串、参考文献必须原文照录（翻译即销毁可引用性）。
 * 这些段不送翻：阅读器直接显示原文，比"半译半留"更干净，也省 token。
 */
const TRANSLATABLE = translatableSql();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Map<number, {listeners:Set<Function>, ctl:AbortController, canceled:boolean}>} */
const runners = new Map();

/**
 * 最近一次运行的计数（内存态，不持久化）：请求数/批次数/缓存命中数。
 * 持久化没有意义（重启后没有「那次运行」这个概念），但自测与排障需要看得到。
 * @type {Map<number, {requests:number,batches:number,cacheHits:number,usage:Object,finishedAt:number}>}
 */
const jobStats = new Map();

/** 事件总线（SSE 订阅） */
function ensureRunner(jobId) {
  let r = runners.get(jobId);
  if (!r) {
    r = { listeners: new Set(), ctl: new AbortController(), canceled: false };
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
 * 创建翻译任务（幂等：同 asset+engine+tgtLang 的活跃 job 直接复用）。
 * @param {string} no works.no
 * @param {{engine?:string, tgtLang?:string, srcLang?:string, scope?:'all'|'pages', pages?:number[],
 *          anchorPage?:number, force?:boolean}} opts
 * @returns {{jobId:number, reused:boolean, status:string}}
 */
export function startTranslate(no, opts = {}) {
  const work = get('SELECT * FROM works WHERE no = ?', [no]);
  if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });
  const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
  if (!asset) throw new AppError('E_NOT_FOUND', '该条目还没有本地 PDF，无法翻译', { no });
  if (asset.extract_status === 'failed') {
    throw new AppError('E_EXTRACT_FAILED', `文本抽取失败，无法翻译：${asset.extract_error || ''}`, { assetId: asset.id });
  }
  if (asset.extract_status === 'needs_ocr') {
    throw new AppError('E_NEEDS_OCR', '该 PDF 没有文本层（扫描件），本期不做 OCR', { assetId: asset.id });
  }
  if (asset.extract_status !== 'ready') {
    throw new AppError('E_EXTRACT_FAILED', '文本尚未抽取完成，请先调用 POST /api/assets/:id/extract', { assetId: asset.id });
  }

  const engineId = String(opts.engine || config.translate.engine || 'deepseek');
  const engine = requireEngine(engineId);
  const tgtLang = String(opts.tgtLang || config.translate.tgtLang || 'zh-CN');
  const srcLang = String(opts.srcLang || config.translate.srcLang || 'auto');
  const scope = opts.scope === 'pages' ? 'pages' : 'all';
  const pages = Array.isArray(opts.pages) ? opts.pages.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (scope === 'pages' && !pages.length) {
    throw new AppError('E_BAD_REQUEST', 'scope=pages 时必须给 pages 数组', { field: 'pages' });
  }

  const active = get(
    `SELECT * FROM translate_jobs WHERE asset_id = ? AND engine = ? AND tgt_lang = ? AND status IN ('queued','running','paused')`,
    [asset.id, engineId, tgtLang],
  );
  if (active) {
    // paused 的任务：这是「继续翻译」——重开 runner 继续跑，已译段直接命中缓存（不重复计费）
    if (active.status === 'paused') {
      run("UPDATE translate_jobs SET status='running', finished_at=NULL WHERE id = ?", [active.id]);
      const resumed = ensureRunner(active.id);
      resumed.canceled = false;
      resumed.ctl = new AbortController();
      runJob(active.id, { engineIds: [engineId, ...(config.translate.fallbackEngines || [])] }).catch((e) => {
        log.error('translate.resume_crash', { jobId: active.id, message: e.message });
        finishJob(active.id, 'failed', e.code || 'E_INTERNAL', e.message);
        emit(active.id, 'error', { code: e.code || 'E_INTERNAL', message: e.message });
      });
      log.info('translate.resume', { jobId: active.id, engine: engineId, tgtLang });
      return { jobId: active.id, reused: true, resumed: true, status: 'running' };
    }
    return { jobId: active.id, reused: true, status: active.status };
  }

  const promptFp = promptFingerprint(resolveTemplate(config));
  const model = resolveModel(engineId);

  let total = 0;
  if (scope === 'pages') {
    const placeholders = pages.map(() => '?').join(',');
    total = get(
      `SELECT count(*) AS n FROM segments WHERE asset_id = ? AND ${TRANSLATABLE} AND page_no IN (${placeholders})`,
      [asset.id, ...pages],
    ).n;
  } else {
    total = get(`SELECT count(*) AS n FROM segments WHERE asset_id = ? AND ${TRANSLATABLE}`, [asset.id]).n;
  }
  if (!total) throw new AppError('E_CONFLICT', '没有可翻译的段落（可能抽取结果为空）', { assetId: asset.id });

  const now = Date.now();
  const jobId = run(
    `INSERT INTO translate_jobs(asset_id, status, engine, model, src_lang, tgt_lang, prompt_fp, scope, scope_pages,
                                total_segments, done_segments, failed_segments, anchor_page, created_at, started_at)
     VALUES(?, 'running', ?,?,?,?,?,?,?,?,0,0,?,?,?)`,
    [
      asset.id,
      engineId,
      model,
      srcLang,
      tgtLang,
      promptFp,
      scope,
      scope === 'pages' ? JSON.stringify(pages) : null,
      total,
      Number.isInteger(opts.anchorPage) ? opts.anchorPage : null,
      now,
      now,
    ],
  ).lastInsertRowid;

  const runner = ensureRunner(jobId);
  if (opts.force) runner.canceled = false;
  log.info('translate.start', { jobId, no, engine: engineId, model, total, scope, tgtLang });
  // 异步跑，不阻塞 HTTP 响应（202 立刻返回 jobId）
  runJob(jobId, { engineIds: [engineId, ...(config.translate.fallbackEngines || [])] }).catch((e) => {
    log.error('translate.crash', { jobId, message: e.message, stack: e.stack });
    finishJob(jobId, 'failed', e.code || 'E_INTERNAL', e.message);
    emit(jobId, 'error', { code: e.code || 'E_INTERNAL', message: e.message });
  });
  return { jobId, reused: false, status: 'running' };
}

/** 取段（按 scope 过滤，只取可翻译段）。带 role：切批时图注要单独成批、送翻前还要过可翻性闸 */
function loadSegments(job) {
  const params = [job.asset_id];
  let where = `asset_id = ? AND ${TRANSLATABLE}`;
  if (job.scope === 'pages') {
    let pages = [];
    try {
      pages = JSON.parse(job.scope_pages || '[]');
    } catch {
      pages = [];
    }
    if (pages.length) {
      where += ` AND page_no IN (${pages.map(() => '?').join(',')})`;
      params.push(...pages);
    }
  }
  return all(`SELECT id, page_no, ord, role, text FROM segments WHERE ${where} ORDER BY page_no ASC, ord ASC`, params);
}

/** 排序：可见页优先（|page-anchor| 升序），其次 page/ord（§9.1.3 [4]） */
function sortByAnchor(list, anchor) {
  if (!Number.isInteger(anchor)) return list;
  return [...list].sort((a, b) => {
    const da = Math.abs(a.page_no - anchor);
    const db = Math.abs(b.page_no - anchor);
    if (da !== db) return da - db;
    if (a.page_no !== b.page_no) return a.page_no - b.page_no;
    return a.ord - b.ord;
  });
}

/** 有界并发池 */
async function pool(items, worker, limit) {
  const n = Math.max(1, Math.min(limit || 1, items.length));
  let cursor = 0;
  const runnersArr = Array.from({ length: n }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runnersArr);
}

/** 单批：引擎链顺序尝试，每引擎最多 2 次，间隔 700ms（§9.1.3 [7]） */
async function translateBatch(batch, engineChainList, ctx) {
  const errors = [];
  for (const engine of engineChainList) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (ctx.signal.aborted) throw new AppError('E_CANCELED', '翻译已取消');
      try {
        const out = await engine.translate(batch.map((s) => s.text), {
          srcLang: ctx.srcLang,
          tgtLang: ctx.tgtLang,
          work: ctx.work,
          promptFp: ctx.promptFp,
          model: ctx.model,
          kind: ctx.kind, // 'caption' → 追加图注专用提示（图注单独成批，见 runJob 的 plans）
          strict: Boolean(ctx.strict), // 体检打回后的严格重试：追加「必须输出中文」
          temperature: ctx.strict ? STRICT_TEMPERATURE : undefined,
          signal: ctx.signal,
          onUsage: ctx.onUsage,
        });
        if (!Array.isArray(out) || !out.length) {
          throw new AppError('E_UPSTREAM', `引擎返回非数组或空数组（期望 ${batch.length} 段）`, { engine: engine.id });
        }
        if (out.length !== batch.length) {
          // 不再整批失败：按序对齐、缺失补 null（对齐后的 null 段不写缓存，由上层体检/补译决定）。
          // 旧实现此处 throw → 整批重发；而"长度相同但内容串段"根本发现不了，会把下一段译文写进本段。
          log.warn('translate.length_mismatch', {
            engine: engine.id,
            expected: batch.length,
            got: out.length,
            filledNull: alignBatchOutput(batch.length, out).filter((x) => x == null).length,
          });
        }
        return { out: alignBatchOutput(batch.length, out), engine: engine.id };
      } catch (e) {
        errors.push({ engine: engine.id, code: e.code || 'E_UPSTREAM', message: e.message });
        if (e.code === 'E_CANCELED' || e.code === 'E_LLM_KEY_MISSING' || e.code === 'E_ENGINE_UNCONFIGURED') throw e;
        log.warn('translate.batch_attempt_failed', { engine: engine.id, attempt, code: e.code, message: e.message });
        if (attempt < 2) await sleep(700);
      }
    }
  }
  throw new AppError('E_UPSTREAM', `引擎链全部失败：${errors.slice(-3).map((e) => `${e.engine}:${e.code}`).join(' | ')}`, {
    errors: errors.slice(-3),
  });
}

/** 主执行体 */
async function runJob(jobId, { engineIds }) {
  const job = get('SELECT * FROM translate_jobs WHERE id = ?', [jobId]);
  if (!job) return;
  const asset = get('SELECT * FROM assets WHERE id = ?', [job.asset_id]);
  const work = get('SELECT * FROM works WHERE id = ?', [asset.work_id]);
  const runner = ensureRunner(jobId);
  const chain = engineChain(engineIds[0], engineIds.slice(1));
  if (!chain.length) {
    finishJob(jobId, 'failed', 'E_ENGINE_UNCONFIGURED', '没有可用的翻译引擎（缺少 apiKey/model）');
    emit(jobId, 'error', { code: 'E_ENGINE_UNCONFIGURED', message: '没有可用的翻译引擎' });
    return;
  }
  const engine = chain[0];

  // 取段后再过一道「原文可翻性」闸：SQL 已按角色挡掉 figure-label/header/footer/page-number/
  // equation/reference，这里只兜空文本与纯符号段。被跳过的段**不计入进度总数**（否则页面永远
  // 显示未完成），也不送翻、不写缓存 —— 阅读器直接显示原文。
  const loaded = loadSegments(job);
  const segments = [];
  const skippedByCode = new Map();
  for (const seg of loaded) {
    const verdict = assessSource(seg.text, seg.role);
    if (verdict.translatable) segments.push(seg);
    else skippedByCode.set(verdict.code, (skippedByCode.get(verdict.code) || 0) + 1);
  }
  if (skippedByCode.size) {
    log.info('translate.skip_untranslatable', {
      jobId,
      loaded: loaded.length,
      kept: segments.length,
      skipped: Object.fromEntries(skippedByCode),
    });
  }

  const extractedVersion = asset.extract_version;
  const keyOf = (seg) =>
    buildCacheKey({
      engine: job.engine,
      model: job.model || resolveModel(job.engine),
      tgtLang: job.tgt_lang,
      promptFp: job.prompt_fp,
      extractVersion: extractedVersion,
      text: seg.text,
    });

  // 缓存命中判定
  const misses = [];
  let hits = 0;
  for (const seg of segments) {
    const key = keyOf(seg);
    const row = get('SELECT cache_key FROM translations WHERE cache_key = ?', [key]);
    if (row) {
      hits += 1;
      run('UPDATE translations SET hits = hits + 1, last_hit_at = ? WHERE cache_key = ?', [Date.now(), key]);
    } else {
      misses.push({ ...seg, cacheKey: key });
    }
  }

  // 每页总段数（页面级增量推送用）
  const pageTotals = new Map();
  for (const seg of segments) pageTotals.set(seg.page_no, (pageTotals.get(seg.page_no) || 0) + 1);
  const pageDone = new Map();
  for (const pageNo of pageTotals.keys()) pageDone.set(pageNo, 0);
  // 已命中的段也算完成（用 Set 避免 O(n²)）
  const missIds = new Set(misses.map((m) => m.id));
  for (const seg of segments) {
    if (!missIds.has(seg.id)) pageDone.set(seg.page_no, (pageDone.get(seg.page_no) || 0) + 1);
  }

  let doneSegments = hits;
  let failedSegments = 0;
  let batchesDone = 0;
  let requests = 0;
  let batchCount = 0;
  const usage = { promptTokens: 0, completionTokens: 0, fallbackCount: 0 };
  const startedAt = Date.now();

  const pushProgress = (force = false) => {
    const payload = buildProgress(jobId, {
      total: segments.length,
      done: doneSegments,
      failed: failedSegments,
      pageTotals,
      pageDone,
      startedAt,
      batchesDone,
      requests,
      cacheHits: hits,
      force,
    });
    emit(jobId, 'progress', payload);
    // 运行期就把请求数/批数写进 jobStats：GET /api/jobs/translate/:id 走 progressFromDb，
    // 只读 DB 拿不到这两个内存计数，界面上会一直显示「请求 0」。
    jobStats.set(jobId, {
      requests,
      batches: batchCount,
      cacheHits: hits,
      usage,
      finishedAt: 0,
    });
    run('UPDATE translate_jobs SET done_segments = ?, failed_segments = ? WHERE id = ?', [doneSegments, failedSegments, jobId]);
  };
  pushProgress(true);

  const ordered = sortByAnchor(misses, job.anchor_page);
  // 切批：**保留 segment 对象**（不再用「text 数组 + cursor 回切」）。
  // 旧写法里 buildBatches 会跳过空串/纯空白段，而 cursor 仍按返回条数推进；
  // 只要跳过一段，其后所有 batch 的 segment 全部错位一格 → 译文串段（顺序错乱根因之一）。
  // 图注判定不能只看 role：实测抽取器把真正的图注（`Fig. 3 Comparison between …`）标成 body，
  // 只有图内标注（`CoT-SC ToT,LMZSP,RAP Prompts`）才标 figure-label。只按 role 分流会让图注
  // 混进普通正文批 → 模型把图内符号也「翻译」一遍，产出 EVRNKSHUHO 式大写垃圾。
  const isCaption = (s) => CAPTION_ROLES.includes(String(s.role || '')) || isCaptionLike(s.text);
  const captionSegs = ordered.filter(isCaption);
  const bodySegs = ordered.filter((s) => !isCaption(s));
  const plans = [
    ...chunkSegments(bodySegs, {
      maxChars: engine.limits.maxChars,
      maxItems: engine.limits.maxItems,
    }).map((segs) => ({ segs, caption: false })),
    // 图注/表注单独成批：条数收紧（图注短、编号密），并带专用提示（见 quality.CAPTION_ROLES）
    ...chunkSegments(captionSegs, {
      maxChars: Math.min(Number(engine.limits.maxChars) || 1200, 1200),
      maxItems: Math.min(Number(engine.limits.maxItems) || 4, 4),
    }).map((segs) => ({ segs, caption: true })),
  ];
  batchCount = plans.length;

  let lastProgressAt = 0;
  const flushEvery = 300;
  const failedFingerprints = new Map();

  await pool(
    plans,
    async ({ segs: batch, caption }) => {
      if (runner.canceled || runner.ctl.signal.aborted) return;
      const fingerprint = batch.map((s) => s.id).join(',');
      const attemptsSoFar = failedFingerprints.get(fingerprint) || 0;
      if (attemptsSoFar >= 2) {
        // 打转检测：同一批连续失败 2 次 → 记 failed，不再重试
        failedSegments += batch.length;
        pushProgress(true);
        return;
      }
      requests += 1;
      const batchCtx = {
        srcLang: job.src_lang,
        tgtLang: job.tgt_lang,
        work,
        promptFp: job.prompt_fp,
        model: job.model,
        kind: caption ? 'caption' : 'body',
        signal: runner.ctl.signal,
        onUsage: (u) => {
          usage.promptTokens += u.promptTokens || 0;
          usage.completionTokens += u.completionTokens || 0;
        },
      };
      try {
        const { out: raw, engine: usedEngine } = await translateBatch(batch, chain, batchCtx);

        // 落库前体检（quality.screenTranslation）：低 CJK 占比 / 无空格拉丁大写垃圾串 /
        // 整段英文原样返回 / 空译文 → 判失败。先只收集坏段，不落库。
        const aligned = alignBatchOutput(batch.length, raw);
        const accepted = new Array(batch.length).fill(null);
        const bad = [];
        const verdictAt = (i, dst) => screenTranslation({ src: batch[i].text, dst, tgtLang: job.tgt_lang });
        for (let i = 0; i < batch.length; i += 1) {
          const v = verdictAt(i, aligned[i]);
          if (v.ok) accepted[i] = aligned[i];
          else bad.push(i);
        }

        // 二次校验：**只重发被判坏的段**（temperature 降到 0.1 + 追加「必须输出中文」）。
        // 不整批重发：乱码通常只出现在个别段，整批重发等于为几段垃圾再付一遍钱。
        const rejected = [];
        if (bad.length) {
          const retrySegs = bad.map((i) => batch[i]);
          let retryRaw = null;
          try {
            retryRaw = (await translateBatch(retrySegs, chain, { ...batchCtx, strict: true })).out;
          } catch (e) {
            if (e.code === 'E_CANCELED') throw e;
            log.warn('translate.strict_retry_failed', { jobId, size: retrySegs.length, code: e.code, message: e.message });
          }
          const retryAligned = alignBatchOutput(retrySegs.length, retryRaw);
          bad.forEach((i, k) => {
            const v = verdictAt(i, retryAligned[k]);
            if (v.ok) accepted[i] = retryAligned[k];
            else {
              rejected.push({
                i,
                codes: v.codes,
                cjkRatio: Number(v.metrics.cjkRatio.toFixed(3)),
                latinRuns: v.metrics.latinRuns,
                sample: String(retryAligned[k] == null ? '' : retryAligned[k]).slice(0, 60),
                src: String(batch[i].text || '').slice(0, 60),
              });
            }
          });
        }

        const now = Date.now();
        const good = [];
        for (let i = 0; i < batch.length; i += 1) if (accepted[i]) good.push(i);
        // 译文落库与译文索引写在**同一事务**里（D22）：否则会出现「有译文但搜不到」的静默错误。
        // **只有通过体检的段才写**：乱码永不进缓存，避免被后续任务反复命中。
        if (good.length) {
          tx(() => {
            for (const i of good) {
              const seg = batch[i];
              run(
                `INSERT INTO translations(cache_key, asset_id, segment_id, page_no, ord, src_text, dst_text, engine, model,
                                          src_lang, tgt_lang, prompt_fp, extract_version, created_at, last_hit_at, hits)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
                 ON CONFLICT(cache_key) DO UPDATE SET dst_text = excluded.dst_text, segment_id = excluded.segment_id,
                                                     last_hit_at = excluded.last_hit_at`,
                [
                  seg.cacheKey,
                  job.asset_id,
                  seg.id,
                  seg.page_no,
                  seg.ord,
                  seg.text,
                  accepted[i],
                  job.engine,
                  job.model,
                  job.src_lang,
                  job.tgt_lang,
                  job.prompt_fp,
                  extractedVersion,
                  now,
                  now,
                ],
              );
              indexTranslation(seg.id, { engine: job.engine, tgtLang: job.tgt_lang, text: accepted[i] });
            }
          });
        }
        for (const i of good) doneSegments += 1;
        for (const r of rejected) {
          failedSegments += 1;
          // 该段保持无译文（dst=null，阅读器显示原文），把证据打进日志供判断"重翻/重抽"
          log.warn('translate.quality_rejected', {
            jobId,
            segmentId: batch[r.i].id,
            assetId: job.asset_id,
            page: batch[r.i].page_no,
            ord: batch[r.i].ord,
            codes: r.codes,
            cjkRatio: r.cjkRatio,
            latinRuns: r.latinRuns,
            sample: r.sample,
            src: r.src,
          });
        }
        // 进度：被拒绝的段本次运行也不会再动，按"已处理完"计入 pageDone，否则整页永远显示未完成
        for (const seg of batch) pageDone.set(seg.page_no, (pageDone.get(seg.page_no) || 0) + 1);
        if (usedEngine !== engine.id) usage.fallbackCount += 1;
        batchesDone += 1;
        const nowMs = Date.now();
        if (nowMs - lastProgressAt >= flushEvery) {
          lastProgressAt = nowMs;
          pushProgress();
        }
        // 页面级增量：该页全部完成 → 推 event: page
        for (const pageNo of new Set(batch.map((s) => s.page_no))) {
          if (pageDone.get(pageNo) >= pageTotals.get(pageNo)) {
            emit(jobId, 'page', loadPagePayload(job, pageNo));
          }
        }
      } catch (e) {
        if (e.code === 'E_CANCELED') return;
        failedFingerprints.set(fingerprint, attemptsSoFar + 1);
        failedSegments += batch.length;
        log.warn('translate.batch_failed', { jobId, size: batch.length, code: e.code, message: e.message });
        pushProgress(true);
      }
    },
    Math.min(config.translate.concurrency || 2, engine.concurrency || 2),
  );

  if (runner.canceled) {
    finishJob(jobId, 'paused', null, null, { doneSegments, failedSegments });
    emit(jobId, 'paused', buildProgress(jobId, { total: segments.length, done: doneSegments, failed: failedSegments, pageTotals, pageDone, startedAt }));
    return;
  }

  const status = failedSegments === 0 ? 'done' : doneSegments > 0 ? 'done' : 'failed';
  finishJob(jobId, status, status === 'failed' ? 'E_UPSTREAM' : null, status === 'failed' ? '全部批次失败' : null, { doneSegments, failedSegments });
  const finalPayload = buildProgress(jobId, { total: segments.length, done: doneSegments, failed: failedSegments, pageTotals, pageDone, startedAt });
  emit(jobId, 'done', {
    ...finalPayload,
    usage,
    cacheHits: hits,
    requests,
    batches: plans.length,
  });
  jobStats.set(jobId, { requests, batches: plans.length, cacheHits: hits, usage, finishedAt: Date.now() });
  log.info('translate.finished', {
    jobId,
    status,
    total: segments.length,
    done: doneSegments,
    failed: failedSegments,
    cacheHits: hits,
    batches: plans.length,
    requests,
    durationMs: Date.now() - startedAt,
  });
}

function buildProgress(jobId, p) {
  const donePages = [...p.pageTotals.keys()].filter((pg) => (p.pageDone.get(pg) || 0) >= p.pageTotals.get(pg)).length;
  const totalPages = p.pageTotals.size;
  return {
    jobId,
    totalSegments: p.total,
    doneSegments: p.done,
    failedSegments: p.failed,
    donePages,
    totalPages,
    cacheHits: p.cacheHits ?? 0,
    batchesDone: p.batchesDone ?? 0,
    requests: p.requests ?? 0,
    elapsedMs: p.startedAt ? Date.now() - p.startedAt : 0,
    at: Date.now(),
  };
}

/**
 * 从数据库重算进度（不依赖内存计数器）。
 *
 * 用途：① SSE 首帧 —— 客户端刚连上时 runner 里可能还没有计数；
 * ② `GET /api/jobs/translate/:id` —— 早先 donePages 用
 * `count(DISTINCT page_no) FROM translations`（库里所有历史页，跨任务、跨版本），
 * 与 totalPages（本任务的段口径）不是一回事，页数会显示成「7/10」这类假进度。
 */
function progressFromDb(jobId) {
  const job = get('SELECT * FROM translate_jobs WHERE id = ?', [jobId]);
  if (!job) return null;
  const asset = get('SELECT extract_version FROM assets WHERE id = ?', [job.asset_id]) || {};
  const rows = all(
    `SELECT id, page_no, text FROM segments
      WHERE asset_id = ? AND ${TRANSLATABLE}
      ORDER BY page_no ASC, ord ASC`,
    [job.asset_id],
  );
  const pageTotals = new Map();
  const pageDone = new Map();
  let done = 0;
  for (const r of rows) {
    pageTotals.set(r.page_no, (pageTotals.get(r.page_no) || 0) + 1);
    const key = buildCacheKey({
      engine: job.engine,
      model: job.model,
      tgtLang: job.tgt_lang,
      promptFp: job.prompt_fp,
      extractVersion: asset.extract_version,
      text: r.text,
    });
    if (get('SELECT 1 AS hit FROM translations WHERE cache_key = ?', [key])) {
      done += 1;
      pageDone.set(r.page_no, (pageDone.get(r.page_no) || 0) + 1);
    }
  }
  const stats = jobStats.get(jobId) || {};
  return {
    ...buildProgress(jobId, {
      total: rows.length,
      done,
      failed: job.failed_segments || 0,
      pageTotals,
      pageDone,
      startedAt: job.started_at || null,
      cacheHits: stats.cacheHits || 0,
      batchesDone: stats.batches || 0,
      requests: stats.requests || 0,
    }),
    status: job.status,
    engine: job.engine,
    model: job.model,
    tgtLang: job.tgt_lang,
  };
}

function loadPagePayload(job, pageNo) {
  const rows = all(
    `SELECT id, page_no, ord, text, is_math, is_label, is_heading, bbox,
            role, tier, align, ratio, gap_pct
       FROM segments
      WHERE asset_id = ? AND page_no = ? ORDER BY ord ASC`,
    [job.asset_id, pageNo],
  );
  const engine = job.engine;
  const model = job.model;
  const asset = get('SELECT extract_version FROM assets WHERE id = ?', [job.asset_id]);
  const paras = rows.map((r) => {
    const key = buildCacheKey({
      engine,
      model,
      tgtLang: job.tgt_lang,
      promptFp: job.prompt_fp,
      extractVersion: asset.extract_version,
      text: r.text,
    });
    const tr = get('SELECT dst_text FROM translations WHERE cache_key = ?', [key]);
    return {
      segmentId: r.id,
      pageNo: r.page_no,
      ord: r.ord,
      text: r.text,
      isMath: Boolean(r.is_math),
      isLabel: Boolean(r.is_label),
      isHeading: Boolean(r.is_heading),
      bbox: safeJson(r.bbox),
      // SSE 增量推来的页也要带排版层级，否则一边翻译一边看时，
      // 新到的段落全是「body/body/left」，与刷新后的排版不一致（标题、图注、公式都不对）。
      role: r.role || undefined,
      tier: r.tier || undefined,
      align: r.align || undefined,
      ratio: r.ratio == null ? undefined : r.ratio,
      gapPct: r.gap_pct == null ? undefined : r.gap_pct,
      dst: tr ? tr.dst_text : null,
      engine,
      model,
      cached: Boolean(tr),
    };
  });
  return { pageNo, paras };
}

function safeJson(t) {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

function finishJob(jobId, status, errorCode, errorMessage, counters = {}) {
  run(
    `UPDATE translate_jobs SET status = ?, error_code = ?, error_message = ?, finished_at = ?,
            done_segments = COALESCE(?, done_segments), failed_segments = COALESCE(?, failed_segments)
      WHERE id = ?`,
    [status, errorCode, errorMessage, Date.now(), counters.doneSegments ?? null, counters.failedSegments ?? null, jobId],
  );
}

/** GET /api/jobs/translate/:id */
export function getTranslateJob(id) {
  const job = get('SELECT * FROM translate_jobs WHERE id = ?', [Number(id)]);
  if (!job) throw new AppError('E_NOT_FOUND', `翻译任务不存在：${id}`, { jobId: id });
  // 进度一律按「本任务口径」算（可翻段数 / 缓存命中页数）。
  // 旧实现用 `count(DISTINCT page_no) FROM translations`（全库历史页）当 donePages，
  // 与 totalPages（本任务段所涉页）不是同一口径，刷新后页数会跳成假数字。
  const prog = progressFromDb(job.id) || {};
  return {
    jobId: job.id,
    status: job.status,
    engine: job.engine,
    model: job.model,
    tgtLang: job.tgt_lang,
    srcLang: job.src_lang,
    scope: job.scope,
    totalSegments: prog.totalSegments ?? job.total_segments,
    doneSegments: prog.doneSegments ?? job.done_segments,
    failedSegments: prog.failedSegments ?? job.failed_segments,
    totalPages: prog.totalPages ?? 0,
    donePages: prog.donePages ?? 0,
    requests: prog.requests ?? 0,
    cacheHits: prog.cacheHits ?? 0,
    anchorPage: job.anchor_page,
    errorCode: job.error_code,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    lastRun: jobStats.get(job.id) || null,
  };
}

/**
 * SSE 订阅（§8.7）。
 * @param {number} id jobId
 * @param {import('express').Response} res
 */
export function streamTranslateEvents(id, res) {
  const jobId = Number(id);
  const job = get('SELECT * FROM translate_jobs WHERE id = ?', [jobId]);
  if (!job) throw new AppError('E_NOT_FOUND', `翻译任务不存在：${id}`, { jobId: id });
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

  // 首帧：当前进度（重连的客户端立刻有底数）。
  // 早先这里手写字段，漏了 donePages/totalPages/requests，于是刚打开翻译面板时
  // 永远显示「页 0/— · 请求 0」；全命中缓存时更不会有后续帧来纠正它。
  send('progress', progressFromDb(jobId) || { jobId, totalSegments: 0, doneSegments: 0, failedSegments: 0, status: job.status });

  const listener = (event, payload) => send(event, payload);
  runner.listeners.add(listener);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    runner.listeners.delete(listener);
    // 客户端断开 → 中止上游（已译段保留，job 转 paused，可续译）
    if (runner.listeners.size === 0 && ['running', 'queued'].includes(currentStatus(jobId))) {
      runner.canceled = true;
      runner.ctl.abort();
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function currentStatus(jobId) {
  const row = get('SELECT status FROM translate_jobs WHERE id = ?', [jobId]);
  return row ? row.status : 'unknown';
}

/** POST /api/jobs/translate/:id/cancel */
export function cancelTranslateJob(id) {
  const jobId = Number(id);
  const job = get('SELECT * FROM translate_jobs WHERE id = ?', [jobId]);
  if (!job) throw new AppError('E_NOT_FOUND', `翻译任务不存在：${id}`, { jobId });
  const runner = ensureRunner(jobId);
  runner.canceled = true;
  runner.ctl.abort();
  const done = get(
    'SELECT count(*) AS n FROM translations WHERE asset_id = ? AND engine = ? AND tgt_lang = ?',
    [job.asset_id, job.engine, job.tgt_lang],
  ).n;
  run("UPDATE translate_jobs SET status='paused', finished_at=? WHERE id = ? AND status IN ('queued','running')", [Date.now(), jobId]);
  log.info('translate.cancel', { jobId, doneSegments: done });
  return { canceled: true, keptSegments: done };
}

/** 引擎连通性测试（POST /api/translate/test） */
export async function testEngine({ engine: engineId, tgtLang, sample } = {}) {
  const engine = requireEngine(engineId || config.translate.engine);
  const text = String(sample || 'The quick brown fox jumps over the lazy dog.');
  const t0 = Date.now();
  const out = await engine.translate([text], {
    srcLang: 'auto',
    tgtLang: tgtLang || config.translate.tgtLang,
    promptFp: promptFingerprint(resolveTemplate(config)),
    model: resolveModel(engine.id),
  });
  return { ok: true, engine: engine.id, model: resolveModel(engine.id), sample: out[0], latencyMs: Date.now() - t0 };
}

/** 试译（POST /api/translate/preview，不写缓存）。附带体检结论：预览里就能看到"这段会不会被判垃圾" */
export async function previewTranslate({ text, engine: engineId, tgtLang, srcLang } = {}) {
  const src = String(text || '').trim();
  if (!src) throw new AppError('E_BAD_REQUEST', '缺少 text', { field: 'text' });
  if (src.length > 2000) throw new AppError('E_BAD_REQUEST', 'text 不能超过 2000 字符', { field: 'text', length: src.length });
  const engine = requireEngine(engineId || config.translate.engine);
  const lang = tgtLang || config.translate.tgtLang;
  const t0 = Date.now();
  const out = await engine.translate([src], {
    srcLang: srcLang || 'auto',
    tgtLang: lang,
    promptFp: promptFingerprint(resolveTemplate(config)),
    model: resolveModel(engine.id),
  });
  return {
    dst: out[0],
    engine: engine.id,
    model: resolveModel(engine.id),
    latencyMs: Date.now() - t0,
    cached: false,
    // 只做判定、不改写：试译接口的用途就是让人看到模型的原始输出与被判坏的原因
    quality: screenTranslation({ src, dst: out[0], tgtLang: lang }),
  };
}

/** 双语 Markdown 导出（§8.4 / §16.1 store.toMarkdown 的语义） */
export function exportMarkdown(no, { bilingual = true } = {}) {
  const work = get('SELECT * FROM works WHERE no = ?', [no]);
  if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });
  const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
  if (!asset) throw new AppError('E_NOT_FOUND', '该条目没有本地 PDF', { no });
  const rows = all(
    `SELECT id, page_no, ord, text, is_math, is_label, is_heading FROM segments
      WHERE asset_id = ? ORDER BY page_no ASC, ord ASC`,
    [asset.id],
  );
  const job = get(
    'SELECT * FROM translate_jobs WHERE asset_id = ? ORDER BY id DESC LIMIT 1',
    [asset.id],
  );
  const lines = [];
  lines.push(`# ${work.title}${work.year ? ` (${work.year})` : ''}`);
  lines.push('');
  lines.push(`- 编号：${work.no}`);
  if (work.authors) lines.push(`- 作者：${work.authors}`);
  if (work.venue) lines.push(`- 出处：${work.venue}`);
  if (work.arxivId) lines.push(`- arXiv：${work.arxivId}`);
  lines.push(`- 抽取版本：${asset.extract_version}${job ? ` · 翻译引擎：${job.engine}/${job.model}` : ''}`);
  lines.push('');
  let currentPage = -1;
  for (const r of rows) {
    if (r.page_no !== currentPage) {
      currentPage = r.page_no;
      lines.push(`\n## 第 ${currentPage} 页\n`);
    }
    if (r.is_math) {
      lines.push('> 公式段（未翻译）');
      lines.push('');
      lines.push(r.text);
      lines.push('');
      continue;
    }
    if (bilingual) {
      lines.push(`> ${r.text}`);
      lines.push('');
    }
    const key = job
      ? buildCacheKey({
          engine: job.engine,
          model: job.model,
          tgtLang: job.tgt_lang,
          promptFp: job.prompt_fp,
          extractVersion: asset.extract_version,
          text: r.text,
        })
      : null;
    const tr = key ? get('SELECT dst_text FROM translations WHERE cache_key = ?', [key]) : null;
    lines.push(tr ? tr.dst_text : `（未翻译）${bilingual ? '' : r.text}`);
    lines.push('');
  }
  return { filename: `${work.no}__${work.title.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60)}${bilingual ? ' 双语对照' : ''}.md`, markdown: lines.join('\n') };
}

/**
 * 启动恢复（§9.4 ③ 的翻译版）：
 * 单进程没有后台调度器，重启后不可能「自动接着跑」，所以把上次遗留的 running/queued 置为 **paused**，
 * 由用户在阅读器点「继续翻译」恢复（已译段命中缓存，不重复计费）。
 * 设计文档写的是置 queued，这里改成 paused —— 差别在于「谁会真的去跑它」，不置 paused 会显示一个永远不会动的任务。
 * @returns {number} 被改写的行数
 */
export function bootTranslateJobs() {
  const r = run("UPDATE translate_jobs SET status='paused' WHERE status IN ('running','queued')");
  return r.changes;
}

/** 运行中任务数（健康检查用） */
export function activeTranslateCount() {
  return get("SELECT count(*) AS n FROM translate_jobs WHERE status IN ('queued','running')").n;
}
