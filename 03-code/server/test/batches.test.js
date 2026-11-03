/**
 * 批次边界与编号协议（自测第 8 项：单段超长 / 空段混入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatches, buildNumberedPrompt, parseNumberedResult, splitParagraphs, cleanPageText, splitSentences } from '../services/segment.js';

test('buildBatches：按 maxItems 切分', () => {
  const batches = buildBatches(['a', 'b', 'c', 'd', 'e'], { maxItems: 2, maxChars: 1000 });
  assert.deepEqual(batches, [['a', 'b'], ['c', 'd'], ['e']]);
});

test('buildBatches：按 maxChars 切分', () => {
  const p = 'x'.repeat(60);
  const batches = buildBatches([p, p, p], { maxItems: 10, maxChars: 130 });
  // 60+1 + 61 = 122 <= 130 → 前两段一批，第三段另起
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 2);
});

test('buildBatches：空段被跳过、不占用批次', () => {
  const batches = buildBatches(['a', '', '   ', 'b'], { maxItems: 6, maxChars: 1000 });
  assert.deepEqual(batches, [['a', 'b']]);
});

test('buildBatches：单个超长段独占一批（不切断原文）', () => {
  const huge = 'y'.repeat(5000);
  const batches = buildBatches(['a', huge, 'b'], { maxItems: 6, maxChars: 1000 });
  assert.equal(batches.length, 3);
  assert.equal(batches[1][0].length, 5000);
});

test('buildBatches：全部为空 → 空批列表（不产生请求）', () => {
  assert.deepEqual(buildBatches(['', ' '], { maxItems: 6, maxChars: 100 }), []);
});

test('buildNumberedPrompt：1. 2. 3. 逐行编号', () => {
  assert.equal(buildNumberedPrompt(['甲', '乙']), '1. 甲\n2. 乙');
});

test('parseNumberedResult：正常解析（容忍 markdown 代码块与行内续行，保留换行以还原列表/引用）', () => {
  const text = '```\n1. 第一段\n2. 第二段\n续行内容\n3. 第三段\n```';
  const out = parseNumberedResult(text, 3);
  assert.deepEqual(out, ['第一段', '第二段\n续行内容', '第三段']);
});

test('parseNumberedResult：覆盖率 <60% → null（上层降级逐段）', () => {
  const out = parseNumberedResult('1. 只有一段\n乱七八糟', 4);
  assert.equal(out, null);
});

test('parseNumberedResult：缺项用空串占位（调用方补译）', () => {
  const out = parseNumberedResult('1. 甲\n3. 丙', 3);
  assert.deepEqual(out, ['甲', '', '丙']);
});

test('splitParagraphs：超长段按句子切到 maxChars 以内', () => {
  const long = 'This is a sentence. '.repeat(60);
  const out = splitParagraphs(long, { maxChars: 120 });
  assert.ok(out.length > 1);
  for (const p of out) assert.ok(p.length <= 120 + 20);
});

test('cleanPageText：修断词、去页码行、折叠空白（NFKC）', () => {
  const raw = 'analy- sis of the ﬁle\n\n\n  12  \nsystems';
  const out = cleanPageText(raw, { fixHyphenation: true });
  assert.ok(out.includes('analysis'));
  assert.ok(out.includes('file'));
  assert.ok(!/\n12\n/.test(out));
});

test('splitSentences：缩写与小数不被误切', () => {
  const s = splitSentences('As shown in Fig. 3, e.g. the value 3.14 holds. Next sentence.');
  assert.equal(s.length, 2);
});
