/**
 * 阅读页编排：打开 PDF → 载入段落/译文 → 触发翻译 → SSE 增量渲染 → 点译文回跳高亮。
 * 业务状态（进度、是否完成）一律以服务端返回为准，前端只渲染。
 *
 * 本文件只负责「编排与观感增强」：面板拖拽、字号/PDF 缩放、页码翻页、译文搜索、
 * 面包屑、对话抽屉开关——均不改动后端接口与既有 class 语义。
 */
import { api, qs } from './api.js';
import { toast, debounce } from './ui.js';
import { Viewer } from './viewer.js';
import { TranslatePanel } from './translate.js';
import { ChatPanel } from './chat.js';

const $ = (id) => document.getElementById(id);
const no = new URL(location.href).searchParams.get('no') || '';

let detail = null;
let viewer = null;
let panel = null;
let chatPanel = null;
let jobId = null;
let es = null;
let refineJobId = null;
let refineEs = null;
const state = {
  engine: '',
  tgtLang: 'zh-CN',
  mode: 'dual',
  extractStatus: 'pending',
};

async function boot() {
  if (!no) {
    toast('缺少 ?no= 参数', 'err');
    return;
  }
  detail = await api.get(`/api/works/${no}`);
  document.title = `${detail.work.no} ${detail.work.title.slice(0, 40)} · 阅读`;
  $('docTitle').textContent = `${detail.work.no} · ${detail.work.title}`;
  $('docMeta').textContent = [detail.work.authors, detail.work.venue, detail.work.year].filter(Boolean).join(' · ');
  $('crumbWork').href = `work.html?no=${encodeURIComponent(no)}`;

  if (!detail.asset || detail.asset.fileState !== 'present') {
    toast('该条目还没有本地 PDF，请先在详情页下载', 'warn', 5000);
    return;
  }
  $('btnRaw').href = `/api/assets/${detail.asset.id}/file`;
  $('btnExport').href = `/api/works/${no}/translation/export?bilingual=1`;

  panel = new TranslatePanel($('dstList'), {
    onSelect: (para) => viewer && viewer.scrollToSegment(para.pageNo, para.bbox),
    getPageSize: (pageNo) => pageSizeFromViewer(pageNo),
    // 版式页里的插图：把 PDF 原区域重渲染进右栏的 canvas；viewer 未就绪时退化成占位框
    renderFigure: (pageNo, box, canvas, opts) =>
      viewer && typeof viewer.renderRegion === 'function'
        ? viewer.renderRegion(pageNo, box, canvas, opts)
        : Promise.resolve(false),
  });
  // 版式页默认「仅译文」：中英文同格上下叠会显得挤，原文在左页 PDF 里已经能看到
  if (panel.renderMode === 'layout') {
    state.mode = 'dst';
    panel.setMode('dst');
    const radio = document.querySelector('input[name="mode"][value="dst"]');
    if (radio) radio.checked = true;
  }
  viewer = new Viewer($('pages'), { scrollHost: $('pdfPane') });
  const savedScale = parseFloat(localStorage.getItem('agentlit.pdfScale'));
  if (savedScale && savedScale > 0) viewer.scale = savedScale;
  await viewer.open(`/api/assets/${detail.asset.id}/file`);
  viewer.onPageChange = updatePdfHud;
  updatePdfHud();
  applyZoomLabel();

  // 记录「最近阅读」，供总览页顶栏「阅读器」入口默认直接续读
  try {
    localStorage.setItem(
      'agentlit.lastReader',
      JSON.stringify({ no, title: detail.work.title || '', ts: Date.now() }),
    );
  } catch {
    /* localStorage 不可用时忽略，不影响阅读 */
  }

  await loadEngines();
  await ensureExtracted();
  await loadSegments();
  await maybeReattachJob();

  chatPanel = new ChatPanel({
    no,
    onCitation: (c) => jumpToCitation(c),
    getSelection: () => readSelection(),
  });
  bind();
  await chatPanel.init();
}

async function loadEngines() {
  const engines = await api.get('/api/translate/engines');
  const sel = $('engine');
  sel.textContent = '';
  const usable = engines.filter((e) => e.configured);
  for (const e of engines) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.name}${e.configured ? '' : '（未配置）'}`;
    opt.disabled = !e.configured;
    sel.append(opt);
  }
  const preferred = usable.find((e) => e.id === 'deepseek') || usable[0];
  if (preferred) {
    sel.value = preferred.id;
    state.engine = preferred.id;
  }
  sel.addEventListener('change', () => {
    state.engine = sel.value;
    loadSegments();
  });
  $('tgtLang').addEventListener('change', () => {
    state.tgtLang = $('tgtLang').value;
    loadSegments();
  });
  if (!usable.length) {
    $('btnTranslate').disabled = true;
    $('dstHint').textContent = '还没有可用引擎：请在「设置」里填 apiKey（或在测试模式下用 mock 引擎）。';
  }
}

/** 没抽取就先把抽取跑起来（同步，1–2s） */
async function ensureExtracted() {
  state.extractStatus = detail.asset.extractStatus;
  const summarize = (s) => `抽取完成：${s.segments} 段 / ${s.pageCount} 页（双栏页 ${s.columnStats ? s.columnStats.twoColumn : '—'}）`;
  if (detail.asset.extractStatus === 'ready') {
    $('progressLine').textContent = `已抽取 · 抽取版本 v${detail.asset.extractVersion}`;
    return;
  }
  $('progressLine').textContent = '正在抽取文本…';
  const out = await api.post(`/api/assets/${detail.asset.id}/extract`, {});
  state.extractStatus = out.extractStatus;
  $('progressLine').textContent = summarize(out);
  if (out.extractStatus === 'needs_ocr') toast('该 PDF 没有文本层（扫描件），本期不做 OCR', 'warn', 6000);
}

async function loadSegments() {
  if (!state.engine) return;
  const query = qs({ withTranslation: 1, engine: state.engine, tgtLang: state.tgtLang });
  const out = await api.get(`/api/works/${no}/segments${query}`);
  // 抽取算法升级后，库里存的还是旧版段落（串栏、逐行碎片、「未翻译」散落）。
  // 这里直接按新算法重抽一次，否则用户永远看到老数据 —— 之前必须手工删库才会变。
  const storedV = Number(out.extractVersion) || 0;
  const currentV = Number(out.extractorVersion) || 0;
  // 用 !== 而不是 < ：老库里 extract_version 曾是「重抽次数」（可能比算法版本大，如 v9），
  // 只有「和当前算法版本不一致」才说明这份段落是别的算法产出的。
  if (out.extractStatus === 'ready' && currentV > 0 && storedV !== currentV && !state.reextracted) {
    state.reextracted = true;
    const hadTranslation = (out.pages || []).some((p) => (p.paras || []).some((x) => x.dst));
    const oldParas = (out.pages || []).reduce((a, p) => a + (p.paras || []).length, 0);
    $('progressLine').textContent = `段落结构已升级（v${storedV} → v${currentV}），正在重排…`;
    try {
      const job = await api.post(`/api/assets/${detail.asset.id}/extract`, { force: true });
      toast(
        `已用新版抽取算法重排：${job.segments} 段（原 ${oldParas} 段），双栏页 ${job.columnStats ? job.columnStats.twoColumn : '—'}`,
        'info',
        6000,
      );
    } catch (e) {
      toast(`重排失败：${e.message}`, 'warn', 6000);
    }
    await loadSegments();
    // 旧译文是按旧段落存的，重排后自然对不上；此前译过的话直接接着译，省一次点击。
    if (hadTranslation) triggerTranslate();
    return;
  }
  panel.render(out.pages || [], { pageFigures: out.pageFigures });
  const { total, done } = panel.stats();
  $('progressLine').textContent = `段落 ${total} · 已译 ${done}`;
}

/** 刷新页面后按 URL 里的 ?job= 重新接上正在跑的任务（进度不丢） */
async function maybeReattachJob() {
  const id = new URL(location.href).searchParams.get('job');
  if (!id) return;
  try {
    const job = await api.get(`/api/jobs/translate/${id}`);
    jobId = job.jobId;
    if (['running', 'queued'].includes(job.status)) subscribe(jobId);
  } catch {
    /* 旧任务可能已随重抽被清理，忽略即可 */
  }
}

function setJobParam(id) {
  const u = new URL(location.href);
  u.searchParams.set('job', String(id));
  history.replaceState(null, '', u.toString());
}

async function triggerTranslate() {
  if (!state.engine) {
    toast('没有可用引擎，请到设置页配置 apiKey', 'warn', 5000);
    return;
  }
  $('btnTranslate').disabled = true;
  try {
    const out = await api.post(`/api/works/${no}/translate`, {
      engine: state.engine,
      tgtLang: state.tgtLang,
      scope: 'all',
      anchorPage: viewer.currentPage,
    });
    jobId = out.jobId;
    setJobParam(jobId);
    toast(out.reused ? '该任务已在队列中，继续跟进进度' : '已开始翻译（按页增量出译文）', 'ok');
    subscribe(jobId);
  } catch (e) {
    toast(`发起翻译失败：${e.message}（${e.code}）`, 'err', 6000);
  } finally {
    $('btnTranslate').disabled = false;
  }
}

async function continueTranslate() {
  if (!state.engine) return;
  try {
    const out = await api.post(`/api/works/${no}/translate`, {
      engine: state.engine,
      tgtLang: state.tgtLang,
      scope: 'all',
      anchorPage: viewer.currentPage,
    });
    jobId = out.jobId;
    setJobParam(jobId);
    toast('继续翻译：已译段落直接命中缓存，不重复计费', 'ok', 4200);
    subscribe(jobId);
  } catch (e) {
    toast(`继续翻译失败：${e.message}`, 'err', 5000);
  }
}

async function cancelTranslate() {
  if (!jobId) return;
  try {
    const out = await api.post(`/api/jobs/translate/${jobId}/cancel`, {});
    toast(`已取消（保留 ${out.keptSegments} 段译文，可继续翻译）`, 'ok', 4200);
    $('btnCancel').hidden = true;
  } catch (e) {
    toast(`取消失败：${e.message}`, 'err');
  }
}

/* ── AI 精排（版面 agent）：用大模型复核每段的真实角色/层级，刷新排版 ── */
async function triggerRefine() {
  const btn = $('btnRefine');
  btn.disabled = true;
  try {
    const out = await api.post(`/api/works/${no}/layout`, { engine: state.engine });
    refineJobId = out.jobId;
    toast('已开始 AI 精排（逐页复核版面）', 'ok');
    subscribeRefine(refineJobId);
  } catch (e) {
    toast(`发起精排失败：${e.message}（${e.code}）`, 'err', 6000);
    btn.disabled = false;
  }
}

async function cancelRefine() {
  if (!refineJobId) return;
  try {
    await api.post(`/api/jobs/layout/${refineJobId}/cancel`, {});
    toast('已取消精排', 'ok', 3000);
  } catch (e) {
    toast(`取消精排失败：${e.message}`, 'err');
  }
}

function subscribeRefine(id) {
  if (refineEs) refineEs.close();
  $('btnRefine').hidden = true;
  $('btnRefineCancel').hidden = false;
  refineEs = new EventSource(`/api/jobs/layout/${id}/events`);
  refineEs.addEventListener('progress', (ev) => {
    try {
      const p = JSON.parse(ev.data);
      $('progressLine').textContent = `AI 精排中… ${p.message || ''}`;
    } catch { /* ignore */ }
  });
  refineEs.addEventListener('done', async (ev) => {
    const p = JSON.parse(ev.data);
    const applied = p.applied || 0;
    const errs = (p.errors && p.errors.length) || 0;
    $('progressLine').textContent =
      `精排完成：复核 ${p.requested || 0} 块，修正 ${applied} 块${errs ? `，失败 ${errs} 批` : ''}`;
    refineEs.close();
    refineEs = null;
    $('btnRefine').hidden = false;
    $('btnRefineCancel').hidden = true;
    $('btnRefine').disabled = false;
    await loadSegments(); // 拉回新 role/tier/align 并重新排版
    toast('排版已按精排结果刷新', 'ok');
  });
  refineEs.addEventListener('error', (ev) => {
    if (ev && ev.data) {
      try {
        const p = JSON.parse(ev.data);
        toast(`精排出错：${p.code} ${p.message}`, 'err', 6000);
      } catch { /* ignore */ }
    }
    $('btnRefine').hidden = false;
    $('btnRefineCancel').hidden = true;
    $('btnRefine').disabled = false;
  });
  refineEs.onerror = () => {
    // EventSource 自带重连；关闭后由 done/error 收尾
  };
}

function subscribe(id) {
  if (es) es.close();
  $('btnCancel').hidden = false;
  es = new EventSource(`/api/jobs/translate/${id}/events`);
  let lastDone = -1;
  es.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    const pct = p.totalSegments ? Math.round((p.doneSegments / p.totalSegments) * 100) : 0;
    $('progressLine').textContent = `翻译中 ${pct}% · ${p.doneSegments}/${p.totalSegments} 段 · 页 ${p.donePages || 0}/${p.totalPages || '—'} · 请求 ${p.requests ?? 0}`;
    if (typeof p.doneSegments === 'number') {
      if (lastDone >= 0 && p.doneSegments < lastDone) {
        // 进度回退说明服务端重排了 —— 直接刷新一次真实状态，不在前端猜
        loadSegments();
      }
      lastDone = p.doneSegments;
    }
  });
  es.addEventListener('page', async (ev) => {
    const page = JSON.parse(ev.data);
    panel.appendPage(page);
    const { total, done } = panel.stats();
    $('progressLine').textContent = `段落 ${total} · 已译 ${done}`;
  });
  es.addEventListener('done', async (ev) => {
    const p = JSON.parse(ev.data);
    $('progressLine').textContent = `完成：${p.doneSegments}/${p.totalSegments} 段（失败 ${p.failedSegments}），请求 ${p.requests ?? 0}，缓存命中 ${p.cacheHits ?? 0}`;
    es.close();
    es = null;
    $('btnCancel').hidden = true;
    await loadSegments();
    toast('翻译完成', 'ok');
  });
  es.addEventListener('paused', async () => {
    toast('已暂停（已译段落保留）', 'info');
    es.close();
    es = null;
    $('btnCancel').hidden = true;
    await loadSegments();
  });
  es.addEventListener('error', (ev) => {
    if (ev && ev.data) {
      try {
        const p = JSON.parse(ev.data);
        toast(`翻译出错：${p.code} ${p.message}`, 'err', 6000);
      } catch {
        /* ignore */
      }
    }
    $('btnCancel').hidden = true;
  });
  es.onerror = () => {
    // EventSource 自带重连；这里只在关闭后提示
  };
}

/** 点引用 chip：取该段的 bbox 后滚页 + 高亮 */
async function jumpToCitation(citation) {
  try {
    const out = await api.get(
      `/api/works/${encodeURIComponent(no)}/segments?from=${citation.segmentId}&to=${citation.segmentId}`,
    );
    const para = out.pages && out.pages[0] && out.pages[0].paras[0];
    if (!para) {
      toast('引用段落已不存在（可能重抽过）', 'warn');
      return;
    }
    await viewer.scrollToSegment(para.pageNo, para.bbox);
  } catch (e) {
    toast(`跳转失败：${e.message}`, 'err');
  }
}

/** 读当前正文选区（只取文字与当前页；不做文本→段的猜测） */
function readSelection() {
  const text = String(window.getSelection ? window.getSelection().toString() : '').trim();
  if (!text) return null;
  return { pageNo: viewer.currentPage, segmentIds: [], text: text.slice(0, 2000) };
}

/* ── PDF 阅读 HUD：页码翻页 + 缩放 ───────────────────────── */
function updatePdfHud() {
  if (!viewer) return;
  $('pdfPageLabel').textContent = `${viewer.currentPage} / ${viewer.numPages}`;
  $('pdfPrev').disabled = viewer.currentPage <= 1;
  $('pdfNext').disabled = viewer.currentPage >= viewer.numPages;
}
function applyZoomLabel() {
  if (viewer) $('zoomVal').textContent = `${Math.round(viewer.scale * 100)}%`;
}

/**
 * 从 viewer 的 viewport 反推 PDF 点尺寸：viewport 是「PDF 点 × viewer.scale」。
 * 版式页按这个尺寸决定纸的宽高比，PDF 缩放（setScale）不影响结果。
 */
function pageSizeFromViewer(pageNo) {
  if (!viewer) return null;
  // 新 viewer 直接给出 PDF 点尺寸（含 rotate），比拿 viewport 反推更准
  if (typeof viewer.pageSizePt === 'function') {
    const size = viewer.pageSizePt(pageNo);
    if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) return size;
  }
  if (!viewer.pageEls) return null;
  const entry = viewer.pageEls.get(pageNo);
  if (!entry || !entry.viewport) return null;
  const scale = viewer.scale > 0 ? viewer.scale : 1;
  return { width: entry.viewport.width / scale, height: entry.viewport.height / scale };
}
async function changeZoom(delta) {
  await viewer.setScale(+(viewer.scale + delta).toFixed(2));
  localStorage.setItem('agentlit.pdfScale', String(viewer.scale));
  applyZoomLabel();
}

/* ── 面板左右拖拽调节 ───────────────────────────────────── */
function setupSplitter() {
  const splitter = $('paneSplitter');
  const main = $('main');
  const saved = localStorage.getItem('agentlit.pdfFrac');
  if (saved) main.style.setProperty('--pdf-frac', saved);

  const setFrac = (frac) => {
    frac = Math.min(0.8, Math.max(0.2, frac));
    main.style.setProperty('--pdf-frac', `${(frac * 100).toFixed(1)}%`);
    localStorage.setItem('agentlit.pdfFrac', `${(frac * 100).toFixed(1)}%`);
  };
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const onMove = (ev) => {
      const rect = main.getBoundingClientRect();
      setFrac((ev.clientX - rect.left) / rect.width);
    };
    const onUp = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.classList.add('col-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  splitter.addEventListener('keydown', (e) => {
    const cur = parseFloat(getComputedStyle(main).getPropertyValue('--pdf-frac')) / 100 || 0.6;
    if (e.key === 'ArrowLeft') { setFrac(cur - 0.03); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setFrac(cur + 0.03); e.preventDefault(); }
  });
}

/* ── 译文字号调节（带百分比显示 + 持久化 + 快捷键）────────── */
function setupFontScale() {
  const dstPane = $('dstPane');
  let fontScale = parseFloat(localStorage.getItem('agentlit.dstScale')) || 1;
  const apply = () => {
    dstPane.style.setProperty('--dst-scale', String(fontScale));
    $('fontVal').textContent = `${Math.round(fontScale * 100)}%`;
    // 版式页的字号按 --dst-scale 重算，段落高度会变，需要重排（保持阅读位置）
    if (panel) panel.relayoutAll();
  };
  const up = () => { fontScale = Math.min(1.3, +(fontScale + 0.1).toFixed(2)); apply(); localStorage.setItem('agentlit.dstScale', String(fontScale)); };
  const down = () => { fontScale = Math.max(0.85, +(fontScale - 0.1).toFixed(2)); apply(); localStorage.setItem('agentlit.dstScale', String(fontScale)); };
  const reset = () => { fontScale = 1; apply(); localStorage.setItem('agentlit.dstScale', String(fontScale)); };
  $('fontUp').addEventListener('click', up);
  $('fontDown').addEventListener('click', down);
  $('fontReset').addEventListener('click', reset);
  apply();

  // Ctrl/Cmd + +/-/0 调节译文（焦点在输入框时不拦截，避免影响聊天输入）
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); up(); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); down(); }
    else if (e.key === '0') { e.preventDefault(); reset(); }
  });
}

/* ── 译文搜索 + 定位当前页 ──────────────────────────────── */
function setupDstSearch() {
  const input = $('dstSearch');
  const onInput = debounce(() => {
    const q = input.value.trim().toLowerCase();
    const paras = document.querySelectorAll('#dstList .dst-para');
    let first = null;
    paras.forEach((p) => {
      const hit = !q || (p.textContent || '').toLowerCase().includes(q);
      p.classList.toggle('dim', !hit);
      if (hit && !first) first = p;
    });
    if (first && q) first.scrollIntoView({ block: 'center' });
  }, 200);
  input.addEventListener('input', onInput);

  $('dstLocate').addEventListener('click', () => {
    const page = viewer ? viewer.currentPage : 1;
    const title = [...document.querySelectorAll('#dstList .dst-page-title')]
      .find((el) => el.textContent.includes(`第 ${page} 页`));
    if (title) title.scrollIntoView({ block: 'start' });
    else toast(`第 ${page} 页还没有译文`, 'info');
  });
}

/* ── 对话抽屉宽度拖拽调节 ─────────────────────────────── */
function setupChatResize() {
  const resizer = $('chatResizer');
  const root = document.documentElement;
  const saved = localStorage.getItem('agentlit.chatW');
  if (saved) root.style.setProperty('--chat-w', saved);

  const clamp = (w) => Math.max(300, Math.min(720, window.innerWidth * 0.72, w));
  const apply = (w) => root.style.setProperty('--chat-w', `${clamp(w)}px`);
  const persist = () =>
    localStorage.setItem('agentlit.chatW', getComputedStyle(root).getPropertyValue('--chat-w').trim());

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('col-resizing');
    const onMove = (ev) => apply(window.innerWidth - ev.clientX);
    const onUp = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persist();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  resizer.addEventListener('keydown', (e) => {
    const cur = parseFloat(getComputedStyle(root).getPropertyValue('--chat-w')) || 360;
    if (e.key === 'ArrowLeft') { apply(cur + 24); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { apply(cur - 24); e.preventDefault(); }
    else return;
    persist();
  });
}

function bind() {
  // 对话改为右侧常驻抽屉：用侧边按钮展开/收起，PDF 与译文常驻可见
  $('chatToggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('chat-open');
    $('chatToggle').setAttribute('aria-expanded', String(open));
    $('chatDrawer').setAttribute('aria-hidden', String(!open));
  });
  $('chatClose').addEventListener('click', () => {
    document.body.classList.remove('chat-open');
    $('chatToggle').setAttribute('aria-expanded', 'false');
    $('chatDrawer').setAttribute('aria-hidden', 'true');
  });

  // 对话抽屉从工具条下方开始，避免打开对话时遮住翻译/导出等工具条入口
  const syncDrawerTop = () => {
    const tb = document.querySelector('.reader-toolbar');
    if (tb) document.documentElement.style.setProperty('--drawer-top', `${tb.offsetHeight + 50}px`);
  };
  syncDrawerTop();
  window.addEventListener('resize', syncDrawerTop);

  // PDF 翻页 / 缩放
  $('pdfPrev').addEventListener('click', () => viewer.goToPage(viewer.currentPage - 1));
  $('pdfNext').addEventListener('click', () => viewer.goToPage(viewer.currentPage + 1));
  $('zoomIn').addEventListener('click', () => changeZoom(0.15));
  $('zoomOut').addEventListener('click', () => changeZoom(-0.15));
  setupSplitter();
  setupFontScale();
  setupDstSearch();
  setupChatResize();

  $('btnTranslate').addEventListener('click', triggerTranslate);
  $('btnContinue').addEventListener('click', continueTranslate);
  $('btnCancel').addEventListener('click', cancelTranslate);
  $('btnRefine').addEventListener('click', triggerRefine);
  $('btnRefineCancel').addEventListener('click', cancelRefine);

  // 版式（按 bbox 还原）/ 线性（原来的段落流）切换，选择记在 localStorage
  const renderBtn = $('btnRender');
  if (renderBtn) {
    const syncRenderBtn = () => {
      const isLayout = panel.renderMode === 'layout';
      renderBtn.textContent = isLayout ? '版式' : '线性';
      renderBtn.setAttribute('aria-pressed', String(isLayout));
      renderBtn.title = isLayout
        ? '当前按原版式还原；点击切换为线性段落流'
        : '当前为线性段落流；点击切换为按原版式还原';
    };
    renderBtn.addEventListener('click', () => {
      panel.setRenderMode(panel.renderMode === 'layout' ? 'flow' : 'layout');
      syncRenderBtn();
    });
    syncRenderBtn();
  }

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      state.mode = radio.value;
      panel.setMode(state.mode);
    });
  }
}

boot().catch((e) => toast(`初始化失败：${e.message}`, 'err', 6000));
