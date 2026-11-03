/**
 * FTS5 索引与检索（§10.3 / D10 / D22）。
 *
 * 两张索引，都用 `rowid = segments.id`，都共用同一个 `toFtsText`：
 *  - `segments_fts`     ：原文（英文）侧
 *  - `translations_fts` ：译文（中文）侧 —— 支撑「中文问英文文献」
 *
 * 三条硬约束（评审补充）：
 *  ① 译文索引只放**当前生效译文**（engine = translate.engine，tgt_lang = translate.tgtLang），
 *    一个段落只有一行；换引擎/重译是「重建该段行」，不堆积、不会搜到旧译文。
 *  ② 入库与建索引必须同一个事务（见 pipeline.js），不允许「先落库后异步建索引」。
 *  ③ 两侧都 0 命中时由 chat 层落 `retrieval_miss` 标记，不靠提示词自觉。
 *
 * 关键：`unicode61` 不切中文，所以入库与查询都必须先过 `toFtsText`——
 * 把 CJK 连续串展开成 2-gram（"工作流" → "工作 作流"），英文按词保留。
 */
import { all, get, run } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('fts');

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_RE = /[\p{L}\p{N}_]/u;
const HAN_RE = /[\u4e00-\u9fff]/;

/** 当前生效的翻译引擎与目标语言（决定译文索引收录哪一份） */
export function activeTranslationTarget() {
  return {
    engine: String((config.translate && config.translate.engine) || ''),
    tgtLang: String((config.translate && config.translate.tgtLang) || 'zh-CN'),
  };
}

/**
 * CJK 2-gram 展开（入库与查询共用，全文只此一处实现）。
 * @param {string} text
 * @returns {string} "工作流 abc" → "工作 作流 abc"
 */
export function toFtsText(text) {
  const s = String(text || '').normalize('NFKC');
  const out = [];
  let cjk = '';
  let word = '';
  const flushCjk = () => {
    if (!cjk) return;
    if (cjk.length === 1) out.push(cjk);
    else for (let i = 0; i < cjk.length - 1; i += 1) out.push(cjk.slice(i, i + 2));
    cjk = '';
  };
  const flushWord = () => {
    if (word) out.push(word.toLowerCase());
    word = '';
  };
  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      flushWord();
      cjk += ch;
    } else if (WORD_RE.test(ch)) {
      flushCjk();
      word += ch;
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return out.join(' ');
}

// ── 原文侧索引 ───────────────────────────────────────────────────────────────

/** 清掉某资产的原文索引（重抽前必调） */
export function deleteIndexForAsset(assetId) {
  run('DELETE FROM segments_fts WHERE rowid IN (SELECT id FROM segments WHERE asset_id = ?)', [Number(assetId)]);
}

/**
 * 建原文索引：rowid = segments.id。
 * @param {number} assetId
 * @param {Array<{id:number, text:string}>} segs
 */
export function indexSegments(assetId, segs) {
  deleteIndexForAsset(assetId);
  for (const s of segs) {
    if (!s || !s.id) continue;
    const idx = toFtsText(s.text);
    if (!idx) continue;
    run('INSERT INTO segments_fts(rowid, text_index) VALUES(?, ?)', [s.id, idx]);
  }
}

// ── 译文侧索引（rowid = segments.id） ────────────────────────────────────────

/**
 * 重建某段的译文索引行（先删后插，永远只有一行）。
 * @param {number} segmentId 段落 id（= rowid）
 * @param {{engine?:string, tgtLang?:string, text:string}} p
 */
export function indexTranslation(segmentId, p) {
  const id = Number(segmentId);
  if (!Number.isInteger(id) || id <= 0) return;
  run('DELETE FROM translations_fts WHERE rowid = ?', [id]);
  const idx = toFtsText(p.text);
  if (!idx) return;
  run('INSERT INTO translations_fts(rowid, engine, tgt_lang, text) VALUES(?,?,?,?)', [
    id,
    String(p.engine || ''),
    String(p.tgtLang || ''),
    idx,
  ]);
}

/** 重抽前清掉该资产的译文索引（段 id 会变，留着就是死链） */
export function deleteTranslationIndexForAsset(assetId) {
  run('DELETE FROM translations_fts WHERE rowid IN (SELECT id FROM segments WHERE asset_id = ?)', [Number(assetId)]);
}

/** 索引行数（迁移断言与自测用） */
export function translationIndexCount() {
  return get('SELECT count(*) AS n FROM translations_fts').n;
}

/**
 * 从 `translations` 重建译文索引（运维/迁移用）。
 * 只取 segment_id 非空、且 engine/tgt_lang 属于当前生效目标的行 —— 一个段落一行。
 * @param {{assetId?:number|null, engine?:string, tgtLang?:string}} [opts]
 * @returns {{indexed:number, expected:number, skipped:number}}
 */
export function backfillTranslationIndex(rawOpts) {
  const opts = rawOpts || {}; // 兼容 CLI 传 null（默认参数只吃 undefined，不吃 null）
  const active = activeTranslationTarget();
  const engine = opts.engine || active.engine;
  const tgtLang = opts.tgtLang || active.tgtLang;
  const params = [engine, tgtLang];
  let where = 't.segment_id IS NOT NULL AND t.engine = ? AND t.tgt_lang = ?';
  if (opts.assetId) {
    where += ' AND t.asset_id = ?';
    params.push(Number(opts.assetId));
  }
  const rows = all(
    `SELECT t.segment_id, t.dst_text, t.engine, t.tgt_lang, t.asset_id, t.src_text, t.extract_version
       FROM translations t
      WHERE ${where}
      ORDER BY t.segment_id`,
    params,
  );
  let indexed = 0;
  let skipped = 0;
  for (const r of rows) {
    const seg = get('SELECT id FROM segments WHERE id = ?', [r.segment_id]);
    if (!seg) {
      skipped += 1; // 段已被删除：不塞索引，避免指向不存在的段
      continue;
    }
    indexTranslation(r.segment_id, { engine: r.engine, tgtLang: r.tgt_lang, text: r.dst_text });
    indexed += 1;
    // 内容寻址：同一段文本可能被多个段共用（translations 只有一行），
    // 但索引是「按段」的 —— 必须把同资产内文本相同的其它段也补上，否则会出现「译了却搜不到」的段。
    const twins = all(
      `SELECT s.id FROM segments s JOIN assets a ON a.id = s.asset_id
        WHERE s.asset_id = ? AND s.text = ? AND s.id <> ? AND a.extract_version = ?`,
      [r.asset_id, r.src_text, r.segment_id, r.extract_version],
    );
    for (const t of twins) {
      indexTranslation(t.id, { engine: r.engine, tgtLang: r.tgt_lang, text: r.dst_text });
      indexed += 1;
    }
  }
  const expected = expectedTranslationIndexCount(engine, tgtLang, opts.assetId || null);
  log.info('fts.backfill_translations', { engine, tgtLang, scanned: rows.length, indexed, expected, skipped });
  return { indexed, expected, skipped };
}

/**
 * 「应索引段数」：当前引擎/语言下，**有可用译文**的段落数。
 * 注意与 `translations` 行数不同：内容寻址会把同文本的多段合并成一行，
 * 所以行数 ≤ 段数。断言必须比段数，不能比行数（否则重复段落会被误判为漏索引）。
 * @param {string} engine
 * @param {string} tgtLang
 * @param {number|null} [assetId]
 */
export function expectedTranslationIndexCount(engine, tgtLang, assetId = null) {
  const params = [engine, tgtLang];
  let extra = '';
  if (assetId) {
    extra = ' AND s.asset_id = ?';
    params.push(Number(assetId));
  }
  return get(
    `SELECT count(*) AS n
       FROM segments s
       JOIN assets a ON a.id = s.asset_id
       JOIN translations t
         ON t.asset_id = s.asset_id AND t.src_text = s.text AND t.engine = ? AND t.tgt_lang = ?
        AND t.segment_id IS NOT NULL
      WHERE a.extract_version = s.extract_version AND s.is_math = 0 AND s.is_label = 0${extra}`,
    params,
  ).n;
}

// ── 检索 ─────────────────────────────────────────────────────────────────────

/**
 * 双索引检索：原文 + 译文，按 segmentId 合并去重。
 * 永不抛（语法错误降级 LIKE，并把降级事实回调给调用方）。
 * @param {number} assetId
 * @param {string} query
 * @param {{topK?:number, side?:'src'|'dst'|'both', onDegrade?:(reason:string)=>void}} [opts]
 * @returns {Array<{segmentId:number,pageNo:number,ord:number,score:number,text:string,textDst:string|null,hitLang:'src'|'dst'}>}
 */
export function searchSegments(assetId, query, opts = {}) {
  const topK = opts.topK || 24;
  const tokens = toFtsText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const matchExpr = buildMatchExpr(tokens);
  const only = opts.side === 'src' || opts.side === 'dst' ? opts.side : 'both';

  let src = [];
  let dst = [];
  try {
    if (only !== 'dst') src = searchSource(assetId, matchExpr, topK);
    if (only !== 'src') dst = searchTranslation(assetId, matchExpr, topK);
  } catch (e) {
    const reason = `FTS 查询失败（${e.message}），已降级 LIKE`;
    log.warn('search.degraded', { assetId, query, reason });
    if (opts.onDegrade) opts.onDegrade(reason);
    return likeFallback(assetId, tokens, topK);
  }
  return mergeHits(src, dst, topK);
}

/** 词 → FTS5 MATCH 表达式（拉丁词加前缀通配，CJK bigram 精确） */
export function buildMatchExpr(tokens) {
  return tokens
    .map((t) => {
      const isLatin = /^[a-z0-9_]+$/i.test(t);
      return isLatin ? `"${t.replace(/"/g, '""')}"*` : `"${t.replace(/"/g, '""')}"`;
    })
    .join(' OR ');
}

function searchSource(assetId, matchExpr, topK) {
  const rows = all(
    `SELECT s.id AS segmentId, s.page_no AS pageNo, s.ord AS ord, s.text AS text,
            bm25(segments_fts) AS score
       FROM segments_fts
       JOIN segments s ON s.id = segments_fts.rowid
      WHERE segments_fts MATCH ? AND s.asset_id = ? AND s.is_math = 0 AND s.is_label = 0
      ORDER BY score ASC, s.page_no ASC, s.ord ASC
      LIMIT ?`,
    [matchExpr, Number(assetId), topK],
  );
  return rows.map((r) => ({ ...r, score: Number(r.score), hitLang: 'src', textDst: null }));
}

function searchTranslation(assetId, matchExpr, topK) {
  const rows = all(
    `SELECT f.rowid AS segmentId, s.page_no AS pageNo, s.ord AS ord, s.text AS text,
            f.engine AS engine, f.tgt_lang AS tgtLang, bm25(translations_fts) AS score
       FROM translations_fts f
       JOIN segments s ON s.id = f.rowid
      WHERE translations_fts MATCH ? AND s.asset_id = ? AND s.is_math = 0 AND s.is_label = 0
      ORDER BY score ASC, s.page_no ASC, s.ord ASC
      LIMIT ?`,
    [matchExpr, Number(assetId), topK],
  );
  return rows.map((r) => {
    const tr = get(
      'SELECT dst_text FROM translations WHERE segment_id = ? AND engine = ? AND tgt_lang = ? LIMIT 1',
      [r.segmentId, r.engine, r.tgtLang],
    );
    return {
      segmentId: Number(r.segmentId),
      pageNo: r.pageNo,
      ord: r.ord,
      text: r.text,
      score: Number(r.score),
      hitLang: 'dst',
      textDst: tr ? tr.dst_text : null,
    };
  });
}

/**
 * 双索引合并：按 segmentId 去重；两侧都命中保留 bm25 更优（更小）的一侧。
 * bm25 在 SQLite 里「越小越相关」。
 */
export function mergeHits(srcHits, dstHits, topK) {
  const byId = new Map();
  for (const h of srcHits) byId.set(h.segmentId, { ...h });
  for (const h of dstHits) {
    const cur = byId.get(h.segmentId);
    if (!cur) {
      byId.set(h.segmentId, { ...h });
      continue;
    }
    if (h.score <= cur.score) byId.set(h.segmentId, { ...h, text: cur.text || h.text });
    else byId.set(h.segmentId, { ...cur, textDst: h.textDst ?? cur.textDst });
  }
  return [...byId.values()]
    .sort((a, b) => a.score - b.score || a.pageNo - b.pageNo || a.ord - b.ord)
    .slice(0, topK);
}

/**
 * 全库检索（跨文献）：把 FTS 命中的段落按文献归并，附文献元数据与命中的锚点段落。
 * 与 `searchSegments` 的唯一区别是**不按 asset_id 过滤** —— 这是「跨全库找文献」的入口。
 * 永不抛：FTS 语法错误降级 LIKE（与单篇检索同策略）。
 *
 * @param {string} query
 * @param {{topK?:number, perWork?:number, worksLimit?:number}} [opts]
 * @returns {Array<{work:Object, bestScore:number, hits:Array<{segmentId:number,pageNo:number,ord:number,text:string,isHeading:boolean}>}>}
 */
export function searchWorksAcross(query, opts = {}) {
  const topK = Math.max(1, Math.min(Number(opts.topK) || 240, 600));
  const perWork = Math.max(1, Math.min(Number(opts.perWork) || 3, 6));
  const worksLimit = Math.max(1, Math.min(Number(opts.worksLimit) || 12, 30));
  const tokens = toFtsText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const matchExpr = buildMatchExpr(tokens);

  let rows = [];
  try {
    rows = all(
      `SELECT s.id AS segmentId, s.page_no AS pageNo, s.ord AS ord, s.text AS text,
              s.is_heading AS isHeading, a.work_id AS workId, bm25(segments_fts) AS score
         FROM segments_fts
         JOIN segments s ON s.id = segments_fts.rowid
         JOIN assets a ON a.id = s.asset_id
        WHERE segments_fts MATCH ? AND s.is_math = 0 AND s.is_label = 0
        ORDER BY score ASC
        LIMIT ?`,
      [matchExpr, topK],
    );
  } catch (e) {
    log.warn('search.works_degraded', { reason: e.message });
    rows = all(
      `SELECT s.id AS segmentId, s.page_no AS pageNo, s.ord AS ord, s.text AS text,
              s.is_heading AS isHeading, a.work_id AS workId, 0 AS score
         FROM segments s
         JOIN assets a ON a.id = s.asset_id
        WHERE s.is_math = 0 AND s.is_label = 0 AND s.text LIKE ?
        ORDER BY s.page_no ASC
        LIMIT ?`,
      [`%${tokens[0]}%`, topK],
    );
  }

  /** workId → {bestScore, hits} */
  const byWork = new Map();
  for (const r of rows) {
    const id = Number(r.workId);
    if (!byWork.has(id)) byWork.set(id, { bestScore: Number(r.score), hits: [] });
    const g = byWork.get(id);
    if (g.hits.length < perWork) {
      g.hits.push({
        segmentId: Number(r.segmentId),
        pageNo: r.pageNo,
        ord: r.ord,
        text: r.text,
        isHeading: Boolean(r.isHeading),
      });
    }
    if (Number(r.score) < g.bestScore) g.bestScore = Number(r.score);
  }

  // 标题/作者/备注也能命中（正文没抽取的条目至少能被找到，避免「搜不到 = 不存在」的错觉）
  const likeQ = `%${String(query).trim()}%`;
  const titleHits = all(
    `SELECT id FROM works
      WHERE retired = 0 AND (title LIKE ? OR authors LIKE ? OR note LIKE ? OR no = ?)
      LIMIT ?`,
    [likeQ, likeQ, likeQ, String(query).trim(), worksLimit],
  );
  for (const t of titleHits) {
    const id = Number(t.id);
    if (!byWork.has(id)) byWork.set(id, { bestScore: Number.POSITIVE_INFINITY, hits: [] });
  }

  const ids = [...byWork.keys()];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const works = all(`SELECT * FROM works WHERE id IN (${placeholders})`, ids);
  const assets = all(
    `SELECT work_id, page_count, file_state, extract_status FROM assets WHERE kind = 'pdf' AND work_id IN (${placeholders})`,
    ids,
  );
  const assetByWork = new Map(assets.map((a) => [Number(a.work_id), a]));

  return works
    .map((w) => {
      const g = byWork.get(Number(w.id));
      const a = assetByWork.get(Number(w.id));
      return {
        work: {
          ...w,
          hasPdf: Boolean(a && a.file_state === 'present'),
          hasText: Boolean(a && a.extract_status === 'ready'),
          pageCount: a ? a.page_count : null,
        },
        bestScore: g.bestScore,
        hits: g.hits,
      };
    })
    .sort((x, y) => x.bestScore - y.bestScore || String(x.work.no).localeCompare(String(y.work.no)))
    .slice(0, worksLimit);
}

function likeFallback(assetId, tokens, topK) {
  const kw = tokens[0] || '';
  if (!kw) return [];
  const src = all(
    `SELECT id AS segmentId, page_no AS pageNo, ord AS ord, text AS text, 0 AS score
       FROM segments
      WHERE asset_id = ? AND is_math = 0 AND is_label = 0 AND text LIKE ?
      ORDER BY page_no ASC, ord ASC
      LIMIT ?`,
    [Number(assetId), `%${kw}%`, topK],
  ).map((r) => ({ ...r, degraded: true, hitLang: 'src', textDst: null }));
  const dst = all(
    `SELECT s.id AS segmentId, s.page_no AS pageNo, s.ord AS ord, s.text AS text,
            t.dst_text AS textDst, 0 AS score
       FROM translations t
       JOIN segments s ON s.id = t.segment_id
      WHERE t.asset_id = ? AND t.dst_text LIKE ?
      ORDER BY s.page_no ASC, s.ord ASC
      LIMIT ?`,
    [Number(assetId), `%${kw}%`, topK],
  ).map((r) => ({ ...r, degraded: true, hitLang: 'dst' }));
  return mergeHits(src, dst, topK);
}

/**
 * 抽样检查索引内容是否含汉字（迁移断言用）。
 * 注意：mock/真实引擎都会加 `[译]` 前缀，而「译」本身就是汉字 —— 必须先把这个孤立的
 * 前缀 token 去掉再判，否则英文索引也能"通过"汉字检查（假阳性）。
 */
export function sampleTranslationIndexHasHanzi(limit = 20, minRequired = 3) {
  const rows = all('SELECT text FROM translations_fts LIMIT ?', [Math.max(limit, minRequired)]);
  const stripPrefixToken = (t) => String(t || '').replace(/(^|\s)译(\s|$)/g, ' ');
  const withHanzi = rows.filter((r) => HAN_RE.test(stripPrefixToken(r.text))).length;
  return {
    sampled: rows.length,
    withHanzi,
    minRequired,
    // 抽样要求：至少 minRequired 条索引里含「译」以外的汉字（全英文索引会 0 条）
    ok: rows.length >= minRequired && withHanzi >= minRequired,
  };
}
