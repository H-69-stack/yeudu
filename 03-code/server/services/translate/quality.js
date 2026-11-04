/**
 * 送翻选择 + 译文体检：**唯一阈值来源**（pipeline 落库前、cli/lint-translations.js 扫描共用）。
 *
 * 线上三类译文事故，全部在这两端兜（送翻前过滤 / 落库前校验）：
 *   A. 图注与图内标注被送翻 → 模型把 `Sensors __+ ---b Actuators` 这类抽取碎片
 *      当成密码去「音译」，产出 `EVRNKSHUHO HGUVVJGF`、`2EVRIWKLQOGDDSHV` 式的拉丁大写垃圾；
 *   B. 页眉/页脚/页码被送翻 → 半翻半留（用户截图里的 `18 SEEE JOURNAL OF …`）；
 *   C. 参考文献被送翻 → 作者名/刊名/页码被改写，引用直接不可用。
 * 这些内容「不送翻」不是为了省 token，而是**根本没有可译的语义**：图内文字是符号碎片，
 * 页眉页脚是跨页重复的栏目信息，公式是符号串，参考文献要求原文照录。
 * 误翻的产物比原文更难读，还会经缓存扩散（一旦写进 translations 就会被反复命中）。
 *
 * 设计约束：
 *  - 判定必须**便宜且确定**：纯正则/计数，不调模型、不联网（pipeline 每批都会跑）。
 *  - 阈值集中在这里，避免「管线放行、巡检判坏」两套口径（旧版巡检与管线各写一套，数字对不上）。
 *  - 宁漏勿错：只在证据充分时拦（低 CJK 占比 + 无空格大写串），把「看着怪但合法」的输出放行；
 *    被拦的段不写缓存、落 dst=null（阅读器显示原文），下一次重翻还会重试——损失可控。
 *
 * 注意（实测结论，别改成"看到大写串就当垃圾"）：按「≥2 个 6 位以上大写串且大写占比 > 0.5」
 * 扫全库 5947 段命中 71 段，其中 70 段是**合法的全大写小标题/页眉**（`II. CONNECTION AND
 * CONTRACT NEGOTIATION`、`IEEE TRANSACTIONS ON COMPUTERS`）。所以大写串只能作为**译文侧**
 * 与低 CJK 占比**同时成立**时的证据，绝不能单独用来判定原文是垃圾。
 */

/** 永不送翻的角色（pipeline 的 SQL 与巡检共用） */
export const NEVER_TRANSLATE_ROLES = Object.freeze([
  'figure',       // 落进图框的段：图区整块以 PDF 原图贴回，框内文字既不译也不再排版
  'figure-label', // 图内文字/图例/坐标轴：符号碎片，没有可译语义；误翻即上面 A 类垃圾
  'header',       // 页眉：跨页重复的栏目信息，模型半翻半留
  'footer',       // 页脚：同上（页码、期刊名）
  'page-number',  // 页码：翻译只会打乱分页标记
  'equation',     // 公式：符号串，翻译必坏（另有 is_math 标记兜底）
  'reference',    // 参考文献：必须原文照录，翻译即销毁可引用性
]);

/** 需要**单独成批**并追加专用提示的角色：图注/表注（要「图 N：」前缀、且不译图内标注） */
export const CAPTION_ROLES = Object.freeze(['caption']);

/**
 * 按**文本内容**识别图注/表注（"Fig. 3 Comparison between …"、"Figure 1: …"、"Table 2. …"）。
 *
 * 为什么不能只看 role：实测本库抽取器把真正的图注标成了 `body`（asset1 的
 * `Fig. 2 A unified framework …`、`Fig. 3 Comparison between …` 都是 body），只有图内标注
 * （`CoT-SC ToT,LMZSP,RAP Prompts`）才标 figure-label。图注与图内标注混在同一个正文批里，
 * 模型会把坐标轴/箭头上的碎片也当正文「翻译」，用户看到的 `EVRNKSHUHO HGUVVJGF` 就是这么来的。
 * 把它单独挑出来、走 caption 批 + 专用提示（不译图内标注、输出「图 N：」前缀），是修复该症状的关键。
 */
/** 图注/表注的「编号头」：`Fig. 3`、`Figure 1:`、`Table 2.`、`图 3`，允许前置 Markdown 记号/项目符号 */
const CAPTION_HEAD =
  /^[\s\-*_`>•]*(?:[Ff][Ii][Gg](?:[Uu][Rr][Ee])?\.?\s*\d+[A-Za-z]?|[Tt][Aa][Bb][Ll][Ee]\s*\d+[A-Za-z]?|图\s*\d+)\s*[:：.．、]?\s+/;
/** 编号头之后必须以大写字母/中文/括号开头（标题式），否则按正文处理 */
const CAPTION_BODY_START = /^[A-Z\u4e00-\u9fff(]/;

export function isCaptionLike(text) {
  const t = String(text == null ? '' : text).trimStart();
  const m = t.match(CAPTION_HEAD);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  // 只认行首（允许 `**`/`_`/`- ` 之类 Markdown 前缀）：正文里"见 Figure 3"不算图注。
  // 编号后必须紧跟「大写开头/中文/括号」的标题式片段——`Figure 4 shows that …` 这种正文句子
  // 会因 `shows` 小写而不命中（宁可漏判成正文，也不要把整句正文塞进图注批改坏）。
  // 剩余长度 ≥ 8 是为了排除 `Fig. 3.` 这种只有编号、无实质内容的残片。
  return CAPTION_BODY_START.test(rest) && rest.length >= 8;
}

/**
 * 由角色表生成 SQL 片段。role 可能为 NULL（旧抽取版本没写这一列），故 coalesce。
 * is_math / is_label 是抽取侧的独立标记，与 role 交叉存在，两条都要保留。
 */
export function translatableSql() {
  const list = NEVER_TRANSLATE_ROLES.map((r) => `'${r}'`).join(',');
  return `is_math = 0 AND is_label = 0 AND coalesce(role,'') NOT IN (${list})`;
}

/**
 * 阈值与理由（改阈值请连同理由一起改，否则后面的人没法判断这些数字是从哪来的）。
 * 实测基线：3532 条历史译文里，正常中文译文的「CJK/(CJK+拉丁字母)」中位数 ≈ 0.97；
 * 整段回退英文或乱码的段普遍 < 0.1。
 */
export const QUALITY = Object.freeze({
  /** 目标语言含中文时，译文里 CJK 字符占「CJK+拉丁字母」的最低比例。0.15 给术语/变量密集的
   *  方法段留足空间（如「使用 BERT 在 SQuAD 上微调，F1 提升 3.2」这种英中混排），
   *  又能拦住「整段没译」与「音译成乱码」两类。 */
  minCjkRatio: 0.15,
  /** 「无空格拉丁大写串」的长度阈值：自然英文里 5 位以上全大写基本只出现在缩写
   *  （IEEE/GPU/arXiv 都 ≤4 位），连续 5 位以上且成段出现基本只有 CMap 损坏的抽取文本。 */
  latinRunLength: 5,
  /** 至少要命中 2 个「≥5 位的无空格大写串」才算乱码墙：单个缩写（`RFC822`、`ANNOUNCED-AWARD`）
   *  在正常译文里也很常见，命中 1 个就报警会产生大量假阳性（实测 148 例外，绝大多数是
   *  `REQUIRE PROCEDURE NAME`、`IEEE JOURNAL OF…` 这类**该保留**的术语/引文）。 */
  garbageRunMin: 2,
  /** 垃圾串必须与「低中文占比」同时成立才判失败：CJK < 35% 说明这一段基本没有中文，
   *  再叠加大写串才敢认定是 CMap 损坏/整段没译；只按大写串判定会误杀
   *  「中文正文里刻意保留的英文术语」（实测 cjk=82% 的低风险段也含 2 个 ≥5 位大写术语）。 */
  garbageCjkCeiling: 0.35,
  /** 整段英文原样返回（未翻译）判定的最小拉丁字母数：短段（`AGI`、`Table 2`）原样保留
   *  是合理译法，只有长英文整段一字不改才算未翻译。 */
  echoMinLatinLetters: 40,
  /** 原文侧：字母数低于此值（纯数字/符号段）没有可译内容，不送翻。 */
  sourceMinLetters: 1,
});

const CJK_CHARS = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;
const LATIN_LETTERS = /[A-Za-z]/g;
const UPPER_LETTERS = /[A-Z]/g;
const LATIN_UPPER_RUN = new RegExp(`[A-Z]{${QUALITY.latinRunLength},}`, 'g');

/** CJK 占比 = CJK 个数 / (CJK + 拉丁字母)。分母只算字母：数字/标点/公式不该稀释中文比例。 */
export function cjkRatio(text) {
  const s = String(text == null ? '' : text);
  const cjk = (s.match(CJK_CHARS) || []).length;
  const latin = (s.match(LATIN_LETTERS) || []).length;
  const denom = cjk + latin;
  return denom ? cjk / denom : 0;
}

/** 译文的结构化度量（巡检脚本按字段输出，便于用户自己定阈值） */
export function measureTranslation(text) {
  const s = String(text == null ? '' : text);
  const cjk = (s.match(CJK_CHARS) || []).length;
  const latin = (s.match(LATIN_LETTERS) || []).length;
  const upper = (s.match(UPPER_LETTERS) || []).length;
  const runs = s.match(LATIN_UPPER_RUN) || [];
  return {
    chars: s.length,
    cjk,
    latin,
    cjkRatio: cjk + latin ? cjk / (cjk + latin) : 0,
    latinRuns: runs.length,
    latinRunMax: runs.reduce((m, r) => Math.max(m, r.length), 0),
    upperShare: latin ? upper / latin : 0,
  };
}

/** 归一化后比较原文/译文（去 Markdown 标记与全部空白），用于抓「整段英文原样返回」 */
function normalizeEcho(s) {
  return String(s == null ? '' : s)
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 译文体检（唯一的输出侧判定）。
 * 返回 `{ok, codes, metrics}`；`ok=false` 时调用方必须重试一次，二次仍 false → 该段 dst=null。
 * codes 顺序即判定顺序，日志里直接可读：
 *  - EMPTY         引擎返回空/只有空白
 *  - LOW_CJK       中文目标下 CJK 占比 < 0.15（整段没译/音译成乱码）
 *  - LATIN_GARBAGE 连续大写串 ≥2 且整体 CJK 占比 < 35%（中文里夹乱码墙）
 *  - UNTRANSLATED  长英文段落原样返回（≥40 字母且归一化后与原文相同）
 * @param {{src?:string, dst?:string, tgtLang?:string}} p
 */
export function screenTranslation({ src = '', dst = '', tgtLang = 'zh-CN' } = {}) {
  const text = String(dst == null ? '' : dst).trim();
  const metrics = measureTranslation(text);
  const codes = [];
  if (!text) codes.push('EMPTY');
  else {
    const zhTarget = String(tgtLang || '').toLowerCase().startsWith('zh');
    if (zhTarget && metrics.cjkRatio < QUALITY.minCjkRatio) codes.push('LOW_CJK');
    // 判定顺序固定：先空、再低中文、再乱码墙、最后原样回传。乱码墙要求「低中文占比」与
    // 「≥2 个 5 位以上无空格大写串」同时成立（见 QUALITY.garbageCjkCeiling 的理由）。
    if (metrics.latinRuns >= QUALITY.garbageRunMin && metrics.cjkRatio < QUALITY.garbageCjkCeiling) {
      codes.push('LATIN_GARBAGE');
    }
    const srcLatin = (String(src || '').match(LATIN_LETTERS) || []).length;
    if (srcLatin >= QUALITY.echoMinLatinLetters && normalizeEcho(src) && normalizeEcho(src) === normalizeEcho(text)) {
      codes.push('UNTRANSLATED');
    }
  }
  return { ok: codes.length === 0, codes, metrics };
}

/**
 * 原文可翻性（送翻前过滤，pipeline 用）。
 * SQL 已按角色挡掉 NEVER_TRANSLATE_ROLES；这里兜 SQL 之外的两类：
 *  - EMPTY：空/纯空白段（旧 buildBatches 会静默跳过它们，进而导致整批错位）
 *  - NO_LETTERS：只有数字/符号/公式残片，没有可译语义
 * 返回 `{translatable, code}`，code 用于日志聚合（不影响阅读器显示原文）。
 */
export function assessSource(text, role) {
  const s = String(text == null ? '' : text);
  if (NEVER_TRANSLATE_ROLES.includes(String(role || ''))) return { translatable: false, code: 'ROLE_BLOCKED' };
  const t = s.trim();
  if (!t) return { translatable: false, code: 'EMPTY' };
  const cjk = (t.match(CJK_CHARS) || []).length;
  const latin = (t.match(LATIN_LETTERS) || []).length;
  if (cjk + latin < QUALITY.sourceMinLetters) return { translatable: false, code: 'NO_LETTERS' };
  return { translatable: true, code: null };
}

/**
 * 段数对齐：引擎返回条数与请求条数不一致时，**按序对齐、缺失补 null**。
 * 旧实现直接 `throw E_UPSTREAM` 整批重发；若长度相同但内容错位（模型串段），旧实现完全发现不了，
 * 会把「下一段的译文」写进本段——这正是「段落顺序错乱」的根因之一。
 * 补 null 的段不会写缓存，阅读器回落到原文，下一次重翻还会再试。
 * @param {number} expected 请求段数
 * @param {string[]|null} raw 引擎返回
 * @returns {(string|null)[]} 长度恒为 expected
 */
export function alignBatchOutput(expected, raw) {
  const n = Math.max(0, Number(expected) || 0);
  const list = Array.isArray(raw) ? raw : [];
  const out = new Array(n).fill(null);
  for (let i = 0; i < n && i < list.length; i += 1) {
    const v = list[i] == null ? '' : String(list[i]).trim();
    out[i] = v ? v : null;
  }
  return out;
}

/**
 * 切批：**保留 segment 对象**（替代 `buildBatches(texts)` + cursor 回切）。
 * 旧写法里 buildBatches 会跳过空串/纯空白段，而 cursor 仍按返回条数推进，
 * 只要跳过一段，其后所有 batch 的 segment 全部错位一格 → 译文串段。
 * 这里空段直接跳过且**不推进任何指针**（对象一一对应，不可能错位）。
 * @template T
 * @param {T[]} items 形如 {text} 的段对象
 * @param {{maxChars?:number, maxItems?:number}} [limits]
 * @returns {T[][]}
 */
export function chunkSegments(items, { maxChars = 3000, maxItems = 6 } = {}) {
  const chars = Math.max(50, Number(maxChars) || 3000);
  const per = Math.max(1, Number(maxItems) || 6);
  const out = [];
  let cur = [];
  let len = 0;
  for (const it of items || []) {
    const t = String(it && it.text != null ? it.text : '');
    if (!t.trim()) continue;
    const add = t.length + 2;
    if (cur.length && (cur.length >= per || len + add > chars)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += add;
  }
  if (cur.length) out.push(cur);
  return out;
}
