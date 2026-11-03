/**
 * 生成「原文 / 译文对照」预览页（一次性快照，便于肉眼验收翻译质量）。
 * 用法：node scripts/make-preview.js <workNo> <fromPage> <toPage> [outFile]
 */
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.AGENTLIT_API || 'http://127.0.0.1:7317';
const workNo = process.argv[2] || '1.8';
const fromPage = Number(process.argv[3] || 1);
const toPage = Number(process.argv[4] || 3);
const outFile = process.argv[5] || path.join('preview', `translation-${workNo.replace(/\./g, '_')}.html`);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const pages = [];
let meta = null;
for (let p = fromPage; p <= toPage; p += 1) {
  const data = await getJson(`${API}/api/works/${workNo}/segments?page=${p}&withTranslation=1`);
  pages.push(data.pages[0]);
  if (!meta) meta = data;
}

// 统计：译文段数 / 字数
let segs = 0;
let srcChars = 0;
let dstChars = 0;
for (const page of pages) {
  for (const para of page.paras) {
    if (para.isMath || para.isLabel) continue;
    segs += 1;
    srcChars += String(para.src || para.text || '').length;
    dstChars += String(para.dst || '').length;
  }
}

// 文档标题（取第一条 title 段）
let docTitle = '';
for (const page of pages) {
  const t = page.paras.find((x) => x.role === 'title');
  if (t) {
    docTitle = t.text;
    break;
  }
}
const docTitleZh = pages.flatMap((p) => p.paras).find((x) => x.role === 'title' && x.dst)?.dst || '';

const q = meta.translationQuery || {};
const payload = {
  workNo,
  docTitle,
  docTitleZh,
  engine: q.engine || '',
  model: q.model || '',
  tgtLang: q.tgtLang || 'zh-CN',
  stats: { pages: pages.length, segs, srcChars, dstChars },
  pages: pages.map((p) => ({
    pageNo: p.pageNo,
    paras: p.paras.map((x) => ({
      text: x.text || x.src || '',
      src: x.src || x.text || '',
      dst: x.dst || '',
      role: x.role || 'body',
      tier: x.tier || 'body',
      align: x.align || 'left',
      passthrough: Boolean(x.passthrough || x.isMath || x.isLabel),
    })),
  })),
};

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>译文对照 · ${escapeHtml(docTitle.slice(0, 40))}</title>
<link rel="stylesheet" href="../web/assets/vendor/md/github.min.css" />
<style>
  :root {
    --bg: #f6f6f4; --panel: #ffffff; --ink: #1c1c1e; --muted: #6b6b70; --line: #e4e4e0;
    --accent: #2f6f4f; --accent-soft: #eef5f0; --src-ink: #4a4a4f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    line-height: 1.75;
  }
  header.top {
    position: sticky; top: 0; z-index: 10; background: rgba(255,255,255,.94);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--line);
    padding: 14px 28px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  }
  .brand { font-weight: 700; letter-spacing: .2px; }
  .meta { color: var(--muted); font-size: 13px; }
  .chip {
    font-size: 12px; padding: 2px 8px; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent); border: 1px solid #d5e6db;
  }
  .spacer { flex: 1; }
  .toggle { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .toggle button {
    appearance: none; border: 0; background: #fff; padding: 6px 14px; font-size: 13px;
    cursor: pointer; color: var(--muted);
  }
  .toggle button.on { background: var(--accent); color: #fff; }
  main { max-width: 1180px; margin: 0 auto; padding: 26px 20px 80px; }
  .doc-head { margin: 6px 0 22px; }
  .doc-head h1 { font-size: 26px; margin: 0 0 6px; line-height: 1.35; }
  .doc-head .zh { font-size: 17px; color: var(--accent); font-weight: 600; margin: 0 0 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 22px 26px; margin-bottom: 22px; }
  .page-tag { font-size: 12px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; margin-bottom: 14px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; padding: 10px 0; border-top: 1px dashed var(--line); }
  .row:first-of-type { border-top: 0; }
  .col-src { color: var(--src-ink); font-family: Georgia, "Times New Roman", serif; font-size: 14.5px; }
  .col-dst { font-size: 15.5px; }
  /* 角色 → 版式（与阅读器一致：title=h1 / section=h2 / caption 小号 / 引用左线） */
  .role-title .col-dst { font-size: 22px; font-weight: 700; line-height: 1.4; }
  .role-section .col-dst { font-size: 17px; font-weight: 700; color: #16324a; }
  .role-section .col-src { font-weight: 700; }
  .role-quote .col-dst { border-left: 3px solid var(--accent); padding-left: 12px; color: #333; }
  .role-quote .col-src { border-left: 3px solid #d8d8d4; padding-left: 12px; }
  .role-figure-label, .role-footnote, .role-reference, .role-header, .role-footer, .role-page-number {
    font-size: 12.5px; color: var(--muted);
  }
  .role-figure-label .col-dst, .role-figure-label .col-src { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .tier-h1 .col-dst { font-size: 22px; font-weight: 700; }
  .tier-h2 .col-dst { font-size: 17px; font-weight: 700; }
  .align-center .col-dst, .align-center .col-src { text-align: center; }
  .missing-dst { color: #b04545; font-style: italic; }
  .passthrough .col-dst { color: var(--muted); }
  .col-dst h1, .col-dst h2, .col-dst h3 { margin: .3em 0; line-height: 1.4; }
  .col-dst ul, .col-dst ol { margin: .3em 0 .3em 1.2em; padding: 0; }
  .col-dst p { margin: .3em 0; }
  body.only-dst .col-src { display: none; }
  body.only-dst .row { grid-template-columns: 1fr; }
  footer.foot { color: var(--muted); font-size: 12px; text-align: center; padding: 6px 0 0; }
  @media (max-width: 860px) {
    .row { grid-template-columns: 1fr; gap: 10px; }
  }
</style>
</head>
<body>
<header class="top">
  <span class="brand">译文对照预览</span>
  <span class="chip">${escapeHtml(payload.engine)} / ${escapeHtml(payload.model)}</span>
  <span class="meta">第 ${fromPage}–${toPage} 页 · ${payload.stats.segs} 段 · 原文 ${payload.stats.srcChars} 字符 → 译文 ${payload.stats.dstChars} 字</span>
  <span class="spacer"></span>
  <div class="toggle">
    <button id="btnBoth" class="on">原文 / 译文</button>
    <button id="btnDst">只看译文</button>
  </div>
</header>
<main>
  <div class="doc-head">
    <h1 id="docTitle"></h1>
    <p class="zh" id="docTitleZh"></p>
  </div>
  <div id="pages"></div>
  <footer class="foot">由 03-code 翻译管线生成 · 渲染规则与阅读器一致（角色/层级/对齐）</footer>
</main>
<script src="../web/assets/vendor/md/marked.min.js"></script>
<script src="../web/assets/vendor/md/purify.min.js"></script>
<script>
const DATA = ${JSON.stringify(payload).replace(/</g, '\\u003c')};
document.getElementById('docTitle').textContent = DATA.docTitle || '';
document.getElementById('docTitleZh').textContent = DATA.docTitleZh || '';

function renderMd(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  try {
    const html = marked.parse(raw, { breaks: true, gfm: true });
    return DOMPurify.sanitize(html);
  } catch (e) {
    return DOMPurify.sanitize(raw.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
  }
}

function paraHtml(p) {
  const cls = ['row', 'role-' + p.role, 'tier-' + p.tier, 'align-' + p.align];
  if (p.passthrough) cls.push('passthrough');
  const dst = p.dst
    ? renderMd(p.dst)
    : p.passthrough
      ? '<span style="color:#8a8a90">' + escapeText(p.src) + '</span>'
      : '<span class="missing-dst">（待翻译）</span>';
  const src = '<div class="col-src">' + DOMPurify.sanitize(escapeText(p.src)) + '</div>';
  return '<div class="' + cls.join(' ') + '">' + src + '<div class="col-dst">' + dst + '</div></div>';
}
function escapeText(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const pagesEl = document.getElementById('pages');
pagesEl.innerHTML = DATA.pages.map((page) => {
  return '<section class="card"><div class="page-tag">Page ' + page.pageNo + '</div>'
    + page.paras.map(paraHtml).join('') + '</section>';
}).join('');

document.getElementById('btnBoth').onclick = () => {
  document.body.classList.remove('only-dst');
  document.getElementById('btnBoth').classList.add('on');
  document.getElementById('btnDst').classList.remove('on');
};
document.getElementById('btnDst').onclick = () => {
  document.body.classList.add('only-dst');
  document.getElementById('btnDst').classList.add('on');
  document.getElementById('btnBoth').classList.remove('on');
};
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, 'utf8');
console.log(JSON.stringify({ out: path.resolve(outFile), bytes: html.length, stats: payload.stats, engine: payload.engine, model: payload.model }, null, 1));

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
