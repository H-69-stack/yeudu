/**
 * 引擎注册表（§16.4 / T 层「注册 ≠ 可用 ≠ 被选中」）。
 *
 * 数据驱动：新增一个 OpenAI 兼容供应商 = 加一条配置（`translate.engines.<id>`），不写代码。
 * `configured` 把三件事在数据层分开：已注册（这里有）/ 已配置（有 key + model + baseUrl）/
 * 被 job 选中（请求里指定且 configured=true）。
 */
import { config } from '../../../config.js';
import { AppError } from '../../../errors.js';
import { resolveProvider } from '../../llm/client.js';
import { createOpenAICompatibleEngine } from './openaiCompatible.js';
import { createGeminiEngine } from './gemini.js';
import { createClaudeEngine } from './claude.js';
import { createMockEngine, mockStats, resetMockStats } from './mock.js';
import { resolveTemplate } from '../prompts.js';

/** 各引擎的默认模型（用户可在 settings 里改：translate.engines.<id>.model） */
export const DEFAULT_MODELS = {
  deepseek: 'deepseek-chat',
  qwen: 'qwen-plus',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  claude: 'claude-3-5-sonnet-latest',
  mock: 'mock-v2',
};

/** 引擎 → provider（密钥、baseUrl 从 provider 配置取） */
const PROVIDER_OF = { deepseek: 'deepseek', qwen: 'qwen', openai: 'openai', gemini: 'gemini', claude: 'claude', mock: 'mock' };

/** 是否启用假引擎（测试/自测用；生产默认关） */
export function mockEnabled() {
  return process.env.NODE_ENV === 'test' || process.env.AGENTLIT_MOCK_ENGINE === '1';
}

function engineOverrides(id) {
  const all = (config.translate && config.translate.engines) || {};
  return all[id] || {};
}

/** 某个引擎当前的生效模型名 */
export function resolveModel(id) {
  if (!id) return '';
  const o = engineOverrides(id);
  return String(o.model || DEFAULT_MODELS[id] || '');
}

function baseOpts(id) {
  const o = engineOverrides(id);
  const providerId = PROVIDER_OF[id] || id;
  const prov = resolveProvider(providerId);
  return {
    id,
    provider: providerId,
    model: resolveModel(id),
    maxChars: Number(o.maxChars || config.translate.batchChars || 3000),
    maxItems: Number(o.maxItems || config.translate.batchItems || 6),
    concurrency: Number(o.concurrency || config.translate.concurrency || 2),
    maxTokens: Number(o.maxTokens ?? (config.translate.maxTokens || 4000)),
    temperature: Number(o.temperature ?? (config.translate.temperature ?? 0.3)),
    template: resolveTemplate(config),
    hasKey: prov.hasKey,
    baseUrl: prov.baseUrl,
  };
}

/** 构建全部引擎（每次调用重建，保证 settings 改动立刻生效） */
function buildEngines() {
  const map = new Map();
  map.set('deepseek', createOpenAICompatibleEngine({ ...baseOpts('deepseek'), name: 'DeepSeek' }));
  map.set('qwen', createOpenAICompatibleEngine({ ...baseOpts('qwen'), name: '通义千问' }));
  map.set('openai', createOpenAICompatibleEngine({ ...baseOpts('openai'), name: 'OpenAI' }));
  map.set('gemini', createGeminiEngine(baseOpts('gemini')));
  map.set('claude', createClaudeEngine(baseOpts('claude')));
  if (mockEnabled()) map.set('mock', createMockEngine(engineOverrides('mock')));
  return map;
}

/**
 * 可选引擎列表（GET /api/translate/engines）。
 * 未配置密钥的引擎仍显示（configured=false），但 job 创建时会被拒绝。
 */
export function listEngines() {
  return [...buildEngines().values()].map((e) => ({
    id: e.id,
    name: e.name,
    needsKey: e.needsKey,
    configured: Boolean(e.configured),
    supportsAuto: e.supportsAuto,
    maxChars: e.limits.maxChars,
    maxItems: e.limits.maxItems,
    concurrency: e.concurrency,
    model: resolveModel(e.id),
    desc: e.desc,
  }));
}

/**
 * 取引擎（不做 configured 检查；调用方需要时用 assertConfigured）。
 * @param {string} id
 */
export function getEngine(id) {
  return buildEngines().get(String(id || '')) || null;
}

/** 取一个「已配置」的引擎，否则抛 E_ENGINE_UNCONFIGURED（§16.4） */
export function requireEngine(id) {
  const engine = getEngine(id);
  if (!engine) throw new AppError('E_ENGINE_UNCONFIGURED', `未注册的翻译引擎：${id}`, { engine: id });
  if (!engine.configured) {
    // 分清两种失败：缺密钥 → E_LLM_KEY_MISSING（用户去填 key）；缺 model/baseUrl → E_ENGINE_UNCONFIGURED
    if (engine.needsKey && !engine.hasKey) {
      throw new AppError('E_LLM_KEY_MISSING', `引擎「${engine.name || id}」未配置 apiKey（请在设置页填写）`, { engine: id });
    }
    if (!engine.hasModel) {
      throw new AppError('E_ENGINE_UNCONFIGURED', `引擎「${engine.name || id}」缺少 model`, { engine: id });
    }
    throw new AppError('E_ENGINE_UNCONFIGURED', `引擎「${engine.name || id}」缺少配置（apiKey / model / baseUrl）`, {
      engine: id,
    });
  }
  return engine;
}

/** 引擎链：主引擎 + 备用链，去重、过滤掉未配置的（§9.1.3 [7]） */
export function engineChain(primary, fallback) {
  const ids = [primary, ...(fallback || [])].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = getEngine(id);
    if (e && e.configured) out.push(e);
  }
  return out;
}

export { mockStats, resetMockStats };
