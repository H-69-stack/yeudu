/**
 * PDF 三连校验（M1 自测第 3 项的离线部分）：
 * 魔数 + 页数 + 体积，三者同时成立才算 PDF。HTTP 200 不算成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPdfFile, countPdfPagesFromBuffer, hasPdfMagic } from '../services/pdf/meta.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlit-pdf-'));

/** 造一个结构上可解析的最小 PDF（页数 1，体积用注释行填到 >8KB） */
function makePdf(pages = 1, padTo = 9000) {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const pageObjs = Array.from(
    { length: pages },
    (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
  ).join('');
  let body =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n` +
    pageObjs;
  while (Buffer.byteLength(body, 'latin1') < padTo) body += `% ${'x'.repeat(78)}\n`;
  body += 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
  return Buffer.from(body, 'latin1');
}

test('hasPdfMagic：前 5 字节判定', () => {
  assert.equal(hasPdfMagic(Buffer.from('%PDF-1.7')), true);
  assert.equal(hasPdfMagic(Buffer.from('<!DOCTYPE html>')), false);
  assert.equal(hasPdfMagic(Buffer.from('%PD')), false);
});

test('countPdfPagesFromBuffer：读 /Count 与 /Type /Page', () => {
  assert.equal(countPdfPagesFromBuffer(makePdf(1)), 1);
  assert.equal(countPdfPagesFromBuffer(makePdf(7)), 7);
  assert.equal(countPdfPagesFromBuffer(Buffer.from('<html>nope</html>')), 0);
});

test('assertPdfFile：合格 PDF 通过并返回页数/体积', async () => {
  const f = path.join(tmp, 'ok.pdf');
  const buf = makePdf(3);
  fs.writeFileSync(f, buf);
  const out = await assertPdfFile(f, { minBytes: 8192 });
  assert.equal(out.pageCount, 3);
  assert.equal(out.size, buf.length);
});

test('assertPdfFile：HTML 错误页（体积够但魔数不对）必须拒绝', async () => {
  const f = path.join(tmp, 'error-page.pdf');
  fs.writeFileSync(f, Buffer.from(`<!DOCTYPE html><html><body>${'x'.repeat(20000)}</body></html>`));
  await assert.rejects(() => assertPdfFile(f), (e) => e.code === 'E_NOT_PDF');
});

test('assertPdfFile：体积不足 8KB 必须拒绝（即便魔数正确）', async () => {
  const f = path.join(tmp, 'tiny.pdf');
  fs.writeFileSync(f, makePdf(1, 500));
  await assert.rejects(() => assertPdfFile(f, { minBytes: 8192 }), (e) => e.code === 'E_NOT_PDF');
});

test('assertPdfFile：读不出页数必须拒绝', async () => {
  const f = path.join(tmp, 'nopages.pdf');
  fs.writeFileSync(f, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('%'.padEnd(9000, '.')), Buffer.from('\n%%EOF\n')]));
  await assert.rejects(() => assertPdfFile(f, { minBytes: 8192 }), (e) => e.code === 'E_NOT_PDF');
});
