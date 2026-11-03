/**
 * 健康检查（§8.2）。
 * `downloadDirWritable` 是 M1 验收项之一：起服务后必须为 true。
 */
import { Router } from 'express';
import { get } from '../db.js';
import { config, isDirWritable, paths } from '../config.js';
import { activeDownloadCount } from '../services/downloader.js';

export function healthRoutes() {
  const r = Router();
  r.get('/health', (req, res) => {
    const missingAssets = get("SELECT count(*) AS n FROM assets WHERE file_state='missing'").n;
    res.json({
      ok: true,
      version: '1.0.0-m1',
      dbDriver: 'node:sqlite',
      dbPath: config.server.dbPath,
      rootDir: paths.root,
      downloadDir: config.download.downloadDir,
      downloadDirWritable: isDirWritable(config.download.downloadDir),
      missingAssets,
      activeJobs: activeDownloadCount(),
      works: get('SELECT count(*) AS n FROM works WHERE retired = 0').n,
    });
  });
  return r;
}
