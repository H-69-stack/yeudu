/**
 * 上下文组装与预算裁剪（§9.3.1 / R5）。
 * 断言的是「裁剪顺序」与「前缀稳定」，不是最终文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, buildBlocks, clip, stablePrefix, budget } from '../services/chat/context.js';

const work = { title: 'Levels of AGI', authors: 'Morris et al.', year: 2023, venue: 'arXiv', note: '分级框架' };

function mkHits(n, chars = 200) {
  return Array.from({ length: n }, (_, i) => ({
    segmentId: 1000 + i,
    pageNo: Math.floor(i / 5) + 1,
    ord: i % 5,
    text: `sentence ${i} ` + 'x'.repeat(chars),
    textDst: `中文 ${i}`,
    hitLang: i % 2 ? 'dst' : 'src',
  }));
}

test('buildContext：消息顺序为 system → user(元数据+块+摘要+历史+问题)', () => {
  const { blocks } = buildBlocks(mkHits(3), 3600);
  const { messages } = buildContext({
    work,
    summary: '',
    blocks,
    history: [
      { role: 'user', content: '上一轮问题' },
      { role: 'assistant', content: '上一轮回答' },
    ],
    question: '本轮问题',
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  const body = messages[1].content;
  const iMeta = body.indexOf('【文献元数据】');
  const iBlocks = body.indexOf('【文献资料片段】');
  const iQ = body.indexOf('【用户问题】');
  assert.ok(iMeta >= 0 && iBlocks > iMeta && iQ > iBlocks, '元数据 → 片段 → 问题 的顺序');
  assert.ok(body.indexOf('上一轮问题') < iQ, '历史在问题之前');
});

test('buildContext：前缀字节稳定（两次渲染 system+元数据 完全相同）', () => {
  assert.equal(stablePrefix(work), stablePrefix({ ...work }));
  const a = buildContext({ work, blocks: [], history: [], question: 'q1' });
  const b = buildContext({ work, blocks: [], history: [], question: 'q2' });
  assert.equal(a.messages[0].content, b.messages[0].content, 'system 必须字节一致');
});

test('裁剪顺序：块超预算时先砍检索块，不砍 system 与问题', () => {
  const { blocks } = buildBlocks(mkHits(30, 600), 100000); // 故意造超大
  const { messages, meta } = buildContext({ work, blocks, history: [], question: '这是当前问题' });
  assert.ok(messages[0].content.startsWith('你是一位严谨的学术文献助手'), 'system 不被裁');
  assert.ok(messages[1].content.includes('这是当前问题'), '当前问题不被裁');
  assert.ok(meta.truncated.some((t) => t.startsWith('retrieve')), '检索块被裁剪');
  assert.ok(meta.chars.blocks <= 3600 + 50);
});

test('裁剪顺序：历史超预算时缩到最近 2 轮', () => {
  const history = [];
  for (let i = 0; i < 6; i += 1) {
    history.push({ role: 'user', content: `问题${i} ` + 'a'.repeat(300) });
    history.push({ role: 'assistant', content: `回答${i} ` + 'b'.repeat(300) });
  }
  const { messages, meta } = buildContext({ work, blocks: [], history, question: '现在的问题' });
  assert.ok(meta.truncated.includes('history-to-2-turns'), '应触发历史裁剪');
  const body = messages[1].content;
  assert.ok(body.includes('问题5'), '最近一轮保留');
  assert.ok(!body.includes('问题0'), '最老一轮被裁');
});

test('选区：默认放在问题之前，且受 selectionChars 预算约束', () => {
  const { messages } = buildContext({
    work,
    blocks: [],
    history: [],
    question: '解释这段',
    selection: { pageNo: 1, segmentIds: [1], text: 'y'.repeat(500) },
    selectionContext: [{ pageNo: 1, ord: 0, text: '前后文一' }],
  });
  const body = messages[1].content;
  assert.ok(body.indexOf('【用户选中的原文】') < body.indexOf('【用户问题】'), '选区在问题之前');
  assert.ok(body.includes('前后文一'), '带上了前后段上下文');
});

test('问题+选区超过预算时抛 E_BAD_REQUEST，不静默截断问题', () => {
  const q = '问'.repeat(5000);
  assert.throws(
    () => buildContext({ work, blocks: [], history: [], question: q }),
    (e) => e.code === 'E_BAD_REQUEST',
  );
});

test('clip：按字符（不是字节）截断，且报告是否裁过', () => {
  assert.deepEqual(clip('中文abc', 2), { text: '中文', clipped: true });
  assert.deepEqual(clip('abc', 5), { text: 'abc', clipped: false });
});

test('buildBlocks：按预算容纳，超出即停止（不切半个块）', () => {
  const { blocks, used } = buildBlocks(mkHits(10, 300), 1000);
  assert.ok(blocks.length >= 1 && blocks.length < 10);
  assert.ok(used <= 1000);
  for (const b of blocks) assert.ok(b.rendered.startsWith('<<<SEG'));
});

test('budget()：预算来自 config.chat，可覆盖', () => {
  const b = budget();
  assert.ok(b.retrieve > 0 && b.history > 0);
});
