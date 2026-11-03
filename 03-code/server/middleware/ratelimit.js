/**
 * 入站令牌桶（§19 第 11 条）：单机单用户，只为防前端 bug 打爆自己。
 * 默认 60 req/min；超限返回 E_RATE_LIMITED。
 */
import { AppError } from '../errors.js';

/**
 * @param {{capacity?:number, refillPerMinute?:number}} [opts]
 */
export function rateLimit(opts = {}) {
  const capacity = opts.capacity ?? 60;
  const refillPerMs = (opts.refillPerMinute ?? 60) / 60000;
  let tokens = capacity;
  let last = Date.now();

  return function limiter(req, res, next) {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + (now - last) * refillPerMs);
    last = now;
    if (tokens < 1) {
      return next(new AppError('E_RATE_LIMITED', '本机请求过于频繁，请稍后重试', { capacity }));
    }
    tokens -= 1;
    return next();
  };
}
