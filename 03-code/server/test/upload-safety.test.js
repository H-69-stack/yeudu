/**
 * 上传/入库的目标路径安全（P0 缺陷回归）：
 *  ① 客户端文件名不可信 → 恶意名直接拒绝，正常名也被忽略（目标名服务端生成）
 *  ② 目标路径必须落在 downloadDir 内部（storage/ 其它子目录也不行）
 *  ③ 生成的名字必须严格是 `<no>__<slug>.pdf`，slug 只含 [a-z0-9-] 或 zh+hash
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, config, paths } from '../config.js';
import { resolveAssetTarget, detectUnsafeFilename, assertInDownloadDir, buildRelPath } from '../services/storage.js';

loadConfig();

const work = { no: '4.6', title: 'Levels of AGI for Operationalizing Progress' };

test('恶意文件名：../ / 绝对路径 / UNC / 编码穿越 全部拒绝', () => {
  const evil = [
    '4.6__../../../tmp-escape.pdf',
    '../../etc/passwd',
    '/abs/path.pdf',
    'C://Windows//evil.pdf',
    '\\\\\\\\server\\\\share\\\\evil.pdf',
    '..%2f..%2fescape.pdf',
    '%2e%2e/escape.pdf',
    'a\u0000b.pdf',
  ];
  for (const name of evil) {
    assert.throws(
      () => resolveAssetTarget({ work, clientFilename: name }),
      (e) => e.code === 'E_PATH_OUT_OF_SCOPE',
      `应拒绝：${name}`,
    );
  }
});

test('detectUnsafeFilename：恶意原因可分类（便于日志/审计）', () => {
  assert.equal(detectUnsafeFilename('4.6__../../x.pdf'), 'dot-dot');
  assert.equal(detectUnsafeFilename('a/b.pdf'), 'path-separator');
  assert.equal(detectUnsafeFilename('C:/x.pdf'), 'drive-letter');
  // 编码穿越优先归到更具体的类别（审计时能区分「明文 ..」与「编码 ..」）
  assert.equal(detectUnsafeFilename('..%2fescape.pdf'), 'percent-encoded-traversal');
  assert.equal(detectUnsafeFilename('normal-file.pdf'), null);
  assert.equal(detectUnsafeFilename(''), null);
});

test('正常文件名也被忽略：目标名由服务端按 <no>__<slug>.pdf 生成', () => {
  const t = resolveAssetTarget({ work, clientFilename: '9.9__ghost-shared.pdf' });
  assert.ok(t.relPath.startsWith('4.6__'), `实际：${t.relPath}`);
  assert.ok(!t.relPath.includes('ghost-shared'), '不能沿用客户端给的名字');
  assert.equal(t.ignoredClientName, true);
  assert.match(t.relPath, /^\d+\.\d+__[a-z0-9-]{1,80}\.pdf$/);
});

test('目标绝对路径必须位于 downloadDir 内部', () => {
  const t = resolveAssetTarget({ work });
  const root = path.resolve(config.download.downloadDir);
  assert.ok(t.absPath.toLowerCase().startsWith(root.toLowerCase() + path.sep), `${t.absPath} 应在 ${root} 下`);
});

test('assertInDownloadDir：storage/ 其它子目录（inbox/tmp）也不行', () => {
  assert.throws(
    () => assertInDownloadDir(path.join(paths.inboxDir, 'x.pdf')),
    (e) => e.code === 'E_PATH_OUT_OF_SCOPE',
  );
  assert.throws(
    () => assertInDownloadDir(path.join(paths.root, 'storage', 'tmp-escape.pdf')),
    (e) => e.code === 'E_PATH_OUT_OF_SCOPE',
  );
});

test('slug 严格 sanitize：只保留 [a-z0-9-]，长度 ≤ 80', () => {
  const evilTitle = work.title + ' ../../etc/passwd 中文标题 ' + 'x'.repeat(200);
  const rel = buildRelPath({ no: '4.6', title: evilTitle });
  const slug = rel.replace(/^4\.6__/, '').replace(/\.pdf$/, '');
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.ok(slug.length <= 80, `slug 长度 ${slug.length}`);
  assert.ok(!rel.includes('..'));
});

test('非拉丁标题：slug 退化为 zh+hash，仍满足命名规则', () => {
  const rel = buildRelPath({ no: '7.2', title: '面向大模型的工作流编排' });
  assert.match(rel, /^7\.2__zh[0-9a-f]{8}\.pdf$/);
  assert.ok(resolveAssetTarget({ work: { no: '7.2', title: '面向大模型的工作流编排' } }).absPath.length > 0);
});
