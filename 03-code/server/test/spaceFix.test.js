import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVocabulary, fixSplitLetters, restoreSpaces, segmentRun } from '../services/pdf/spaceFix.js';

/** 把若干行文本拼成最小 rawPages 形状（buildVocabulary 只看 items[].str）。 */
function pagesOf(lines) {
  return [{ items: lines.map((str) => ({ str })) }];
}

test('fixSplitLetters 修掉词内被插入的空格', () => {
  assert.equal(fixSplitLetters('i s'), 'is');
  assert.equal(fixSplitLetters('a s'), 'as');
  assert.equal(fixSplitLetters('o f'), 'of');
  assert.equal(fixSplitLetters('Eventually it i s intended'), 'Eventually it is intended');
});

test('fixSplitLetters 不动正常的单字母搭配', () => {
  assert.equal(fixSplitLetters('a little'), 'a little');
  assert.equal(fixSplitLetters('i t'), 'it'); // "i t" 就是被劈开的 it
  assert.equal(fixSplitLetters('q z'), 'q z'); // 拼不成常用词就不动
  assert.equal(fixSplitLetters('x = 3'), 'x = 3');
  assert.equal(fixSplitLetters(''), '');
});

test('restoreSpaces 在词表支持下切开被吞空格的粘连词', () => {
  const vocab = buildVocabulary(
    pagesOf(['the robot can move', 'the robot must move', 'for controlling mobile robots', 'control system design', 'robots and control']),
  );
  assert.equal(restoreSpaces('forcontrollingmobilerobots', vocab), 'for controlling mobile robots');
  assert.equal(restoreSpaces('therobotcanmove', vocab), 'the robot can move');
});

test('restoreSpaces 宁可不切也不切错：片必须全部成词', () => {
  const vocab = buildVocabulary(pagesOf(['applicable ability application', 'the robot can move']));
  // 逐片都是词才切；切成 `a pplic ability` 这类半词结果必须被拒绝
  assert.equal(restoreSpaces('applicability', vocab), 'applicability');
});

test('restoreSpaces 对正常文本零改动', () => {
  const vocab = buildVocabulary(pagesOf(['the robot can move', 'for controlling mobile robots']));
  assert.equal(restoreSpaces('The robot can move quickly.', vocab), 'The robot can move quickly.');
  assert.equal(restoreSpaces('表 1 中的结果', vocab), '表 1 中的结果');
});

test('segmentRun 在 requireAllKnown 下拒绝含未知片的切分', () => {
  const vocab = buildVocabulary(pagesOf(['the robot can move', 'mobile robots']));
  assert.equal(segmentRun('therobot', vocab, { requireAllKnown: true }).join(' '), 'the robot');
  assert.equal(segmentRun('zzqqrobo', vocab, { requireAllKnown: true }), null);
});

test('粘连 token 允许一个未知片：术语/生词不再导致整段不切', () => {
  // `subsuming` 在这份文档里从没分开出现过，词表里没有它；
  // 但它两侧全是常用词，仍然应该切开（实测 1.11 第 4 页）。
  // 粘连 token 必须真的出现在原始 items 里 —— 词表是从原文统计出来的。
  const vocab = buildVocabulary(
    pagesOf([
      'the control system is layered with higher level layers',
      'layered with higher level layers when they interact',
      'lower level layers are suppressed by higher layers',
      'layeredwithhigherlevellayerssubsuming',
    ]),
  );
  assert.equal(
    restoreSpaces('layeredwithhigherlevellayerssubsuming', vocab),
    'layered with higher level layers subsuming',
  );
});

test('粘连切分不产出碎渣片：宁可整段不切', () => {
  const vocab = buildVocabulary(pagesOf(['the control system is described in this paper']));
  // `The suppress i on` / `out puts can` 这类“全片成词但不像话”的切法必须被拒绝
  assert.equal(restoreSpaces('Thesuppression', vocab), 'Thesuppression');
  assert.equal(restoreSpaces('outputscan', vocab), 'outputscan');
});

test('全大写片段（页眉）也能切开', () => {
  const vocab = buildVocabulary(pagesOf(['a robust layered control system for a mobile robot', 'control system']));
  assert.match(
    restoreSpaces('BROOKS:AROBUSTLAYEREDCONTROLSYSTEMFORAMOBILEROBOT', vocab),
    /^BROOKS:A ROBUST LAYERED CONTROL SYSTEM FOR A MOBILE ROBOT$/,
  );
});
