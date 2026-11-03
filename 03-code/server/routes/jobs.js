/**
 * 任务查询与操作路由（§8.3）：下载任务的列表/详情/重试/取消。
 */
import { Router } from 'express';
import { listJobs, getJob, retryJob, cancelJob } from '../services/downloader.js';
import { parseInput } from '../middleware/validate.js';

const JOB_STATUSES = ['queued', 'resolving', 'downloading', 'verifying', 'done', 'failed', 'needs_manual', 'canceled'];

export function jobsRoutes() {
  const r = Router();

  r.get('/jobs/download', (req, res, next) => {
    try {
      const p = parseInput(
        {
          status: { type: 'enum', enum: JOB_STATUSES },
          limit: { type: 'int', min: 1, max: 200, default: 20 },
        },
        req.query,
      );
      res.json(listJobs(p));
    } catch (e) {
      next(e);
    }
  });

  r.get('/jobs/download/:id', (req, res, next) => {
    try {
      res.json(getJob(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  r.post('/jobs/download/:id/retry', (req, res, next) => {
    try {
      res.status(202).json(retryJob(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  r.post('/jobs/download/:id/cancel', (req, res, next) => {
    cancelJob(Number(req.params.id))
      .then((out) => res.json(out))
      .catch(next);
  });

  return r;
}
