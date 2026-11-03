/**
 * 设置与维护路由（§8.6）。
 * 密钥只写不读：GET /settings 永远返回掩码（§9.5 密钥出口）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { run, all } from '../db.js';
import { AppError } from '../errors.js';
import {
  config,
  settingsView,
  applyDbSettings,
  writeSecrets,
  isSettableKey,
  isDirWritable,
  setRuntimeDownloadDir,
} from '../config.js';
import { resyncStorage } from '../services/storage.js';
import { getStats } from '../services/artworks.js';
import { createLogger } from '../logger.js';

const log = createLogger('settings');

const FORBIDDEN_KEYS = new Set(['server.port', 'server.dbPath', 'download.downloadDir']);

function persistSetting(key, value) {
  run(
    `INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, typeof value === 'string' ? value : JSON.stringify(value), Date.now()],
  );
}

export function settingsRoutes() {
  const r = Router();

  r.get('/settings', (req, res) => {
    res.json(settingsView());
  });

  r.put('/settings', (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('E_BAD_REQUEST', '需要 JSON 对象（扁平或嵌套均可）');
      }
      const flat = {};
      const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
          else flat[key] = v;
        }
      };
      walk(body, '');
      const ignored = [];
      let applied = 0;
      for (const [key, value] of Object.entries(flat)) {
        if (FORBIDDEN_KEYS.has(key) || !isSettableKey(key)) {
          ignored.push(key);
          continue;
        }
        persistSetting(key, value);
        applied += 1;
      }
      applyDbSettings(all);
      if (ignored.length) log.warn('settings.ignored_keys', { ignored });
      res.json({ ...settingsView(), applied, ignored });
    } catch (e) {
      next(e);
    }
  });

  r.put('/settings/secret', (req, res, next) => {
    try {
      const body = req.body || {};
      const patch = { providers: {}, engines: {}, download: {} };
      if (body.llm && typeof body.llm === 'object') {
        const provider = body.llm.provider || config.chat.provider;
        const entry = {};
        if (typeof body.llm.apiKey === 'string') entry.apiKey = body.llm.apiKey.trim();
        if (typeof body.llm.baseUrl === 'string') entry.baseUrl = body.llm.baseUrl.trim();
        if (Object.keys(entry).length) patch.providers[provider] = entry;
      }
      if (body.providers && typeof body.providers === 'object') {
        for (const [id, p] of Object.entries(body.providers)) {
          if (!p || typeof p !== 'object') continue;
          patch.providers[id] = {
            ...(typeof p.apiKey === 'string' ? { apiKey: p.apiKey.trim() } : {}),
            ...(typeof p.baseUrl === 'string' ? { baseUrl: p.baseUrl.trim() } : {}),
          };
        }
      }
      if (body.engines && typeof body.engines === 'object') {
        for (const [id, e] of Object.entries(body.engines)) {
          if (e && typeof e.apiKey === 'string') patch.engines[id] = { apiKey: e.apiKey.trim() };
        }
      }
      if (body.download && typeof body.download.unpaywallEmail === 'string') {
        patch.download.unpaywallEmail = body.download.unpaywallEmail.trim();
      }
      writeSecrets(patch);
      log.info('settings.secret_updated', { providers: Object.keys(patch.providers), engines: Object.keys(patch.engines) });
      res.json({ ok: true, llm: settingsView().llm });
    } catch (e) {
      next(e);
    }
  });

  r.put('/settings/downloadDir', async (req, res, next) => {
    try {
      const body = req.body || {};
      const target = body.path;
      const mode = body.mode || 'switch';
      if (!target || typeof target !== 'string') throw new AppError('E_BAD_REQUEST', '需要 path 字段');
      if (!path.isAbsolute(target)) {
        throw new AppError('E_BAD_REQUEST', 'downloadDir 必须是绝对路径（避免相对路径解析歧义）', { path: target });
      }
      if (mode === 'migrate') {
        // M1 不做目录迁移（要逐个 rename 数百个文件 + 后台 job），如实拒绝而不是假装成功
        throw new AppError('E_BAD_REQUEST', 'M1 未实现目录迁移（migrate）；请用 switch 模式并手动移动文件', { mode });
      }
      if (mode !== 'switch') throw new AppError('E_BAD_REQUEST', "mode 只能是 'switch'", { mode });
      fs.mkdirSync(target, { recursive: true });
      if (!isDirWritable(target)) throw new AppError('E_CONFLICT', `目标目录不可写：${target}`, { path: target });
      const previous = config.download.downloadDir;
      const resolved = setRuntimeDownloadDir(target);
      persistSetting('download.downloadDir', resolved);
      const report = await resyncStorage({});
      log.info('settings.download_dir_switched', { from: previous, to: resolved });
      res.json({
        ok: true,
        previous,
        downloadDir: resolved,
        resync: { present: report.present, missing: report.missing, orphan: report.orphan },
      });
    } catch (e) {
      next(e);
    }
  });

  r.post('/storage/resync', async (req, res, next) => {
    try {
      const report = await resyncStorage({ deep: Boolean(req.body && req.body.deep) });
      res.json(report);
    } catch (e) {
      next(e);
    }
  });

  r.get('/stats', (req, res) => {
    res.json({ ...getStats(), config: { downloadDir: config.download.downloadDir, port: config.server.port } });
  });

  return r;
}
