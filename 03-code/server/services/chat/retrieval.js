/**
 * 检索决策与跨语言兜底（§9.1.4 [B] / D11 / D22）。
 *
 * 两条确定性规则（不用模型做决策）：
 *  ① 命中率规则：本次问题在已有检索块里的关键词命中率 < 阈值 → 需要追加检索。
 *  ② 打转检测：同一 chat 内连续两次相同 fingerprints → 跳过检索，并在上下文里加一行确定性说明。
 * 一条兜底（用廉价档 LLM，只此一处）：
 *  ③ 双索引都 0 命中且问题含 CJK → 把问题改写成英文关键词重试一次；仍 0 命中就返回 0，**不许编**。
 */
import crypto from 'node:crypto';
import { searchSegments, toFtsText } from '../fts.js';
import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { openaiChat, geminiChat, anthropicChat, resolveProvider } from '../llm/client.js';
import { resolveModel } from '../translate/engines/registry.js';
import { mockEnabled } from '../translate/engines/registry.js';

const log = createLogger('retrieval');

const CJK_RE = /[\p{Script=Han}]/u;

/** 关键词命中率：查询 token 有多少比例出现在已有块里（确定性，用于「要不要再检索」） */
export function keywordHitRatio(query, blocks) {
  const tokens = toFtsText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  const hay = (blocks || []).map((b) => toFtsText(b.text || '')).join(' ');
  const hit = tokens.filter((t) => hay.includes(t)).length;
  return hit / tokens.length;
}

/** 检索指纹（打转检测用） */
export function retrievalFingerprint(query, selectionIds) {
  return crypto
    .createHash('sha256')
    .update(`${String(query || '').trim()}|${(selectionIds || []).slice().sort().join(',')}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * 基础检索（双索引）。
 * @param {number} assetId
 * @param {string} query
 * @param {{topK?:number}} [opts]
 */
export function search(assetId, query, opts = {}) {
  return searchSegments(assetId, query, { topK: opts.topK || config.chat.retrieveTopK });
}

/**
 * 把中文问题改写成英文关键词（廉价档，单次 ≤100 tokens）。
 * mock 模式下返回确定性的假关键词（只为把链路跑通，不冒充真实模型结果）。
 * @param {string} query
 * @returns {Promise<{keywords:string, engine:string, mocked:boolean}>}
 */
export async function rewriteToEnglishKeywords(query) {
  if (mockEnabled()) {
    // 说明：mock 返回固定英文关键词，仅用于验证「改写 → 重检索」链路
    return { keywords: 'workflow orchestration multi-agent agent', engine: 'mock', mocked: true };
  }
  const provider = config.chat.provider || 'deepseek';
  const model = resolveModel(provider) || config.chat.model || 'deepseek-chat';
  const prov = resolveProvider(provider);
  if (!prov.hasKey) {
    // 没有 key 时不做改写（不静默用一个假关键词去搜）
    return { keywords: '', engine: provider, mocked: false, skipped: 'no-key' };
  }
  const prompt =
    'Translate the following research question into 3-8 English search keywords for a full-text index. ' +
    'Output keywords only, separated by spaces, no punctuation, no explanation.\n\nQuestion: ' +
    String(query || '').slice(0, 400);
  const messages = [{ role: 'user', content: prompt }];
  // 硬约束：≤100 tokens 输出、≤3s 墙钟、失败不重试（不再花第二次钱）
  const opts = { provider, model, maxTokens: 100, temperature: 0, timeoutMs: 3000, retry: false };
  let text = '';
  if (prov.protocol === 'gemini') {
    text = (await geminiChat({ ...opts, prompt })).text;
  } else if (prov.protocol === 'anthropic') {
    text = (await anthropicChat({ ...opts, prompt })).text;
  } else {
    text = (await openaiChat({ ...opts, messages })).text;
  }
  const keywords = String(text || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { keywords, engine: provider, mocked: false };
}

/**
 * 检索 + 跨语言兜底（M3 唯一入口，chat 层只调它）。
 * @param {{assetId:number, query:string, topK?:number, allowRewrite?:boolean}} p
 * @returns {Promise<{hits:Array, rewritten:boolean, keywords:string|null, mocked:boolean, reason:string}>}
 */
export async function retrieve({ assetId, query, topK, allowRewrite = true }) {
  // 开关（可在设置页关掉）：关掉后 0 命中就老实返回 0，不去花一次廉价调用
  if (config.chat && config.chat.rewriteFallback === false) allowRewrite = false;
  const first = search(assetId, query, { topK });
  if (first.length) return { hits: first, rewritten: false, keywords: null, mocked: false, reason: 'hit' };

  const hasCjk = CJK_RE.test(String(query || ''));
  if (!allowRewrite || !hasCjk) {
    return { hits: [], rewritten: false, keywords: null, mocked: false, reason: 'no-hit-no-rewrite' };
  }
  let rw;
  try {
    rw = await rewriteToEnglishKeywords(query);
  } catch (e) {
    log.warn('retrieval.rewrite_failed', { message: e.message, code: e.code });
    return { hits: [], rewritten: false, keywords: null, mocked: false, reason: `rewrite-failed:${e.code || 'error'}` };
  }
  if (!rw.keywords) {
    return { hits: [], rewritten: false, keywords: null, mocked: false, reason: `rewrite-${rw.skipped || 'empty'}` };
  }
  const second = search(assetId, rw.keywords, { topK });
  log.info('retrieval.rewritten', { assetId, keywords: rw.keywords, hits: second.length, mocked: rw.mocked });
  return {
    hits: second,
    rewritten: true,
    keywords: rw.keywords,
    mocked: rw.mocked,
    reason: second.length ? 'rewritten-hit' : 'rewritten-no-hit',
  };
}

/**
 * 是否需要在已有块的基础上追加检索（§9.1.4 [B]）。
 * @param {{query:string, blocks:Array, fingerprint:string, lastFingerprint:string|null}} p
 */
export function decideRetrieval({ query, blocks, fingerprint, lastFingerprint }) {
  if (!blocks || !blocks.length) return { need: true, reason: 'no-blocks' };
  if (fingerprint && fingerprint === lastFingerprint) {
    return { need: false, reason: 'same-fingerprint' };
  }
  const ratio = keywordHitRatio(query, blocks);
  if (ratio < (config.chat.minKeywordHitRatio ?? 0.3)) {
    return { need: true, reason: `keyword-hit-ratio=${ratio.toFixed(2)}` };
  }
  return { need: false, reason: `keyword-hit-ratio=${ratio.toFixed(2)}` };
}
