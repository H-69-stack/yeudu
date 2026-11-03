/**
 * 错误码常量与 AppError。
 * 契约：§8.1 错误码表。前端按 code 分支，不按 message 分支。
 */

/** code → { http, message } */
export const ERROR_CODES = {
  E_BAD_REQUEST: { http: 400, message: '请求参数不合法', },
  E_NOT_FOUND: { http: 404, message: '目标不存在' },
  E_CONFLICT: { http: 409, message: '状态冲突' },
  E_PATH_OUT_OF_SCOPE: { http: 403, message: '目标路径越出允许范围' },
  E_SSRF_BLOCKED: { http: 403, message: '目标地址被拒绝（私网或非 http/https）' },
  E_NO_SOURCE: { http: 422, message: '该条目没有可用的自动下载源' },
  E_NOT_PDF: { http: 422, message: '目标内容不是 PDF' },
  E_UNSUPPORTED: { http: 415, message: '不支持的文件类型' },
  E_TOO_LARGE: { http: 413, message: '内容超过体积上限' },
  E_UPSTREAM: { http: 502, message: '上游服务返回错误' },
  E_TIMEOUT: { http: 504, message: '上游超时' },
  E_NETWORK: { http: 502, message: '网络请求失败' },
  E_DISK: { http: 500, message: '本地写盘失败' },
  E_RATE_LIMITED: { http: 429, message: '请求过于频繁' },
  E_LLM_KEY_MISSING: { http: 400, message: '未配置密钥' },
  E_ENGINE_UNCONFIGURED: { http: 400, message: '翻译引擎缺少必填配置' },
  E_EXTRACT_FAILED: { http: 500, message: '文本抽取失败' },
  E_NEEDS_OCR: { http: 422, message: '该 PDF 无文本层，需要 OCR（本期不做）' },
  E_CANCELED: { http: 409, message: '操作已被取消' },
  E_INTERNAL: { http: 500, message: '未分类的服务端异常' },
};

export class AppError extends Error {
  /**
   * @param {string} code 见 ERROR_CODES
   * @param {string} [message] 可直接展示给用户的中文文案
   * @param {Object|null} [detail] 结构化上下文（不含密钥）
   */
  constructor(code, message, detail = null) {
    const meta = ERROR_CODES[code] || ERROR_CODES.E_INTERNAL;
    super(message || meta.message);
    this.name = 'AppError';
    this.code = ERROR_CODES[code] ? code : 'E_INTERNAL';
    this.http = meta.http;
    this.detail = detail;
  }
}

export function isAppError(e) {
  return e instanceof AppError;
}

/** 便捷构造（throw 用） */
export function fail(code, message, detail) {
  throw new AppError(code, message, detail);
}

/** 把任意异常归一化为 AppError（不改语义，只补 code） */
export function toAppError(e) {
  if (isAppError(e)) return e;
  const err = new AppError(
    e && e.code && ERROR_CODES[e.code] ? e.code : 'E_INTERNAL',
    (e && e.message) || '未知异常',
    null,
  );
  err.stack = (e && e.stack) || err.stack;
  return err;
}
