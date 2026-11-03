/**
 * 文件名生成与反解（§12.2 buildRelPath 必须有单测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelPath, parseNoFromFilename, slugify } from '../services/storage.js';

test('slugify：拉丁标题转 kebab-case 并截断', () => {
  assert.equal(slugify('A Survey on Large Language Model based Autonomous Agents'), 'a-survey-on-large-language-model-based-autonomous-agents');
  assert.equal(slugify('  Hello, World!!  '), 'hello-world');
});

test('slugify：非拉丁（中文）标题退化为 zh+hash', () => {
  const s = slugify('面向大模型的工作流编排');
  assert.match(s, /^zh[0-9a-f]{8}$/);
  // 同一标题必须稳定（幂等键依赖它）
  assert.equal(s, slugify('面向大模型的工作流编排'));
});

test('slugify：maxLen 截断不留下尾部连字符', () => {
  const s = slugify('a'.repeat(5) + '-' + 'b'.repeat(80), { maxLen: 10 });
  assert.ok(s.length <= 10);
  assert.ok(!s.endsWith('-'));
});

test('buildRelPath：`<no>__<slug>.pdf` 形状', () => {
  const p = buildRelPath({ no: '4.13', title: 'Survey on Large Language Model based Agents' });
  assert.equal(p, '4.13__survey-on-large-language-model-based-agents.pdf');
});

test('parseNoFromFilename：从文件名反解编号（幂等键）', () => {
  assert.equal(parseNoFromFilename('12.10__xxx.pdf'), '12.10');
  assert.equal(parseNoFromFilename('4.13__a.pdf'), '4.13');
  assert.equal(parseNoFromFilename('no-number.pdf'), null);
  assert.equal(parseNoFromFilename('4.13__a.txt'), null);
});

test('buildRelPath 与 parseNoFromFilename 互为反函数（编号可逆）', () => {
  for (const no of ['1.1', '7.2', '12.10']) {
    const p = buildRelPath({ no, title: 'Some Paper Title' });
    assert.equal(parseNoFromFilename(p), no);
  }
});
