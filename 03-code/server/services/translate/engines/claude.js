/**
 * Claude 引擎（Anthropic messages 协议）。
 */
import { translateItems } from './shared.js';
import { anthropicChat } from '../../llm/client.js';

/**
 * @param {{id:string, provider:string, model:string, maxChars:number, maxItems:number,
 *          concurrency:number, maxTokens:number, temperature:number, template:string, hasKey:boolean}} cfg
 */
export function createClaudeEngine(cfg) {
  return {
    id: cfg.id,
    name: 'Claude',
    needsKey: true,
    supportsAuto: true,
    limits: { maxChars: cfg.maxChars, maxItems: cfg.maxItems },
    concurrency: cfg.concurrency,
    configured: cfg.hasKey && Boolean(cfg.model),
    hasKey: Boolean(cfg.hasKey),
    hasModel: Boolean(cfg.model),
    desc: `Anthropic Claude（model=${cfg.model || '未配置'}）`,
    async translate(items, ctx) {
      return translateItems({
        items,
        ctx: { ...ctx, engineId: cfg.id },
        template: cfg.template,
        call: async (prompt) => {
          const out = await anthropicChat({
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
