/**
 * 译文面板：按页渲染段落（原文 + 译文），点段落回调给阅读器做「跳页 + 高亮」。
 *
 * 两种排版（renderMode）：
 *  - layout（默认）：版式还原页，每页一张 .page-sheet，段落按 bbox 绝对定位（见 page-layout.js）；
 *  - flow：原来的线性段落流，作为 bbox 缺失 / 想通读时的降级与备选。
 * 两种排版都支持「对照 / 仅译文」两档：对照 = 原文小字，仅译文 = 隐藏原文。
 *
 * 排版：每个段按 role/tier/align 加 class（来自抽取层 classifyRich 或 AI 精排），
 * 译文按 Markdown 渲染，这样模型在翻译时输出的 # 标题、- 列表、> 引用 能真正变成结构。
 */
import {
  SheetPage,
  bboxOf,
  classify,
  createParaEl,
  pageSizeOf,
  renderDst,
} from './page-layout.js';

const STORE_KEY = 'agentlit.renderMode';

function readSavedRenderMode() {
  try {
    return localStorage.getItem(STORE_KEY) === 'flow' ? 'flow' : 'layout';
  } catch {
    return 'layout';
  }
}

function saveRenderMode(mode) {
  try {
    localStorage.setItem(STORE_KEY, mode);
  } catch {
    /* localStorage 不可用时只影响记忆，不影响本次会话 */
  }
}

/** `pageFigures` 形如 {"1": [[x0,y0,x1,y1], ...]}；键转成数字页码，没有图的页不放进 Map */
function figureMapOf(raw) {
  const map = new Map();
  if (!raw || typeof raw !== 'object') return map;
  for (const [key, boxes] of Object.entries(raw)) {
    const pageNo = Number(key);
    if (!Number.isFinite(pageNo) || !Array.isArray(boxes) || !boxes.length) continue;
    map.set(pageNo, boxes);
  }
  return map;
}

export class TranslatePanel {
  /**
   * @param {HTMLElement} listEl
   * @param {{onSelect?:(para:Object)=>void,
   *          getPageSize?:(pageNo:number)=>{width:number,height:number}|null,
   *          renderMode?:'layout'|'flow',
   *          renderFigure?:(pageNo:number, box:number[], canvas:HTMLCanvasElement,
   *                         opts:{scale:number})=>Promise<boolean>}} opts
   */
  constructor(listEl, { onSelect, getPageSize, renderMode, renderFigure } = {}) {
    this.listEl = listEl;
    this.onSelect = onSelect || (() => {});
    this.getPageSize = getPageSize || null;
    this.renderFigure = renderFigure || null;
    this.figuresByPage = new Map(); // pageNo → 图区 bbox 数组（API 的 pageFigures）
    this.mode = 'dual'; // dual | dst
    this.renderMode = renderMode === 'flow' || renderMode === 'layout' ? renderMode : readSavedRenderMode();
    this.pages = new Map(); // pageNo → {el, page, sheet, paras}
    this.rawPages = new Map(); // pageNo → 原始 page（切换排版时重建）
    this.activeId = null;
    this._raf = 0;
    this.listEl.classList.toggle('dst-only', this.mode === 'dst');
  }

  /** 对照 / 仅译文：只切 class，不重建 DOM；版式页要重排（原文行高度变了） */
  setMode(mode) {
    this.mode = mode === 'dst' ? 'dst' : 'dual';
    const only = this.mode === 'dst';
    this.listEl.classList.toggle('dst-only', only);
    for (const { el } of this.pages.values()) el.classList.toggle('dst-only', only);
    // 这里**不能**重建 DOM：仅译文模式由 CSS 隐藏原文行即可，
    // 重建会让正在拖动的滚动位置跳回顶部（早先 setMode 调 rerender() 的副作用）。
    this.relayoutAll();
    if (!this.pages.size) this.ensureHint();
  }

  /** 版式 / 线性排版切换：两种结构不同，只能重建；重建后尽量留在原来的页 */
  setRenderMode(mode) {
    if (mode !== 'layout' && mode !== 'flow') return;
    if (mode === this.renderMode) return;
    const scroller = this._scroller();
    const keepTop = scroller ? scroller.scrollTop : 0;
    const anchor = this._pickPageAnchor(scroller);
    this.renderMode = mode;
    saveRenderMode(mode);

    const pages = [...this.rawPages.values()].sort((a, b) => a.pageNo - b.pageNo);
    this._clear();
    for (const page of pages) {
      const rec = this._buildPage(page);
      this.pages.set(page.pageNo, rec);
      this.listEl.append(rec.el);
    }
    for (const rec of this.pages.values()) rec.sheet?.relayout();
    if (scroller) {
      const next = anchor && this.pages.get(anchor.no);
      if (next) {
        scroller.scrollTop += next.el.getBoundingClientRect().top - anchor.top;
      } else {
        scroller.scrollTop = keepTop;
      }
    }
    this.ensureHint();
  }

  ensureHint() {
    if (this.pages.size) return;
    if (this.listEl.querySelector('.hint')) return;
    const tip = document.createElement('div');
    tip.className = 'hint';
    tip.textContent = '还没有段落：先点上方「全文翻译」，或确认这份 PDF 已完成文本抽取。';
    this.listEl.append(tip);
  }

  /** 批量渲染（首次载入）；opts.pageFigures = API 顶层 `pageFigures` */
  render(pages, opts = {}) {
    this._clear();
    this.rawPages.clear();
    this.figuresByPage = figureMapOf(opts.pageFigures);
    for (const p of pages || []) this.appendPage(p, { silent: true });
    this.ensureHint();
  }

  /** 单页追加/替换（SSE event: page 用） */
  appendPage(page, opts = {}) {
    const scroller = this._scroller();
    const keepTop = scroller ? scroller.scrollTop : 0;
    const anchor = this._pickAnchor(scroller);

    const prev = this.pages.get(page.pageNo);
    if (prev) {
      if (prev.sheet) prev.sheet.destroy();
      prev.el.remove();
      this.pages.delete(page.pageNo);
    }
    this.rawPages.set(page.pageNo, page);

    const rec = this._buildPage(page);
    this.pages.set(page.pageNo, rec);

    const hint = this.listEl.querySelector('.hint');
    if (hint) hint.remove();

    // 就地插入（按页码升序），不整块重建 —— 边翻译边阅读时不能把滚动位置弹回顶部。
    let before = null;
    for (const [no, r] of this.pages) {
      if (no > page.pageNo && (!before || no < before.no)) before = { no, el: r.el };
    }
    if (before) this.listEl.insertBefore(rec.el, before.el);
    else this.listEl.append(rec.el);

    if (rec.sheet) rec.sheet.relayout();
    // 插在视口上方会整体下移内容：用锚点段落的屏幕位移补回滚动位置
    if (!this._restoreAnchor(scroller, anchor) && scroller && !opts.silent) {
      scroller.scrollTop = keepTop;
    }
  }

  setActive(segmentId) {
    this.activeId = segmentId;
    for (const rec of this.pages.values()) {
      if (rec.sheet) {
        rec.sheet.setActive(segmentId);
        continue;
      }
      for (const p of rec.paras) p.el.classList.toggle('active', p.para.segmentId === segmentId);
    }
  }

  /** 原地刷新所有段落的译文（不重建 DOM，滚不动） */
  rerender() {
    for (const rec of this.pages.values()) {
      if (rec.sheet) {
        rec.sheet.refresh();
        continue;
      }
      for (const { para, el } of rec.paras) {
        const dst = el.querySelector('.dst');
        if (!dst) continue;
        dst.className = 'dst';
        dst.textContent = '';
        dst.removeAttribute('title');
        renderDst(dst, para);
      }
    }
  }

  /** 宽度变化 / 字号变化后重排所有版式页（保持阅读位置） */
  relayoutAll() {
    if (!this.pages.size) return;
    const scroller = this._scroller();
    const anchor = this._pickAnchor(scroller);
    for (const rec of this.pages.values()) rec.sheet?.relayout();
    this._restoreAnchor(scroller, anchor);
  }

  /** 已渲染段数 / 已译段数（进度条之外的自检口径） */
  stats() {
    let total = 0;
    let done = 0;
    for (const page of this.rawPages.values()) {
      for (const para of page.paras || []) {
        total += 1;
        if (para.dst) done += 1;
      }
    }
    return { total, done };
  }

  /* ── 内部：建页 ─────────────────────────────────────────── */

  _buildPage(page) {
    const layoutable = this.renderMode === 'layout' && (page.paras || []).some((p) => bboxOf(p.bbox));
    if (!layoutable) return this._buildLinearPage(page);

    const sheet = new SheetPage(page, {
      mode: this.mode,
      getPageSize: () => this._pageSize(page),
      figures: this.figuresByPage.get(Number(page.pageNo)) || [],
      onRenderFigure: this.renderFigure,
      onPick: (para) => {
        this.setActive(para.segmentId);
        this.onSelect(para);
      },
      onResize: () => this._scheduleRelayout(),
    });
    return {
      page,
      el: sheet.el,
      sheet,
      paras: sheet.items.map((it) => ({ para: it.para, el: it.el })),
    };
  }

  _buildLinearPage(page) {
    const el = document.createElement('div');
    el.className = 'dst-page';
    el.dataset.page = String(page.pageNo);
    if (this.mode === 'dst') el.classList.add('dst-only');
    const title = document.createElement('div');
    title.className = 'dst-page-title';
    title.textContent = `第 ${page.pageNo} 页`;
    el.append(title);
    const paras = [];
    for (const para of page.paras || []) {
      const rec = createParaEl(para, {
        onPick: (p) => {
          this.setActive(p.segmentId);
          this.onSelect(p);
        },
      });
      el.append(rec.el);
      paras.push({ para, el: rec.el });
    }
    return { page, el, sheet: null, paras };
  }

  _pageSize(page) {
    const viewerSize = this.getPageSize ? this.getPageSize(page.pageNo) : null;
    return pageSizeOf(page, viewerSize);
  }

  _clear() {
    for (const rec of this.pages.values()) {
      if (rec.sheet) rec.sheet.destroy();
      rec.el.remove();
    }
    this.pages.clear();
    this.listEl.textContent = '';
  }

  _scroller() {
    return this.listEl.closest('.dst-pane');
  }

  /** 找到视口内第一个可见段落，作为滚动锚点（页面增删/重排时保持阅读位置） */
  _pickAnchor(scroller) {
    if (!scroller) return null;
    const top = scroller.getBoundingClientRect().top + 2;
    for (const el of this.listEl.querySelectorAll('.dst-para')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top) return { el, top: r.top };
    }
    return null;
  }

  _restoreAnchor(scroller, anchor) {
    if (!scroller || !anchor || !anchor.el.isConnected) return false;
    const dy = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(dy) > 0.5) scroller.scrollTop += dy;
    return true;
  }

  _pickPageAnchor(scroller) {
    if (!scroller) return null;
    const top = scroller.getBoundingClientRect().top + 2;
    for (const [no, rec] of this.pages) {
      const r = rec.el.getBoundingClientRect();
      if (r.bottom > top) return { no, top: r.top };
    }
    return null;
  }

  _scheduleRelayout() {
    if (this._raf) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._raf = raf(() => {
      this._raf = 0;
      this.relayoutAll();
    });
  }
}

export { classify, renderDst };
