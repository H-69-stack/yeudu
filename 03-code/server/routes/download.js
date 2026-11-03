/**
 * 下载触发路由（§8.3 / §15.2）。
 * 幂等检查顺序：① 文件在位 → 200 alreadyDownloaded ② 有活跃 job → 200 reused ③ 插入 queued。
 */
import { Router } from 'express';
import { createDownload } from '../services/downloader.js';
import { AppError } from '../errors.js';
import { WORK_NO_PATTERN } from '../middleware/validate.js';

export function downloadRoutes() {
  const r = Router();

  r.post('/works/:no/download', (req, res, next) => {
    try {
      const no = req.params.no;
      if (!WORK_NO_PATTERN.test(String(no || ''))) {
        throw new AppError('E_BAD_REQUEST', `编号格式不合法（应为 "段号.序号"）：${no}`, { field: 'no', value: no });
      }
      const body = req.body || {};
      if (body.source !== undefined && !['auto', 'arxiv', 'link'].includes(body.source)) {
        throw new AppError('E_BAD_REQUEST', 'source 只能是 auto/arxiv/link', { field: 'source', value: body.source });
      }
      const { code, body: payload } = createDownload(no, {
        force: body.force === true,
        source: body.source,
      });
      res.status(code).json(payload);
    } catch (e) {
      next(e);
    }
  });

  return r;
}
