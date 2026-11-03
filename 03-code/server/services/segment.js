/**
 * 文本清洗与切分（§16.1 直接搬 `lib/segment.js`，零宿主依赖）。
 *
 * 与原始文件的两处差异（有意为之，均记录在 STATUS.md）：
 *  ① `cleanPageText` 的归一化用 NFKC 而非 NFC —— 设计要求 NFKC（§12.1 / §16.2 S5），
 *    且 NFKC 会把 PDF 里常见的 ﬁ/ﬂ 连字展开成 fi/fl，对翻译与检索都更有利。
 *  ② 函数导出方式从 `ZTL.Segment = (function(){...})()` 改为 ESM 具名导出，逻辑一字未改。
 */

const CJK_PUNCT = '。！？；…';
const ABBREV = new Set([
  'e.g', 'i.e', 'eg', 'ie', 'et al', 'al', 'etc', 'vs', 'fig', 'figs', 'eq', 'eqn', 'eqns',
  'no', 'nos', 'ref', 'refs', 'cf', 'approx', 'ca', 'dr', 'prof', 'mr', 'mrs', 'ms', 'st',
  'sect', 'vol', 'vols', 'pp', 'p', 'eds', 'ed', 'inc', 'ltd', 'min', 'max', 'tab', 'ch', 'sec',
]);

/**
 * 清洗从 PDF 抽取出来的文本：
 * - 合并被换行拆开的连字符单词（analy- sis → analysis）
 * - 统一空白、去软连字符、去页码行
 * @param {string} text
 * @param {{fixHyphenation?:boolean}} [options]
 * @returns {string}
 */
export function cleanPageText(text, options) {
  const fixHyphen = !options || options.fixHyphenation !== false;
  let t = String(text == null ? '' : text);
  t = t.normalize('NFKC');
  t = t.replace(/^\s*\d{1,3}\s*$/gm, '');
  if (fixHyphen) {
    t = t.replace(/([\p{Ll}])[-\u2010\u2011]\s+([\p{Ll}])/gu, '$1$2');
  }
  t = t.replace(/\u00ad/g, '');
  t = t.replace(/[ \t\u00a0]+/g, ' ');
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * 单段清洗（段落级）：与 cleanPageText 共用同一套规则，但不做页码行删除之外的页面级折叠。
 * @param {string} text
 * @returns {string}
 */
export function cleanParagraphText(text) {
  return cleanPageText(text, { fixHyphenation: true })
    .replace(/\n+/g, ' ')
    // pdf.js 会把「右引号/右括号 + 句末标点」与下一个单词粘在一起（`“wires.”There is no…`），
    // 中文译文里会表现为两个词直接相连，这里补回被吞掉的空格。
    .replace(/([.!?]["”'’)\]])(?=[A-Z])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一段文本拆成句子（对学术文本中的缩写、小数、人名首字母做了保护）
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  let buf = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    buf += ch;
    if (ch === '\n') {
      out.push(buf);
      buf = '';
      continue;
    }
    const isCJK = CJK_PUNCT.indexOf(ch) >= 0;
    // 分号**不是**句末：把 "… distributed; there is neither global control …" 切开，
    // 会让后半段变成"小写开头的半句"，翻译时模型会自行补全前半句 → 相邻译文互相吞并。
    const isLatin = '.!?'.indexOf(ch) >= 0;
    if (!isCJK && !isLatin) continue;
    let j = i + 1;
    let spaces = '';
    while (j < src.length && /\s/.test(src[j])) {
      spaces += src[j];
      j += 1;
    }
    if (j >= src.length) {
      out.push(buf + spaces);
      buf = '';
      break;
    }
    if (isCJK) {
      out.push(buf + spaces);
      buf = '';
      i = j - 1;
      continue;
    }
    let shouldSplit = false;
    if (spaces.indexOf('\n') >= 0) {
      shouldSplit = true;
    } else if (spaces.length > 0) {
      const left = src.slice(Math.max(0, i - 24), i + 1);
      const m = left.match(/([A-Za-z][A-Za-z.]*)$/);
      const token = m ? m[1].toLowerCase().replace(/\.$/, '') : '';
      const isAbbrev = ABBREV.has(token) || /^[a-z]$/.test(token);
      const prevDigit = /[0-9]$/.test(src.slice(0, i));
      const nextDigit = /[0-9]/.test(src[j]);
      shouldSplit = !(isAbbrev || (prevDigit && nextDigit));
    }
    if (shouldSplit) {
      out.push(buf + spaces);
      buf = '';
      i = j - 1;
    }
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 文本 → 段落数组（必要时把超长段落按句子再切分）
 * @param {string} pageText
 * @param {{maxChars?:number}} [options]
 * @returns {string[]}
 */
export function splitParagraphs(pageText, options) {
  const maxChars = (options && options.maxChars) || 600;
  const raw = String(pageText == null ? '' : pageText).split(/\n+/);
  const out = [];
  for (const p of raw) {
    const para = p.replace(/\s+/g, ' ').trim();
    if (!para) continue;
    if (para.length <= maxChars) {
      out.push(para);
      continue;
    }
    const sentences = splitSentences(para);
    let buf = '';
    for (const s of sentences) {
      if (buf && buf.length + 1 + s.length > maxChars) {
        out.push(buf);
        buf = s;
      } else {
        buf = buf ? `${buf} ${s}` : s;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/**
 * 把段落按「单请求最大字符数 / 最大条目数」打包成批次。
 * 边界：单个超长段落独占一批（不切断原文，交给引擎整段处理）；空串被跳过。
 * @param {string[]} paragraphs
 * @param {{maxChars?:number, maxItems?:number}} [options]
 * @returns {string[][]}
 */
export function buildBatches(paragraphs, options) {
  const maxChars = (options && options.maxChars) || 1500;
  const maxItems = (options && options.maxItems) || 1;
  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const p of paragraphs) {
    if (!p || !String(p).trim()) continue; // 空段不占批次
    const len = p.length + 1;
    const full = cur.length && (curLen + len > maxChars || cur.length >= maxItems);
    if (full) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(p);
    curLen += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * 生成「编号段落」提示词正文，供大模型逐条翻译（与插件字节一致，解析率依赖它）
 * @param {string[]} items
 * @returns {string}
 */
export function buildNumberedPrompt(items) {
  return items.map((t, i) => `${i + 1}. ${t}`).join('\n');
}

/**
 * 解析大模型返回的「编号段落」结果。
 * 覆盖率 < 60% 视为解析失败（返回 null），由上层降级为逐段重试。
 * @param {string} text
 * @param {number} count
 * @returns {(string|null)[]|null}
 */
export function parseNumberedResult(text, count) {
  let body = String(text == null ? '' : text).trim();
  body = body.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  const lines = body.split(/\n/);
  const slots = new Array(count).fill(null);
  let lastIndex = -1;
  let matched = 0;
  for (const line of lines) {
    const m = line.match(/^\s*#{0,3}\s*\[?(\d{1,3})\]?\s*[.、)．:：]\s*(.*)$/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < count) {
        slots[idx] = m[2].trim();
        lastIndex = idx;
        matched += 1;
      } else {
        lastIndex = -1;
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (lastIndex >= 0) {
      // 续行用换行连接（而非空格）：保留模型输出的 Markdown 列表/引用结构，
      // 普通正文在 Markdown 渲染时换行即软换行（等价于空格），观感不变。
      slots[lastIndex] = (slots[lastIndex] ? `${slots[lastIndex]}\n` : '') + trimmed;
    }
  }
  if (matched < Math.max(1, Math.ceil(count * 0.6))) return null;
  return slots.map((s) => (s == null ? '' : s));
}

/** 把模型返回的多行结果合并为单段（去掉硬换行） */
export function unwrap(text) {
  return String(text == null ? '' : text)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 字符数合计 */
export function countChars(list) {
  return (list || []).reduce((sum, s) => sum + (s ? s.length : 0), 0);
}

export default {
  cleanPageText,
  cleanParagraphText,
  splitSentences,
  splitParagraphs,
  buildBatches,
  buildNumberedPrompt,
  parseNumberedResult,
  unwrap,
  countChars,
};
