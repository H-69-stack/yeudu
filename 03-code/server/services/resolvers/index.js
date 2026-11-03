/**
 * resolver 链装配（§9.1.2 三级降级）。
 * M1 只做两级自动源：L1 arxiv → L2 条目 link；DOI 只给跳转（D6 已定案）。
 */
import { resolveArxiv } from './arxiv.js';
import { resolveLink } from './link.js';
import { buildDoiJumpUrl } from './doi.js';

const ORDER = [
  ['arxiv', resolveArxiv],
  ['link', resolveLink],
];

/**
 * @param {Object} work works 行（camelCase）
 * @param {{source?:'auto'|'arxiv'|'link'|'doi'}} [opts]
 * @returns {Promise<Array<{source:string,url:string,note?:string,expect:'pdf'|'unknown'}>>}
 */
export async function resolveSources(work, opts = {}) {
  const wanted = opts.source && opts.source !== 'auto' ? opts.source : null;
  const ctx = { work };
  const out = [];
  for (const [id, fn] of ORDER) {
    if (wanted && wanted !== id) continue;
    const list = await fn(ctx);
    for (const s of list) out.push(s);
  }
  return out;
}

/** 该条目是否完全没有自动源（用于 needs_manual 判定） */
export function hasNoAutoSource(work) {
  const arxiv = Boolean(work.arxivId);
  const link = Boolean(work.link && /^https?:\/\//i.test(work.link));
  return !arxiv && !link;
}

export { buildDoiJumpUrl };
