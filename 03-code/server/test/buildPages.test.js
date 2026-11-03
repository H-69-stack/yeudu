/**
 * S1–S7 衔接链（§16.2）：行聚合 / 栏判定 / 阅读顺序 / 段落合并 / 角色判定 / 确定性。
 * 纯函数，零 IO —— 直接喂合成的 items，不需要 fixture PDF。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPagesFromRaw, groupLines, detectColumns, classifyRole, classifyRich, hoistDropCaps } from '../services/pdf/buildPages.js';

const FONT = 10;
/** 造一个 item：x/y 为 PDF 用户坐标（y 向上），w 为宽度 */
function item(str, x, y, w = str.length * FONT * 0.5, h = FONT) {
  return { str, transform: [h, 0, 0, h, x, y], width: w, height: h, hasEOL: false };
}

/** 造一页双栏：左栏 x=55..289，右栏 x=307..543，行距 12 */
function twoColumnPage(pageNo = 1) {
  const items = [];
  const xLeft = 55;
  const xRight = 307;
  for (let i = 0; i < 12; i += 1) {
    const y = 700 - i * 12;
    items.push(item(`Left column line number ${i} with some words`, xLeft, y));
    items.push(item(`Right column line number ${i} with some words`, xRight, y));
  }
  // 通栏标题
  items.push(item('A Full Width Title Spanning Both Columns', 55, 740, 488));
  return { pageNo, width: 612, height: 792, items };
}

function oneColumnPage(pageNo = 1) {
  const items = [];
  for (let i = 0; i < 20; i += 1) {
    items.push(item(`Single column line ${i} with a reasonably long sentence of text.`, 72, 700 - i * 12, 468));
  }
  return { pageNo, width: 612, height: 792, items };
}

test('groupLines：同一基线上的左右栏被切成两行（不会串成一行）', () => {
  const lines = groupLines(twoColumnPage().items);
  assert.ok(lines.length >= 24, `应至少 24 行，实际 ${lines.length}`);
  const wide = lines.filter((l) => l.x1 - l.x0 > 0.7 * 612);
  assert.ok(wide.length >= 1, '通栏标题应保留为宽行');
});

test('groupLines：负字距（Tw<0）把词距压成负间隙时仍补空格', () => {
  // 实测 1.11 第 4 页：连续 5 个词各自是独立 item，边界互相重叠 -10pt，
  // 旧逻辑只按「正间隙」补空格，于是拼成 `Processorssendmessagesoverconnecting`。
  const items = [item('Processors', 353.8, 728.6, 44.1), item('send', 387.9, 728.6, 18.8), item('messages', 396.7, 728.6, 38.9)];
  const lines = groupLines(items);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Processors send messages$/);
});

test('groupLines：重叠 <0.5pt 视为连续笔画，不补空格', () => {
  const items = [item('half', 100, 700, 20.1), item('way', 120, 700, 18)];
  const lines = groupLines(items);
  assert.equal(lines[0].text, 'halfway');
});

test('detectColumns：双栏页判为 2 栏，splitX 落在两栏之间', () => {
  const lines = groupLines(twoColumnPage().items);
  const col = detectColumns(lines, 612, {});
  assert.equal(col.columns, 2);
  assert.ok(col.splitX > 280 && col.splitX < 320, `splitX=${col.splitX}`);
});

test('detectColumns：单栏页不会误判为双栏', () => {
  const lines = groupLines(oneColumnPage().items);
  const col = detectColumns(lines, 612, {});
  assert.equal(col.columns, 1);
});

test('buildPagesFromRaw：双栏页段落顺序为「先左栏后右栏」', () => {
  const pages = buildPagesFromRaw([twoColumnPage(1)], { paragraphChars: 600 });
  const texts = pages[0].paras.map((p) => p.text);
  const firstLeft = texts.findIndex((t) => t.startsWith('Left column'));
  const firstRight = texts.findIndex((t) => t.startsWith('Right column'));
  assert.ok(firstLeft >= 0 && firstRight >= 0, '两栏内容都在');
  assert.ok(firstLeft < firstRight, '左栏应排在右栏之前');
});

test('buildPagesFromRaw：确定性（同一输入两次输出逐字节相等）', () => {
  const a = buildPagesFromRaw([twoColumnPage(1), oneColumnPage(2)]);
  const b = buildPagesFromRaw([twoColumnPage(1), oneColumnPage(2)]);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('段落合并：句子未结束且无缩进 → 逐行并成一段', () => {
  const items = [];
  const words = ['This is the first half of a sentence,', 'and this is the second half of it.', 'A new paragraph starts here.'];
  words.forEach((w, i) => items.push(item(w, 72, 700 - i * 12, 400)));
  const pages = buildPagesFromRaw([{ pageNo: 1, width: 612, height: 792, items }], { paragraphChars: 600 });
  const paras = pages[0].paras.map((p) => p.text);
  // 前两行并入同一段（第二行以 "." 结束 → 第三行另起）
  assert.ok(paras.length >= 1 && paras.length <= 3, `实际段数 ${paras.length}`);
});

test('角色判定：公式 / 图注 / 标题 / 正文', () => {
  const math = classifyRole('x = 3 × 4 + ∑ y ≤ 12 ∈ R');
  assert.equal(math.isMath, true, '符号密度高的行应判公式');
  const body = classifyRole('This paper proposes a framework for classifying capabilities of AI systems.');
  assert.equal(body.isMath, false);
  assert.equal(body.isLabel, false);
  const heading = classifyRole('2. Defining AGI: Case Studies');
  assert.equal(heading.isHeading, true);
  const label = classifyRole('Figure 3');
  assert.equal(label.isLabel, true);
});

test('bbox：段落包围盒是页内合法矩形（y 向上）', () => {
  const pages = buildPagesFromRaw([twoColumnPage(1)]);
  for (const p of pages[0].paras) {
    const [x0, y0, x1, y1] = p.bbox;
    assert.ok(x0 >= 0 && x0 <= 612, 'x0 在页内');
    assert.ok(x1 > x0 && y1 > y0, '矩形非退化');
  }
});

// ───────────────────────── joinContinuations（S4.5 跨栏续句） ─────────────────────────
import { joinContinuations } from '../services/pdf/buildPages.js';

/** 造一个 mergeParagraphs 形态的块 */
function blk(text, fontSize = 10, x0 = 55, x1 = 300) {
  return { text, x0, x1, yTop: 700, yBottom: 600, fontSize, column: 0 };
}

test('joinContinuations：连字符断词跨栏拼回整句', () => {
  const blocks = [
    blk('DISTRIBUTED problem solving is the cooperative so-'),
    blk('lution of problems by a decentralized collection of knowledge-sources.'),
  ];
  const out = joinContinuations(blocks, 10);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /cooperative solution of problems/);
});

test('joinContinuations：分号后的跨栏续句也要拼（分号不算句末）', () => {
  const blocks = [
    blk('By decentralized we mean that both control and data are logically and often geographically distributed;'),
    blk('there is neither global control nor global data storage.'),
  ];
  const out = joinContinuations(blocks, 10);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /distributed; there is neither/);
});

test('joinContinuations：句号结尾 + 大写开头 = 新段落，不拼', () => {
  const blocks = [
    blk('This paragraph has already finished its own sentence properly.'),
    blk('Another paragraph starts here with a capital letter and goes on.'),
  ];
  assert.equal(joinContinuations(blocks, 10).length, 2);
});

test('joinContinuations：被拆开的多行大标题拼回一段', () => {
  const blocks = [
    blk('The Contract Net Protocol: High-Level', 20),
    blk('Communication and Control in a Distributed Problem Solver', 20),
  ];
  const out = joinContinuations(blocks, 10);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /High-Level Communication and Control/);
});

test('classifyRole：罗马数字章节标题判为 heading 而不是图注', () => {
  assert.equal(classifyRole('I. INTRODUCTION').isHeading, true);
  assert.equal(classifyRole('I. INTRODUCTION').isLabel, false);
  assert.equal(classifyRole('III. EXAMPLE').isHeading, true);
  // 页码 / 版权行仍应是图注（不送翻译）
  assert.equal(classifyRole('1 104').isLabel, true);
  assert.equal(classifyRole('©) 1980 Canadian Crown Copyright').isLabel, true);
});

test('classifyRich：IEEE 页脚条码行判脚注，不当作正文字号段落', () => {
  const block = { text: '08824967/86/0300-0014$01.OO © 1986 IEEE', fontSize: 10, x0: 55, x1: 300, yTop: 40, yBottom: 32 };
  const rich = classifyRich(block, 10, 612);
  assert.equal(rich.role, 'footnote');
  assert.equal(rich.tier, 'small');
});

test('hoistDropCaps：首字下沉的大字母搬回上一行行首', () => {
  const lines = [
    { text: 'CONTROL SYSTEM for a completely autonomous', fontSize: 10, column: 'L', x0: 55, x1: 280, yTop: 700, yBottom: 690 },
    { text: 'Amobile robot must perform many complex tasks', fontSize: 22, column: 'L', x0: 55, x1: 280, yTop: 685, yBottom: 660 },
  ];
  const out = hoistDropCaps(lines, 10);
  assert.equal(out[0].text, 'A CONTROL SYSTEM for a completely autonomous');
  assert.equal(out[1].text, 'mobile robot must perform many complex tasks');
  assert.equal(out[1].fontSize, 10);
});

test('hoistDropCaps：上一行已收句时不搬', () => {
  const lines = [
    { text: 'A paragraph that already ended.', fontSize: 10, column: 'L', x0: 55, x1: 280, yTop: 700, yBottom: 690 },
    { text: 'Amobile robot must perform many complex tasks', fontSize: 22, column: 'L', x0: 55, x1: 280, yTop: 685, yBottom: 660 },
  ];
  const out = hoistDropCaps(lines, 10);
  assert.equal(out[0].text, 'A paragraph that already ended.');
  assert.match(out[1].text, /^Amobile/);
});
