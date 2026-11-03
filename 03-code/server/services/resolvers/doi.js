/**
 * DOI 源解析（§9.1.2 L3 / §20 D6 已定案：DOI 只做跳转，不做自动下载）。
 *
 * 实测理由：`https://doi.org/{doi}` 会 302 跳到出版商落地页，多为付费墙（Springer 等），
 * 自动拿 PDF 成功率极低，且 Unpaywall 只「发现 OA 副本」、命中率不确定还要把邮箱发给第三方。
 * 因此本解析器在默认配置（unpaywallEmail 为空）下返回空数组，
 * 只导出 buildDoiJumpUrl 供 UI 呈现「去出版商页面（需机构订阅）」。
 */

/**
 * @param {{work:{doi?:string|null}, cfg?:{download?:{unpaywallEmail?:string}}}} _ctx
 * @returns {Promise<Array<{source:string,url:string,note?:string,expect:'pdf'|'unknown'}>>}
 */
export async function resolveDoi(_ctx) {
  // D6 = A：预留接口、默认关闭。开启条件（填了 unpaywallEmail）也不在本期实现，
  // 这里明确返回空，避免「静默尝试一个注定失败的网络请求」。
  return [];
}

/**
 * DOI 跳转 URL（不承诺能下到 PDF）。
 * @param {{doi?:string|null}} work
 * @returns {string|null}
 */
export function buildDoiJumpUrl(work) {
  const doi = work && work.doi;
  if (!doi) return null;
  return `https://doi.org/${encodeURI(doi)}`;
}

export default resolveDoi;
