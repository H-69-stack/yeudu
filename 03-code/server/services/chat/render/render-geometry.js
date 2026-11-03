/**
 * 渲染几何——**纯函数**，零 I/O、零浏览器依赖（浏览器内与 Node 侧共用同一套算术）。
 *
 * 从 dsh-impl 的 `service/render-geometry.ts`（P3 视觉通道）移植；常量与算式保持一致，
 * 只把 TypeScript 类型换掉（本项目是纯 JS，没有 Cordis / 没有构建期类型）。
 *
 * 唯一存在理由（dsh 设计 §18-3）：`maxEdge` 约束的是**输出图**的长边，不是页面长边。
 * 因此取 1/4 象限时 scale 会自动翻倍 ⇒ 同样的 token 成本下分辨率真的提高了。
 * 这个语义极易被写错成"裁一小块、分辨率不变"，故算式只允许有本文件这一个实现。
 */

/** 4 象限预设枚举（对模型暴露的稳定名字；刻意不扩 16 块，实测收益不成立）。 */
export const REGION_PRESETS = Object.freeze({
  full: Object.freeze([0, 0, 1, 1]),
  'top-left': Object.freeze([0, 0, 0.5, 0.5]),
  'top-right': Object.freeze([0.5, 0, 1, 0.5]),
  'bottom-left': Object.freeze([0, 0.5, 0.5, 1]),
  'bottom-right': Object.freeze([0.5, 0.5, 1, 1]),
});

export const REGION_PRESET_NAMES = Object.keys(REGION_PRESETS);

/** 默认输出长边：A4 竖版在 1126×1500 时恰好 1010 vision tokens 且不被 provider 回缩。 */
export const DEFAULT_MAX_EDGE = 1500;
/** 再小会被 provider 上采样（纯浪费字节与时间），故设下限。 */
export const MIN_MAX_EDGE = 600;
/** 再大会被附件归一化降采样，故设上限。 */
export const MAX_MAX_EDGE = 2048;
/** 总像素上限默认值（≈1024 token 预算的承载能力，防方页/超宽页浪费）。 */
export const DEFAULT_MAX_PIXELS = 1_650_000;
/** provider 一个 vision token 格在送入图上的边长 = 14px patch × 3。 */
export const TOKEN_CELL_PX = 42;

/** 定点小数取整（避免浮点抖动破坏前缀稳定）。 */
export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 参数错误一律抛，消息里给合法范围（模型可据此纠正重试）。 */
function badRegion(reason) {
  throw new Error(
    `invalid region rect: ${reason}（要求 [x0,y0,x1,y1]，0 ≤ x0 < x1 ≤ 1、0 ≤ y0 < y1 ≤ 1）`,
  );
}

const isPreset = (value) => typeof value === 'string' && Object.hasOwn(REGION_PRESETS, value);
const isRectTuple = (value) =>
  Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === 'number' && Number.isFinite(v));

/**
 * 把"区域"规整成归一化矩形——几何路径的唯一入口，枚举与分数矩形在此合流。
 * @param {string|number[]} [region] 预设名或 [x0,y0,x1,y1]；省略 ⇒ 整页
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function regionRect(region = 'full') {
  if (isPreset(region)) {
    const [x0, y0, x1, y1] = REGION_PRESETS[region];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (!isRectTuple(region)) badRegion(`got ${JSON.stringify(region)}`);
  const [x0, y0, x1, y1] = region;
  if (!(x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1)) badRegion(`out of [0,1]: ${JSON.stringify(region)}`);
  if (!(x0 < x1 && y0 < y1)) badRegion(`degenerate: ${JSON.stringify(region)}`);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 由页面尺寸与约束求出渲染计划（唯一算式）。
 *
 * 双约束取小：① 输出图长边 ≤ maxEdge；② 输出总像素 ≤ maxPixels（防方页/超宽页）。
 * @param {{width:number,height:number}} vp1 页面在 scale=1 时的 viewport（pt）
 * @param {string|number[]} [region]
 * @param {number} [maxEdge]
 * @param {number} [maxPixels]
 * @returns {{scale:number,region:Object,width:number,height:number}}
 */
export function planRender(vp1, region = 'full', maxEdge = DEFAULT_MAX_EDGE, maxPixels = DEFAULT_MAX_PIXELS) {
  if (!(Number.isFinite(vp1?.width) && Number.isFinite(vp1?.height)) || vp1.width <= 0 || vp1.height <= 0) {
    throw new Error(`invalid page viewport: ${JSON.stringify(vp1)}（应给出正的 pt 宽高）`);
  }
  if (!(Number.isFinite(maxEdge) && maxEdge > 0)) throw new Error(`invalid maxEdge: ${String(maxEdge)}`);
  if (!(Number.isFinite(maxPixels) && maxPixels > 0)) throw new Error(`invalid maxPixels: ${String(maxPixels)}`);

  const r = regionRect(region);
  const wPt = vp1.width * r.w;
  const hPt = vp1.height * r.h;
  const scale = Math.min(maxEdge / Math.max(wPt, hPt), Math.sqrt(maxPixels / (wPt * hPt)));
  return {
    scale,
    region: r,
    width: Math.max(1, Math.floor(vp1.width * scale * r.w)),
    height: Math.max(1, Math.floor(vp1.height * scale * r.h)),
  };
}

/**
 * 夹取输出长边：默认 1500，落在 [600, 2048]。
 * @param {number|null|undefined} value
 * @returns {number}
 */
export function clampMaxEdge(value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return DEFAULT_MAX_EDGE;
  return Math.min(MAX_MAX_EDGE, Math.max(MIN_MAX_EDGE, Math.round(value)));
}

/** 区域覆盖整页的面积比例（0–1）；full = 1。 */
export function coversPageFraction(region = 'full') {
  const r = regionRect(region);
  return round(r.w * r.h, 3);
}

/**
 * 诊断量：provider 每个 token 格覆盖多少**源像素**（越小越清晰）。
 *
 * `srcPxPerCell = TOKEN_CELL_PX / scale`：输出相对源页面的放大倍率是 scale，
 * 所以一格 42 个输出 px 覆盖 `42 / scale` 个 72dpi 源像素。
 * 只有把实际渲染倍率算进来，这个值才能区分"裁剪=放大"与"裁小图、分辨率不变"
 * （dsh 侧旧实现只按区域面积开方，是个恒真式，已修正）。
 * @param {{scale:number}} plan
 * @returns {{cellPx:number, srcPxPerCell:number}}
 */
export function pxPerCell(plan) {
  return { cellPx: TOKEN_CELL_PX, srcPxPerCell: round(TOKEN_CELL_PX / plan.scale, 2) };
}
