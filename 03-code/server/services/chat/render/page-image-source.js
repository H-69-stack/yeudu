/**
 * `lit_page_image` 的渲染 seam：把「PDF 某一页（或其一区域）」渲染成图像字节。
 *
 * 移植自 dsh-impl 的 `service/page-image-source.ts`（P3 视觉通道，已验证实现），
 * 保留了它的三条硬契约：
 *   1) **环境/协议故障一律 reject**，绝不降级成"这页没有内容"（dsh `page-image-source.ts` 头部）；
 *   2) **不监听任何端口**：PDF 字节与 pdf.js 资源由 playwright 的 `context.route` 在
 *      进程内 fulfill，假 origin `http://lit-page.invalid`（RFC 2606，DNS 永不解析）；
 *   3) **非假 origin 一律 route.abort()** —— 这是唯一的出网闸门。
 *
 * 与 dsh 版的差别只在于宿主：本项目是纯 JS Express 服务，没有 Cordis，所以
 *   · 配置/依赖解析走入参（`opts.pdfjsDir` / `opts.playwrightModule`），不靠 `ctx.inject`；
 *   · 进程内单例由 {@link getSharedRenderer} 提供，生命周期跟 Express 进程走。
 *
 * 依赖解析顺序（关键，别硬编码死）：① `require('playwright')`；② 用 `createRequire`
 * 解析 `opts.playwrightModule`（绝对路径，可指向别的仓库的 node_modules）。
 * 两条都不通 ⇒ 抛 `E_RENDERER_UNAVAILABLE`，**不静默降级**。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { planRender, regionRect } from './render-geometry.js';

/** 假 origin：`.invalid` 由 RFC 2606 保留，永不解析 ⇒ 即使 route 漏配也发不出去。 */
const ORIGIN = 'http://lit-page.invalid';
/** pdf.js 资源目录白名单（只允许这些目录下的单层文件）。 */
const ASSET_DIRS = ['build', 'standard_fonts', 'cmaps', 'iccs', 'wasm'];
/**
 * 允许的静态文件扩展名。`ttf`/`otf` 不能漏：`standard_fonts/` 里的 `LiberationSans-*.ttf`
 * 正是 pdf.js 给未内嵌 Helvetica/Arial 用的标准字体数据，漏了它们字形会静默退化。
 */
const ASSET_EXT = /\.(mjs|js|pfb|ttf|otf|bcmap|bin|icc|wasm)$/u;
/** build 目录里额外只放行 pdf.js 的入口文件名。 */
const BUILD_ENTRY = /^pdf(\.worker)?(\.min)?\.mjs$/u;
/** 改了页面内脚本就 +1（进缓存键，作废旧图）。 */
const ENCODER_VERSION = 2;
/** 进程侧结果缓存容量（LRU，Map 插入序）。 */
const CACHE_CAPACITY = 8;
/** 页面内 document 缓存容量。 */
const DOC_CACHE_CAPACITY = 2;
/** docKey → PDF 路径登记表上限（只为 route 回字节用）。 */
const DOC_REGISTRY_CAPACITY = 4;

class RenderFailure extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RenderFailure';
    this.code = 'E_RENDER_FAILED';
  }
}

// ---------------------------------------------------------------- 依赖解析

/**
 * 解析 playwright。
 * @param {string} [playwrightModule] 可选的绝对路径（指向另一仓库的 node_modules/playwright）
 * @returns {{chromium:Object, resolvedFrom:string}}
 */
function loadPlaywright(playwrightModule) {
  const require_ = createRequire(import.meta.url);
  const attempts = [];
  try {
    const mod = require_('playwright');
    if (mod?.chromium) return { chromium: mod.chromium, resolvedFrom: require_.resolve('playwright') };
    attempts.push('require("playwright") 成功但没有 chromium 入口');
  } catch (error) {
    attempts.push(`require("playwright") 失败：${error?.code ?? error?.message ?? error}`);
  }
  if (typeof playwrightModule === 'string' && playwrightModule.length > 0) {
    try {
      const mod = require_(playwrightModule);
      if (mod?.chromium) return { chromium: mod.chromium, resolvedFrom: require_.resolve(playwrightModule) };
      attempts.push(`${playwrightModule} 加载了但没有 chromium 入口`);
    } catch (error) {
      attempts.push(`${playwrightModule} 失败：${error?.code ?? error?.message ?? error}`);
    }
  }
  throw Object.assign(
    new Error(
      'lit_page_image 未找到 playwright：视觉通道依赖 playwright（本项目**不新增**这个依赖）。'
      + '可用 `chat.pageImage.playwrightModule` 指定它的绝对路径'
      + '（例如另一个已装 playwright 的仓库的 node_modules/playwright）。'
      + `（已尝试：${attempts.join('；')}）`,
    ),
    { code: 'E_RENDERER_UNAVAILABLE' },
  );
}

// ---------------------------------------------------------------- pdf.js 资产

function countAssets(root) {
  const counts = {};
  const files = {};
  for (const dir of ASSET_DIRS) {
    let found = [];
    try {
      found = fs
        .readdirSync(path.join(root, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && ASSET_EXT.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      found = []; // 目录不存在 ⇒ 0（下面的断言决定这是不是致命）
    }
    files[dir] = found;
    counts[dir] = found.length;
  }
  return { counts, files };
}

function describeAssets(assets) {
  const line = ['standard_fonts', 'cmaps', 'iccs', 'wasm', 'build']
    .map((d) => `${d}=${assets.counts[d]}`)
    .join(' ');
  const degraded = [];
  if (assets.counts.iccs === 0) degraded.push('ICC 色彩管理（走 JS 回退）');
  if (assets.counts.wasm === 0) degraded.push('wasm 解码器（走 JS 回退）');
  return degraded.length === 0 ? line : `${line}｜降级：${degraded.join('；')}`;
}

/**
 * 解析 pdf.js 静态资源目录：**包根与 build 目录两种写法都接受**（与 dsh 一致）。
 * `build/` 里同名的 standard_fonts/、cmaps/ 是**空目录**，指到那里等于没有资源。
 * @param {string} [configured]
 * @returns {{root:string, buildDir:string, version:string, source:string, assets:Object, assetsLine:string}}
 */
function resolvePdfjsAssets(configured) {
  const accept = (root, source, hint) => {
    const assets = countAssets(root);
    if (assets.counts.standard_fonts === 0 || assets.counts.cmaps === 0) return undefined;
    const buildDir = fs.existsSync(path.join(root, 'build', 'pdf.min.mjs'))
      ? path.join(root, 'build')
      : root;
    assertPdfjsPair(buildDir, hint);
    return { root, buildDir, version: readPdfjsVersion(root), source, assets, assetsLine: describeAssets(assets) };
  };

  if (typeof configured === 'string' && configured.length > 0) {
    for (const root of [configured, path.dirname(configured)]) {
      const hit = accept(root, 'config', `（pdfjsDir=${configured} ⇒ 实际包根 ${root}）`);
      if (hit) return hit;
    }
    throw Object.assign(
      new Error(
        'lit_page_image 启动失败：pdfjsDir 既不是 pdfjs-dist 包根、也不是它的 build 目录。'
        + `需要指向包根（其下有 build/、standard_fonts/、cmaps/）或它的 build 目录（上一级有前两者）。`
        + `注意 build/ 里的 standard_fonts/、cmaps/ 是空目录，指到那里等于没有资源。`
        + `（实测 ${configured}：${describeAssets(countAssets(configured))}）`,
      ),
      { code: 'E_RENDERER_UNAVAILABLE' },
    );
  }

  const require_ = createRequire(import.meta.url);
  let packageJson;
  try {
    packageJson = require_.resolve('pdfjs-dist/package.json');
  } catch (error) {
    throw Object.assign(
      new Error(
        `lit_page_image 启动失败：无法解析宿主安装里的 pdfjs-dist（${error?.message ?? error}）。`
        + '请配置 chat.pageImage.pdfjsDir 指向一份完整的 pdf.js 静态资源目录。',
      ),
      { code: 'E_RENDERER_UNAVAILABLE' },
    );
  }
  const root = path.dirname(packageJson);
  const hit = accept(root, 'host-install', '修法：重装 pdfjs-dist，或配置 chat.pageImage.pdfjsDir。');
  if (!hit) {
    throw Object.assign(
      new Error(
        `lit_page_image 启动失败：pdf.js 资源目录里缺少 standard_fonts/ 或 cmaps/（${root}）。`
        + `（实测：${describeAssets(countAssets(root))}）`,
      ),
      { code: 'E_RENDERER_UNAVAILABLE' },
    );
  }
  return hit;
}

/** 断言 API 与 worker **成对**同目录（跨目录各取一个会报版本错配）。 */
function assertPdfjsPair(dir, hint) {
  const missing = ['pdf.min.mjs', 'pdf.worker.min.mjs'].filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length === 0) return;
  throw Object.assign(
    new Error(
      `lit_page_image: pdf.js assets not found in "${dir}"; expected pdf.min.mjs and pdf.worker.min.mjs`
      + `（缺：${missing.join('、')}）。成对存在是为了让 API 与 worker 版本天然一致。${hint}`,
    ),
    { code: 'E_RENDERER_UNAVAILABLE' },
  );
}

function readPdfjsVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------- 页面内脚本

const RENDERER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>lit page renderer</title>
<style>html,body{margin:0;padding:0;background:#fff}</style></head>
<body><canvas id="lit-canvas"></canvas>
<script type="module">
const state = { pdfjs: undefined, docs: new Map() }
try {
  const pdfjs = await import('/vendor/build/pdf.min.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.min.mjs'
  state.pdfjs = pdfjs

  const load = async (docKey) => {
    const hit = state.docs.get(docKey)
    if (hit) { state.docs.delete(docKey); state.docs.set(docKey, hit); return hit }
    const task = pdfjs.getDocument({
      url: '/doc.pdf?doc=' + encodeURIComponent(docKey),
      isEvalSupported: false,
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/standard_fonts/',
      iccUrl: '/vendor/iccs/',
      wasmUrl: '/vendor/wasm/',
    })
    const doc = await task.promise
    const entry = { task, doc, pageCount: doc.numPages }
    state.docs.set(docKey, entry)
    while (state.docs.size > ${DOC_CACHE_CAPACITY}) {
      const oldest = state.docs.keys().next()
      if (oldest.done) break
      const stale = state.docs.get(oldest.value)
      state.docs.delete(oldest.value)
      try { await stale.task.destroy() } catch (e) { /* 已被回收 */ }
    }
    return entry
  }

  window.__litPageImageOpen = async (docKey) => (await load(docKey)).pageCount
  window.__litPageImageSize = async (docKey, pageNo) => {
    const entry = await load(docKey)
    const pg = await entry.doc.getPage(pageNo)
    const vp = pg.getViewport({ scale: 1 })
    return { width: vp.width, height: vp.height }
  }
  window.__litPageImageRender = async (docKey, pageNo, plan, mediaType, quality) => {
    const entry = await load(docKey)
    const pg = await entry.doc.getPage(pageNo)
    const canvas = document.getElementById('lit-canvas')
    canvas.width = plan.width
    canvas.height = plan.height
    const context = canvas.getContext('2d')
    const viewport = pg.getViewport({ scale: plan.scale })
    const ox = Math.floor(viewport.width * plan.region.x)
    const oy = Math.floor(viewport.height * plan.region.y)
    const params = { canvasContext: context, viewport, background: 'rgb(255,255,255)' }
    if (ox !== 0 || oy !== 0) params.transform = [1, 0, 0, 1, -ox, -oy]
    await pg.render(params).promise
    const dataUrl = quality === null ? canvas.toDataURL(mediaType) : canvas.toDataURL(mediaType, quality)
    return { dataUrl, width: canvas.width, height: canvas.height }
  }
  window.__litPageImageReady = true
} catch (error) {
  window.__litPageImageInitError = String((error && error.message) || error)
  throw error
}
</script>
</body></html>`;

// ---------------------------------------------------------------- 渲染器

function buildDocKey(pdfPath, info) {
  return createHash('sha256').update(`${pdfPath}|${Math.round(info.mtimeMs)}|${info.size}`).digest('hex').slice(0, 16);
}

function buildCacheKey(input) {
  return [
    'v', ENCODER_VERSION,
    input.pdfPath,
    Math.round(input.mtimeMs),
    input.size,
    input.pageNo,
    // 归一化后的裁剪框：预设与等价分数矩形因此共享缓存
    JSON.stringify(regionRect(input.region)),
    input.maxEdge,
    input.maxPixels,
    input.format,
    input.jpegQuality,
    input.pdfjsVersion,
  ].join('|');
}

function assertImageSignature(bytes, mediaType) {
  const jpeg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!(mediaType === 'image/jpeg' ? jpeg : png)) {
    throw new RenderFailure(`渲染结果的字节签名不符合 ${mediaType}（前 8 字节：${Buffer.from(bytes.subarray(0, 8)).toString('hex')}）`);
  }
}

function decodeDataUrl(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  if (comma < 0) throw new RenderFailure('浏览器返回了无法解析的 data URL');
  return Buffer.from(String(dataUrl).slice(comma + 1), 'base64');
}

/**
 * 创建渲染器。
 * @param {Object} [opts]
 * @param {string} [opts.pdfjsDir] pdf.js 静态资源目录（包根或它的 build 目录）
 * @param {string} [opts.playwrightModule] playwright 的绝对路径（可选）
 * @param {number} [opts.renderTimeoutMs=8000]
 * @param {number} [opts.idleTimeoutMs=300000] 0 = 不回收
 * @returns {{render:Function, dispose:Function, describe:Function, isBrowserConnected:Function, cacheSize:Function}}
 */
export function createPageImageRenderer(opts = {}) {
  const pdfjs = resolvePdfjsAssets(opts.pdfjsDir);
  const { chromium, resolvedFrom } = loadPlaywright(opts.playwrightModule);
  const renderTimeoutMs = Math.max(1000, Math.round(Number(opts.renderTimeoutMs) || 8000));
  const idleTimeoutMs = Math.max(0, Math.round(Number(opts.idleTimeoutMs ?? 300000)));

  let executablePath;
  try {
    executablePath = chromium.executablePath();
  } catch (error) {
    throw Object.assign(new Error(`lit_page_image 启动失败：找不到 Chromium（${error?.message ?? error}）`), {
      code: 'E_RENDERER_UNAVAILABLE',
    });
  }
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw Object.assign(
      new Error(`lit_page_image 启动失败：Chromium 可执行文件不存在（期望 ${executablePath || '（空路径）'}）。`),
      { code: 'E_RENDERER_UNAVAILABLE' },
    );
  }

  let browser;
  let browserContext;
  let launching;
  let page;
  let diag = emptyDiag();
  let idleTimer;
  let queue = Promise.resolve();
  const docs = new Map();
  const cache = new Map();

  const serialize = (work) => {
    const run = queue.then(work, work);
    queue = run.then(() => {}, () => {});
    return run;
  };

  const touchIdle = () => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void serialize(async () => {
        if (!browser) return;
        await dispose();
      }).catch(() => {});
    }, idleTimeoutMs);
    idleTimer.unref?.(); // 别因为这个定时器把 Express 进程钉住
  };

  async function dispose() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    const p = page;
    page = undefined;
    if (p) { try { await p.close(); } catch { /* 已关闭 */ } }
    const b = browser;
    browser = undefined;
    browserContext = undefined;
    docs.clear();
    if (b) { try { await b.close(); } catch { /* 已关闭 */ } }
  }

  async function ensureBrowser() {
    if (browser?.isConnected()) return browser;
    if (launching) return launching;
    launching = (async () => {
      try {
        const b = await chromium.launch();
        browser = b;
        b.on('disconnected', () => {
          if (browser === b) { browser = undefined; browserContext = undefined; page = undefined; docs.clear(); }
        });
        const ctx = await b.newContext();
        // 唯一网络闸门：**只在 context 创建时注册一次**
        await ctx.route('**/*', (route) => { void handleRoute(route); });
        browserContext = ctx;
        return b;
      } catch (error) {
        throw new RenderFailure(
          `lit_page_image: cannot start the headless browser（可执行文件 ${executablePath}）。`
          + '受限 shell 下常见原因是 TEMP 不可写（EPERM: mkdtemp）——把 TEMP/TMP 指到可写目录再启动服务。'
          + `（根因：${error?.message ?? error}）`,
          { cause: error },
        );
      } finally {
        launching = undefined;
      }
    })();
    return launching;
  }

  async function handleRoute(route) {
    const url = route.request().url();
    try {
      if (url.startsWith('data:') || url.startsWith('blob:')) { await route.continue(); return; }
      // ① 出网闸门：非假 origin 一律 abort
      if (!url.startsWith(`${ORIGIN}/`) && url !== ORIGIN) { diag.blocked.push(url); await route.abort(); return; }
      const { pathname } = new URL(url);
      if (pathname === '/' || pathname === '/index.html') {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: RENDERER_HTML });
        return;
      }
      if (pathname === '/doc.pdf') {
        const docKey = new URL(url).searchParams.get('doc') ?? '';
        const pdfPath = /^[0-9a-f]{16}$/u.test(docKey) ? docs.get(docKey) : undefined;
        if (pdfPath === undefined) {
          await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'unknown document' });
          return;
        }
        try {
          const bytes = await fsp.readFile(pdfPath);
          await route.fulfill({ status: 200, contentType: 'application/pdf', body: bytes });
        } catch {
          await route.fulfill({ status: 500, contentType: 'text/plain; charset=utf-8', body: 'document unreadable' });
        }
        return;
      }
      if (pathname.startsWith('/vendor/')) {
        const parts = pathname.slice('/vendor/'.length).split('/');
        const [dir, file] = parts.length === 2 ? parts : ['', ''];
        const allowed =
          ASSET_DIRS.includes(dir) && ASSET_EXT.test(file) && !file.includes('..') && (dir !== 'build' || BUILD_ENTRY.test(file));
        // build 段映射到入口目录，其余段映射到包根下同名目录（build 里的同名目录是空的）
        const base = dir === 'build' ? pdfjs.buildDir : path.join(pdfjs.root, dir);
        const target = allowed ? path.join(base, file) : undefined;
        if (target === undefined || !fs.existsSync(target)) {
          await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found' });
          return;
        }
        const bytes = await fsp.readFile(target);
        await route.fulfill({
          status: 200,
          contentType: file.endsWith('.mjs') || file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream',
          body: bytes,
        });
        return;
      }
      // ③ origin 内未知路径：404（不是 abort）——让 pdf.js 缺资源时报错可读
      await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found' });
    } catch {
      try { await route.abort(); } catch { /* 已处理 */ }
    }
  }

  async function ensurePage() {
    if (page && !page.isClosed()) return page;
    await ensureBrowser();
    if (!browserContext) throw new RenderFailure('lit_page_image: 浏览器上下文不可用；下次调用会重建。');
    const p = await browserContext.newPage();
    diag = emptyDiag();
    p.on('pageerror', (e) => diag.pageErrors.push(e?.message ?? String(e)));
    p.on('console', (m) => { if (m.type() === 'error') diag.consoleErrors.push(m.text()); });
    p.on('requestfailed', (r) => diag.requestFailures.push(`${r.url()} (${r.failure()?.errorText ?? 'failed'})`));
    p.on('crash', () => { diag.crashes.push(new Date().toISOString()); if (page === p) page = undefined; });
    p.setDefaultTimeout(renderTimeoutMs);
    try {
      await p.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(
        () => globalThis.__litPageImageReady === true || typeof globalThis.__litPageImageInitError === 'string',
        undefined,
        { timeout: renderTimeoutMs },
      );
      const initError = await p.evaluate(() => globalThis.__litPageImageInitError ?? null);
      if (initError !== null) {
        throw new RenderFailure(`lit_page_image 的 pdf.js 初始化失败：${initError}${diagTail()}`);
      }
    } catch (error) {
      try { await p.close(); } catch { /* ignore */ }
      if (error instanceof RenderFailure) throw error;
      throw new RenderFailure(`lit_page_image 的浏览器引导页未能就绪（pdf.js 无法在页面内加载）：${diagTail()}`, { cause: error });
    }
    page = p;
    return p;
  }

  const diagTail = () => {
    const bits = [];
    if (diag.pageErrors.length) bits.push(`pageerror=${diag.pageErrors.slice(0, 2).join(' | ')}`);
    if (diag.consoleErrors.length) bits.push(`console=${diag.consoleErrors.slice(0, 2).join(' | ')}`);
    if (diag.requestFailures.length) bits.push(`requestfailed=${diag.requestFailures.slice(0, 2).join(' | ')}`);
    if (diag.blocked.length) bits.push(`blocked=${diag.blocked.slice(0, 2).join(' | ')}`);
    if (diag.crashes.length) bits.push(`crashes=${diag.crashes.length}`);
    return bits.length ? `（诊断：${bits.join('；')}）` : '';
  };

  async function renderOnPage(job) {
    const p = await ensurePage();
    const pageCount = Number(
      await p.evaluate((args) => globalThis.__litPageImageOpen(args.docKey), { docKey: job.docKey }),
    );
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new RenderFailure(`无法读取 PDF 页数（浏览器返回 ${String(pageCount)}）：文件可能已损坏。${diagTail()}`);
    }
    if (job.pageNo > pageCount) {
      throw new RenderFailure(
        `lit_page_image: pageNo ${job.pageNo} is out of range (1..${pageCount})`
        + `（pageNo=${job.pageNo} 越界：该文献共 ${pageCount} 页，合法范围 1–${pageCount}）。`,
      );
    }
    const vp1 = await p.evaluate(
      (args) => globalThis.__litPageImageSize(args.docKey, args.pageNo),
      { docKey: job.docKey, pageNo: job.pageNo },
    );
    // 几何只在这里算一次（render-geometry.js 是唯一实现；页面内只做算术，不重新决策）
    const plan = planRender(vp1, job.region, job.maxEdge, job.maxPixels);
    const shot = await p.evaluate(
      (args) => globalThis.__litPageImageRender(
        args.docKey, args.pageNo, args.plan, args.mediaType, args.quality,
      ),
      {
        docKey: job.docKey,
        pageNo: job.pageNo,
        plan,
        mediaType: job.mediaType,
        quality: job.format === 'jpeg' ? job.jpegQuality : null,
      },
    );
    const bytes = decodeDataUrl(shot.dataUrl);
    assertImageSignature(bytes, job.mediaType);
    if (bytes.length === 0) throw new RenderFailure(`渲染产出的图像字节为空（0 字节）。${diagTail()}`);
    return {
      bytes,
      mediaType: job.mediaType,
      width: shot.width,
      height: shot.height,
      scale: plan.scale,
      rect: [plan.region.x, plan.region.y, plan.region.x + plan.region.w, plan.region.y + plan.region.h],
      page: { widthPt: vp1.width, heightPt: vp1.height, pageCount },
    };
  }

  function withDeadline(work, ms) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new RenderFailure(`lit_page_image 渲染超时（${ms}ms）；可改用更小的 maxEdge 重试。`)), ms);
    });
    return Promise.race([work, guard]).finally(() => clearTimeout(timer));
  }

  async function render(request) {
    const pdfPath = request?.pdfPath;
    if (typeof pdfPath !== 'string' || pdfPath.length === 0) {
      throw new RenderFailure('lit_page_image.render: pdfPath 必须是非空绝对路径');
    }
    if (!Number.isInteger(request.pageNo) || request.pageNo < 1) {
      throw new RenderFailure(`lit_page_image.render: pageNo 必须是 ≥1 的整数（收到 ${String(request.pageNo)}）`);
    }
    const region = request.region ?? 'full';
    regionRect(region); // 非法区域在入队前就抛，不占浏览器
    const maxEdge = Number(request.maxEdge) || 1500;
    const maxPixels = Number(request.maxPixels) || 1_650_000;
    const format = request.format === 'png' ? 'png' : 'jpeg';
    const mediaType = format === 'png' ? 'image/png' : 'image/jpeg';
    const jpegQuality = Number(request.jpegQuality) || 0.85;

    return serialize(async () => {
      await ensureBrowser();
      const info = await fsp.stat(pdfPath);
      const docKey = buildDocKey(pdfPath, info);
      const cacheKey = buildCacheKey({
        pdfPath, mtimeMs: info.mtimeMs, size: info.size, pageNo: request.pageNo,
        region, maxEdge, maxPixels, format, jpegQuality, pdfjsVersion: pdfjs.version,
      });
      const cached = cache.get(cacheKey);
      if (cached) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        touchIdle();
        return { ...cached, bytes: Uint8Array.from(cached.bytes), cacheKey };
      }
      // docKey 登记表（有界）
      if (docs.size >= DOC_REGISTRY_CAPACITY) docs.delete(docs.keys().next().value);
      docs.set(docKey, pdfPath);

      const work = renderOnPage({ docKey, pageNo: request.pageNo, region, maxEdge, maxPixels, mediaType, format, jpegQuality });
      void work.catch(() => {});
      let rendered;
      try {
        rendered = await withDeadline(work, renderTimeoutMs);
      } catch (error) {
        const p = page;
        page = undefined;
        if (p) { try { await p.close(); } catch { /* ignore */ } }
        throw error;
      }
      const entry = {
        bytes: Buffer.from(rendered.bytes),
        mediaType: rendered.mediaType,
        width: rendered.width,
        height: rendered.height,
        scale: rendered.scale,
        rect: rendered.rect,
        page: rendered.page,
      };
      cache.set(cacheKey, entry);
      while (cache.size > CACHE_CAPACITY) cache.delete(cache.keys().next().value);
      touchIdle();
      return { ...entry, bytes: Uint8Array.from(entry.bytes), cacheKey };
    });
  }

  return {
    render,
    dispose,
    isBrowserConnected: () => browser?.isConnected() === true,
    cacheSize: () => cache.size,
    describe: () => ({
      available: true,
      encoderVersion: ENCODER_VERSION,
      playwrightPath: resolvedFrom,
      chromiumExecutable: executablePath,
      pdfjsDir: pdfjs.root,
      pdfjsBuildDir: pdfjs.buildDir,
      pdfjsVersion: pdfjs.version,
      pdfjsSource: pdfjs.source,
      assetCounts: pdfjs.assets.counts,
      assetsLine: pdfjs.assetsLine,
      renderTimeoutMs,
      idleTimeoutMs,
    }),
  };
}

function emptyDiag() {
  return { pageErrors: [], consoleErrors: [], requestFailures: [], blocked: [], crashes: [] };
}

// ---------------------------------------------------------------- 进程内单例

let shared;
let sharedError;

/**
 * 取进程内共享渲染器（懒创建；创建失败会记住错误，不反复重试拖慢每个请求）。
 * @param {Object} [opts] 与 {@link createPageImageRenderer} 相同
 * @returns {{renderer:Object|null, error:Error|null, describe:Object|null}}
 */
export function getSharedRenderer(opts = {}) {
  if (shared) return { renderer: shared, error: null, describe: shared.describe() };
  if (sharedError) return { renderer: null, error: sharedError, describe: null };
  try {
    shared = createPageImageRenderer(opts);
    return { renderer: shared, error: null, describe: shared.describe() };
  } catch (error) {
    sharedError = error;
    return { renderer: null, error, describe: null };
  }
}

/** 关掉共享渲染器（进程退出/测试收尾用）。幂等。 */
export async function disposeSharedRenderer() {
  if (!shared) return;
  const r = shared;
  shared = undefined;
  await r.dispose();
}
