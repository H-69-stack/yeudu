/**
 * 对话路由（§8.5）：会话 CRUD + SSE 提问 + 取消 + 反馈 + 多模态附件上传/回源。
 */
import express from 'express';
import { Router } from 'express';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { extractMultipartFile } from './assets.js';
import {
  createChat,
  listChats,
  listMessages,
  postMessage,
  cancelTurn,
  setFeedback,
  deleteChat,
} from '../services/chat/agent.js';
import { loadChat } from '../services/chat/session.js';
import {
  readAttachment,
  readAttachmentMeta,
  readImageSize,
  saveFile,
  sniffMediaType,
} from '../services/chat/attachments.js';

/** mediaType → 下载文件名扩展名（GET ?dl=1 用） */
function extForMediaType(mediaType) {
  switch (String(mediaType || '')) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'application/pdf': return 'pdf';
    case 'text/plain': return 'txt';
    case 'text/markdown': return 'md';
    default: return 'bin';
  }
}

/** 解析上传请求体：multipart 的 file part 或裸 image/*、application/pdf 原始体 */
function parseUploadBody(body, contentType) {
  const ct = String(contentType || '');
  if (ct.startsWith('multipart/form-data')) {
    const part = extractMultipartFile(body, ct);
    if (!part) throw new AppError('E_BAD_REQUEST', 'multipart 里没有 file 字段');
    return part.data;
  }
  // 裸体（浏览器对单文件可直接 POST 原始字节）
  if (Buffer.isBuffer(body) && body.length) return body;
  throw new AppError('E_BAD_REQUEST', '未收到文件内容（需要 multipart 的 file 字段或 image/* 原始体）');
}

/**
 * 用户上传附件（两步式第一步）：落盘内容寻址对象，返回引用。
 * 安全：仅本机 Node 进程内 IO，不触外部网络；经 express.raw 接 multipart/裸体。
 */
function uploadAttachment(req, res, next) {
  try {
    loadChat(Number(req.params.id)); // 校验会话存在（不存在抛 E_NOT_FOUND）
    const bytes = parseUploadBody(req.body, req.headers['content-type']);
    if (!bytes || !bytes.length) throw new AppError('E_BAD_REQUEST', '空文件');

    const maxBytes = Number(config.chat.attachments?.maxBytes ?? 10485760);
    if (bytes.length > maxBytes) {
      throw new AppError('E_TOO_LARGE', `上传文件 ${bytes.length} 字节，超过单文件上限 ${maxBytes}（约 ${Math.round(maxBytes / 1048576)}MB），请压缩后重试`, { bytes: bytes.length, maxBytes });
    }

    const mediaType = sniffMediaType(bytes);
    const supported = config.chat.attachments?.supported || [];
    if (!supported.includes(mediaType)) {
      throw new AppError('E_UNSUPPORTED', `不支持的文件类型：${mediaType}（本轮仅支持图片与 PDF/TXT/MD）`, { mediaType });
    }

    if (mediaType.startsWith('image/')) {
      const size = readImageSize(bytes);
      const maxEdge = Number(config.chat.attachments?.maxEdgePx ?? 4096);
      if (size && Math.max(size.width, size.height) > maxEdge) {
        throw new AppError('E_TOO_LARGE', `图片长边 ${Math.max(size.width, size.height)}px 超过上限 ${maxEdge}px（本系统暂不支持自动压缩，请用更小的图）`, { edge: Math.max(size.width, size.height), maxEdge });
      }
    }

    const ref = saveFile({ bytes, mediaType, sniff: false });
    res.status(201).json({
      attachmentId: ref.attachmentId,
      source: 'user',
      kind: mediaType.startsWith('image/') ? 'image' : 'file',
      mediaType: ref.mediaType,
      width: ref.width,
      height: ref.height,
      bytes: ref.bytes,
      url: `/api/chats/${req.params.id}/attachments/${encodeURIComponent(ref.attachmentId)}`,
    });
  } catch (e) {
    next(e);
  }
}

export function chatRoutes() {
  const r = Router();

  r.post('/chats', (req, res, next) => {
    try {
      const { workNo, provider, model, title } = req.body || {};
      if (!workNo) throw new AppError('E_BAD_REQUEST', '缺少 workNo', { field: 'workNo' });
      res.status(201).json(createChat({ workNo, provider, model, title }));
    } catch (e) {
      next(e);
    }
  });

  r.get('/chats', (req, res, next) => {
    try {
      res.json(listChats(req.query.workNo ? String(req.query.workNo) : null));
    } catch (e) {
      next(e);
    }
  });

  r.get('/chats/:id/messages', (req, res, next) => {
    try {
      res.json(
        listMessages(Number(req.params.id), {
          limit: Number(req.query.limit) || 50,
          before: req.query.before ? Number(req.query.before) : undefined,
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  r.post('/chats/:id/messages', (req, res, next) => {
    postMessage(Number(req.params.id), req.body || {}, res).catch(next);
  });

  r.post('/chats/:id/messages/:mid/cancel', (req, res, next) => {
    try {
      res.json(cancelTurn(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  r.post('/messages/:id/feedback', (req, res, next) => {
    try {
      const { score } = req.body || {};
      res.json(setFeedback(Number(req.params.id), Number(score)));
    } catch (e) {
      next(e);
    }
  });

  // 附件上传（两步式第一步）：multipart / 裸体均可，落盘内容寻址对象后返回引用。
  // 该路径已在 app.js 的 allowMultipartPaths 白名单内（否则被 security 中间件按 Content-Type 拒绝）。
  r.post(
    '/chats/:id/attachments',
    express.raw({
      type: ['multipart/form-data', 'image/*', 'application/pdf', 'text/plain', 'text/markdown'],
      limit: (Number(config.chat.attachments?.maxBytes ?? 10485760) + 8 * 1024 * 1024),
    }),
    (req, res, next) => uploadAttachment(req, res, next),
  );

  // 附件回源（图片/文件）：只按 attachmentId 取内容寻址对象，不暴露磁盘路径；只读、不写。
  // ?dl=1 → 作为附件下载（Content-Disposition: attachment），否则内联（img 元素直接显示）。
  r.get('/chats/:id/attachments/:attId', (req, res, next) => {
    try {
      const id = String(req.params.attId || '');
      const meta = readAttachmentMeta(id);
      if (!meta) throw new AppError('E_NOT_FOUND', `附件不存在：${id}`, { attId: id });
      const a = readAttachment(id);
      if (!a) throw new AppError('E_NOT_FOUND', `附件不存在：${id}`, { attId: id });
      const mediaType = meta.mediaType || a.mediaType;
      res.setHeader('Content-Type', mediaType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      // 图片只在已授权的会话上下文里展示，不允许被当作页面直接执行
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.query.dl === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${id}.${extForMediaType(mediaType)}"`);
      }
      res.end(a.bytes);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/chats/:id', (req, res, next) => {
    try {
      res.json(deleteChat(Number(req.params.id)));
    } catch (e) {
      next(e);
    }
  });

  return r;
}
