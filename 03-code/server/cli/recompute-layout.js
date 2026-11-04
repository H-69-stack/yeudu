#!/usr/bin/env node
/**
 * `node server/cli/recompute-layout.js` —— 一次性重算版面（schema v5 的存量数据入口）。
 *
 * 干什么（**不删段、不改文本**，只更新 `bbox / role / tier` 与 `page_figures`）：
 *  1. 重开 PDF，用 `getOperatorList()` 收集墨迹 → 每页图区（3–8 个候选框，重叠框已合并）；
 *  2. 同 bbox 分组按字符数比例重切 y 跨度（规则与 `buildPages.splitBlockBBox` 相同），
 *     再多一遍 `dedupeBBoxes` 兜底 —— 保证「同页同 bbox」不再出现；
 *  3. 用与抽取完全相同的一套 `classifyRich`（含图区上下文）重算 role/tier：
 *     图注 → `caption`（tier=small），图内短标注 → `figure-label`，其余保持原判定；
 *  4. 用图注反推图区（`attachCaptionAnchors`），补上「整幅由文字/符号字形画成」的插图；
 *  5. 整页覆盖写 `page_figures`（含 width/height，前端据此按真实页面比例排版）。
 *
 * 幂等：所有判定都是确定性的；第二次跑时重复组已消失、role 已就位，
 * 只有内容真的变了的行才会 UPDATE（`changed=0`），可以随时重跑。
 *
 * 用法：
 *   node server/cli/recompute-layout.js                 # 全部 ready 资产
 *   node server/cli/recompute-layout.js 5 14            # 只跑指定资产
 *   node server/cli/recompute-layout.js --dry-run       # 只算不写，打印统计
 *   node server/cli/recompute-layout.js --keep-roles    # 只修 bbox + 图区，不动角色（保留 AI 精排结果）
 *   node server/cli/recompute-layout.js --sync-flags    # 顺带同步 is_math/is_label/is_heading 并重建该资产 FTS
 *
 * 注意：会按启发式覆盖 role/tier。对跑过「AI 精排」的文档请用 `--keep-roles`，
 * 否则精排产出的角色会被这里的规则替换（job/refine 的产物就是同样的 role/tier 列）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, applyDbSettings, ensureDirs, paths } from '../config.js';
import { openDb, closeDb, all, get, run } from '../db.js';
import { migrate } from '../migrate.js';
import { initLogger, createLogger } from '../logger.js';
import { absFromRel } from '../services/storage.js';
import { readRawPages } from '../services/extractor.js';
import {
  groupLines,
  estimateBodyFont,
  classifyRich,
  adjustRoleForPage,
  dedupeBBoxes,
} from '../services/pdf/buildPages.js';
import { FIGURE_VERSION, attachCaptionAnchors, detectPageFigures } from '../services/pdf/figures.js';
import { indexSegments, deleteIndexForAsset } from '../services/fts.js';

const log = createLogger('recompute-layout');

/**
 * 重算入口（DB 必须已打开、迁移已跑完；配置里的 roleRules 会被读取）。
 * @param {{assetIds?:number[], dryRun?:boolean, keepRoles?:boolean, syncFlags?:boolean, verbose?:boolean}} [opts]
 * @returns {Promise<Object>} 汇总统计
 */
export async function recomputeLayout(opts = {}) {
  const { assetIds = [], dryRun = false, keepRoles = false, syncFlags = false, verbose = true } = opts;
  const cfg = loadConfig();
  const assets = assetIds.length
    ? all(`SELECT id, storage_rel_path, page_count FROM assets WHERE id IN (${assetIds.map(() => '?').join(',')})`, assetIds)
    : all("SELECT id, storage_rel_path FROM assets WHERE extract_status = 'ready' AND storage_rel_path IS NOT NULL");
  const totals = {
    assets: 0,
    pages: 0,
    dupBefore: 0,
    dupAfter: 0,
    rowsChanged: 0,
    captions: 0,
    labels: 0,
    pagesWithFigures: 0,
    boxes: 0,
    anchors: 0,
    figuresRows: 0,
    failed: 0,
  };
  if (!assets.length) return totals;

  for (const asset of assets) {
    const t0 = Date.now();
    let raw;
    try {
      raw = await readRawPages(absFromRel(asset.storage_rel_path));
    } catch (e) {
      totals.failed += 1;
      console.error(`asset ${asset.id}: 读 PDF 失败 —— ${e.message}`);
      continue;
    }

    // ── 1. 第一遍图区（墨迹）─────────────────────────────────────────────
    const figures = new Map();
    const pageMeta = new Map();
    for (const page of raw.pages) {
      let fig = { boxes: [] };
      try {
        fig = detectPageFigures({ width: page.width, height: page.height, items: page.items, ink: page.ink });
      } catch (e) {
        log.warn('recompute.figures_failed', { assetId: asset.id, pageNo: page.pageNo, error: String(e && e.message) });
      }
      figures.set(page.pageNo, fig.boxes);
      const lines = groupLines(page.items);
      pageMeta.set(page.pageNo, {
        width: page.width,
        height: page.height,
        bodyFont: estimateBodyFont([{ lines }]) || 10,
      });
    }

    // ── 2. 读出现有段（只动几何/角色，文本一字不改）─────────────────────
    const rows = all(
      `SELECT id, page_no, ord, text, char_len, bbox, role, tier, align, ratio, is_math, is_label, is_heading
         FROM segments WHERE asset_id = ? ORDER BY page_no ASC, ord ASC`,
      [asset.id],
    );
    const parsed = rows.map((r) => ({ ...r, bbox_raw: r.bbox, bbox: parseBBox(r.bbox) }));
    const dupBefore = countDupGroups(parsed);

    // ── 3. 同 bbox 分组重切 + 兜底去重 ──────────────────────────────────
    resliceDuplicateGroups(parsed); // 规则见函数注释（= splitBlockBBox）
    dedupeBBoxes(parsed);
    const dupAfter = countDupGroups(parsed);

    // ── 4. 角色重算（两遍：先按墨迹图区判，再由图注反推补图区后复判）────
    const classifyAll = () => {
      for (const r of parsed) {
        if (!r.bbox) continue;
        const meta = pageMeta.get(r.page_no) || { width: 612, bodyFont: 10 };
        const ratio = Number(r.ratio) > 0 ? Number(r.ratio) : 1;
        const block = {
          text: r.text,
          fontSize: Math.max(1, meta.bodyFont * ratio),
          x0: r.bbox[0],
          y0: r.bbox[1],
          y1: r.bbox[3],
          yBottom: r.bbox[1],
          yTop: r.bbox[3],
        };
        const rich = classifyRich(block, meta.bodyFont, meta.width, cfg.extract.roleRules, {
          figureBoxes: figures.get(r.page_no) || null,
          alignInherit: r.align || undefined,
        });
        // 与抽取时的页眉纠正是同一函数（否则重算会把 header 变回 section）
        adjustRoleForPage(rich, block, { height: meta.height }, r.text);
        r.rich = rich;
        r.newRole = keepRoles ? r.role : rich.role;
        r.newTier = keepRoles ? r.tier : rich.tier;
      }
    };
    classifyAll();
    const pseudoPages = [...pageMeta.entries()].map(([pageNo, meta]) => ({
      pageNo,
      width: meta.width,
      height: meta.height,
      paras: parsed.filter((r) => r.page_no === pageNo && r.bbox).map((r) => ({ role: r.newRole, bbox: r.bbox })),
    }));
    const anchor = attachCaptionAnchors(figures, pseudoPages);
    if (anchor.added) classifyAll(); // 补出来的图区会让「紧邻图区的短段」也变成 caption

    // ── 5. 落库 ─────────────────────────────────────────────────────────
    let changed = 0;
    let captions = 0;
    let labels = 0;
    let flagsChanged = 0;
    for (const r of parsed) {
      if (r.newRole === 'caption') captions += 1;
      if (r.newRole === 'figure-label') labels += 1;
      if (!r.bbox) continue;
      const bboxJson = JSON.stringify(r.bbox);
      const bboxChanged = bboxJson !== r.bbox_raw;
      const roleChanged = r.newRole !== r.role || r.newTier !== r.tier;
      const flagChanged =
        syncFlags &&
        (Boolean(r.rich.isMath) !== Boolean(r.is_math) ||
          Boolean(r.rich.isLabel) !== Boolean(r.is_label) ||
          Boolean(r.rich.isHeading) !== Boolean(r.is_heading));
      if (!bboxChanged && !roleChanged && !flagChanged) continue;
      changed += 1;
      if (flagChanged) flagsChanged += 1;
      if (dryRun) continue;
      if (syncFlags) {
        run(
          'UPDATE segments SET bbox = ?, role = ?, tier = ?, is_math = ?, is_label = ?, is_heading = ? WHERE id = ?',
          [
            bboxJson,
            r.newRole ?? null,
            r.newTier ?? null,
            r.rich.isMath ? 1 : 0,
            r.rich.isLabel ? 1 : 0,
            r.rich.isHeading ? 1 : 0,
            r.id,
          ],
        );
      } else {
        // 交付⑤的口径：只更新 bbox / role / tier，不碰文本与 is_* 列
        run('UPDATE segments SET bbox = ?, role = ?, tier = ? WHERE id = ?', [
          bboxJson,
          r.newRole ?? null,
          r.newTier ?? null,
          r.id,
        ]);
      }
    }

    let figuresRows = 0;
    let boxesTotal = 0;
    let pagesWithFigures = 0;
    const now = Date.now();
    for (const page of raw.pages) {
      const boxes = figures.get(page.pageNo) || [];
      if (boxes.length) pagesWithFigures += 1;
      boxesTotal += boxes.length;
      const boxesJson = JSON.stringify(boxes);
      const prev = get('SELECT boxes, width, height FROM page_figures WHERE asset_id = ? AND page_no = ?', [
        asset.id,
        page.pageNo,
      ]);
      const same =
        prev &&
        prev.boxes === boxesJson &&
        Math.abs(Number(prev.width) - page.width) < 0.01 &&
        Math.abs(Number(prev.height) - page.height) < 0.01;
      if (same) continue;
      figuresRows += 1;
      if (dryRun) continue;
      run(
        `INSERT INTO page_figures(asset_id, page_no, boxes, width, height, version, updated_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(asset_id, page_no) DO UPDATE SET
           boxes = excluded.boxes, width = excluded.width, height = excluded.height,
           version = excluded.version, updated_at = excluded.updated_at`,
        [asset.id, page.pageNo, boxesJson, round2(page.width), round2(page.height), FIGURE_VERSION, now],
      );
    }

    if (!dryRun && syncFlags && flagsChanged) {
      // is_label 变了就必须重建该资产的原 FTS 索引（标注段本就不进索引）
      const fresh = all(
        'SELECT id, text, is_math, is_label FROM segments WHERE asset_id = ? AND is_math = 0 AND is_label = 0',
        [asset.id],
      );
      deleteIndexForAsset(asset.id);
      indexSegments(asset.id, fresh.map((s) => ({ id: s.id, text: s.text })));
    }

    totals.assets += 1;
    totals.dupBefore += dupBefore;
    totals.dupAfter += dupAfter;
    totals.rowsChanged += changed;
    totals.captions += captions;
    totals.labels += labels;
    totals.pages += raw.pages.length;
    totals.pagesWithFigures += pagesWithFigures;
    totals.boxes += boxesTotal;
    totals.anchors += anchor.added;
    totals.figuresRows += figuresRows;

    if (verbose) {
      console.log(
        [
          `asset ${asset.id}: ${raw.pages.length} 页 / ${parsed.length} 段`,
          `重复 bbox ${dupBefore} → ${dupAfter}`,
          `更新 ${changed} 段${dryRun ? '（dry-run 不写）' : ''}`,
          `caption ${captions} / figure-label ${labels}`,
          `图区 ${boxesTotal} 框（${pagesWithFigures} 页非空，图注补 ${anchor.added}）`,
          `page_figures 写入 ${figuresRows} 行`,
          `${Date.now() - t0}ms`,
        ].join(' | '),
      );
    }
  }
  return totals;
}

// ── CLI 入口（被 import 时不执行）────────────────────────────────────────
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const ids = argv
    .filter((a) => !a.startsWith('--'))
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const dryRun = flags.has('--dry-run');
  const keepRoles = flags.has('--keep-roles');
  const syncFlags = flags.has('--sync-flags');

  const cfg = loadConfig();
  ensureDirs();
  initLogger({ logDir: paths.logDir, logLevel: cfg.server.logLevel });
  openDb(cfg.server.dbPath);
  applyDbSettings(all);
  const mig = migrate();
  console.log(`DB 版本：v${mig.from} → v${mig.to}${mig.steps.length ? ` (${mig.steps.join('; ')})` : ''}`);

  const totals = await recomputeLayout({ assetIds: ids, dryRun, keepRoles, syncFlags });
  console.log(
    `\n合计：${totals.assets} 个资产 / ${totals.pages} 页；重复 bbox ${totals.dupBefore} → ${totals.dupAfter}；` +
      `更新 ${totals.rowsChanged} 段；caption ${totals.captions}、figure-label ${totals.labels}；` +
      `图区 ${totals.boxes} 个框（${totals.pagesWithFigures} 页有图），其中 ${totals.anchors} 个由图注反推`,
  );
  if (dryRun) console.log('（--dry-run：未写入任何数据）');
  if (totals.failed) console.log(`失败 ${totals.failed} 个资产（见上方错误）`);
  closeDb();
}

// ── helpers ──────────────────────────────────────────────────────────────

function parseBBox(raw) {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    return Array.isArray(b) && b.length === 4 ? b.map(Number) : null;
  } catch {
    return null;
  }
}

function countDupGroups(list) {
  const seen = new Map();
  for (const r of list) {
    if (!r.bbox) continue;
    const k = r.bbox.join(',');
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).length;
}

/**
 * 同 bbox 分组 → 按字符数比例重切 y 跨度（**与 buildPages.splitBlockBBox 同一规则**）：
 * 组内按 ord 排序（=阅读顺序，第一段在块顶部），把 [y0,y1] 按各段字符数占比自上而下切开，
 * 最后一段吃掉累积误差。这样每段拿到的是「自己那几行」的行带，而不是整块的包围盒。
 * @param {Array<{bbox:number[]|null, char_len:number, text:string, ord:number}>} list
 * @returns {number} 被重切的段数
 */
function resliceDuplicateGroups(list) {
  const groups = new Map();
  for (const r of list) {
    if (!r.bbox) continue;
    const k = r.bbox.join(',');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let fixed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.ord - b.ord);
    const [x0, bottom, x1, top] = group[0].bbox;
    const span = top - bottom;
    const total = group.reduce((s, r) => s + Math.max(1, Number(r.char_len) || String(r.text || '').length || 1), 0);
    let cursor = top;
    for (let i = 0; i < group.length; i += 1) {
      const chars = Math.max(1, Number(group[i].char_len) || String(group[i].text || '').length || 1);
      const h = i === group.length - 1 ? cursor - bottom : (span * chars) / total;
      const y1 = cursor;
      const y0 = Math.max(bottom, cursor - h);
      group[i].bbox = [round2(x0), round2(y0), round2(x1), round2(y1)];
      cursor = y0;
      fixed += 1;
    }
  }
  return fixed;
}

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}
