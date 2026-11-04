/**
 * 多段合批的公共实现（§16.1 搬 llm.js 的 translateItems 语义）。
 *
 * 关键点（这条是「提速核心」也是「不报废整批」的关键）：
 *  - 1 段：直接单段请求。
 *  - N 段：用编号协议一次请求；解析失败/缺项 → **逐段补译**，而不是整批失败。
 *  - 网络/限流类异常向上抛，由管线做引擎链下移（不在这里偷偷重试，避免放大计费）。
 */
import { buildNumberedPrompt, parseNumberedResult } from '../../segment.js';
import {
  CAPTION_INSTRUCTION,
  NUMBERING_INSTRUCTION,
  RETRY_ZH_INSTRUCTION,
  renderPrompt,
} from '../prompts.js';
import { AppError } from '../../../errors.js';

/** 这些错误不该被「逐段重试」掩盖：配置缺失、取消 */
const FATAL = new Set(['E_LLM_KEY_MISSING', 'E_ENGINE_UNCONFIGURED', 'E_CANCELED']);

/**
 * 批次级附加约束（追加在 prompt 最末）：
 *  - kind==='caption' → 图注专用要求（「图 N：」起行、不译图内标注）；
 *  - strict=true      → 体检失败后的严格重试（必须输出中文，见 pipeline 的二次校验）。
 * 两者可叠加（图注批被体检打回时）。
 */
function extraInstruction(ctx) {
  let s = '';
  if (ctx && ctx.kind === 'caption') s += CAPTION_INSTRUCTION;
  if (ctx && ctx.strict) s += RETRY_ZH_INSTRUCTION;
  return s;
}

/**
 * 清理模型译文：去代码围栏、折叠 3+ 连续空行，但**保留单/双换行**——
 * 这是 Markdown 列表/引用结构赖以还原的关键（unwrap 过去会把它们压成一行）。
 */
function cleanTranslation(s) {
  let t = String(s == null ? '' : s).trim();
  t = t.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/**
 * @param {{items:string[], ctx:Object, call:(prompt:string)=>Promise<string>, template:string}} p
 * @returns {Promise<string[]>}
 */
export async function translateItems({ items, ctx, call, template }) {
  const srcLang = ctx.srcLang || 'auto';
  const tgtLang = ctx.tgtLang || 'zh-CN';
  const one = async (text) => {
    const prompt = renderPrompt({
      template,
      sourceText: text,
      srcLang,
      tgtLang,
      work: ctx.work,
      extra: extraInstruction(ctx),
    });
    const out = await call(prompt);
    const dst = cleanTranslation(out);
    if (!dst) throw new AppError('E_UPSTREAM', '引擎返回空译文（单段）', { engine: ctx.engineId || null });
    return dst;
  };

  if (items.length === 1) return [await one(items[0])];

  const numbered = buildNumberedPrompt(items);
  // 顺序：模板 → 编号协议 → 批次附加约束（附加约束放最后，指令权重最高）
  const prompt =
    renderPrompt({ template, sourceText: numbered, srcLang, tgtLang, work: ctx.work }) +
    NUMBERING_INSTRUCTION +
    extraInstruction(ctx);

  let raw = null;
  try {
    raw = await call(prompt);
  } catch (e) {
    if (e && FATAL.has(e.code)) throw e;
    throw e;
  }

  const parsed = parseNumberedResult(raw, items.length);
  const results = new Array(items.length).fill(null);
  let fallbackCount = 0;
  if (parsed) {
    for (let i = 0; i < items.length; i += 1) {
      const v = parsed[i] ? cleanTranslation(parsed[i]) : '';
      if (v) results[i] = v;
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    if (!results[i]) {
      fallbackCount += 1;
      results[i] = await one(items[i]);
    }
  }
  if (fallbackCount && ctx.onStats) ctx.onStats({ fallbackCount, batchSize: items.length });
  return results;
}
