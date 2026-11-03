/**
 * Gemini 引擎（Google AI Studio / generateContent 协议）。
 * 与 OpenAI 的区别只在请求形状与返回字段，分批/缓存/重试同样在上层。
 */
import { translateItems } from './shared.js';
import { geminiChat } from '../../llm/client.js';

/**
 * @param {{id:string, provider:string, model:string, maxChars:number, maxItems:number,
 *          concurrency:number, maxTokens:number, temperature:number, template:string, hasKey:boolean}} cfg
 */
export function createGeminiEngine(cfg) {
  return {
    id: cfg.id,
    name: 'Gemini',
    needsKey: true,
    supportsAuto: true,
    limits: { maxChars: cfg.maxChars, maxItems: cfg.maxItems },
    concurrency: cfg.concurrency,
    configured: cfg.hasKey && Boolean(cfg.model),
    hasKey: Boolean(cfg.hasKey),
    hasModel: Boolean(cfg.model),
    desc: `Google Gemini（model=${cfg.model || '未配置'}）`,
    async translate(items, ctx) {
      return translateItems({
        items,
        ctx: { ...ctx, engineId: cfg.id },
        template: cfg.template,
        call: async (prompt) => {
          const out = await geminiChat({
            provider: cfg.provider,
            model: cfg.model,
            prompt,
            maxTokens: cfg.maxTokens,
            temperature: cfg.temperature,
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
