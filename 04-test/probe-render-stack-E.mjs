/**
 * E 项单独复跑：基线必须为 0 才算证明"无残留"。
 * 首次跑 E 时基线上有 6 个 chrome-headless-shell（来自本会话更早的其它进程），
 * 那些进程后来随其父进程退出了；现在基线为 0 ⇒ 可以直接断言"渲染后回到 0"。
 *
 * 运行：node --no-warnings "D:/A-knowledge/agent工作流优化/04-test/probe-render-stack-E.mjs"（cwd=03-code）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

function chromiumProcs() {
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const lines = (out.stdout ?? '').split('\n').filter((l) => /chrom/i.test(l));
  return lines;
}
const names = (lines) => {
  const m = {};
  for (const l of lines) {
    const hit = l.match(/"([^"]+\.exe)"/u);
    if (hit) m[hit[1]] = (m[hit[1]] ?? 0) + 1;
  }
  return m;
};

const sample = db.get(
  `SELECT w.no, a.storage_rel_path AS rel FROM works w JOIN assets a ON a.work_id = w.id AND a.kind='pdf'
    ORDER BY w.no LIMIT 1`,
);
const pdfPath = path.resolve(config.download.downloadDir, sample.rel);

const before = chromiumProcs();
console.log(`E0 基线（渲染前）：count=${before.length} ${JSON.stringify(names(before))}`);
if (before.length > 0) console.log(before.join('\n'));

const r = createPageImageRenderer({
  pdfjsDir: undefined,
  playwrightModule: PLAYWRIGHT_MODULE,
  renderTimeoutMs: 20000,
  idleTimeoutMs: 1500,
});
for (let i = 0; i < 3; i += 1) {
  await r.render({ pdfPath, pageNo: 1, region: 'full', maxEdge: 700 + i, maxPixels: 1_650_000, format: 'jpeg', jpegQuality: 0.85 });
}
const during = chromiumProcs();
console.log(`E1 渲染 3 次后：count=${during.length} ${JSON.stringify(names(during))}`);

await new Promise((res) => setTimeout(res, 4000));
const connected = r.isBrowserConnected();
await r.dispose();
await new Promise((res) => setTimeout(res, 1500));
const after = chromiumProcs();
const raw = spawnSync('cmd', ['/c', 'tasklist | findstr /i chrom'], { encoding: 'utf8' });

console.log(`E2 空闲 1500ms 后 isBrowserConnected=${connected}（应为 false）`);
console.log(`E3 dispose 后：count=${after.length} ${JSON.stringify(names(after))}`);
console.log(`E4 \`tasklist | findstr /i chrom\` 原始输出（exit=${raw.status}）:\n${(raw.stdout || '').trim() || '(空)'}`);

const ok = before.length === 0 && during.length > 0 && connected === false && after.length === 0;
console.log(`\nE SUMMARY ${JSON.stringify({ baseline0: before.length === 0, launched: during.length, idleRecycled: connected === false, residualAfterDispose: after.length, ok })}`);
process.exit(ok ? 0 : 1);
