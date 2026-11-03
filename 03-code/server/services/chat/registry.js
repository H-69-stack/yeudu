/**
 * 工具注册表 —— 参照 dsh `defineTool` 契约的 JS 移植（dsh-impl/packages/dsh-bundle-litagent/src/tools/lit-search.ts）。
 *
 * 三条契约（与 dsh 逐字段对齐，将来把引擎换成 dsh 子进程时工具层零改动）：
 *   1) `execute` 只返回**规范 JSON**（结构化，可断言），模型可见文本由 `render` 单独生成；
 *   2) 「没找到」不是异常：返回空结果让模型自行解释，不抛错打断循环；
 *   3) 注册表聚合出的 schema 直接就是上游 `tools` 参数 —— **不存在第二份手写工具描述**。
 *
 * 与 dsh 的差异（有意为之）：dsh 用 `inject: ['tools','library']` 做依赖注入；这里是单进程脚本，
 * 工具直接 import 数据访问层（`db.js` / `fts.js`），只在 `execute(args, ctx)` 的 ctx 里注入
 * 当前会话上下文（assetId / workNo / 选区），避免工具自己去猜「现在在读哪篇」。
 */
import { AppError } from '../../errors.js';

const ALLOWED_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

/** dsh 错误码体系的一个子集（`packages/core/tools/src/contracts.ts`），够本项目用且语义一致 */
export const TOOL_ERROR = {
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  INVALID_TOOL_OUTPUT: 'INVALID_TOOL_OUTPUT',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  ABORTED: 'ABORTED',
  TOOL_QUOTA: 'TOOL_QUOTA',
};

/**
 * 极简 JSON Schema 校验（只覆盖我们自己写的那几种形状：object/array/string/number/boolean + required + 数值区间）。
 * 对齐 dsh「每次成功返回值都过 output.schema，违反即 INVALID_TOOL_OUTPUT」（`contracts.ts:18,310`）。
 * @returns {string|null} 错误说明，通过返回 null
 */
export function validateOutput(schema, value) {
  if (!schema) return null;
  const type = schema.type || 'object';
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type === 'object' && actual !== 'object') return `期望 object，实际 ${actual}`;
  if (type === 'array') {
    if (actual !== 'array') return `期望 array，实际 ${actual}`;
    return null;
  }
  if (type !== 'object' && type !== 'array' && actual !== type) return `期望 ${type}，实际 ${actual}`;
  for (const key of schema.required || []) {
    if (value == null || !(key in value)) return `缺少必填字段 ${key}`;
  }
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (!(key in value)) continue;
    const v = value[key];
    if (v === null) continue;
    const t = Array.isArray(v) ? 'array' : typeof v;
    if (prop.type && prop.type !== t) return `字段 ${key} 期望 ${prop.type}，实际 ${t}`;
    if (prop.type === 'number' && Number.isFinite(Number(v))) {
      if (prop.minimum != null && Number(v) < prop.minimum) return `字段 ${key} 小于下限 ${prop.minimum}`;
      if (prop.maximum != null && Number(v) > prop.maximum) return `字段 ${key} 超出上限 ${prop.maximum}`;
    }
  }
  return null;
}

/**
 * 声明一个工具。返回对象直接交给 `createRegistry`。
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters?: Record<string, {type:string, description?:string, required?:boolean, enum?:any[], items?:object}>,
 *   outputSchema?: {type:string, required?:string[], properties?:Object},
 *   timeoutMs?: number,
 *   execute: (args:Object, ctx:Object) => any|Promise<any>,
 *   render: (args:Object, value:any) => string,
 * }} spec
 */
export function defineTool(spec) {
  const { name, description, parameters = {}, execute, render, outputSchema, timeoutMs } = spec || {};
  if (!name || typeof name !== 'string') throw new AppError('E_INTERNAL', '工具缺少 name');
  if (!description) throw new AppError('E_INTERNAL', `工具 ${name} 缺少 description（模型靠它判断何时调用）`);
  if (typeof execute !== 'function') throw new AppError('E_INTERNAL', `工具 ${name} 缺少 execute`);
  if (typeof render !== 'function') throw new AppError('E_INTERNAL', `工具 ${name} 缺少 render`);

  const properties = {};
  const required = [];
  for (const [key, p] of Object.entries(parameters)) {
    if (!p || !ALLOWED_TYPES.has(p.type)) {
      throw new AppError('E_INTERNAL', `工具 ${name} 的参数 ${key} 类型非法：${p && p.type}`);
    }
    const node = { type: p.type };
    if (p.description) node.description = p.description;
    if (Array.isArray(p.enum) && p.enum.length) node.enum = p.enum;
    if (p.type === 'array' && p.items) node.items = p.items;
    properties[key] = node;
    if (p.required) required.push(key);
  }

  return {
    name,
    description,
    parameters,
    execute,
    render,
    outputSchema: outputSchema || null,
    timeoutMs: Number.isFinite(timeoutMs) ? Number(timeoutMs) : null,
    /** 上游 tools 参数里的一项（OpenAI 兼容格式） */
    schema: {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    },
  };
}

/**
 * 单工具超时（对齐 dsh `contracts.ts:69` 的 timeoutMs）：超时不等到底，直接让调用失败并
 * 把「超时」这个事实回给模型（模型可以换更小的参数重试），而不是让整轮卡住。
 * @template T
 * @param {Promise<T>|T} work
 * @param {number|null} ms
 */
async function withTimeout(work, ms) {
  const p = Promise.resolve(work);
  if (!Number.isFinite(ms) || Number(ms) <= 0) return p;
  let timer = null;
  try {
    return await Promise.race([
      p,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), Number(ms));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 建一个本轮生效的注册表。
 * @param {Array} tools defineTool 的返回值数组
 * @param {{maxCalls?:number, sessionCounts?:Object, maxCallsPerName?:Object}} [opts]
 *   maxCalls        本轮工具调用总次数上限（成本闸）
 *   sessionCounts   本会话已发生的调用计数 { 工具名: 次数 }（跨轮配额用）
 *   maxCallsPerName 每会话每工具的配额 { 工具名: 上限 }
 */
export function createRegistry(tools, opts = {}) {
  const map = new Map();
  for (const t of tools || []) {
    if (!t || !t.name) continue;
    if (map.has(t.name)) throw new AppError('E_INTERNAL', `工具重名：${t.name}`);
    map.set(t.name, t);
  }
  const maxCalls = Number.isFinite(opts.maxCalls) ? Number(opts.maxCalls) : 8;
  const sessionCounts = opts.sessionCounts || {};
  const maxCallsPerName = opts.maxCallsPerName || {};
  const byName = {};
  let calls = 0;

  return {
    names() {
      return [...map.keys()];
    },
    has(name) {
      return map.has(name);
    },
    /** 直接在请求体里用的 tools 数组；空注册表返回 undefined（不传该字段） */
    openaiTools() {
      return map.size ? [...map.values()].map((t) => t.schema) : undefined;
    },
    stats() {
      return { calls, byName: { ...byName }, exhausted: calls >= maxCalls };
    },
    /**
     * 执行一个工具。**永不抛**：失败以 `{ok:false, error}` 返回，让循环把错误作为
     * tool 消息回给模型（模型可以换个参数重试），而不是整轮崩掉。
     * @param {string} name
     * @param {Object} args
     * @param {Object} ctx 会话上下文（assetId/workNo/selection）
     */
    async run(name, args, ctx = {}) {
      const tool = map.get(name);
      if (!tool) {
        return { ok: false, error: `未知工具：${name}`, errorCode: TOOL_ERROR.UNKNOWN_TOOL, ms: 0 };
      }
      if (calls >= maxCalls) {
        return {
          ok: false,
          error: `E_TOOL_QUOTA：本轮工具调用已达上限 ${maxCalls} 次，请直接用已有信息作答`,
          errorCode: TOOL_ERROR.TOOL_QUOTA,
          ms: 0,
        };
      }
      // 跨轮配额（对齐 dsh 的「每会话渲染次数」闸）：本轮已用 + 历史已用
      const perName = maxCallsPerName[name];
      if (Number.isFinite(perName)) {
        // 已发生次数 = 历史（落库投影）+ 本轮
        // 注意：dsh 的 `used > max`（page-image-usage.ts:14）里的 used **含当前这次**
        //（它的批执行器先写 tool/call 再执行，batch.ts:243-249）；我们这里是执行前判定，
        // 所以等价写法是 `已发生 >= 上限` —— 语义仍是「最多 max 次」，不会白送也不会少给。
        const used = Number(sessionCounts[name] || 0) + (byName[name] || 0);
        if (used >= perName) {
          return {
            ok: false,
            error: `E_TOOL_QUOTA：${name} 在本会话已用 ${used} 次，达到上限 ${perName} 次（开新会话可重置；或改用 lit_read 读文字）`,
            errorCode: TOOL_ERROR.TOOL_QUOTA,
            ms: 0,
          };
        }
      }
      calls += 1;
      byName[name] = (byName[name] || 0) + 1;
      const t0 = Date.now();
      try {
        const value = await withTimeout(tool.execute(args || {}, ctx), tool.timeoutMs);
        if (value && value.__timeout) {
          return {
            ok: false,
            error: `${TOOL_ERROR.TOOL_TIMEOUT}：${name} 超过 ${tool.timeoutMs}ms 未返回`,
            errorCode: TOOL_ERROR.TOOL_TIMEOUT,
            ms: Date.now() - t0,
          };
        }
        const bad = validateOutput(tool.outputSchema, value);
        if (bad) {
          return {
            ok: false,
            error: `${TOOL_ERROR.INVALID_TOOL_OUTPUT}：${name} 返回值不合契约（${bad}）`,
            errorCode: TOOL_ERROR.INVALID_TOOL_OUTPUT,
            ms: Date.now() - t0,
          };
        }
        const text = tool.render(args || {}, value);
        return { ok: true, value, text: String(text == null ? '' : text), ms: Date.now() - t0 };
      } catch (e) {
        const aborted = e && (e.code === 'E_CANCELED' || e.name === 'AbortError');
        return {
          ok: false,
          error: String(e && e.message ? e.message : e),
          errorCode: aborted ? TOOL_ERROR.ABORTED : null,
          ms: Date.now() - t0,
        };
      }
    },
  };
}
