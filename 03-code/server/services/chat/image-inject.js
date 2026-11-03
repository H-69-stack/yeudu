/**
 * 把渲染出的图片**注入给模型**——做成纯函数，便于不起 LLM 就能测。
 *
 * 为什么必须注入而不是"工具结果带图"（dsh 的硬约束，`dsh-impl/docs/01-源码梳理.md:262`）：
 * 生产适配器声明为 text-only 输出，**只有用户消息可以携带图片**
 * （上游 `packages/llm/llm/src/types.ts:83-96` 的 ImageBlock 注释）。
 * 所以正确路径是：工具栅格化 → 存 attachments → 以**用户消息**注入图片块，
 * 工具结果本身只回文本摘要。前端展示那条链路（SSE image 事件）属于 pipeline，不动。
 *
 * 契约：
 *   · 入参是本轮的工具调用日志条目（只处理 `ok === true` 且带附件的）；
 *   · 出参 `{ messages, skipped }`：`messages` 可直接 push 进 OpenAI messages 数组；
 *   · 越界一律**跳过并记账**（`skipped`），绝不因为一张超大图把整轮搞挂；
 *   · 字节读取通过 `opts.read` 注入 ⇒ 测试不必真的落盘。
 */

import { readAttachment } from './attachments.js';

/** 默认单张上限 5MB（超过就跳过，文本里说明）；每轮最多 4 张。 */
export const DEFAULT_MAX_INJECT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_INJECT_PER_TURN = 4;

const intOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
};

/**
 * 生成要注入的用户消息。
 * @param {Array<Object>} entries 本轮工具调用条目：`{name, ok, args, attachments:[{attachmentId, mediaType, width, height, region}]}`
 * @param {{maxBytes?:number, maxPerTurn?:number, read?:(id:string)=>({bytes:Buffer,mediaType:string}|null)}} [opts]
 * @returns {{messages:Array<Object>, skipped:Array<{attachmentId:string, reason:string}>}}
 */
export function buildImageInjection(entries, opts = {}) {
  const maxBytes = intOr(opts.maxBytes, DEFAULT_MAX_INJECT_BYTES);
  const maxPerTurn = intOr(opts.maxPerTurn, DEFAULT_MAX_INJECT_PER_TURN);
  const read = typeof opts.read === 'function' ? opts.read : readAttachment;

  const messages = [];
  const skipped = [];
  if (!Array.isArray(entries)) return { messages, skipped };

  for (const entry of entries) {
    if (!entry || entry.ok !== true) continue;
    const images = Array.isArray(entry.attachments) ? entry.attachments : [];
    for (const image of images) {
      const attachmentId = image && image.attachmentId;
      if (!attachmentId) continue;

      if (messages.length >= maxPerTurn) {
        skipped.push({ attachmentId, reason: `本轮注入已达上限 ${maxPerTurn} 张，未送入模型` });
        continue;
      }

      let loaded = null;
      try {
        loaded = read(attachmentId);
      } catch (error) {
        loaded = null;
        skipped.push({ attachmentId, reason: `读取附件失败：${error?.message ?? error}` });
        continue;
      }
      if (!loaded || !loaded.bytes || loaded.bytes.length === 0) {
        skipped.push({ attachmentId, reason: '附件不存在或为空，未送入模型' });
        continue;
      }
      if (loaded.bytes.length > maxBytes) {
        skipped.push({
          attachmentId,
          reason: `该图 ${loaded.bytes.length} 字节 > 单张上限 ${maxBytes}，未送入模型（改用更小的 maxEdge 重渲）`,
        });
        continue;
      }

      const mediaType = String(loaded.mediaType || image.mediaType || 'image/jpeg');
      const caption = buildCaption(entry, image, mediaType);
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: caption },
          {
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${Buffer.from(loaded.bytes).toString('base64')}` },
          },
        ],
      });
    }
  }

  return { messages, skipped };
}

/**
 * 图片说明文字。**前缀稳定**：不含路径、时间戳、PDF 正文——同输入同输出。
 * 措辞按 dsh 的能力边界来：说清"页面外观、不是 OCR"，别让模型以为这是文字层。
 */
function buildCaption(entry, image, mediaType) {
  const pageNo = Number(entry?.args?.pageNo);
  const region = String(image?.region ?? '');
  const size = image?.width && image?.height ? `${image.width}x${image.height} px` : '';
  const bits = [];
  if (Number.isInteger(pageNo) && pageNo >= 1) bits.push(`第 ${pageNo} 页`);
  if (region) bits.push(`region=${region}`);
  if (size) bits.push(size);
  const where = bits.length ? `：${bits.join('，')}` : '';
  return `（上面 ${String(entry?.name ?? 'lit_page_image')} 渲染出的页面外观图${where}）`
    + '这是页面外观，不是 OCR：极小的字可能读错；引用原文措辞仍优先用 lit_read 的文本。';
}
