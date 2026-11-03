/**
 * AI 精排路由：
 *  - POST /api/works/:no/layout           启动精排任务（202 返回 jobId）
 *  - GET  /api/jobs/layout/:id            查询任务状态
 *  - GET  /api/jobs/layout/:id/events     SSE 进度流
 *  - POST /api/jobs/layout/:id/cancel     取消任务
 */
import { Router } from 'express';
import { AppError } from '../errors.js';
import { startLayout, getLayoutJob, streamLayoutEvents, cancelLayoutJob } from '../services/layout/job.js';
import { WORK_NO_PATTERN } from '../middleware/validate.js';

export function layoutRoutes() {
  const r = Router();

  r.post('/works/:no/layout', (req, res, next) => {
    try {
      const no = req.params.no;
      if (!WORK_NO_PATTERN.test(String(no || ''))) {
        throw new AppError('E_BAD_REQUEST', `编号格式不合法：${no}`, { field: 'no' });
      }
      const body = req.body || {};
      const out = startLayout(no, {
        engine: body.engine,
        model: body.model,
        maxPages: body.maxPages ? Number(body.maxPages) : undefined,
      });
      res.status(202).json(out);
    } catch (e) {
      next(e);
    }
  });

  r.get('/jobs/layout/:id', (req, res, next) => {
    try {
      res.json(getLayoutJob(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  r.get('/jobs/layout/:id/events', (req, res, next) => {
    try {
      streamLayoutEvents(Number(req.params.id), res);
    } catch (e) {
      next(e);
    }
  });

  r.post('/jobs/layout/:id/cancel', (req, res, next) => {
    try {
      res.json(cancelLayoutJob(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  return r;
}
