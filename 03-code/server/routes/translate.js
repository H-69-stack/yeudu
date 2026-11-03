/**
 * 翻译路由（§8.4）：引擎列表 / 连通性测试 / 试译 / 触发任务 / 任务查询 / SSE / 取消 / 导出双语 Markdown。
 */
import { Router } from 'express';
import { AppError } from '../errors.js';
import { listEngines } from '../services/translate/engines/registry.js';
import {
  startTranslate,
  getTranslateJob,
  streamTranslateEvents,
  cancelTranslateJob,
  testEngine,
  previewTranslate,
  exportMarkdown,
} from '../services/translate/pipeline.js';
import { parseInput, WORK_NO_PATTERN } from '../middleware/validate.js';

export function translateRoutes() {
  const r = Router();

  r.get('/translate/engines', (req, res) => {
    res.json(listEngines());
  });

  r.post('/translate/test', async (req, res, next) => {
    try {
      const body = req.body || {};
      const out = await testEngine({ engine: body.engine, tgtLang: body.tgtLang, sample: body.sample });
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/translate/preview', async (req, res, next) => {
    try {
      const out = await previewTranslate(req.body || {});
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/works/:no/translate', (req, res, next) => {
    try {
      const no = req.params.no;
      if (!WORK_NO_PATTERN.test(String(no || ''))) {
        throw new AppError('E_BAD_REQUEST', `编号格式不合法：${no}`, { field: 'no' });
      }
      const body = req.body || {};
      if (body.scope !== undefined && !['all', 'pages'].includes(body.scope)) {
        throw new AppError('E_BAD_REQUEST', "scope 只能是 'all' 或 'pages'", { field: 'scope' });
      }
      if (body.pages !== undefined && !Array.isArray(body.pages)) {
        throw new AppError('E_BAD_REQUEST', 'pages 必须是整数数组', { field: 'pages' });
      }
      const out = startTranslate(no, {
        engine: body.engine,
        tgtLang: body.tgtLang,
        srcLang: body.srcLang,
        scope: body.scope,
        pages: body.pages,
        anchorPage: body.anchorPage,
        force: body.force === true,
      });
      res.status(out.reused ? 200 : 202).json(out);
    } catch (e) {
      next(e);
    }
  });

  r.get('/jobs/translate/:id', (req, res, next) => {
    try {
      res.json(getTranslateJob(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  r.get('/jobs/translate/:id/events', (req, res, next) => {
    try {
      streamTranslateEvents(Number(req.params.id), res);
    } catch (e) {
      next(e);
    }
  });

  r.post('/jobs/translate/:id/cancel', (req, res, next) => {
    try {
      res.json(cancelTranslateJob(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  r.get('/works/:no/translation/export', (req, res, next) => {
    try {
      const no = req.params.no;
      if (!WORK_NO_PATTERN.test(String(no || ''))) {
        throw new AppError('E_BAD_REQUEST', `编号格式不合法：${no}`, { field: 'no' });
      }
      const bilingual = req.query.bilingual !== '0';
      const { filename, markdown } = exportMarkdown(no, { bilingual });
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(markdown);
    } catch (e) {
      next(e);
    }
  });

  return r;
}
