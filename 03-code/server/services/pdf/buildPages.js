/**
 * `RawPage[] → ExtractPage[]`（§16.2 S1–S7，纯函数、零 IO）。
 *
 * 这是本项目唯一原创算法层：pdftext.js 不移植（4,666 行，Zotero 阅读器耦合），
 * 改由 pdf.js 的 `getTextContent()` 提供 items，这里做
 *   行聚合 → 栏判定 → 阅读顺序 → 段落合并 → 清洗 → 分段 → 角色判定。
 *
 * 设计原则：
 *  - 全部确定性：同样输入必须逐字节同样输出（extract_version 依赖这一点）。
 *  - 参数全部可配（extract.roleRules / lineGapRatio 等），便于用真实文献调阈值而不改代码。
 *  - isMath 宁宽勿窄：多判一段只是少翻一段，错判会让公式被翻成乱码（§16.5）。
 */
import { cleanParagraphText, splitParagraphs } from '../segment.js';
import { restoreSpaces } from './spaceFix.js';

/** 默认角色判定阈值（§16.2 S7） */
export const DEFAULT_ROLE_RULES = {
  mathNonAlnumRatio: 0.45,
  mathMinSymbols: 2,
  mathDigitRatio: 0.1,
  labelMaxChars: 40,
  headingMaxChars: 90,
};

/**
 * 版权/条码行：老 IEEE 论文页脚形如 `08824967/86/0300-0014$01.OO © 1986 IEEE`，
 * 字号与正文一致，靠字号判不出来，只能靠模式 + 长度上限。
 */
const COPYRIGHT_RE = /^\d{8}\/\d{2}\/|\bISSN\b|\bISBN\b|©\s*\d{4}|\(c\)\s*\d{4}/i;

/**
 * 页眉（running head）的版式特征：期刊名/卷期/页码。判决还要求「贴页顶 + 短行」，
 * 三条同时成立才当页眉 —— 正文首段同样贴页顶，只靠位置会误伤。
 */
const RUNNING_HEAD_RE = /\b(JOURNAL|PROCEEDINGS|TRANSACTIONS|CONFERENCE|SYMPOSIUM|VOL\.?|NO\.?|ISSN|PP\.)\b|\bVOL\s|\bNO\s+[0-9IVX]/i;

/**
 * 参考文献条目的版式特征。字号与正文相同时（老 IEEE 论文常见）ratio≈1，
 * 会被判成 body / section，译文栏里就混进大号「S. Tsuji, …」这种条目。
 */
const REFERENCE_RE =
  /\b(Eds?\.|Cambridge, ?MA|New York, ?NY|M\.I\.T\.|MIT Press|Springer|Prentice|Academic Press|IEEE Trans|Proc\.|Tech\. Rep|Ph\.?D\.? thesis|pp\.\s*\d|vol\.\s*\d|"[,]?\s*in\b)/i;


/**
 * 图注/表注的形态判据（S7 与段落合并护栏共用，唯一事实源）。
 *
 * 两种写法算图注：
 *  ① 编号后带分隔符或直接跟全大写：`Fig. 1.`、`Fig.1:`、`TABLE II`、`Table 2 Performance`、`表 2：`；
 *  ② 只有编号（短标题，如 `Fig. 3`）。
 * 反例（**不算**图注）：`Figure 1 shows that …`、`Table 2 lists …` —— 编号后跟小写动词，
 * 这是正文里的引用句。
 */
const CAPTION_MARK = /^(?:fig(?:ure)?|tab(?:le)?|图|表)\s*[.．:：-]?\s*(?:[IVXLC]{1,6}|\d{1,3})(?![0-9])/iu;
// 注意：这里**不能**加 `i` —— 加了之后 `\s+\p{Lu}` 会连小写词也匹配，
// `Figure 1 shows …` 这种正文引用句就会被误判成图注。前缀的两种大小写手写进字符类。
const CAPTION_STRONG =
  /^(?:[Ff]ig(?:ure)?|[Tt]ab(?:le)?|图|表)\s*[.．:：-]?\s*(?:[IVXLC]{1,6}|\d{1,3})\s*(?:[.．:：|–—-]|\s+\p{Lu})/u;

/** 图注长度上限（角色判定与「图注不许吞正文」护栏共用同一个值） */
export const CAPTION_MAX_CHARS = 300;

/**
 * 文本是否像图注/表注。
 * @param {string} text
 * @param {{maxChars?:number}} [opts]
 * @returns {boolean}
 */
export function isCaptionText(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > (opts.maxChars ?? CAPTION_MAX_CHARS)) return false;
  if (CAPTION_STRONG.test(t)) return true;
  if (!CAPTION_MARK.test(t)) return false;
  const rest = t.replace(CAPTION_MARK, '').trim();
  // 只剩编号：`Fig. 3` / `TABLE II`
  if (!rest) return true;
  // 编号后面必须重新「起头」：大写、数字、括号/引号或 CJK。
  // 小写开头的是正文引用句（`Figure 1 shows …`），交还给 body。
  return /^[\p{Lu}\p{Lt}\d(（[「『“"'\u4e00-\u9fff]/u.test(rest) && rest.length <= 120;
}

/** 数学习惯符号集（判定 is_math 用） */
const MATH_SYMBOLS = ['=', '+', '−', '-', '×', '÷', '∑', '∫', '√', '≤', '≥', '∈', '∂', '≈', '±', '∞', '→', '⊗', '∇', 'θ', 'λ', 'α', 'β', 'σ'];

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * S1 行聚合：把 pdf.js 的 items 聚成「行」。
 * y 用 transform[5] 分组（容差 max(2, font×0.3)）；同组内按 x 升序拼接；
 * 相邻 item 的 x 间距 > 0.25×平均字宽 时补一个空格；hasEOL 强制断行；空白 str 丢弃。
 * @param {Array} items pdf.js textContent.items
 * @param {{yTol?:number}} [opts]
 * @returns {Array<{text:string,x0:number,x1:number,y:number,fontSize:number}>}
 */
export function groupLines(items, opts = {}) {
  const usable = [];
  for (const it of items || []) {
    if (!it || typeof it.transform === 'undefined') continue;
    const str = typeof it.str === 'string' ? it.str : '';
    const x = it.transform[4];
    const y = it.transform[5];
    const w = Number(it.width) || 0;
    const h = Number(it.height) || 0;
    if (!str && !it.hasEOL) continue;
    // 纯空白 item 必须保留：它就是「词距」本身（本库里的 PDF 可达 64pt）。
    // 早先在此丢弃它，导致后续「大水平间隙切分」把词距误判成栏缝，
    // 整页被切成单词级碎片（1402 items → 545 段），译文自然稀碎。
    usable.push({ str, x, y, w, h, hasEOL: Boolean(it.hasEOL), space: str.length > 0 && !str.trim() });
  }
  if (!usable.length) return [];

  const fontSize = median(usable.filter((u) => u.str.trim() && u.h > 0.5).map((u) => u.h)) || 10;
  const yTol = opts.yTol ?? Math.max(2, fontSize * 0.3);
  const charWidths = usable
    .filter((u) => u.str.trim().length > 0 && u.w > 0)
    .map((u) => u.w / [...u.str].length)
    .filter((v) => v > 0 && Number.isFinite(v));
  const avgCharW = median(charWidths) || fontSize * 0.5;

  // 按「y 带」聚类成行：以带内 y 均值做容差比较。
  // 不能靠 hasEOL 强制断行 —— 实测本库 PDF 会在一行中间插 hasEOL，
  // 导致同一视觉行被拆成两段，且按 (y,x) 排序后右半段排到左半段前面（阅读顺序错乱）。
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(it.y - g.yMean) <= yTol) {
      g.items.push(it);
      g.yMean = g.items.reduce((s, v) => s + v.y, 0) / g.items.length;
    } else {
      groups.push({ yMean: it.y, items: [it] });
    }
  }

  const lines = [];
  // 同一 y 组内还要按「大水平间隙」再切成子行：双栏版面上，左右栏的 item 共享同一基线，
  // 如果不切，整行会横跨两栏（x0..x1 = 全宽），后面既判不出栏、段落也会串行。
  //
  // 阈值不能拍死成 fontSize 的固定倍数：本库 IEEE 双栏页栏缝只有 14pt，而字号 12 → 2.5× 得 30pt，
  // 左右栏会被粘成一条 518pt 的整行（阅读顺序直接错乱）。
  // 空格 item 已保留，行内词距的残留 gap 实测 ≤1pt，所以阈值只需略低于最窄的真实栏缝：
  // 取 0.8×字号（≥4pt）——足够高（不会把词切开），足够低（能切开 14pt 的窄栏缝）。
  const gapSplitPx = opts.gapSplitPx ?? Math.max(4, fontSize * 0.8);
  // 有栏缝坐标时**只在那条缝上切**：盲目按间隙切会把图注里的 "Fig.1." / "Traditional" 这类
  // 本来就该连着读的片段切成多行（本库实测 12pt 间隙 > 8pt 阈值），进而生成一堆碎片段。
  const splitAt = opts.splitAt || null;
  const shouldSplit = (it, prevEnd) => {
    if (prevEnd === null) return false;
    const gap = it.x - prevEnd;
    if (splitAt) {
      const at = splitAt.at;
      const lo = splitAt.from ?? at - 1;
      const hi = splitAt.to ?? at + 1;
      // 间隙必须**横跨**栏缝：左侧还在缝左、右侧已进缝右。
      // 阈值还要跟**这一行自己的字号**走：17pt 的论文标题横跨栏缝中线，
      // "Syste" 与 "m" 之间 2pt 的字间缝一旦被当成栏缝，标题就永远缺一个字母。
      const minGap = Math.max(splitAt.minGap ?? 2, 0.55 * Math.max(it.h || 0, 4));
      return prevEnd < hi && it.x > lo && gap >= minGap;
    }
    return gap > gapSplitPx;
  };
  for (const g of groups) {
    g.items.sort((a, b) => a.x - b.x);
    let bucket = [];
    let prevEnd = null;
    const flushBucket = () => {
      if (!bucket.length) return;
      let text = '';
      let x0 = Infinity;
      let x1 = -Infinity;
      let fontSizeOfLine = 0;
      let lastEnd = null;
      for (const it of bucket) {
        if (it.space) {
          // 显式空白：宽度即词距，折算成一个空格；只用来推进游标，不参与 x0/x1
          if (text && !/\s$/.test(text)) text += ' ';
          lastEnd = Math.max(lastEnd ?? -Infinity, it.x + it.w);
          continue;
        }
        if (!it.str) continue;
        if (lastEnd !== null) {
          const gap = it.x - lastEnd;
          const needWs = !/\s$/.test(text) && !/^\s/.test(it.str);
          // gap > 0：正常词距。gap < 0：PDF 用负字距（Tw<0）把词间空格压成了「负间隙」，
          // pdf.js 于是把相邻两个词当成独立 item 且边界重叠（实测 1.11 第 4 页
          // 连续 5 个词 gap 都是 -10.0pt）。重叠量 < 0.5pt 仍当作连续笔画，不补空格。
          const squeezed = gap < -0.5 && /[\p{L}\p{N}]$/u.test(text) && /^[\p{L}\p{N}]/u.test(it.str);
          if (needWs && (gap > 0.25 * avgCharW || squeezed)) text += ' ';
        }
        text += it.str;
        lastEnd = it.x + it.w;
        x0 = Math.min(x0, it.x);
        x1 = Math.max(x1, it.x + it.w);
        if (it.h > fontSizeOfLine) fontSizeOfLine = it.h;
      }
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean && Number.isFinite(x0)) {
        lines.push({ text: clean, x0, x1, y: g.yMean, fontSize: fontSizeOfLine || fontSize });
      }
      bucket = [];
      prevEnd = null;
    };
    for (const it of g.items) {
      if (shouldSplit(it, prevEnd)) flushBucket();
      bucket.push(it);
      // 空格 item 推进游标（宽度即词距）。注意：不能拿「空格宽度」当栏缝判据 ——
      // 两端对齐的标题词距可达 70pt+，与真实栏缝（本库 ≈94pt）同一量级，按宽度切会切碎标题。
      // 左右栏同基线的行偶尔会因跨栏填充空格粘成一行，这只影响首页作者块这类前置信息。
      prevEnd = it.x + it.w;
    }
    flushBucket();
  }
  return lines;
}

/**
 * S2 栏判定：对 x0/x1 覆盖区间做直方图（bin=1% 页宽），
 * 找一段宽度 ≥ minGapPct 页宽、两侧文本量比在 balance 区间内、且没有任何行跨越的空白带。
 * @param {Array} lines
 * @param {number} pageWidth
 * @param {{minGapPct?:number, balance?:[number,number], minLinesPerSide?:number}} [opts]
 * @returns {{columns:1|2, splitX:number|null, evidence:Object}}
 */
export function detectColumns(lines, pageWidth, opts = {}) {
  // 1.0% 而非 1.5%：arXiv/IEEE 双栏的栏间空白常见只有 1.2~1.4% 页宽，
  // 用 1.5% 会把真实双栏页误判成单栏（实测 1.11 p4/p6、1.8 p8、4.4 p1）。
  // 直方图只有 1% 一格，低于 1.0% 已无法分辨，故这是安全下限。
  const minGapPct = opts.minGapPct ?? 1.0;
  const [balMin, balMax] = opts.balance ?? [0.3, 0.7];
  const minSideShare = opts.minSideShare ?? 0.35;
  const minLinesPerSide = opts.minLinesPerSide ?? 3;
  const BINS = 100;

  const evidence = {
    bins: BINS,
    gapStartPct: null,
    gapEndPct: null,
    crossLines: 0,
    leftChars: 0,
    rightChars: 0,
    ratio: null,
    reason: '',
  };
  if (!lines.length) return { columns: 1, splitX: null, evidence: { ...evidence, reason: 'no-lines' } };

  // 直方图只统计「确定落在单栏内」的行：通栏标题、居中作者块这些跨栏行会把栏缝填死。
  // 「多宽算单栏行」不能拍死一个阈值 —— 逐级放宽，且**每一档都要走完校验**：
  // 常见失败是「这一档把某一栏的行全排除了，候选栏缝边界随之偏移」，所以不能"找到候选就用"。
  const caps = opts.widthCaps ?? [0.4, 0.45, 0.5, 0.55, 0.62, 0.7];
  const pageCenter = pageWidth / 2;
  const centerTol = Math.max(6, 0.04 * pageWidth);
  // 首页常见「通栏标题 + 通栏摘要 + 下方双栏」，跨栏行可占近三成，阈值不宜压太死。
  // 真正的单栏页不会出现候选栏缝（正文行铺满页宽），所以这里留 35% 的余量。
  const maxCross = opts.maxCrossShare ?? 0.35;

  let lastReason = 'no-gap';
  for (const cap of caps) {
    // 居中行（居中标题、作者行）不属于任何一栏，却会横跨并堵死栏缝 ——
    // 它们的中心必然贴页中心，而栏内行的中心落在四分位处，据此排除。
    const narrow = lines.filter(
      (l) => l.x1 - l.x0 <= cap * pageWidth && Math.abs((l.x0 + l.x1) / 2 - pageCenter) > centerTol,
    );
    if (narrow.length < minLinesPerSide * 2) {
      lastReason = `cap ${cap}：窄行仅 ${narrow.length} 行`;
      // eslint-disable-next-line no-continue
      continue;
    }

    const minX = Math.min(...narrow.map((l) => l.x0));
    const maxX = Math.max(...narrow.map((l) => l.x1));
    const span = Math.max(1, maxX - minX);
    const binW = span / BINS;
    const cover = new Array(BINS).fill(0);
    for (const l of narrow) {
      const a = Math.max(0, Math.floor((l.x0 - minX) / binW));
      const b = Math.min(BINS - 1, Math.ceil((l.x1 - minX) / binW) - 1);
      for (let i = a; i <= b; i += 1) cover[i] += 1;
    }
    // 容忍极少数噪点：页码/脚注号常落在栏缝正中（本库实测页码 "456" 就在 x≈315），
    // 严格零覆盖会被这一行毁掉整个栏判定，所以允许 ≤ 1% 的窄行穿缝。
    const tol = Math.max(1, Math.floor(narrow.length * 0.01));
    let runStart = -1;
    let cand = null;
    for (let i = 0; i <= BINS; i += 1) {
      const empty = i < BINS && cover[i] <= tol;
      if (empty && runStart < 0) runStart = i;
      if (!empty && runStart >= 0) {
        const width = i - runStart;
        const touchesEdge = runStart === 0 || i === BINS;
        if (!touchesEdge && (!cand || width > cand.width)) cand = { start: runStart, end: i, width };
        runStart = -1;
      }
    }
    if (!cand) {
      lastReason = `cap ${cap}：无候选栏缝`;
      // eslint-disable-next-line no-continue
      continue;
    }

    // 分箱会把栏缝宽度量化到 bin 的整数倍（100 bin 时每个 5pt），窄栏缝会被量成 1 个 bin
    // （实测 12pt 的缝被算成 5.2pt，直接过不了 minGapPct）。所以用真实行边界细化它。
    const binStartX = minX + cand.start * binW;
    const binEndX = minX + cand.end * binW;
    const midX = (binStartX + binEndX) / 2;
    const leftEnds = narrow.filter((l) => l.x1 <= midX).map((l) => l.x1);
    const rightStarts = narrow.filter((l) => l.x0 >= midX).map((l) => l.x0);
    const gapStartX = leftEnds.length ? Math.max(...leftEnds) : binStartX;
    const gapEndX = rightStarts.length ? Math.min(...rightStarts) : binEndX;
    const gapPct = ((gapEndX - gapStartX) / pageWidth) * 100;
    // 校验阶段用全量行：跨栏行（标题/通栏摘要/通栏图注）允许存在，但不能多到说明这其实是单栏页
    const left = lines.filter((l) => l.x1 <= gapStartX + 1);
    const right = lines.filter((l) => l.x0 >= gapEndX - 1);
    const crossing = lines.filter((l) => l.x1 > gapStartX + 1 && l.x0 < gapEndX - 1);
    if (crossing.length > Math.max(2, lines.length * maxCross)) {
      lastReason = `cap ${cap}：跨栏行 ${crossing.length}/${lines.length} 过多`;
      // eslint-disable-next-line no-continue
      continue;
    }
    if (gapPct < minGapPct) {
      lastReason = `cap ${cap}：gap ${gapPct.toFixed(1)}% < ${minGapPct}%`;
      // eslint-disable-next-line no-continue
      continue;
    }
    if (left.length < minLinesPerSide || right.length < minLinesPerSide) {
      lastReason = `cap ${cap}：left ${left.length} / right ${right.length} 行不足`;
      // eslint-disable-next-line no-continue
      continue;
    }
    const leftChars = left.reduce((a, l) => a + l.text.length, 0);
    const rightChars = right.reduce((a, l) => a + l.text.length, 0);
    const total = leftChars + rightChars;
    const ratio = total ? leftChars / total : 0;
    if (ratio < balMin || ratio > balMax) {
      lastReason = `cap ${cap}：balance ${ratio.toFixed(2)} 越界`;
      // eslint-disable-next-line no-continue
      continue;
    }
    // 单栏的「段首缩进」也会造出一条伪栏缝：它的左簇（段首行）必然是少数派。
    // 双栏则两侧行数大致相当，所以用「少数侧行数占比」再挡一次。
    const share = Math.min(left.length, right.length) / (left.length + right.length);
    if (share < minSideShare) {
      lastReason = `cap ${cap}：少数侧行占比 ${share.toFixed(2)} < ${minSideShare}`;
      // eslint-disable-next-line no-continue
      continue;
    }

    Object.assign(evidence, {
      gapStartPct: Number(((gapStartX / pageWidth) * 100).toFixed(1)),
      gapEndPct: Number(((gapEndX / pageWidth) * 100).toFixed(1)),
      leftChars,
      rightChars,
      ratio: Number(ratio.toFixed(2)),
      sideLineShare: Number(share.toFixed(2)),
      crossLines: crossing.length,
      narrowLines: narrow.length,
      widthCap: cap,
      reason: 'ok',
    });
    return { columns: 2, splitX: (gapStartX + gapEndX) / 2, gapStartX, gapEndX, evidence };
  }
  return { columns: 1, splitX: null, evidence: { ...evidence, reason: lastReason } };
}

/**
 * S3 阅读顺序。
 * 单栏：y 降序。双栏：以「跨栏行」为分带点，每带内先左栏后右栏；
 * 跨栏行（标题/通栏图注，x1-x0 > 0.7×页宽）按其自身 y 插入。
 * @param {Array} lines
 * @param {{columns:1|2, splitX:number|null}} col
 * @param {number} pageWidth
 * @returns {Array} 带 column 标记的有序行
 */
export function orderLines(lines, col, pageWidth) {
  const byY = (a, b) => b.y - a.y || a.x0 - b.x0;
  if (col.columns === 1 || col.splitX == null) {
    return [...lines].sort(byY).map((l) => ({ ...l, column: 'full' }));
  }
  const isCross = (l) => l.x1 - l.x0 > 0.7 * pageWidth || (l.x0 < col.splitX - 1 && l.x1 > col.splitX + 1);
  const cross = lines.filter(isCross).sort(byY);
  const left = lines.filter((l) => !isCross(l) && (l.x0 + l.x1) / 2 < col.splitX).sort(byY);
  const right = lines.filter((l) => !isCross(l) && (l.x0 + l.x1) / 2 >= col.splitX).sort(byY);

  const out = [];
  let li = 0;
  let ri = 0;
  const flushBands = (limitY) => {
    while (li < left.length && left[li].y > limitY) out.push({ ...left[li++], column: 'left' });
    while (ri < right.length && right[ri].y > limitY) out.push({ ...right[ri++], column: 'right' });
  };
  for (const c of cross) {
    flushBands(c.y);
    out.push({ ...c, column: 'cross' });
  }
  while (li < left.length) out.push({ ...left[li++], column: 'left' });
  while (ri < right.length) out.push({ ...right[ri++], column: 'right' });
  return out;
}

/**
 * S4 段落合并。
 *
 * **不能用「绝对行高倍数」当行距判据**：本库实测 PDF 的「行距/字身高」中位数就是 1.58，
 * 阈值取 1.5 会把每一行都断成独立一段 —— 正文于是逐行送去翻译，完全没有上下文，
 * 这是译文读起来破碎、代词与术语前后不一致的直接原因。
 *
 * 改为「相对同栏主导行距」+ 首行缩进 + 短尾行 + 形态排除：
 *  ① 同栏  ② 字号一致（|Δfont| ≤ 1.5）
 *  ③ 行距 ≤ 主导行距 × paragraphGapRatio（默认 1.25）
 *  ④ 本行相对栏左边界无首行缩进
 *  ⑤ 上一行不是「短尾行 + 句末标点」（真正的段末信号）
 *  ⑥ 本行不以编号 / 图表题 / 小标题形态开头
 * @param {Array} orderedLines
 * @param {{paragraphGapRatio?:number}} [opts]
 * @returns {Array<{text:string, x0:number, x1:number, yTop:number, yBottom:number, fontSize:number, column:string}>}
 */
export function mergeParagraphs(orderedLines, opts = {}) {
  const gapRatio = opts.paragraphGapRatio ?? 1.25;
  const bodyFont = Number(opts.bodyFont) > 0 ? Number(opts.bodyFont) : 0;

  // 「上一行是标题」时绝不能并进下一段：本库 IEEE 论文里 "I. INTRODUCTION" 与正文
  // 字号、行距完全一致（9pt / 12pt），只有文本形态能区分，靠 gap 判据永远判不出来。
  const HEADING_ONLY_RE = /^(?:\d+(?:\.\d+)*|[IVXLC]{1,6}|[A-Z])\s*[.)]?$/; // "I." / "2.3"
  const CAPS_HEADING_RE = /^[A-Z][A-Z0-9 ,.:'&()/\u2013\u2014-]{2,80}$/; // 全大写短行
  const WORD_HEADING_RE = /^(?:\d+(?:\.\d+)*|[IVXLC]{1,6}|[A-Z])\s*[.)]\s+[A-Z][a-z]/; // "A . Requirements"
  const looksHeading = (text, line) => {
    const s = String(text || '').trim();
    if (!s || s.length > 90) return false;
    if (HEADING_ONLY_RE.test(s) || CAPS_HEADING_RE.test(s) || WORD_HEADING_RE.test(s)) return true;
    return bodyFont > 0 && line.fontSize >= 1.12 * bodyFont;
  };

  // 每栏统计：主导行距（行距中位数）、左边界、右边界
  const stats = new Map();
  {
    const byCol = new Map();
    for (const line of orderedLines) {
      if (!byCol.has(line.column)) byCol.set(line.column, []);
      byCol.get(line.column).push(line);
    }
    const pick = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
    for (const [col, lines] of byCol) {
      const gaps = [];
      for (let i = 1; i < lines.length; i += 1) {
        const g = lines[i - 1].y - lines[i].y;
        if (g > 0 && g < Math.max(lines[i - 1].fontSize, lines[i].fontSize) * 3) gaps.push(g);
      }
      const xs = lines.map((l) => l.x0).sort((a, b) => a - b);
      const x1s = lines.map((l) => l.x1).sort((a, b) => a - b);
      stats.set(col, {
        leading: median(gaps),
        marginLeft: pick(xs, 0.1),
        colRight: pick(x1s, 0.9),
        medianFont: median(lines.map((l) => l.fontSize).filter((v) => v > 0)),
      });
    }
  }

  const blocks = [];
  let cur = null;
  for (const line of orderedLines) {
    if (!cur || cur.column !== line.column) {
      if (cur) blocks.push(cur);
      cur = { column: line.column, lines: [line] };
      continue;
    }
    const prev = cur.lines[cur.lines.length - 1];
    const st = stats.get(line.column) || {};
    const gap = prev.y - line.y;
    const prevText = prev.text.trim();
    const nextText = line.text.trim();
    const leading = st.leading || Math.max(prev.fontSize, line.fontSize) * 1.3;
    // 短尾行：这一行没有排到栏右边界，通常意味着段落在本行结束
    const shortTail = Number.isFinite(st.colRight) && prev.x1 < st.colRight - 2.2 * prev.fontSize;
    // 上一行是否已经收句。中文/英文的句末标点都算；行尾的右引号/右括号一并吸收。
    const prevTerminated = /[.!?。！？:;：；]["'”’）)\]】』」]?$/.test(prevText);
    // 首行缩进：只有「相对栏左边界」缩进才算新段（用 cur 的首行 x0 会漏判）
    const indented = Number.isFinite(st.marginLeft) && line.x0 - st.marginLeft > line.fontSize * 0.9;
    // 大字号行（多行标题/大标题）的行距本来就不按正文 leading 走：
    // 用「正文字号 1.15 倍以上」判定 display，并按其自身字号放宽行距容忍，
    // 否则「A Survey on … Autonomous」与「Agents」会被切成两段。
    const isDisplay = line.fontSize >= 1.15 * (bodyFont || st.medianFont || 0) && prev.fontSize >= 1.15 * (bodyFont || st.medianFont || 0);
    const gapLimit = isDisplay ? Math.max(leading * gapRatio, line.fontSize * 1.9) : leading * gapRatio;
    const prevHeading = looksHeading(prevText, prev);
    // 反向护栏（与下面 `!/^(图|表|Figure|Fig\.?|Table)\s*\d/` 那句配对）：
    // 旧代码只挡「正文吞掉紧随其后的图注」，挡不住「图注吞掉后面的正文」——
    // 只要段落以 `Fig. 1.` 开头，后文正文就被继续并进来（asset 5 p1 #7 的根因）。
    // 规则：段首行是图注时，只允许并入图注自身的续行，且整段不得超过 CAPTION_MAX_CHARS。
    if (cur.captionLike === undefined) cur.captionLike = isCaptionText(prevText);
    const curChars = cur.lines.reduce((s, l) => s + l.text.length + 1, 0);
    const captionStop =
      cur.captionLike && curChars + nextText.length + 1 > CAPTION_MAX_CHARS && !isCaptionText(nextText);
    // 上一行没收句 ⇒ 这段还没完：跨插图/跨栏底时行距会明显变大，仍应并入同一段。
    // 收句的行仍用严格 gapLimit，避免把两段正文粘在一起。
    const effectiveGapLimit = prevTerminated ? gapLimit : gapLimit * 2.6;
    const ok =
      gap > 0 &&
      gap <= effectiveGapLimit &&
      // 字号一致性：绝对 1.5pt 对正文够用，但大字号标题的同一行常因字形差异差 2~3pt，
      // 再用绝对值会把标题切两半；对大于 12pt 的行改用 8% 相对容差。
      Math.abs(prev.fontSize - line.fontSize) <= Math.max(1.5, 0.08 * Math.max(prev.fontSize, line.fontSize)) &&
      // 居中标题的续行天然"缩进"，但对 display 行来说这是排版常态，不是新段落
      (!indented || isDisplay) &&
      !prevHeading &&
      !captionStop &&
      !(shortTail && /[.!?。！？:;]$/.test(prevText)) &&
      !/^(\d+(\.\d+)*|[•·*\-–—]|\(?\d+\))\s+/.test(nextText) &&
      // 图注边界：只有当上一行**已经收句**时，"Fig. 3 …" 才是新段（真图注）。
      // 上一行没收句说明它是折行，"…as shown in Fig. 1. After analyzing…" 是同一段，
      // 在此处断开会把句子切成两半（asset 5 p1 #6/#7、p8 #5/#6 就是这种）。
      !(isCaptionText(nextText) && prevTerminated) &&
      !/^[A-Z][A-Za-z]+:\s/.test(nextText);
    if (ok) cur.lines.push(line);
    else {
      blocks.push(cur);
      cur = { column: line.column, lines: [line] };
    }
  }
  if (cur) blocks.push(cur);

  return blocks.map((b) => {
    const x0 = Math.min(...b.lines.map((l) => l.x0));
    const x1 = Math.max(...b.lines.map((l) => l.x1));
    const yTop = Math.max(...b.lines.map((l) => l.y + l.fontSize * 0.8));
    const yBottom = Math.min(...b.lines.map((l) => l.y - l.fontSize * 0.25));
    // 块字号取「字符数最多的那一行」：drop cap / 小型大写首字母会把 Math.max 抬到 20pt+，
    // 正文段于是被 classifyRich 按 ratio 判成 section / title（旧版正文段全被标成标题的根因）。
    const dominant = b.lines.reduce((a, l) => (l.text.length > a.text.length ? l : a), b.lines[0]);
    const fontSize = dominant.fontSize;
    return {
      text: b.lines.map((l) => l.text).join(' '),
      x0,
      x1,
      yTop,
      yBottom,
      fontSize,
      column: b.column,
    };
  });
}

/**
 * S7 角色判定（确定性规则，不用模型）。
 * @param {string} text
 * @param {Object} [rules]
 * @returns {{isMath:boolean, isLabel:boolean, isHeading:boolean}}
 */
export function classifyRole(text, rules = {}) {
  const r = { ...DEFAULT_ROLE_RULES, ...rules };
  const t = String(text || '');
  const chars = [...t];
  const len = chars.length;
  if (!len) return { isMath: false, isLabel: false, isHeading: false };

  let alnum = 0;
  let digits = 0;
  for (const ch of chars) {
    if (/[\p{L}\p{N}]/u.test(ch)) alnum += 1;
    if (/\p{N}/u.test(ch)) digits += 1;
  }
  const nonAlnum = 1 - alnum / len;
  const symbolHits = MATH_SYMBOLS.reduce((acc, s) => acc + (t.split(s).length - 1), 0);
  const isMath = nonAlnum > r.mathNonAlnumRatio && symbolHits >= r.mathMinSymbols && digits / len > r.mathDigitRatio;

  // isLabel 原规则（长度<40 且无句末标点）会把大量正常短段（参考文献条目、表格单元格、
  // 小节末句）都判成图内标注，而这些段是**不送翻译**的 —— 误判等于静默丢掉正文。
  // 这里收紧为：短 + 无句末标点 + （≤4 个词 或 含数字）+ 非标题。
  const words = t.trim().split(/\s+/);
  const wordsCount = words.length;
  const allUpper = words.length >= 3 && words.every((w) => w === w.toUpperCase() && /[A-Z]/.test(w));
  // 章节号常见三种写法："2 Defining" / "2. Defining" / 罗马数字 "I. INTRODUCTION"（老式 IEEE 论文）
  const numbered = /^\d+(\.\d+)*[.)]?\s+[A-Z]/.test(t.trim());
  // 老式 IEEE 排版的字母小标题常写成 "A . Requirements"（句点前有空格），
  // 旧正则要求 "A." 紧贴，于是这条小标题被判成图内标注 → 永久不翻译。
  const romanOrLetter = /^([IVXLC]{1,6}|[A-Z])\s*[.)]\s+\S/.test(t.trim());
  const isHeading = len < r.headingMaxChars && (numbered || romanOrLetter || allUpper);

  // isLabel 必须**排在标题判定之后**：否则 "I. INTRODUCTION"（2 个词、无句末标点）会被判成
  // 图内标注，而标注是 passthrough 不送翻译的 —— 结果正文章节标题原样留英文。
  const isLabel =
    !isHeading &&
    len < r.labelMaxChars &&
    !/[.!?。！？:：]$/.test(t.trim()) &&
    (wordsCount <= 4 || /\d/.test(t)) &&
    !/^\d+(\.\d+)*[.)]?\s+[A-Z]/.test(t.trim());

  return { isMath, isLabel, isHeading };
}

/**
 * 段块与图区的关系（用于把「图内短标注」与「图注」和正文分开）。
 * @param {{x0:number,y0?:number,y1?:number,yBottom:number,x1:number,yTop:number}} block
 * @param {number[][]} boxes 图区（PDF 点、y 向上）
 * @returns {'inside'|'near'|'outside'}
 */
function boxRelation(block, boxes) {
  const b = [block.x0, block.yBottom, block.x1, block.yTop];
  const bArea = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  let near = false;
  for (const f of boxes) {
    if (!Array.isArray(f) || f.length !== 4) continue;
    const ix = Math.min(f[2], b[2]) - Math.max(f[0], b[0]);
    const iy = Math.min(f[3], b[3]) - Math.max(f[1], b[1]);
    if (ix > 0 && iy > 0) {
      // 中心落在图框内、或 60% 以上面积落在图框内 → 图内标注
      if (ix * iy >= 0.6 * bArea) return 'inside';
      const cx = (b[0] + b[2]) / 2;
      const cy = (b[1] + b[3]) / 2;
      if (cx > f[0] && cx < f[2] && cy > f[1] && cy < f[3]) return 'inside';
      near = true;
      continue;
    }
    // 相距 ≤24pt 且水平投影重叠 ≥30% → 紧邻图区（图注/图题）
    const vgap = Math.max(f[1] - b[3], b[1] - f[3]);
    const minW = Math.max(1, Math.min(f[2] - f[0], b[2] - b[0]));
    if (vgap <= 24 && ix > 0.3 * minW) near = true;
  }
  return near ? 'near' : 'outside';
}

/**
 * 富角色判定（S7 增强）：在 classifyRole 基础上，结合字号比、居中、文本模式，
 * 产出 Zotero「AI 精排」同构的 { role, tier, align, ratio }，供前端按层级排版。
 * 纯确定性规则（不调模型），作为「没有精排」时的基线；精排会覆盖这里的判断。
 *
 * @param {{text:string, fontSize:number, x0:number, x1:number, yTop:number, yBottom:number}} block
 * @param {number} bodyFont 该页正文基准字号（块字号中位数）
 * @param {number} pageWidth 页宽（同 block 坐标系）
 * @param {Object} [rules]
 * @param {{figureBoxes?:number[][], alignInherit?:string}} [ctx] 图区（PDF 点、y 向上）；alignInherit 供重算时沿用原对齐
 * @returns {{isMath:boolean,isLabel:boolean,isHeading:boolean,isCaption:boolean,role:string,tier:string,align:string,ratio:number}}
 */
export function classifyRich(block, bodyFont, pageWidth, rules = {}, ctx = {}) {
  const base = classifyRole(block.text, rules);
  const ratio = bodyFont > 0 ? Math.min(3, Math.max(0.5, block.fontSize / bodyFont)) : 1;
  const width = Math.max(0, block.x1 - block.x0);
  const center = (block.x0 + block.x1) / 2;
  const cent =
    width > 0 &&
    width < 0.7 * pageWidth &&
    Math.abs(center - pageWidth / 2) < 0.08 * pageWidth;

  const t = String(block.text || '').trim();
  // 图内标注 = 不送翻译。旧版直接信 classifyRole 的 isLabel，于是 17pt 的论文标题
  // 第二行 "For A Mobile Robot"（4 个词、无句末标点）也被当成图注，永远显示「未翻译」。
  // 真正的图内标注还有两个伴生特征：字号偏小，或文本以 Fig./Table 开头。
  const captionLike = /^(fig|figure|table|tab|eq|equation|algorithm|图|表)\s*[.．]?\s*\d/i.test(t);
  // 图区关系：有图区信息时用它来收紧/放宽图内标注的判定（见下方 isLabel）。
  const figs = Array.isArray(ctx.figureBoxes) && ctx.figureBoxes.length ? ctx.figureBoxes : null;
  const figRel = figs ? boxRelation(block, figs) : null;
  // 图注：① 形态判据（Fig./Table/图/表 + 编号）；② 紧邻图区的短段（≤300 字符）。
  const isCaption =
    !base.isMath &&
    (isCaptionText(t) || (figRel === 'near' && t.length < CAPTION_MAX_CHARS && !base.isHeading));
  // 图内标注 = 不送翻译。旧版只按字号比判，于是：
  //  - 图里用正文字号写的短标注被判成正文（译文里混入图内词）；
  //  - 图外的短正文碎片（"2.3" 之类）又被判成标注而永久不译。
  // 有图区时按「是否落在图框内」决定：图内放宽到 ratio ≤ 1.05，图外收紧到 ≤ 0.82。
  const isLabel =
    !isCaption &&
    base.isLabel &&
    (figRel === 'inside'
      ? ratio <= 1.05
      : figRel === 'outside'
        ? ratio <= 0.82 || captionLike
        : ratio <= 0.92 || captionLike);
  let role = 'body';
  let tier = 'body';
  let align = 'left';

  if (base.isMath) {
    role = 'equation';
    tier = 'body';
    align = 'center';
  } else if (isCaption) {
    // 图注/表注：小字号档，单独一段，不再和正文混排（此前被归进 body/footnote）
    role = 'caption';
    tier = 'small';
    align = ctx.alignInherit || (cent ? 'center' : 'left');
  } else if (isLabel) {
    role = 'figure-label';
    tier = 'small';
    align = 'left';
  } else if (base.isHeading) {
    role = 'section';
    tier = 'h2';
    align = cent ? 'center' : 'left';
  } else if (COPYRIGHT_RE.test(t) && t.length <= 120) {
    // IEEE 老论文页脚的「08824967/86/0300-0014$01.OO © 1986 IEEE」这类条码行，
    // 字号与正文相同（ratio≈1.1）因此会掉进 body，翻出来是一串噪声。
    role = 'footnote';
    tier = 'small';
    align = 'left';
  } else if (t.length <= 320 && REFERENCE_RE.test(t)) {
    role = 'reference';
    tier = 'small';
    align = 'left';
  } else if (ratio >= 1.4) {
    role = 'title';
    tier = 'h1';
    align = 'center';
  } else if (ratio >= 1.12) {
    role = 'section';
    tier = 'h2';
    align = cent ? 'center' : 'left';
  } else if (ratio <= 0.82) {
    // 小字号：优先按模式判参考文献 / 脚注 / 页眉页脚
    if (/^(manuscript|the author|authors are|ieee log|copyright|received|revised|©|\(c\))/i.test(t)) {
      role = 'footnote';
    } else if (/^\s*\[?\d{1,3}\]?[\.\)]?\s|et al\.|\(\d{4}\)|\b19\d{2}\b|\b20\d{2}\b/.test(t) && t.length > 40) {
      role = 'reference';
    } else {
      role = 'footnote';
    }
    tier = 'small';
    align = 'left';
  } else {
    // 引用块：以引号包裹且较长
    if (/^["“『「«]|["”』」»]$/.test(t) && t.length > 60) {
      role = 'quote';
      align = 'left';
    }
  }

  return { isMath: base.isMath, isLabel, isHeading: base.isHeading, isCaption, role, tier, align, ratio };
}

/**
 * S4.5 跨栏/跨段续句合并。
 *
 * 双栏论文的句子常被栏缝切断：左栏末行 "…is the cooperative so-"、右栏首行 "lution of problems…"。
 * 抽出来是两个「半句」，单段送翻时模型会自行补全前半句的语义，于是把相邻片段的内容也译进来，
 * 造成相邻译文互相吞并/重复（用户看到的是"译文跑到了别的段落"）。
 * 这里在 classifyRich 之前把这类片段拼回完整句子：
 *  - 前块未以句末标点结尾（且够长，排除标题）；
 *  - 后块以小写字母（或标点）开头，或前块以连字符断词；
 *  - 两块字号接近、都不是大字号标题。
 * @param {Array} blocks mergeParagraphs 的输出
 * @param {number} bodyFont 该页正文基准字号
 * @returns {Array} 合并后的块（浅拷贝，不修改入参元素）
 */
export function joinContinuations(blocks, bodyFont) {
  if (!Array.isArray(blocks) || blocks.length < 2) return blocks;
  const display = (b) => bodyFont > 0 && b.fontSize >= 1.15 * bodyFont;
  // 只有「句末」标点才算结束：分号/冒号后常接同一句的后半（"…geographically distributed; there is…"），
  // 把它们当结束会让跨栏半句永远拼不回去。
  const terminal = /[.!?。！？»"'”’)\]】]$/;
  const out = [];
  const seenCols = new Set();
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const curCol = b.column || 'full';
    if (prev) {
      const pa = String(prev.text || '').trim();
      const cb = String(b.text || '').trim();
      const prevCol = prev.column || 'full';
      // 跨栏拼接只在「左栏最后一块 → 右栏第一块」时成立（双栏页会把半句从栏底折到下一栏栏顶）。
      // 若目标栏里已经出现过块，说明这一块不在栏顶，拼过去就会把两栏各自的段尾粘成一段
      // —— 粘出来的块 bbox 横跨两栏、高度只有一个行高，前端按它排就是一段通栏文字。
      const crossCol = prevCol !== curCol && prevCol !== 'cross' && curCol !== 'cross' && prevCol !== 'full' && curCol !== 'full';
      // 跨栏一律不拼：拼出来的块 bbox 会横跨两栏、且高度只有一个行高，前端会把它排成一段通栏文字。
      // 分栏折行的半句就留在各自栏里，翻译时按片段处理即可。
      const colOk = !crossCol;
      const unfinished = pa.length >= 30 && !terminal.test(pa);
      const hyphenated = /[A-Za-z]-$/.test(pa);
      const contStart = /^[a-z(,;]/.test(cb);
      const allCaps = /^[A-Z0-9 .,:;&'’()\-–—/]+$/.test(pa);
      // 情况一：多行标题/大标题被拆开（两行都是大字号，续行常以大写开头）→ 合并回到一个块
      const titleJoin = display(prev) && display(b) && (pa + ' ' + cb).length <= 200;
      // 情况二：正文半句被栏缝/缩进切断 → 要求续行以小写或标点开头
      const bodyJoin =
        !display(prev) &&
        !display(b) &&
        !allCaps &&
        Math.abs(prev.fontSize - b.fontSize) <= Math.max(1.5, 0.08 * Math.max(prev.fontSize, b.fontSize)) &&
        (contStart || (hyphenated && /^[a-zA-Z]/.test(cb)));
      const ok = unfinished && colOk && (titleJoin || bodyJoin);
      if (ok) {
        // 连字符断词直接去连字符（"so-" + "lution" → "solution"），其余用空格拼
        const glue = hyphenated && /^[a-zA-Z]/.test(cb) ? '' : ' ';
        prev.text = `${pa.replace(/-$/, '')}${glue}${cb}`;
        prev.x0 = Math.min(prev.x0, b.x0);
        prev.x1 = Math.max(prev.x1, b.x1);
        prev.yTop = Math.max(prev.yTop, b.yTop);
        prev.yBottom = Math.min(prev.yBottom, b.yBottom);
        prev.fontSize = Math.max(prev.fontSize, b.fontSize);
        prev.joined = (prev.joined || 0) + 1;
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    seenCols.add(curCol);
    out.push({ ...b });
  }
  return out;
}

/**
 * 小块文本的「句末标点」判定辅助（导出给测试用）
 * @param {string} text
 */
export function endsSentence(text) {
  return /[.!?。！？:：;；»"'”’)\]】]$/.test(String(text || '').trim());
}

/**
 * S5.5 页眉/页脚去重（确定性后处理，§16.2 未列出但必需）：
 * 同一段文字在 ≥30% 的页上出现在页顶/页底 8% 区域 → 判为页眉/页脚并整篇丢弃。
 * 只处理「重复 + 位于边栏」的文本，正文里偶然重复的句子不会被误删。
 * @param {Array} pages buildPagesFromRaw 的中间结果
 * @param {{marginRatio?:number, minPageRatio?:number}} [opts]
 */
export function dropRepeatedMarginalia(pages, opts = {}) {
  const marginRatio = opts.marginRatio ?? 0.08;
  const minPageRatio = opts.minPageRatio ?? 0.3;
  if (pages.length < 4) return pages;
  const norm = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const counts = new Map();
  for (const page of pages) {
    const top = page.height * (1 - marginRatio);
    const bottom = page.height * marginRatio;
    const seen = new Set();
    for (const p of page.paras) {
      const [, y0, , y1] = p.bbox || [0, 0, 0, 0];
      const inMargin = y1 >= top || y0 <= bottom;
      if (!inMargin) continue;
      const key = norm(p.text);
      if (key.length < 4 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * minPageRatio));
  const drop = new Set([...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k));
  if (!drop.size) return pages;
  for (const page of pages) {
    page.paras = page.paras.filter((p) => !drop.has(norm(p.text)));
  }
  return pages;
}

/**
 * drop cap（首字下沉）修复。
 *
 * 老式 IEEE 论文的段首字母常做成 3 行高的大字母，pdf.js 给的基线落在**第二视觉行**上，
 * 于是阅读顺序变成「CONTROL SYSTEM for a completely autonomous」→「A mobile robot must
 * perform…」—— 一个句子被拆成两段，且第一段丢了句首。这里把大字母搬回上一行行首。
 * @param {Array} orderedLines orderLines 的输出
 * @param {number} bodyFont 正文字号
 * @returns {Array} 浅拷贝后的行
 */
export function hoistDropCaps(orderedLines, bodyFont) {
  if (!Array.isArray(orderedLines) || orderedLines.length < 2) return orderedLines;
  if (!(bodyFont > 0)) return orderedLines;
  const out = orderedLines.map((l) => ({ ...l }));
  for (let i = 1; i < out.length; i += 1) {
    const cur = out[i];
    const prev = out[i - 1];
    if (cur.column !== prev.column) continue;
    if (!(cur.fontSize >= 1.5 * bodyFont)) continue;
    const text = String(cur.text || '');
    if (text.length < 20) continue;
    const m = text.match(/^([A-Z])([a-z][\s\S]*)$/);
    if (!m) continue;
    if (/[.!?。！？:;]$/.test(String(prev.text || '').trim())) continue;
    prev.text = `${m[1]} ${String(prev.text || '').trim()}`;
    cur.text = m[2];
    cur.fontSize = bodyFont;
  }
  return out;
}

/**
 * 估正文字号：按字符数加权的众数（0.5pt 分桶）。
 * 字符数加权比「绝对值中位数」稳得多 —— 图注/脚注行数多但字符少，正文行才是字符主力。
 * @param {Array<{lines:Array<{text:string,fontSize:number}>}>} pagesWithLines
 * @returns {number} 0 表示估不出来
 */
export function estimateBodyFont(pagesWithLines) {
  const buckets = new Map();
  for (const p of pagesWithLines || []) {
    for (const l of p?.lines || []) {
      const chars = String(l.text || '').replace(/\s+/g, '').length;
      if (!chars || !(l.fontSize > 0)) continue;
      const key = Math.round(l.fontSize * 2) / 2;
      buckets.set(key, (buckets.get(key) || 0) + chars);
    }
  }
  let bestSize = 0;
  let bestChars = 0;
  for (const [size, chars] of buckets) {
    if (chars > bestChars || (chars === bestChars && size > bestSize && size < 14)) {
      bestChars = chars;
      bestSize = size;
    }
  }
  return bestSize;
}

/**
 * 取某一页的图区（opts.pageFigures 支持 Map / 数组 / 普通对象三种形状）。
 * @param {Map<number,number[][]>|Array<{pageNo:number,boxes:number[][]}>|Object} [src]
 * @param {number} pageNo
 * @returns {number[][]|null}
 */
function pickFigures(src, pageNo) {
  if (!src) return null;
  if (src instanceof Map) return src.get(pageNo) || null;
  if (Array.isArray(src)) {
    const hit = src.find((x) => x && Number(x.pageNo) === Number(pageNo));
    return hit ? hit.boxes || null : null;
  }
  if (typeof src === 'object') return src[pageNo] || null;
  return null;
}

/**
 * 把一个块的 bbox 切成 k 个**互不相同**的子段 bbox（交付①的核心规则）。
 *
 * 判定规则（确定性、可复现，重算脚本用同一套）：
 *  1. `splitParagraphs` 只在文本超过 paragraphChars（600）时才把一块拆成多段，
 *     所以「同一块拆出来的 k 段」天然按阅读顺序排列：第一段在块**顶部**，最后一段在底部。
 *  2. 块级 y 跨度（yBottom..yTop）按各段**字符数占比**分段；x 范围沿用块级
 *     x0..x1（拆段只发生在行与行之间，横向不会缩进）。字符数用 `Math.max(1, len)`
 *     兜底，保证不会出现零高度框。
 *  3. 累积取整误差全部落到最后一段（`y0 = 块底`），因此各段首尾相接、总和等于原块高。
 *  4. 若块高极小（<1pt）则退化为横向均分，避免所有段仍共用一个 y。
 *
 * 这样每段拿到的是「自己那几行文本所在的行带」，而不是整块的行带 ——
 * 前端按 bbox 贴译文时不再互相叠字。
 * @param {{x0:number,x1:number,yTop:number,yBottom:number}} block
 * @param {string[]} pieces
 * @returns {number[][]} 与 pieces 等长的 bbox 数组
 */
export function splitBlockBBox(block, pieces) {
  const n = Array.isArray(pieces) ? pieces.length : 0;
  const x0 = round(block.x0);
  const x1 = round(block.x1);
  if (n <= 1) return [[x0, round(block.yBottom), x1, round(block.yTop)]];
  const totalChars = pieces.reduce((s, t) => s + Math.max(1, String(t || '').length), 0);
  const top = block.yTop;
  const bottom = block.yBottom;
  const span = top - bottom;
  if (!(span > 1)) {
    // 极端情况：块没有垂直跨度（多段挤在同一基线）→ 横向等分，保证 bbox 互不相同
    const step = (x1 - x0) / n;
    return pieces.map((_, i) => [round(x0 + i * step), round(bottom), round(x0 + (i + 1) * step), round(top)]);
  }
  const out = [];
  let cursor = top;
  for (let i = 0; i < n; i += 1) {
    const chars = Math.max(1, String(pieces[i] || '').length);
    const h = i === n - 1 ? cursor - bottom : (span * chars) / totalChars;
    const y1 = cursor;
    const y0 = Math.max(bottom, cursor - h);
    out.push([x0, round(y0), x1, round(y1)]);
    cursor = y0;
  }
  return out;
}

/**
 * 同 bbox 去重兜底（跨块重复时 splitBlockBBox 管不到）。
 *
 * 规则：第 k 次（k≥1）出现完全相同的 bbox 时，把这一段的 y 上沿下移 0.5k pt、
 * 下沿上移 0.5k pt（等价于在原区域内**向内收缩**），保证几何上仍落在原文本行带里；
 * 收缩到高度 <1pt 后改为横向内缩 0.4k pt。收缩量只与本段是第几次重复有关，
 * 与输入顺序绑定 —— 同样的输入永远得到同样的 bbox（extract_version 依赖确定性）。
 * @param {Array<{bbox:number[]}>} paras
 * @returns {number} 被修正的段数
 */
export function dedupeBBoxes(paras) {
  const seen = new Map();
  let fixed = 0;
  for (const p of paras) {
    if (!Array.isArray(p.bbox) || p.bbox.length !== 4) continue;
    const key = p.bbox.join(',');
    const k = seen.get(key) || 0;
    seen.set(key, k + 1);
    if (k === 0) continue;
    const [x0, y0, x1, y1] = p.bbox;
    const pad = 0.5 * k;
    let ny0 = Math.min(y1 - 1, y0 + pad);
    let ny1 = Math.max(ny0 + 1, y1 - pad);
    let nx0 = x0;
    let nx1 = x1;
    if (ny1 - ny0 < 1) {
      ny0 = y0;
      ny1 = y1;
      nx0 = Math.min(nx1 - 1, x0 + 0.4 * k);
      nx1 = Math.max(nx0 + 1, x1 - 0.4 * k);
    }
    p.bbox = [round(nx0), round(ny0), round(nx1), round(ny1)];
    fixed += 1;
  }
  return fixed;
}

/**
 * 页面位置修正（从 buildPagesFromRaw 里抽出来的，重算脚本 `recompute-layout.js` 复用同一套）。
 *
 * 页眉（running head）在 IEEE 双栏页上常是该行唯一的大字号文本，`classifyRich` 会把它判成
 * section；但正文首行也贴页面顶沿，所以只有「版式特征（RUNNING_HEAD_RE）」或
 * 「通栏全大写 + 短行」才纠正成 header。就地修改 rich，返回同一对象。
 *
 * @param {Object} rich classifyRich 的返回值
 * @param {{yTop:number}} block
 * @param {{height:number}} page 该页（raw 页对象，height=getViewport 可视高）
 * @param {string} text 该段文本（已清洗）
 */
export function adjustRoleForPage(rich, block, page, text) {
  const height = Number(page && page.height) || 0;
  if (!(height > 0)) return rich;
  const atTop = block.yTop >= height * 0.93;
  if (!atTop) return rich;
  const headLetters = String(text).replace(/[^A-Za-z]/g, '');
  const capsHead =
    headLetters.length >= 12 && headLetters.replace(/[^A-Z]/g, '').length / headLetters.length >= 0.8;
  const headLike = String(text).length <= 120 && (RUNNING_HEAD_RE.test(text) || capsHead);
  if (rich.role === 'section' || (rich.role === 'body' && headLike)) {
    rich.role = 'header';
    rich.tier = 'small';
  }
  return rich;
}

/**
 * 衔接点唯一入口（§16.2）：输入 RawPage[]，输出 ExtractPage[]。
 * @param {Array<{pageNo:number,width:number,height:number,items:Array}>} rawPages
 * @param {{paragraphChars?:number, roleRules?:Object, lineGapRatio?:number, columnRules?:Object}} [opts]
 * @returns {Array<{pageNo:number,width:number,height:number,columns:'1'|'2',splitX:number|null,evidence:Object,paras:Array}>}
 */
export function buildPagesFromRaw(rawPages, opts = {}) {
  const paragraphChars = opts.paragraphChars || 600;
  const pages = rawPages || [];

  // 第一遍：逐页独立判定（含行聚合），并收集双栏页的 splitX
  const prelim = pages.map((raw) => {
    const lines = groupLines(raw.items);
    const col = detectColumns(lines, raw.width, opts.columnRules || {});
    return { raw, lines, col };
  });

  // 文档级先验：同一篇文献的栏位是统一的。多数页判为双栏且 splitX 一致时，
  // 对个别判不出的页（被图表/表格盖住栏缝）沿用文档 splitX —— 否则单页会串栏。
  const widths = prelim.map((p) => p.raw.width).filter((w) => w > 0);
  const firstWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
  const twoColPages = prelim.filter((p) => p.col.columns === 2 && p.col.splitX != null);
  let docSplitX = null;
  if (twoColPages.length >= Math.max(2, Math.ceil(prelim.length * 0.4))) {
    const xs = twoColPages.map((p) => p.col.splitX).sort((a, b) => a - b);
    const median = xs[Math.floor(xs.length / 2)];
    const consistent = xs.every((x) => Math.abs(x - median) <= firstWidth * 0.04);
    if (consistent) docSplitX = median;
  }
  if (docSplitX != null) {
    for (const p of prelim) {
      if (p.col.columns === 2) continue;
      // 图重的页（一栏大半被插图占住）侧行很少，默认阈值判不出栏；这类页的栏缝往往也不在文档 median 位置上
      // （实测 1.11 p9：本页栏缝 325.3，文档 median 300.72），沿用 median 切不干净、会把两栏同一基线的行拼成一句。
      // 所以先用放宽阈值按本页自己的直方图再判一次，判出来就用本页的 splitX/gap。
      const loose = detectColumns(p.lines, p.raw.width, { minSideShare: 0.25, maxCrossShare: 0.45 });
      if (loose.columns === 2 && loose.splitX != null) {
        p.col = { ...loose, evidence: { ...loose.evidence, strategy: 'relaxed-page' } };
        continue;
      }
      const left = p.lines.filter((l) => l.x1 <= docSplitX + 1);
      const right = p.lines.filter((l) => l.x0 >= docSplitX - 1);
      const leftChars = left.reduce((a, l) => a + l.text.length, 0);
      const rightChars = right.reduce((a, l) => a + l.text.length, 0);
      const share = Math.min(left.length, right.length) / (left.length + right.length || 1);
      // 图重的页（一栏大半被插图占住）只剩个位数的行在那一侧，share 会低到 0.15 上下；
      // 这类页若沿用「单栏」就会把左右两栏同一基线的行拼成一句（产出跨两栏的烂段），
      // 因此两侧各有 3 行就沿用文档 splitX。
      if (left.length >= 3 && right.length >= 3 && share >= 0.12 && leftChars > 0 && rightChars > 0) {
        p.col = {
          columns: 2,
          splitX: docSplitX,
          evidence: { ...p.col.evidence, strategy: 'document-prior', reason: 'ok(document-prior)', ratio: Number((leftChars / (leftChars + rightChars)).toFixed(2)), sideLineShare: Number(share.toFixed(2)) },
        };
      }
    }
  }

  // 文档级正文字号：按「字符数」加权的众数（0.5pt 分桶）。
  // 旧版取「块字号的绝对值中位数」，而块字号被 drop cap / 图注 / 脚注一起平均，
  // 基准一旦偏低，ratio = 块字号/基准 就把 10pt 正文判成 section、17pt 标题判成 h1 之外的东西。
  const docBodyFont = estimateBodyFont(prelim) || 10;

  const out = [];
  for (const { raw, lines, col } of prelim) {
    // 双栏页按**真实栏缝**重切一遍行：预扫描用的「大间隙即切」会把图注一行
    // （"Fig.1." + 12pt 视觉间隙 + "Traditional"）也切成两行，进而碎成多个段落。
    const splitAt =
      col.columns === 2 && col.splitX != null
        ? { at: col.splitX, from: col.gapStartX ?? col.splitX - 1, to: col.gapEndX ?? col.splitX + 1, minGap: 2 }
        : null;
    const pageLines = splitAt ? groupLines(raw.items, { splitAt }) : lines;
    const bodyFont = estimateBodyFont([{ lines: pageLines }]) || docBodyFont;
    // 首字下沉（drop cap）会在 x/y 上把句首字母抛到第二行，先搬回上一行行首，
    // 否则一个句子会被拆成「CONTROL SYSTEM…」+「A mobile robot…」两段。
    const ordered = hoistDropCaps(orderLines(pageLines, col, raw.width), bodyFont);
    const blocks = mergeParagraphs(ordered, { paragraphGapRatio: opts.paragraphGapRatio, bodyFont });
    // 双栏版式会把一个句子从栏底折到栏顶（"…cooperative so-" + "lution of problems…"）。
    // 这种半句片段单独送翻时，模型会自动"补全上下文"，把相邻片段的内容也译进来，
    // 译文与段落就不再一一对应（表现为相邻两段译文互相吞并、内容重复）。
    // 因此在分类之前先把「未结束 + 小写开头」的相邻块拼回去。
    const joined = joinContinuations(blocks, bodyFont);
    const figures = pickFigures(opts.pageFigures, raw.pageNo);
    const paras = [];
    let prevBottom = null; // 上一块底边 y（同一页，用于算 gap_pct）
    for (const b of joined) {
      let cleaned = cleanParagraphText(b.text);
      if (!cleaned) continue;
      // item 级修复（spaceFix.restoreSpacesInItems）看不到「跨 item 的粘连」：
      // 词间空格被负字距压成 0.3pt 的小正间隙时，groupLines 的 gap>0.25*avgCharW 判据不补空格，
      // 于是拿到 `Layers of` + `control` → `ofcontrol` 这种词。段落成形后整段再扫一遍，
      // 用同一份文档词表把粘连切开（幂等：已正确的词没有连续 5 字母长串，直接原样返回）。
      if (opts.spaceVocab) cleaned = restoreSpaces(cleaned, opts.spaceVocab);
      const rich = classifyRich(b, bodyFont, raw.width, opts.roleRules, {
        figureBoxes: figures,
        pageHeight: raw.height,
      });
      // 页眉（running head）：贴在页面最上沿、字号又恰好偏大的行（IEEE 双栏页的
      // "14 IEEE JOURNAL OF ROBOTICS AND AUTOMATION, …"）会被 ratio 判成 section，
      // 这里按位置纠正成 header —— 否则译文栏里会把它当成一级标题渲染。
      // 正文首行也贴页顶，所以只有「版式特征 / 通栏全大写 + 短行」才按页眉处理。
      adjustRoleForPage(rich, b, raw, cleaned);
      // 单字符游离碎片（上标、图注里的散字母 "B"/"I"/"n"）：翻出来没有意义，
      // 还会在白送进模型的批次里占号、拉偏分批对齐。属于公式的除外。
      if (!rich.isMath && cleaned.length <= 2 && !/\d/.test(cleaned)) continue;
      // 同理：只有标点/数字/单字母的「图上标注碎片」（`I ,`、`, I`、`I 1`）整段没有一个
      // 三个字母以上的英文词，翻出来是乱码，直接丢弃（保留公式段）。
      if (!rich.isMath && !/[A-Za-z]{3,}/.test(cleaned)) continue;
      // 块上方空白占页高百分比（精排输入之一；pdf.js 坐标 y 向上，上方块 yBottom 更大）
      let gapPct = 0;
      if (prevBottom != null && raw.height > 0) {
        gapPct = Math.max(0, Math.round(((prevBottom - b.yTop) / raw.height) * 1000) / 10);
      }
      prevBottom = b.yBottom;
      const pieces = splitParagraphs(cleaned, { maxChars: paragraphChars });
      // **每个子段单独算 bbox**：旧代码把块级包围盒原样复制给 k 个子段，
      // 于是同一页出现 k 段共享完全相同的 bbox（全库 404 组 / 937 段）。
      // 前端按 bbox 定位时这些段会叠在同一块区域上，译文只能互相压字。
      const boxes = splitBlockBBox(b, pieces);
      for (let i = 0; i < pieces.length; i += 1) {
        paras.push({
          text: pieces[i],
          isMath: rich.isMath,
          isLabel: rich.isLabel,
          isHeading: rich.isHeading,
          role: rich.role,
          tier: rich.tier,
          align: rich.align,
          ratio: Math.round(rich.ratio * 1000) / 1000,
          gapPct,
          bbox: boxes[i],
        });
      }
    }
    // 兜底：跨块的 bbox 完全重合（两段文本来自不同块却落在同一区域）也拆开
    dedupeBBoxes(paras);
    out.push({
      pageNo: raw.pageNo,
      width: round(raw.width),
      height: round(raw.height),
      columns: col.columns === 2 ? '2' : '1',
      splitX: col.splitX == null ? null : round(col.splitX),
      evidence: col.evidence,
      paras,
    });
  }
  // 页眉/页脚去重后再返回（只影响「重复且贴边」的文本）
  dropRepeatedMarginalia(out);
  return out;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export default {
  buildPagesFromRaw,
  groupLines,
  detectColumns,
  orderLines,
  mergeParagraphs,
  joinContinuations,
  classifyRole,
  classifyRich,
  adjustRoleForPage,
  dropRepeatedMarginalia,
  isCaptionText,
  splitBlockBBox,
  dedupeBBoxes,
  CAPTION_MAX_CHARS,
};
