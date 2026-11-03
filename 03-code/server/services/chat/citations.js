/**
 * 引用装配：模型给的锚点必须能查到真实 segments 行，否则丢弃（§9.6）。
 *
 * 这是本项目比 dsh 更严的一道防线，两个引擎共用：**模型输出的锚点一律不可信**，
 * 只有能在库里查到的锚点才会出现在 citations 里、才会被前端渲染成可跳转 chip。
 */
import { get } from '../../db.js';

/**
 * @param {number|null} assetId
 * @param {Array<{pageNo:number, ord:number}>} anchors
 * @returns {Array<{segmentId:number, pageNo:number, ord:number, quote:string, stale:boolean}>}
 */
export function assembleCitations(assetId, anchors) {
  if (!assetId) return [];
  const out = [];
  for (const a of anchors || []) {
    const seg = get('SELECT id, text FROM segments WHERE asset_id = ? AND page_no = ? AND ord = ?', [
      Number(assetId),
      a.pageNo,
      a.ord,
    ]);
    if (!seg) continue; // 伪造/过期锚点：丢弃，不报错
    out.push({
      segmentId: seg.id,
      pageNo: a.pageNo,
      ord: a.ord,
      quote: String(seg.text || '').slice(0, 40),
      stale: false,
    });
  }
  return out;
}
