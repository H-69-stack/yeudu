/**
 * 上下文组装（§9.3.1 预算 / §9.3.2 每轮重取 + 前缀字节稳定 / R5 裁剪顺序）。
 *
 * 顺序（前三段字节稳定，供厂商前缀缓存复用）：
 *   1 system（固定模板，无变量）
 *   2 元数据块（来自 works 行，手写模板）
 *   3 检索块（append-only；本轮追加的排在后面）
 *   4 更早对话摘要（半稳定，只压一次）
 *   5 最近 N 轮原文
 *   6 当前问题（若带 selection，把选中段与前后各 1 段提到问题前）
 *
 * 裁剪顺序（硬编码，永不裁当前 user message）：
 *   ① 检索块尾部 → ② 历史缩到最近 2 轮 → ③ 选区缩到 800 字符 → ④ 仍超则拒绝并提示缩小选区
 */
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { CHAT_SYSTEM_TEMPLATE, buildMetadataBlock, buildSummaryBlock, lastTurns, wrapSegmentBlock } from './prompts.js';

/** 字符预算（§9.3.1，全部可在配置里调） */
export function budget() {
  const c = config.chat || {};
  return {
    system: c.systemChars ?? 1200,
    meta: c.metaChars ?? 600,
    retrieve: c.retrieveChars ?? 3600,
    selection: c.selectionChars ?? 1600,
    history: c.historyChars ?? 2400,
    summary: c.summaryChars ?? 400,
  };
}

const len = (s) => [...String(s || '')].length;

/** 超过 max 就按字符截断（不切断 surrogate pair） */
export function clip(text, max) {
  const chars = [...String(text == null ? '' : text)];
  if (chars.length <= max) return { text: chars.join(''), clipped: false };
  return { text: chars.slice(0, Math.max(0, max)).join(''), clipped: true };
}

/**
 * 把检索命中合并成「段落窗口」并截到预算（相邻段合并、按页+段序输出）。
 * @param {Array<{pageNo:number, ord:number, text:string, textDst?:string|null}>} hits
 * @param {number} maxChars
 */
export function buildBlocks(hits, maxChars) {
  const list = Array.isArray(hits) ? hits : [];
  const blocks = [];
  let used = 0;
  for (const h of list) {
    const block = wrapSegmentBlock({ pageNo: h.pageNo, ord: h.ord, text: h.text, dst: h.textDst || null });
    const cost = len(block) + 2;
    if (used + cost > maxChars) break;
    blocks.push({ segmentId: h.segmentId, pageNo: h.pageNo, ord: h.ord, text: h.text, textDst: h.textDst || null, rendered: block });
    used += cost;
  }
  return { blocks, used };
}

/**
 * 组装本轮 messages。
 * @param {{work:Object, summary?:string, blocks?:Array, history?:Array, question:string,
 *          selection?:{pageNo:number, segmentIds:number[], text:string}|null, selectionContext?:Array}} p
 * @returns {{messages:Array<{role:string,content:string}>, meta:Object}}
 */
export function buildContext({ work, summary, blocks, history, question, selection, selectionContext }) {
  const b = budget();
  const meta = { truncated: [], blockIds: [], chars: {} };

  const systemText = clip(CHAT_SYSTEM_TEMPLATE, b.system);
  const metaText = clip(buildMetadataBlock(work), b.meta);
  const summaryText = clip(buildSummaryBlock(summary), b.summary);

  // 3) 检索块（本轮已按 retrieve 预算切过；这里再兜一次）
  let blockList = Array.isArray(blocks) ? blocks.slice() : [];
  const renderBlocks = () => blockList.map((x) => x.rendered || wrapSegmentBlock(x)).join('\n\n');
  let blocksText = renderBlocks();
  while (len(blocksText) > b.retrieve && blockList.length > 1) {
    blockList = blockList.slice(0, -1);
    blocksText = renderBlocks();
    meta.truncated.push('retrieve-tail');
  }
  if (len(blocksText) > b.retrieve) {
    blocksText = clip(blocksText, b.retrieve).text;
    meta.truncated.push('retrieve-clip');
  }

  // 5) 历史：先取配置轮数，超预算缩到最近 2 轮
  const turns = config.chat.historyTurns ?? 4;
  let historyList = lastTurns(history, turns);
  const renderHistory = (list) => list.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
  let historyText = renderHistory(historyList);
  if (len(historyText) > b.history) {
    historyList = lastTurns(historyList, 2);
    historyText = renderHistory(historyList);
    meta.truncated.push('history-to-2-turns');
  }
  if (len(historyText) > b.history) {
    historyText = clip(historyText, b.history).text;
    meta.truncated.push('history-clip');
  }

  // 6) 选区（含前后各 1 段）——放尾部，绝不裁问题本身
  let selectionText = '';
  if (selection && (selection.text || (selectionContext && selectionContext.length))) {
    const ctx = Array.isArray(selectionContext) ? selectionContext : [];
    const body = [
      ctx.length ? ctx.map((s) => wrapSegmentBlock({ pageNo: s.pageNo, ord: s.ord, text: s.text, dst: s.textDst || null })).join('\n\n') : '',
      `【用户选中的原文】\n${clip(selection.text || '', b.selection).text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    selectionText = body;
    if (len(selectionText) > b.selection) {
      selectionText = clip(selectionText, Math.min(800, b.selection)).text;
      meta.truncated.push('selection-to-800');
    }
  }

  const questionText = `【用户问题】\n${String(question || '').trim()}`;
  if (len(questionText) > 4000) {
    throw new AppError('E_BAD_REQUEST', '问题过长（超过 4000 字符），请缩短后重试', { questionChars: len(questionText) });
  }

  const tail = [selectionText, questionText].filter(Boolean).join('\n\n');
  const tailLen = len(tail);
  if (tailLen > b.selection + b.retrieve) {
    // 裁剪到底仍超预算：拒绝，不静默截断用户问题（§9.3.1 ④）
    throw new AppError('E_BAD_REQUEST', '问题与选区过长，请缩小选区后重试', {
      questionChars: len(questionText),
      selectionChars: len(selectionText),
    });
  }

  const messages = [
    { role: 'system', content: systemText.text },
    {
      role: 'user',
      content: [
        metaText.text,
        blocksText ? `【文献资料片段】\n${blocksText}` : '【文献资料片段】\n（本轮未检索到相关段落）',
        summaryText.text,
        historyText,
        tail,
      ]
        .filter((x) => x && x.trim())
        .join('\n\n'),
    },
  ];

  meta.blockIds = blockList.map((x) => x.segmentId);
  meta.chars = {
    system: len(systemText.text),
    meta: len(metaText.text),
    blocks: len(blocksText),
    summary: len(summaryText.text),
    history: len(historyText),
    selection: len(selectionText),
    question: len(questionText),
    totalInput: len(messages[0].content) + len(messages[1].content),
  };
  return { messages, meta };
}

/**
 * 校验「前缀字节稳定」：同一 chat 的 system + 元数据在两次渲染后必须完全一致。
 * 单测直接用它（§22 M3 验收项）。
 */
export function stablePrefix(work) {
  return `${CHAT_SYSTEM_TEMPLATE}\u0000${buildMetadataBlock(work)}`;
}
