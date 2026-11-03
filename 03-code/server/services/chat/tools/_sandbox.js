/**
 * 存储区路径作用域（对齐 dsh 的 sandbox/workspace-root 思路：`fs.resolve` 一律先落回工作区根）。
 *
 * 本项目的「工作区根」= 文库 PDF 存储目录（`config.download.downloadDir`）。
 * 任何**由模型提供、指向磁盘**的值（文献编号 → 相对路径 → 绝对路径）都必须过这里：
 * 越界即抛错，不做「尽力而为」的拼接。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../config.js';

/** 规范路径分隔符（Windows 也用 `/` 比较） */
const norm = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();

/**
 * 判断 child 是否落在 root 内（含 root 自身）。
 * @param {string} root
 * @param {string} child
 */
export function isWithin(root, child) {
  const r = norm(root);
  const c = norm(child);
  return c === r || c.startsWith(`${r}/`);
}

/**
 * 把「存储根 + 资产相对路径」解析成绝对路径并做越界校验。
 * @param {string} relPath assets.storage_rel_path
 * @returns {string} 绝对路径
 */
export function resolveStoragePath(relPath) {
  const root = path.resolve(config.download.downloadDir);
  const rel = String(relPath || '');
  if (!rel) throw new Error('资产缺少 storage_rel_path');
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Error(`非法的资产相对路径：${rel}`);
  }
  const abs = path.resolve(root, rel);
  if (!isWithin(root, abs)) throw new Error(`资产路径越出存储根：${rel}`);
  return abs;
}

/**
 * 存在性 + 越界的组合校验（工具层用）。
 * @returns {{abs:string, exists:boolean, bytes:number|null}}
 */
export function statStoragePath(relPath) {
  const abs = resolveStoragePath(relPath);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch {
    st = null;
  }
  return { abs, exists: Boolean(st && st.isFile()), bytes: st ? st.size : null };
}
