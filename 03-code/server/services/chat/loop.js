/**
 * tool-calling 循环（对齐 dsh agent loop 的语义）。
 *
 * 一轮提问的事件序列：
 *   模型 → 决定调用工具 → 工具结果回模型 → 模型 → … → 产出正文
 * 循环的四个硬约束：
 *   1) **工具串行执行**（dsh 同样串行）：03-code 的库是 SQLite 单写者，并发写会撞锁；
 *   2) **额度闸**：`registry` 自带 maxCalls，用尽后强制一次「不带 tools」的收尾调用，
 *      保证用户总能拿到回答，而不是卡在循环里；
 *   3) **工具失败不中断**：错误作为 tool 消息回模型（模型可换参数重试），循环继续；
 *   4) **中止可传播**：signal 一路透传到 HTTP 请求，取消后不再发起新的一轮。
 */
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { openaiChatStream } from '../llm/client.js';
import { buildImageInjection } from './image-inject.js';

/**
 * @param {{
 *   provider:string, model:string, messages:Array, registry:Object, signal?:AbortSignal,
 *   onDelta?:(t:string)=>void, onTool?:(info:Object)=>void, onToolResult?:(info:Object)=>void,
 *   toolCtx?:Object, maxRounds?:number, maxTokens?:number, temperature?:number, timeoutMs?:number,
 * }} p
 */
export async function runToolLoop(p) {
  const {
    provider,
    model,
    registry,
    signal,
    onDelta,
    onTool,
    onToolResult,
    toolCtx = {},
    maxTokens,
    temperature,
    timeoutMs,
  } = p;
  const maxRounds = Math.max(1, Number(p.maxRounds || config.chat.maxToolRounds || 5));
  const messages = Array.isArray(p.messages) ? p.messages.slice() : [];

  let text = '';
  let promptTokens = null;
  let completionTokens = null;
  let latencyMs = 0;
  let round = 0;
  const toolLog = [];

  const call = (withTools) =>
    openaiChatStream({
      provider,
      model,
      messages,
      tools: withTools ? registry.openaiTools() : undefined,
      maxTokens,
      temperature,
      timeoutMs,
      signal,
      onDelta: (d) => {
        text += d;
        if (onDelta) onDelta(d);
      },
    });

  for (round = 1; round <= maxRounds; round += 1) {
    if (signal && signal.aborted) throw new AppError('E_CANCELED', '已取消');
    const out = await call(true);
    latencyMs += out.latencyMs || 0;
    promptTokens = out.promptTokens == null ? promptTokens : out.promptTokens;
    completionTokens = out.completionTokens == null ? completionTokens : out.completionTokens;

    const calls = Array.isArray(out.toolCalls) ? out.toolCalls : [];
    if (!calls.length) {
      return { text, usage: { promptTokens, completionTokens }, latencyMs, toolCalls: toolLog, rounds: round };
    }

    // 模型这一轮只想调工具：把 assistant(tool_calls) 回填，再逐条塞 tool 结果
    messages.push({
      role: 'assistant',
      content: out.text || '',
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
      })),
    });

    // 本轮的工具条目（用于图片注入——只注入**本轮**的，跨轮重复注入会把上下文撑爆）
    const roundEntries = [];

    for (const c of calls) {
      let args = {};
      try {
        args = c.arguments ? JSON.parse(c.arguments) : {};
      } catch {
        args = {};
      }
      if (onTool) onTool({ id: c.id, name: c.name, args });
      const r = await registry.run(c.name, args, toolCtx);
      const entry = {
        id: c.id,
        name: c.name,
        args,
        ok: Boolean(r.ok),
        ms: r.ms || 0,
        chars: r.ok ? String(r.text || '').length : 0,
        error: r.ok ? null : r.error,
        errorCode: r.ok ? null : r.errorCode || null,
        // 视觉通道：工具体在 value.image 里给出附件引用（对齐 dsh 的 ImageAttachmentRef，
        // 不是把 base64 塞进上下文），这里只把引用往上带，落库与展示由 pipeline 负责
        attachments: r.ok && r.value && r.value.image && r.value.image.attachmentId
          ? [r.value.image]
          : (r.ok && r.value && Array.isArray(r.value.attachments) ? r.value.attachments : []),
      };
      toolLog.push(entry);
      roundEntries.push(entry);
      if (onToolResult) onToolResult(entry);
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: r.ok ? r.text : `工具执行失败（${c.name}）：${r.error}`,
      });
    }

    // 视觉通道：**图片必须以用户消息注入**，模型才看得到（工具结果只回文本摘要）。
    // 依据 dsh `docs/01-源码梳理.md:262`：生产适配器是 text-only 输出，只有用户消息能带图。
    const injectCfg = config.chat.pageImage || {};
    if (injectCfg.injectImages !== false && roundEntries.length > 0) {
      const injection = buildImageInjection(roundEntries, {
        maxBytes: injectCfg.maxInjectBytes,
        maxPerTurn: injectCfg.maxInjectPerTurn,
      });
      for (const m of injection.messages) messages.push(m);
      for (const s of injection.skipped) {
        // 跳过也要让模型知道（否则它会以为自己已经看过这张图）
        messages.push({
          role: 'user',
          content: `[系统提示] ${s.reason}（attachmentId=${s.attachmentId}）。`,
        });
      }
    }

    // 额度用尽：不再给工具，逼模型基于已有材料作答（保证有输出）
    if (registry.stats().exhausted) {
      const fin = await call(false);
      latencyMs += fin.latencyMs || 0;
      promptTokens = fin.promptTokens == null ? promptTokens : fin.promptTokens;
      completionTokens = fin.completionTokens == null ? completionTokens : fin.completionTokens;
      return { text, usage: { promptTokens, completionTokens }, latencyMs, toolCalls: toolLog, rounds: round, quotaHit: true };
    }
  }

  // 轮数用尽仍有工具调用：强制收尾一次（不给工具）
  const fin = await call(false);
  latencyMs += fin.latencyMs || 0;
  promptTokens = fin.promptTokens == null ? promptTokens : fin.promptTokens;
  completionTokens = fin.completionTokens == null ? completionTokens : fin.completionTokens;
  return { text, usage: { promptTokens, completionTokens }, latencyMs, toolCalls: toolLog, rounds: round, roundsExhausted: true };
}
