/**
 * arXiv 源解析（§9.1.2 L1）。
 * 只生成候选 URL，不发任何请求、不写盘、不改状态（§5 resolvers 边界）。
 */

/**
 * @param {{work:{arxivId?:string|null}}} ctx
 * @returns {Promise<Array<{source:string,url:string,note?:string,expect:'pdf'|'unknown'}>>}
 */
export async function resolveArxiv(ctx) {
  const id = ctx && ctx.work ? ctx.work.arxivId : null;
  if (!id) return [];
  // 实测：匿名 GET https://arxiv.org/pdf/{id} 直接返回 application/pdf（无需 UA），
  // 但对不存在的 id 会返回 HTML 错误页 → 必须靠魔数兜底，HTTP 200 不算成功。
  return [
    {
      source: 'arxiv',
      url: `https://arxiv.org/pdf/${encodeURIComponent(id)}`,
      note: `arXiv:${id}`,
      expect: 'pdf',
    },
  ];
}

export default resolveArxiv;
