/**
 * 安全中间件（§9.5 L 层，M1 必做）：
 *  1. Host 头白名单 —— 防 DNS rebinding
 *  2. Origin/Referer 校验 —— 防跨站打本机 API（无 Cookie，故用无状态 + Origin）
 *  3. 写接口 Content-Type 强制 application/json —— 防 CSRF 简单请求
 *  4. SSRF 预检工具（出站 URL scheme + 解析后 IP 段），下载器逐跳调用
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';

const log = createLogger('security');

/**
 * @param {{allowedHosts:string[], allowedOrigins:string[], allowMultipartPaths?:RegExp[]}} opts
 * @returns {(req:any,res:any,next:any)=>void}
 */
export function securityMiddleware(opts) {
  const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const origins = new Set(opts.allowedOrigins.map((o) => o.toLowerCase()));
  const allowMultipartPaths = opts.allowMultipartPaths || [];

  return function security(req, res, next) {
    // 1) Host 头白名单
    const host = String(req.headers.host || '').toLowerCase();
    if (!hosts.has(host)) {
      log.warn('host.rejected', { host, path: req.path });
      return next(new AppError('E_PATH_OUT_OF_SCOPE', `Host 头不被允许：${host || '(空)'}（服务仅接受 127.0.0.1/localhost）`));
    }

    const method = req.method.toUpperCase();
    const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

    if (isWrite) {
      // 2) Origin / Referer 校验
      const origin = req.headers.origin ? String(req.headers.origin).toLowerCase() : '';
      const referer = req.headers.referer ? String(req.headers.referer).toLowerCase() : '';
      if (origin) {
        if (!origins.has(origin)) {
          log.warn('origin.rejected', { origin, path: req.path });
          return next(new AppError('E_PATH_OUT_OF_SCOPE', `Origin 不被允许：${origin}`));
        }
      } else if (referer) {
        const refOrigin = safeOrigin(referer);
        if (!refOrigin || !origins.has(refOrigin)) {
          log.warn('referer.rejected', { referer, path: req.path });
          return next(new AppError('E_PATH_OUT_OF_SCOPE', `Referer 不被允许：${referer}`));
        }
      }
      // 无 Origin（curl / 本机脚本）→ 放行：浏览器跨站写请求必然带 Origin，已在上一步拦掉

      // 3) Content-Type 强制（DELETE 无 body，不校验）
      if (method !== 'DELETE') {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        // 白名单路径上的上传：接受 multipart 与「裸体原始字节」（图片/PDF/纯文本）。
        // 必须与 routes/chat.js 的 express.raw(type) 列表一致，否则裸体 image/* 会被误拒。
        const onUploadPath = allowMultipartPaths.some((re) => re.test(req.path));
        const isUpload = onUploadPath && (
          ct.startsWith('multipart/form-data') ||
          ct.startsWith('image/') ||
          ct.startsWith('application/pdf') ||
          ct.startsWith('text/plain') ||
          ct.startsWith('text/markdown')
        );
        if (!ct.startsWith('application/json') && !isUpload) {
          return next(new AppError('E_BAD_REQUEST', `写接口必须使用 application/json（收到 ${ct || '空'}）`, { contentType: ct }));
        }
      }
    }

    return next();
  };
}

function safeOrigin(urlText) {
  try {
    const u = new URL(urlText);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** 私网 / 保留地址判定（IPv4 + IPv6 常见段） */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80')) return true; // 链路本地
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // 解析不出的一律拒绝
}

/**
 * SSRF 预检：scheme 必须 http(s)，且解析后的所有 IP 都不能是私网/保留地址。
 * 下载器每一跳重定向都要重新调用（§9.5：只在入口校验一次是不够的）。
 * @param {string} urlText
 * @returns {Promise<URL>}
 * @throws {AppError} E_SSRF_BLOCKED
 */
export async function assertUrlSafe(urlText) {
  let u;
  try {
    u = new URL(urlText);
  } catch {
    throw new AppError('E_SSRF_BLOCKED', `不是合法 URL：${urlText}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError('E_SSRF_BLOCKED', `只允许 http/https（收到 ${u.protocol}）`, { url: urlText });
  }
  if (u.username || u.password) {
    throw new AppError('E_SSRF_BLOCKED', 'URL 不允许携带凭证', { url: urlText });
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(u.hostname, { all: true, verbatim: true });
  } catch (e) {
    throw new AppError('E_NETWORK', `域名解析失败：${u.hostname}`, { url: urlText, reason: e.code || e.message });
  }
  if (!addrs.length) throw new AppError('E_NETWORK', `域名无解析结果：${u.hostname}`, { url: urlText });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new AppError('E_SSRF_BLOCKED', `目标解析到私网/保留地址：${u.hostname} → ${a.address}`, {
        url: urlText,
        address: a.address,
      });
    }
  }
  return u;
}
