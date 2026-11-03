// ==UserScript==
// @name         文献库直传助手（Agent 工作流文献管理系统）
// @namespace    lit-local-uploader
// @version      1.2.0
// @description  手动模式：你自己打开文献页面，脚本自动识别该页 DOI/arXiv → 匹配本地文献库 → 抓取 PDF 直传系统（不经过浏览器下载文件夹）。脚本不会自动跳转或批量跑。支持人机验证（手动点掉后自动重试）。内置限速：两次上传至少间隔 15 秒、每日上限 60 篇。
// @author       lit
// @match        *://*.cambridge.org/*
// @match        *://link.springer.com/*
// @match        *://www.springer.com/*
// @match        *://*.springeropen.com/*
// @match        *://www.sciencedirect.com/*
// @match        *://onlinelibrary.wiley.com/*
// @match        *://ieeexplore.ieee.org/*
// @match        *://dl.acm.org/*
// @match        *://www.tandfonline.com/*
// @match        *://www.taylorfrancis.com/*
// @match        *://journals.sagepub.com/*
// @match        *://academic.oup.com/*
// @match        *://www.mdpi.com/*
// @match        *://www.nature.com/*
// @match        *://www.science.org/*
// @match        *://journals.aps.org/*
// @match        *://www.frontiersin.org/*
// @match        *://link.springeropen.com/*
// @match        *://arxiv.org/*
// @match        *://export.arxiv.org/*
// @match        *://*.doi.org/*
// @match        *://127.0.0.1:7317/*
// @match        *://localhost:7317/*
// @connect      127.0.0.1
// @connect      localhost
// @connect      cambridge.org
// @connect      springer.com
// @connect      sciencedirect.com
// @connect      elsevier.com
// @connect      wiley.com
// @connect      ieee.org
// @connect      acm.org
// @connect      tandfonline.com
// @connect      taylorfrancis.com
// @connect      sagepub.com
// @connect      oup.com
// @connect      mdpi.com
// @connect      nature.com
// @connect      science.org
// @connect      aps.org
// @connect      frontiersin.org
// @connect      arxiv.org
// @connect      doi.org
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ─── 配置（按需修改）───────────────────────────────────────────
  const API = 'http://127.0.0.1:7317/api';   // 本地文献库服务
  const MIN_INTERVAL_MS = 15000;             // 两次上传最小间隔（限速，勿调小）
  const DAILY_CAP = 60;                      // 每日上传上限
  const DEBUG = false;                       // true 时 console 输出详细日志
  const VERSION = '1.2.0';

  // ─── 人机验证（CAPTCHA / Cloudflare / WAF 拦截）─────────────────
  const CHALLENGE_RETRY_SEC = 10;            // 每 10 秒重试一次
  const CHALLENGE_RETRY_MAX = 18;            // 最多等 3 分钟（18 × 10s）
  const CHALLENGE_STATUS = [403, 429, 503];
  const CHALLENGE_RE = /(captcha|recaptcha|hcaptcha|turnstile|cf-browser-verification|cf[_-]chl|challenge[-_ ]?platform|are you a (human|robot)|verify (you are|that you.?re)|checking your browser|just a moment|attention required|enable javascript and cookies|access denied|blocked by|人机验证|请完成(安全)?验证|验证您?是?人类|访问验证|安全验证|请求验证|点击.*验证)/i;
  // 「机构没买 / 需单独购买」的页面特征：和「站点规则没覆盖」区分开，方便事后人工补
  const NOACCESS_RE = /(purchase (this )?(article|pdf|chapter)|buy (this )?(article|pdf)|rent (this )?article|subscribe to (read|view)|sign in to (buy|purchase)|you (do not|don'?t) have access|your institution (does not|doesn'?t) (have|provide)|not subscribed|购买|订阅以|无访问权限|需单独购买)/i;
  class ChallengeError extends Error {
    constructor(reason) { super('需要人机验证：' + reason); this.name = 'ChallengeError'; this.reason = reason; }
  }

  // doi.org 是纯重定向器：在它上面跑会误判"无 PDF"，等它落到真正的出版商页面再处理
  const REDIRECTORS = /(^|\.)doi\.org$/i;

  // 硬封锁页（区别于“需要人机验证”的 challenge）：返回这类页说明站点直接拒绝访问，
  // 无法抓取。直接标记 blocked 并跳过，不必傻等 3 分钟挑战窗口。
  const BLOCK_RE = /(sorry,?\s*you have been blocked|you have been blocked|has been blocked by the owner|access to this site has been denied|your request has been blocked|the owner of this website has banned|ray id\s*[:#]|cf-chl-error|error code (1020|1009|1015)|ddos[ -]?protection by cloudflare)/i;
  function pageLooksLikeBlock() {
    try {
      const t = (document.title || '') + '\n' + (document.body ? document.body.innerText.slice(0, 4000) : '');
      return BLOCK_RE.test(t);
    } catch { return false; }
  }

  // ─── 站点专属的 PDF 链接发现规则（在 citation_pdf_url 之前/之后皆可）──
  // 返回绝对 URL 或 null。命中顺序：直链 .pdf 页 → citation_pdf_url → 站点规则 → 泛化兜底。
  const SITE_RULES = [
    {
      host: /(^|\.)cambridge\.org$/i,
      find: () =>
        q('a[href*="/core/services/aop-cambridge-core/content/view/"]') ||
        q('a[data-test="access-pdf"]') ||
        null,
    },
    {
      host: /(^|\.)sciencedirect\.com$/i,
      find: () =>
        q('a[href*="/pdfft"]') ||
        q('a.download-pdf-link') ||
        q('a[aria-label*="Download"][href*="/pii/"]') ||
        null,
    },
    {
      host: /(^|\.)ieeexplore\.ieee\.org$/i,
      find: () => {
        const iframe = q('iframe[src*="/stamp"]');
        if (iframe) return iframe;
        // 文档页 URL 只有内部编号 /document/1675516：直接构造 stamp 页（真正 PDF 在其 iframe 里，稍后解包）
        const m = location.pathname.match(/document\/(\d+)/);
        return m ? `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${m[1]}` : null;
      },
    },
    {
      host: /(^|\.)tandfonline\.com$/i,
      find: () => q('a[href*="/doi/pdf/"]') || q('a.showPdf') || null,
    },
    {
      host: /(^|\.)journals\.sagepub\.com$/i,
      find: () => q('a[href*="/doi/pdf/"]') || q('a[href*="/doi/epdf/"]') || null,
    },
    {
      host: /(^|\.)academic\.oup\.com$/i,
      find: () => q('a[href*="/article-pdf/"]') || q('a.pdf-link') || null,
    },
    {
      host: /(^|\.)dl\.acm\.org$/i,
      find: () => q('a[href*="/doi/pdf/"]') || null,
    },
  ];

  const log = (...a) => { if (DEBUG) console.log('%c[lit]', 'color:#c00', ...a); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => {
    try { const el = document.querySelector(sel); return el ? absUrl(el.getAttribute('href') || el.getAttribute('src')) : null; }
    catch { return null; }
  };
  const absUrl = (u) => { try { return new URL(u, location.href).toString(); } catch { return null; } };
  const truncate = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const isSameOrigin = (u) => { try { return new URL(u).origin === location.origin; } catch { return false; } };

  // ─── 标识符提取 ────────────────────────────────────────────────
  function extractIdentifiers() {
    const metas = (n) => document.querySelector(`meta[name="${n}" i], link[rel="${n}" i]`)?.content ||
                        document.querySelector(`link[rel="${n}" i]`)?.href || '';
    let doi = metas('citation_doi') || metas('dc.doiidentifier') || metas('dc.identifier') || '';
    if (doi && !/^10\./.test(doi.trim())) {
      const m = String(doi).match(/10\.\d{4,9}\/\S+/);
      doi = m ? m[0] : '';
    }
    let arxiv = '';
    if (/(^|\.)arxiv\.org$/i.test(location.hostname)) {
      const m = location.pathname.match(/(?:abs|pdf)\/(\d{4}\.\d{4,5})/);
      if (m) arxiv = m[1];
    }
    if (!doi) {
      const m = location.href.match(/doi\.org\/(10\.\d{4,9}\/\S+)/);
      if (m) doi = decodeURIComponent(m[1]);
    }
    // URL 路径形态：dl.acm.org/doi/10.1145/... 、tandfonline.com/doi/pdf/... 等
    if (!doi) {
      const m = location.pathname.match(/\/doi\/(?:full|pdf|epdf|abs)?\/?(10\.\d{4,9}\/[^?#\s]+)/i);
      if (m) doi = decodeURIComponent(m[1]).replace(/\/+$/, '');
    }
    // SPA 兜底：IEEE 等动态站把元数据嵌在页面 JS 里（如 xplGlobal.document.metadata={"doi":"10.1109/..."}）
    if (!doi) {
      const m = document.documentElement.innerHTML.match(/"doi"\s*:\s*"(10\.\d{4,9}\/[^"]+)"/);
      if (m) doi = m[1];
    }
    return { doi: String(doi || '').trim(), arxiv: String(arxiv || '').trim() };
  }

  // ─── PDF 链接发现 ──────────────────────────────────────────────
  function findPdfUrl() {
    if (/\.pdf(\?|$)/i.test(location.pathname)) return absUrl(location.href);
    const site = SITE_RULES.find((r) => r.host.test(location.hostname));
    // citation_pdf_url：meta 用 content、link 用 href——不能用 q()（它只认 href/src，meta 会拼出 /null）
    let viaCite = null;
    const citeEl = document.querySelector('meta[name="citation_pdf_url" i], link[rel="citation_pdf_url" i]');
    if (citeEl) viaCite = citeEl.getAttribute('content') || citeEl.getAttribute('href');
    const ordered = [];
    if (viaCite) ordered.push(absUrl(viaCite));
    if (site) ordered.push(site.find());
    // 泛化兜底：页面上显式的 pdf 链接（最多取前 3 个候选交给校验环节）
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (/\.pdf(\?|#|$)/i.test(h) || /\/pdf\/|\/pdfft|stampPDF|article-pdf/i.test(h)) {
        ordered.push(absUrl(h));
        if (ordered.length > 6) break;
      }
    }
    return ordered.find(Boolean) || null;
  }

  // IEEE stamp.jsp 是 HTML 壳：解开取 iframe 里真正的 getPDF 地址
  async function resolvePdfUrl(url) {
    if (url && /stamp\/stamp\.jsp/i.test(url)) {
      try {
        const html = await fetch(url, { credentials: 'include' }).then((r) => r.text());
        const m = html.match(/<iframe[^>]+src="([^"]+getPDF[^"]*)"/i)
               || html.match(/src="(https?:\/\/[^"]+\.pdf[^"]*)"/i);
        if (m) { const real = absUrl(m[1]); log('IEEE 解包 →', real); return real; }
      } catch (e) { log('IEEE 解包失败：', e.message); }
    }
    return url;
  }

  // ─── 人机验证：页面层检测 + 等待人工点掉 ────────────────────────
  function hasPaywallHint() {
    try { return document.body ? NOACCESS_RE.test(document.body.innerText.slice(0, 6000)) : false; }
    catch { return false; }
  }

  function pageLooksLikeChallenge() {
    try {
      if (document.querySelector('#cf-challenge-running, .cf-browser-verification, iframe[src*="challenge"], iframe[src*="captcha"]')) return true;
      const t = (document.title || '') + '\n' + (document.body ? document.body.innerText.slice(0, 3000) : '');
      return CHALLENGE_RE.test(t);
    } catch { return false; }
  }

  // 页面被验证拦住时：提示用户手动点，脚本按固定间隔重查
  async function waitForHumanOnPage(label) {
    for (let i = 0; i < CHALLENGE_RETRY_MAX; i++) {
      if (!pageLooksLikeChallenge()) return true;
      toast('warn', '需要你手动完成人机验证',
        `${label}：${location.hostname} 返回了验证页。请在页面里点掉验证，脚本每 ${CHALLENGE_RETRY_SEC}s 自动重试（${i + 1}/${CHALLENGE_RETRY_MAX}）`,
        CHALLENGE_RETRY_SEC * 1000);
      await sleep(CHALLENGE_RETRY_SEC * 1000);
    }
    return !pageLooksLikeChallenge();
  }

  // ─── 限速与每日上限 ────────────────────────────────────────────
  function rateGate() {
    const last = Number(GM_getValue('lastOpTs', 0));
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dayKey = `cap-${today}`;
    const used = Number(GM_getValue(dayKey, 0));
    if (used >= DAILY_CAP) return { ok: false, why: `已达今日上限 ${DAILY_CAP} 篇`, cap: true };
    if (now - last < MIN_INTERVAL_MS) {
      const wait = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
      return { ok: false, why: `限速中，${wait}s 后重试本页`, waitMs: MIN_INTERVAL_MS - (now - last) };
    }
    return { ok: true };
  }
  function markOp() {
    GM_setValue('lastOpTs', Date.now());
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dayKey = `cap-${today}`;
    GM_setValue(dayKey, Number(GM_getValue(dayKey, 0)) + 1);
  }
  // ─── GM promise 封装 ───────────────────────────────────────────
  const gmr = (opt) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      timeout: 60000,
      anonymous: false,
      ...opt,
      onload: resolve,
      onerror: () => reject(new Error('网络错误')),
      ontimeout: () => reject(new Error('超时')),
    });
  });

  const ascii = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
  const headText = (bytes, n = 4000) => {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, n)); } catch { return ''; }
  };

  // 原始响应：同域优先页面 fetch（带完整浏览器上下文，Cloudflare 放行），否则回退 GM
  async function readBody(url) {
    if (isSameOrigin(url)) {
      try {
        const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/pdf,*/*' } });
        const buf = new Uint8Array(await r.arrayBuffer());
        return { status: r.status, buf, ct: (r.headers && r.headers.get('content-type')) || '' };
      } catch (e) { log('同域 fetch 异常，回退 GM：', e.message); }
    }
    const resp = await gmr({ method: 'GET', url, responseType: 'arraybuffer' });
    const buf = new Uint8Array(resp.response || new ArrayBuffer(0));
    const h = String(resp.responseHeaders || '');
    const m = h.match(/content-type:\s*([^\r\n;]+)/i);
    return { status: resp.status, buf, ct: m ? m[1] : '' };
  }

  function classify(status, ct, text) {
    if (CHALLENGE_STATUS.indexOf(status) >= 0) return `HTTP ${status}`;
    if (CHALLENGE_RE.test(text)) return text.match(CHALLENGE_RE)[0];
    if (/text\/html/i.test(ct) || /^\s*<!doctype|<html/i.test(text)) return `返回的是网页（${ct || 'html'}）`;
    return null;
  }

  // 抓 PDF：命中验证 → 抛 ChallengeError；不是 PDF → 抛普通错误
  async function fetchPdfBlob(url) {
    const r = await readBody(url);
    if (r.buf.length >= 5 && ascii(r.buf.slice(0, 5)) === '%PDF-') {
      return new Blob([r.buf], { type: 'application/pdf' });
    }
    const text = headText(r.buf);
    const why = classify(r.status, r.ct, text);
    if (why) {
      const isChallenge = CHALLENGE_STATUS.indexOf(r.status) >= 0 || CHALLENGE_RE.test(text);
      throw isChallenge ? new ChallengeError(why) : new Error(`响应不是 PDF（${why}）`);
    }
    throw new Error(`响应不是 PDF：HTTP ${r.status} ${r.ct || ''} ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
  }

  // 抓取 + 遇验证自动等人工点掉后重试（用户自己点，脚本不尝试绕过）
  async function fetchPdfWithHumanHelp(url) {
    let cur = url;
    for (let i = 0; i <= CHALLENGE_RETRY_MAX; i++) {
      try {
        return await fetchPdfBlob(cur);
      } catch (e) {
        if (!(e instanceof ChallengeError) || i === CHALLENGE_RETRY_MAX) throw e;
        toast('warn', '需要你手动完成人机验证',
          `抓取被拦（${e.reason}）。请在页面里点掉验证，脚本每 ${CHALLENGE_RETRY_SEC}s 自动重试（${i + 1}/${CHALLENGE_RETRY_MAX}）`,
          CHALLENGE_RETRY_SEC * 1000);
        await sleep(CHALLENGE_RETRY_SEC * 1000);
        // 验证通过后页面结构可能变了：重新发现一次 PDF 链接
        const again = findPdfUrl();
        cur = again ? await resolvePdfUrl(again) : cur;
      }
    }
    throw new Error('人机验证未通过');
  }

  // ─── UI ────────────────────────────────────────────────────────
  GM_addStyle(`
    #lit-toast{position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.5 system-ui,sans-serif;
      background:#111;color:#fff;padding:10px 14px;border-radius:8px;max-width:340px;white-space:pre-wrap;
      box-shadow:0 4px 16px rgba(0,0,0,.35);opacity:0;transition:opacity .25s}
    #lit-toast.ok{background:#0d6b3f}#lit-toast.warn{background:#8a6d00}#lit-toast.err{background:#8b2020}
    #lit-toast b{display:block;margin-bottom:2px}
  `);
  function toast(kind, title, body, ms = 5000) {
    let el = document.getElementById('lit-toast');
    if (!el) { el = document.createElement('div'); el.id = 'lit-toast'; document.documentElement.appendChild(el); }
    el.className = kind;
    el.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, ms);
  }

  // ─── 主流程 ────────────────────────────────────────────────────
  let busy = false;

  // 返回状态：ok / dup / nomatch / nopdf / noaccess / blocked / rate / failed
  async function run() {
    if (busy) return 'busy';
    // doi.org 是纯重定向器：不在这里处理，等浏览器跳到真正的出版商页面再跑
    if (REDIRECTORS.test(location.hostname)) {
      log('跳过重定向页 doi.org，等它落到出版商页面');
      return 'nomatch';
    }
    // 硬封锁页：直接提示并跳过，不傻等
    if (pageLooksLikeBlock()) {
      toast('err', '页面被拦截/封锁', `${location.hostname} 返回了访问封锁页（如 Cloudflare "Sorry, you have been blocked"）。本篇无法抓取，请换其它来源或稍后再试。`, 8000);
      return 'blocked';
    }
    const flag = `lit-done-${location.href}`;
    // 用 GM 存（不靠 sessionStorage）：跨域跳转后还能认出"这篇已处理过"
    try { if (GM_getValue(flag, '0') === '1') { log('本页已上传过，跳过'); return 'dup'; } } catch {}
    const id = extractIdentifiers();
    if (!id.doi && !id.arxiv) {
      console.info('[lit] 本页未识别到 DOI/arXiv，跳过（页面 URL:', location.pathname, '）');
      return 'nomatch';
    }
    console.info('[lit] 识别到标识符：', id.doi || id.arxiv);
    busy = true;
    try {
      // 0) 页面本身是验证页 → 等人工点掉
      if (pageLooksLikeChallenge() && !(await waitForHumanOnPage('页面加载'))) {
        toast('err', '人机验证未通过', `${location.hostname} 一直是验证页，已跳过本条`, 8000);
        return 'failed';
      }
      // 1) 查库
      const ps = new URLSearchParams();
      if (id.doi) ps.set('doi', id.doi);
      if (id.arxiv) ps.set('arxiv', id.arxiv);
      const look = await gmr({ method: 'GET', url: `${API}/works/lookup?${ps}` });
      if (look.status !== 200) throw new Error(`lookup HTTP ${look.status}`);
      const data = JSON.parse(look.responseText);
      if (!data.found) { log('未命中库内条目', id); return 'nomatch'; }
      const { work, asset } = data;
      if (asset && asset.fileState === 'present') {
        try { GM_setValue(flag, '1'); } catch {}
        log('已在库中', work.no); return 'dup';
      }
      // 2) 找 PDF
      let pdfUrl = findPdfUrl();
      // 慢加载 / SPA 的 PDF 链接可能晚出现：给 3 次机会（每次 3s）再判定「无 PDF」；
      // 期间如果页面是验证页，则等你手动点掉后再找一次
      for (let k = 0; !pdfUrl && k < 3; k++) {
        if (pageLooksLikeChallenge() && !(await waitForHumanOnPage('PDF 链接'))) break;
        await sleep(3000);
        pdfUrl = findPdfUrl();
      }
      if (!pdfUrl) {
        const paywall = hasPaywallHint();
        toast('warn', `跳过 ${work.no}《${truncate(work.title, 30)}》`,
          paywall ? '页面没有 PDF 链接，且提示需购买/机构无权限 → 交给人工处理'
                  : '页面上没找到可抓取的 PDF 链接（站点规则未覆盖）', 6000);
        return paywall ? 'noaccess' : 'nopdf';
      }
      // 3) 限速
      const gate = rateGate();
      if (!gate.ok) { toast('warn', '已匹配但暂缓上传', gate.why, 8000); return gate.cap ? 'rate' : 'nopdf'; }
      // 4) 抓 PDF（同域走页面 fetch，跨域回退 GM；都带当前登录会话；遇验证等人工点掉后重试）
      pdfUrl = await resolvePdfUrl(pdfUrl);
      const blob = await fetchPdfWithHumanHelp(pdfUrl);
      if (!blob || blob.size < 8192) throw new Error(`文件过小（${blob ? blob.size : 0}B），疑似错误页`);
      const head = await blob.slice(0, 5).text();
      if (head !== '%PDF-') throw new Error('内容不是 PDF（魔数不符）');
      // 5) 直传
      const up = await gmr({
        method: 'POST',
        url: `${API}/works/${encodeURIComponent(work.no)}/asset`,
        data: blob,
        headers: { 'Content-Type': 'application/pdf' },
      });
      if (up.status === 200 || up.status === 201) {
        markOp();
        try { GM_setValue(flag, '1'); } catch {}
        toast('ok', `已入库 ${work.no}`, `《${truncate(work.title, 34)}》 · ${(blob.size / 1024).toFixed(0)} KB`, 6000);
        return 'ok';
      } else if (up.status === 409) {
        try { GM_setValue(flag, '1'); } catch {}
        log('已在库中(409)', work.no);
        return 'dup';
      } else {
        let msg = '';
        try { msg = JSON.parse(up.responseText)?.error?.message || ''; } catch {}
        throw new Error(`上传 HTTP ${up.status} ${msg}`);
      }
    } catch (e) {
      toast('err', '直传失败', String(e.message || e), 8000);
      log(e);
      return 'failed';
    } finally {
      busy = false;
    }
  }

  // ─── 菜单 ──────────────────────────────────────────────────────
  GM_registerMenuCommand('立即重试本页（忽略已上传标记）', () => {
    try { GM_deleteValue(`lit-done-${location.href}`); } catch {}
    run();
  });

  GM_registerMenuCommand('诊断本页', async () => {
    const id = extractIdentifiers();
    let look = '（未查询：没有标识符）';
    if (id.doi || id.arxiv) {
      try {
        const ps = new URLSearchParams();
        if (id.doi) ps.set('doi', id.doi);
        if (id.arxiv) ps.set('arxiv', id.arxiv);
        const r = await gmr({ method: 'GET', url: `${API}/works/lookup?${ps}` });
        const d = JSON.parse(r.responseText);
        look = d.found
          ? `命中 ${d.work.no}《${truncate(d.work.title, 24)}》 本地文件:${d.asset ? d.asset.fileState : '无'}`
          : '库里没有这条（不匹配，脚本不动作）';
      } catch (e) {
        look = 'lookup 失败：' + e.message + '（本地服务没开？）';
      }
    }
    let pdf = '未找到';
    try { pdf = findPdfUrl() || '未找到'; } catch {}
    toast('warn', '诊断结果',
      `DOI: ${id.doi || '无'}\narXiv: ${id.arxiv || '无'}\n匹配: ${look}\nPDF链接: ${pdf}\n验证页: ${pageLooksLikeChallenge() ? '是' : '否'}`,
      15000);
  });

  // ─── 与系统网页集成：只上报「脚本已就绪」─────────────────────
  // 手动模式：脚本不再自动跳转/批量跑，只在你自己打开的文献页面上自动直传。
  // 这里仅在系统页暴露版本号，供网页显示「直传脚本已就绪 / 未安装」。
  function integrateSystemPage() {
    const onSystem = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) &&
      (location.port === '7317');
    if (!onSystem) return;
    window.__litUploader = VERSION;
    // 主动通知网页：脚本已就绪（页面可能在脚本前加载，poll 也会兜底）
    try { window.dispatchEvent(new Event('lit-ready')); } catch {}
  }

  // ─── 启动 ──────────────────────────────────────────────────────
  async function boot() {
    await sleep(1500);
    integrateSystemPage();
    // 手动模式：只处理"你当前打开的这一页"，不自动跳到下一篇
    await run();
  }
  // 尽早让网页按钮就绪（DOM 在 document-idle 已就绪；即便早于网页模块也无害）
  try { integrateSystemPage(); } catch {}
  setTimeout(boot, 0);

  // 只跟 SPA 路由变化（出版商站内切换文章时不刷新页面）：URL 变了就再跑一次本页
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    setTimeout(() => run(), 1500);
  }, 2000);
})();
