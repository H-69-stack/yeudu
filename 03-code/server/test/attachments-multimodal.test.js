/**
 * 多模态输入/输出能力单测：不需要 key、不需要网络、不需要浏览器。
 *
 * 验证「用户上传图片 → 真的进入模型上下文（data URI content parts）」与「落库引用可追溯」两件事：
 *   - saveFile / readAttachmentMeta / attachmentIdOf / sniffMediaType / readImageSize 存储层
 *   - buildUserContent：无图返回纯文本、有图返回含 image_url 的数组、超字节降级为文字
 *   - resolveUserAttachments：上传图片 → 进模型字节 + 落库引用；不存在的 id → skipped
 *
 * 与 image-inject.test.js 的分工：那个测「工具产图注入」，这个测「用户上传图注入 + 存储层」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { config, loadConfig } from '../config.js';
import { openDb, get } from '../db.js';
import { createChat, insertUserMessage, listMessages } from '../services/chat/session.js';
import {
  saveFile,
  readAttachment,
  readAttachmentMeta,
  attachmentIdOf,
  sniffMediaType,
  readImageSize,
} from '../services/chat/attachments.js';
import { buildUserContent, resolveUserAttachments } from '../services/chat/pipeline.js';

/** 1×1 PNG：够小、能被嗅探成 image/png、readImageSize 能解析出 1×1 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF', 'latin1');
const TEXT_BYTES = Buffer.from('hello world\nthis is plain text\n', 'utf8');

loadConfig();

test('attachmentIdOf：默认 img_ 前缀、可指定 file_ 前缀、内容寻址稳定', () => {
  const fileId = attachmentIdOf(TINY_PNG, 'file');
  assert.ok(fileId.startsWith('file_'));
  assert.equal(attachmentIdOf(TINY_PNG, 'file'), fileId, '同字节 → 同 id');
  assert.ok(attachmentIdOf(TINY_PNG).startsWith('img_'));
});

test('sniffMediaType：识别 png/pdf/text/未知', () => {
  assert.equal(sniffMediaType(TINY_PNG), 'image/png');
  assert.equal(sniffMediaType(PDF_BYTES), 'application/pdf');
  assert.equal(sniffMediaType(TEXT_BYTES), 'text/plain');
  assert.equal(sniffMediaType(Buffer.from([0, 1, 2, 3, 4, 5])), 'application/octet-stream');
});

test('readImageSize：解析 PNG 尺寸', () => {
  const s = readImageSize(TINY_PNG);
  assert.ok(s && s.width === 1 && s.height === 1, JSON.stringify(s));
});

test('saveFile：内容寻址落盘 + .meta.json 侧车 + 回读一致', () => {
  const ref = saveFile({ bytes: TINY_PNG, mediaType: 'image/png', sniff: false });
  assert.ok(ref.attachmentId.startsWith('file_'));
  const meta = readAttachmentMeta(ref.attachmentId);
  assert.ok(meta, 'meta 应存在');
  assert.equal(meta.mediaType, 'image/png');
  assert.equal(meta.width, 1);
  assert.equal(meta.height, 1);
  assert.equal(meta.bytes, TINY_PNG.length);
  const data = readAttachment(ref.attachmentId);
  assert.ok(data && data.bytes.length === TINY_PNG.length);
});

test('saveFile：PDF 等非图片落盘，kind 隐含为 file、无尺寸', () => {
  const ref = saveFile({ bytes: PDF_BYTES, mediaType: 'application/pdf', sniff: false });
  const meta = readAttachmentMeta(ref.attachmentId);
  assert.equal(meta.mediaType, 'application/pdf');
  assert.equal(meta.width, null);
  assert.equal(meta.height, null);
});

test('buildUserContent：无图返回纯文本字符串（保持历史行为）', () => {
  const out = buildUserContent({ text: '看图说话', imageAttachments: [] });
  assert.equal(out, '看图说话');
});

test('buildUserContent：有图返回含 image_url(data URI) 的数组', () => {
  const out = buildUserContent({
    text: '描述这张图',
    imageAttachments: [{ attachmentId: 'file_x', mediaType: 'image/png', bytes: TINY_PNG }],
  });
  assert.ok(Array.isArray(out), '应为 content parts 数组');
  const textPart = out.find((p) => p.type === 'text');
  const imgPart = out.find((p) => p.type === 'image_url');
  assert.ok(textPart && textPart.text === '描述这张图');
  assert.ok(imgPart, '应包含 image_url part');
  assert.ok(imgPart.image_url.url.startsWith('data:image/png;base64,'), imgPart.image_url.url.slice(0, 30));
});

test('buildUserContent：超字节图片降级为文字说明，不抛错', () => {
  const big = Buffer.alloc(config.chat.attachments.maxInjectBytes + 10, 0xff);
  const out = buildUserContent({
    text: '看',
    imageAttachments: [{ attachmentId: 'file_b', mediaType: 'image/png', bytes: big }],
  });
  const skip = out.find((p) => p.type === 'text' && p.text.includes('超过单张上限'));
  assert.ok(skip, JSON.stringify(out));
});

test('resolveUserAttachments：上传图片 → 进模型字节 + 落库引用；不存在 id → skipped', () => {
  const ref = saveFile({ bytes: TINY_PNG, mediaType: 'image/png', sniff: false });
  const { refs, images, skipped } = resolveUserAttachments([ref.attachmentId]);
  assert.equal(skipped.length, 0);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].source, 'user');
  assert.equal(refs[0].kind, 'image');
  assert.equal(refs[0].mediaType, 'image/png');
  assert.equal(images.length, 1, '图片字节应进模型');
  assert.equal(images[0].bytes.length, TINY_PNG.length);

  const bad = resolveUserAttachments(['file_deadbeef0000000000000000000000000000000000000000000000000000000000']);
  assert.equal(bad.skipped.length, 1, '不存在的 id 应记入 skipped');
  assert.equal(bad.refs.length, 0);
});

test('集成：用户附件随 user 消息落库并可回读（insertUserMessage → listMessages）', () => {
  openDb('data/app.db');
  const work = get('SELECT * FROM works LIMIT 1');
  if (!work) {
    console.warn('跳过：works 表无数据，无法建会话');
    return;
  }
  const { chatId } = createChat({ workNo: work.no, provider: 'deepseek', model: 'deepseek-chat' });
  const ref = saveFile({ bytes: TINY_PNG, mediaType: 'image/png', sniff: false });
  const { refs } = resolveUserAttachments([ref.attachmentId]);
  const userMsgId = insertUserMessage(
    { id: chatId, provider: 'deepseek', model: 'deepseek-chat' },
    '请看这张图',
    refs,
  );
  const out = listMessages(chatId);
  const msg = out.messages.find((m) => m.id === userMsgId);
  assert.ok(msg, '应能读回刚写入的用户消息');
  assert.equal(msg.role, 'user');
  assert.ok(Array.isArray(msg.attachments) && msg.attachments.length === 1, '落库附件应为 1 个');
  assert.equal(msg.attachments[0].attachmentId, ref.attachmentId);
  assert.equal(msg.attachments[0].source, 'user');
  assert.equal(msg.attachments[0].kind, 'image');
});
