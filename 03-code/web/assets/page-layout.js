/**
 * 版式还原层：把「每页段落 + bbox」排成一张按原文版式还原的纸。
 *
 * 坐标约定：segments.bbox = [x0, y0, x1, y1]，单位是 PDF 点，原点在左下角、y 轴向上。
 * 换到 DOM 时：
 *   k     = 容器宽度 / 页宽（纸宽铺满右栏，页高按同一比例缩放）
 *   left  = x0 * k
 *   top   = (pageHeight - y1) * k
 *   width = (x1 - x0) * k
 *
 * 排版策略（简单分层，不做完整约束求解）：
 *   1. 先按 bbox 绝对定位，字号 = 正文基准字号 × ratio × k（正文基准按页宽估算）；
 *   2. 插入后统一测量每段实际高度（译文比原文长时会向下撑开）；
 *   3. 自上而下放置：若与已放置段落「水平、垂直都相交」（同栏才相交），
 *      就把它推到相交段落底边之下，反复直到不再相交。
 *   这样双栏不会串行（两栏 x 区间不重叠，互不推挤），同一 bbox 的多段会按 ord
 *   顺序垂直堆叠，页脚/脚注被上方长段落推下去也不会叠字。
 *
 * 降级：单段 bbox 非法 → 排到本页末尾的线性区；整页没有有效 bbox → 由
 * TranslatePanel 退回原来的线性列表。viewer 未就绪时按 API 的 aspect（或 A4）
 * 占位，拿到真实页尺寸后重排。
 */

const MIN_FONT_PX = 5;
const MAX_FONT_PX = 64;
const MAX_PT = 20000;

export const MD_OK =
  typeof window !== 'undefined' && Boolean(window.marked && window.DOMPurify);

/** 由段属性推导 role/tier/align（兼容没有精排、只有 is_heading/is_math 的旧数据） */
export function classify(para) {
  let role = para.role || 'body';
  let tier = para.tier || null;
  let align = para.align || 'left';
  if (para.isMath && (role === 'body' || role === 'equation')) {
    role = 'equation';
    tier = 'body';
    align = 'center';
  }
  if (para.isHeading && (role === 'body' || !tier)) {
    role = 'section';
    tier = 'h2';
  }
  if (!tier) {
    if (role === 'title') tier = 'h1';
    else if (role === 'section') tier = 'h2';
    else if (role === 'equation') tier = 'body';
    else if (['footnote', 'reference', 'caption', 'figure-label', 'header', 'footer', 'page-number', 'list-item'].includes(role)) tier = 'small';
    else tier = 'body';
  }
  return { role, tier, align };
}

/**
 * 把译文渲染成 Markdown（安全：先过 DOMPurify）；公式段与图内标注保留原文本。
 * @param {HTMLElement} dstEl
 * @param {Object} para
 * @param {{layout?:boolean}} [opts] layout=true 时（版式页）缺译文用原文占位，避免整页「（未翻译）」
 */
export function renderDst(dstEl, para, opts = {}) {
  if (para.isMath) {
    dstEl.textContent = para.text;
    dstEl.classList.add('empty', 'math-raw');
    return;
  }
  // 图内标注（"Fig.1." "Sensors → Actuators" 这类）按设计不送翻译，
  // 早先一律写「（未翻译）」，一页里能出现十几条，看着像翻译挂了。
  // 页眉/页脚/页码同理：它们是跨页重复的栏目信息，服务端不送翻，这里直接显示原文。
  const untranslatedByDesign =
    para.isLabel ||
    para.role === 'header' ||
    para.role === 'footer' ||
    para.role === 'page-number';
  if (untranslatedByDesign) {
    // 即便库里还留着历史译文（早期版本翻过页眉，出现 `18 SEEE JOURNAL…` 这类半成品），
    // 也一律显示原文：这类段落在服务端已经不送翻，显示旧译文只会更乱。
    dstEl.textContent = para.text;
    dstEl.classList.add('label-src');
    return;
  }
  const text = para.dst;
  if (!text) {
    // 版式页按 bbox 还原，空段会留下一个空格子；用原文占位既能看到版式，也知道这段还没译。
    if (opts.layout) {
      dstEl.textContent = para.text;
      dstEl.classList.add('empty', 'pending-src');
      dstEl.title = '尚未翻译，暂以原文占位';
      return;
    }
    dstEl.textContent = '（未翻译）';
    dstEl.classList.add('empty');
    return;
  }
  if (MD_OK) {
    const raw = window.marked.parse(text, { gfm: true, breaks: false });
    dstEl.innerHTML = window.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    dstEl.classList.add('md');
  } else {
    dstEl.textContent = text;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** 校验 bbox；返回 [x0,y0,x1,y1] 或 null。允许轻微越界，渲染时会再裁到纸内。 */
export function bboxOf(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const v = bbox.slice(0, 4).map(Number);
  if (!v.every(Number.isFinite)) return null;
  const [x0, y0, x1, y1] = v;
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  if (x1 - x0 > MAX_PT || y1 - y0 > MAX_PT) return null;
  if (Math.abs(x0) > MAX_PT || Math.abs(y0) > MAX_PT || Math.abs(x1) > MAX_PT || Math.abs(y1) > MAX_PT) return null;
  return v;
}

/**
 * 页尺寸：API 的真实 width/height（若后续服务端补上）> viewer viewport > API aspect > A4。
 * @param {Object} page  /api/works/:no/segments 的 page
 * @param {{width:number,height:number}|null} viewerSize  viewer 换算出的 PDF 点尺寸
 */
export function pageSizeOf(page, viewerSize) {
  const w = Number(page && (page.width ?? page.pageWidth));
  const h = Number(page && (page.height ?? page.pageHeight));
  if (Number.isFinite(w) && Number.isFinite(h) && w > 50 && h > 50) return { width: w, height: h, source: 'api' };
  if (viewerSize && Number.isFinite(viewerSize.width) && Number.isFinite(viewerSize.height) && viewerSize.width > 50) {
    return { width: viewerSize.width, height: viewerSize.height, source: 'viewer' };
  }
  const aspect = Number(page && page.aspect);
  if (Number.isFinite(aspect) && aspect > 0.2 && aspect < 5) {
    return { width: 612, height: Math.round((612 / aspect) * 100) / 100, source: 'aspect' };
  }
  return { width: 595, height: 842, source: 'a4' };
}

/** 正文字号（pt）：按页宽估算。604pt 的论文纸 ≈ 11.6pt，屏幕上不会缩到看不清。 */
export function bodyFontPt(pageWidth) {
  return clamp(pageWidth / 52, 7, 20);
}

/**
 * 估本页的栏位（只用 bbox，不依赖 PDF 解析）。
 * 单栏：取正文 x0 的 10% 分位到 x1 的 90% 分位；双栏：按中线聚类后取两栏外框。
 * 页面只有零星段落时退回默认版心，至少保证标题不会被挤成竖排。
 */
function columnPlan(records, pageW) {
  const fallback = {
    two: false,
    cols: [{ left: pageW * 0.06, right: pageW * 0.94 }],
    full: { left: pageW * 0.06, right: pageW * 0.94 },
  };
  const usable = records.filter((r) => {
    const w = r.bbox[2] - r.bbox[0];
    return (
      w > pageW * 0.12 &&
      w < pageW * 0.62 &&
      ['body', 'section', 'reference', 'footnote', 'caption'].includes(r.role)
    );
  });
  if (usable.length < 4) return fallback;

  const mid = pageW / 2;
  const left = usable.filter((r) => (r.bbox[0] + r.bbox[2]) / 2 < mid);
  const right = usable.filter((r) => (r.bbox[0] + r.bbox[2]) / 2 >= mid);
  if (left.length >= 3 && right.length >= 3) {
    const span = (rs) => ({
      left: Math.min(...rs.map((r) => r.bbox[0])),
      right: Math.max(...rs.map((r) => r.bbox[2])),
    });
    const l = span(left);
    const rr = span(right);
    if (rr.left - l.right > 2 && l.right - l.left > pageW * 0.18 && rr.right - rr.left > pageW * 0.18) {
      return { two: true, cols: [l, rr], full: { left: l.left, right: rr.right } };
    }
  }

  const q = (arr, p) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    const i = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
    return sorted[i];
  };
  const one = {
    left: q(usable.map((r) => r.bbox[0]), 0.1),
    right: q(usable.map((r) => r.bbox[2]), 0.9),
  };
  if (one.right - one.left < pageW * 0.3) return fallback;
  return { two: false, cols: [one], full: one };
}

/** 同一行右侧最近的邻居（作者名并排、Keywords 与关键词并排）：宽度只能补到它左边，不能压过去 */
function rowInfo(rec, records) {
  const [x0, y0, x1, y1] = rec.bbox;
  const h = y1 - y0;
  let limit = null;
  let neighbor = false;
  for (const o of records) {
    if (o === rec || !o.bbox) continue;
    const [a, b, , d] = o.bbox;
    const overlap = Math.min(y1, d) - Math.max(y0, b);
    if (overlap < Math.min(h, d - b) * 0.5) continue;
    neighbor = true;
    if (a >= x1 - 1 && (limit == null || a - 3 < limit)) limit = a - 3;
  }
  return { neighbor, limit };
}

/**
 * 是否需要单独排一行原文（对照模式）。公式 / 图内标注 / 页眉页脚页码本来就不送翻，
 * .dst 里已经是原文；版式页里「尚未翻译」也用原文占位，再排 .src 只会显示两遍。
 */
function srcVisible(para, role, layout) {
  return (
    !para.isMath &&
    !para.isLabel &&
    !['header', 'footer', 'page-number'].includes(role) &&
    !(layout && !para.dst)
  );
}

/**
 * 生成一个段落节点（线性页与版式页共用）。
 * @param {Object} para
 * @param {{layout?:boolean,onPick?:(para:Object,el:HTMLElement)=>void}} [opts]
 */
export function createParaEl(para, opts = {}) {
  const { role, tier, align } = classify(para);
  const el = document.createElement('div');
  el.className =
    `dst-para role-${role} tier-${tier} align-${align}` +
    `${para.isMath ? ' math' : ''}${para.isLabel ? ' label' : ''}`;
  el.dataset.segmentId = String(para.segmentId);
  el.dataset.ord = String(para.ord);
  const src = document.createElement('div');
  src.className = 'src';
  // 原文不再截断：对照阅读时被截掉的半句反而更费解
  src.textContent = para.isMath ? '（公式段，不翻译）' : para.text;
  const dst = document.createElement('div');
  dst.className = 'dst';
  renderDst(dst, para, { layout: opts.layout });
  if (srcVisible(para, role, opts.layout)) el.append(src);
  el.append(dst);
  if (opts.onPick) {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onPick(para, el);
    });
  }
  return { para, el, src, dst, role, tier, align };
}

/** 行高：标题紧、正文松（中文需要一点行距才不糊成一团） */
function lineHeightOf(role, tier) {
  if (tier === 'h1' || role === 'title') return 1.16;
  if (tier === 'h2' || role === 'section') return 1.3;
  if (['header', 'footer', 'page-number', 'figure-label', 'caption'].includes(role)) return 1.28;
  if (['footnote', 'reference'].includes(role)) return 1.34;
  return 1.4;
}

/** 把 API 的 `pageFigures`（每页一组框）校验成可用的 bbox 数组 */
export function figuresOf(raw) {
  const out = [];
  for (const box of Array.isArray(raw) ? raw : []) {
    const v = bboxOf(box);
    if (v) out.push(v);
  }
  return out;
}

/**
 * 图内文字判断：段 bbox 中心点落在图区里 → 这段文字已经由图片画出来了，
 * 再排一遍会跟插图叠字。中心点在外部、只有边缘擦到的段落（图注、栏间正文）保留。
 */
function insideFigure(box, figures) {
  if (!figures.length) return false;
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  return figures.some(
    ([x0, y0, x1, y1]) => cx >= x0 - 0.5 && cx <= x1 + 0.5 && cy >= y0 - 0.5 && cy <= y1 + 0.5,
  );
}

/**
 * 一页版式纸。
 */
export class SheetPage {
  /**
   * @param {Object} page
   * @param {{mode?:'dual'|'dst', getPageSize?:()=>{width:number,height:number}|null,
   *          onPick?:(para:Object)=>void, onResize?:()=>void,
   *          figures?:Array<[number,number,number,number]>,
   *          onRenderFigure?:(pageNo:number, box:number[], canvas:HTMLCanvasElement,
   *                           opts:{scale:number})=>Promise<boolean>}} opts
   */
  constructor(page, opts = {}) {
    this.page = page;
    this.mode = opts.mode || 'dual';
    this.getPageSize = opts.getPageSize || (() => null);
    this.onPick = opts.onPick || (() => {});
    this.onResize = opts.onResize || null;
    this.onRenderFigure = opts.onRenderFigure || null;
    this.figures = figuresOf(opts.figures);
    this.figureEls = [];
    this.skipped = 0;
    this._figTimer = 0;
    this._lastK = 0;
    this.items = [];
    this._lastWidth = 0;
    this._ro = null;

    const el = document.createElement('div');
    el.className = 'dst-page page-layout';
    el.dataset.page = String(page.pageNo);
    if (this.mode === 'dst') el.classList.add('dst-only');
    this.el = el;

    const title = document.createElement('div');
    title.className = 'dst-page-title';
    title.textContent = `第 ${page.pageNo} 页`;
    this.titleEl = title;

    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    const sheet = document.createElement('div');
    sheet.className = 'page-sheet';
    sheet.setAttribute('role', 'document');
    sheet.setAttribute('aria-label', `第 ${page.pageNo} 页版式还原`);
    wrap.append(sheet);
    this.wrap = wrap;
    this.sheet = sheet;
    el.append(title, wrap);

    // 插图 / 图内图元：按 bbox 把 PDF 原区域重渲染成 canvas，贴在纸面上（文字层下面）。
    // 预览页没有 viewer，renderFigure 为空 → 保留虚线占位框，用来核对图区位置。
    for (const box of this.figures) {
      const canvas = document.createElement('canvas');
      canvas.className = 'page-figure figure-empty';
      canvas.setAttribute('aria-hidden', 'true');
      sheet.append(canvas);
      this.figureEls.push({ box, canvas, k: 0, rendered: false, rendering: false, token: 0 });
    }

    const orphans = [];
    for (const para of page.paras || []) {
      const rec = createParaEl(para, {
        layout: true,
        onPick: (p) => this.onPick(p),
      });
      rec.el.classList.add('page-para');
      const box = bboxOf(para.bbox);
      if (!box) {
        orphans.push(rec);
        continue;
      }
      // 图里的文字（示意图标签、图内正文）已经随插图一起画出来了，跳过，避免叠字
      if (para.role === 'figure' || insideFigure(box, this.figures)) {
        this.skipped += 1;
        continue;
      }
      rec.bbox = box;
      sheet.append(rec.el);
      this.items.push(rec);
    }

    if (orphans.length && this.items.length) {
      const box = document.createElement('div');
      box.className = 'sheet-orphans';
      const tip = document.createElement('div');
      tip.className = 'sheet-orphans-tip';
      tip.textContent = `本页 ${orphans.length} 段缺少位置信息，按段落顺序列在下方`;
      box.append(tip);
      for (const rec of orphans) box.append(rec.el);
      el.append(box);
      this.orphans = box;
    }

    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => {
        const w = this.wrap.clientWidth;
        // 高度变化（自己撑开纸高）也会触发观察，这里只关心宽度
        if (Math.abs(w - this._lastWidth) < 0.75) return;
        if (this.onResize) this.onResize();
        else this.relayout();
      });
      this._ro.observe(wrap);
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.el.classList.toggle('dst-only', mode === 'dst');
    this.relayout();
  }

  setActive(segmentId) {
    for (const rec of this.items) rec.el.classList.toggle('active', rec.para.segmentId === segmentId);
  }

  /** 原地刷新译文（不重建 DOM） */
  refresh() {
    for (const rec of this.items) {
      const dst = rec.el.querySelector('.dst');
      if (!dst) continue;
      dst.className = 'dst';
      dst.textContent = '';
      dst.removeAttribute('title');
      renderDst(dst, rec.para, { layout: true });
      // 译文是后来补上的 → 需要补回原文行；反过来也成立
      if (srcVisible(rec.para, rec.role, true) && !rec.src.isConnected) {
        rec.el.insertBefore(rec.src, dst);
      } else if (!srcVisible(rec.para, rec.role, true) && rec.src.isConnected) {
        rec.src.remove();
      }
    }
    this.relayout();
  }

  relayout() {
    const wrapW = this.wrap.clientWidth;
    if (wrapW < 40) return;
    const size = this.getPageSize() || { width: 612, height: 792 };
    const pageW = Number(size.width) > 50 ? Number(size.width) : 612;
    const pageH = Number(size.height) > 50 ? Number(size.height) : 792;
    const k = wrapW / pageW;
    this._lastWidth = wrapW;

    const scale = this._fontScale();
    const basePt = bodyFontPt(pageW);
    const sheetH = Math.max(1, Math.floor(pageH * k));
    this.sheet.style.width = `${wrapW}px`;
    this.sheet.style.height = `${sheetH}px`;
    this._lastK = k;
    this._layoutFigures(k, pageW, pageH);

    // 先写样式（统一批处理），再统一测量，避免「写→读→写」触发 N 次强制重排
    const plan = columnPlan(this.items, pageW);
    // 跨两栏的整幅块（大标题、双栏下面的整幅正文）：按整页宽排，不能塞进某一栏
    const isFullWidth = (rec) => {
      if (!plan.two) return true;
      const boxW = rec.bbox[2] - rec.bbox[0];
      const cx = (rec.bbox[0] + rec.bbox[2]) / 2;
      if (boxW > pageW * 0.52) return true;
      return (
        (rec.role === 'title' || rec.tier === 'h1' || rec.role === 'section') &&
        rec.align === 'center' &&
        boxW > pageW * 0.2 &&
        Math.abs(cx - pageW / 2) < pageW * 0.14
      );
    };
    for (const rec of this.items) {
      const [x0, y0, x1, y1] = rec.bbox;
      const boxW = x1 - x0;
      const boxH = y1 - y0;
      const ratio = Number(rec.para.ratio);
      const r = Number.isFinite(ratio) && ratio > 0.3 ? ratio : 1;
      const fontPt = basePt * r;
      const single = boxH <= Math.max(10, fontPt * 1.45);
      const alignCenter = rec.align === 'center';
      const cx = (x0 + x1) / 2;
      let band = plan.two ? (cx < plan.cols[1].left ? plan.cols[0] : plan.cols[1]) : plan.full;
      // 跨页居中的大标题、跨两栏的整幅正文在两栏页里占满整个版心
      if (isFullWidth(rec)) band = plan.full;
      const bandW = band.right - band.left;
      const row = rowInfo(rec, this.items);
      const limitPt = Math.min(band.right, row.limit == null ? band.right : row.limit);

      let left = clamp(x0, 0, pageW - 2) * k;
      let width = Math.max(6, (clamp(x1, x0 + 2, pageW) - clamp(x0, 0, pageW - 2)) * k);
      let alignLeft = !alignCenter;

      // 单行短盒（标题、作者行、短小节名）宽度补到栏宽：bbox 常常只有「这一行字」那么宽，
      // 直接拿来排译文会逐词断行；有并排邻居时只补到邻居左侧，绝不压过去。
      const canWiden =
        single &&
        boxW < bandW * 0.75 &&
        limitPt - x0 > boxW * 1.08 &&
        (!alignCenter || (!row.neighbor && boxW < bandW * 0.62));
      if (canWiden) {
        const anchorCenter =
          alignCenter && Math.abs(cx - (band.left + band.right) / 2) <= bandW * 0.08;
        const leftPt = anchorCenter ? band.left : Math.max(x0, band.left);
        left = leftPt * k;
        width = Math.max(6, (limitPt - leftPt) * k);
        alignLeft = !anchorCenter;
      }

      let fs = clamp(basePt * r * k * scale, MIN_FONT_PX, MAX_FONT_PX);
      // 单行标题字号不得明显超过自己的 bbox 高度，否则行高会盖住下一段
      if (single && (rec.role === 'title' || rec.tier === 'h1')) {
        fs = Math.min(fs, Math.max(10, boxH * k * 1.05));
      }
      rec.left = left;
      rec.width = width;
      rec.top0 = Math.max(0, (pageH - y1) * k);
      rec.lineHeight = lineHeightOf(rec.role, rec.tier);
      rec.el.style.left = `${left.toFixed(1)}px`;
      rec.el.style.width = `${width.toFixed(1)}px`;
      rec.el.style.top = `${rec.top0.toFixed(1)}px`;
      rec.el.style.fontSize = `${fs.toFixed(1)}px`;
      rec.el.style.lineHeight = String(rec.lineHeight);
      rec.el.style.textAlign = alignLeft ? 'left' : 'center';
      if (rec.dst) rec.dst.style.textAlign = alignLeft ? 'left' : 'center';
    }

    // ── 排版：按栏「顺排」+ 整页按需缩字号 ──────────────────────────────
    // 不把每段钉死在原 bbox 的 y 上：中文比英文长 1.3–1.8 倍，钉死一定溢出，
    // 一路下推会在纸面底部堆出大片空白、页面被撑到两倍高（这正是用户看到的毛病）。
    // 现在保留原来的一切横向信息（栏宽、缩进、对齐、字号层级、图区占位），
    // 只是让同一栏里的段落按阅读顺序往下排；整页放不下就整页等比缩字号。
    for (const rec of this.items) rec.fsBase = parseFloat(rec.el.style.fontSize) || MIN_FONT_PX;

    // 每段属于哪一栏：与上面算宽度时用的是同一套规则
    for (const rec of this.items) {
      const cx = (rec.bbox[0] + rec.bbox[2]) / 2;
      let band = plan.two ? (cx < plan.cols[1].left ? plan.cols[0] : plan.cols[1]) : plan.full;
      if (isFullWidth(rec)) band = plan.full;
      rec.bandKey = !plan.two ? 'f' : band === plan.cols[0] ? 'l' : band === plan.cols[1] ? 'r' : 'f';
    }

    const marginY = Math.max(3, 0.016 * sheetH);
    const pageBottom = sheetH - marginY * 0.6;
    const obstacles = [];
    for (const fig of this.figureEls) {
      const [x0, y0, x1, y1] = fig.box;
      obstacles.push({
        left: Math.max(0, x0) * k,
        right: Math.min(pageW, x1) * k,
        top: Math.max(0, (pageH - Math.min(y1, pageH)) * k),
        bottom: Math.max(0, (pageH - Math.max(y0, 0)) * k),
      });
    }

    const bands = { l: [], r: [], f: [] };
    for (const rec of this.items) {
      // 页眉/页脚这种页边元素留在原位，不参与顺排，免得被排到正文中间
      rec.anchor = rec.role === 'header';
      rec.heading = rec.role === 'section' || rec.role === 'title' || rec.tier === 'h1' || rec.tier === 'h2';
      bands[rec.bandKey].push(rec);
    }
    for (const key of ['l', 'r', 'f']) {
      bands[key].sort((a, b) => a.top0 - b.top0 || (Number(a.para.ord) || 0) - (Number(b.para.ord) || 0));
    }

    // 图区是障碍物：正文不能压到插图上（插图是 PDF 原图，压上去就糊了）
    const bump = (y, rec) => {
      let cur = y;
      for (let guard = 0; guard < 8; guard += 1) {
        let next = -1;
        for (const o of obstacles) {
          if (rec.left >= o.right - 1 || rec.left + rec.width <= o.left + 1) continue;
          if (cur >= o.bottom - 1 || cur + rec.height <= o.top + 1) continue;
          if (o.bottom > next) next = o.bottom;
        }
        if (next < 0) return cur;
        cur = next + 1.5;
      }
      return cur;
    };

    // 整页宽的块（大标题、双栏下面那种整幅正文）把页切成若干「横段」；
    // 每段里左右两栏各自顺排，段末再把整幅块接在较矮的那一栏之后。
    const wideItems = bands.f.filter((r) => !r.anchor);
    const segIndex = (rec) => {
      let s = 0;
      for (let i = 0; i < wideItems.length; i += 1) if (rec.top0 >= wideItems[i].top0 - 0.5) s = i + 1;
      return s;
    };
    const colSegs = new Map();
    for (const key of ['l', 'r']) {
      for (const rec of bands[key]) {
        const id = `${key}#${segIndex(rec)}`;
        if (!colSegs.has(id)) colSegs.set(id, []);
        colSegs.get(id).push(rec);
      }
    }

    // 仅译文模式可以缩到 0.72 倍把整页塞满；对照模式要放两份文字，只轻度收缩
    const minScale = this.mode === 'dst' ? 0.8 : 0.9;
    let scaleTry = 1;
    let tops = new Map();
    let bottomAll = pageBottom;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      for (const rec of this.items) {
        rec.fs = Math.max(MIN_FONT_PX, rec.fsBase * scaleTry);
        rec.el.style.fontSize = `${rec.fs.toFixed(1)}px`;
      }
      for (const rec of this.items) {
        rec.height = Math.max(1, rec.el.getBoundingClientRect().height);
      }
      tops = new Map();
      for (const rec of bands.f) {
        if (rec.anchor) tops.set(rec, clamp(rec.top0, marginY, Math.max(marginY, pageBottom - rec.height)));
      }
      let cursor = marginY;
      for (let s = 0; s <= wideItems.length; s += 1) {
        const wide = s > 0 ? wideItems[s - 1] : null;
        if (wide) {
          // 整页宽的块尽量留在原位；但别为了"还原原位"把纸撑高——顶到页底就往上收
          const cap = Math.max(marginY, pageBottom - wide.height);
          const y = bump(Math.max(cursor, Math.min(wide.top0, cap)), wide);
          tops.set(wide, y);
          cursor = Math.max(cursor, y + wide.height);
        }
        let segBottom = cursor;
        for (const key of ['l', 'r']) {
          const list = colSegs.get(`${key}#${s}`) || [];
          if (!list.length) continue;
          let prev = null;
          for (const rec of list) {
            const gap = prev == null ? 0 : Math.max(1.5, (rec.heading ? 1.05 : 0.42) * rec.fs);
            const base = prev == null ? Math.max(cursor, rec.top0) : prev + gap;
            const y = bump(base, rec);
            tops.set(rec, y);
            prev = y + rec.height;
          }
          if (prev != null) segBottom = Math.max(segBottom, prev);
        }
        cursor = segBottom;
      }
      bottomAll = cursor;
      this.sheet.dataset.fitScale = scaleTry.toFixed(3);
      this.sheet.dataset.fitNeed = Math.round(bottomAll - marginY) + "/" + Math.round(pageBottom - marginY);
      if (bottomAll <= pageBottom + 1) break;
      if (scaleTry <= minScale + 1e-6) break;
      const room = Math.max(40, pageBottom - marginY);
      const need = Math.max(1, bottomAll - marginY);
      scaleTry = Math.max(minScale, scaleTry * clamp(room / need, 0.55, 0.94));
    }

    for (const rec of this.items) {
      const t = tops.get(rec);
      if (t != null) rec.el.style.top = `${t.toFixed(1)}px`;
    }

    // 兜底：缩到 0.5 倍还放不下才让纸面长高（正常不该发生）
    const limit = Math.ceil(bottomAll + Math.max(4, 6 * k));
    if (limit > sheetH + 1) {
      this.sheet.style.height = `${limit}px`;
      this.sheet.classList.add('grown');
    } else {
      this.sheet.style.height = `${sheetH}px`;
      this.sheet.classList.remove('grown');
    }
  }

  _fontScale() {
    const cs = getComputedStyle(this.el);
    const s = parseFloat(cs.getPropertyValue('--dst-scale'));
    return Number.isFinite(s) && s > 0.2 ? s : 1;
  }

  /* ── 插图 ─────────────────────────────────────────────────── */

  _layoutFigures(k, pageW, pageH) {
    if (!this.figureEls.length) return;
    for (const fig of this.figureEls) {
      const [x0, y0, x1, y1] = fig.box;
      const left = Math.max(0, Math.min(x0, pageW - 1)) * k;
      const right = Math.max(left + 1, Math.min(x1, pageW) * k);
      // PDF 的 y 向上：区域上边界 y1 对应纸上的 (pageH - y1)
      const top = Math.max(0, (pageH - Math.min(y1, pageH)) * k);
      const bottom = Math.max(top + 1, (pageH - Math.max(y0, 0)) * k);
      fig.canvas.style.left = `${left.toFixed(1)}px`;
      fig.canvas.style.top = `${top.toFixed(1)}px`;
      fig.canvas.style.width = `${(right - left).toFixed(1)}px`;
      fig.canvas.style.height = `${(bottom - top).toFixed(1)}px`;
    }
    this._scheduleFigures();
  }

  /** 拖动分栏时会连续触发 relayout：合并成一次渲染，避免反复重画 PDF */
  _scheduleFigures() {
    if (!this.onRenderFigure || this._figTimer) return;
    this._figTimer = setTimeout(() => {
      this._figTimer = 0;
      this._renderFigures();
    }, 160);
  }

  _renderFigures() {
    const k = Math.round(this._lastK * 1000) / 1000;
    for (const fig of this.figureEls) {
      if (fig.rendering) continue;
      // 宽度/缩放变了才重画；字号变化、段落撑开不影响图区
      if (fig.rendered && Math.abs(fig.k - k) < 0.002) continue;
      fig.k = k;
      fig.rendering = true;
      const token = ++fig.token;
      // renderRegion 内部自己乘 devicePixelRatio；这里只传「CSS 像素 / PDF 点」的比例
      Promise.resolve(this.onRenderFigure(this.page.pageNo, fig.box, fig.canvas, { scale: k }))
        .then((ok) => {
          if (token !== fig.token) return;
          fig.rendered = ok !== false;
          fig.canvas.classList.toggle('figure-empty', !fig.rendered);
        })
        .catch(() => {
          if (token !== fig.token) return;
          fig.rendered = false;
          fig.canvas.classList.add('figure-empty');
        })
        .finally(() => {
          fig.rendering = false;
        });
    }
  }

  destroy() {
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._figTimer) {
      clearTimeout(this._figTimer);
      this._figTimer = 0;
    }
    for (const fig of this.figureEls) fig.token += 1;
  }
}
