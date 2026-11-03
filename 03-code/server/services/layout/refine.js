/**
 * AI 精排（版面 agent）—— 移植自 Zotero 插件 zotero插件1/content/lib/layout.js
 *
 * 翻译完成后，把每页的「版面块 + 启发式判定」交给大模型复核，让它返回每个块的真实角色
 * 与层级（标题 / 正文 / 图注 / 公式 / 页眉页脚 / 引用 / 列表…），再写回库，供译文页按
 * 修正后的版面渲染。
 *
 * 之所以能提升排版质量：启发式（classifyRich）只能靠字号与位置猜，而模型能读懂
 * 「这段文字是什么」——例如把 "Authorized licensed use limited to…" 判成页脚而非正文。
 *
 * 与 Zotero 原版差异（仅实现层，逻辑等价）：
 *  - 用本工程的统一 LLM 出口 openaiChat（server/services/llm/client.js），不再自己 fetch；
 *  - 精排引擎独立配置（config.translate.refineEngine，默认 deepseek），可与翻译引擎不同供应商；
 *  - 入参是 DB 中的 segments（已带 role/tier/align/ratio/gap_pct），出参直接回写 segments。
 */
import { exec, all, get, tx } from '../../db.js';
import { config } from '../../config.js';
import { openaiChat, hasKey } from '../../services/llm/client.js';
import { resolveModel } from '../translate/engines/registry.js';
import { createLogger } from '../../logger.js';

const log = createLogger('layout.refine');

/** 允许的角色 → 渲染时映射到 CSS 类 ztl-role-* / dst-role-* */
const ROLES = [
  'title', 'author', 'abstract', 'section', 'body', 'caption', 'figure-label',
  'equation', 'footnote', 'reference', 'header', 'footer', 'page-number',
  'quote', 'list-item', 'unknown',
];
const TIERS = ['h1', 'h2', 'body', 'small'];
const ALIGNS = ['left', 'center'];

function batchItems() {
  const v = Number(config.translate && config.translate.batchItems) || 0;
  return v > 0 ? Math.min(v * 6, 80) : 40; // 精排批大小默认比翻译批大些（纯分类、无长输出）
}

/**
 * 精排提示词（英文：输入文本多是英文学术正文，模型对英文指令更稳定；
 * 与 Zotero 原版 INSTRUCTION 同构，并补充 quote / list-item 两类渲染所需的角色）。
 */
const INSTRUCTION = [
  'You are a layout normalizer for academic PDFs. You will receive a JSON array of text',
  'blocks extracted from one page, each with: id, text (may be truncated), ratio (font size',
  'relative to body text), cent (whether the line is horizontally centered), gapPct (blank',
  'space above the block, as a percentage of page height) and math (a heuristic flag).',
  '',
  'For EVERY id, decide its real role in the paper and the correct rendering tier/alignment.',
  'Allowed role values: ' + ROLES.join(', ') + '.',
  'Blocks carrying "figure": true are already known to be text drawn inside a figure — keep',
  'their role as figure-label and tier small.',
  'Allowed tier values: h1 (paper title), h2 (section heading), body (normal paragraph),',
  'small (footnote / caption / page number / list item).',
  'Allowed align values: left, center.',
  '',
  'Rules:',
  '- Do NOT translate, rewrite or summarize any text.',
  '- journal headers/footers, license notes, download stamps, page numbers -> header/footer/page-number, tier small',
  '- "Abstract"/"摘要" style lead-ins -> abstract, tier h2',
  '- author names and affiliations -> author, tier body, align center',
  '- figure/table captions ("Fig. 3.", "Table 2.") -> caption, tier small',
  '- text that lives INSIDE a figure or diagram (part names, axis labels, tick',
  '  numbers, symbol lists like "Coil", "0.5", "Fss,r", "Fem,l") -> figure-label,',
  '  tier small. NEVER use equation for these.',
  '- display formulas and their fragments -> equation (keep the given tier/align)',
  '- bibliography entries -> reference, tier small',
  '- an indented or numbered/lettered item that is part of a list -> list-item, tier small',
  '- a long quoted passage (block quote) -> quote, tier body, align left',
  '- everything else that is running text -> body, tier body, align left',
  '',
  'Reply with ONLY this JSON shape and nothing else:',
  '{"items":[{"id":1,"role":"body","tier":"body","align":"left"}]}',
  '',
  'Output the JSON immediately: no explanation, no markdown fences, no text before or after it,',
  'and every id from the input must appear exactly once (thinking models: skip the reasoning and',
  'answer with the JSON only).',
].join('\n');

/** 把一页的版面块压成发给模型的紧凑数组 */
function buildBlocksPayload(segments, pageIndex) {
  return segments.map((seg, i) => {
    let text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    const item = {
      id: i,
      text: text.length > 140 ? text.slice(0, 140) + '…' : text,
      ratio: typeof seg.ratio === 'number' ? seg.ratio : 1,
      cent: seg.align === 'center',
      gapPct: typeof seg.gapPct === 'number' ? seg.gapPct : 0,
    };
    if (seg.isMath) item.math = true;
    if (seg.isLabel) item.figure = true; // 抽取层已判为图内标注：让模型别改回 equation/caption
    if (pageIndex !== undefined && pageIndex !== null) item.page = pageIndex + 1;
    return item;
  });
}

function buildPrompt(blocks) {
  return INSTRUCTION + '\n\nInput blocks:\n' + JSON.stringify(blocks);
}

/** 从文本里挑出所有「配对的 {...}」候选（跳过字符串里的花括号） */
function jsonCandidates(body, limit) {
  const out = [];
  const max = limit || 40;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < body.length && out.length < max; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** 把模型给的条目数组规范化（丢弃非法 id / 把非法 role 归为 unknown） */
function normalizeItems(items, allowedIds) {
  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const id = parseInt(raw.id, 10);
    if (Number.isNaN(id) || (allowedIds && allowedIds.indexOf(id) < 0)) continue;
    out.push({
      id,
      role: ROLES.indexOf(raw.role) >= 0 ? raw.role : 'unknown',
      tier: TIERS.indexOf(raw.tier) >= 0 ? raw.tier : null,
      align: ALIGNS.indexOf(raw.align) >= 0 ? raw.align : null,
    });
  }
  return out;
}

/**
 * 容错解析：允许 ```json 包裹、允许直接返回数组、允许正文里夹着解释文字，
 * 也允许模型输出多个 JSON（逐个尝试，取第一个能用的）—— 推理模型经常这样。
 */
function parseReply(text, allowedIds) {
  let body = String(text == null ? '' : text).trim();
  body = body.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const candidates = [];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  const startArr = body.indexOf('[');
  const endArr = body.lastIndexOf(']');
  if (start >= 0 && end > start && (startArr < 0 || start < startArr)) {
    candidates.push(body.slice(start, end + 1));
  }
  if (startArr >= 0 && endArr > startArr) {
    candidates.push(body.slice(startArr, endArr + 1));
  }
  candidates.push(...jsonCandidates(body));
  const seen = new Set();
  for (const cand of candidates) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    let data = null;
    try {
      data = JSON.parse(cand);
    } catch {
      // 非 JSON，跳到下一个候选
      // eslint-disable-next-line no-continue
      continue;
    }
    const items = Array.isArray(data) ? data : data && data.items;
    if (!Array.isArray(items)) continue;
    const parsed = normalizeItems(items, allowedIds);
    if (parsed.length) return parsed;
  }
  return null;
}

/**
 * 把模型结果应用到版面块上（纯函数，就地修改 blocks；便于测试与回写）。
 * blocks 与 payload 同序：blocks[i] 的 id == i。
 * @returns {Number} 实际修改的块数
 */
function applyItems(blocks, items) {
  const map = new Map();
  items.forEach((it) => map.set(it.id, it));
  let changed = 0;
  blocks.forEach((block, i) => {
    const it = map.get(i);
    if (!it) return;
    if (block.isLabel) {
      // 图内标注由抽取层按上下文判定（模型看不到附图），不能被改回 equation/caption/body
      if (it.role === 'equation' || it.role === 'caption' || it.role === 'body') {
        it.role = 'figure-label';
        it.tier = 'small';
        it.align = 'left';
      }
    }
    if (block.role !== it.role) {
      block.role = it.role;
      changed += 1;
    }
    if (it.tier && block.tier !== it.tier) {
      block.tier = it.tier;
      block.ratio = it.tier === 'h1' ? 1.6 : it.tier === 'h2' ? 1.22 : it.tier === 'small' ? 0.85 : 1;
      changed += 1;
    }
    if (it.align && block.align !== it.align) {
      block.align = it.align;
      changed += 1;
    }
    if (it.role === 'equation' && !block.isMath) {
      block.isMath = true;
      changed += 1;
    }
  });
  return changed;
}

/**
 * 取精排通道：优先 translate.refineEngine（独立配置，可与翻译引擎不同供应商），
 * 未配置或该引擎没有密钥时回退到翻译引擎（保证精排永远可用）。
 */
function resolveLayoutChannel(opts = {}) {
  const translateEngine = config.translate.engine || 'deepseek';
  let engineId = opts.engine || config.translate.refineEngine || translateEngine;
  if (engineId !== translateEngine && !hasKey(engineId)) {
    log.warn('layout.refine.engine_fallback', { wanted: engineId, use: translateEngine, reason: 'refine engine has no apiKey' });
    engineId = translateEngine;
  }
  const model = opts.model || resolveModel(engineId);
  return { provider: engineId, model };
}

/**
 * 单页精排：按 batchItems 分批问模型并就地修改 segments。
 * @param {Array} segments 该页的段数组（同序，index 即 id）
 * @param {{provider:string, model:string, signal?:AbortSignal, batchItems?:number, onProgress?:(s:string)=>void, pageIndex?:number}} opts
 * @returns {Promise<{requested:number, applied:number, errors:string[]}>}
 */
async function refinePage(segments, opts) {
  const stats = { requested: 0, applied: 0, errors: [] };
  if (!segments.length) return stats;
  const size = opts.batchItems || batchItems();
  for (let start = 0; start < segments.length; start += size) {
    if (opts.signal && opts.signal.aborted) break;
    const slice = segments.slice(start, start + size);
    const payload = buildBlocksPayload(slice, opts.pageIndex);
    payload.forEach((item, i) => {
      item.id = start + i;
    }); // 重排 id 为全局页内序号
    const ids = payload.map((item) => item.id);
    stats.requested += slice.length;
    if (typeof opts.onProgress === 'function') {
      opts.onProgress(`AI 精排：第 ${(opts.pageIndex || 0) + 1} 页 ${start + slice.length}/${segments.length} 块`);
    }
    let reply = '';
    try {
      const out = await openaiChat({
        provider: opts.provider,
        model: opts.model,
        messages: [{ role: 'user', content: buildPrompt(payload) }],
        temperature: 0.2,
        maxTokens: Math.max(800, ids.length * 30),
        signal: opts.signal,
      });
      reply = out.text;
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      // 单批失败不该拖垮整篇：记下来继续下一批，最后在状态里汇报
      stats.errors.push(
        `第 ${(opts.pageIndex || 0) + 1} 页第 ${start}~${start + slice.length} 块：${e && e.message ? e.message : String(e)}`,
      );
      // eslint-disable-next-line no-continue
      continue;
    }
    const items = parseReply(reply, ids);
    if (!items) {
      stats.errors.push(`第 ${(opts.pageIndex || 0) + 1} 页第 ${start}~${start + slice.length} 块：模型未按要求返回 JSON`);
      // eslint-disable-next-line no-continue
      continue;
    }
    stats.applied += applyItems(segments, items);
  }
  return stats;
}

/**
 * 整篇精排：逐页调用 refinePage（就地修改传入的 segments），并把结果写回库。
 * @param {number} assetId
 * @param {{engine?:string, model?:string, signal?:AbortSignal, onProgress?:(s:string)=>void,
 *          maxPages?:number, batchItems?:number, dryRun?:boolean}} [opts]
 * @returns {Promise<{assetId:number, requested:number, applied:number, errors:string[], pages:number, changed:Array}>}
 */
async function refineWork(assetId, opts = {}) {
  const ch = resolveLayoutChannel(opts);
  if (!ch.model) {
    throw new Error(`AI 精排未配置模型（引擎 ${ch.provider} 无可用 model），请先在设置里配置精排引擎`);
  }
  const asset = get('SELECT id, extract_version FROM assets WHERE id = ?', [assetId]);
  if (!asset) throw new Error(`资产不存在：assetId=${assetId}`);

  // 按页取段（保持 page_no, ord 顺序），连同 id/role/tier/align/ratio/gap_pct/is_math/is_label
  const rows = all(
    `SELECT id, page_no, ord, text, is_math, is_label, is_heading, role, tier, align, ratio, gap_pct
       FROM segments WHERE asset_id = ? ORDER BY page_no ASC, ord ASC`,
    [assetId],
  );
  const byPage = new Map();
  for (const r of rows) {
    if (!byPage.has(r.page_no)) byPage.set(r.page_no, []);
    byPage.get(r.page_no).push({
      id: r.id,
      text: r.text,
      isMath: Boolean(r.is_math),
      isLabel: Boolean(r.is_label),
      role: r.role ?? 'body',
      tier: r.tier ?? null,
      align: r.align ?? 'left',
      ratio: r.ratio ?? null,
      gapPct: r.gap_pct ?? null,
    });
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const limit = opts.maxPages ? Math.min(opts.maxPages, pages.length) : pages.length;

  const out = { assetId, requested: 0, applied: 0, errors: [], pages: 0, changed: [] };
  const toPersist = [];
  for (let p = 0; p < limit; p += 1) {
    if (opts.signal && opts.signal.aborted) break;
    const pageNo = pages[p];
    const segs = byPage.get(pageNo);
    const stats = await refinePage(segs, {
      provider: ch.provider,
      model: ch.model,
      signal: opts.signal,
      batchItems: opts.batchItems,
      pageIndex: p,
      onProgress: opts.onProgress,
    });
    out.requested += stats.requested;
    out.applied += stats.applied;
    out.errors = out.errors.concat(stats.errors);
    out.pages += 1;
    if (!opts.dryRun) {
      for (const seg of segs) {
        toPersist.push([
          seg.role ?? null,
          seg.tier ?? null,
          seg.align ?? null,
          seg.ratio ?? null,
          seg.isMath ? 1 : 0,
          seg.id,
        ]);
        out.changed.push({ id: seg.id, pageNo, role: seg.role, tier: seg.tier, align: seg.align, ratio: seg.ratio });
      }
    }
  }

  if (!opts.dryRun && toPersist.length) {
    tx(() => {
      const stmt = 'UPDATE segments SET role=?, tier=?, align=?, ratio=?, is_math=? WHERE id=?';
      for (const row of toPersist) exec(stmt, row);
    });
    log.info('layout.refine.persisted', { assetId, rows: toPersist.length, applied: out.applied });
  }
  return out;
}

export {
  ROLES,
  TIERS,
  ALIGNS,
  INSTRUCTION,
  buildBlocksPayload,
  buildPrompt,
  parseReply,
  normalizeItems,
  applyItems,
  refinePage,
  refineWork,
  batchItems,
  resolveLayoutChannel,
};

export default { refineWork, refinePage, applyItems, parseReply, buildPrompt, ROLES, TIERS, ALIGNS };
