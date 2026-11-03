/**
 * 译文面板：按页渲染段落（原文 + 译文），点段落回调给阅读器做「跳页 + 高亮」。
 * 两档显示：对照（原文小字 + 译文）/ 仅译文（只显示译文，便于通读）。
 *
 * 排版：每个段按 role/tier/align 加 class（来自抽取层 classifyRich 或 AI 精排），
 * 并由 reader.css 还原标题层级 / 引用 / 列表 / 段落间距；译文按 Markdown 渲染，
 * 这样模型在翻译时输出的 # 标题、- 列表、> 引用 能真正变成结构。
 */
const MD_OK = Boolean(window.marked && window.DOMPurify);

/** 由段属性推导 role/tier/align（兼容没有精排、只有 is_heading/is_math 的旧数据） */
function classify(para) {
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

/** 把译文渲染成 Markdown（安全：先过 DOMPurify）；公式段与图内标注保留原文本 */
function renderDst(dstEl, para) {
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

export class TranslatePanel {
  /**
   * @param {HTMLElement} listEl
   * @param {{onSelect:(para:Object)=>void}} opts
   */
  constructor(listEl, { onSelect }) {
    this.listEl = listEl;
    this.onSelect = onSelect;
    this.mode = 'dual';
    this.pages = new Map(); // pageNo → {el, paras}
    this.activeId = null;
  }

  setMode(mode) {
    this.mode = mode;
    const only = mode === 'dst';
    this.listEl.classList.toggle('dst-only', only);
    for (const { el } of this.pages.values()) el.classList.toggle('dst-only', only);
    // 这里**不能**重排 DOM：仅译文模式由 CSS 隐藏原文行即可，
    // 重建会让正在拖动的滚动位置跳回顶部（早先 setMode 调 rerender() 的副作用）。
    if (!this.pages.size) this.ensureHint();
  }

  ensureHint() {
    if (this.pages.size) return;
    if (this.listEl.querySelector('.hint')) return;
    const tip = document.createElement('div');
    tip.className = 'hint';
    tip.textContent = '还没有段落：先点上方「全文翻译」，或确认这份 PDF 已完成文本抽取。';
    this.listEl.append(tip);
  }

  /** 批量渲染（首次载入） */
  render(pages) {
    this.listEl.textContent = '';
    this.pages.clear();
    for (const p of pages) this.appendPage(p);
    this.ensureHint();
  }

  /** 单页追加/替换（SSE event: page 用） */
  appendPage(page) {
    const scroller = this.listEl.closest('.dst-pane');
    const keepTop = scroller ? scroller.scrollTop : 0;
    const prev = this.pages.get(page.pageNo);
    if (prev) prev.el.remove();
    const el = document.createElement('div');
    el.className = 'dst-page';
    if (this.mode === 'dst') el.classList.add('dst-only');
    const title = document.createElement('div');
    title.className = 'dst-page-title';
    title.textContent = `第 ${page.pageNo} 页`;
    el.append(title);
    const paras = [];
    for (const para of page.paras) {
      const { role, tier, align } = classify(para);
      const item = document.createElement('div');
      item.className =
        `dst-para role-${role} tier-${tier} align-${align}` +
        `${para.isMath ? ' math' : ''}${para.isLabel ? ' label' : ''}`;
      item.dataset.segmentId = String(para.segmentId);
      const src = document.createElement('div');
      src.className = 'src';
      // 原文不再截断到 160 字：对照阅读时被截掉的半句反而更费解，
      // 而且这也是「译文/原文对不上」的观感来源之一。
      src.textContent = para.isMath ? '（公式段，不翻译）' : para.text;
      const dst = document.createElement('div');
      dst.className = 'dst';
      renderDst(dst, para);
      item.append(src, dst);
      item.addEventListener('click', () => {
        this.setActive(para.segmentId);
        this.onSelect(para);
      });
      el.append(item);
      paras.push({ para, el: item });
    }
    this.pages.set(page.pageNo, { el, paras });
    // 就地插入（按页码升序），不整块重建 —— 边翻译边阅读时不能把滚动位置弹回顶部。
    const hint = this.listEl.querySelector('.hint');
    if (hint) hint.remove();
    let anchor = null;
    for (const [no, v] of this.pages.entries()) {
      if (no > page.pageNo && (!anchor || no < anchor.no)) anchor = { no, el: v.el };
    }
    if (anchor) this.listEl.insertBefore(el, anchor.el);
    else this.listEl.append(el);
    if (scroller) scroller.scrollTop = keepTop;
  }

  setActive(segmentId) {
    this.activeId = segmentId;
    for (const { paras } of this.pages.values()) {
      for (const p of paras) p.el.classList.toggle('active', p.para.segmentId === segmentId);
    }
  }

  /** 原地刷新所有段落的译文（不重建 DOM，滚不动） */
  rerender() {
    for (const { paras } of this.pages.values()) {
      for (const p of paras) {
        const dst = p.el.querySelector('.dst');
        if (!dst) continue;
        dst.className = 'dst';
        dst.textContent = '';
        renderDst(dst, p.para);
      }
    }
  }

  /** 已渲染段数 / 已译段数（进度条之外的自检口径） */
  stats() {
    let total = 0;
    let done = 0;
    for (const { paras } of this.pages.values()) {
      for (const p of paras) {
        total += 1;
        if (p.para.dst) done += 1;
      }
    }
    return { total, done };
  }
}
