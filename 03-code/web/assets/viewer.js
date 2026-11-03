/**
 * pdf.js 渲染层（canvas + 文本层 + 高亮层）。
 *
 * 说明（两条有意的简化，均已写入 STATUS.md 的偏离点）：
 *  ① 文本层不用 pdf.js 内部的 TextLayer 类，而是用 `getTextContent()` 的 items 自己摆 span：
 *     少了内部 API 随版本漂移的风险（D17：pdfjs 锁版本），代价是与字形宽度有细微偏差，
 *     但「文字可选中」这个目标成立。
 *  ② 高亮不改原文排版：只用 `segments.bbox` 画半透明矩形（§M2b 需求），
 *     **不做**「译文按原版式盖回原文位置」的字体级回填。
 */
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/** 向上找到真正产生滚动的祖先（`#pages` 自己是普通 div，滚动发生在 `.pdf-pane`） */
function findScrollParent(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return n;
  }
  return null;
}

export class Viewer {
  /**
   * @param {HTMLElement} host 页面节点容器（`#pages`，本身通常不滚动）
   * @param {{scrollHost?: HTMLElement}} [opts] 真正的滚动容器；不给则自动向上探测
   */
  constructor(host, opts = {}) {
    this.host = host;
    // 关键：滚动容器与「页面节点容器」常常不是同一个元素。若把 host 当滚动容器，
    // IntersectionObserver 的 root、scroll 监听、scrollTo/scrollTop 全部作用在错误对象上，
    // 表现就是「页码不跟随滚动、点译文不跳转 / 跳错位置」。
    this.scrollHost = opts.scrollHost || findScrollParent(host) || host;
    this.doc = null;
    this.scale = 1.35;
    this.numPages = 0;
    this.onPageChange = null; // 翻页时回调：(pageNo) => void
    this.pageEls = new Map(); // pageNo → {wrap, canvas, textLayer, hlLayer}
    this.pageTops = new Map(); // pageNo → 该页顶部在「滚动内容坐标」里的 y
    this.rendered = new Set();
    this.observing = null;
    this.currentPage = 1;
    this._onScroll = () => this.trackCurrentPage();
    this._onResize = null;
    this._scrollAttached = false;
  }

  /** @param {string} url 通常是 /api/assets/:id/file */
  async open(url) {
    this.teardown();
    this.host.textContent = '';
    this.pageEls.clear();
    this.pageTops.clear();
    this.rendered.clear();
    this.currentPage = 1;
    // pdf.js 6.x 的图像解码器（JBIG2 / JPEG2000）、CMap、标准字体、ICC 都必须显式给出资源地址。
    // 缺了它们，JBIG2 压缩的扫描页会整页解码失败（Jbig2Error: failed to initialize）→ 画布空白，
    // 只剩可抽取的文本层——表现就是「PDF 打开了但整页白」。
    const vbase = new URL('./vendor/pdfjs/', import.meta.url);
    this.doc = await pdfjsLib.getDocument({
      url,
      isEvalSupported: false,
      wasmUrl: new URL('wasm/', vbase).href,
      cMapUrl: new URL('cmaps/', vbase).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', vbase).href,
      iccUrl: new URL('iccs/', vbase).href,
    }).promise;
    this.numPages = this.doc.numPages;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const pageNo = Number(e.target.dataset.page);
        this.renderPage(pageNo).catch(() => {});
      }
    }, { root: this.scrollHost, rootMargin: '400px 0px' });
    this.observing = io;

    let firstViewport = null;
    for (let i = 1; i <= this.doc.numPages; i += 1) {
      const page = await this.doc.getPage(i);
      const viewport = page.getViewport({ scale: this.scale });
      if (!firstViewport) firstViewport = viewport;
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.page = String(i);
      wrap.style.width = `${Math.floor(viewport.width)}px`;
      wrap.style.height = `${Math.floor(viewport.height)}px`;
      wrap.style.setProperty('--scale-factor', String(this.scale));
      const canvas = document.createElement('canvas');
      wrap.append(canvas);
      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      wrap.append(textLayer);
      const hlLayer = document.createElement('div');
      hlLayer.className = 'hl-layer';
      wrap.append(hlLayer);
      this.host.append(wrap);
      this.pageEls.set(i, { wrap, canvas, textLayer, hlLayer, viewport });
      io.observe(wrap);
    }
    // 监听真正的滚动容器；同时随窗口尺寸变化重算页面位置（换行/缩放都会改变纵向偏移）
    if (!this._scrollAttached) {
      this.scrollHost.addEventListener('scroll', this._onScroll, { passive: true });
      this._scrollAttached = true;
    }
    this._onResize = this._onResize || (() => {
      this.measurePageTops();
      this.trackCurrentPage();
    });
    window.removeEventListener('resize', this._onResize);
    window.addEventListener('resize', this._onResize);
    this.scrollHost.scrollTop = 0;
    this.measurePageTops();
    this.trackCurrentPage();
    return { numPages: this.doc.numPages, firstViewport };
  }

  /** 解绑滚动/尺寸监听与观察器（重复 open 或销毁时调用，避免监听器叠加） */
  teardown() {
    if (this.observing) {
      this.observing.disconnect();
      this.observing = null;
    }
    if (this._scrollAttached) {
      this.scrollHost.removeEventListener('scroll', this._onScroll);
      this._scrollAttached = false;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
  }

  /**
   * 缓存每页顶部在「滚动内容坐标」里的位置。
   * 不能用 `wrap.offsetTop`：`.page-wrap` 是 position:relative，offsetParent 可能是 body，
   * 于是 offsetTop 与 scrollHost.scrollTop 不在同一坐标系（差一个顶栏+工具条的高度），
   * 页码判断和 scrollTo 都会系统性偏移。用两者 rect 的差值换算才与滚动容器严格对齐。
   */
  measurePageTops() {
    if (!this.pageEls.size) return;
    const shRect = this.scrollHost.getBoundingClientRect();
    const base = this.scrollHost.scrollTop - shRect.top; // 内容坐标 = rect.top + base
    for (const [pageNo, entry] of this.pageEls) {
      this.pageTops.set(pageNo, Math.round(entry.wrap.getBoundingClientRect().top + base));
    }
  }

  async renderPage(pageNo) {
    if (this.rendered.has(pageNo) || !this.doc) return;
    this.rendered.add(pageNo);
    try {
      const entry = this.pageEls.get(pageNo);
      const page = await this.doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: this.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = entry.canvas;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;
      await this.buildTextLayer(page, viewport, entry.textLayer);
    } catch (e) {
      // 渲染失败不再静默（原先 .catch(()=>{}) 会把错误吞掉，只留下白页让人猜）：
      // 回滚 rendered 标记允许重试，并大声报错。
      this.rendered.delete(pageNo);
      console.error(`[viewer] 第 ${pageNo} 页渲染失败`, e);
    }
  }

  /** 手工文本层：真实文本 + 透明色，可选中可复制 */
  async buildTextLayer(page, viewport, container) {
    const tc = await page.getTextContent();
    container.style.setProperty('--scale-factor', String(this.scale));
    const frag = document.createDocumentFragment();
    for (const item of tc.items) {
      if (!item.str || !item.str.trim()) continue;
      const tr = item.transform;
      const [x, y] = viewport.convertToViewportPoint(tr[4], tr[5]);
      const fontSize = Math.abs(tr[3] || tr[0]) * this.scale;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.left = `${x}px`;
      span.style.top = `${y - fontSize}px`;
      span.style.fontSize = `${fontSize}px`;
      span.style.fontFamily = 'serif';
      frag.append(span);
    }
    container.textContent = '';
    container.append(frag);
  }

  trackCurrentPage() {
    if (!this.pageEls.size) return;
    const top = this.scrollHost.scrollTop;
    let best = 1;
    for (const pageNo of this.pageEls.keys()) {
      const pt = this.pageTops.get(pageNo);
      if (pt === undefined) continue;
      if (pt - 80 <= top) best = pageNo;
    }
    if (best !== this.currentPage) {
      this.currentPage = best;
      if (this.onPageChange) this.onPageChange(best);
    }
  }

  /** 滚到某页并把该段高亮出来 */
  async scrollToSegment(pageNo, bbox) {
    const entry = this.pageEls.get(pageNo);
    if (!entry) return;
    await this.renderPage(pageNo);
    if (!this.pageTops.size) this.measurePageTops();
    const top = this.pageTops.get(pageNo) ?? 0;
    this.scrollHost.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
    entry.wrap.classList.add('target');
    setTimeout(() => entry.wrap.classList.remove('target'), 1600);
    for (const e of this.pageEls.values()) e.hlLayer.textContent = '';
    if (Array.isArray(bbox) && bbox.length === 4) {
      // pdf.js 6.x 的 PageViewport 只保留 convertToViewportPoint，
      // 旧版的 convertToViewportRectangle 已被移除（调用会抛 TypeError，高亮框永远画不出来）。
      // 这里用对角两点自行换算矩形：PDF 坐标 y 轴朝上，viewport 朝下，由 convertToViewportPoint 负责翻转。
      const [ax, ay] = entry.viewport.convertToViewportPoint(bbox[0], bbox[1]);
      const [bx, by] = entry.viewport.convertToViewportPoint(bbox[2], bbox[3]);
      const left = Math.min(ax, bx);
      const topY = Math.min(ay, by);
      const w = Math.abs(bx - ax);
      const h = Math.abs(by - ay);
      if (w > 0.5 && h > 0.5) {
        const box = document.createElement('div');
        box.className = 'hl-box';
        box.style.left = `${left}px`;
        box.style.top = `${topY}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
        entry.hlLayer.append(box);
      }
    }
    this.currentPage = pageNo;
    if (this.onPageChange) this.onPageChange(pageNo);
  }

  /** 翻到指定页（页码从 1 开始），平滑滚动到该页顶部 */
  goToPage(pageNo) {
    if (!this.doc) return;
    const n = Math.min(this.numPages, Math.max(1, pageNo));
    const entry = this.pageEls.get(n);
    if (!entry) return;
    this.renderPage(n);
    if (!this.pageTops.size) this.measurePageTops();
    const top = this.pageTops.get(n) ?? 0;
    this.scrollHost.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
    this.currentPage = n;
    if (this.onPageChange) this.onPageChange(n);
  }

  /** 调整渲染缩放比并就地重绘当前可见页（不刷新页面） */
  async setScale(s) {
    s = Math.min(3, Math.max(0.5, s));
    this.scale = s;
    if (!this.doc) return;
    // 用滚动容器的可视区判断「哪些页在视口附近」：拿 #pages 的 rect 会把整篇文档都算成可见，
    // 一放大就把所有页全部重绘。
    const viewRect = this.scrollHost.getBoundingClientRect();
    const visible = [];
    for (let i = 1; i <= this.numPages; i += 1) {
      const entry = this.pageEls.get(i);
      const page = await this.doc.getPage(i);
      const viewport = page.getViewport({ scale: this.scale });
      entry.viewport = viewport;
      entry.wrap.style.width = `${Math.floor(viewport.width)}px`;
      entry.wrap.style.height = `${Math.floor(viewport.height)}px`;
      entry.wrap.style.setProperty('--scale-factor', String(this.scale));
      entry.canvas.width = 1; // 清空旧位图，renderPage 会按新缩放重设
      entry.canvas.height = 1;
      entry.textLayer.textContent = '';
      entry.hlLayer.textContent = '';
      this.rendered.delete(i);
      const r = entry.wrap.getBoundingClientRect();
      if (r.bottom > viewRect.top - 400 && r.top < viewRect.bottom + 400) visible.push(i);
    }
    this.measurePageTops();
    for (const i of visible) this.renderPage(i).catch(() => {});
    this.trackCurrentPage();
  }
}
