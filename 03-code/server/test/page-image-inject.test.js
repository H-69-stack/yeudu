/**
 * 图片注入（模型真能看到图那一环）的单测：不需要 key、不需要网络、不需要浏览器。
 *
 * 覆盖 dsh 侧那条硬约束：图片只能**以用户消息**注入，工具结果只回文本摘要
 * （`dsh-impl/docs/01-源码梳理.md:262`）。
 *   ① 有附件 ⇒ 产出 role:'user' + content 为多模态数组且含 image_url；
 *   ② 超过单张字节上限 ⇒ 跳过，且 skipped 里带可读原因；
 *   ③ 每轮张数上限 ⇒ 超出的跳过；
 *   ④ 无附件 / 工具失败 ⇒ 不产生任何 user 消息（no_pdf 无图不注入）；
 *   ⑤ 真实附件落盘后能被注入（真读盘）；
 *   ⑥ **loop 真跑**：起本地 stub 服务（OpenAI 协议 SSE），把 provider 指向它，
 *      断言「发给模型的请求体」里确实出现了带 image_url 的 user 消息；
 *   ⑦ 开关关掉 ⇒ 同一个 loop 一行图都不发。
 *
 * ⑥⑦ 是「模型真能看到图」的硬证据：**断言目标不是内存里的 messages，而是 HTTP 请求体**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildImageInjection } from '../services/chat/image-inject.js';
import { saveImage, readAttachment, attachmentsDir } from '../services/chat/attachments.js';
import { runToolLoop } from '../services/chat/loop.js';
import { config, secrets } from '../config.js';

/** 一张真的小 PNG（1×1 红点，够小也能被 readAttachment 嗅探成 image/png）。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** 造一个"渲染成功"的条目（形状与 loop.js 里 toolLog 的 entry 一致）。 */
function okEntry(over = {}) {
  return {
    name: 'lit_page_image',
    ok: true,
    args: { no: '1.17', pageNo: 1, region: 'full' },
    attachments: [{ attachmentId: 'img_abc', mediaType: 'image/png', width: 8, height: 8, region: 'full' }],
    ...over,
  };
}

const fakeRead = (bytes, mediaType = 'image/png') => () => ({ bytes, mediaType });

test('① 有附件 ⇒ 注入一条 user 消息，content 是多模态数组且含 image_url', () => {
  const { messages, skipped } = buildImageInjection([okEntry()], { read: fakeRead(TINY_PNG) });
  assert.equal(messages.length, 1);
  assert.equal(skipped.length, 0);
  const m = messages[0];
  assert.equal(m.role, 'user', '图片必须以用户消息注入（适配器 text-only 输出）');
  assert.ok(Array.isArray(m.content), 'content 必须是数组（多模态）');
  assert.equal(m.content[0].type, 'text');
  assert.equal(m.content[1].type, 'image_url');
  assert.match(m.content[1].image_url.url, /^data:image\/png;base64,/u);
  // base64 必须能解回原字节（不是占位串）
  const b64 = m.content[1].image_url.url.split(',')[1];
  assert.equal(Buffer.from(b64, 'base64').length, TINY_PNG.length);
  // 说明文字要带页码/区域，且不写本机路径
  assert.match(m.content[0].text, /第 1 页/u);
  assert.match(m.content[0].text, /region=full/u);
  assert.match(m.content[0].text, /不是 OCR/u);
  assert.doesNotMatch(m.content[0].text, /[A-Za-z]:[\\/]|\.pdf/u);
});

test('② 超过单张字节上限 ⇒ 跳过，skipped 里写清原因', () => {
  const { messages, skipped } = buildImageInjection([okEntry()], {
    read: fakeRead(Buffer.alloc(1000, 1)),
    maxBytes: 500,
  });
  assert.equal(messages.length, 0, '超限的图不能进上下文');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /1000 字节 > 单张上限 500/u);
  assert.equal(skipped[0].attachmentId, 'img_abc');
});

test('③ 每轮张数上限 ⇒ 超出的跳过', () => {
  const entries = [okEntry(), okEntry({ args: { no: '1.17', pageNo: 2 } })];
  const { messages, skipped } = buildImageInjection(entries, {
    read: fakeRead(TINY_PNG),
    maxPerTurn: 1,
  });
  assert.equal(messages.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /本轮注入已达上限 1 张/u);
});

test('④ 无附件 / 工具失败 / 附件读不到 ⇒ 不产生任何 user 消息', () => {
  assert.deepEqual(buildImageInjection([], { read: fakeRead(TINY_PNG) }).messages, []);
  // no_pdf：status 是 no_pdf 时工具层不产出 image ⇒ entry.attachments 为空
  assert.deepEqual(
    buildImageInjection([okEntry({ attachments: [] })], { read: fakeRead(TINY_PNG) }).messages,
    [],
  );
  // 工具失败：ok=false ⇒ 整条跳过
  const failed = buildImageInjection([okEntry({ ok: false })], { read: fakeRead(TINY_PNG) });
  assert.deepEqual(failed.messages, []);
  assert.equal(failed.skipped.length, 0);
  // 附件读不到
  const missing = buildImageInjection([okEntry()], { read: () => null });
  assert.deepEqual(missing.messages, []);
  assert.match(missing.skipped[0].reason, /附件不存在或为空/u);
});

test('⑤ 真实附件落盘后能被注入（readAttachment 真读盘，不是假 read）', () => {
  const ref = saveImage({ bytes: TINY_PNG, mediaType: 'image/png', width: 8, height: 8 });
  assert.ok(fs.existsSync(path.join(attachmentsDir(), ...objectTail(ref.attachmentId))), '附件应真的落盘');
  const { messages } = buildImageInjection([okEntry({ attachments: [{ ...ref, region: 'top-left' }] })]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content[1].image_url.url, /^data:image\/png;base64,/u);
  assert.match(messages[0].content[0].text, /region=top-left/u);
  // readAttachment 回读一致
  const back = readAttachment(ref.attachmentId);
  assert.equal(back.bytes.length, TINY_PNG.length);
});

/** attachments.js 用内容寻址两级目录：objectsRoot()/<sha[0:2]>/<sha> */
function objectTail(attachmentId) {
  const id = String(attachmentId).replace(/^img_/u, '').replace(/^sha256:/u, '');
  return [id.slice(0, 2), id];
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥⑦ 的公共设施：一个 OpenAI 协议 stub 服务（SSE），让 runToolLoop **真的**发 HTTP。
// 断言目标是**请求体**，不是内存里的 messages —— 这样才叫「图真的发给了模型」。
// ─────────────────────────────────────────────────────────────────────────────

/** 起一个 stub：第 1 次请求下发 tool_call，第 2 次请求下发正文。返回收到的请求体列表。 */
async function startStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = null;
      }
      received.push(body);
      const n = received.length;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (n === 1) {
        // 第 1 轮：模型要调工具（按 index 分片下发，逼 loop 走真实的流式拼接）
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lit_page_image' } }] }, finish_reason: null }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"no":"1.1' } }] }, finish_reason: null }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '7","pageNo":1}' } }] }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // 第 2 轮：只出正文（不再调工具 ⇒ loop 正常收尾）
        send({ choices: [{ delta: { content: '图上看' }, finish_reason: null }] });
        send({ choices: [{ delta: { content: '得到：8' }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 4 } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, close: () => new Promise((r) => server.close(r)), port: server.address().port };
}

/** 跑一遍真 loop；`injectImages` 由调用方决定。返回 stub 收到的第 2 个请求体。 */
async function runLoopOnce({ port, attachmentId, injectImages }) {
  const prevInject = config.chat.pageImage.injectImages;
  const prevSecrets = secrets.providers[PROVIDER];
  config.chat.pageImage.injectImages = injectImages;
  // 把 provider 指向本地 stub：这样 client.js 真的发 HTTP，而不是被 mock 掉
  secrets.providers[PROVIDER] = { apiKey: 'stub-key', baseUrl: `http://127.0.0.1:${port}/v1` };
  try {
    const registry = {
      openaiTools: () => undefined,
      stats: () => ({ calls: 1, byName: {}, exhausted: false }),
      async run(name, args) {
        assert.equal(name, 'lit_page_image');
        assert.equal(args.no, '1.17');
        assert.equal(args.pageNo, 1);
        return {
          ok: true,
          text: '第 1/8 页已渲染（region=full，8x8 px）。',
          value: {
            no: '1.17',
            pageNo: 1,
            status: 'ok',
            image: { attachmentId, mediaType: 'image/png', width: 8, height: 8, region: 'full' },
          },
        };
      },
    };
    return await runToolLoop({
      provider: PROVIDER,
      model: 'stub-model',
      messages: [{ role: 'user', content: '看看 1.17 第 1 页' }],
      registry,
      maxRounds: 3,
    });
  } finally {
    config.chat.pageImage.injectImages = prevInject;
    if (prevSecrets === undefined) delete secrets.providers[PROVIDER];
    else secrets.providers[PROVIDER] = prevSecrets;
  }
}

const PROVIDER = 'deepseek';

test('⑥ loop 真跑：发给模型的第 2 个请求体里，有 role=user 且带 image_url 的消息', async () => {
  const ref = saveImage({ bytes: TINY_PNG, mediaType: 'image/png', width: 8, height: 8 });
  const stub = await startStub();
  try {
    const out = await runLoopOnce({ port: stub.port, attachmentId: ref.attachmentId, injectImages: true });

    // 循环确实完整跑过：2 次 HTTP，第 1 次触发工具、第 2 次产出正文
    assert.equal(stub.received.length, 2, 'stub 应收到 2 次请求（工具轮 + 收尾轮）');
    assert.equal(out.text, '图上看得到：8', '流式 delta 应被正确拼接');
    assert.equal(out.toolCalls.length, 1, '分片下发的 tool_call 必须拼成 1 条');
    assert.equal(out.toolCalls[0].name, 'lit_page_image');
    assert.deepEqual(out.toolCalls[0].args, { no: '1.17', pageNo: 1 }, 'arguments 分片拼接要无损（解析后与期望一致）');
    assert.equal(out.usage.promptTokens, 123);

    const second = stub.received[1];
    const injected = (second.messages || []).filter((m) => m.role === 'user' && Array.isArray(m.content));
    assert.equal(injected.length, 1, '**恰好**注入 1 条多模态 user 消息');
    const msg = injected[0];
    assert.equal(msg.content[0].type, 'text');
    assert.equal(msg.content[1].type, 'image_url');
    assert.match(msg.content[1].image_url.url, /^data:image\/png;base64,/u);
    // base64 解回的字节 == 落盘的那张图（不是占位）
    assert.equal(
      Buffer.from(msg.content[1].image_url.url.split(',')[1], 'base64').toString('base64'),
      TINY_PNG.toString('base64'),
    );

    // 顺序：assistant(tool_calls) → tool(纯文本) → user(图)。图必须在 tool 结果**之后**
    const roles = second.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'user'], `实际 roles=${JSON.stringify(roles)}`);
    // 工具结果本身只回文本摘要：**不**含图（否则就是语义错位）
    assert.equal(typeof second.messages[2].content, 'string');
    assert.doesNotMatch(String(second.messages[2].content), /base64|image_url/u);
    // 第 1 轮请求体里没有图（那时还没渲染）
    assert.equal((stub.received[0].messages || []).filter((m) => Array.isArray(m.content)).length, 0);
  } finally {
    await stub.close();
  }
});

test('⑦ 开关关掉 ⇒ loop 一行图都不发（injectImages:false）', async () => {
  const ref = saveImage({ bytes: TINY_PNG, mediaType: 'image/png', width: 8, height: 8 });
  const stub = await startStub();
  try {
    await runLoopOnce({ port: stub.port, attachmentId: ref.attachmentId, injectImages: false });
    assert.equal(stub.received.length, 2);
    const second = stub.received[1];
    assert.equal((second.messages || []).filter((m) => Array.isArray(m.content)).length, 0, '关掉后不应有任何多模态消息');
    assert.deepEqual(second.messages.map((m) => m.role), ['user', 'assistant', 'tool']);
  } finally {
    await stub.close();
  }
});
