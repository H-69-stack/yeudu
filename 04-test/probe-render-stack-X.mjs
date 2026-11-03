/**
 * X 项：任务清单之外的对抗性补充（超时分支 / 未夹取的 maxEdge / 附件可取回 / 配额与注册门控）。
 * 运行：node --no-warnings "D:/A-knowledge/agent工作流优化/04-test/probe-render-stack-X.mjs"（cwd=03-code）
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

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
};

const { config } = await import(mod('server/config.js'));
const db = await import(mod('server/db.js'));
db.openDb(path.resolve(ROOT, config.server.dbPath));
const { createPageImageRenderer } = await import(mod('server/services/chat/render/page-image-source.js'));
const { tool } = await import(mod('server/services/chat/tools/lit-page-image.js'));
const { readAttachment } = await import(mod('server/services/chat/attachments.js'));
config.chat.pageImage.playwrightModule = PLAYWRIGHT_MODULE;

const rows = db.all(
  `SELECT w.no, a.storage_rel_path AS rel FROM works w JOIN assets a ON a.work_id=w.id AND a.kind='pdf' ORDER BY w.no`,
);
const samples = rows
  .map((r) => ({ ...r, abs: path.resolve(config.download.downloadDir, r.rel) }))
  .filter((r) => fs.existsSync(r.abs));

// ---- X1 超时分支：renderTimeoutMs 下限是 1000ms，用未夹取的超大 maxEdge 把渲染拖慢 ----
{
  const r = createPageImageRenderer({ playwrightModule: PLAYWRIGHT_MODULE, renderTimeoutMs: 1000, idleTimeoutMs: 0 });
  const heavy = samples.at(-1);
  let threw = null;
  const t0 = Date.now();
  try {
    // maxEdge 在 renderer 层未被夹取（工具层才 clampMaxEdge），20 万像素长边必然拖垮/超时
    await r.render({ pdfPath: heavy.abs, pageNo: 1, region: 'full', maxEdge: 200000, maxPixels: 1_650_000, format: 'png' });
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  const ms = Date.now() - t0;
  check(
    'X1 超时/超限 ⇒ 抛错（不返回空图、不静默）',
    threw !== null,
    threw === null ? `没有抛错（${ms}ms）` : `${ms}ms :: ${threw.slice(0, 120)}`,
  );
  check(
    'X1b 超时消息可识别（含"超时"字样）或为画布/资源类明确报错',
    threw !== null && /超时|超时|canvas|Invalid|allocation|Failed|failed|error/iu.test(threw),
    (threw ?? '').slice(0, 140),
  );
  check(
    'X1c 失败后下一次正常参数仍能渲染（错误没把渲染器带坏）',
    await r
      .render({ pdfPath: heavy.abs, pageNo: 1, region: 'full', maxEdge: 800, maxPixels: 1_650_000, format: 'jpeg' })
      .then((o) => o.bytes.length > 1024)
      .catch(() => false),
    `pageNo=1 maxEdge=800`,
  );
  await r.dispose();
}

// ---- X2 工具层的 maxEdge 确实被夹取到 [600,2048] ----
{
  const s = samples[0];
  const big = await tool.execute({ no: s.no, pageNo: 1, maxEdge: 99999, format: 'jpeg' });
  const small = await tool.execute({ no: s.no, pageNo: 1, maxEdge: 10, format: 'jpeg' });
  check(
    'X2 工具层 maxEdge 夹取：99999→≤2048、10→≥600',
    Math.max(big.image.width, big.image.height) <= 2048 && Math.max(small.image.width, small.image.height) >= 600,
    `big=${big.image.width}x${big.image.height}（scale=${big.image.scale}） small=${small.image.width}x${small.image.height}（scale=${small.image.scale}）`,
  );
}

// ---- X3 附件可按 id 取回且字节一致（内容寻址） ----
{
  const s = samples[0];
  const v = await tool.execute({ no: s.no, pageNo: 1, format: 'png' });
  const back = readAttachment(v.image.attachmentId);
  check(
    'X3 附件按 attachmentId 可取回（内容寻址，日志只存引用）',
    back !== null && back.bytes.length === v.image.bytes && back.mediaType === v.image.mediaType,
    `id=${v.image.attachmentId.slice(0, 20)}… bytes=${v.image.bytes} mediaType=${back?.mediaType}`,
  );
}

// ---- X4 两态契约的 ok 分支结构完整 ----
{
  const s = samples[0];
  const v = await tool.execute({ no: s.no, pageNo: 1, region: 'top-left' });
  const text = tool.render({ no: s.no, pageNo: 1, region: 'top-left' }, v);
  check(
    'X4 ok 分支字段齐全且文本 5 行前缀稳定',
    v.status === 'ok' && typeof v.image.attachmentId === 'string' && v.image.scale > 0
      && text.split('\n').length === 5 && /分辨率约提高 2 倍/u.test(text),
    `lines=${text.split('\n').length} scale=${v.image.scale} covers=${v.image.coversPageFraction} rect=${JSON.stringify(v.image.rect)}`,
  );
  const noPdfText = tool.render({}, { no: '9.9', pageNo: 1, status: 'no_pdf' });
  check(
    'X4b no_pdf 文本两句且指向 lit_read',
    noPdfText.split('\n').length === 2 && /lit_read/u.test(noPdfText),
    JSON.stringify(noPdfText),
  );
}

// ---- X5 配置默认值：enabled=false（视觉通道默认关闭） ----
{
  const raw = fs.readFileSync(path.join(ROOT, 'server/config.js'), 'utf8');
  check(
    'X5 配置默认 chat.pageImage.enabled=false（默认不暴露视觉通道）',
    /pageImage:\s*\{[\s\S]{0,120}enabled:\s*false/u.test(raw) && config.chat.pageImage.enabled === false,
    `config.chat.pageImage.enabled=${config.chat.pageImage.enabled}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\nX SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.id) })}`);
process.exit(failed.length === 0 ? 0 : 1);
