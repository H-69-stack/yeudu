#!/usr/bin/env node
/**
 * 译文体检（只读，绝不写库、绝不重翻）
 *
 * 用途：给用户一个可复现的「哪些文献的译文是垃圾、哪些段根本没译文、重翻是否划算」清单。
 * 复用 `server/services/translate/quality.js` 的判定逻辑——线上 pipeline 落库前的体检与这里
 * **同一套阈值**，所以「本脚本报出来的，就是 pipeline 会拒绝落库的」。
 *
 * 判定口径（阈值见 QUALITY）：
 *  - dst 为空            EMPTY
 *  - CJK 占比 < 15%      LOW_CJK（中文目标下整段没译出来）
 *  - 无空格拉丁大写串    LATIN_GARBAGE（`EVRNKSHUHO HGUVVJGF` 这类乱码）
 *  - 长英文原样返回      UNTRANSLATED
 * 另给出两类「版本口径」信息，用来回答「这批译文还能不能直接用」：
 *  - prompt_fp 与当前模板指纹不同  → 提示词已升级，缓存不会命中，只有重翻才会更新
 *  - extract_version 与资产当前版本不同 → 原文重抽过，译文位置未必还对得上
 * 最后按「当前送翻白名单」统计覆盖：可译段总数 / 没有任何译文 / 有译文但指纹过期 / 已是最新。
 *
 * 用法：
 *   node server/cli/lint-translations.js             # 人读表格
 *   node server/cli/lint-translations.js --json      # 机器读
 *   node server/cli/lint-translations.js --db D:\path\app.db
 *   node server/cli/lint-translations.js --limit 20  # 命中明细条数（默认 10）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEVER_TRANSLATE_ROLES, QUALITY, screenTranslation, translatableSql } from '../services/translate/quality.js';
import { promptFingerprint, resolveTemplate } from '../services/translate/prompts.js';

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = path.resolve(CLI_DIR, '..', '..');
const DEFAULT_DB = path.join(CODE_ROOT, 'data', 'app.db');

function parseArgs(argv) {
  const opt = { json: false, db: null, limit: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opt.json = true;
    else if (a === '--db') opt.db = argv[++i] || null;
    else if (a === '--limit') opt.limit = Math.max(1, Number(argv[++i]) || 10);
    else if (a === '--help' || a === '-h') opt.help = true;
  }
  return opt;
}

/** 数据库路径：--db 优先；否则按服务端同一份配置解析（与 CWD 无关） */
async function bootConfig(opt) {
  let mod = null;
  try {
    mod = await import('../config.js');
    mod.loadConfig(); // 读 config.local.json + data/secret.json（只读，不改文件）
    if (opt.db) return { dbPath: path.resolve(opt.db), mod };
    const p = mod.config?.server?.dbPath;
    return { dbPath: p ? path.resolve(CODE_ROOT, p) : DEFAULT_DB, mod };
  } catch {
    /* 配置读不到就退回默认值：体检脚本不该因为密钥/配置缺失而不可用 */
    return { dbPath: opt.db ? path.resolve(opt.db) : DEFAULT_DB, mod };
  }
}

/**
 * 当前 prompt 指纹：必须与服务端同口径 —— 先 loadConfig，再 applyDbSettings（settings 表可覆盖
 * translate.prompt / engine / tgtLang），否则算出来的 fp 与 routes/segments.js 回查用的不一致，
 * stale 判定会全错。两个调用都只读。
 */
function currentFingerprint(cfgMod) {
  if (!cfgMod) return { fp: null, tgtLang: 'zh-CN' };
  try {
    return {
      fp: promptFingerprint(resolveTemplate(cfgMod.config)),
      tgtLang: cfgMod.config?.translate?.tgtLang || 'zh-CN',
    };
  } catch {
    return { fp: null, tgtLang: 'zh-CN' };
  }
}

const clip = (s, n = 60) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.log(src.slice(0, src.indexOf('*/') + 2).replace(/^#![^\n]*\n/, ''));
    return;
  }
  const { dbPath, mod: cfgMod } = await bootConfig(opt);
  if (!fs.existsSync(dbPath)) {
    console.error(`找不到数据库：${dbPath}`);
    process.exitCode = 1;
    return;
  }
  const { DatabaseSync } = await import('node:sqlite');

  // 只读打开：任何写入都会直接抛错，脚本不存在「手滑改库」的可能性
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // settings 表可覆盖 translate.prompt / engine / tgtLang —— 与服务端同口径必须应用它（只读）
  try {
    cfgMod?.applyDbSettings((sql) => db.prepare(sql).all());
  } catch (e) {
    console.error(`（settings 覆盖应用失败，按 config.local.json 口径统计：${e && e.message}）`);
  }
  const { fp: currentFp, tgtLang: cfgTgt } = currentFingerprint(cfgMod);

  const rows = db
    .prepare(
      `SELECT t.cache_key, t.asset_id, t.page_no, t.ord, t.src_text, t.dst_text, t.engine, t.model,
              t.tgt_lang, t.prompt_fp, t.extract_version, t.segment_id,
              s.id AS cur_seg_id, s.role AS role, a.extract_version AS asset_extract_version,
              w.no AS work_no, w.title AS work_title
         FROM translations t
         LEFT JOIN assets a ON a.id = t.asset_id
         LEFT JOIN works w ON w.id = a.work_id
         LEFT JOIN segments s ON s.asset_id = t.asset_id AND s.page_no = t.page_no AND s.ord = t.ord
        ORDER BY w.no, t.asset_id, t.page_no, t.ord`,
    )
    .all();

  // 覆盖统计：只看「当前白名单允许送翻」的段，逐段判断有没有译文
  const coverage = { segs: 0, missingAny: 0, missingCurrent: 0, byRole: [] };
  try {
    const cov = db
      .prepare(
        `SELECT coalesce(nullif(s.role,''),'body') AS role,
                count(*) AS segs,
                sum(CASE WHEN NOT EXISTS (
                      SELECT 1 FROM translations t
                       WHERE t.asset_id = s.asset_id AND t.page_no = s.page_no AND t.ord = s.ord
                    ) THEN 1 ELSE 0 END) AS missing_any,
                sum(CASE WHEN NOT EXISTS (
                      SELECT 1 FROM translations t
                       WHERE t.asset_id = s.asset_id AND t.page_no = s.page_no AND t.ord = s.ord
                         AND t.prompt_fp = ? AND t.tgt_lang = ?
                    ) THEN 1 ELSE 0 END) AS missing_current
           FROM segments s
          WHERE ${translatableSql()}
          GROUP BY 1
          ORDER BY 2 DESC`,
      )
      .all(currentFp ?? '', cfgTgt);
    coverage.byRole = cov.map((r) => ({ role: r.role, segs: Number(r.segs), missingAny: Number(r.missing_any), missingCurrent: Number(r.missing_current) }));
    for (const r of coverage.byRole) {
      coverage.segs += r.segs;
      coverage.missingAny += r.missingAny;
      coverage.missingCurrent += r.missingCurrent;
    }
  } catch (e) {
    coverage.error = String(e && e.message ? e.message : e);
  }
  db.close();

  const totals = {
    total: rows.length,
    empty: 0,
    lowCjk: 0,
    latinGarbage: 0,
    untranslated: 0,
    anyBad: 0,
    stalePrompt: 0,
    staleExtract: 0,
    staleAny: 0,
    noLongerTranslatable: 0,
    located: 0,
    unlocated: 0,
  };
  const byWork = new Map();
  const badRows = [];

  for (const r of rows) {
    const verdict = screenTranslation({ src: r.src_text, dst: r.dst_text, tgtLang: r.tgt_lang || cfgTgt });
    const { codes } = verdict;
    const bad = !verdict.ok;
    const role = String(r.role || '');
    const unsent = NEVER_TRANSLATE_ROLES.includes(role);

    if (codes.includes('EMPTY')) totals.empty += 1;
    if (codes.includes('LOW_CJK')) totals.lowCjk += 1;
    if (codes.includes('LATIN_GARBAGE')) totals.latinGarbage += 1;
    if (codes.includes('UNTRANSLATED')) totals.untranslated += 1;
    if (bad) totals.anyBad += 1;
    if (unsent) totals.noLongerTranslatable += 1;
    if (r.cur_seg_id == null) totals.unlocated += 1;
    else totals.located += 1;

    const stalePrompt = currentFp != null && String(r.prompt_fp || '') !== currentFp;
    const staleExtract = r.asset_extract_version != null && Number(r.extract_version) !== Number(r.asset_extract_version);
    if (stalePrompt) totals.stalePrompt += 1;
    if (staleExtract) totals.staleExtract += 1;
    if (stalePrompt || staleExtract) totals.staleAny += 1;

    const key = r.work_no || `asset#${r.asset_id}`;
    let w = byWork.get(key);
    if (!w) {
      w = { workNo: key, title: r.work_title || '', assets: new Set(), total: 0, bad: 0, empty: 0, lowCjk: 0, latinGarbage: 0, untranslated: 0, stale: 0 };
      byWork.set(key, w);
    }
    w.assets.add(r.asset_id);
    w.total += 1;
    if (bad) w.bad += 1;
    if (codes.includes('EMPTY')) w.empty += 1;
    if (codes.includes('LOW_CJK')) w.lowCjk += 1;
    if (codes.includes('LATIN_GARBAGE')) w.latinGarbage += 1;
    if (codes.includes('UNTRANSLATED')) w.untranslated += 1;
    if (stalePrompt || staleExtract) w.stale += 1;

    if (bad) {
      badRows.push({
        workNo: key,
        workTitle: r.work_title || '',
        assetId: r.asset_id,
        pageNo: r.page_no,
        ord: r.ord,
        segmentId: r.segment_id, // 记录里的 segment_id（可能指向已被重抽掉的旧段）
        currentSegmentId: r.cur_seg_id, // 按 (asset, page, ord) 对上的当前段 id，重翻时用它定位
        role,
        noLongerTranslatable: unsent,
        codes,
        cjkRatio: verdict.metrics.cjkRatio,
        latinRuns: verdict.metrics.latinRuns,
        engine: r.engine,
        model: r.model,
        src: clip(r.src_text),
        dst: clip(r.dst_text),
        variants: 1,
      });
    }
  }

  /** 同一条译文会在库里留下多个 cache_key 变体；明细里按位置去重，并优先展示「还需要重翻」的段 */
  const score = (h) =>
    (h.noLongerTranslatable ? 0 : 100) +
    (h.codes.includes('LATIN_GARBAGE') ? 50 : 0) +
    (h.codes.includes('LOW_CJK') ? 20 : 0) +
    (h.codes.includes('UNTRANSLATED') ? 10 : 0) +
    (h.codes.includes('EMPTY') ? 30 : 0);
  const seenPos = new Map();
  const ranked = [];
  for (const h of [...badRows].sort((a, b) => score(b) - score(a))) {
    const pos = `${h.assetId}:${h.pageNo}:${h.ord}`;
    const prev = seenPos.get(pos);
    if (prev) {
      prev.variants += 1;
      continue;
    }
    seenPos.set(pos, h);
    ranked.push(h);
    if (ranked.length >= opt.limit) break;
  }

  const works = [...byWork.values()].map((w) => ({ ...w, assets: [...w.assets] })).sort((a, b) => b.bad - a.bad || b.total - a.total);

  if (opt.json) {
    console.log(JSON.stringify({ dbPath, currentFp, thresholds: QUALITY, totals, coverage, works, hits: ranked }, null, 2));
    return;
  }

  const line = (k, v) => console.log(`  ${k.padEnd(26, ' ')} ${v}`);
  console.log('译文体检（只读；不写库、不重翻）');
  console.log(`  库${' '.repeat(24)} ${dbPath}`);
  console.log(`  当前 prompt_fp${' '.repeat(14)} ${currentFp ?? '(读不到配置，跳过 stale 判定)'}`);
  console.log(`  阈值 minCjkRatio=${QUALITY.minCjkRatio} garbageRuns≥${QUALITY.garbageRunMin} garbageCjk<${QUALITY.garbageCjkCeiling} echo≥${QUALITY.echoMinLatinLetters}`);
  console.log('');
  console.log('一、总账（translations 表，一条 cache_key 算一条）');
  line('译文总条数', totals.total);
  line('dst 为空', `${totals.empty}（pipeline 只在体检通过后落库，所以结构上恒为 0）`);
  line('CJK 占比过低', totals.lowCjk);
  line('拉丁大写垃圾串', totals.latinGarbage);
  line('整段英文未译', totals.untranslated);
  line('任一问题（需重翻）', totals.anyBad);
  line('prompt 指纹已过期', totals.stalePrompt);
  line('extract_version 过期', totals.staleExtract);
  line('“白名单角色”的历史行', `${totals.noLongerTranslatable}（figure-label/header/… 已不送翻，阅读器也不再展示其译文）`);
  line('能按位置对上当前段', `${totals.located} / ${totals.total}（对不上的说明原文已重抽，译文必然错位）`);
  console.log('');
  console.log('二、按文献');
  if (!works.length) console.log('  （库里没有译文）');
  else {
    console.log(`  ${'work'.padEnd(8)} ${'问题/总'.padEnd(12)} ${'低CJK'.padEnd(7)} ${'垃圾串'.padEnd(7)} ${'过期'.padEnd(7)} 标题`);
    for (const w of works.slice(0, 20)) {
      console.log(
        `  ${String(w.workNo).padEnd(8)} ${`${w.bad}/${w.total}`.padEnd(12)} ${String(w.lowCjk).padEnd(7)} ${String(w.latinGarbage).padEnd(7)} ${String(w.stale).padEnd(7)} ${clip(w.title, 48)}`,
      );
    }
    if (works.length > 20) console.log(`  … 其余 ${works.length - 20} 篇省略`);
  }
  console.log('');
  console.log('三、覆盖（按当前送翻白名单统计 segments，回答「阅读器还会显示 null 吗」）');
  if (coverage.error) line('统计失败', coverage.error);
  else {
    line('可译段总数', coverage.segs);
    line('无任何译文行', coverage.missingAny);
    line('有译文但指纹过期', `${coverage.missingCurrent - coverage.missingAny} ← 提示词升级/版本变化导致，重翻才会更新`);
    line('已是当前版本译文', coverage.segs - coverage.missingCurrent);
    for (const r of coverage.byRole.slice(0, 10)) {
      line(`  ${r.role}`, `${r.segs} 段，无译文 ${r.missingAny}，过期 ${r.missingCurrent - r.missingAny}`);
    }
  }
  console.log('');
  console.log(`四、命中明细（前 ${ranked.length} 条，已按位置去重、需重翻的排在前面）`);
  for (const h of ranked) {
    const tag = h.noLongerTranslatable ? ' [白名单角色，不必重翻]' : '';
    const dup = h.variants > 1 ? `（同位置另有 ${h.variants - 1} 个变体）` : '';
    console.log(
      `  work ${h.workNo} p.${h.pageNo} ord ${h.ord}｜${h.codes.join(',')}｜cjk=${pct(h.cjkRatio)} runs=${h.latinRuns}｜${h.engine}/${h.model}${tag}${dup}`,
    );
    console.log(`    segment_id=${h.segmentId}（当前段 ${h.currentSegmentId}）role=${h.role} ${clip(h.workTitle, 40)}`);
    console.log(`    src: ${h.src}`);
    console.log(`    dst: ${h.dst}`);
  }
  console.log('');
  console.log('说明：本脚本只读。重翻某一篇请用 POST /api/works/:no/translate（scope=all 或 scope=pages），');
  console.log('      提示词升级后 prompt_fp 已变，旧译文不会命中，会自然重译；不需要删库。');
}

await main();
