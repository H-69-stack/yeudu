/**
 * 每页图形区域（M4 / schema v5 `page_figures`）。
 *
 * 目标：给前端「在译文页上贴原图裁片」提供每页 3–8 个候选矩形。
 *  1. 从 `page.getOperatorList()` 里收集**墨迹**：位图绘制（paintImageXObject 等）
 *     与矢量路径（constructPath）的包围盒，经 CTM 变换到 PDF 用户空间。
 *  2. 把相互靠近/重叠的墨迹聚成一簇（并查集 + 外扩容差），重叠框在这里被合并。
 *  3. 用「文字占格覆盖率」剔除其实是文字框的簇（表格线、段落下划线之类）。
 *  4. 用「未被文字覆盖的白色区域」补足候选（只在已有墨迹簇的页上启用）。
 *
 * 坐标口径：**PDF 点、y 向上、原点在左下角**，与 `segments.bbox` 完全一致
 * （前端用同一个 `convertToViewportPoint` 换算）。矩形一律写成 `[x0, y0, x1, y1]`。
 *
 * 已知限制：detectPageFigures 只用 transform/CTM 近似位图矩形（pdf.js 把图像画在单位正方形上，
 * 见 pdf.mjs 里 `ctx.scale(1/width, -1/height)`），不解析图像像素内容；扫描件（整页位图）
 * 会被「面积 > 92% 页面积」这条规则剔除 —— 那属于 needs_ocr 路径，不该当成插图。
 */

export const FIGURE_VERSION = 1;

/** 检测参数（全部可覆盖，便于用真实文献调阈值） */
export const FIGURE_DEFAULTS = {
  cell: 6, // 文字占格网格边长（pt）
  clusterPadX: 10, // 墨迹聚簇的水平容差（pt）
  clusterPadY: 12, // 墨迹聚簇的垂直容差（pt）
  minBoxAreaPct: 1.2, // 候选框最小面积（占页面积 %）
  minBoxWidthPct: 10, // 候选框最小宽度（占页宽 %）
  minBoxHeightPct: 3, // 候选框最小高度（占页高 %）
  maxPageCoverPct: 85, // 超过则视为整页背景（扫描件/底色）——整页图贴回译文页会把译文整页盖住
  maxTextCover: 0.55, // 文字覆盖率超过则不是图（表格线、下划线）
  maxBoxes: 8,
  minBoxes: 3, // 有墨迹的页至少要给这么多个候选（不足时用白区补）
  whiteHoleAreaPct: 2.5, // 白区候选最小面积（占页面积 %）
};

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** 2×3 仿射矩阵乘法（pdf.js `Util.transform` 同一约定，a b c d e f） */
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 把用户空间矩形 (0,0)-(1,1)（图像）/ 任意矩形经矩阵变换后的 AABB */
function mappedBox(m, x0, y0, x1, y1) {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
  }
  return [bx0, by0, bx1, by1];
}

function normBox(b) {
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

function areaOf(b) {
  const w = Math.max(0, b[2] - b[0]);
  const h = Math.max(0, b[3] - b[1]);
  return w * h;
}

function intersect(a, b) {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function intersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function union(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function expandBox(b, padX, padY) {
  return [b[0] - padX, b[1] - padY, b[2] + padX, b[3] + padY];
}

function isWhiteRgb(args) {
  if (!Array.isArray(args) || args.length < 3) return false;
  const [r, g, b] = args;
  return r >= 245 && g >= 245 && b >= 245;
}

/**
 * 从 operator list 收集墨迹框。
 *
 * CTM 追踪：`save/restore` 与 `paintFormXObjectBegin/End` 都是栈操作；
 * `transform`（cm）是 `ctm = ctm × m`。位图绘制落在单位正方形上（pdf.js 内部
 * 先 `ctx.scale(1/width, -1/height)`），所以取 (0,0)-(1,1) 四点变换即得实际矩形。
 *
 * @param {{fnArray:number[], argsArray:any[]}} opList
 * @param {Object} ops pdfjs 的 `OPS` 枚举
 * @returns {Array<{box:number[], kind:'image'|'path', white:boolean}>}
 */
export function collectInkBoxes(opList, ops) {
  const fnArray = (opList && opList.fnArray) || [];
  const argsArray = (opList && opList.argsArray) || [];
  const out = [];
  if (!ops || !fnArray.length) return out;

  const formBegin = ops.paintFormXObjectBegin;
  const formEnd = ops.paintFormXObjectEnd;
  const transformOp = ops.transform;
  const imageOps = new Set(
    [ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject, ops.paintJpegXObject, ops.paintSolidColorImageMask].filter(
      (v) => v !== undefined,
    ),
  );
  const pathOp = ops.constructPath;

  let ctm = IDENTITY;
  let fillWhite = false;
  const stack = [];

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === ops.save) {
      stack.push({ ctm, fillWhite });
      continue;
    }
    if (fn === ops.restore) {
      const s = stack.pop();
      if (s) {
        ctm = s.ctm;
        fillWhite = s.fillWhite;
      }
      continue;
    }
    if (fn === transformOp) {
      if (Array.isArray(args) && args.length === 6 && args.every((v) => Number.isFinite(v))) ctm = mul(ctm, args);
      continue;
    }
    if (fn === formBegin) {
      stack.push({ ctm, fillWhite });
      if (Array.isArray(args) && Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
      continue;
    }
    if (fn === formEnd) {
      const s = stack.pop();
      if (s) {
        ctm = s.ctm;
        fillWhite = s.fillWhite;
      }
      continue;
    }
    if (fn === ops.setFillRGBColor) {
      fillWhite = isWhiteRgb(args);
      continue;
    }
    if (fn === ops.setFillGray) {
      fillWhite = Array.isArray(args) && Number(args[0]) >= 0.96;
      continue;
    }
    if (fn === ops.setFillColor || fn === ops.setFillColorN) {
      // 颜色空间/图案名不可解析时按「非纯白」处理（宁可多留一个框）
      fillWhite = false;
      continue;
    }
    if (imageOps.has(fn)) {
      const box = normBox(mappedBox(ctm, 0, 0, 1, 1));
      if (areaOf(box) > 1) out.push({ box, kind: 'image', white: false });
      continue;
    }
    if (fn === pathOp) {
      // v6：args = [subOp, matrixArray|null, bboxObject]；bboxObject 的键是 "0".."3"
      const bbox = Array.isArray(args) ? args[2] : null;
      let local = null;
      if (bbox && typeof bbox === 'object') {
        const x0 = Number(bbox[0]);
        const y0 = Number(bbox[1]);
        const x1 = Number(bbox[2]);
        const y1 = Number(bbox[3]);
        if ([x0, y0, x1, y1].every((v) => Number.isFinite(v)) && x1 > x0 && y1 > y0) local = [x0, y0, x1, y1];
      }
      if (!local) continue;
      const m = Array.isArray(args[1]) && args[1].length ? (Array.isArray(args[1][0]) ? args[1][0] : args[1]) : null;
      let box = normBox(mappedBox(ctm, local[0], local[1], local[2], local[3]));
      if (m && m.length === 6 && m.every((v) => Number.isFinite(v)) && Math.abs(m[0]) <= 1.001 && Math.abs(m[3]) <= 1.001) {
        // 路径自带矩阵时（pdf.js 会把「建路径时的变换」塞进 args[1]），先按它把局部 bbox 变换一次
        const inner = normBox(mappedBox(m, local[0], local[1], local[2], local[3]));
        if (areaOf(inner) > 1) box = normBox(mappedBox(ctm, inner[0], inner[1], inner[2], inner[3]));
      }
      if (areaOf(box) > 2) out.push({ box, kind: 'path', white: fillWhite });
    }
  }
  return out;
}

/**
 * 文字占格网格：用来算「一个矩形里有多少被文字覆盖」。
 * item 的 transform 是基线位置，字形大致落在 [y-0.25h, y+0.8h]。
 */
function buildTextGrid(items, width, height, cell) {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const grid = new Uint8Array(cols * rows);
  const mark = (x0, y0, x1, y1) => {
    const c0 = Math.max(0, Math.floor(x0 / cell));
    const c1 = Math.min(cols - 1, Math.ceil(x1 / cell) - 1);
    const r0 = Math.max(0, Math.floor(y0 / cell));
    const r1 = Math.min(rows - 1, Math.ceil(y1 / cell) - 1);
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) grid[r * cols + c] = 1;
  };
  let tx0 = Infinity;
  let ty0 = Infinity;
  let tx1 = -Infinity;
  let ty1 = -Infinity;
  for (const it of items || []) {
    const tr = it && it.transform;
    if (!tr) continue;
    const w = Number(it.width) || 0;
    const h = Number(it.height) || 0;
    if (!(w > 0)) continue;
    const x = tr[4];
    const y = tr[5];
    const box = [x, y - 0.25 * h, x + w, y + 0.8 * h];
    mark(box[0], box[1], box[2], box[3]);
    if (it.str && String(it.str).trim()) {
      tx0 = Math.min(tx0, box[0]);
      ty0 = Math.min(ty0, box[1]);
      tx1 = Math.max(tx1, box[2]);
      ty1 = Math.max(ty1, box[3]);
    }
  }
  return {
    grid,
    cols,
    rows,
    cell,
    covered(box) {
      const c0 = Math.max(0, Math.floor(box[0] / cell));
      const c1 = Math.min(cols - 1, Math.ceil(box[2] / cell) - 1);
      const r0 = Math.max(0, Math.floor(box[1] / cell));
      const r1 = Math.min(rows - 1, Math.ceil(box[3] / cell) - 1);
      if (c1 < c0 || r1 < r0) return 0;
      let n = 0;
      for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) n += grid[r * cols + c];
      const cells = (c1 - c0 + 1) * (r1 - r0 + 1);
      return cells ? n / cells : 0;
    },
    textBounds: Number.isFinite(tx0) ? [tx0, ty0, tx1, ty1] : null,
  };
}

/** 并查集：把相互接触（外扩容差后相交）的墨迹框聚成一簇 */
function clusterBoxes(boxes, padX, padY) {
  const n = boxes.length;
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  for (let i = 0; i < n; i += 1) {
    const a = expandBox(boxes[i].box, padX, padY);
    for (let j = i + 1; j < n; j += 1) {
      if (!intersects(a, boxes[j].box)) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[rj] = ri;
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(boxes[i]);
  }
  return [...groups.values()];
}

/** 在「空闲格」里找最大的若干个矩形（直方图法，确定性） */
function largestEmptyRects(grid, cols, rows, scale, limit) {
  const free = new Uint8Array(cols * rows);
  for (let i = 0; i < free.length; i += 1) free[i] = grid[i] ? 0 : 1;
  const out = [];
  for (let k = 0; k < limit; k += 1) {
    const height = new Int32Array(cols).fill(0);
    let best = { area: 0, c0: 0, c1: 0, r0: 0, r1: 0 };
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) height[c] = free[r * cols + c] ? height[c] + 1 : 0;
      // 单调栈求以本行为底的最大矩形
      const stack = [];
      for (let c = 0; c <= cols; c += 1) {
        const h = c === cols ? 0 : height[c];
        while (stack.length && height[stack[stack.length - 1]] >= h) {
          const top = stack.pop();
          const left = stack.length ? stack[stack.length - 1] + 1 : 0;
          const w = c - left;
          const hh = height[top];
          const area = w * hh;
          if (area > best.area) best = { area, c0: left, c1: c - 1, r0: r - hh + 1, r1: r };
        }
        stack.push(c);
      }
    }
    if (!best.area) break;
    out.push([
      best.c0 * scale,
      best.r0 * scale,
      (best.c1 + 1) * scale,
      (best.r1 + 1) * scale,
    ]);
    for (let r = best.r0; r <= best.r1; r += 1) for (let c = best.c0; c <= best.c1; c += 1) free[r * cols + c] = 0;
  }
  return out;
}

/**
 * 检测一页的图区。
 * @param {{width:number, height:number, items:Array, ink?:Array<{box:number[],kind:string,white:boolean}>}} page
 * @param {Object} [opts]
 * @returns {{width:number, height:number, boxes:number[][], stats:Object}}
 */
export function detectPageFigures(page, opts = {}) {
  const o = { ...FIGURE_DEFAULTS, ...opts };
  const width = Number(page && page.width) > 0 ? Number(page.width) : 0;
  const height = Number(page && page.height) > 0 ? Number(page.height) : 0;
  const stats = { ink: 0, clusters: 0, kept: 0, whiteHoles: 0, textCover: 0 };
  if (!width || !height) return { width, height, boxes: [], stats };

  const pageArea = width * height;
  const text = buildTextGrid(page.items, width, height, o.cell);

  // 1) 墨迹 → 清洗（越界裁剪、过小、纯白大底）→ 聚簇
  const ink = (page.ink || [])
    .map((it) => ({ ...it, box: normBox(it.box) }))
    .filter((it) => {
      const box = it.box;
      if (!(areaOf(box) > 2)) return false;
      if (it.white && areaOf(box) >= 0.01 * pageArea) return false; // 白色铺底不可见
      const inter = intersect(box, [0, 0, width, height]);
      return areaOf(inter) >= 0.5 * areaOf(box);
    })
    .map((it) => ({ ...it, box: intersect(it.box, [0, 0, width, height]) }));
  stats.ink = ink.length;
  const clusters = clusterBoxes(ink, o.clusterPadX, o.clusterPadY);
  stats.clusters = clusters.length;

  const minArea = (o.minBoxAreaPct / 100) * pageArea;
  const minW = (o.minBoxWidthPct / 100) * width;
  const minH = (o.minBoxHeightPct / 100) * height;
  const candidates = [];
  for (const members of clusters) {
    let box = members[0].box;
    for (const m of members) box = union(box, m.box);
    const a = areaOf(box);
    if (a < minArea || box[2] - box[0] < minW || box[3] - box[1] < minH) continue;
    if (a >= (o.maxPageCoverPct / 100) * pageArea) continue; // 整页底色/扫描件
    const cover = text.covered(box);
    const hasImage = members.some((m) => m.kind === 'image');
    if (!hasImage && cover > o.maxTextCover) continue; // 表格线/段落装饰
    if (hasImage && cover > 0.92) continue; // 整页位图
    const memberInk = members.reduce((s, m) => s + areaOf(m.box), 0);
    const density = Math.min(1, memberInk / Math.max(a, 1));
    const score = a * (1 - 0.6 * cover) * (hasImage ? 1.35 : 1) * (0.55 + 0.45 * density);
    candidates.push({ box, score, cover, hasImage, members: members.length });
  }

  // 2) 白区补充：只在「这页确实有墨迹」时启用，补到 minBoxes 个（最多 maxBoxes）
  let boxes = candidates.map((c) => c.box);
  if (boxes.length && boxes.length < o.minBoxes && text.textBounds) {
    const region = intersect(
      [text.textBounds[0] - 2, text.textBounds[1] - 2, text.textBounds[2] + 2, text.textBounds[3] + 2],
      [0, 0, width, height],
    );
    const c0 = Math.max(0, Math.floor(region[0] / o.cell));
    const r0 = Math.max(0, Math.floor(region[1] / o.cell));
    const c1 = Math.min(text.cols - 1, Math.ceil(region[2] / o.cell) - 1);
    const r1 = Math.min(text.rows - 1, Math.ceil(region[3] / o.cell) - 1);
    if (c1 > c0 && r1 > r0) {
      const sub = new Uint8Array((c1 - c0 + 1) * (r1 - r0 + 1));
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          // 已被文字或已有图框占住的格子都算“不可用”
          let occ = text.grid[r * text.cols + c];
          if (!occ) {
            const cellBox = [c * o.cell, r * o.cell, (c + 1) * o.cell, (r + 1) * o.cell];
            occ = boxes.some((b) => intersects(b, cellBox)) ? 1 : 0;
          }
          sub[(r - r0) * (c1 - c0 + 1) + (c - c0)] = occ;
        }
      }
      const holes = largestEmptyRects(sub, c1 - c0 + 1, r1 - r0 + 1, o.cell, o.minBoxes);
      const minHoleArea = (o.whiteHoleAreaPct / 100) * pageArea;
      for (const h of holes) {
        const box = [h[0] + c0 * o.cell, h[1] + r0 * o.cell, h[2] + c0 * o.cell, h[3] + r0 * o.cell];
        const a = areaOf(box);
        if (a < minHoleArea) continue;
        const ar = (box[2] - box[0]) / Math.max(1, box[3] - box[1]);
        if (ar < 0.25 || ar > 6) continue;
        if (boxes.some((b) => areaOf(intersect(b, box)) > 0.2 * a)) continue; // 与已有框重合过多
        boxes.push(box);
        stats.whiteHoles += 1;
        if (boxes.length >= o.minBoxes) break;
      }
    }
  }

  // 3) 合并重叠框（IoU > 0.15 或一方覆盖另一方 60% 以上 → 取并集），再按面积取舍
  boxes = mergeOverlapping(boxes);

  // 4) 排序 + 截断：先按上沿（y 大）再按左沿，保证确定性
  boxes.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  if (boxes.length > o.maxBoxes) boxes = boxes.slice(0, o.maxBoxes);
  stats.kept = boxes.length;
  stats.textCover = Number((text.covered(boxes.length ? unionAll(boxes) : [0, 0, 0, 0]) || 0).toFixed(3));
  return {
    width,
    height,
    boxes: boxes.map((b) => [round(b[0]), round(b[1]), round(b[2]), round(b[3])]),
    stats,
  };
}

/**
 * 用图注反推图区（第二遍）。
 *
 * 为什么需要它：本库很多插图**整幅是文字/符号字形**（asset 5 p1 的 Figure 1 就是 405 个
 * showText 画出来的，operator list 里既没有位图也没有路径），墨迹检测拿不到任何框。
 * 这类页唯一可靠的锚点是图注：图注上方那段「没有正文、却也没被判成图」的空白就是图。
 *
 * 规则（确定性）：
 *  - 只处理 role='caption' 的段；
 *  - 已经落在某个候选框 45pt 内的图注不再造框（避免重复）；
 *  - 图注上方找最近的正文段底边（y0）作为上界，上界与图注顶边的间距 ≥ 60pt 才成立；
 *  - 横向沿用图注的 x 范围，允许向两侧各扩 12pt（图通常比图注宽），
 *    宽度不足 30% 页宽时以图注中心对称扩到 30%；
 *  - 新框面积 ≥ 2% 页面积，最后并进该页候选框并重新合并重叠框。
 *
 * @param {Map<number, number[][]>} figuresByPage 第一遍（墨迹）结果，会被就地补全
 * @param {Array<{pageNo:number,width:number,height:number,paras:Array}>} pages buildPagesFromRaw 的输出
 * @param {Object} [opts]
 * @returns {{added:number, pages:number}}
 */
export function attachCaptionAnchors(figuresByPage, pages, opts = {}) {
  const o = { maxNearDist: 45, minGap: 60, minAreaPct: 2, ...opts };
  let added = 0;
  let touched = 0;
  for (const page of pages || []) {
    const w = Number(page.width) || 0;
    const h = Number(page.height) || 0;
    if (!w || !h) continue;
    const boxes = (figuresByPage.get(page.pageNo) || []).map((b) => [...b]);
    const paras = (page.paras || []).filter((p) => Array.isArray(p.bbox));
    const captions = paras.filter((p) => p.role === 'caption');
    if (!captions.length) continue;
    let localAdded = 0;
    for (const cap of captions) {
      const [cx0, cy0, cx1, cy1] = cap.bbox;
      const near = boxes.some(
        (b) =>
          Math.min(b[2], cx1) - Math.max(b[0], cx0) > 0.3 * Math.max(1, Math.min(b[2] - b[0], cx1 - cx0)) &&
          (b[1] - cy1 <= o.maxNearDist || cy0 - b[3] <= o.maxNearDist),
      );
      if (near) continue;
      // 图可以在图注上方（IEEE 老论文常见）也可以在下方（`Fig. 3` 在页顶、图在标题下面）。
      // 两个方向都量一遍，取间距更大的那一侧。
      //
      // 只量**同栏**的段：双栏页里图注上方往往紧贴着另一栏的正文，纯按 y 量会把那个
      // 正文的底边当成图的边界，gap 永远 <60pt（asset 5 p4/p5 就因此一个图都框不出来）。
      // 图内标注（figure-label）也要跳过——它们本来就画在图的空白里，会把 gap 截断。
      const capW = Math.max(1, cx1 - cx0);
      const inColumn = (b) => Math.min(cx1, b[2]) - Math.max(cx0, b[0]) > 0.3 * capW;
      let limitTop = h;
      let limitBottom = 0;
      let labelTop = 0;
      for (const p of paras) {
        if (p === cap) continue;
        const b = p.bbox;
        if (!inColumn(b)) continue;
        if (p.role === 'figure-label') {
          // 图内标注：不算边界，但它的上沿就是图的上沿（比空档更可靠）
          if (b[1] >= cy1 - 2 && b[3] > labelTop) labelTop = b[3];
          continue;
        }
        if (b[1] >= cy1 - 2 && b[1] < limitTop) limitTop = b[1]; // 底边高于图注顶边
        if (b[3] <= cy0 + 2 && b[3] > limitBottom) limitBottom = b[3]; // 顶边低于图注底边
      }
      // 同栏上方没有任何文字（图注上方就是页顶/页眉）时，用图内标注的上沿；
      // 连标注都没有（整幅是位图/截图）就按页面高度的 42% 封顶，避免把页眉上方
      // 的空白整片框进来。
      if (limitTop === h && labelTop > 0) limitTop = labelTop + 12;
      else if (limitTop === h) limitTop = Math.min(h - 36, cy1 + 0.42 * h);
      const gapAbove = limitTop - cy1;
      const gapBelow = cy0 - limitBottom;
      // IEEE 老论文绝大多数是「图在上、图注在下」，所以下方没有明显更大的空档时留在上方。
      const useAbove = gapAbove * 1.25 >= gapBelow;
      const gap = useAbove ? gapAbove : gapBelow;
      if (gap < o.minGap) continue;
      let box = useAbove ? [cx0, cy1 + 6, cx1, limitTop - 6] : [cx0, limitBottom + 6, cx1, cy0 - 6];
      // 图注常常比图窄得多（居中单行 "Fig. 5. Level 0 control system."），
      // 单靠图注宽度框不到图：把落在该带内的图内标注一起圈进来。
      let lx0 = box[0];
      let lx1 = box[2];
      for (const p of paras) {
        if (p.role !== 'figure-label') continue;
        const b = p.bbox;
        if (b[3] < box[1] - 2 || b[1] > box[3] + 2) continue;
        if (b[0] < lx0) lx0 = b[0];
        if (b[2] > lx1) lx1 = b[2];
      }
      box = [Math.max(0, lx0 - 12), box[1], Math.min(w, lx1 + 12), box[3]];
      if (box[2] - box[0] < 0.3 * w) {
        const c = (box[0] + box[2]) / 2;
        box = [Math.max(0, c - 0.15 * w), box[1], Math.min(w, c + 0.15 * w), box[3]];
      }
      // 窄图注（"Fig. 8. Simulated robot"）落在哪一栏，就把框对齐到那一栏的版心，
      // 免得裁片只截到图的一半。
      const snap = columnSnap(paras, (cx0 + cx1) / 2);
      if (snap && box[2] - box[0] < 0.42 * w) {
        box = [Math.max(0, Math.min(box[0], snap[0] - 8)), box[1], Math.min(w, Math.max(box[2], snap[1] + 8)), box[3]];
      }
      if (box[3] - box[1] < o.minGap * 0.5) continue;
      if ((box[2] - box[0]) * (box[3] - box[1]) < (o.minAreaPct / 100) * w * h) continue;
      boxes.push(box);
      localAdded += 1;
      added += 1;
    }
    if (localAdded) {
      const merged = mergeOverlapping(boxes);
      merged.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
      figuresByPage.set(page.pageNo, merged.slice(0, FIGURE_DEFAULTS.maxBoxes).map((b) => [round(b[0]), round(b[1]), round(b[2]), round(b[3])]));
      touched += 1;
    }
  }
  return { added, pages: touched };
}

/**
 * 版心（栏）吸附：把段落的 x 范围按 40pt 容差聚成栏，返回包含 xc 的那一栏的 [x0,x1]。
 * 通栏正文（宽度超过 0.8 页宽）不算栏；找不到返回 null。
 * @param {Array<{role:string, bbox:number[]}>} paras
 * @param {number} xc 目标 x（一般用图注中心）
 * @param {number} w 页宽
 * @returns {[number, number]|null}
 */
function columnSnap(paras, xc, w) {
  const spans = [];
  for (const p of paras) {
    if (p.role === 'header' || p.role === 'figure-label') continue;
    const b = p.bbox;
    if (!b || b[2] - b[0] < 40) continue;
    spans.push([b[0], b[2]]);
  }
  if (spans.length < 2) return null;
  spans.sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [x0, x1] of spans) {
    const last = cols[cols.length - 1];
    if (last && x0 - last[0] <= 40) {
      last[0] = Math.min(last[0], x0);
      last[1] = Math.max(last[1], x1);
    } else {
      cols.push([x0, x1]);
    }
  }
  const narrow = cols.filter((c) => c[1] - c[0] < 0.8 * w);
  if (!narrow.length) return null;
  for (const c of narrow) if (xc >= c[0] - 20 && xc <= c[1] + 20) return c;
  return null;
}

function unionAll(boxes) {
  let b = boxes[0];
  for (const x of boxes.slice(1)) b = union(b, x);
  return b;
}

function mergeOverlapping(boxes) {
  let list = boxes.map((b) => [...b]);
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    const out = [];
    for (const b of list) {
      const hit = out.findIndex((o) => {
        const inter = areaOf(intersect(o, b));
        if (!(inter > 0)) return false;
        const iou = inter / Math.max(1, areaOf(o) + areaOf(b) - inter);
        const share = inter / Math.max(1, Math.min(areaOf(o), areaOf(b)));
        return iou > 0.15 || share > 0.6;
      });
      if (hit >= 0) {
        out[hit] = union(out[hit], b);
        changed = true;
      } else {
        out.push(b);
      }
    }
    list = out;
    if (!changed) break;
  }
  return list;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export default { FIGURE_VERSION, FIGURE_DEFAULTS, collectInkBoxes, detectPageFigures };
