/**
 * 英文单词间距修复（S2.5）。
 *
 * 背景：pdf.js 的 `saveLastChar/shouldAddWhitepsace`（pdf.worker.mjs 里
 * TRACKING_SPACE_FACTOR / NOT_A_SPACE_FACTOR 阈值）在负 `Tw`（字距压缩）的 PDF
 * 上会把空格吞掉，textContent 直接给出 `forcontrollingmobilerobots` 这种粘连词。
 * 公共 API 不透传 `keepWhiteSpace`，所以只能在拿到 str 之后尽力还原。
 *
 * 做法：
 *  1. 先扫**整本文档**建词表；词表分两层：常用词表 + 本文档里“本来就分开”的短词。
 *  2. 用短词表反查“可疑粘连 token”（能干净切回多个小词的长 token）—— 这些 token
 *     不允许进词表，否则词表会被自己的粘连结果污染，切分时反被判成“已知单词”。
 *  3. 对每个不在词表里的长 token 做 DP 切分：命中词表给正分、未知词给重罚、
 *     切得越碎越不划算；最后用覆盖率 + “末片必须成词”两道闸门兜底。
 *
 * 纯 JS、零依赖、确定性（同样输入永远同样输出）。
 */

/** 学术英文高频词（补足文档词表覆盖不到的功能词/常见词形） */
const COMMON_WORDS = `
a an the and or but if then than that this these those there here which who whom whose what when where why how
is are was were be been being am do does did done doing have has had having will would shall should can could may
might must not no nor so as at by for from in into of off on onto out over per to up upon via with within without
about above across after against along among around before behind below beneath beside between beyond during except
inside like near outside since through throughout till toward under until
we our us i you your he she it they them their its his her one ones other others another each every both few many
more most less least several some such only also just even still yet already again further once twice
paper papers work works study studies research approach approaches method methods model models system systems
design designs result results problem problems task tasks robot robots control controls learning algorithm algorithms
data information knowledge process processes structure structures function functions level levels layer layers module
modules behavior behaviors behaviour behaviours architecture architectures network networks agent agents
capability capabilities human humans machine machines computer computers world worlds example examples case cases
type types part parts set sets group groups number numbers value values time times place places way ways
new old first second third last next same different possible impossible important key main high low large small long
short good better best bad worse worst able unable available general specific particular total partial full empty
reduces reduce reduced increases increase increased allows allow allowed requires require required requirement
requirements provides provide provided produces produce produced contains contain contained includes include
included represents represent make makes made use uses used using build builds built get gets got give gives given
take takes taken find finds found show shows shown see sees seen know knows known think thinks thought say says said
call calls called name named mean means meant become becomes became keep keeps kept start starts started stop stops
stopped remain remains remained appear appears appeared look looks looked turn turns turned move moves moved happen
happens happened need needs needed try tries tried ask asks asked tell tells told put puts lead leads led run runs ran
base bases based form forms formed view views viewed follow follows followed consist consists consisted correspond
corresponds corresponding depend depends depended derive derives derived describe describes described description
explain explains explained identify identifies identified indicate indicates indicated involve involves involved
lack lacks lacking limit limits limited obtain obtains obtained occur occurs occurred offer offers offered perform
performs performed place places placed plan plans planned prefer prefers preferred prevent prevents prevented
purpose purposes raise raises raised reach reaches reached regard regards regarded relate relates related rely relies
relied report reports reported respect respects respected respond responds responded return returns returned reveal
reveals revealed satisfy satisfies satisfied select selects selected send sends sent serve serves served share shares
shared solve solves solved specify specifies specified state states stated suggest suggests suggested support
supports supported tend tends tended test tests tested treat treats treated understand understands understood vary
varies varied wait waits waited want wants wanted watch watches watched write writes written
author authors editor editors abstract introduction conclusion conclusions summary references appendix
section sections figure figures table tables equation equations chapter item items note notes remark remarks
analogously similarly differently namely indeed actually essentially basically generally formally virtually
mobile autonomous asynchronous bandwidth channel channels competence competences instance instances communicate
communicates communication suppress suppresses suppressed suppressing subsumes subsume traditional decomposition
layered robust flexible wander wanders wandering laboratory laboratories office offices building buildings map maps
arm arms sensor sensors actuator actuators perception planning execution monitor monitors monitoring change changes
changed explore explores exploring avoid avoids avoiding achieve achieves achieving multiple point points track
tracks pick picks picking pause pauses resume resumes whether otherwise rather instead therefore however thus hence
moreover furthermore nevertheless accordingly consequently likewise specifically generally usually typically often
sometimes always never almost nearly roughly approximately plus minus times divided equals greater lesser
high-level low-level higher-level lower-level task-achieving real-time low-bandwidth self-contained
intend intends intended intending tend tends tended tending extend extends extended attending attempt attempts
attempted contain contains contained maintain maintains maintained obtain gain gains gained remain include
achieve achieved consider considered considering require requires requiring provide provides providing
develop develops developed developing implement implements implemented implementing represent represents
represented produce produces producing introduce introduces introduced introducing reduce reduces reducing
increase increases increasing decrease decreases decreasing measure measures measured measuring compute
computes computed computing estimate estimates estimated estimating evaluate evaluates evaluated evaluating
apply applies applied applying describe describes describing consist consists consisting exist exists existed
existing occur occurs occurring appear appears appearing seem seems seemed belong belongs belonged
result results resulting effect effects affect affects affected approach approaches approached analyze
analyzes analyzed analysis analyses compare compares compared comparing differ differs differed different
following followed follows using usually however therefore various several important general specific
according according to along across among around available available because before behind below between
`

const COMMON = new Set(
  COMMON_WORDS.split(/[\s,]+/)
    .map((w) => w.replace(/[.']+$/, ''))
    .filter((w) => w.length >= 1)
    .map((w) => w.toLowerCase()),
);

const WORD_RE = /^[A-Za-z][A-Za-z'\u2019-]*[A-Za-z]$/;
const ALPHA_RUN_RE = /[A-Za-z][A-Za-z'\u2019-]*/g;
const SINGLE_OK = new Set(['a', 'i']);

/**
 * 高频功能词：`of control` / `in part` / `to the` 这类「虚词 + 实词」的粘连是最常见的一类，
 * 切开后两片里往往只有一片够长，会被下面的「至少两片 ≥4 字母」规则误伤，因此单独放行。
 */
const FUNCTION_WORDS = new Set([
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'and', 'or', 'the', 'a', 'an',
  'is', 'are', 'was', 'were', 'be', 'been', 'we', 'it', 'its', 'as', 'if', 'so', 'do', 'no',
  'up', 'he', 'she', 'my', 'not', 'but', 'that', 'this', 'than', 'then', 'can', 'will',
]);


/** 常见后缀（词形还原兜底 + “不能当未知片”的黑名单） */
const SUFFIXES = ['ations', 'ation', 'ings', 'ing', 'edly', 'ies', 'ied', 'ests', 'est', 'ers', 'er', 'ed', 'es', 's', 'ly', 'al', 'ive', 'ity', 'ment', 'ments', 'ness', 'ful', 'less', 'ion', 'ions'];

/** 纯词尾片段（不能作为“唯一的未知片”，否则会把 requirements 切成 require + ments） */
const SUFFIX_PIECES = new Set(['ations', 'ation', 'ings', 'ing', 'edly', 'ies', 'ied', 'ests', 'est', 'ers', 'er', 'ed', 'es', 's', 'ly', 'al', 'ive', 'ity', 'ment', 'ments', 'ness', 'ful', 'less', 'ion', 'ions', 'ally', 'ously', 'ically', 'ism', 'ist', 'ory', 'ary', 'ance', 'ence', 'ant', 'ent', 'age', 'ery']);

const KNOWN_BONUS = 3.6; // 每片命中词表的固定奖励（鼓励切出真词）
const UNKNOWN_PENALTY = 15; // 未知片重罚（兜底时才允许出现）
const MIN_COVERAGE = 0.6; // 命中词表的字符占比下限
const MAX_RUN = 64;
const MAX_PIECES = 10;

/** 统一的词表形态：`{freq: Map, glue: Set}`，也兼容裸 Map */
function norm(voc) {
  if (!voc) return { freq: new Map(), glue: new Set() };
  if (voc.freq instanceof Map) return voc;
  return { freq: voc, glue: new Set() };
}

/** 词频（0 = 词表里没有） */
function freqOf(word, voc) {
  const { freq } = norm(voc);
  return (freq.get(word.toLowerCase()) || 0) + (COMMON.has(word.toLowerCase()) ? 4 : 0);
}

/** 是否被判定为“粘连产物”（不可信 token） */
function isGlue(word, voc) {
  return norm(voc).glue.has(word.toLowerCase());
}

/**
 * 词的“可信度”：1 = 词表直查命中；0.5~0.65 = 词形还原后命中；0 = 未知。
 * 粘连 token 一律按未知处理。
 */
function morphScore(word, voc) {
  const w = word.toLowerCase();
  if (isGlue(w, voc)) return 0;
  if (freqOf(w, voc) > 0) return 1;
  if (w.length < 4) return 0;
  for (const suf of SUFFIXES) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, w.length - suf.length);
    if (stem.length < 3) continue;
    if (freqOf(stem, voc) > 0) return 0.64;
    if (/([bdfglmnprt])\1$/.test(stem) && freqOf(stem.slice(0, -1), voc) > 0) return 0.62;
    if (stem.endsWith('e') && freqOf(stem.slice(0, -1), voc) > 0) return 0.6;
    if (stem.endsWith('i') && freqOf(`${stem.slice(0, -1)}y`, voc) > 0) return 0.6;
  }
  return 0;
}

/** 单片得分：null = 这一片不允许 */
function pieceValue(piece, voc, isFirst, allowCaps = false) {
  const len = piece.length;
  const lower = piece.toLowerCase();
  if (SUFFIX_PIECES.has(lower)) return null; // 纯词尾不能单独成片
  if (len === 1) return SINGLE_OK.has(lower) ? KNOWN_BONUS : null;
  if (len === 2 && !COMMON.has(lower)) return null; // 两字母片只在常用词表里才可信
  if (!WORD_RE.test(piece)) return null;
  // 词中大写只可能是句首；但整段全大写（标题/页眉）时每片首字母都大写，此时不设限
  if (!allowCaps && /^[A-Z]/.test(piece) && !isFirst) return null;
  const m = morphScore(piece, voc);
  if (m > 0) {
    let v = KNOWN_BONUS * m + Math.log(1 + freqOf(piece, voc));
    if (m < 1 && len < 3) v -= 4;
    return v;
  }
  // 兜底：允许一个“看着像词”的未知片（专有名词/术语/生词）
  if (len < 5 || !/^[a-z]+$/.test(lower)) return null;
  return -UNKNOWN_PENALTY - 0.5 * len;
}

/**
 * 对单个“连续字母片段”做 DP 切分。
 * @param {string} run
 * @param {Map<string,number>|{freq:Map<string,number>,glue:Set<string>}} voc
 * @param {{maxPieces?:number}} [opts]
 * @returns {string[]|null} 切分结果；`null` 表示无法（或不该）切
 */
export function segmentRun(run, voc, opts = {}) {
  const n = run.length;
  const maxPieces = opts.maxPieces ?? Math.min(16, Math.max(4, Math.ceil(n / 3)));
  if (n < 5 || n > MAX_RUN) return null;
  // 全大写片段（页眉 "BROOKS:AROBUSTLAYERED..."、标题 "AROBOTCONTROL..."）允许每片首字母大写
  const allowCaps = /[A-Z]/.test(run) && run === run.toUpperCase();

  // dp[i] = 从 i 到结尾的最优切法
  const dp = new Array(n + 1).fill(null);
  dp[n] = { score: 0, pieces: 0, cuts: [n], unknown: 0, knownChars: 0 };

  for (let i = n - 1; i >= 0; i -= 1) {
    let best = null;
    for (let len = 1; len <= Math.min(24, n - i); len += 1) {
      const j = i + len;
      const next = dp[j];
      if (!next) continue;
      if (next.pieces + 1 > maxPieces) continue;
      const piece = run.slice(i, j);
      const value = pieceValue(piece, voc, i === 0, allowCaps);
      if (value === null) continue;
      const score = next.score + value;
      if (!best || score > best.score) {
        const known = value > 0;
        best = {
          score,
          pieces: next.pieces + 1,
          cuts: [j, ...next.cuts],
          unknown: next.unknown + (known ? 0 : 1),
          knownChars: next.knownChars + (known ? len : 0),
        };
      }
    }
    dp[i] = best;
  }

  const res = dp[0];
  if (!res || res.pieces < 2) return null;
  const out = [];
  let prev = 0;
  for (const cut of res.cuts) {
    if (cut > prev) out.push(run.slice(prev, cut));
    prev = cut;
  }
  if (out.length < 2) return null;
  // 严格模式下末片必须是词表里真实存在的词（不能只靠词形还原）：否则 `computational`
  // 会被切成 `com put a tional`（`tional` 靠 -al 词尾还原成 `tion` 而“看起来像词”）。
  // 宽松模式（粘连 token）里末片恰好常是词表没有的生词（`...layers subsuming`），
  // 由 plausibleGlueSplit 的结构约束兜底，不在这里卡死。
  if (opts.requireAllKnown && freqOf(out[out.length - 1], voc) <= 0) return null;
  // 闸门：最多容忍一个未知片，且已知词覆盖率不能太低
  if (res.unknown > (opts.requireAllKnown ? 0 : 1)) return null;
  if (res.knownChars / n < MIN_COVERAGE) return null;
  if (!plausibleGlueSplit(out, n, opts.requireAllKnown === true)) return null;
  return out;
}

/**
 * 切分结果的“像不像话”校验：错切比粘连更难读，宁可整段不切。
 * 实测反例：`Thesuppression` → `The suppress i on`、`belowthat` → `be low that`、
 * `outputscan` → `out puts can`（源文档里 suppression/below/outputs 都没在别处出现过，
 * 词表查不到，于是被挤成“全片成词”的其它切法）。
 * 宽松模式（只对词表判定过的粘连 token 启用）额外要求至少两片 ≥4 字母。
 * @param {string[]} pieces
 * @param {number} n 原片段长度
 * @param {boolean} strict 是否为“全片成词”的严格模式
 */
function plausibleGlueSplit(pieces, n, strict) {
  for (let i = 0; i < pieces.length; i += 1) {
    const p = pieces[i];
    // 单字母 `i` 只可能是句首的代词 I；出现在词中就是碎渣
    if (p.toLowerCase() === 'i' && i > 0) return false;
    if (strict) continue;
    // 中间不许出现 1~2 字母的碎渣片；长片段至少要有两片 ≥4 字母的真词
    if (p.length <= 2 && i > 0 && !COMMON.has(p.toLowerCase())) return false;
  }
  if (n <= 8) return strict ? true : pieces.length <= 3;
  if (strict) {
    // 严格模式也要挡一下“全是短词”的切法：`outputscan` → `out puts can` 每片都成词，
    // 但 10 个字母里没有一片超过 4 个字母，更像一个拼错的整词。
    return pieces.some((p) => p.length >= 5);
  }
  if (pieces.filter((p) => p.length >= 4).length >= 2) return true;
  // 「虚词 + 实词」两片式：`ofcontrol` → `of control`、`inthe` 这类在真实 PDF 里极常见，
  // 但按「两片 ≥4 字母」会被判不合格（`of` 只有 2 个字母），于是整段粘连永远切不开。
  return pieces.length === 2 && FUNCTION_WORDS.has(pieces[0].toLowerCase()) && pieces[1].length >= 4;
}

/**
 * 建文档词表。
 * @param {Array<{items:Array<{str:string}>}>} rawPages
 * @returns {{freq:Map<string,number>, glue:Set<string>}}
 */
export function buildVocabulary(rawPages) {
  const counts = new Map();
  for (const page of rawPages || []) {
    // 连字符跨行断词（"computa-" + "tional"）会在词表里塞进 `tional` 这种「词尾碎片」；
    // 碎片一旦进了词表，`requireAllKnown` 的切分就会把完整单词反过来切碎
    // （实测 3.1 的 `computational` 被切成 `com put a tional`）。所以碎片一律不计数。
    let prevEndsHyphen = false;
    for (const it of page?.items || []) {
      const s = typeof it?.str === 'string' ? it.str : '';
      if (!s) continue;
      const toks = s.split(/[\s\u00a0]+/).filter(Boolean);
      // 纯空白 item（pdf.js 常把词间空隙单独发一个 " "）不改变「上一项是否以连字符结尾」
      if (!toks.length) continue;
      toks.forEach((tok, ti) => {
        if (ti === 0 && prevEndsHyphen) return;
        if (/[-\u00ad\u2010]$/.test(tok)) return;
        const m = tok.match(ALPHA_RUN_RE);
        if (!m) return;
        const w = m[0].toLowerCase().replace(/['\u2019]s$/, '');
        if (w.length < 2) return;
        counts.set(w, (counts.get(w) || 0) + 1);
      });
      prevEndsHyphen = /[-\u00ad\u2010]\s*$/.test(s);
    }
  }

  // 第一层：可信短词（常用词表，或不太长且出现过 ≥2 次）
  const base = new Map();
  for (const [w, f] of counts) {
    if (COMMON.has(w)) base.set(w, f);
    else if (w.length <= 9 && f >= 2) base.set(w, f);
  }

  // 第二层：拿短词表反查粘连 token（词形合法的词不参与，避免把 implementation 拆碎）
  const glue = new Set();
  for (const [w] of counts) {
    if (w.length < 8 || COMMON.has(w) || base.has(w)) continue;
    const probeVoc = { freq: base, glue: new Set() };
    if (morphScore(w, probeVoc) > 0) continue; // 形如 xxx-ation / xxx-ing 的合法派生词
    if (segmentRun(w, probeVoc)) glue.add(w);
  }

  // 最终词表：短词 + 未被判为粘连的长 token
  const freq = new Map();
  for (const [w, f] of counts) {
    if (glue.has(w)) continue;
    freq.set(w, f);
  }
  for (const [w, f] of base) if (!freq.has(w)) freq.set(w, f);
  return { freq, glue };
}

/**
 * 修掉「短词被空格劈开」的另一类损伤。
 *
 * pdf.js 的空白判定是双向的：阈值偏高会吞掉词间空格（`forcontrol`），
 * 判定到「小间隙」时又会往词**内部**插空格 —— 本库实测第 1 页 `is` 被拆成
 * 独立的 item `"i s"`，最后译成「最终，它 intended 用于控制…」这种半英半中的句子。
 * 只处理「1 个字母 + 1~2 个字母」且拼回去是常用词的情况（is/in/as/on/to/of/it），
 * 其余一律不动，避免把 `a little` 这类正常搭配揉在一起。
 * @param {string} text
 * @returns {string}
 */
export function fixSplitLetters(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\b([A-Za-z]) ([A-Za-z]{1,2})\b/g, (m, a, b) => {
    const joined = (a + b).toLowerCase();
    return COMMON.has(joined) ? a + b : m;
  });
}

/**
 * 修复一段文本里被吞掉的空格。
 * @param {string} text
 * @param {Map<string,number>|{freq:Map<string,number>,glue:Set<string>}} voc
 * @returns {string}
 */
export function restoreSpaces(text, voc) {
  if (!text || typeof text !== 'string') return text;
  const dejoined = fixSplitLetters(text);
  if (!/[A-Za-z]{5,}/.test(dejoined)) return dejoined;
  text = dejoined;

  const parts = text.split(/(\s+)/);
  let changed = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || /^\s+$/.test(part)) continue;
    let out = '';
    let cursor = 0;
    let local = false;
    for (const run of part.match(ALPHA_RUN_RE) || []) {
      const idx = part.indexOf(run, cursor);
      out += part.slice(cursor, idx);
      cursor = idx + run.length;
      // 词表层已经把这个 token 判为「粘连产物」时，才允许“一片未知”的宽松切分：
      // 否则 `layeredwithhigherlevellayerssubsuming` 会因 `subsuming` 不在词表里而整段不切。
      // 非粘连 token 仍用严格模式（全片成词），以保住 `applicability` 这类完整单词。
      const gluey = isGlue(run, voc);
      const trusted = !gluey && (run.length < 5 || morphScore(run, voc) > 0);
      if (trusted) {
        out += run;
        continue;
      }
      const pieces = segmentRun(run, voc, { requireAllKnown: !gluey });
      if (pieces && pieces.length >= 2) {
        out += pieces.join(' ');
        local = true;
      } else {
        out += run;
      }
    }
    if (!local) continue;
    parts[i] = out + part.slice(cursor);
    changed = true;
  }
  return changed ? parts.join('') : text;
}

/**
 * 修复一页 items 的 str（返回新数组，不改原数组）。
 * @param {Array<{str?:string}>} items
 * @param {Map<string,number>|{freq:Map<string,number>,glue:Set<string>}} voc
 */
export function restoreSpacesInItems(items, voc) {
  if (!Array.isArray(items)) return items;
  let dirty = false;
  const next = items.map((it) => {
    const s = typeof it?.str === 'string' ? it.str : '';
    // 这里不能再加「至少 5 个连续字母」的前置过滤：
    // 被劈开的短词（"i s" → "is"）正好不满足该条件，也正是最显眼的那类损伤。
    if (!s || !/[A-Za-z]/.test(s)) return it;
    const fixed = restoreSpaces(s, voc);
    if (fixed === s) return it;
    dirty = true;
    return { ...it, str: fixed };
  });
  return dirty ? next : items;
}

/** 供测试/诊断使用 */
export const _internal = { COMMON, WORD_RE, KNOWN_BONUS, UNKNOWN_PENALTY, morphScore, freqOf, isGlue };
