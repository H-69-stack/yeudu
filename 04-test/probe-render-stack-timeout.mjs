/**
 * 超时分支的负载注入：单页渲染在本机只要 30–900ms，低于 renderTimeoutMs 的
 * 实现下限 1000ms ⇒ 用**并发负载**把单次渲染拖过 1000ms（不改代码、不 hack，只是制造 CPU 争用）。
 *
 * 运行：node --no-warnings "D:/A-knowledge/agent工作流优化/04-test/probe-render-stack-timeout.mjs"
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = 'D:/A-knowledge/agent工作流优化/04-test';
const TMP = path.join(OUT, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
process.env.TEMP = TMP;
process.env.TMP = TMP;
process.env.TMPDIR = TMP;

const ROOT = 'D:/A-knowledge/agent工作流优化/03-code';
const PLAYWRIGHT_MODULE = 'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/playwright';
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const { config } = await import(mod('server/config.js'));
const db = await import(mod('server/db.js'));
db.openDb(path.resolve(ROOT, config.server.dbPath));
const { createPageImageRenderer } = await import(mod('server/services/chat/render/page-image-source.js'));

const rows = db.all(`SELECT w.no, a.storage_rel_path AS rel FROM works w JOIN assets a ON a.work_id=w.id AND a.kind='pdf' ORDER BY w.no`);
const samples = rows.map((r) => ({ ...r, abs: path.resolve(config.download.downloadDir, r.rel) })).filter((r) => fs.existsSync(r.abs));
const heavy = samples.at(-1);

// 先测一遍"空载"单页耗时，作为对照
const warm = createPageImageRenderer({ playwrightModule: PLAYWRIGHT_MODULE, renderTimeoutMs: 20000, idleTimeoutMs: 0 });
const t0 = Date.now();
const base = await warm.render({ pdfPath: heavy.abs, pageNo: 1, region: 'full', maxEdge: 2048, maxPixels: 1e12, format: 'png' });
console.log(`空载：${Date.now() - t0}ms ${base.width}x${base.height} ${base.bytes.length}B（no=${heavy.no}）`);
await warm.dispose();

// 并发 10 个渲染器（各自独立浏览器），截止时间 1000ms
const N = 10;
const renderers = Array.from({ length: N }, () =>
  createPageImageRenderer({ playwrightModule: PLAYWRIGHT_MODULE, renderTimeoutMs: 1000, idleTimeoutMs: 0 }),
);
const started = Date.now();
const outcomes = await Promise.all(
  renderers.map(async (r, i) => {
    const s = Date.now();
    try {
      const out = await r.render({ pdfPath: heavy.abs, pageNo: 1 + (i % 3), region: 'full', maxEdge: 2048, maxPixels: 1e12, format: 'png' });
      return { i, ok: true, ms: Date.now() - s, size: `${out.width}x${out.height}`, bytes: out.bytes.length };
    } catch (e) {
      return { i, ok: false, ms: Date.now() - s, err: String(e?.message ?? e).slice(0, 120) };
    }
  }),
);
const wall = Date.now() - started;
for (const o of outcomes) {
  console.log(`  #${o.i} ${o.ms}ms ${o.ok ? `ok ${o.size} ${o.bytes}B` : `throw ${o.err}`}`);
}
const timeouts = outcomes.filter((o) => !o.ok && /超时/u.test(o.err ?? ''));
const throws = outcomes.filter((o) => !o.ok);
console.log(`\n并发 ${N} 路（截止 1000ms）：抛出 ${throws.length} 次，其中命中超时分支 ${timeouts.length} 次，墙钟 ${wall}ms`);
console.log(
  timeouts.length > 0
    ? '判定：PASS —— 超时分支确认抛错（RenderFailure），不是空图、不是 no_pdf'
    : `判定：未命中超时分支（最慢 ${Math.max(...outcomes.map((o) => o.ms))}ms < 1000ms）`,
);
for (const r of renderers) await r.dispose().catch(() => {});
process.exit(timeouts.length > 0 ? 0 : 2);
