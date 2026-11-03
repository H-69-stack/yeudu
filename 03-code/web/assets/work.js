/**
 * 详情页：元数据 / 贡献定位 / 本地 PDF 状态与动作 / 字段级编辑（写锁定）/ 下载进度轮询。
 * M1 的「打开 PDF」= 新标签打开 GET /api/assets/:id/file，交给浏览器内置阅读器（不引 pdf.js）。
 */
import { api, uploadPdf } from './api.js';
import { el, toast, fmtBytes, fmtTime } from './ui.js';

const FIELDS = [
  { key: 'title', label: '标题', type: 'text' },
  { key: 'authors', label: '作者', type: 'text' },
  { key: 'year', label: '年份', type: 'number' },
  { key: 'venue', label: '出处', type: 'text' },
  { key: 'type', label: '类型', type: 'select', options: ['期刊', '会议', '专著', '预印本', '非同行评审'] },
  { key: 'arxivId', label: 'arXiv', type: 'text' },
  { key: 'doi', label: 'DOI', type: 'text' },
  { key: 'isbn', label: 'ISBN', type: 'text' },
  { key: 'link', label: '链接', type: 'text' },
  { key: 'note', label: '贡献定位', type: 'textarea' },
];

const $ = (id) => document.getElementById(id);
const no = new URL(location.href).searchParams.get('no') || '';
let detail = null;
let lockSet = new Set();
let unlockSet = new Set();
let pollTimer = null;
const ACTIVE = new Set(['queued', 'resolving', 'downloading', 'verifying']);

async function load() {
  if (!no) {
    toast('缺少 ?no= 参数', 'err');
    return;
  }
  detail = await api.get(`/api/works/${encodeURIComponent(no)}`);
  render();
  if (detail.downloadJob && ACTIVE.has(detail.downloadJob.status)) startPolling();
}

function render() {
  const w = detail.work;
  document.title = `${w.no} ${w.title.slice(0, 40)} · 文献详情`;
  $('crumb').textContent = `${w.no} · ${w.section}`;

  const kv = $('metaKv');
  kv.textContent = '';
  const add = (k, v) => {
    kv.append(el('dt', { text: k }), el('dd', {}, [typeof v === 'string' ? document.createTextNode(v) : v]));
  };
  add('编号', w.no);
  add('专题', w.section);
  add('作者', w.authors || '—');
  add('标题', w.title || '—');
  add('年份', w.year ? String(w.year) : '—');
  add('出处', w.venue || '—');
  add('类型', w.type || '—');
  add('arXiv', w.arxivId ? el('a', { href: `https://arxiv.org/abs/${w.arxivId}`, target: '_blank', rel: 'noreferrer', text: w.arxivId }) : '—');
  add('DOI', w.doi ? el('a', { href: `https://doi.org/${w.doi}`, target: '_blank', rel: 'noreferrer', text: w.doi }) : '—');
  add('ISBN', w.isbn || '—');
  add('链接', w.link ? el('a', { href: w.link, target: '_blank', rel: 'noreferrer', text: w.link }) : '—');
  add('数据来源', w.sourceNote || '—');
  add('字段锁', w.fieldsLocked.length ? w.fieldsLocked.join(', ') : '（无）');

  $('noteBody').textContent = w.note || '（无贡献定位）';

  renderFile();
  renderEdit();
}

function renderFile() {
  const a = detail.asset;
  const job = detail.downloadJob;
  const badge = $('fileBadge');
  const info = $('fileInfo');
  const openBtn = $('btnOpen');
  const revealBtn = $('btnReveal');
  const doiBtn = $('btnDoi');
  const manual = $('manualHints');

  badge.className = 'badge';
  // 「打开 PDF」常驻：有文件可点，无文件置灰并给出原因（不要藏起来，否则用户不知道有没有）
  const setOpenBtn = (enabled, label) => {
    openBtn.hidden = false;
    openBtn.classList.toggle('is-disabled', !enabled);
    openBtn.textContent = label;
    if (enabled) {
      openBtn.href = `/api/assets/${a.id}/file`;
      openBtn.removeAttribute('title');
      openBtn.onclick = null;
    } else {
      openBtn.removeAttribute('href');
      openBtn.title = '本地还没有 PDF：先下载，或从出版商页面下载后用下方上传按钮导入';
      openBtn.onclick = (ev) => { ev.preventDefault(); toast('本地还没有 PDF，先下载或上传', 'warn', 3000); };
    }
  };

  if (a && a.fileState === 'present') {
    badge.classList.add('badge-ok');
    badge.textContent = '已下载';
    info.textContent = `${fmtBytes(a.fileSize)} · ${a.pageCount || '?'} 页 · 来源 ${a.source || '—'} · ${fmtTime(a.downloadedAt)} · sha256 ${(a.fileSha256 || '').slice(0, 12)}…`;
    setOpenBtn(true, '打开 PDF（浏览器内置阅读器）');
    revealBtn.hidden = false;
    $('btnDownload').textContent = '重新下载？';
    $('btnDownload').hidden = true;
    $('btnForce').hidden = false;
  } else if (a && a.fileState === 'missing') {
    badge.classList.add('badge-err');
    badge.textContent = '文件丢失';
    info.textContent = `记录里的路径：${a.storageRelPath || '—'}（可能被移动或删除）`;
    setOpenBtn(false, '打开 PDF（文件已丢失）');
    revealBtn.hidden = true;
    $('btnDownload').hidden = false;
    $('btnForce').hidden = false;
  } else {
    badge.classList.add('badge-idle');
    badge.textContent = '未下载';
    info.textContent = '自动下载覆盖率预期 76%–85%（arXiv 条目 ≥90%），拿不到开放 PDF 的条目走「需人工」路径。';
    setOpenBtn(false, '打开 PDF（本地暂无）');
    revealBtn.hidden = true;
    $('btnDownload').hidden = false;
    $('btnForce').hidden = true;
  }

  if (job) {
    const map = {
      queued: '排队中',
      resolving: '解析下载源…',
      downloading: `下载中 ${job.bytesTotal ? Math.round(((job.bytesDone || 0) / job.bytesTotal) * 100) : 0}%`,
      verifying: '校验中（魔数 / 页数 / 体积）',
      done: '下载完成',
      failed: `失败：${job.errorCode || ''} ${job.errorMessage || ''}`,
      needs_manual: `需人工：${job.errorMessage || ''}`,
      canceled: '已取消',
    };
    $('jobLine').textContent = `任务 #${job.jobId} · ${map[job.status] || job.status}${job.url ? ` · ${job.url}` : ''}`;
    const isManual = job.status === 'needs_manual';
    manual.hidden = !isManual;
    if (isManual) {
      manual.textContent =
        '这是一条正常路径而不是错误：该文献没有可直连的开放 PDF。你可以 ①点「进入网页」到原文页面自己下载（多数需机构订阅；装了直传脚本时脚本会自动抓）；②把 PDF 拖到下面的上传按钮；③把它放进 storage/inbox/ 后用设置页的「扫描收件箱」。';
    }
  } else {
    $('jobLine').textContent = '';
    manual.hidden = true;
  }

  // 「进入网页」：原文链 → DOI → arXiv 兜底，手动模式下配合直传脚本使用
  const landing = landingUrlOf(detail.work);
  doiBtn.hidden = !landing;
  if (landing) {
    doiBtn.href = landing;
    doiBtn.title = '新标签打开这篇文献的原文页面（原文链 → DOI → arXiv 兜底）；装了直传脚本时，脚本会在那一页自动直传';
  }
}

// 与列表页 list.js 的 landingUrl 同一规则：原文链优先，doi.org 只是跳转壳排其后
function landingUrlOf(w) {
  const link = String(w.link || '').trim();
  if (/^https?:\/\//i.test(link) && !/^https?:\/\/([a-z0-9-]+\.)?doi\.org\//i.test(link)) return link;
  if (w.doi) return 'https://doi.org/' + String(w.doi).trim();
  if (/^https?:\/\//i.test(link)) return link;
  if (w.arxivId) return 'https://arxiv.org/abs/' + String(w.arxivId).trim();
  return null;
}

function renderEdit() {
  const box = $('editForm');
  box.textContent = '';
  lockSet = new Set();
  unlockSet = new Set();
  const w = detail.work;
  for (const f of FIELDS) {
    const locked = w.fieldsLocked.includes(f.key);
    const input =
      f.type === 'textarea'
        ? el('textarea', { id: `f_${f.key}`, rows: 3 })
        : f.type === 'select'
          ? el('select', { id: `f_${f.key}` }, f.options.map((o) => el('option', { value: o, text: o })))
          : el('input', { id: `f_${f.key}`, type: f.type === 'number' ? 'number' : 'text' });
    if (f.type === 'textarea' || f.type === 'text' || f.type === 'number') input.value = w[f.key] ?? '';
    else input.value = w[f.key] || f.options[0];

    const lockBtn = el('button', {
      class: 'small',
      type: 'button',
      title: locked ? '该字段已锁定：重导入不会覆盖它。点此解除锁定' : '锁定后重导入不会覆盖该字段（不改值）',
      text: locked ? '已锁定（点击解锁）' : '锁定',
      onclick: (ev) => {
        const btn = ev.target;
        const nowLocked = btn.dataset.locked === '1';
        if (nowLocked) {
          btn.dataset.locked = '0';
          btn.textContent = '锁定';
          lockSet.delete(f.key);
          unlockSet.add(f.key);
        } else {
          btn.dataset.locked = '1';
          btn.textContent = '已锁定（点击解锁）';
          lockSet.add(f.key);
          unlockSet.delete(f.key);
        }
        renderLockHint();
      },
    });
    lockBtn.dataset.locked = locked ? '1' : '0';

    box.append(
      el('div', { class: 'field' }, [
        el('label', { for: `f_${f.key}` }, [
          document.createTextNode(f.label),
          locked
            ? el('span', {
                class: 'lock-badge',
                text: '已锁',
                title: '本地已修改，重导入不会覆盖；点右侧「已锁定」可解锁',
              })
            : null,
        ]),
        el('div', { class: 'row' }, [input, lockBtn]),
      ]),
    );
  }
  renderLockHint();
}

function renderLockHint() {
  const parts = [];
  if (lockSet.size) parts.push(`将锁定：${[...lockSet].join(', ')}`);
  if (unlockSet.size) parts.push(`将解锁：${[...unlockSet].join(', ')}`);
  const lockedCount = detail && detail.work ? detail.work.fieldsLocked.length : 0;
  $('lockHint').textContent =
    parts.join('；') ||
    `改动任何字段都会自动加锁（重导入不再覆盖该字段）；当前已锁 ${lockedCount} 个字段。解锁后该字段会重新接受 CSV 覆盖。`;
}

async function save() {
  const w = detail.work;
  const body = {};
  for (const f of FIELDS) {
    const input = $(`f_${f.key}`);
    if (!input) continue;
    const next = f.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
    const prev = w[f.key] ?? (f.type === 'number' ? null : '');
    if (String(next ?? '') !== String(prev ?? '')) body[f.key] = next;
  }
  if (lockSet.size) body.lock = [...lockSet];
  if (unlockSet.size) body.unlock = [...unlockSet];
  if (!Object.keys(body).length) {
    toast('没有改动', 'info');
    return;
  }
  try {
    detail = await api.patch(`/api/works/${encodeURIComponent(no)}`, body);
    toast('已保存（改动字段已锁定）', 'ok');
    render();
  } catch (e) {
    toast(`保存失败：${e.message}`, 'err', 4500);
  }
}

function bind() {
  const reader = $('btnReader');
  if (reader) reader.href = `reader.html?no=${encodeURIComponent(no)}`;
  $('btnSave').addEventListener('click', save);
  $('btnReset').addEventListener('click', () => {
    renderEdit();
    toast('已放弃本次修改', 'info');
  });
  $('btnDownload').addEventListener('click', () => trigger(false));
  $('btnForce').addEventListener('click', () => trigger(true));
  $('btnReveal').addEventListener('click', async () => {
    if (!detail.asset) return;
    try {
      const out = await api.post(`/api/assets/${detail.asset.id}/reveal`, {});
      toast(`已在文件管理器中定位：${out.dir}`, 'ok', 4200);
    } catch (e) {
      toast(`定位失败：${e.message}`, 'err');
    }
  });
  // 打开 PDF 的同时在文件管理器定位所在文件夹（不阻塞新标签打开 PDF）
  $('btnOpen').addEventListener('click', () => {
    const a = detail && detail.asset;
    if (!a || a.fileState !== 'present') return;
    api.post(`/api/assets/${a.id}/reveal`, {}).catch(() => {});
  });
  $('fileInput').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const out = await uploadPdf(no, file);
      toast(`上传成功：${out.pageCount} 页 / ${fmtBytes(out.fileSize)}`, 'ok', 4200);
      await load();
    } catch (e) {
      toast(`上传失败：${e.message}（${e.code}）`, 'err', 5000);
    } finally {
      ev.target.value = '';
    }
  });
}

async function trigger(force) {
  try {
    const out = await api.post(`/api/works/${encodeURIComponent(no)}/download`, { force });
    if (out.alreadyDownloaded) toast('已有本地 PDF（无需重复下载）', 'info');
    else if (out.reused) toast('下载任务已在队列中', 'info');
    else if (out.status === 'needs_manual') toast('没有可自动下载的开放源，已标记「需人工」', 'warn', 4600);
    else toast('已加入下载队列', 'ok');
    await load();
    startPolling();
  } catch (e) {
    toast(`触发下载失败：${e.message}（${e.code}）`, 'err', 5000);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      detail = await api.get(`/api/works/${encodeURIComponent(no)}`);
      renderFile();
      const st = detail.downloadJob && detail.downloadJob.status;
      if (!st || !ACTIVE.has(st)) {
        clearInterval(pollTimer);
        pollTimer = null;
        render();
      }
    } catch {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 1200);
}

bind();
load().catch((e) => toast(`加载失败：${e.message}`, 'err', 6000));
