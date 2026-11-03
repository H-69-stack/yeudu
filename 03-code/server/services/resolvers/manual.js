/**
 * 人工源（§9.1.2 L3 的唯一人工入口）。
 * 不是一个可自动执行的源：只产出「该怎么人工拿到」的提示与 DOI 跳转链接。
 */
import { buildDoiJumpUrl } from './doi.js';

/**
 * @param {{work:Object}} ctx
 * @returns {Promise<Array<never>>} 永远为空（不产生自动候选）
 */
export async function resolveManual(_ctx) {
  return [];
}

/**
 * needs_manual 的人读出口说明（前端直接展示）。
 * @param {Object} work
 * @returns {{jumpUrl:string|null, hints:string[]}}
 */
export function manualHints(work) {
  const jumpUrl = buildDoiJumpUrl(work);
  const hints = [];
  if (jumpUrl) hints.push('点「去出版商页面」自己下载（多数需机构订阅）');
  hints.push('把 PDF 直接拖到详情页上传');
  hints.push('把 PDF 放进 storage/inbox/ 后点「扫描收件箱」');
  return { jumpUrl, hints };
}

export default resolveManual;
