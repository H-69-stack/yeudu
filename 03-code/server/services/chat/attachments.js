/**
 * 附件服务（对齐 dsh 的 `packages/attachment/attachment` + `attachment-local`）。
 *
 * 关键差异与刻意保留的一致性：
 *   - dsh 用「内容寻址 + 引用（attachmentId）」而不是把 base64 内联进上下文（省 token）；
 *     这里同样：图片落到 `data/attachments/v1/objects/<2位hex>/<sha256>`，工具体把 `attachmentId`
 *     放进结构化 value，模型拿到的是引用而不是几万字节的 base64。
 *   - dsh 的 attachmentId 是品牌类型字符串；这里用 `<prefix>_<sha256>` —— **摘要本身即索引**，
 *     所以不需要额外的索引表（比 dsh 少一个状态，代价是 id 较长）。
 *
 * 两种前缀：
 *   - `img_<sha256>`：图片（工具产图 saveImage / 用户上传的图片 alsch via saveFile 之外也允许）
 *   - `file_<sha256>`：非图片文件（用户上传的 PDF/TXT/MD 等，本轮仅落盘占位，不进模型）
 * objectPath 同时兼容两种前缀（按末尾 64 位 hex 定位，与前缀无关）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

/** 对象存储根（跟随数据库所在目录，换库即换附件区） */
function objectsRoot() {
  return path.join(path.dirname(config.server.dbPath), 'attachments', 'v1', 'objects');
}

/** 由 attachmentId 反解出 64 位 hex（兼容 img_ / file_ 任意前缀） */
function shaOf(attachmentId) {
  const m = String(attachmentId || '').match(/([0-9a-f]{64})$/);
  return m ? m[1] : null;
}

function objectPath(attachmentId) {
  const sha = shaOf(attachmentId);
  if (!sha) return null;
  return path.join(objectsRoot(), sha.slice(0, 2), sha);
}

/** 侧车 metadata 路径（与对象同目录同名 + .meta.json） */
function metaPath(attachmentId) {
  const file = objectPath(attachmentId);
  return file ? `${file}.meta.json` : null;
}

/**
 * 生成 attachmentId（泛化前缀）。
 * @param {Uint8Array|number[]|Buffer} bytes
 * @param {string} [prefix] 默认 'img'
 */
export function attachmentIdOf(bytes, prefix = 'img') {
  const sha = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  return `${prefix}_${sha}`;
}

/**
 * 嗅探媒体类型（仅看 magic byte，不做完整解析）：
 * png/jpeg/webp/gif → image/*；pdf → application/pdf；其余按文本启发式；兜底 octet-stream。
 * @param {Buffer} buf
 * @returns {string}
 */
export function sniffMediaType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (isLikelyText(buf)) return 'text/plain';
  return 'application/octet-stream';
}

/** 文本启发式：前 512 字节要么是可打印 ASCII，要么是合法 UTF-8 多字节序列 */
function isLikelyText(buf) {
  const slice = buf.subarray(0, Math.min(512, buf.length));
  let i = 0;
  while (i < slice.length) {
    const b = slice[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) {
      i += 1;
      continue;
    }
    if (b >= 0x80) {
      // UTF-8 续字节：110xxxxx(2) / 1110xxxx(3) / 11110xxx(4)
      let need = 0;
      if ((b & 0xe0) === 0xc0) need = 1;
      else if ((b & 0xf0) === 0xe0) need = 2;
      else if ((b & 0xf8) === 0xf0) need = 3;
      else return false;
      let ok = true;
      for (let k = 1; k <= need; k += 1) {
        if (i + k >= slice.length || (slice[i + k] & 0xc0) !== 0x80) { ok = false; break; }
      }
      if (!ok) return false;
      i += need + 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * 轻量解析图片尺寸（无新依赖）：仅支持 PNG / JPEG / WebP；不支持返回 null。
 * @param {Buffer} buf
 * @returns {{width:number, height:number}|null}
 */
export function readImageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  // PNG：IHDR 在 16 字节偏移
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：扫标记段，首个 SOF 标记带尺寸
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off < buf.length - 9) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
      }
      const segLen = buf.readUInt16BE(off + 2);
      off += 2 + segLen;
    }
    return null;
  }
  // WebP：RIFF....WEBP + VP8/VP8L/VP8X
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 30) {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = (buf.readUInt32LE(24) & 0xffffff) + 1;
      const h = (buf.readUInt32LE(27) & 0xffffff) + 1;
      return { width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** 写侧车 metadata（不阻塞主流程，失败静默） */
function writeMeta(attachmentId, meta) {
  const mp = metaPath(attachmentId);
  if (!mp) return;
  try {
    fs.writeFileSync(mp, JSON.stringify(meta));
  } catch {
    /* 侧车是附加信息，写入失败不致命 */
  }
}

/**
 * 读取侧车 metadata；无侧车（旧 img_ 对象）回退 magic 嗅探。
 * @returns {{mediaType:string, width:number|null, height:number|null, bytes:number}|null}
 */
export function readAttachmentMeta(attachmentId) {
  const mp = metaPath(attachmentId);
  if (mp && fs.existsSync(mp)) {
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (m && typeof m.mediaType === 'string') return m;
    } catch {
      /* 解析失败走下方回退 */
    }
  }
  const file = objectPath(attachmentId);
  if (!file || !fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const mediaType = sniffMediaType(buf);
  const size = mediaType.startsWith('image/') ? readImageSize(buf) : null;
  return {
    mediaType,
    width: size ? size.width : null,
    height: size ? size.height : null,
    bytes: buf.length,
  };
}

/**
 * 存一张图片（幂等：同字节只落一次盘）。
 * @param {{bytes:Uint8Array|number[]|Buffer, mediaType?:string, width?:number, height?:number}} p
 * @returns {{attachmentId:string, mediaType:string, bytes:number, width:number|null, height:number|null, sha256:string}}
 */
export function saveImage(p) {
  const buf = Buffer.from(p.bytes);
  if (!buf.length) throw new Error('saveImage: 空字节');
  const sha = createHash('sha256').update(buf).digest('hex');
  const attachmentId = `img_${sha}`;
  const file = objectPath(attachmentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  const size = p.width == null || p.height == null ? readImageSize(buf) : { width: p.width, height: p.height };
  writeMeta(attachmentId, {
    mediaType: String(p.mediaType || 'image/jpeg'),
    width: size ? size.width : null,
    height: size ? size.height : null,
    bytes: buf.length,
  });
  return {
    attachmentId,
    mediaType: String(p.mediaType || 'image/jpeg'),
    bytes: buf.length,
    width: size ? size.width : null,
    height: size ? size.height : null,
    sha256: sha,
  };
}

/**
 * 存任意文件（用户上传）。前缀 `file_<sha256>`（非图片由 sniff 推断 mediaType）。
 * 写对象 + `.meta.json` 侧车（含正确 mediaType / 尺寸 / 字节数，供下载路由与前端复用）。
 * @param {{bytes:Uint8Array|number[]|Buffer, mediaType?:string, sniff?:boolean}} p
 * @returns {{attachmentId:string, mediaType:string, bytes:number, width:number|null, height:number|null, sha256:string}}
 */
export function saveFile(p) {
  const buf = Buffer.from(p.bytes);
  if (!buf.length) throw new Error('saveFile: 空字节');
  const mediaType = String(
    p.mediaType || (p.sniff ? sniffMediaType(buf) : 'application/octet-stream'),
  );
  const sha = createHash('sha256').update(buf).digest('hex');
  const attachmentId = `file_${sha}`;
  const file = objectPath(attachmentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  const size = mediaType.startsWith('image/') ? readImageSize(buf) : null;
  writeMeta(attachmentId, {
    mediaType,
    width: size ? size.width : null,
    height: size ? size.height : null,
    bytes: buf.length,
  });
  return {
    attachmentId,
    mediaType,
    bytes: buf.length,
    width: size ? size.width : null,
    height: size ? size.height : null,
    sha256: sha,
  };
}

/**
 * 读回附件字节（路由层用）。越界/非法 id 一律返回 null，不外抛路径细节。
 * @returns {{bytes:Buffer, mediaType:string}|null}
 */
export function readAttachment(attachmentId) {
  const file = objectPath(attachmentId);
  if (!file || !fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  return { bytes: buf, mediaType: sniffMediaType(buf) };
}

export function attachmentsDir() {
  return objectsRoot();
}
