/**
 * `lit_translation` —— 读某篇文献已有的中文译文段落（移植自 dsh-impl 的 litagent `tools/lit-translation.ts`）。
 *
 * 用途：中文提问 + 英文原文时，读译文比读原文更省 token 也更准；译文缺失时明确告知
 * （不静默回落原文，避免模型以为自己在读中文）。
 */
import { all } from '../../../db.js';
import { defineTool } from '../registry.js';
import { anchor, clampInt, resolveWork } from './_resolve.js';

function render(_args, value) {
  if (!value.available) {
    return `文献 ${value.no} 暂无可用译文段落：请改用 lit_read 读原文，或提示用户在阅读页先做一次翻译。`;
  }
  const blocks = value.segments.map((s) => `${anchor(s.pageNo, s.ord)} ${s.text}`);
  const head = `文献 ${value.no} 的中文译文（引擎 ${value.engine || '未知'}；本次 p${value.from}-p${value.to}，返回 ${value.segments.length} 段 / ${value.totalChars} 字${value.truncated ? '，已截断' : ''}）`;
  const tail = value.truncated ? '\n（已按 maxChars 截断；需要后续页请指定 from/to）' : '';
  return `${head}\n${blocks.join('\n')}${tail}`;
}

export const tool = defineTool({
  name: 'lit_translation',
  description:
    '读取某篇文献已有的中文译文段落（按页范围）。中文提问、英文原文时优先用它，比读原文更省且更准。不传 no 时读当前正在阅读的这篇。返回译文段落及锚点 [p页#段]。',
  parameters: {
    no: { type: 'string', description: '文献编号，例如 "4.6"；省略则读当前正在阅读的文献' },
    from: { type: 'number', description: '起始页（含），从 1 开始' },
    to: { type: 'number', description: '结束页（含）' },
    maxChars: { type: 'number', description: '本次返回的字数上限，默认 6000' },
  },
  execute(args, ctx = {}) {
    const no = String(args.no || ctx.workNo || '').trim();
    const { work, asset } = resolveWork(no);
    const empty = {
      no: work.no,
      available: false,
      engine: null,
      from: 0,
      to: 0,
      truncated: false,
      totalChars: 0,
      segments: [],
    };
    if (!asset) return empty;

    const maxChars = clampInt(args.maxChars, { min: 200, max: 20000, fallback: 6000 });
    const pageCount = asset.page_count == null ? null : Number(asset.page_count);
    const from = clampInt(args.from, { min: 1, max: pageCount || 9999, fallback: 1 });
    const to = clampInt(args.to, { min: from, max: pageCount || 9999, fallback: pageCount || 9999 });

    // 同一段可能有多份译文（换引擎/重译）：按 created_at 倒序，先出现的就是最新一份
    const rows = all(
      `SELECT s.page_no AS pageNo, s.ord AS ord, t.dst_text AS dst, t.engine AS engine, t.created_at AS createdAt
         FROM translations t
         JOIN segments s ON s.id = t.segment_id
        WHERE s.asset_id = ? AND s.page_no BETWEEN ? AND ? AND s.is_math = 0
        ORDER BY s.page_no ASC, s.ord ASC, t.created_at DESC`,
      [asset.id, from, to],
    );

    const seen = new Set();
    const segments = [];
    let totalChars = 0;
    let truncated = false;
    let engine = null;
    for (const r of rows) {
      const key = `${r.pageNo}#${r.ord}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = String(r.dst || '');
      if (!text) continue;
      if (totalChars + text.length > maxChars && segments.length) {
        truncated = true;
        break;
      }
      engine = engine || r.engine || null;
      segments.push({ pageNo: r.pageNo, ord: r.ord, text, isHeading: false });
      totalChars += text.length;
    }
    if (!segments.length) return empty;
    return { no: work.no, available: true, engine, from, to, truncated, totalChars, segments };
  },
  render,
});
