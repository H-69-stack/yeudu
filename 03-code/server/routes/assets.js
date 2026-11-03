/**
 * 文件服务路由（§8.3）：
 *  - GET  /assets/:id/file      支持 Range（206），Content-Type: application/pdf
 *  - POST /assets/:id/reveal    在系统文件管理器中定位
 *  - POST /works/:no/asset      手动上传（multipart 或裸 application/pdf）
 *  - POST /assets/scan-inbox    扫描 storage/inbox/
 *  - POST /assets/import-from-inbox 确认把 inbox 里某个文件入到指定条目
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import express from 'express';
import { get, run } from '../db.js';
import { AppError } from '../errors.js';
import { config, paths } from '../config.js';
import {
  assertInScope,
  assertInDownloadDir,
  absFromRel,
  commitAtomic,
  tmpDir,
  resolveAssetTarget,
  revealInOs,
  scanInbox,
  sha256File,
} from '../services/storage.js';
import { assertPdfFile } from '../services/pdf/meta.js';
import { commitAsset } from '../services/downloader.js';
import { getWorkRow } from '../services/artworks.js';
import { WORK_NO_PATTERN } from '../middleware/validate.js';
import { createLogger } from '../logger.js';

const log = createLogger('assets');

/** 解析 `Range: bytes=a-b`；返回 null 表示按整文件返回 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start = hasStart ? Number(m[1]) : null;
  let end = hasEnd ? Number(m[2]) : null;
  if (start === null) {
    // bytes=-N：最后 N 字节
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null) {
    end = size - 1;
  }
  if (end >= size) end = size - 1;
  if (start > end || start < 0) return { invalid: true };
  return { start, end };
}

/** 从 multipart body 中取出 name="file" 的二进制内容 */
export function extractMultipartFile(body, contentType) {
  const mb = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!mb) return null;
  const boundary = (mb[1] || mb[2]).trim();
  const sep = Buffer.from(`--${boundary}`, 'latin1');
  const parts = [];
  let cursor = body.indexOf(sep);
  while (cursor >= 0) {
    cursor += sep.length;
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '--') break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    const next = body.indexOf(sep, cursor);
    if (next < 0) break;
    let partEnd = next;
    if (body[partEnd - 2] === 13 && body[partEnd - 1] === 10) partEnd -= 2;
    const raw = body.subarray(cursor, partEnd);
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      parts.push({
        headers: raw.subarray(0, headerEnd).toString('utf8'),
        data: raw.subarray(headerEnd + 4),
      });
    }
    cursor = next;
  }
  for (const p of parts) {
    if (/name="file"/i.test(p.headers) || /filename=/i.test(p.headers)) return p;
  }
  return null;
}

export function assetsRoutes() {
  const r = Router();

  // ── 文件流（Range 支持）────────────────────────────────────────────
  r.get('/assets/:id/file', (req, res, next) => {
    try {
      const asset = get('SELECT * FROM assets WHERE id = ?', [Number(req.params.id)]);
      if (!asset) throw new AppError('E_NOT_FOUND', `资产不存在：${req.params.id}`, { assetId: req.params.id });
      if (!asset.storage_rel_path) throw new AppError('E_NOT_FOUND', '该资产还没有本地文件', { assetId: asset.id });

      let abs;
      try {
        abs = absFromRel(asset.storage_rel_path);
      } catch (e) {
        // 路径越界 → 记录并拒绝（不返回文件内容）
        log.warn('file.path_rejected', { assetId: asset.id, relPath: asset.storage_rel_path });
        throw e;
      }
      if (!fsSync.existsSync(abs)) {
        run("UPDATE assets SET file_state='missing', missing_since=?, updated_at=? WHERE id=?", [
          Date.now(),
          Date.now(),
          asset.id,
        ]);
        res.setHeader('X-File-State', 'missing');
        res.status(410).json({
          error: {
            code: 'E_NOT_FOUND',
            message: '文件不在了（可能被移动或删除）',
            detail: { assetId: asset.id, relPath: asset.storage_rel_path },
            traceId: req.traceId,
          },
        });
        return;
      }

      const stat = fsSync.statSync(abs);
      const range = parseRange(req.headers.range, stat.size);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      if (asset.file_sha256) res.setHeader('ETag', `"${asset.file_sha256.slice(0, 16)}"`);

      if (range && range.invalid) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.status(416).end();
        return;
      }
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        res.setHeader('Content-Length', range.end - range.start + 1);
        fsSync.createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
        return;
      }
      res.status(200);
      res.setHeader('Content-Length', stat.size);
      fsSync.createReadStream(abs).pipe(res);
    } catch (e) {
      next(e);
    }
  });

  // ── 在资源管理器中定位 ─────────────────────────────────────────────
  r.post('/assets/:id/reveal', async (req, res, next) => {
    try {
      const asset = get('SELECT * FROM assets WHERE id = ?', [Number(req.params.id)]);
      if (!asset || !asset.storage_rel_path) {
        throw new AppError('E_NOT_FOUND', `资产不存在或没有本地文件：${req.params.id}`, { assetId: req.params.id });
      }
      const abs = absFromRel(asset.storage_rel_path);
      if (!fsSync.existsSync(abs)) {
        throw new AppError('E_NOT_FOUND', '文件不在了（可能被移动或删除）', { assetId: asset.id });
      }
      const out = await revealInOs(abs);
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // ── 手动上传（multipart 或裸 PDF）──────────────────────────────────
  r.post(
    '/works/:no/asset',
    express.raw({ type: ['multipart/form-data', 'application/pdf'], limit: config.download.maxBytes + 8 * 1024 * 1024 }),
    async (req, res, next) => {
      try {
        const no = req.params.no;
        if (!WORK_NO_PATTERN.test(String(no || ''))) {
          throw new AppError('E_BAD_REQUEST', `编号格式不合法：${no}`, { field: 'no', value: no });
        }
        const work = getWorkRow(no);
        if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          throw new AppError('E_BAD_REQUEST', '未收到文件内容（需要 multipart 的 file 字段或 application/pdf 原始体）');
        }
        const ct = String(req.headers['content-type'] || '');
        let data = body;
        let filename = '';
        if (ct.startsWith('multipart/form-data')) {
          const part = extractMultipartFile(body, ct);
          if (!part) throw new AppError('E_BAD_REQUEST', 'multipart 里没有 file 字段');
          data = part.data;
          const fm = /filename="([^"]*)"/i.exec(part.headers);
          filename = fm ? fm[1] : '';
        }
        if (data.length > config.download.maxBytes) {
          throw new AppError('E_TOO_LARGE', `上传 ${data.length} 字节，超过上限 ${config.download.maxBytes}`);
        }

        // ① 目标名一律服务端生成（客户端 filename 只用于日志；恶意名直接 403）
        // ② 落盘路径必须落在 downloadDir 内部（storage/ 其它子目录也不行）
        const target = resolveAssetTarget({ work, clientFilename: filename });
        // ③ 一文献一份：已有 asset 且未 force → 409（带现有 assetId）
        const force = req.query.force === '1' || req.query.force === 'true';
        const existing = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
        if (existing && existing.file_state === 'present' && !force) {
          throw new AppError('E_CONFLICT', '该条目已有本地 PDF；如需替换请带 ?force=1', {
            assetId: existing.id,
            storageRelPath: existing.storage_rel_path,
            fileSize: existing.file_size,
          });
        }

        const partAbs = assertInScope(path.join(tmpDir(), `upload-${Date.now().toString(36)}.part`));
        await fs.writeFile(partAbs, data);
        let verdict;
        try {
          verdict = await assertPdfFile(partAbs, {
            minBytes: config.download.minPdfBytes || 8192,
            url: `upload:${filename || no}`,
          });
        } catch (e) {
          await fs.rm(partAbs, { force: true }).catch(() => {});
          throw e;
        }
        const sha = await sha256File(partAbs);
        // 内容完全一样 → 不折腾（不重写、不删旧文件），直接返回现有 asset
        if (existing && existing.file_sha256 && existing.file_sha256 === sha) {
          await fs.rm(partAbs, { force: true }).catch(() => {});
          log.info('asset.upload_same_content', { no, assetId: existing.id, bytes: verdict.size });
          res.status(200).json({
            assetId: existing.id,
            pageCount: existing.page_count || verdict.pageCount,
            fileSize: existing.file_size || verdict.size,
            replaced: false,
            sameContent: true,
          });
          return;
        }

        await commitAtomic(partAbs, target.absPath);
        // 换了文件名（标题改过）→ 删旧文件，避免两份物理文件
        if (existing && existing.storage_rel_path && existing.storage_rel_path !== target.relPath) {
          try {
            await fs.rm(assertInDownloadDir(path.resolve(config.download.downloadDir, existing.storage_rel_path)), { force: true });
          } catch (e) {
            log.warn('asset.old_file_remove_failed', { no, oldRelPath: existing.storage_rel_path, message: e.message });
          }
        }
        const assetId = commitAsset({
          workId: work.id,
          relPath: target.relPath,
          result: { bytes: verdict.size, sha256: sha, pageCount: verdict.pageCount },
          source: 'manual',
          sourceUrl: null,
        });
        log.info('asset.uploaded', {
          no,
          assetId,
          bytes: verdict.size,
          pageCount: verdict.pageCount,
          relPath: target.relPath,
          clientFilename: filename || null,
          ignoredClientName: target.ignoredClientName,
          replaced: Boolean(existing),
        });
        res.status(existing ? 200 : 201).json({
          assetId,
          pageCount: verdict.pageCount,
          fileSize: verdict.size,
          relPath: target.relPath,
          replaced: Boolean(existing),
        });
      } catch (e) {
        next(e);
      }
    },
  );

  // ── 收件箱扫描 ─────────────────────────────────────────────────────
  r.post('/assets/scan-inbox', async (req, res, next) => {
    try {
      const out = await scanInbox();
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/assets/import-from-inbox', async (req, res, next) => {
    try {
      const { no, file } = req.body || {};
      if (!no || !file) throw new AppError('E_BAD_REQUEST', '需要 no 与 file 两个字段');
      if (!WORK_NO_PATTERN.test(String(no))) throw new AppError('E_BAD_REQUEST', `编号格式不合法：${no}`);
      if (String(file).includes('..') || String(file).includes('/') || String(file).includes('\\')) {
        throw new AppError('E_PATH_OUT_OF_SCOPE', '文件名不能包含路径分隔符', { file });
      }
      const work = getWorkRow(no);
      if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });
      const srcAbs = assertInScope(path.join(paths.inboxDir, String(file)));
      if (!fsSync.existsSync(srcAbs)) throw new AppError('E_NOT_FOUND', `收件箱里没有该文件：${file}`, { file });

      // 目标名同样由服务端生成，且必须落在 downloadDir 内部（与上传共用同一条出口）
      const target = resolveAssetTarget({ work, clientFilename: '' });
      const force = req.body && (req.body.force === true || req.body.force === '1');
      const existing = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
      if (existing && existing.file_state === 'present' && !force) {
        throw new AppError('E_CONFLICT', '该条目已有本地 PDF；如需替换请带 force=true', {
          assetId: existing.id,
          storageRelPath: existing.storage_rel_path,
        });
      }
      const relPath = target.relPath;
      const partAbs = assertInScope(path.join(tmpDir(), `inbox-${Date.now().toString(36)}.part`));
      await fs.copyFile(srcAbs, partAbs);
      let verdict;
      try {
        verdict = await assertPdfFile(partAbs, { minBytes: config.download.minPdfBytes || 8192, url: `inbox:${file}` });
      } catch (e) {
        await fs.rm(partAbs, { force: true }).catch(() => {});
        throw e;
      }
      const sha = await sha256File(partAbs);
      await commitAtomic(partAbs, target.absPath);
      if (existing && existing.storage_rel_path && existing.storage_rel_path !== relPath) {
        await fs
          .rm(assertInDownloadDir(path.resolve(config.download.downloadDir, existing.storage_rel_path)), { force: true })
          .catch(() => {});
      }
      const assetId = commitAsset({
        workId: work.id,
        relPath,
        result: { bytes: verdict.size, sha256: sha, pageCount: verdict.pageCount },
        source: 'inbox',
        sourceUrl: null,
      });
      log.info('asset.from_inbox', { no, assetId, file, bytes: verdict.size });
      res.status(201).json({ assetId, pageCount: verdict.pageCount, fileSize: verdict.size, relPath });
    } catch (e) {
      next(e);
    }
  });

  return r;
}

