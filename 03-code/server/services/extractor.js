/**
 * 抽取器（§16.3 / D4 / D17）：pdfjs-dist（服务端权威）→ RawPage → buildPages → segments + FTS。
 *
 * 为什么服务端为权威：浏览器与服务端各跑一次 pdf.js，版本/字体回退不同 → 段落不可复现。
 * 翻译缓存会随浏览器升级漂移。因此这里抽取写库，浏览器只渲染（§16.2）。
 *
 * 确定性要求：同一 PDF 每次抽出的 items 必须一致 —— 单 worker、关 eval、关系统字体。
 * 固定 pdfjs 版本（D17）。`EXTRACTOR_VERSION` 与 pdfjs 版本一起写入 settings，
 * 用于解释「缓存为什么失效」。
 */
import fs from 'node:fs';
import { all, get, run, tx } from '../db.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { absFromRel } from './storage.js';
import { buildPagesFromRaw } from './pdf/buildPages.js';
import { buildVocabulary, restoreSpacesInItems } from './pdf/spaceFix.js';
import { FIGURE_VERSION, attachCaptionAnchors, collectInkBoxes, detectPageFigures } from './pdf/figures.js';
import { indexSegments, deleteIndexForAsset, deleteTranslationIndexForAsset } from './fts.js';
import { buildCacheKey } from './translate/cacheKey.js';

const log = createLogger('extractor');

/**
 * 抽取算法版本：S1–S7 任何语义变化都要 +1（与 pdfjs 版本共同决定段落是否可比）。
 * v5：图注独立成 caption、子段 bbox 按字符数比例切分（不再复用块级包围盒）、
 *     每页写 `page_figures`、payload 带每页真实宽高。
 */
export const EXTRACTOR_VERSION = 5;
export const PDFJS_VERSION = '6.4.299';

let pdfjsModule = null;

/** 懒加载 pdfjs（ESM），只加载一次。 */
async function loadPdfjs() {
  if (pdfjsModule) return pdfjsModule;
  // pdfjs 在 Node 下会尝试加载可选的 @napi-rs/canvas（原生预编译包，仅用于在服务端渲染图像）。
  // 我们用不到它（只取 textContent），且项目要求「零原生模块」，因此在 .npmrc 里用 omit=optional 装依赖。
  // 缺它时 pdfjs 会在导入阶段打三条 polyfill 告警 —— 这里在导入期间静音，避免污染日志。
  // 真正影响抽取的错误是抛异常，不会被这条静音掩盖。
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return pdfjsModule;
}

/** 固定住 pdfjs 打开参数：目的只有一个 —— 结果可复现。 */
function documentOptions(data) {
  return {
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  };
}

/**
 * 把 PDF 抽成 RawPage[]（纯抽取，不写库）。
 * @param {string} absPath
 * @param {{maxPages?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{pageCount:number, pages:Array, pdfjsVersion:string}>}
 */
export async function readRawPages(absPath, opts = {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(absPath));
  let doc;
  let loadingTask = null;
  try {
    loadingTask = pdfjs.getDocument(documentOptions(data));
    doc = await loadingTask.promise;
  } catch (e) {
    const name = e && e.name;
    if (name === 'PasswordException') {
      throw new AppError('E_EXTRACT_FAILED', 'PDF 已加密，无法抽取（本期不做解密）', { reason: name });
    }
    throw new AppError('E_EXTRACT_FAILED', `无法解析 PDF：${e.message}`, { reason: name || 'parse' });
  }
  const pageCount = doc.numPages;
  const limit = opts.maxPages && opts.maxPages > 0 ? Math.min(opts.maxPages, pageCount) : pageCount;
  const pages = [];
  try {
    for (let i = 1; i <= limit; i += 1) {
      if (opts.signal && opts.signal.aborted) throw new AppError('E_CANCELED', '抽取已取消');
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      // 图区检测需要 operator list（位图/矢量路径的变换矩阵）。它比 textContent 贵，
      // 但失败不能影响文本抽取：拿不到就退化成「只有文字覆盖」的判据（ink=null）。
      let ink = null;
      try {
        const opList = await page.getOperatorList();
        ink = collectInkBoxes(opList, pdfjs.OPS);
      } catch (e) {
        ink = null;
      }
      pages.push({
        pageNo: i,
        width: viewport.width, // 已是旋转后的可视尺寸（不要用 view[2]/view[3]）
        height: viewport.height,
        items: tc.items,
        ink,
      });
      if (typeof page.cleanup === 'function') page.cleanup();
    }
  } finally {
    // pdfjs 6 在 Node 下没有 doc.destroy()，用 loadingTask.destroy() 释放 worker/资源
    try {
      if (typeof doc.cleanup === 'function') await doc.cleanup();
    } catch {
      /* 释放失败不影响已取到的 items */
    }
    try {
      if (loadingTask && typeof loadingTask.destroy === 'function') await loadingTask.destroy();
    } catch {
      /* 同上 */
    }
  }
  return { pageCount, pages, pdfjsVersion: pdfjs.version };
}

/**
 * pdf.js 的空白修复层。
 *
 * 本库这类 IEEE 老排版用负 `Tw` 压缩词距，空格 advance 掉到 pdf.js 的空白判定阈值以下，
 * `TRACKING_SPACE_FACTOR` 阈值以下，于是 `saveLastChar/shouldAddWhitepsace` 直接把空格丢掉，
 * 拿到的是 `forcontrollingmobilerobots` 这种整段粘连串。`keepWhiteSpace` 选项不对外透传
 * （pdf.mjs 里 streamTextContent 只发 includeMarkedContent/disableNormalization），
 * 因此只能在拿到 str 之后用文档词表 + DP 重新切分（见 pdf/spaceFix.js）。
 * @param {Array} pages readRawPages 的 pages
 * @returns {{fixedItems:number, fixedChars:number, vocabSize:number, glueSize:number}}
 */
export function restoreSpacesInPages(pages, sink) {
  const stats = { fixedItems: 0, fixedChars: 0, vocabSize: 0, glueSize: 0 };
  try {
    const voc = buildVocabulary(pages);
    if (sink) sink.vocab = voc; // 词表要复用给段级修复（见 buildPagesFromRaw 的 spaceVocab），但不进 JSON 摘要
    stats.vocabSize = voc.freq ? voc.freq.size : 0;
    stats.glueSize = voc.glue ? voc.glue.size : 0;
    for (const p of pages || []) {
      const before = p.items;
      const after = restoreSpacesInItems(before, voc);
      if (after === before) continue;
      for (let i = 0; i < after.length; i += 1) {
        if (after[i] === before[i]) continue;
        stats.fixedItems += 1;
        const a = typeof before[i].str === 'string' ? before[i].str.length : 0;
        const b = typeof after[i].str === 'string' ? after[i].str.length : 0;
        stats.fixedChars += Math.max(0, b - a);
      }
      p.items = after;
    }
  } catch (e) {
    // 词表修复是「锦上添花」，失败不能阻断抽取 —— 宁可留着粘连串也要出文本。
    stats.error = String((e && e.message) || e);
  }
  return stats;
}

/**
 * 抽取 + 落库（幂等：已 ready 且未 force 则直接返回现有统计）。
 * @param {number} assetId
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<Object>} 抽取摘要（含逐页栏判定 evidence，便于自测与排障）。
 */
export async function extractAsset(assetId, opts = {}) {
  const asset = get('SELECT * FROM assets WHERE id = ?', [Number(assetId)]);
  if (!asset) throw new AppError('E_NOT_FOUND', `资产不存在：${assetId}`, { assetId });
  if (!asset.storage_rel_path) throw new AppError('E_NOT_FOUND', '该资产没有本地文件', { assetId });
  const abs = absFromRel(asset.storage_rel_path);

  if (!opts.force && asset.extract_status === 'ready') {
    const stat = get('SELECT count(*) AS n, max(page_no) AS pages FROM segments WHERE asset_id = ?', [asset.id]);
    if (stat.n > 0) {
      return {
        assetId: asset.id,
        reused: true,
        extractStatus: 'ready',
        extractVersion: asset.extract_version,
        pageCount: asset.page_count,
        segments: stat.n,
        pdfjsVersion: readRuntimeInfo().pdfjsVersion || PDFJS_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
      };
    }
  }

  const t0 = Date.now();
  run("UPDATE assets SET extract_status='extracting', extract_error=NULL, updated_at=? WHERE id=?", [Date.now(), asset.id]);

  let raw;
  try {
    raw = await readRawPages(abs);
  } catch (e) {
    run("UPDATE assets SET extract_status='failed', extract_error=?, updated_at=? WHERE id=?", [
      String(e.message).slice(0, 500),
      Date.now(),
      asset.id,
    ]);
    throw e instanceof AppError ? e : new AppError('E_EXTRACT_FAILED', e.message);
  }

  // 词表修空格：必须在 buildPages 之前（本库 PDF 用负 Tw 压词距，pdf.js 会把空格吞掉）。
  const spaceSink = {};
  const spaceStats = restoreSpacesInPages(raw.pages, spaceSink);

  // 每页图区（第一遍：墨迹）。必须在 buildPages 之前 —— 图注与图内标注的判定要用它。
  const figures = new Map();
  const figureStats = { pages: 0, inkPages: 0, pagesWithFigures: 0, boxes: 0, captionAnchors: 0 };
  for (const page of raw.pages) {
    let fig = { boxes: [] };
    try {
      fig = detectPageFigures({ width: page.width, height: page.height, items: page.items, ink: page.ink });
    } catch (e) {
      log.warn('extract.figures_failed', { assetId: asset.id, pageNo: page.pageNo, error: String(e && e.message) });
    }
    figures.set(page.pageNo, fig.boxes);
    figureStats.pages += 1;
    if (page.ink) figureStats.inkPages += 1;
  }

  const built = buildPagesFromRaw(raw.pages, {
    paragraphChars: config.extract.paragraphChars,
    roleRules: config.extract.roleRules,
    paragraphGapRatio: config.extract.paragraphGapRatio,
    columnRules: config.extract.columnRules,
    // item 之间的小正间隙同样会吞空格（`Layers of` + `control` 拼成 `ofcontrol`），
    // 段落成形后再用同一份词表扫一遍，把这类「跨 item 粘连」也切开。
    spaceVocab: spaceSink.vocab || null,
    // 图区：用于把 caption / figure-label 与正文分开（见 buildPages.classifyRich）
    pageFigures: figures,
  });

  // 第二遍图区：图注反推。本库不少插图整幅由文字/符号字形画出（asset 5 p1 的 Figure 1
  // 就是 405 个 showText，operator list 里既无位图也无路径），墨迹检测拿不到任何框，
  // 只能靠「图注上方的空白区」补出来。
  const anchor = attachCaptionAnchors(figures, built);
  figureStats.captionAnchors = anchor.added;
  for (const page of built) {
    const boxes = figures.get(page.pageNo) || [];
    if (boxes.length) figureStats.pagesWithFigures += 1;
    figureStats.boxes += boxes.length;
  }

  const totalPages = built.length;
  const pagesWithText = built.filter((p) => p.paras.some((x) => x.text.trim().length > 0)).length;
  const textPageRatio = totalPages ? pagesWithText / totalPages : 0;

  if (textPageRatio < 0.5) {
    run("UPDATE assets SET extract_status='needs_ocr', extract_error=?, page_count=?, updated_at=? WHERE id=?", [
      `无文本层（有文本页占比 ${(textPageRatio * 100).toFixed(0)}% < 50%）`,
      raw.pageCount,
      Date.now(),
      asset.id,
    ]);
    log.warn('extract.needs_ocr', { assetId: asset.id, textPageRatio });
    return {
      assetId: asset.id,
      extractStatus: 'needs_ocr',
      pageCount: raw.pageCount,
      segments: 0,
      textPageRatio,
      pdfjsVersion: raw.pdfjsVersion,
      extractorVersion: EXTRACTOR_VERSION,
      durationMs: Date.now() - t0,
    };
  }

  // 版本号就是「抽取算法版本」，不再在每次强制重抽时自增。
  // 旧做法 `force ? extract_version + 1 : max(extract_version, 1)` 会把版本号变成「重抽次数」，
  // 于是「库里存的版本 < 当前算法版本」这个判断失效（重抽过 9 次的旧文档看起来永远比代码新），
  // 前端也就无法自动识别哪些文档还是旧结构。改由 EXTRACTOR_VERSION 统一描述算法：
  // 算法一动就 +1，重抽后写入同一个值，前端的陈旧检测（storedV !== currentV）即可自愈。
  const nextVersion = EXTRACTOR_VERSION;
  const now = Date.now();
  const inserted = [];

  tx(() => {
    deleteIndexForAsset(asset.id);
    // 段 id 会变：译文索引必须跟着清，否则会指向已删除的段（搜到却取不回来）
    deleteTranslationIndexForAsset(asset.id);
    run('DELETE FROM segments WHERE asset_id = ?', [asset.id]);
    for (const page of built) {
      page.paras.forEach((p, ord) => {
        const res = run(
          `INSERT INTO segments(asset_id, page_no, ord, text, char_len, is_math, is_label, is_heading, bbox, role, tier, align, ratio, gap_pct, extract_version)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            asset.id,
            page.pageNo,
            ord,
            p.text,
            p.text.length,
            p.isMath ? 1 : 0,
            p.isLabel ? 1 : 0,
            p.isHeading ? 1 : 0,
            JSON.stringify(p.bbox),
            p.role ?? null,
            p.tier ?? null,
            p.align ?? null,
            p.ratio ?? null,
            p.gapPct ?? null,
            nextVersion,
          ],
        );
        inserted.push({ id: res.lastInsertRowid, text: p.text, isMath: p.isMath, isLabel: p.isLabel });
      });
    }
    // FTS 只索引可翻译/可检索的段（公式与图内标注不进索引，§7 DDL 注释）
    indexSegments(
      asset.id,
      inserted.filter((s) => !s.isMath && !s.isLabel).map((s) => ({ id: s.id, text: s.text })),
    );
    // 图区：整页覆盖写（含没有图的页 —— 前端要用这里的 width/height 做真实比例排版）
    run('DELETE FROM page_figures WHERE asset_id = ?', [asset.id]);
    for (const page of raw.pages) {
      const boxes = figures.get(page.pageNo) || [];
      run(
        `INSERT INTO page_figures(asset_id, page_no, boxes, width, height, version, updated_at)
         VALUES(?,?,?,?,?,?,?)`,
        [asset.id, page.pageNo, JSON.stringify(boxes), round2(page.width), round2(page.height), FIGURE_VERSION, now],
      );
    }
    run(
      `UPDATE assets SET extract_status='ready', extract_version=?, extract_error=NULL, page_count=?,
                         last_verified_at=?, updated_at=? WHERE id=?`,
      [nextVersion, raw.pageCount, now, now, asset.id],
    );
    persistRuntimeInfo(raw.pdfjsVersion, nextVersion, asset.id);
  });

  const perPage = built.map((p) => ({ pageNo: p.pageNo, columns: p.columns, paras: p.paras.length }));
  const summary = {
    assetId: asset.id,
    reused: false,
    extractStatus: 'ready',
    extractVersion: nextVersion,
    extractorVersion: EXTRACTOR_VERSION,
    pdfjsVersion: raw.pdfjsVersion,
    pageCount: raw.pageCount,
    pagesExtracted: totalPages,
    segments: inserted.length,
    avgSegmentsPerPage: totalPages ? Number((inserted.length / totalPages).toFixed(2)) : 0,
    textPageRatio: Number(textPageRatio.toFixed(3)),
    spaceFix: spaceStats,
    figures: figureStats,
    columnStats: {
      oneColumn: built.filter((p) => p.columns === '1').length,
      twoColumn: built.filter((p) => p.columns === '2').length,
    },
    perPage,
    evidence: built.map((p) => ({
      pageNo: p.pageNo,
      columns: p.columns,
      splitX: p.splitX,
      gapStartPct: p.evidence.gapStartPct,
      gapEndPct: p.evidence.gapEndPct,
      ratio: p.evidence.ratio,
      leftChars: p.evidence.leftChars,
      rightChars: p.evidence.rightChars,
      reason: p.evidence.reason,
    })),
    durationMs: Date.now() - t0,
  };
  log.info('extract.done', {
    assetId: asset.id,
    version: nextVersion,
    pages: summary.pageCount,
    segments: summary.segments,
    twoColumnPages: summary.columnStats.twoColumn,
    durationMs: summary.durationMs,
  });
  return summary;
}

function persistRuntimeInfo(pdfjsVersion, extractVersion, assetId) {
  const value = JSON.stringify({
    pdfjsVersion,
    extractorVersion: EXTRACTOR_VERSION,
    lastAssetId: assetId,
    lastExtractVersion: extractVersion,
    at: Date.now(),
  });
  run(
    `INSERT INTO settings(key, value, updated_at) VALUES('extract.runtime', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [value, Date.now()],
  );
}

/** 读回运行时信息（/api/health、segments 元信息用）。 */
export function readRuntimeInfo() {
  const row = get("SELECT value FROM settings WHERE key = 'extract.runtime'");
  if (!row) return { pdfjsVersion: PDFJS_VERSION, extractorVersion: EXTRACTOR_VERSION };
  try {
    return JSON.parse(row.value);
  } catch {
    return { pdfjsVersion: PDFJS_VERSION, extractorVersion: EXTRACTOR_VERSION };
  }
}

/** 取回段（按页分组，附可选译文），用于 GET /works/:no/segments */
export function getSegments(assetId, { page, from, to, translation = null } = {}) {
  const where = ['s.asset_id = ?'];
  const params = [Number(assetId)];
  if (page) {
    where.push('s.page_no = ?');
    params.push(Number(page));
  }
  if (from) {
    where.push('s.id >= ?');
    params.push(Number(from));
  }
  if (to) {
    where.push('s.id <= ?');
    params.push(Number(to));
  }
  const rows = all(
    `SELECT s.id, s.page_no, s.ord, s.text, s.is_math, s.is_label, s.is_heading, s.bbox, s.char_len,
            s.role, s.tier, s.align, s.ratio, s.gap_pct
       FROM segments s WHERE ${where.join(' AND ')} ORDER BY s.page_no ASC, s.ord ASC`,
    params,
  );
  const asset = get('SELECT page_count, storage_rel_path, extract_version FROM assets WHERE id = ?', [assetId]);
  // 每页真实尺寸 + 图区（v5）。老数据还没重算时这两张表为空 → 回落到旧行为（width=null、aspect 写死），
  // 保证接口向后兼容：老调用方不读新字段也能工作。
  const figRows = all(
    'SELECT page_no, boxes, width, height FROM page_figures WHERE asset_id = ? ORDER BY page_no ASC',
    [Number(assetId)],
  );
  const pageSizes = new Map();
  const pageFigures = {};
  for (const r of figRows) {
    pageSizes.set(r.page_no, { width: r.width, height: r.height });
    const boxes = safeParse(r.boxes);
    if (Array.isArray(boxes) && boxes.length) pageFigures[r.page_no] = boxes;
  }
  const byPage = new Map();
  for (const r of rows) {
    if (!byPage.has(r.page_no)) byPage.set(r.page_no, []);
    let tr = null;
    if (translation) {
      const key = buildCacheKey({
        engine: translation.engine,
        model: translation.model,
        tgtLang: translation.tgtLang,
        promptFp: translation.promptFp,
        extractVersion: asset ? asset.extract_version : 0,
        text: r.text,
      });
      tr = get('SELECT dst_text, engine, model FROM translations WHERE cache_key = ?', [key]);
    }
    byPage.get(r.page_no).push({
      segmentId: r.id,
      pageNo: r.page_no,
      ord: r.ord,
      text: r.text,
      charLen: r.char_len,
      isMath: Boolean(r.is_math),
      isLabel: Boolean(r.is_label),
      isHeading: Boolean(r.is_heading),
      bbox: safeParse(r.bbox),
      role: r.role ?? null,
      tier: r.tier ?? null,
      align: r.align ?? null,
      ratio: r.ratio ?? null,
      gapPct: r.gap_pct ?? null,
      dst: tr ? tr.dst_text : null,
      engine: tr ? tr.engine : null,
      model: tr ? tr.model : null,
      cached: Boolean(tr),
    });
  }
  return {
    assetId: Number(assetId),
    pageCount: asset ? asset.page_count : null,
    // 图区：`{ [pageNo]: [[x0,y0,x1,y1], ...] }`，与 segments.bbox 同一坐标口径（PDF 点、y 向上）。
    // 老调用方忽略该字段即可（新增字段，不动既有字段语义）。
    pageFigures,
    pages: [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pageNo, paras]) => {
        const size = pageSizes.get(pageNo);
        const width = size && Number(size.width) > 0 ? Number(size.width) : null;
        const height = size && Number(size.height) > 0 ? Number(size.height) : null;
        return {
          pageNo,
          // 真实页面比例（此前写死 1/1.294，对 1.19/2.6/2.3 的页面偏差 13–16%）
          aspect: width && height ? Number((width / height).toFixed(4)) : 1 / 1.294,
          width,
          height,
          paras,
        };
      }),
  };
}

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function safeParse(t) {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}
