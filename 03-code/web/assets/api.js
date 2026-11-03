/**
 * 前端 fetch 封装：统一错误结构 {error:{code,message,detail,traceId}}。
 * 前端只按 code 分支，不按 message（消息文案可能变）。
 */

export class ApiError extends Error {
  constructor(payload, status) {
    super((payload && payload.error && payload.error.message) || `请求失败（HTTP ${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.code = (payload && payload.error && payload.error.code) || 'E_UNKNOWN';
    this.detail = (payload && payload.error && payload.error.detail) || null;
    this.traceId = (payload && payload.error && payload.error.traceId) || null;
  }
}

async function request(path, { method = 'GET', body, timeoutMs = 60000, raw = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const init = { method, signal: ctl.signal, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError({ error: { code: 'E_NETWORK', message: `网络请求失败：${e.message}` } }, 0);
  }
  clearTimeout(timer);
  if (raw) return res;
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) throw new ApiError(payload, res.status);
  return payload;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: body ?? {} }),
  patch: (path, body) => request(path, { method: 'PATCH', body: body ?? {} }),
  put: (path, body) => request(path, { method: 'PUT', body: body ?? {} }),
  raw: request,
};

/** 上传本地 PDF（multipart，服务端手写解析） */
export async function uploadPdf(no, file) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await fetch(`/api/works/${encodeURIComponent(no)}/asset`, { method: 'POST', body: fd });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) throw new ApiError(payload, res.status);
  return payload;
}

/** 拼查询串（跳过空值） */
export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
