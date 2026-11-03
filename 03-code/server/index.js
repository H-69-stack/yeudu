/**
 * 启动入口（§6）：读配置 → 开库 → 迁移 → 恢复悬挂 job → 校验文件 → 起服务 → 优雅退出。
 * 仅监听 127.0.0.1（§9.5 硬编码，不接受配置）。
 */
import { loadConfig, applyDbSettings, ensureDirs, paths, config } from './config.js';
import { openDb, closeDb, all } from './db.js';
import { migrate } from './migrate.js';
import { initLogger, createLogger, closeLogger } from './logger.js';
import { createApp } from './app.js';
import { bootDownloader, activeDownloadCount } from './services/downloader.js';
import { bootTranslateJobs } from './services/translate/pipeline.js';
import { resyncStorage } from './services/storage.js';

const log = createLogger('server');

async function main() {
  const cfg = loadConfig();
  ensureDirs();
  initLogger({ logDir: paths.logDir, logLevel: cfg.server.logLevel });

  openDb(cfg.server.dbPath);
  const mig = migrate();
  applyDbSettings(all);
  ensureDirs();

  // 启动恢复：悬挂 job 重置为 queued（§9.4）；翻译任务置 paused（等用户点「继续翻译」）
  await bootDownloader();
  const pausedTranslateJobs = bootTranslateJobs();
  if (pausedTranslateJobs) log.warn('translate.reset_paused', { count: pausedTranslateJobs });

  // 启动自检：file_state='present' 的文件是否还在（§22 M1 自愈验收）
  let resync = null;
  try {
    resync = await resyncStorage({});
  } catch (e) {
    log.warn('startup.resync_failed', { message: e.message });
  }

  const app = createApp();
  const server = app.listen(cfg.server.port, '127.0.0.1', () => {
    log.info('server.listen', {
      url: `http://127.0.0.1:${cfg.server.port}/`,
      dbPath: cfg.server.dbPath,
      downloadDir: cfg.download.downloadDir,
      migration: mig,
      resync,
      activeJobs: activeDownloadCount(),
    });
    // 便于本地开发直接看到地址（结构化日志之外的一行提示）
    process.stdout.write(
      `\n  Agent 工作流文献管理系统已启动：http://127.0.0.1:${cfg.server.port}/\n` +
        `  数据库：${cfg.server.dbPath}\n  下载目录：${cfg.download.downloadDir}\n\n`,
    );
  });
  server.on('error', (e) => {
    log.error('server.error', { message: e.message, code: e.code });
    process.exitCode = 1;
  });

  const shutdown = (sig) => {
    log.info('server.shutdown', { sig });
    server.close(() => {
      closeDb();
      closeLogger();
      process.exit(0);
    });
    // 兜底：5s 内没关完就强退
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  // 启动失败必须显式报错退出，不能静默留在半启动状态
  process.stderr.write(`启动失败：${e.stack || e.message}\n`);
  process.exit(1);
});
