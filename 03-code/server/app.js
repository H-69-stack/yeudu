/**
 * Express 组装（§9.5 拦截点：security → json(1mb) → routes → error）。
 * 中间件顺序不可随意调整：Host/Origin/Content-Type 校验必须在业务之前。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { securityMiddleware } from './middleware/security.js';
import { traceMiddleware, notFoundHandler, errorMiddleware } from './middleware/error.js';
import { rateLimit } from './middleware/ratelimit.js';
import { healthRoutes } from './routes/health.js';
import { worksRoutes } from './routes/works.js';
import { downloadRoutes } from './routes/download.js';
import { jobsRoutes } from './routes/jobs.js';
import { assetsRoutes } from './routes/assets.js';
import { settingsRoutes } from './routes/settings.js';
import { importRoutes } from './routes/import.js';
import { segmentRoutes } from './routes/segments.js';
import { translateRoutes } from './routes/translate.js';
import { layoutRoutes } from './routes/layout.js';
import { chatRoutes } from './routes/chat.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const WEB_DIR = path.resolve(APP_ROOT, 'web');
// 浏览器直传脚本：保持「磁盘上唯一一份」，网页上的「批量采集」按钮靠这个地址一键安装/更新
const USERSCRIPT = path.resolve(APP_ROOT, 'userscript', 'lit-uploader.user.js');

export function createApp() {
  const port = config.server.port;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(traceMiddleware);
  app.use(
    securityMiddleware({
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`],
      allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      // 手动上传走 multipart / 裸 PDF，属于 Content-Type 强制的显式例外
      allowMultipartPaths: [/^\/api\/works\/[^/]+\/asset$/, /^\/api\/chats\/[^/]+\/attachments$/],
    }),
  );
  app.use(rateLimit({ capacity: 120, refillPerMinute: 120 }));
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  api.use(healthRoutes());
  api.use(worksRoutes());
  api.use(downloadRoutes());
  api.use(jobsRoutes());
  api.use(assetsRoutes());
  api.use(settingsRoutes());
  api.use(importRoutes());
  api.use(segmentRoutes());
  api.use(translateRoutes());
  api.use(layoutRoutes());
  api.use(chatRoutes());
  app.use('/api', api);

  // 浏览器直传脚本（Tampermonkey 认 .user.js 后缀；必须在静态挂载之前，且只读这一个文件）
  app.get('/lit-uploader.user.js', (_req, res, next) => {
    fs.readFile(USERSCRIPT, 'utf8')
      .then((code) => {
        const ver = (code.match(/@version\s+([^\r\n]+)/) || [, 'unknown'])[1].trim();
        res.set('Content-Type', 'text/javascript; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.set('X-Userscript-Version', ver);
        res.send(code);
      })
      .catch(next);
  });

  // 前端静态资源（零构建，原生 JS）
  app.use(express.static(WEB_DIR, { index: 'index.html', extensions: ['html'], maxAge: 0 }));

  app.use(notFoundHandler);
  app.use(errorMiddleware);
  return app;
}

export { WEB_DIR };
