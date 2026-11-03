/**
 * 条目官方链接源（§9.1.2 L2）。
 * 覆盖率低、多数是落地页 HTML，因此 expect 一律 'unknown'，必须靠魔数兜底判定。
 */

/**
 * @param {{work:{link?:string|null}}} ctx
 * @returns {Promise<Array<{source:string,url:string,note?:string,expect:'pdf'|'unknown'}>>}
 */
export async function resolveLink(ctx) {
  const link = ctx && ctx.work ? ctx.work.link : null;
  if (!link || !/^https?:\/\//i.test(link)) return [];
  // 明显的 arXiv 链接交给 arxiv 解析器出 PDF 直链，避免重复尝试同一目标
  if (/arxiv\.org\/(abs|pdf)\//i.test(link) && ctx.work.arxivId) return [];
  return [
    {
      source: 'link',
      url: link,
      note: '条目官方链接（需魔数判定是否为 PDF）',
      expect: 'unknown',
    },
  ];
}

export default resolveLink;
