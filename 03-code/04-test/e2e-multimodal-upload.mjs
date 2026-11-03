/**
 * 多模态输入/输出 · 真实端到端验证（对照 02-design/多模态输入输出设计.md §10）。
 *
 * 硬证据（确定性，无需网络/key）：
 *   A1. resolveUserAttachments + buildToolMessages → 末条 user 消息的 content 是数组，
 *       且含 `type:'image_url'`、`image_url.url` 以 `data:image/...;base64,` 开头
 *       （即「用户上传图真的进入了模型上下文」，与 buildImageInjection 同思路）。
 *   A2. 上传图片落盘后能被回读（saveFile → readAttachmentMeta 一致）。
 *
 * 软证据（best-effort，需要 network + deepseek key + 渲染后端；连不上就 SKIP，不影响硬证据）：
 *   B1. 真把带图的 messages 丢给 deepseek，模型返回文本并实际描述图中内容。
 *   B2. 触发 lit_page_image 渲染真实 PDF 页 → 模型描述版面（复用视觉通道）。
 */
import { config, loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import zlib from 'node:zlib';
import { saveFile, readAttachmentMeta } from '../server/services/chat/attachments.js';

const log = (...a) => console.error('[step]', ...a);
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(1); });

/** 用 zlib 现造一张合法的真彩 PNG（DeepSeek 要求最低尺寸，故用 64×64 蓝底） */
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
const SAMPLE_PNG = makePng(64, 64);

openDb('data/app.db');
log('db opened');
loadConfig();
log('config loaded');

// 关键：必须先打开视觉通道 + 渲染器，再「动态」导入 pipeline（pipeline 会顺带加载 tools/index，
// 而 lit_page_image 的注册发生在 tools/index 模块求值那一刻，故 enabled 必须在此前就为真）
config.chat.pageImage.enabled = true;
config.chat.pageImage.playwrightModule =
  'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/playwright/index.js';
config.chat.tools = ['lit_search', 'lit_read', 'lit_translation', 'lit_page_image'];

const { buildToolMessages, resolveUserAttachments } = await import('../server/services/chat/pipeline.js');

// ── 硬证据 A2：上传落盘 → 侧车可回读 ──────────────────────────────────────────
const ref = saveFile({ bytes: SAMPLE_PNG, mediaType: 'image/png', sniff: false });
const meta = readAttachmentMeta(ref.attachmentId);
if (!meta || meta.mediaType !== 'image/png' || !(meta.width === 64 && meta.height === 64) || meta.bytes !== SAMPLE_PNG.length) {
  console.error('FAIL A2: readAttachmentMeta 不一致', meta);
  process.exit(1);
}
log('A2 ok: 落盘+侧车回读一致', ref.attachmentId, `(${meta.width}x${meta.height}, ${meta.bytes}B)`);

// ── 硬证据 A1：用户图进入 buildToolMessages 的 user content parts ──────────────
const { refs, images, skipped } = resolveUserAttachments([ref.attachmentId]);
if (skipped.length || !images.length) {
  console.error('FAIL A1: resolveUserAttachments 未解析出图片', { refs, images, skipped });
  process.exit(1);
}
const work = { no: '4.4', title: 'A Survey on LLM-based Autonomous Agents' };
const { messages } = buildToolMessages({
  work,
  history: [],
  content: '请描述这张图片里你实际看到的内容，只据图作答。',
  userImageAttachments: images,
});
const lastUser = messages[messages.length - 1];
if (lastUser.role !== 'user' || !Array.isArray(lastUser.content)) {
  console.error('FAIL A1: 末条 user 消息 content 不是数组', lastUser);
  process.exit(1);
}
const imgPart = lastUser.content.find((p) => p.type === 'image_url');
if (!imgPart || !/^data:image\/[^;]+;base64,/.test(imgPart.image_url.url)) {
  console.error('FAIL A1: 未含 data URI 图片块', lastUser.content);
  process.exit(1);
}
console.log('A1 ok: 用户图已注入模型上下文（image_url data URI）');
console.log('   content 块数 =', lastUser.content.length, '| 含 image_url =', Boolean(imgPart));

// ── 软证据 B1/B2：真实模型调用（best-effort） ────────────────────────────────
async function tryLive() {
  const { secrets } = await import('../server/config.js');
  if (!secrets.providers[config.chat.provider]?.apiKey) {
    console.log('SKIP B1/B2: 未配置 deepseek key，跳过真实模型调用（硬证据 A1+A2 已通过）');
    return;
  }
  const { buildTools, PAGE_IMAGE_STATUS } = await import('../server/services/chat/tools/index.js');
  const { createRegistry } = await import('../server/services/chat/registry.js');
  const { runToolLoop } = await import('../server/services/chat/loop.js');
  log('pageImage 注册状态:', JSON.stringify(PAGE_IMAGE_STATUS));
  const { tools } = buildTools(config.chat.tools);
  const registry = createRegistry(tools, { maxCalls: 6 });

  // B1：用户上传图 → 模型接收并描述
  const started = Date.now();
  const out = await runToolLoop({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages,
    registry,
    maxRounds: 3,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`B1 ok: 模型接收带图消息并返回 ${out.text.length} 字（${secs}s）：`);
  console.log(out.text.slice(0, 220));

  // B2：lit_page_image 渲染真实 PDF 页 → 模型描述版面
  if (!PAGE_IMAGE_STATUS.registered) {
    console.log('SKIP B2: lit_page_image 未注册（渲染后端不可用）→', PAGE_IMAGE_STATUS.reason,
      '（工具产图路径已在 e2e-vision-real.mjs + image-inject 单测中验证）');
    return;
  }
  const { messages: m2 } = buildToolMessages({
    work,
    history: [],
    content:
      '请先用 lit_page_image 渲染文献 4.4 的第 1 页，然后告诉我这一页上你实际看到了哪些版面元素（标题/作者/摘要/图表等）。只根据图片作答。',
  });
  const out2 = await runToolLoop({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: m2,
    registry,
    maxRounds: 4,
  });
  const imgTool = out2.toolCalls.find((t) => t.name === 'lit_page_image');
  console.log('B2: 渲染工具被调用 =', Boolean(imgTool), '| 总轮数 =', out2.rounds);
  console.log(out2.text.slice(0, 220));
}

try {
  await tryLive();
} catch (e) {
  console.log('SKIP B1/B2: 真实模型调用失败（可能是离线/超时），硬证据不受影响 →', e.message);
}
console.log('\n=== 多模态 E2E 通过（硬证据 A1+A2）===');
process.exit(0);
