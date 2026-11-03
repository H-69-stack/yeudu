/**
 * PDF 结构轻量校验（M1 用；不引入 pdfjs）。
 * 只做两件事：魔数 `%PDF-` 判定、页数估计。
 *
 * 为什么不用 pdfjs 读 pageCount：pdfjs-dist 是 M2（抽取）才引入的依赖（§16.3 / D17），
 * M1 不引入它。页数用确定性结构解析获得：优先 `/Type /Pages` 后代里的 `/Count`，
 * 其次数 `/Type /Page` 对象个数，最后用 `/MediaBox` 出现次数兜底。
 * 这是「宁可拒绝一个可疑文件，也不假装成功」的判定：解析不出页数就返回 0（校验失败）。
 */
import fs from 'node:fs';
import { AppError } from '../../errors.js';

export const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** @param {Buffer} head 文件前若干字节 */
export function hasPdfMagic(head) {
  return head.length >= 5 && head.subarray(0, 5).equals(PDF_MAGIC);
}

/**
 * 从字节块估计页数（不做完整解析）。
 * @param {Buffer} buf
 * @returns {number} 0 表示无法判定
 */
export function countPdfPagesFromBuffer(buf) {
  const text = buf.toString('latin1');
  let pageObjs = 0;
  let maxCount = 0;
  let mediaBoxes = 0;

  const pageRe = /\/Type\s*\/Page(?![sA-Za-z])/g;
  while (pageRe.exec(text) !== null) pageObjs += 1;

  const countRe = /\/Count\s+(\d+)/g;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = countRe.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxCount) maxCount = n;
  }

  const mbRe = /\/MediaBox\s*\[/g;
  while (mbRe.exec(text) !== null) mediaBoxes += 1;

  const pages = Math.max(pageObjs, maxCount);
  if (pages > 0) return pages;
  // 兜底：/MediaBox 通常每个页面对象一个（Pages 根节点也可能带一个，故不做 -1 修正，
  // 这里只用于「至少是不是一页 PDF」的判定）
  return mediaBoxes > 0 ? mediaBoxes : 0;
}

/**
 * 三连校验（唯一实现，下载与手动上传共用）：
 *   ① 前 5 字节 = `%PDF-`　② 页数 ≥ 1　③ 体积 ≥ minBytes
 * 三者同时成立才算「这是一个真 PDF」；HTTP 200 / Content-Type 都不算证据。
 * @param {string} absPath 已通过 assertInScope 的绝对路径
 * @param {{minBytes?:number, url?:string}} [opts]
 * @returns {Promise<{size:number, pageCount:number}>}
 * @throws {AppError} E_NOT_PDF
 */
export async function assertPdfFile(absPath, opts = {}) {
  const minBytes = opts.minBytes ?? 8192;
  const url = opts.url || null;
  const stat = await fs.promises.stat(absPath);
  if (stat.size < minBytes) {
    throw new AppError('E_NOT_PDF', `文件体积 ${stat.size} 字节，小于 ${minBytes} 字节下限（疑似错误页）`, {
      url,
      size: stat.size,
    });
  }
  const fh = await fs.promises.open(absPath, 'r');
  let head;
  try {
    head = Buffer.alloc(5);
    await fh.read(head, 0, 5, 0);
  } finally {
    await fh.close();
  }
  if (!hasPdfMagic(head)) {
    throw new AppError('E_NOT_PDF', `文件头不是 %PDF-（实际：${JSON.stringify(head.toString('latin1'))}）`, {
      url,
      firstBytes: head.toString('latin1'),
    });
  }
  const pageCount = await countPdfPagesFromFile(absPath);
  if (!pageCount || pageCount < 1) {
    throw new AppError('E_NOT_PDF', '无法从 PDF 结构中读出页数（≥1 才算有效 PDF）', { url, size: stat.size });
  }
  return { size: stat.size, pageCount };
}

/**
 * 从文件读页数：只读首尾各几 MB（页面树与 /Count 几乎总在文件前部；
 * 尾部读一段是为了兜住增量更新 / 对象流在末尾的 PDF）。
 * @param {string} absPath
 * @param {{headBytes?:number, tailBytes?:number}} [opts]
 * @returns {Promise<number>} 0 表示无法判定
 */
export async function countPdfPagesFromFile(absPath, opts = {}) {
  const headBytes = opts.headBytes ?? 4 * 1024 * 1024;
  const tailBytes = opts.tailBytes ?? 1024 * 1024;
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    const headLen = Math.min(size, headBytes);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    let pages = countPdfPagesFromBuffer(head);
    if (pages === 0 && size > headLen) {
      const tailLen = Math.min(size - headLen, tailBytes);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      pages = countPdfPagesFromBuffer(tail);
    }
    return pages;
  } finally {
    await fh.close();
  }
}
