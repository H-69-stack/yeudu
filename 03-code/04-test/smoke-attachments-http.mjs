/**
 * 多模态附件 · HTTP 路由层真实冒烟（补 e2e-multimodal-upload.mjs 未覆盖的 Express 链路）。
 *
 * 背景：此前所有验证都直连函数（saveFile/buildUserContent/runToolLoop），从未真正经过
 *       security 中间件 → express.raw → uploadAttachment → res.json → GET 回源 → GET ?dl=1。
 *       本脚本启动真实 Express（临时端口 + 临时库副本，隔离真实数据），跑通整条 HTTP 链路。
 *
 * 断言：
 *   H1 multipart 上传 → 201 + attachmentId + kind/mediaType/宽高
 *   H2 裸体 image/png 上传 → 201（验证 security 白名单与 express.raw(type) 对齐，裸体图片不被误拒）
 *   H3 GET inline → 200 + Content-Type: image/png + 字节与上传一致
 *   H4 GET ?dl=1 → Content-Disposition: attachment; filename="<id>.png"
 *   H5 不支持的字节（application/pdf 头但内容非 PDF）→ 400 E_UNSUPPORTED
 *   H6 图片长边超 maxEdgePx（IHDR 声明 5000）→ 400 E_TOO_LARGE
 *   H7 纯图发送（content:'' + attachmentIds）→ SSE 200 且先收到 meta；落库 user 消息 content='' 且 attachments 含该 id
 *
 * 用法：node 04-test/smoke-attachments-http.mjs
 * 退出码：0 全过 / 1 有断言失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = path.join(HERE, '.tmp-smoke');
const TMP_DB = path.join(TMP, 'app-smoke.db');

// ── 工具：找空闲端口（config.server.port 必须与 listen 端口一致，才能过 Host 白名单） ──
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ── 工具：现造合法 PNG（与 e2e 同法，64×64 真彩） ──
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : (c >>> 1);
  }
  return (~c) >>> 0;
}
function makePng(width, height) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = 0x33; raw[o + 1] = 0x66; raw[o + 2] = 0x99;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
/** 只构造 PNG 头（IHDR 声明超大边长），用于触发 maxEdgePx 拒绝；readImageSize 只读 IHDR。 */
function makePngHeaderOnly(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const len = Buffer.alloc(4); len.writeUInt32BE(13, 0);
  const t = Buffer.from('IHDR', 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, ihdr])) >>> 0, 0);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, len, t, ihdr, crc]);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? `  → ${detail}` : ''}`);
}

async function main() {
  // 1) 准备隔离数据库副本（含 works 数据，能建会话）
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const srcDb = path.join(ROOT, 'data', 'app.db');
  if (!fs.existsSync(srcDb)) throw new Error(`找不到源库 ${srcDb}`);
  fs.copyFileSync(srcDb, TMP_DB);
  for (const ext of ['-wal', '-shm']) {
    const f = `${srcDb}${ext}`;
    if (fs.existsSync(f)) fs.copyFileSync(f, `${TMP_DB}${ext}`);
  }

  // 2) 在导入业务模块前设好 env（loadConfig 读 process.env）
  const port = await freePort();
  process.env.AGENTLIT_PORT = String(port);
  process.env.AGENTLIT_DB = TMP_DB;
  process.env.AGENTLIT_LOG_LEVEL = 'warn';

  const { config, loadConfig } = await import('../server/config.js');
  loadConfig();
  const { openDb, closeDb, all, get } = await import('../server/db.js');
  openDb(config.server.dbPath);
  const { migrate } = await import('../server/migrate.js');
  migrate();
  const { createApp } = await import('../server/app.js');

  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(config.server.port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const BASE = `http://127.0.0.1:${config.server.port}`;
  console.log(`[smoke] Express 已起在 ${BASE}（临时库 ${path.basename(TMP_DB)}）`);

  try {
    // 3) 建会话
    const work = get('SELECT no FROM works LIMIT 1');
    if (!work) throw new Error('works 表为空，无法建会话');
    const cr = await fetch(`${BASE}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workNo: work.no }),
    });
    const chat = await cr.json();
    if (!cr.ok) throw new Error(`建会话失败 ${cr.status}: ${JSON.stringify(chat)}`);
    const chatId = chat.chatId;
    console.log(`[smoke] chatId=${chatId} workNo=${work.no}`);

    // 4) H1 multipart 上传
    const png = makePng(64, 64);
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
    const r1 = await fetch(`${BASE}/api/chats/${chatId}/attachments`, { method: 'POST', body: fd });
    const j1 = await r1.json().catch(() => ({}));
    check('H1 multipart 上传 → 201', r1.status === 201 && j1.attachmentId, `status=${r1.status} id=${j1.attachmentId}`);
    check('H1 元数据正确', j1.kind === 'image' && j1.mediaType === 'image/png' && j1.width === 64 && j1.height === 64,
      `kind=${j1.kind} ${j1.width}x${j1.height} ${j1.mediaType}`);
    const attId = j1.attachmentId;

    // 5) H2 裸体 image/png（验证 security 白名单与 express.raw(type) 对齐）
    const r2 = await fetch(`${BASE}/api/chats/${chatId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    const j2 = await r2.json().catch(() => ({}));
    check('H2 裸体 image/png 上传 → 201', r2.status === 201 && j2.attachmentId, `status=${r2.status} id=${j2.attachmentId}`);

    // 6) H3 GET inline
    const r3 = await fetch(`${BASE}/api/chats/${chatId}/attachments/${encodeURIComponent(attId)}`);
    const b3 = Buffer.from(await r3.arrayBuffer());
    check('H3 inline 回源 → 200 + image/png + 字节一致',
      r3.status === 200 && (r3.headers.get('content-type') || '').startsWith('image/png') && b3.equals(png),
      `status=${r3.status} ct=${r3.headers.get('content-type')} bytes=${b3.length}`);

    // 7) H4 GET ?dl=1
    const r4 = await fetch(`${BASE}/api/chats/${chatId}/attachments/${encodeURIComponent(attId)}?dl=1`);
    const cd = r4.headers.get('content-disposition') || '';
    check('H4 下载 → Content-Disposition attachment + .png',
      r4.status === 200 && /attachment/i.test(cd) && /\.png"?$/.test(cd), `cd="${cd}"`);

    // 8) H5 不支持类型（application/pdf 头 + 非 PDF 字节 → sniff 成 octet-stream）
    const r5 = await fetch(`${BASE}/api/chats/${chatId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    });
    const j5 = await r5.json().catch(() => ({}));
    check('H5 不支持字节 → 415 E_UNSUPPORTED', r5.status === 415 && j5?.error?.code === 'E_UNSUPPORTED',
      `status=${r5.status} code=${j5?.error?.code}`);

    // 9) H6 超长边 → E_TOO_LARGE
    const huge = makePngHeaderOnly(5000, 40);
    const r6 = await fetch(`${BASE}/api/chats/${chatId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: huge,
    });
    const j6 = await r6.json().catch(() => ({}));
    check('H6 长边 5000px → 413 E_TOO_LARGE', r6.status === 413 && j6?.error?.code === 'E_TOO_LARGE',
      `status=${r6.status} code=${j6?.error?.code}`);

    // 10) H7 纯图发送（content 空 + attachmentIds）→ SSE 200 + 先收到 meta
    const r7 = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '', attachmentIds: [attId] }),
    });
    check('H7 纯图发送 → SSE 200', r7.status === 200 && (r7.headers.get('content-type') || '').includes('text/event-stream'),
      `status=${r7.status} ct=${r7.headers.get('content-type')}`);
    let gotMeta = false;
    let head = '';
    if (r7.body) {
      const reader = r7.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        head = buf.slice(0, 400);
        if (buf.includes('event: meta')) { gotMeta = true; break; }
        if (buf.length > 8192) break;
      }
      await reader.cancel().catch(() => {});
    }
    check('H7 收到 event: meta', gotMeta, gotMeta ? '' : `首段=${JSON.stringify(head)}`);
    // 落库校验：最近一条 user 消息 content='' 且 attachments 含该 id
    const row = get('SELECT content, attachments FROM messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1', [chatId, 'user']);
    let atts = [];
    try { atts = row ? JSON.parse(row.attachments || '[]') : []; } catch { atts = []; }
    check('H7 落库 user 消息含附件引用', row && row.content === '' && atts.length === 1 && atts[0].attachmentId === attId && atts[0].source === 'user',
      `content=${JSON.stringify(row?.content)} atts=${JSON.stringify(atts.map((a) => a.attachmentId))}`);

    // 11) 附带校验：GET 鉴权应仍按会话路径（不同 chatId 也能取，因是内容寻址；此处仅确认 404 对不存在 id）
    const rBad = await fetch(`${BASE}/api/chats/${chatId}/attachments/file_${'0'.repeat(64)}`);
    const jBad = await rBad.json().catch(() => ({}));
    check('不存在 attachmentId → 404', rBad.status === 404 && jBad?.error?.code === 'E_NOT_FOUND', `status=${rBad.status}`);
  } finally {
    await new Promise((r) => server.close(r));
    closeDb();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== HTTP 冒烟：${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join(' | '));
    console.log(`（临时目录保留供排查：${TMP}）`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP, { recursive: true, force: true }); // 全过则清理临时库副本
  }
}

main().catch((e) => {
  console.error('SMOKE CRASH:', e?.stack || e);
  process.exitCode = 1;
});
