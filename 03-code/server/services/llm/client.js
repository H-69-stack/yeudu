/**
 * LLM 唯一出站出口（§9.2 T 层「凭证不进执行环境」/ §12.3）。
 *
 * 三条铁律：
 *  ① 只有本文件读 `secrets`；读完立即组进请求头，不返回、不落 job 上下文、不进日志。
 *  ② 所有出站 HTTP（含三家协议差异）都在本文件内完成，引擎层不得自己 fetch。
 *  ③ 错误统一归一化为 AppError；错误 detail 里**永不**包含密钥（只给 provider 名与 HTTP 状态）。
 *
 * 重试策略（§12.3）：仅对 429 / 5xx / 网络错误重试 1 次（间隔 1s）；4xx（除 429）不重试。
 */
import { AppError } from '../../errors.js';
import { secrets } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('llm');

const DEFAULTS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', protocol: 'openai-chat' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' },
  claude: { baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic' },
  local: { baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai-chat' },
};

/**
 * 解析 provider 配置（密钥只在内存里存在，调用方拿不到 apiKey —— 这里返回 hasKey 布尔）。
 * @param {string} providerId
 * @returns {{id:string, baseUrl:string, protocol:string, apiKey:string, hasKey:boolean, source:string}}
 */
export function resolveProvider(providerId) {
  const id = String(providerId || '').trim() || 'deepseek';
  // provider 密钥优先取 secret.providers.<id>；gemini/claude 这类「引擎密钥」允许放在 engines.<id>
  const sec = { ...((secrets.engines || {})[id] || {}), ...((secrets.providers || {})[id] || {}) };
  const base = DEFAULTS[id] || { baseUrl: '', protocol: 'openai-chat' };
  return {
    id,
    baseUrl: String(sec.baseUrl || base.baseUrl || '').replace(/\/+$/, ''),
    protocol: sec.protocol || base.protocol,
    apiKey: String(sec.apiKey || ''),
    hasKey: Boolean(String(sec.apiKey || '').trim()),
    source: sec.apiKey ? 'secret.json/env' : 'none',
  };
}

export function hasKey(providerId) {
  return resolveProvider(providerId).hasKey;
}

/** 组合超时与外部取消信号 */
function combineSignal(timeoutMs, signal) {
  const signals = [];
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  if (signal) signals.push(signal);
  return signals.length ? AbortSignal.any(signals) : undefined;
}

/**
 * 底层 JSON 请求（唯一 fetch 调用点）。
 * @param {string} url
 * @param {{method?:string, headers?:Object, body?:any, timeoutMs?:number, signal?:AbortSignal}} opts
 */
async function httpJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const ctl = combineSignal(timeoutMs, opts.signal);
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctl,
    });
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw new AppError('E_CANCELED', '请求已取消');
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new AppError('E_TIMEOUT', `LLM 请求超时（${timeoutMs}ms）`, { url: safeUrl(url) });
    }
    throw new AppError('E_NETWORK', `LLM 网络请求失败：${e.message}`, { url: safeUrl(url) });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const status = res.status;
    const snippet = summarizeUpstream(json, text);
    if (status === 429) throw new AppError('E_RATE_LIMITED', `LLM 限流（429）：${snippet}`, { status });
    throw new AppError('E_UPSTREAM', `LLM 返回 HTTP ${status}：${snippet}`, { status });
  }
  return { json, text, status: res.status };
}

function summarizeUpstream(json, text) {
  const msg =
    (json && json.error && (json.error.message || json.error.type)) ||
    (json && json.message) ||
    String(text || '').slice(0, 200) ||
    '（无响应体）';
  return String(msg).replace(/\s+/g, ' ').slice(0, 300);
}

/** 只保留 host/path，永不把 query（可能带 key）写进错误 detail */
function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

const RETRYABLE = new Set(['E_RATE_LIMITED', 'E_UPSTREAM', 'E_NETWORK', 'E_TIMEOUT']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带 1 次重试的调用包装（只对 429/5xx/网络/超时）。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{retries?:number, retryDelayMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? 1;
  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      if (i === retries || !RETRYABLE.has(code)) throw e;
      if (opts.signal && opts.signal.aborted) throw new AppError('E_CANCELED', '请求已取消');
      log.warn('llm.retry', { code, attempt: i + 1, retryDelayMs: opts.retryDelayMs ?? 1000 });
      await sleep(opts.retryDelayMs ?? 1000);
    }
  }
  throw lastErr;
}

/**
 * OpenAI 协议对话（DeepSeek / OpenAI / 任意兼容网关）。
 * @param {{provider:string, model:string, messages:Array, maxTokens?:number, temperature?:number,
 *          timeoutMs?:number, signal?:AbortSignal, purpose?:string}} p
 * @returns {Promise<{text:string, promptTokens:number|null, completionTokens:number|null, finishReason:string|null, latencyMs:number}>}
 */
export async function openaiChat(p) {
  const prov = resolveProvider(p.provider);
  if (!prov.hasKey) throw new AppError('E_LLM_KEY_MISSING', `provider「${prov.id}」未配置 apiKey`, { provider: prov.id });
  if (!prov.baseUrl) throw new AppError('E_ENGINE_UNCONFIGURED', `provider「${prov.id}」缺少 baseUrl`, { provider: prov.id });
  if (!p.model) throw new AppError('E_ENGINE_UNCONFIGURED', `provider「${prov.id}」缺少 model`, { provider: prov.id });

  const body = {
    model: p.model,
    messages: p.messages,
    temperature: p.temperature ?? 0.3,
    stream: false,
  };
  if (p.maxTokens) body.max_tokens = p.maxTokens;

  const t0 = Date.now();
  const { json } = await withRetry(
    () =>
      httpJson(`${prov.baseUrl}/chat/completions`, {
        headers: { Authorization: `Bearer ${prov.apiKey}`, 'api-key': prov.apiKey },
        body,
        timeoutMs: p.timeoutMs,
        signal: p.signal,
      }),
    { retries: p.retry === false ? 0 : 1, signal: p.signal },
  );
  const choice = json && json.choices && json.choices[0];
  const text = (choice && choice.message && choice.message.content) || '';
  if (!text) throw new AppError('E_UPSTREAM', 'LLM 返回空内容', { provider: prov.id, model: p.model });
  return {
    text,
    promptTokens: json.usage ? json.usage.prompt_tokens ?? null : null,
    completionTokens: json.usage ? json.usage.completion_tokens ?? null : null,
    finishReason: choice ? choice.finish_reason ?? null : null,
    latencyMs: Date.now() - t0,
  };
}

/**
 * Gemini 协议（generateContent）。
 * @param {{provider:string, model:string, prompt:string, maxTokens?:number, temperature?:number,
 *          timeoutMs?:number, signal?:AbortSignal}} p
 */
export async function geminiChat(p) {
  const prov = resolveProvider(p.provider || 'gemini');
  if (!prov.hasKey) throw new AppError('E_LLM_KEY_MISSING', `provider「${prov.id}」未配置 apiKey`, { provider: prov.id });
  if (!p.model) throw new AppError('E_ENGINE_UNCONFIGURED', 'gemini 引擎缺少 model', { provider: prov.id });
  const url = `${prov.baseUrl}/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(prov.apiKey)}`;
  const t0 = Date.now();
  const { json } = await withRetry(
    () =>
      httpJson(url, {
        body: {
          contents: [{ role: 'user', parts: [{ text: p.prompt }] }],
          generationConfig: {
            temperature: p.temperature ?? 0.3,
            ...(p.maxTokens ? { maxOutputTokens: p.maxTokens } : {}),
          },
        },
        timeoutMs: p.timeoutMs,
        signal: p.signal,
      }),
    { retries: p.retry === false ? 0 : 1, signal: p.signal },
  );
  const cand = json && json.candidates && json.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.map((x) => x.text || '').join('');
  if (!text) throw new AppError('E_UPSTREAM', 'Gemini 返回空内容', { provider: prov.id, model: p.model });
  return {
    text,
    promptTokens: json.usageMetadata ? json.usageMetadata.promptTokenCount ?? null : null,
    completionTokens: json.usageMetadata ? json.usageMetadata.candidatesTokenCount ?? null : null,
    finishReason: cand ? cand.finishReason ?? null : null,
    latencyMs: Date.now() - t0,
  };
}

/**
 * Anthropic 协议（messages）。
 * @param {{provider:string, model:string, prompt:string, system?:string, maxTokens?:number,
 *          temperature?:number, timeoutMs?:number, signal?:AbortSignal}} p
 */
export async function anthropicChat(p) {
  const prov = resolveProvider(p.provider || 'claude');
  if (!prov.hasKey) throw new AppError('E_LLM_KEY_MISSING', `provider「${prov.id}」未配置 apiKey`, { provider: prov.id });
  if (!p.model) throw new AppError('E_ENGINE_UNCONFIGURED', 'claude 引擎缺少 model', { provider: prov.id });
  const t0 = Date.now();
  const { json } = await withRetry(
    () =>
      httpJson(`${prov.baseUrl}/messages`, {
        headers: { 'x-api-key': prov.apiKey, 'anthropic-version': '2023-06-01' },
        body: {
          model: p.model,
          max_tokens: p.maxTokens || 4096,
          temperature: p.temperature ?? 0.3,
          ...(p.system ? { system: p.system } : {}),
          messages: [{ role: 'user', content: p.prompt }],
        },
        timeoutMs: p.timeoutMs,
        signal: p.signal,
      }),
    { retries: p.retry === false ? 0 : 1, signal: p.signal },
  );
  const blocks = (json && json.content) || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) throw new AppError('E_UPSTREAM', 'Claude 返回空内容', { provider: prov.id, model: p.model });
  return {
    text,
    promptTokens: json.usage ? json.usage.input_tokens ?? null : null,
    completionTokens: json.usage ? json.usage.output_tokens ?? null : null,
    finishReason: json.stop_reason ?? null,
    latencyMs: Date.now() - t0,
  };
}

export { httpJson as __httpJson };

// ─────────────────────────────────────────────────────────────────────────────
// 流式（对话用，§8.7 SSE）。非流式兜底：某些网关不返回 SSE，按整段文本推一个 delta。
// ─────────────────────────────────────────────────────────────────────────────

/** 逐行解析 SSE（保留半截 JSON 的 buffer 语义：只在遇到空行时交付一个完整事件） */
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (dataLines.length) yield dataLines.join('\n');
      idx = buf.indexOf('\n\n');
    }
  }
  if (buf.trim()) {
    const dataLines = buf
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (dataLines.length) yield dataLines.join('\n');
  }
}

async function postStream(url, { headers, body, timeoutMs, signal }) {
  const ctl = combineSignal(timeoutMs, signal);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: ctl,
    });
  } catch (e) {
    if (signal && signal.aborted) throw new AppError('E_CANCELED', '请求已取消');
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new AppError('E_TIMEOUT', `LLM 流式请求超时（${timeoutMs}ms）`, { url: safeUrl(url) });
    }
    throw new AppError('E_NETWORK', `LLM 网络请求失败：${e.message}`, { url: safeUrl(url) });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429) throw new AppError('E_RATE_LIMITED', `LLM 限流（429）`, { status: 429 });
    throw new AppError('E_UPSTREAM', `LLM 返回 HTTP ${res.status}：${summarizeUpstream(null, text)}`, { status: res.status });
  }
  return res;
}

/**
 * OpenAI 协议流式对话。
 * @param {{provider:string, model:string, messages:Array, maxTokens?:number, temperature?:number,
 *          timeoutMs?:number, signal?:AbortSignal, onDelta:(s:string)=>void}} p
 */
export async function openaiChatStream(p) {
  const prov = resolveProvider(p.provider);
  if (!prov.hasKey) throw new AppError('E_LLM_KEY_MISSING', `provider「${prov.id}」未配置 apiKey`, { provider: prov.id });
  if (!p.model) throw new AppError('E_ENGINE_UNCONFIGURED', `provider「${prov.id}」缺少 model`, { provider: prov.id });
  const body = {
    model: p.model,
    messages: p.messages,
    temperature: p.temperature ?? 0.3,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (p.maxTokens) body.max_tokens = p.maxTokens;
  // tool calling（tools 引擎用）：数组为空时**不要**带这个字段，否则部分兼容实现会报错
  if (Array.isArray(p.tools) && p.tools.length) {
    body.tools = p.tools;
    if (p.toolChoice) body.tool_choice = p.toolChoice;
  }
  const t0 = Date.now();
  const res = await postStream(`${prov.baseUrl}/chat/completions`, {
    headers: { Authorization: `Bearer ${prov.apiKey}`, 'api-key': prov.apiKey },
    body,
    timeoutMs: p.timeoutMs,
    signal: p.signal,
  });
  let text = '';
  let promptTokens = null;
  let completionTokens = null;
  let finishReason = null;
  /** index → {id, name, arguments}：流式 tool_calls 是**按 index 分片**下发的，必须自己拼 */
  const toolAcc = new Map();
  for await (const data of sseEvents(res)) {
    if (data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue; // 半截/心跳：忽略这一条，不抛
    }
    const choice = json.choices && json.choices[0];
    const delta = choice && choice.delta && choice.delta.content;
    if (delta) {
      text += delta;
      if (p.onDelta) p.onDelta(delta);
    }
    const chunks = choice && choice.delta && choice.delta.tool_calls;
    if (Array.isArray(chunks)) {
      for (const tc of chunks) {
        const idx = tc.index == null ? 0 : Number(tc.index);
        const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = String(tc.id);
        if (tc.function && tc.function.name) cur.name = String(tc.function.name);
        if (tc.function && tc.function.arguments) cur.arguments += String(tc.function.arguments);
        toolAcc.set(idx, cur);
      }
    }
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens ?? promptTokens;
      completionTokens = json.usage.completion_tokens ?? completionTokens;
    }
  }
  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, c]) => ({
      id: c.id || `call_${idx}`,
      name: c.name,
      arguments: c.arguments || '{}',
    }))
    .filter((c) => c.name);
  // 只调工具、还没产出正文的轮次是合法的：有 toolCalls 就不算空响应
  if (!text && !toolCalls.length) throw new AppError('E_UPSTREAM', 'LLM 流式返回空内容', { provider: prov.id });
  return { text, promptTokens, completionTokens, finishReason, toolCalls, latencyMs: Date.now() - t0 };
}

/** Anthropic 流式（messages + SSE） */
export async function anthropicChatStream(p) {
  const prov = resolveProvider(p.provider || 'claude');
  if (!prov.hasKey) throw new AppError('E_LLM_KEY_MISSING', `provider「${prov.id}」未配置 apiKey`, { provider: prov.id });
  const t0 = Date.now();
  const res = await postStream(`${prov.baseUrl}/messages`, {
    headers: { 'x-api-key': prov.apiKey, 'anthropic-version': '2023-06-01' },
    body: {
      model: p.model,
      max_tokens: p.maxTokens || 1600,
      temperature: p.temperature ?? 0.3,
      stream: true,
      ...(p.system ? { system: p.system } : {}),
      messages: p.messages.filter((m) => m.role !== 'system'),
    },
    timeoutMs: p.timeoutMs,
    signal: p.signal,
  });
  let text = '';
  let promptTokens = null;
  let completionTokens = null;
  for await (const data of sseEvents(res)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
      text += json.delta.text;
      if (p.onDelta) p.onDelta(json.delta.text);
    }
    if (json.type === 'message_start' && json.message && json.message.usage) promptTokens = json.message.usage.input_tokens ?? null;
    if (json.type === 'message_delta' && json.usage) completionTokens = json.usage.output_tokens ?? null;
  }
  if (!text) throw new AppError('E_UPSTREAM', 'Claude 流式返回空内容', { provider: prov.id });
  return { text, promptTokens, completionTokens, finishReason: null, latencyMs: Date.now() - t0 };
}

/**
 * 统一流式入口：按 provider 的 protocol 分派。
 * Gemini 走非流式再一次性推 delta（如实记录，不假装流式）。
 */
export async function streamChat(p) {
  const prov = resolveProvider(p.provider);
  if (prov.protocol === 'anthropic') return anthropicChatStream(p);
  if (prov.protocol === 'gemini') {
    const flat = p.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    const out = await geminiChat({ provider: p.provider, model: p.model, prompt: flat, maxTokens: p.maxTokens, temperature: p.temperature, signal: p.signal });
    if (p.onDelta) p.onDelta(out.text);
    return out;
  }
  return openaiChatStream(p);
}
