/**
 * 小工具：DOM 构造、toast、debounce、状态文案映射。
 * 只做渲染相关，不含业务状态计算（进度百分比由服务端给）。
 */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let toastBox = null;
export function toast(message, kind = 'info', ms = 3200) {
  if (!toastBox) {
    toastBox = el('div', { class: 'toast-box' });
    document.body.append(toastBox);
  }
  const item = el('div', { class: `toast toast-${kind}`, text: message });
  toastBox.append(item);
  setTimeout(() => item.classList.add('toast-out'), ms - 300);
  setTimeout(() => item.remove(), ms);
}

/** 下载状态 → 中文标签 + 徽章样式 */
export function downloadStatusView(item) {
  const job = item.job || null;
  if (item.fileState === 'present' && (!job || job.status === 'done')) {
    return { label: '已下载', kind: 'ok', percent: 100 };
  }
  if (item.downloadStatus === 'queued') return { label: '排队中', kind: 'wait', percent: 0 };
  if (item.downloadStatus === 'downloading') {
    const done = job ? job.bytesDone || 0 : 0;
    const total = job ? job.bytesTotal || 0 : 0;
    const percent = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
    return { label: `下载中 ${percent}%`, kind: 'run', percent };
  }
  if (item.downloadStatus === 'failed') {
    return { label: `失败${job && job.errorCode ? `（${job.errorCode}）` : ''}`, kind: 'err', percent: 0 };
  }
  if (item.downloadStatus === 'needs_manual') return { label: '需人工', kind: 'warn', percent: 0 };
  if (item.fileState === 'missing') return { label: '文件丢失', kind: 'err', percent: 0 };
  return { label: '未下载', kind: 'idle', percent: 0 };
}

export function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
