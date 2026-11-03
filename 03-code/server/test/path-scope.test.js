/**
 * 路径白名单（§9.5）：越界必须抛 E_PATH_OUT_OF_SCOPE。
 * 这是 M1 自测第 7 项的直接覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, config, paths } from '../config.js';
import { assertInScope, buildRelPath } from '../services/storage.js';

loadConfig();

test('允许：downloadDir 下的文件名', () => {
  const rel = buildRelPath({ no: '4.4', title: 'A Survey' });
  const abs = path.resolve(config.download.downloadDir, rel);
  assert.equal(assertInScope(abs), abs);
});

test('允许：相对路径按项目根解析后仍在白名单内', () => {
  const out = assertInScope('storage/pdfs/x.pdf');
  assert.ok(out.startsWith(paths.storageDir) || out.toLowerCase().includes('storage'));
});

test('拒绝：含 ".." 的路径穿越（../../config.local.json）', () => {
  assert.throws(
    () => assertInScope(path.resolve(config.download.downloadDir, '../../config.local.json')),
    (e) => e.code === 'E_PATH_OUT_OF_SCOPE',
  );
});

test('拒绝：白名单之外的绝对路径', () => {
  const outside = process.platform === 'win32' ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/passwd';
  assert.throws(
    () => assertInScope(outside),
    (e) => e.code === 'E_PATH_OUT_OF_SCOPE',
  );
  assert.throws(
    () => assertInScope(path.join(paths.root, 'package.json')),
    (e) => e.code === 'E_PATH_OUT_OF_SCOPE',
  );
});

test('拒绝：空路径与 NUL 字节', () => {
  assert.throws(() => assertInScope(''), (e) => e.code === 'E_PATH_OUT_OF_SCOPE');
  assert.throws(() => assertInScope('storage/pdfs/a\u0000.pdf'), (e) => e.code === 'E_PATH_OUT_OF_SCOPE');
});

test('拒绝：白名单根目录的兄弟目录（前缀相同但不是子路径）', () => {
  // data-evil 与 data 前缀相同，但不是 data 的子路径 → 必须拒绝
  const sibling = path.join(paths.root, 'data-evil', 'x.pdf');
  assert.throws(() => assertInScope(sibling), (e) => e.code === 'E_PATH_OUT_OF_SCOPE');
  // 反例对照：storage 的任何子目录都是允许的（inbox / tmp / pdfs 都在里面）
  assert.ok(assertInScope(path.join(paths.storageDir, 'pdfs-evil', 'x.pdf')));
});
