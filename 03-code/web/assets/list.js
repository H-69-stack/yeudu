/**
 * 总览页逻辑：搜索 / 专题 / 类型 / 下载状态 / 分页 / 下载按钮 / job 进度轮询。
 * 约束（§5）：不计算业务状态——进度、状态文案都来自服务端返回的 job 字段。
 */
import { api, qs } from './api.js';
import { el, debounce, toast, downloadStatusView } from './ui.js';

const state = {
  q: '',
  sectionNo: '',
  type: '',
  hasPdf: '',
  sort: 'no',
  order: 'asc',
  page: 1,
  pageSize: 50,
  total: 0,
  items: [],
  sections: [],
};

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['queued', 'resolving', 'downloading', 'verifying']);
// 文献类型徽章配色（沿用静态清单：期刊青 / 会议蓝 / 专著褐 / 预印本橙 / 非同行评审红）
const TYPE_BADGE = { 期刊: 'b-j', 会议: 'b-c', 专著: 'b-b', 预印本: 'b-p', 非同行评审: 'b-n' };
let pollTimer = null;

function readUrl() {
  const u = new URL(location.href);
  for (const k of ['q', 'sectionNo', 'type', 'hasPdf', 'sort', 'order', 'page']) {
    const v = u.searchParams.get(k);
    if (v !== null && v !== '') state[k] = k === 'page' ? Number(v) : v;
  }
}

function writeUrl() {
  const u = new URL(location.href);
  const entries = { q: state.q, sectionNo: state.sectionNo, type: state.type, hasPdf: state.hasPdf, sort: state.sort, order: state.order, page: state.page };
  for (const [k, v] of Object.entries(entries)) {
    if (v === '' || v === undefined || v === null || (k === 'page' && Number(v) === 1)) u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  history.replaceState(null, '', u.toString());
}

async function loadStats() {
  try {
    const s = await api.get('/api/stats');
    $('statLine').textContent = `共 ${s.works} 条 · 已下载 ${s.withPdf} · 需人工 ${s.needsManual} · 活跃任务 ${s.activeJobs}`;
    $('statTotal').textContent = String(s.works);
    $('statPdf').textContent = String(s.withPdf);
    $('statManual').textContent = String(s.needsManual);
    $('statSeg').textContent = String(s.segments);
  } catch (e) {
    $('statLine').textContent = `统计加载失败：${e.message}`;
  }
}

async function loadSections() {
  state.sections = await api.get('/api/sections');
  $('sectionCount').textContent = String(state.sections.length);
  $('statSections').textContent = String(state.sections.length);
  const box = $('sections');
  box.textContent = '';
  const mk = (label, value, count) =>
    el('button', {
      class: `section-item${String(state.sectionNo) === String(value) ? ' active' : ''}`,
      onclick: () => {
        state.sectionNo = String(state.sectionNo) === String(value) ? '' : value;
        state.page = 1;
        writeUrl();
        renderSections();
        loadWorks();
      },
    }, [el('span', { text: label }), el('span', { class: 'count', text: String(count) })]);

  box.append(mk('全部专题', '', state.sections.reduce((a, b) => a + b.count, 0)));
  for (const s of state.sections) box.append(mk(s.section, s.sectionNo, s.count));
}

function renderSections() {
  const box = $('sections');
  const nodes = [...box.children];
  const values = ['', ...state.sections.map((s) => String(s.sectionNo))];
  nodes.forEach((n, i) => n.classList.toggle('active', String(state.sectionNo) === values[i]));
}

async function loadWorks() {
  const query = qs({
    q: state.q,
    sectionNo: state.sectionNo,
    type: state.type,
    hasPdf: state.hasPdf,
    sort: state.sort,
    order: state.order,
    page: state.page,
    pageSize: state.pageSize,
  });
  try {
    const out = await api.get(`/api/works${query}`);
    state.total = out.total;
    state.items = out.items;
    renderRows();
  } catch (e) {
    toast(`列表加载失败：${e.message}`, 'err');
  }
}

function renderRows() {
  const tbody = $('rows');
  tbody.textContent = '';
  $('empty').hidden = state.items.length > 0;
  for (const item of state.items) {
    const st = downloadStatusView(item);
    const detailHref = `work.html?no=${encodeURIComponent(item.no)}`;
    const title = el('div', {}, [
      el('a', { class: 't', href: detailHref, text: item.title || '(无标题)' }),
      el('div', {
        class: 'meta',
        text: [item.authors || '—', item.venue || '', item.arxivId ? `arXiv:${item.arxivId}` : '']
          .filter(Boolean)
          .join(' · '),
      }),
    ]);

    const actions = el('div', { class: 'row' }, [
      el('a', { class: 'btn small', href: detailHref, text: '详情' }),
      item.fileState === 'present' && item.assetId
        ? el('a', {
            class: 'small btn',
            href: `/api/assets/${item.assetId}/file`,
            target: '_blank',
            rel: 'noreferrer',
            text: '打开 PDF',
            title: '新标签打开本地 PDF',
          })
        : el('span', {
            class: 'small btn is-disabled',
            text: '打开 PDF',
            title: '本地还没有 PDF：先点「下载」，或去出版商页面下载后上传',
            onclick: () => toast(`${item.no} 本地还没有 PDF，先下载或上传`, 'warn', 3000),
          }),
      item.fileState === 'present' && item.assetId
        ? el('a', {
            class: 'small btn',
            href: `reader.html?no=${encodeURIComponent(item.no)}`,
            target: '_blank',
            rel: 'noreferrer',
            text: '阅读器',
            title: '打开阅读器（PDF + 译文对照 + 对话 Agent）',
          })
        : el('span', {
            class: 'small btn is-disabled',
            text: '阅读器',
            title: '本地还没有 PDF，无法进入阅读器',
            onclick: () => toast(`${item.no} 本地还没有 PDF，先下载或上传`, 'warn', 3000),
          }),
      el('button', {
        class: 'small primary',
        text: st.kind === 'ok' ? '重新下载' : '下载',
        onclick: (ev) => triggerDownload(item.no, st.kind === 'ok', ev.target),
      }),
      // 「进入网页」：原文链 → DOI → arXiv 兜底，手动模式下配合直传脚本使用
      landingUrl(item)
        ? el('a', {
            class: 'small btn',
            href: landingUrl(item),
            target: '_blank',
            rel: 'noreferrer',
            text: '进入网页',
            title: '新标签打开这篇文献的原文页面（原文链 → DOI → arXiv 兜底）；装了直传脚本时，脚本会在那一页自动直传',
          })
        : null,
    ]);

    const statusCell = el('td', {}, [
      el('span', { class: `badge badge-${st.kind}`, text: st.label }),
      item.job && item.job.errorMessage ? el('div', { class: 'hint', text: item.job.errorMessage.slice(0, 60) }) : null,
    ]);

    tbody.append(
      el('tr', {}, [
        el('td', { class: 'no', text: item.no }),
        el('td', { class: 'title' }, [title]),
        el('td', { text: item.year ? String(item.year) : '—' }),
        el('td', {}, [
          TYPE_BADGE[item.type]
            ? el('span', { class: `badge badge-type ${TYPE_BADGE[item.type]}`, text: item.type })
            : el('span', { class: 'hint', text: item.type || '—' }),
        ]),
        el('td', { class: 'hint', text: item.section.replace(/^\d+\s*/, '') }),
        statusCell,
        el('td', {}, [actions]),
      ]),
    );
  }
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $('pageInfo').textContent = `第 ${state.page} / ${pages} 页 · 共 ${state.total} 条`;
  $('prev').disabled = state.page <= 1;
  $('next').disabled = state.page >= pages;
}

async function triggerDownload(no, force, btn) {
  btn.disabled = true;
  try {
    const out = await api.post(`/api/works/${encodeURIComponent(no)}/download`, { force });
    if (out.alreadyDownloaded) toast(`${no} 已有本地 PDF（无需重复下载）`, 'info');
    else if (out.reused) toast(`${no} 的下载任务已在队列中`, 'info');
    else if (out.status === 'needs_manual') toast(`${no} 没有可自动下载的开放源，已标记「需人工」`, 'warn', 4500);
    else toast(`${no} 已加入下载队列`, 'ok');
    startPolling();
  } catch (e) {
    toast(`下载失败：${e.message}（${e.code}）`, 'err', 4500);
  } finally {
    btn.disabled = false;
    loadWorks();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollJobs, 1200);
  pollJobs();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollJobs() {
  let jobs = [];
  try {
    jobs = await api.get('/api/jobs/download?limit=50');
  } catch {
    stopPolling();
    return;
  }
  const byNo = new Map(jobs.map((j) => [j.no, j]));
  let activeCount = 0;
  for (const item of state.items) {
    const j = byNo.get(item.no);
    if (!j) continue;
    item.job = {
      jobId: j.jobId,
      status: j.status,
      errorCode: j.errorCode,
      errorMessage: j.errorMessage,
      bytesDone: j.bytesDone,
      bytesTotal: j.bytesTotal,
    };
    if (ACTIVE.has(j.status)) {
      activeCount += 1;
      item.downloadStatus = j.status === 'downloading' || j.status === 'verifying' ? 'downloading' : 'queued';
    } else if (j.status === 'done') {
      item.downloadStatus = 'done';
      item.fileState = 'present';
    } else if (j.status === 'failed') item.downloadStatus = 'failed';
    else if (j.status === 'needs_manual') item.downloadStatus = 'needs_manual';
  }
  renderRows();
  if (activeCount === 0) {
    stopPolling();
    loadStats();
    loadWorks(); // 收尾刷新一次真实状态（fileState / errorMessage）
  }
}

function bindToolbar() {
  $('q').addEventListener(
    'input',
    debounce((e) => {
      state.q = e.target.value.trim();
      state.page = 1;
      writeUrl();
      loadWorks();
    }, 250),
  );
  $('type').addEventListener('change', (e) => {
    state.type = e.target.value;
    state.page = 1;
    writeUrl();
    loadWorks();
  });
  $('pdfFilter').addEventListener('change', (e) => {
    state.hasPdf = e.target.value;
    state.page = 1;
    writeUrl();
    loadWorks();
  });
  $('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    state.page = 1;
    writeUrl();
    loadWorks();
  });
  $('prev').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      writeUrl();
      loadWorks();
    }
  });
  $('next').addEventListener('click', () => {
    state.page += 1;
    writeUrl();
    loadWorks();
  });
  $('btnNextPending').addEventListener('click', () => openNextPending());
  $('btnUploaderNote').addEventListener('click', () => toggleUploaderNote());
  // 按钮与状态由网页统一根据「脚本是否注入」决定（单一事实来源）
  function syncScriptButton() {
    const btn = $('btnNextPending');
    const s = $('scriptStatus');
    const ready = !!window.__litUploader;
    if (btn) {
      btn.classList.toggle('primary', ready);
      btn.title = ready
        ? '新标签打开下一条待采集文献，脚本会在那一页自动直传'
        : '新标签打开下一条待采集文献（装好直传脚本后才会自动直传）';
    }
    if (s) s.textContent = ready ? `直传脚本已就绪 v${window.__litUploader}` : '未安装直传脚本（点「脚本说明」看如何安装）';
    return ready;
  }
  syncScriptButton();
  // 脚本可能比网页晚加载：轮询 + 监听脚本派发的 lit-ready 事件，就绪后立刻更新状态
  window.addEventListener('lit-ready', syncScriptButton);
  const sPoll = setInterval(() => {
    if (syncScriptButton()) clearInterval(sPoll);
  }, 300);
  setTimeout(() => clearInterval(sPoll), 8000);
}

// 手动模式：算出这条文献该打开哪个页面（原文链 → DOI → arXiv）
function landingUrl(it) {
  const link = String(it.link || '').trim();
  if (/^https?:\/\//i.test(link) && !/^https?:\/\/([a-z0-9-]+\.)?doi\.org\//i.test(link)) return link;
  if (it.doi) return 'https://doi.org/' + String(it.doi).trim();
  if (/^https?:\/\//i.test(link)) return link;
  if (it.arxivId) return 'https://arxiv.org/abs/' + String(it.arxivId).trim();
  return null;
}

// 手动模式：一次只开一个标签页，由你自己点；脚本只负责在你打开的页面上自动直传
async function openNextPending() {
  const btn = $('btnNextPending');
  if (btn) btn.disabled = true;
  try {
    // 取一批候选：有些条目既没有原文链也没有 DOI/arXiv（如纯专著），无法定位页面，要跳过它们
    const r = await api.get('/api/works?hasPdf=0&hasArxiv=0&pageSize=200&page=1');
    const list = r.items || [];
    if (!list.length) {
      toast('没有待采集的条目了（本地都已下载）', 'ok', 4000);
      return;
    }
    let it = null;
    let url = null;
    for (const c of list) {
      const u = landingUrl(c);
      if (u) { it = c; url = u; break; }
    }
    if (!it || !url) {
      toast(`还剩 ${list.length} 条待采集，但都没有原文链接/DOI/arXiv，无法定位页面`, 'warn', 5000);
      return;
    }
    window.open(url, '_blank', 'noopener');
    toast(`已打开 ${it.no}《${String(it.title || '').slice(0, 20)}》，装了脚本时它会自动直传`, 'info', 4500);
  } catch (e) {
    toast(`获取待采集条目失败：${e.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 直传脚本说明：手动模式用法 + 一键装/更新脚本 + 待采集条数
async function toggleUploaderNote() {
  const note = $('batchNote');
  if (!note.hidden) {
    note.hidden = true;
    return;
  }
  note.textContent = '';
  note.append(el('h3', { text: '直传脚本（手动模式）：你自己开页面，脚本自动直传' }));
  const lines = el('div', { class: 'hint', text: '正在统计…' });
  note.append(lines);
  note.hidden = false;

  let total = '—';
  let reachable = '—';
  try {
    const q = '/api/works?hasPdf=0&hasArxiv=0&pageSize=200&page=1';
    const r = await api.get(q);
    total = String(r.total);
    reachable = String(
      (r.items || []).filter((i) => i.doi || i.arxivId || /^https?:\/\//i.test(i.link || '')).length,
    );
  } catch (e) {
    toast(`统计失败：${e.message}`, 'err');
  }
  lines.replaceWith(
    el('div', {}, [
      el('p', { style: 'margin:0 0 6px', text: '' }, [
        el('span', { text: '当前待采集 ' }),
        el('b', { text: total }),
        el('span', { text: ' 条（无 arXiv 号、系统无法自动下载，且本地还没有 PDF），其中 ' }),
        el('b', { text: reachable }),
        el('span', { text: ' 条能定位到原文页面。' }),
      ]),
      el('p', {
        class: 'hint',
        style: 'margin:0 0 8px',
        text: '工作方式：脚本不会自动跳转、也不会批量跑。你自己在浏览器里打开某篇文献的页面（点工具栏「打开下一篇待采集」，或点列表里的「原文」链接），脚本会在你打开的那一页自动识别 DOI/arXiv、匹配库内条目、抓取 PDF 并直传。',
      }),
      el('ol', {}, [
        el('li', {}, [
          el('span', { text: '先安装 / 更新脚本：' }),
          el('a', {
            href: '/lit-uploader.user.js',
            target: '_blank',
            rel: 'noreferrer',
            text: '打开 lit-uploader.user.js',
          }),
          el('span', { class: 'hint', text: '（Tampermonkey 会弹出安装页，点「安装」；已装过的同样点这里可更新）' }),
        ]),
        el('li', { text: '在这个浏览器里登录机构账号（学校图书馆入口），并确保油猴已启用「文献库直传助手」。' }),
        el('li', { text: '回到本页，工具栏会显示「直传脚本已就绪 v1.2.0」；点「打开下一篇待采集」会在新标签打开一条待采集文献。' }),
        el('li', { text: '在打开的页面上，脚本自动完成识别 → 抓 PDF → 直传，右下角弹提示。传完关掉标签，回来再点一次即可处理下一条。' }),
        el('li', { text: '遇到人机验证：你自己点掉即可，脚本每 10 秒自动重试一次（最多 3 分钟）；没有 PDF 链接的条目会提示跳过。' }),
      ]),
      el('p', {
        class: 'hint',
        style: 'margin:8px 0 0',
        text: '注意：必须在真实 Chrome/Edge 里打开本页并装好油猴（WorkBuddy 内置预览窗没有扩展，脚本不会生效）。内置限速：上传成功间隔 15 秒、每日 60 篇。脚本只匹配库内条目，不是通用爬虫。',
      }),
    ]),
  );
}

// 顶栏「阅读器」入口：弹出选择器，列出本地已有 PDF 的文献，点选进入阅读器
let pickerItems = [];
let lastReaderPinned = null;
function bindReaderPicker() {
  const nav = $('navReader');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    e.preventDefault();
    openReaderPicker();
  });
  $('readerPickerClose').addEventListener('click', () => {
    $('readerPicker').hidden = true;
  });
  $('readerPicker').addEventListener('click', (e) => {
    if (e.target === $('readerPicker')) $('readerPicker').hidden = true;
  });
  $('readerPickerQ').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    renderPickerList(
      pickerItems.filter(
        (i) => !q || i.no.toLowerCase().includes(q) || String(i.title || '').toLowerCase().includes(q),
      ),
    );
  });
}
async function openReaderPicker() {
  const modal = $('readerPicker');
  const list = $('readerPickerList');
  modal.hidden = false;
  list.textContent = '加载中…';
  $('readerPickerQ').value = '';
  // 读取「最近阅读」，作为默认续读入口置顶
  try {
    const raw = localStorage.getItem('agentlit.lastReader');
    lastReaderPinned = raw ? JSON.parse(raw) : null;
  } catch {
    lastReaderPinned = null;
  }
  try {
    const r = await api.get('/api/works?hasPdf=1&pageSize=200&page=1');
    pickerItems = (r.items || []).filter((i) => i.fileState === 'present' && i.assetId);
    if (!pickerItems.length && !lastReaderPinned) {
      list.textContent = '没有已下载 PDF 的文献';
      return;
    }
    renderPickerList(pickerItems);
  } catch (e) {
    list.textContent = `加载失败：${e.message}`;
  }
}
function renderPickerList(items) {
  const list = $('readerPickerList');
  list.textContent = '';
  // 默认续读：最近一次打开过的文献置顶，点击直接进阅读器
  if (lastReaderPinned && lastReaderPinned.no) {
    list.append(
      el('button', {
        class: 'picker-row pinned',
        type: 'button',
        title: '继续阅读最近打开的这篇',
        onclick: () => {
          window.location.href = `reader.html?no=${encodeURIComponent(lastReaderPinned.no)}`;
        },
      }, [
        el('span', { class: 'no', text: '↺ 继续阅读' }),
        el('span', { class: 't', text: lastReaderPinned.title || '(无标题)' }),
      ]),
    );
  }
  for (const it of items) {
    // 跳过与「继续阅读」重复的那条
    if (lastReaderPinned && it.no === lastReaderPinned.no) continue;
    list.append(
      el('button', {
        class: 'picker-row',
        type: 'button',
        onclick: () => {
          window.location.href = `reader.html?no=${encodeURIComponent(it.no)}`;
        },
      }, [
        el('span', { class: 'no', text: it.no }),
        el('span', { class: 't', text: it.title || '(无标题)' }),
      ]),
    );
  }
  if (!items.length && !(lastReaderPinned && lastReaderPinned.no)) list.textContent = '没有匹配的文献';
}

async function main() {
  readUrl();
  $('q').value = state.q;
  $('type').value = state.type;
  $('pdfFilter').value = state.hasPdf;
  $('sort').value = state.sort;
  bindToolbar();
  bindReaderPicker();
  await loadSections();
  await Promise.all([loadWorks(), loadStats()]);
  // 页面上有活跃任务时自动开始轮询
  const hasActive = state.items.some((i) => ACTIVE.has(i.job && i.job.status));
  if (hasActive) startPolling();
}

main().catch((e) => toast(`初始化失败：${e.message}`, 'err', 6000));
