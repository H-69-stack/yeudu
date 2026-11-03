/**
 * 手写参数校验（§5：路由层只做「参数校验 + 调服务 + 序列化」）。
 * schema 形状：
 *   { 字段名: { type:'int'|'number'|'string'|'bool'|'enum'|'intArray', required?, min?, max?,
 *               enum?:any[], pattern?:RegExp, maxLength?, default? } }
 */
import { AppError } from '../errors.js';

function bad(field, reason, value) {
  return new AppError('E_BAD_REQUEST', `参数 ${field} ${reason}`, { field, value });
}

function coerce(field, spec, raw) {
  const { type } = spec;
  if (raw === undefined || raw === null || raw === '') {
    if (spec.default !== undefined) return spec.default;
    if (spec.required) throw new AppError('E_BAD_REQUEST', `缺少必填参数 ${field}`, { field });
    return undefined;
  }
  switch (type) {
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw bad(field, '必须是整数', raw);
      if (spec.min !== undefined && n < spec.min) throw bad(field, `不能小于 ${spec.min}`, raw);
      if (spec.max !== undefined && n > spec.max) throw bad(field, `不能大于 ${spec.max}`, raw);
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw bad(field, '必须是数字', raw);
      if (spec.min !== undefined && n < spec.min) throw bad(field, `不能小于 ${spec.min}`, raw);
      if (spec.max !== undefined && n > spec.max) throw bad(field, `不能大于 ${spec.max}`, raw);
      return n;
    }
    case 'bool': {
      if (raw === true || raw === 'true' || raw === '1' || raw === 1) return true;
      if (raw === false || raw === 'false' || raw === '0' || raw === 0) return false;
      throw bad(field, '必须是布尔值', raw);
    }
    case 'enum': {
      if (!spec.enum.includes(raw)) throw bad(field, `必须是 ${spec.enum.join('/')} 之一`, raw);
      return raw;
    }
    case 'intArray': {
      const arr = Array.isArray(raw) ? raw : String(raw).split(',');
      const nums = arr.map((x) => Number(x));
      if (nums.some((n) => !Number.isInteger(n))) throw bad(field, '必须是整数数组', raw);
      return nums;
    }
    case 'stringArray': {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (arr.some((x) => typeof x !== 'string')) throw bad(field, '必须是字符串数组', raw);
      return arr;
    }
    case 'string':
    default: {
      const s = String(raw);
      if (spec.maxLength !== undefined && s.length > spec.maxLength) throw bad(field, `长度不能超过 ${spec.maxLength}`, s.slice(0, 40));
      if (spec.pattern && !spec.pattern.test(s)) throw bad(field, '格式不合法', s.slice(0, 80));
      return s;
    }
  }
}

/** 校验并归一化（不抛时返回新对象，含 default 值） */
export function parseInput(schema, input) {
  const out = {};
  for (const [field, spec] of Object.entries(schema)) {
    const v = coerce(field, spec, input ? input[field] : undefined);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

/** express 中间件形态：结果放到 req.validated */
export function validate(schema, source = 'body') {
  return function validator(req, res, next) {
    try {
      const input = source === 'query' ? req.query : req.body;
      req.validated = parseInput(schema, input || {});
      return next();
    } catch (e) {
      return next(e);
    }
  };
}

/** 常用路径参数校验：编号形如 7.2 / 12.10 */
export const WORK_NO_PATTERN = /^\d+\.\d+$/;
