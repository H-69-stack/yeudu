/**
 * 工具共用的「按编号定位文献」逻辑（三个 lit 工具都要用）。
 * 与 dsh 侧 `ctx.library` 的定位规则一致：先按 works.no 找行，再取该条目的 pdf 资产。
 */
import { get } from '../../../db.js';

/**
 * @param {string} no 文献编号，例如 "4.6"
 * @returns {{work:Object, asset:Object}}
 */
export function resolveWork(no) {
  const key = String(no == null ? '' : no).trim();
  if (!key) throw new Error('缺少文献编号 no（例如 "4.6"）');
  const work = get('SELECT * FROM works WHERE no = ?', [key]);
  if (!work) throw new Error(`库里没有编号为 ${key} 的文献：请先用 lit_search 查编号`);
  const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
  return { work, asset };
}

/** 数字参数收敛到区间（含默认值） */
export function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** 段落锚点：[p页#段] —— 与 prompts.js 的 CITATION_PATTERN 完全一致 */
export function anchor(pageNo, ord) {
  return `[p${pageNo}#${ord}]`;
}
