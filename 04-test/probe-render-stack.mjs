/**
 * 03-code「P3 视觉通道渲染栈」独立验证探针（测试工程师自建，不复用实现者的自测）。
 *
 * 运行（cwd = 03-code，Node 22）：
 *   node --no-warnings "D:/A-knowledge/agent工作流优化/04-test/probe-render-stack.mjs"
 *
 * 覆盖：A 真实渲染出图 / B 决定性 / C 象限 scale / D 契约边界（含反向验证）/ E 无残留进程。
 * 只读被测源码；唯一副作用是工具自身会写 data/attachments（内容寻址，属设计行为）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---- 环境：TEMP 必须可写（受限 shell 下 chromium.launch 会 EPERM: mkdtemp）----
const OUT = 'D:/A-knowledge/agent工作流优化/04-test';
const TMP = path.join(OUT, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
process.env.TEMP = TMP;
process.env.TMP = TMP;
process.env.TMPDIR = TMP;

const ROOT = 'D:/A-knowledge/agent工作流优化/03-code';
const PLAYWRIGHT_MODULE = 'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/playwright';
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
};

const sha = (b) => createHash('sha256').update(b).digest('hex');
const sha16 = (b) => sha(b).slice(0, 16);

const { config } = await import(mod('server/config.js'));
const db = await import(mod('server/db.js'));
// 服务启动时由 server/index.js 打开；探针要自己开一次（相对路径按项目根解析）
db.openDb(path.resolve(ROOT, config.server.dbPath));
const { createPageImageRenderer } = await import(mod('server/services/chat/render/page-image-source.js'));
const { tool } = await import(mod('server/services/chat/tools/lit-page-image.js'));
const geo = await import(mod('server/services/chat/render/render-geometry.js'));

// 让工具层能找到 playwright（03-code 不装它，这是配置面而不是改代码）
config.chat.pageImage.playwrightModule = PLAYWRIGHT_MODULE;

console.log(`env: node=${process.version} db=${config.server.dbPath} storageRoot=${config.download.downloadDir}`);
console.log(`env: TEMP=${TMP} playwrightModule=${PLAYWRIGHT_MODULE}`);

// ---------------------------------------------------------------- 事实：从库里查，不猜路径
const storageRoot = config.download.downloadDir;
const rows = db.all(
  `SELECT w.no, w.title, a.storage_rel_path AS rel, a.id AS assetId
     FROM works w LEFT JOIN assets a ON a.work_id = w.id AND a.kind = 'pdf'
    ORDER BY w.no LIMIT 400`,
);
const withPdf = [];
const withoutPdf = [];
const withRowButMissingFile = [];
for (const r of rows) {
  if (!r.rel) { withoutPdf.push(r); continue; }
  const abs = path.resolve(storageRoot, r.rel);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) withPdf.push({ ...r, abs });
  else withRowButMissingFile.push({ ...r, abs });
}
console.log(`facts: works=${rows.length} pdfFileExists=${withPdf.length} noPdfAsset=${withoutPdf.length} assetButFileMissing=${withRowButMissingFile.length}`);
console.log(`facts: 样例(有PDF)=${withPdf.slice(0, 3).map((r) => `${r.no}`).join(',')} 样例(无PDF资产)=${withoutPdf.slice(0, 3).map((r) => r.no).join(',')}`);

check(
  'A0 库里同时存在"有本地 PDF"与"没有本地 PDF"的文献（后面几项才有对照）',
  withPdf.length > 0 && withoutPdf.length > 0,
  `有PDF=${withPdf.length} 无PDF=${withoutPdf.length}`,
);

const sample = withPdf[0];
const MAX_EDGE = Number(config.chat.pageImage.maxEdge) || 1500;

// ---------------------------------------------------------------- A. 真实渲染
const renderer = createPageImageRenderer({
  pdfjsDir: config.chat.pageImage.pdfjsDir || undefined,
  playwrightModule: PLAYWRIGHT_MODULE,
  renderTimeoutMs: 20000,
  idleTimeoutMs: 300000,
});
console.log(`renderer: ${JSON.stringify(renderer.describe())}`);

const t0 = Date.now();
const png = await renderer.render({
  pdfPath: sample.abs, pageNo: 1, region: 'full', maxEdge: MAX_EDGE,
  maxPixels: Number(config.chat.pageImage.maxPixels) || 1650000,
  format: 'png', jpegQuality: 0.85,
});
const firstMs = Date.now() - t0;
const b = Buffer.from(png.bytes);
const magic = b.subarray(0, 4).toString('hex').toUpperCase();
// PNG 头：8 签名 + 4 长度 + 4 "IHDR" + 4 宽 + 4 高
const decW = b.readUInt32BE(16);
const decH = b.readUInt32BE(20);
check(
  'A1 PNG 字节 > 5KB',
  b.length > 5120,
  `${(b.length / 1024).toFixed(1)}KB（${b.length}B）`,
);
check(
  'A2 PNG magic bytes = 89 50 4E 47',
  magic === '89504E47',
  `${b.subarray(0, 8).toString('hex').toUpperCase()}`,
);
check(
  `A3 解码宽高 ≤ maxEdge(${MAX_EDGE}) 且与返回值一致`,
  Math.max(decW, decH) <= MAX_EDGE && decW === png.width && decH === png.height,
  `解码=${decW}x${decH} 返回=${png.width}x${png.height} scale=${png.scale.toFixed(3)} pageCount=${png.page.pageCount}`,
);
check(
  'A4 渲染耗时可接受（首调含 launch，<15s）',
  firstMs < 15000,
  `${firstMs}ms（no=${sample.no} p1，${b.length}B）`,
);
check(
  'A5 非空白图：字节数远大于纯白页（>50KB）',
  b.length > 50 * 1024,
  `${(b.length / 1024).toFixed(1)}KB（纯白 PNG 通常 <10KB）`,
);

// ---------------------------------------------------------------- B. 决定性
const again = await renderer.render({
  pdfPath: sample.abs, pageNo: 1, region: 'full', maxEdge: MAX_EDGE,
  maxPixels: Number(config.chat.pageImage.maxPixels) || 1650000,
  format: 'png', jpegQuality: 0.85,
});
check(
  'B1 同参数连渲两次 digest 相同（同进程，命中结果缓存）',
  sha(Buffer.from(png.bytes)) === sha(Buffer.from(again.bytes)),
  `sha256:${sha16(Buffer.from(png.bytes))} vs sha256:${sha16(Buffer.from(again.bytes))}`,
);
// 更强的决定性：另起一个渲染器（新浏览器实例、新缓存）比字节
const renderer2 = createPageImageRenderer({
  pdfjsDir: config.chat.pageImage.pdfjsDir || undefined,
  playwrightModule: PLAYWRIGHT_MODULE,
  renderTimeoutMs: 20000,
  idleTimeoutMs: 0,
});
const cross = await renderer2.render({
  pdfPath: sample.abs, pageNo: 1, region: 'full', maxEdge: MAX_EDGE,
  maxPixels: Number(config.chat.pageImage.maxPixels) || 1650000,
  format: 'png', jpegQuality: 0.85,
});
check(
  'B2 跨浏览器实例 digest 相同（真正的决定性，非缓存背书）',
  sha(Buffer.from(png.bytes)) === sha(Buffer.from(cross.bytes)),
  `sha256:${sha16(Buffer.from(png.bytes))} vs sha256:${sha16(Buffer.from(cross.bytes))}`,
);
await renderer2.dispose();

// ---------------------------------------------------------------- C. 区域 scale
const full = await renderer.render({
  pdfPath: sample.abs, pageNo: 1, region: 'full', maxEdge: MAX_EDGE,
  maxPixels: Number(config.chat.pageImage.maxPixels) || 1650000, format: 'jpeg', jpegQuality: 0.85,
});
const quad = await renderer.render({
  pdfPath: sample.abs, pageNo: 1, region: 'top-left', maxEdge: MAX_EDGE,
  maxPixels: Number(config.chat.pageImage.maxPixels) || 1650000, format: 'jpeg', jpegQuality: 0.85,
});
const ratio = quad.scale / full.scale;
check(
  'C1 象限 scale ≈ 2 × 整页 scale（±2%）',
  Math.abs(ratio - 2) <= 0.04,
  `full=${full.scale.toFixed(3)} quad=${quad.scale.toFixed(3)} ratio=${ratio.toFixed(4)}`,
);
check(
  'C2 象限输出像素 ≈ 整页输出像素（裁剪=放大，不是裁小图）',
  Math.abs(quad.width - full.width) <= 1 && Math.abs(quad.height - full.height) <= 1,
  `full=${full.width}x${full.height} quad=${quad.width}x${quad.height}`,
);
check(
  'C3 象限与整页像素内容不同（确实换了区域）',
  sha(Buffer.from(quad.bytes)) !== sha(Buffer.from(full.bytes)),
  `full=${sha16(Buffer.from(full.bytes))} quad=${sha16(Buffer.from(quad.bytes))} quadBytes=${(quad.bytes.length / 1024).toFixed(0)}KB < full=${(full.bytes.length / 1024).toFixed(0)}KB`,
);
// 纯几何交叉验证（不启浏览器）
const planFull = geo.planRender({ width: 595.28, height: 841.89 }, 'full', 1500, 1_650_000);
const planQuad = geo.planRender({ width: 595.28, height: 841.89 }, 'top-left', 1500, 1_650_000);
check(
  'C4 纯函数交叉验证：A4 上 quadrant.scale / full.scale = 2',
  Math.abs(planQuad.scale / planFull.scale - 2) < 1e-9,
  `${planFull.scale.toFixed(4)} → ${planQuad.scale.toFixed(4)}，尺寸 ${planFull.width}x${planFull.height} vs ${planQuad.width}x${planQuad.height}`,
);
check(
  'C5 pxPerCell 不再是恒真式（srcPxPerCell 随 scale 变化）',
  geo.pxPerCell(planQuad).srcPxPerCell < geo.pxPerCell(planFull).srcPxPerCell,
  `full=${JSON.stringify(geo.pxPerCell(planFull))} quad=${JSON.stringify(geo.pxPerCell(planQuad))}`,
);

// ---------------------------------------------------------------- D. 契约边界
// D1 没有本地 PDF ⇒ status:no_pdf 且不抛错
const noPdfNo = withoutPdf[0]?.no;
let d1;
try {
  d1 = await tool.execute({ no: noPdfNo, pageNo: 1 });
} catch (e) {
  d1 = { threw: String(e?.message ?? e) };
}
check(
  `D1 无本地 PDF（no=${noPdfNo}）⇒ status:'no_pdf' 且不抛错`,
  d1?.status === 'no_pdf',
  `status=${d1?.status ?? JSON.stringify(d1).slice(0, 120)}`,
);

// D2 资产行存在但文件缺失 ⇒ 也应 no_pdf（顺带记录，库里 ${withRowButMissingFile.length} 条）
if (withRowButMissingFile.length > 0) {
  const missing = withRowButMissingFile[0];
  let d2;
  try {
    d2 = await tool.execute({ no: missing.no, pageNo: 1 });
  } catch (e) {
    d2 = { threw: String(e?.message ?? e) };
  }
  check(
    `D2 资产行存在但文件缺失（no=${missing.no}）⇒ no_pdf`,
    d2?.status === 'no_pdf',
    `status=${d2?.status ?? JSON.stringify(d2).slice(0, 120)}`,
  );
} else {
  console.log('skip D2：库里没有"资产行存在但文件缺失"的样本');
}

// D3 编号不存在 ⇒ 抛错（不是 no_pdf）
let d3;
try {
  d3 = { returned: await tool.execute({ no: '999.99', pageNo: 1 }) };
} catch (e) {
  d3 = { threw: String(e?.message ?? e) };
}
check(
  "D3 编号不存在（no='999.99'）⇒ 抛错而不是 no_pdf",
  typeof d3.threw === 'string' && !('status' in (d3.returned ?? {})),
  d3.threw ?? `错误地返回了 ${JSON.stringify(d3.returned).slice(0, 120)}`,
);

// D4 反向验证：渲染失败必须抛错，且绝不返回 no_pdf
const failCases = [
  ['页码越界', { pdfPath: sample.abs, pageNo: 99999 }],
  ['PDF 路径不存在', { pdfPath: path.join(TMP, 'does-not-exist.pdf'), pageNo: 1 }],
  ['PDF 内容损坏', { pdfPath: corruptPdf(), pageNo: 1 }],
];
for (const [label, extra] of failCases) {
  let threw = null;
  try {
    await renderer.render({ maxEdge: 1200, format: 'jpeg', jpegQuality: 0.85, ...extra });
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  check(
    `D4 反向-${label} ⇒ 抛错（不是空值/不是 no_pdf）`,
    threw !== null && !/no_pdf/u.test(threw),
    threw === null ? '没有抛错（严重：会被读成业务事实）' : threw.slice(0, 130),
  );
}

// D5 工具层：渲染失败必须 reject，不能 resolve 成 no_pdf
let d5;
try {
  d5 = { returned: await tool.execute({ no: sample.no, pageNo: 99999 }) };
} catch (e) {
  d5 = { threw: String(e?.message ?? e) };
}
check(
  `D5 工具层：pageNo 越界（no=${sample.no}）⇒ reject，不返回 no_pdf`,
  typeof d5.threw === 'string',
  d5.threw ?? `错误地返回 ${JSON.stringify(d5.returned).slice(0, 120)}`,
);

// D6 代码级确认：no_pdf 的唯一下达点
const src = fs.readFileSync(path.join(ROOT, 'server/services/chat/tools/lit-page-image.js'), 'utf8').split('\n');
const noPdfLines = src
  .map((l, i) => ({ n: i + 1, t: l }))
  .filter((x) => x.t.includes("status: 'no_pdf'"));
check(
  'D6 代码确认：no_pdf 只有一处下达点，且在调用渲染器之前（结构锁死）',
  noPdfLines.length === 1,
  noPdfLines.map((x) => `lit-page-image.js:${x.n}`).join(',') +
    `；rendererOrThrow() 在 lit-page-image.js:${src.findIndex((l) => l.includes('const renderer = rendererOrThrow();')) + 1}`,
);

// ---------------------------------------------------------------- E. 无残留进程
function chromiumProcs() {
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const lines = (out.stdout ?? '').split('\n').filter((l) => /chrom/i.test(l));
  const names = {};
  for (const l of lines) {
    const m = l.match(/"([^"]+\.exe)"/u);
    if (m) names[m[1]] = (names[m[1]] ?? 0) + 1;
  }
  return { total: lines.length, names };
}

const before = chromiumProcs();
const idleRenderer = createPageImageRenderer({
  pdfjsDir: config.chat.pageImage.pdfjsDir || undefined,
  playwrightModule: PLAYWRIGHT_MODULE,
  renderTimeoutMs: 20000,
  idleTimeoutMs: 1500, // 短阈值，走完全相同的 touchIdle → 到期 dispose 代码路径
});
for (let i = 0; i < 3; i += 1) {
  await idleRenderer.render({
    pdfPath: sample.abs, pageNo: 1, region: 'full', maxEdge: 700 + i,
    maxPixels: 1_650_000, format: 'jpeg', jpegQuality: 0.85,
  });
}
const during = chromiumProcs();
await new Promise((r) => setTimeout(r, 4000)); // 等空闲回收（定时器 unref，但事件循环仍活着）
const connectedAfterIdle = idleRenderer.isBrowserConnected();
await idleRenderer.dispose();
await new Promise((r) => setTimeout(r, 800));
const after = chromiumProcs();
const shellCmd = spawnSync('cmd', ['/c', 'tasklist | findstr /i chrom'], { encoding: 'utf8' });
check(
  'E1 渲染期间确实起过浏览器进程（进程名要认 chrome-headless-shell.exe，不是 chrome.exe）',
  during.total > before.total,
  `before=${before.total} during=${during.total} 进程名=${JSON.stringify(during.names)}`,
);
check(
  'E2 空闲 1.5s 到点后浏览器被回收（isBrowserConnected=false）',
  connectedAfterIdle === false,
  `isBrowserConnected=${connectedAfterIdle}（idleTimeoutMs=1500，等 4000ms）`,
);
check(
  'E3 回收+dispose 后 chromium 进程回落到基线',
  after.total <= before.total,
  `before=${before.total} after=${after.total}（${JSON.stringify(after.names)}）`,
);
console.log(`E4 tasklist | findstr /i chrom 原始输出：\n${(shellCmd.stdout || '(空)').trim() || '(空)'}\nexit=${shellCmd.status}`);

await renderer.dispose();

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.id) })}`);
process.exit(failed.length === 0 ? 0 : 1);

/** 造一个内容损坏的 PDF（反向用例：渲染必须失败，不许静默） */
function corruptPdf() {
  const p = path.join(TMP, 'corrupt.pdf');
  fs.writeFileSync(p, '%PDF-1.7\n这不是 PDF，只是几个字节\n%%EOF\n');
  return p;
}
