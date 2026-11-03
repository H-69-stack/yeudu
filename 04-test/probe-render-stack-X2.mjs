/**
 * X' 修订版：修正 X1 的无效注入（maxPixels 构造性封顶，maxEdge 大也没用）。
 * 真正能拖垮渲染的是**同时放大 maxPixels**，而 maxPixels 在 renderer 层同样不夹取。
 *
 * 目的：
 *   X1' 极端参数（maxPixels=1e12 + maxEdge=200000）⇒ 必须抛错或超时，不得返回空图；
 *   X2' 用大画布 + 短超时（1000ms 是实现下限）实测**超时分支**是否真的走抛错；
 *   X3' 修完 X4 的判定：ok 文本是 6 行（与 dsh 同构），只校验"确定性 + 关键句"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
};
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

const { config } = await import(mod('server/config.js'));
const db = await import(mod('server/db.js'));
db.openDb(path.resolve(ROOT, config.server.dbPath));
const { createPageImageRenderer } = await import(mod('server/services/chat/render/page-image-source.js'));
const { tool } = await import(mod('server/services/chat/tools/lit-page-image.js'));
config.chat.pageImage.playwrightModule = PLAYWRIGHT_MODULE;

const rows = db.all(`SELECT w.no, a.storage_rel_path AS rel FROM works w JOIN assets a ON a.work_id=w.id AND a.kind='pdf' ORDER BY w.no`);
const samples = rows.map((r) => ({ ...r, abs: path.resolve(config.download.downloadDir, r.rel) })).filter((r) => fs.existsSync(r.abs));
const heavy = samples.at(-1);

// ---- X1' 极端参数：两个上限同时放开 ----
{
  const r = createPageImageRenderer({ playwrightModule: PLAYWRIGHT_MODULE, renderTimeoutMs: 8000, idleTimeoutMs: 0 });
  let threw = null;
  const t0 = Date.now();
  try {
    const out = await r.render({ pdfPath: heavy.abs, pageNo: 1, region: 'full', maxEdge: 200000, maxPixels: 1e12, format: 'png' });
    threw = `NO_THROW ${out.width}x${out.height} ${out.bytes.length}B`;
  } catch (e) {
    threw = `THROW ${String(e?.message ?? e).slice(0, 160)}`;
  }
  const ms = Date.now() - t0;
  check(
    "X1' 极端参数（maxEdge=200000 且 maxPixels=1e12）⇒ 抛错，不返回空图/静默",
    threw.startsWith('THROW'),
    `${ms}ms :: ${threw}`,
  );
  // 关键：失败之后渲染器还能用（错误没污染状态）
  const recovered = await r
    .render({ pdfPath: heavy.abs, pageNo: 1, region: 'full', maxEdge: 800, maxPixels: 1_650_000, format: 'jpeg' })
    .then((o) => `${o.width}x${o.height} ${o.bytes.length}B sha=${sha(Buffer.from(o.bytes))}`)
    .catch((e) => `FAILED ${String(e?.message ?? e).slice(0, 80)}`);
  check("X1'b 极端参数失败后同实例仍能正常渲染", !recovered.startsWith('FAILED'), recovered);
  await r.dispose();
}

// ---- X2' 超时分支实测（renderTimeoutMs 下限 1000ms）----
{
  const r = createPageImageRenderer({ playwrightModule: PLAYWRIGHT_MODULE, renderTimeoutMs: 1000, idleTimeoutMs: 0 });
  // 冷启动 + 大画布 PNG 编码：尽量压过 1000ms
  let threw = null;
  const t0 = Date.now();
  try {
    const out = await r.render({ pdfPath: heavy.abs, pageNo: 1, region: 'full', maxEdge: 2048, maxPixels: 1e12, format: 'png' });
    threw = `NO_THROW ${out.width}x${out.height} ${out.bytes.length}B`;
  } catch (e) {
    threw = `THROW ${String(e?.message ?? e).slice(0, 160)}`;
  }
  const ms = Date.now() - t0;
  const isTimeout = typeof threw === 'string' && /超时/u.test(threw);
  check(
    "X2' 渲染超过 renderTimeoutMs=1000 时抛**超时**错（不是空图、不是 no_pdf）",
    threw.startsWith('THROW'),
    `${ms}ms :: ${threw}${isTimeout ? '' : '（本次未触发超时分支，仅证明"失败即抛错"）'}`,
  );
  console.log(`X2' 判定：${isTimeout ? '命中超时分支' : '未命中超时分支（渲染在 1000ms 内完成或先被浏览器画布限制拦下）'}`);
  await r.dispose();
}

// ---- X3' ok 文本：与 dsh 同构 6 行；只校验确定性与关键句 ----
{
  const s = samples[0];
  const v1 = await tool.execute({ no: s.no, pageNo: 1, region: 'top-left' });
  const t1 = tool.render({ no: s.no, pageNo: 1, region: 'top-left' }, v1);
  const v2 = await tool.execute({ no: s.no, pageNo: 1, region: 'top-left' });
  const t2 = tool.render({ no: s.no, pageNo: 1, region: 'top-left' }, v2);
  check(
    "X3' ok 文本确定性：同参数两次调用字节与文本完全一致",
    t1 === t2 && v1.image.attachmentId === v2.image.attachmentId,
    `lines=${t1.split('\n').length} attachmentId=${v1.image.attachmentId.slice(0, 18)}…（两次相同=${v1.image.attachmentId === v2.image.attachmentId}）`,
  );
  check(
    "X3'b ok 文本含能力边界与 region 提示（防把'能看图'误读成'能读字'）",
    /不是 OCR/u.test(t1) && /region=/u.test(t1) && /分辨率约提高 2 倍/u.test(t1),
    JSON.stringify(t1.split('\n')[0]),
  );
  // 与 dsh 版 renderText 对齐性：dsh 也是 6 个数组元素（第 4 行是缩进续行）
  const dshLines = 6;
  console.log(`X3' 备注：ok 文本 ${t1.split('\n').length} 行；lit-page-image.js:44 的注释写"五段固定文本"——实际是 5 段/6 行（与 dsh renderText 同构），注释措辞不准（建议级）。`);
  check("X3'c 文本行数与 dsh 版一致（6 行）", t1.split('\n').length === dshLines, `${t1.split('\n').length} 行`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nX' SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.id) })}`);
process.exit(failed.length === 0 ? 0 : 1);
