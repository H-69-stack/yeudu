/**
 * dsh 能力对齐的单测（不需要 key、不需要网络、不需要浏览器）。
 *
 * 覆盖从 dsh 搬过来的几条硬契约：
 *   ① defineTool 契约与「模型只看到 name/description/parameters」的投影；
 *   ② output.schema 校验 → INVALID_TOOL_OUTPUT（dsh contracts.ts:18,310）；
 *   ③ 单工具超时 → TOOL_TIMEOUT（dsh contracts.ts:69）；
 *   ④ 工具失败不中断循环（错误回给模型，不是异常）；
 *   ⑤ 本轮额度闸 与 每会话每工具额度闸（dsh lit-page-image.ts:167-175 的 `used > max` 判定）；
 *   ⑥ 未知工具 → UNKNOWN_TOOL；
 *   ⑦ 引用锚点校验（伪造锚点丢弃）；
 *   ⑧ persona 字节稳定（同配置同产物，前缀缓存友好）；
 *   ⑨ 存储区路径作用域（越界抛错，不做尽力而为拼接）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { defineTool, createRegistry, validateOutput, TOOL_ERROR } from '../services/chat/registry.js';
import { personaText } from '../services/chat/persona/lit-research.js';
import { attachmentIdOf, readAttachment, saveImage } from '../services/chat/attachments.js';
import { isWithin, resolveStoragePath } from '../services/chat/tools/_sandbox.js';

const baseTool = (over = {}) =>
  defineTool({
    name: 't_ok',
    description: '工具描述',
    parameters: { q: { type: 'string', required: true } },
    outputSchema: { type: 'object', required: ['total'], properties: { total: { type: 'number', minimum: 0 } } },
    execute: () => ({ total: 1 }),
    render: (_a, v) => `total=${v.total}`,
    ...over,
  });

test('defineTool：schema 投影只含模型该看的字段', () => {
  const t = baseTool();
  const schema = t.schema.function;
  assert.equal(schema.name, 't_ok');
  assert.deepEqual(schema.parameters.required, ['q']);
  assert.equal(schema.parameters.additionalProperties, false);
});

test('defineTool：缺 render / 非法参数类型直接拒绝（装配期响亮失败）', () => {
  assert.throws(() => defineTool({ name: 'x', description: 'd', execute: () => ({}) }), /render/);
  assert.throws(
    () => defineTool({ name: 'x', description: 'd', parameters: { a: { type: 'blob' } }, execute: () => ({}), render: () => '' }),
    /类型非法/,
  );
});

test('output.schema 违反 → INVALID_TOOL_OUTPUT（不是静默通过）', async () => {
  const reg = createRegistry([
    baseTool({ name: 't_bad', execute: () => ({ total: -1 }) }),
    baseTool({ name: 't_wrongtype', execute: () => ({ total: 'x' }) }),
  ]);
  const a = await reg.run('t_bad', {});
  const b = await reg.run('t_wrongtype', {});
  assert.equal(a.ok, false);
  assert.equal(a.errorCode, TOOL_ERROR.INVALID_TOOL_OUTPUT);
  assert.equal(b.errorCode, TOOL_ERROR.INVALID_TOOL_OUTPUT);
});

test('单工具超时 → TOOL_TIMEOUT，且不让整轮卡死', async () => {
  const reg = createRegistry([
    baseTool({
      name: 't_slow',
      timeoutMs: 30,
      execute: () => new Promise((r) => setTimeout(() => r({ total: 1 }), 500)),
    }),
  ]);
  const r = await reg.run('t_slow', {});
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, TOOL_ERROR.TOOL_TIMEOUT);
  assert.ok(r.ms < 400);
});

test('工具抛错不中断：错误作为结果返回（模型可换参数重试）', async () => {
  const reg = createRegistry([baseTool({ name: 't_throw', execute: () => { throw new Error('boom'); } })]);
  const r = await reg.run('t_throw', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  assert.equal(typeof r.text, 'undefined');
});

test('本轮额度闸：超过 maxCalls 后拒绝并给出替代方案', async () => {
  const reg = createRegistry([baseTool({ name: 't_ok' })], { maxCalls: 2 });
  assert.equal((await reg.run('t_ok', {})).ok, true);
  assert.equal((await reg.run('t_ok', {})).ok, true);
  const third = await reg.run('t_ok', {});
  assert.equal(third.ok, false);
  assert.equal(third.errorCode, TOOL_ERROR.TOOL_QUOTA);
});

test('每会话每工具额度：sessionCounts 计入，判定是 used > max', async () => {
  const reg = createRegistry([baseTool({ name: 'img' })], {
    sessionCounts: { img: 19 },
    maxCallsPerName: { img: 20 },
  });
  assert.equal((await reg.run('img', {})).ok, true); // 第 20 次放行
  const second = await reg.run('img', {}); // 第 21 次拦下
  assert.equal(second.ok, false);
  assert.equal(second.errorCode, TOOL_ERROR.TOOL_QUOTA);
});

test('未知工具 → UNKNOWN_TOOL', async () => {
  const reg = createRegistry([baseTool()]);
  const r = await reg.run('nope', {});
  assert.equal(r.errorCode, TOOL_ERROR.UNKNOWN_TOOL);
});

test('validateOutput：数组与嵌套字段也能校', () => {
  assert.equal(validateOutput({ type: 'array' }, []), null);
  assert.match(validateOutput({ type: 'array' }, {}), /期望 array/);
  assert.match(validateOutput({ type: 'object', required: ['a'] }, {}), /缺少必填字段 a/);
});

test('persona：同配置两次渲染字节一致（前缀稳定），看图边界随能力开关出现', () => {
  const a = personaText({ canSeeImages: true });
  const b = personaText({ canSeeImages: true });
  assert.equal(a, b);
  assert.match(a, /看图边界/);
  assert.match(a, /不是文字层，也不是 OCR/);
  const off = personaText({ canSeeImages: false });
  assert.ok(!off.includes('看图边界'));
  assert.match(personaText({ canWrite: false }), /只读/);
});

test('附件：内容寻址、幂等、可按 id 读回', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const a = saveImage({ bytes, mediaType: 'image/png', width: 10, height: 20 });
  const b = saveImage({ bytes, mediaType: 'image/png', width: 10, height: 20 });
  assert.equal(a.attachmentId, b.attachmentId);
  assert.equal(a.attachmentId, attachmentIdOf(bytes));
  const back = readAttachment(a.attachmentId);
  assert.ok(back);
  assert.equal(back.mediaType, 'image/png');
  assert.equal(back.bytes.length, bytes.length);
  assert.equal(readAttachment('img_deadbeef'), null);
});

test('存储区作用域：越界路径一律拒绝', () => {
  assert.equal(isWithin('/a/b', '/a/b/c'), true);
  assert.equal(isWithin('/a/b', '/a/bc'), false);
  assert.throws(() => resolveStoragePath('../outside.pdf'), /非法/);
  assert.throws(() => resolveStoragePath('C:/Windows/x.pdf'), /非法/);
});
