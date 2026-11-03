/**
 * 翻译缓存键（§7 / §21 R3 / 自测第 6 项的基础）。
 * 断言的核心：只有「真正影响译文的字段」变化才 miss；srcLang 与空白差异不制造 miss。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey, normalizeForHash } from '../services/translate/cacheKey.js';

const base = {
  engine: 'deepseek',
  model: 'deepseek-chat',
  tgtLang: 'zh-CN',
  promptFp: 'abcd1234',
  extractVersion: 3,
  text: 'We propose a framework for classifying capabilities.',
};

test('同一输入 → 同一 key（确定性）', () => {
  assert.equal(buildCacheKey(base), buildCacheKey({ ...base }));
});

test('换模型 → miss', () => {
  assert.notEqual(buildCacheKey(base), buildCacheKey({ ...base, model: 'deepseek-reasoner' }));
});

test('改提示词指纹 → miss', () => {
  assert.notEqual(buildCacheKey(base), buildCacheKey({ ...base, promptFp: 'abcd1235' }));
});

test('换目标语言 → miss；换引擎 → miss', () => {
  assert.notEqual(buildCacheKey(base), buildCacheKey({ ...base, tgtLang: 'zh-TW' }));
  assert.notEqual(buildCacheKey(base), buildCacheKey({ ...base, engine: 'claude' }));
});

test('重抽（extract_version+1）→ miss', () => {
  assert.notEqual(buildCacheKey(base), buildCacheKey({ ...base, extractVersion: base.extractVersion + 1 }));
});

test('srcLang 不进键（auto 与 en 对同一段译文应当一致，§21 R3）', () => {
  const withSrc = { ...base, srcLang: 'en' };
  assert.equal(buildCacheKey(base), buildCacheKey(withSrc));
});

test('空白/NFKC 差异不制造 miss（同一段文本的不可见差异）', () => {
  const a = buildCacheKey({ ...base, text: 'ＡＧＩ  is   a  goal' });
  const b = buildCacheKey({ ...base, text: 'AGI is a goal' });
  assert.equal(a, b);
});

test('正文不同 → 不同 key', () => {
  assert.notEqual(buildCacheKey(base), buildCacheKey({ ...base, text: base.text + '.' }));
});

test('分隔符用 \\u0000：含 "|" 的正文不会与另一组合串冲突', () => {
  const k1 = buildCacheKey({ ...base, text: 'a|b' });
  const k2 = buildCacheKey({ ...base, text: 'a', promptFp: 'b' });
  assert.notEqual(k1, k2);
});

test('normalizeForHash：NFKC + 空白折叠', () => {
  assert.equal(normalizeForHash('  a\n\n  b  '), 'a b');
  assert.equal(normalizeForHash('ﬁle'), 'file');
});
