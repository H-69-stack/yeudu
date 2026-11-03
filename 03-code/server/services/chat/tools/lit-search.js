/**
 * `lit_search` —— 跨全库检索文献（移植自 dsh-impl 的 litagent `tools/lit-search.ts`）。
 *
 * 与旧链路的差别：旧检索被 `fts.js` 的 `asset_id = ?` 锁死在「当前这篇」内；
 * 这个工具走 `searchWorksAcross`，**不按 asset 过滤**，因此能回答「哪些文献讲过 X」。
 * 命中按文献归并，每篇附 1-3 个段落锚点，模型可直接用锚点写引用。
 */
import { searchWorksAcross } from '../../fts.js';
import { defineTool } from '../registry.js';
import { clampInt } from './_resolve.js';

const HIT_PREVIEW_CHARS = 160;

function render(_args, value) {
  if (!value.total) {
    return '未命中：请放宽关键词（多个词用空格分隔表示同时满足），或去掉过滤条件。';
  }
  const lines = value.items.map((it) => {
    const bits = [it.no, it.title];
    if (it.authors) bits.push(it.authors);
    if (it.year != null) bits.push(String(it.year));
    if (it.section) bits.push(it.section);
    if (!it.hasPdf) bits.push('（本地无 PDF）');
    else if (!it.hasText) bits.push('（PDF 已下载但正文未抽取，暂不可读）');
    const head = `- ${bits.join(' | ')}`;
    const segs = it.hits.map((h) => `    · [p${h.pageNo}#${h.ord}] ${h.text}`);
    return [head, ...segs].join('\n');
  });
  return `${value.total} 篇命中（最多 ${value.limit} 篇）：\n${lines.join('\n')}\n\n需要读全文用 lit_read（传文献编号），需要读译文用 lit_translation。`;
}

export const tool = defineTool({
  name: 'lit_search',
  description:
    '在用户的个人文献库中跨文献检索（不是只在当前这篇里找）。按关键词匹配正文段落，也匹配标题/作者/贡献定位；多个关键词以空格分隔表示「同时满足」（AND）。返回文献编号、标题、作者、年份、分区，以及每篇命中的 1-3 个原文段落及其锚点 [p页#段]。后续用 lit_read / lit_translation 深入阅读。',
  parameters: {
    q: {
      type: 'string',
      required: true,
      description: '关键词；多个词用空格分隔表示同时满足（AND）。中文与英文都可，英文走前缀匹配',
    },
    limit: { type: 'number', description: '返回文献篇数上限，默认 8，最大 20' },
  },
  execute(args) {
    const q = String(args.q == null ? '' : args.q).trim();
    const limit = clampInt(args.limit, { min: 1, max: 20, fallback: 8 });
    if (!q) return { total: 0, limit, items: [] };
    const list = searchWorksAcross(q, { worksLimit: limit, perWork: 2 });
    return {
      total: list.length,
      limit,
      items: list.map(({ work, hits }) => ({
        no: work.no,
        title: work.title,
        authors: work.authors || null,
        year: work.year == null ? null : Number(work.year),
        section: work.section || null,
        hasPdf: Boolean(work.hasPdf),
        hasText: Boolean(work.hasText),
        hits: hits.map((h) => ({
          pageNo: h.pageNo,
          ord: h.ord,
          text: String(h.text || '').replace(/\s+/g, ' ').slice(0, HIT_PREVIEW_CHARS),
        })),
      })),
    };
  },
  render,
});
