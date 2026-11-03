/**
 * `lit_read` —— 按页读取某篇文献的原文段落（移植自 dsh-impl 的 litagent `tools/lit-read.ts`）。
 *
 * 关键设计（照搬 dsh）：**显式 `truncated` 标记 + maxChars**，让模型知道「这不是全文」，
 * 而不是把截断结果当完整上下文（避免幻觉式总结）。
 * 段落前带 `[p页#段]` 锚点，模型引用时直接抄锚点，服务端再查库校验（防伪造）。
 */
import { all } from '../../../db.js';
import { defineTool } from '../registry.js';
import { anchor, clampInt, resolveWork } from './_resolve.js';

function render(_args, value) {
  if (!value.no) return '未找到文献：请先用 lit_search 查到文献编号。';
  if (!value.segments.length) {
    return `文献 ${value.no} 在 p${value.from}-p${value.to} 没有可读段落：请确认页码范围，或用 lit_search 确认该条目是否已抽取正文。`;
  }
  const blocks = value.segments.map(
    (s) => `${anchor(s.pageNo, s.ord)}${s.isHeading ? '（标题）' : ''} ${s.text}`,
  );
  const head = `文献 ${value.no}（共 ${value.pageCount == null ? '?' : value.pageCount} 页；本次 p${value.from}-p${value.to}，返回 ${value.segments.length} 段 / ${value.totalChars} 字${value.truncated ? '，已截断' : ''}）`;
  const tail = value.truncated ? '\n（内容已按 maxChars 截断；需要后续页请指定 from/to 继续读）' : '';
  return `${head}\n${blocks.join('\n')}${tail}`;
}

export const tool = defineTool({
  name: 'lit_read',
  description:
    '按页码读取某篇文献的原文段落（PDF 抽取出的文本块，含页内段落序号）。用于核对细节、摘录原句、写引用。不传 no 时读当前正在阅读的这篇。返回段落文本与是否被截断。',
  parameters: {
    no: { type: 'string', description: '文献编号，例如 "4.6"；省略则读当前正在阅读的文献' },
    from: { type: 'number', description: '起始页（含），从 1 开始；省略为第 1 页' },
    to: { type: 'number', description: '结束页（含）；省略为末页' },
    maxChars: { type: 'number', description: '本次返回的字数上限，默认 6000，最小 200' },
  },
  execute(args, ctx = {}) {
    const no = String(args.no || ctx.workNo || '').trim();
    const { work, asset } = resolveWork(no);
    if (!asset) {
      return { no: work.no, pageCount: null, from: 0, to: 0, truncated: false, totalChars: 0, segments: [] };
    }
    if (asset.extract_status !== 'ready') {
      return { no: work.no, pageCount: asset.page_count ?? null, from: 0, to: 0, truncated: false, totalChars: 0, segments: [] };
    }
    const maxChars = clampInt(args.maxChars, { min: 200, max: 20000, fallback: 6000 });
    const pageCount = asset.page_count == null ? null : Number(asset.page_count);
    const from = clampInt(args.from, { min: 1, max: pageCount || 9999, fallback: 1 });
    const to = clampInt(args.to, { min: from, max: pageCount || 9999, fallback: pageCount || 9999 });

    const rows = all(
      `SELECT page_no AS pageNo, ord, text, is_heading AS isHeading
         FROM segments
        WHERE asset_id = ? AND page_no BETWEEN ? AND ? AND is_math = 0
        ORDER BY page_no ASC, ord ASC`,
      [asset.id, from, to],
    );

    const segments = [];
    let totalChars = 0;
    let truncated = false;
    for (const r of rows) {
      const text = String(r.text || '');
      if (!text.trim()) continue; // 空段（图表占位/纯公式残留）不占预算也不返给模型
      if (totalChars + text.length > maxChars && segments.length) {
        truncated = true;
        break;
      }
      segments.push({ pageNo: r.pageNo, ord: r.ord, text, isHeading: Boolean(r.isHeading) });
      totalChars += text.length;
    }
    return { no: work.no, pageCount, from, to, truncated, totalChars, segments };
  },
  render,
});
