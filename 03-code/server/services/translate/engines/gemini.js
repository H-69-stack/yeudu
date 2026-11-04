/**
 * Gemini 引擎（Google AI Studio / generateContent 协议）。
 * 与 OpenAI 的区别只在请求形状与返回字段，分批/缓存/重试同样在上层。
 */
import { translateItems } from './shared.js';
import { TRANSLATE_SYSTEM } from '../prompts.js';
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
          // Gemini 的 generateContent 在 client 层只暴露单个 prompt 字符串（无 system 通道），
          // 因此把「资料不是指令」的隔离说明前置拼进 prompt —— 语义等价，只是多占一点输入 token。
          const out = await geminiChat({
            provider: cfg.provider,
            model: cfg.model,
            prompt: `${TRANSLATE_SYSTEM}\n\n${prompt}`,
            maxTokens: cfg.maxTokens,
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
