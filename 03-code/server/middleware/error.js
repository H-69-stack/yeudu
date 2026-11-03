/**
 * 统一错误出口（§8.1 错误结构 + §12.4 签名）。
 * 所有响应错误都是 { error: { code, message, detail, traceId } }；堆栈只进日志。
 */
import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES, toAppError } from '../errors.js';
import { createLogger } from '../logger.js';

const log = createLogger('error');

/** 请求级 traceId（也写进响应头，便于对照日志） */
export function traceMiddleware(req, res, next) {
  req.traceId = randomUUID().slice(0, 8);
  res.setHeader('X-Trace-Id', req.traceId);
  next();
}

export function notFoundHandler(req, res, next) {
  next(new AppError('E_NOT_FOUND', `接口不存在：${req.method} ${req.path}`, { path: req.path }));
}

// eslint-disable-next-line no-unused-vars
export function errorMiddleware(err, req, res, next) {
  const appErr = toAppError(err);
  const traceId = req.traceId || 'no-trace';
  const isInternal = appErr.code === 'E_INTERNAL';
  if (isInternal || appErr.http >= 500) {
    log.error('request.failed', { traceId, method: req.method, path: req.path, code: appErr.code, message: appErr.message, stack: appErr.stack });
  } else {
    log.warn('request.rejected', { traceId, method: req.method, path: req.path, code: appErr.code, message: appErr.message, detail: appErr.detail });
  }
  if (res.headersSent) {
    // SSE / 流式响应中途出错：只能断流，不能改状态码
    try {
      res.end();
    } catch {
      /* 已断开 */
    }
    return;
  }
  const http = ERROR_CODES[appErr.code] ? ERROR_CODES[appErr.code].http : 500;
  res.status(http).json({
    error: {
      code: appErr.code,
      message: appErr.message || ERROR_CODES[appErr.code]?.message || '服务端异常',
      detail: isInternal ? null : appErr.detail ?? null,
      traceId,
    },
  });
}
