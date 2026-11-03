/**
 * 导入路由（§8.6 POST /api/import）：mode='dry-run'|'merge'（D2 定案：不再提供全量覆盖模式）。
 */
import { Router } from 'express';
import { AppError } from '../errors.js';
import { importWorks } from '../services/importer.js';

export function importRoutes() {
  const r = Router();

  r.post('/import', (req, res, next) => {
    try {
      const { mode = 'dry-run', path: csvPath } = req.body || {};
      if (!['dry-run', 'merge'].includes(mode)) {
        throw new AppError('E_BAD_REQUEST', "mode 只能是 'dry-run' 或 'merge'（不提供全量覆盖模式）", { mode });
      }
      const report = importWorks({ mode, csvPath });
      // 执行后告知（§9.5 L 层「执行后告知」档）：返回 diff 明细供 UI 展示
      res.json(report);
    } catch (e) {
      next(e);
    }
  });

  return r;
}
