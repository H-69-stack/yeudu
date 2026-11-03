/**
 * 引擎契约（JSDoc typedef，§12.3）。运行时不产生代码。
 *
 * @typedef {Object} EngineLimits
 * @property {number} maxChars  单请求最大字符数
 * @property {number} maxItems  单请求最大段数
 *
 * @typedef {Object} EngineContext
 * @property {string} srcLang   'auto' 或语言码
 * @property {string} tgtLang
 * @property {Object} [work]    works 行（注入标题/贡献定位做术语上下文）
 * @property {string} promptFp  提示词指纹（仅日志/记账用，引擎不得改提示词）
 * @property {string} model
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} Engine
 * @property {string} id
 * @property {string} name
 * @property {boolean} needsKey
 * @property {boolean} supportsAuto
 * @property {EngineLimits} limits
 * @property {number} concurrency
 * @property {string} desc
 * @property {(items:string[], ctx:EngineContext) => Promise<string[]>} translate
 *   契约：返回数组长度必须 === items.length；每项必须是非空字符串。
 *         允许实现内部做「多段合批 + 解析失败回退逐段」；**不做分批**（上层已按 limits 分批）。
 */

export const ENGINE_CONTRACT_VERSION = 1;
