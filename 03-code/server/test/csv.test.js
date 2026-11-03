/**
 * CSV 解析与字段归一化（§7.1）。
 * 覆盖：BOM、引号内逗号/换行/双引号、arXiv/DOI/链接/年份/专题归一化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  normalizeArxiv,
  normalizeDoi,
  normalizeLink,
  normalizeYear,
  normalizeSection,
  readCsvRecords,
} from '../services/importer.js';

test('parseCsv：引号内逗号与换行', () => {
  const text = 'a,b,c\r\n1,"x,y","line1\nline2"\r\n2,"he said ""hi""",z\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['1', 'x,y', 'line1\nline2']);
  assert.deepEqual(rows[2], ['2', 'he said "hi"', 'z']);
});

test('normalizeArxiv：去前缀与版本号，转小写', () => {
  assert.equal(normalizeArxiv('arXiv:2308.11432v2'), '2308.11432');
  assert.equal(normalizeArxiv('2308.11432'), '2308.11432');
  assert.equal(normalizeArxiv('  '), null);
});

test('normalizeDoi：去 doi.org 前缀并小写', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1016/B978-0-934613-03-3.50033-7'), '10.1016/b978-0-934613-03-3.50033-7');
  assert.equal(normalizeDoi('doi:10.1000/XYZ'), '10.1000/xyz');
  assert.equal(normalizeDoi(''), null);
});

test('normalizeLink：只接受 http(s)', () => {
  assert.equal(normalizeLink('https://example.org/a.pdf'), 'https://example.org/a.pdf');
  assert.equal(normalizeLink('ftp://example.org/a.pdf'), null);
  assert.equal(normalizeLink('example.org'), null);
});

test('normalizeYear：解析失败置 NULL', () => {
  assert.equal(normalizeYear('2019'), 2019);
  assert.equal(normalizeYear('2019年'), 2019);
  assert.equal(normalizeYear('不详'), null);
  assert.equal(normalizeYear(''), null);
});

test('normalizeSection：拆序号与全称，缺序号告警', () => {
  assert.deepEqual(normalizeSection('4 LLM Agent 工作流：编排'), { sectionNo: 4, section: '4 LLM Agent 工作流：编排' });
  const r = normalizeSection('无序号专题');
  assert.equal(r.sectionNo, 0);
  assert.ok(r.warning);
});

test('readCsvRecords：真实 CSV 的 13 列映射（424 行，321 条含 arXiv，22 专题）', () => {
  const { records, warnings } = readCsvRecords();
  assert.equal(records.length, 424);
  assert.equal(records.filter((r) => r.arxivId).length, 321);
  assert.equal(new Set(records.map((r) => r.sectionNo)).size, 22);
  assert.deepEqual(warnings, []);
  const first = records[0];
  assert.equal(first.no, '1.1');
  assert.equal(first.sectionNo, 1);
  assert.equal(first.type, '专著');
  assert.ok(first.title.length > 0);
  // 每条记录都必须有合法的 段号.序号
  for (const r of records) assert.match(r.no, /^\d+\.\d+$/);
});
