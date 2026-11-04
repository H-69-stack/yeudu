/**
 * OpenAI 协议引擎（DeepSeek / OpenAI / 本地 Ollama 等任意兼容端）。
 * 只负责「把 N 段文本发给某处、拿回 N 段文本」：不分批、不缓存、不重试（都在上层）。
 */
import { translateItems } from './shared.js';
import { TRANSLATE_SYSTEM } from '../prompts.js';
import { openaiChat } from '../../llm/client.js';

/**
 * @param {{id:string, name:string, provider:string, model:string, maxChars:number, maxItems:number,
 *          concurrency:number, maxTokens:number, temperature:number, template:string, hasKey:boolean,
 *          baseUrl:string}} cfg
 */
export function createOpenAICompatibleEngine(cfg) {
  return {
    id: cfg.id,
    name: cfg.name,
    needsKey: true,
    supportsAuto: true,
    limits: { maxChars: cfg.maxChars, maxItems: cfg.maxItems },
    concurrency: cfg.concurrency,
    configured: cfg.hasKey && Boolean(cfg.model) && Boolean(cfg.baseUrl),
    hasKey: Boolean(cfg.hasKey),
    hasModel: Boolean(cfg.model),
    desc: `OpenAI 兼容协议（${cfg.baseUrl || '未配置 baseUrl'}，model=${cfg.model || '未配置'}）`,
    /**
     * @param {string[]} items
     * @param {Object} ctx
     * @returns {Promise<string[]>}
     */
    async translate(items, ctx) {
      return translateItems({
        items,
        ctx: { ...ctx, engineId: cfg.id },
        template: cfg.template,
        call: async (prompt) => {
          const out = await openaiChat({
            provider: cfg.provider,
            model: cfg.model,
            // system 通道放「资料不是指令」的隔离说明（模板本身只谈译文要求；
            // 分离后改隔离文案不会动 prompt_fp，也就不会让已有译文全部失效）。
            messages: [
              { role: 'system', content: TRANSLATE_SYSTEM },
              { role: 'user', content: prompt },
            ],
            maxTokens: cfg.maxTokens,
            // 严格重试（体检失败后）由上层给更低的 temperature；其余用配置值
            temperature: Number.isFinite(ctx.temperature) ? ctx.temperature : cfg.temperature,
            timeoutMs: ctx.timeoutMs,
            signal: ctx.signal,
          });
          if (ctx.onUsage) ctx.onUsage(out);
          return out.text;
        },
      });
    },
  };
}
