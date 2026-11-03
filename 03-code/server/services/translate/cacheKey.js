/**
 * 翻译缓存键（内容寻址，§7 / §9.4 / §21 R3）。
 *
 * key = sha256(engine | model | tgtLang | promptFp | extractVersion | normalizedText)
 * 说明（与 §21 R3 对齐）：
 *  - 分隔符用 `\u0000` 而不是 `|`：论文正文里可能出现 `|`，会出现理论上可构造的串冲突。
 *  - **srcLang 不进键**：`auto` 与 `en` 对同一段英文的译文应当一致；进键会让「语言检测规则变一下」就全 miss。
 *  - `extractVersion` 进键：重抽（换 pdfjs 版本/改分段规则）后旧译文不再冒充有效（§19 第 6 条版本绑定）。
 *  - 文本先 NFKC + 空白折叠再 hash：同一段文本在不同 PDF 里的不可见差异不该造成 miss。
 */
import crypto from 'node:crypto';

const SEP = '\u0000';

/** 与 `segment.cleanPageText` 的清洗口径一致（NFKC + 空白折叠），用于稳定 hash */
export function normalizeForHash(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * @param {{engine:string, model:string, tgtLang:string, promptFp:string, extractVersion:number, text:string}} p
 * @returns {string} 64 位 hex
 */
export function buildCacheKey(p) {
  const parts = [
    String(p.engine || ''),
    String(p.model || ''),
    String(p.tgtLang || ''),
    String(p.promptFp || ''),
    String(p.extractVersion ?? ''),
    normalizeForHash(p.text),
  ];
  return crypto.createHash('sha256').update(parts.join(SEP), 'utf8').digest('hex');
}

export { SEP as CACHE_KEY_SEPARATOR };
