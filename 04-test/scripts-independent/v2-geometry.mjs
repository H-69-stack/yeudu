/**
 * 独立验证 V2：maxEdge / 裁剪语义 —— 「裁剪 = 放大」，且反例 3（裁一小块但分辨率不变）不成立。
 *
 *   node --import tsx .tmp/verify/v2-geometry.mjs
 *
 * 两部分：
 *   A. 纯几何（planRender）——不启浏览器，断言算式本身；
 *   B. 真实渲染——同页整页 vs 象限，输出尺寸相同、scale 2 倍、字节内容不同（真的换了图），
 *      并把两张图落盘供人眼核对（.tmp/verify/img/）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const tempDir = join(root, '.tmp', 'verify-temp')
mkdirSync(tempDir, { recursive: true })
process.env.TEMP = tempDir
process.env.TMP = tempDir
process.env.TMPDIR = tempDir

const geo = await import('../../packages/dsh-bundle-litagent/src/service/render-geometry.ts')
const { planRender, regionRect, clampMaxEdge, coversPageFraction, pxPerCell, DEFAULT_MAX_EDGE, DEFAULT_MAX_PIXELS } = geo

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} :: ${detail}`)
}

// ---------------- A. 纯几何 ----------------
const A4 = { width: 595.28, height: 841.89 }
const full = planRender(A4, 'full', 1500, DEFAULT_MAX_PIXELS)
const quad = planRender(A4, 'top-left', 1500, DEFAULT_MAX_PIXELS)
const ratio = quad.scale / full.scale

check(
  'A1 象限 scale = 2 × 整页 scale（±1%）',
  Math.abs(ratio - 2) <= 0.02,
  `full=${full.scale.toFixed(4)} quad=${quad.scale.toFixed(4)} ratio=${ratio.toFixed(4)}（设计 R-P3-7① ±1%）`,
)
check(
  'A2 象限输出尺寸 == 整页输出尺寸（"裁剪=放大"的签名）',
  quad.width === full.width && quad.height === full.height,
  `full=${full.width}x${full.height} quad=${quad.width}x${quad.height}`,
)
// 反例 3 的"错误实现"：把 maxEdge 定在页面长边 ⇒ 象限只会得到一半尺寸。
const wrongScale = Math.min(1500 / Math.max(A4.width, A4.height), Math.sqrt(DEFAULT_MAX_PIXELS / (A4.width * A4.height)))
const wrongQuad = { width: Math.floor(A4.width * wrongScale * 0.5), height: Math.floor(A4.height * wrongScale * 0.5) }
check(
  'A3 反例 3（裁一小块、分辨率不变）不成立：输出尺寸 ≠ 半页尺寸',
  !(quad.width === wrongQuad.width && quad.height === wrongQuad.height),
  `正确=${quad.width}x${quad.height} vs 错误实现会得到 ${wrongQuad.width}x${wrongQuad.height}`,
)
const small = planRender(A4, 'full', 800, DEFAULT_MAX_PIXELS)
check(
  'A4 maxEdge=800 约束的是输出图长边（长边=800，不是页面长边）',
  Math.max(small.width, small.height) === 800,
  `${small.width}x${small.height} scale=${small.scale.toFixed(4)}`,
)
const square = planRender({ width: 1000, height: 1000 }, 'full', 1500, DEFAULT_MAX_PIXELS)
check(
  'A5 方页由 maxPixels 兜住（R-P3-8）',
  square.width * square.height <= DEFAULT_MAX_PIXELS && square.scale < 1.5,
  `${square.width}x${square.height}=${square.width * square.height} ≤ ${DEFAULT_MAX_PIXELS} scale=${square.scale.toFixed(4)}`,
)
const clamps = [undefined, 300, 5000, 1500, Number.NaN].map((v) => clampMaxEdge(v))
check('A6 clampMaxEdge 默认 1500 / 夹取 [600,2048]', JSON.stringify(clamps) === JSON.stringify([1500, 600, 2048, 1500, 1500]), JSON.stringify(clamps))
check(
  'A7 regionRect(bottom-right) = (0.5,0.5,0.5,0.5)',
  JSON.stringify(regionRect('bottom-right')) === JSON.stringify({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }),
  JSON.stringify(regionRect('bottom-right')),
)
check(
  'A8 coversPageFraction: full=1 quad=0.25',
  coversPageFraction('full') === 1 && coversPageFraction('top-right') === 0.25,
  `${coversPageFraction('full')} / ${coversPageFraction('top-right')}`,
)
const cellsFull = pxPerCell(full)
const cellsQuad = pxPerCell(quad)
check(
  'A9 pxPerCell: cellPx 恒 42，srcPxPerCell full=42 / quad=21（注：该式由 areaFraction 直接定义，断言恒真）',
  cellsFull.cellPx === 42 && cellsQuad.cellPx === 42 && cellsFull.srcPxPerCell === 42 && cellsQuad.srcPxPerCell === 21,
  `full=${JSON.stringify(cellsFull)} quad=${JSON.stringify(cellsQuad)}`,
)

// ---------------- B. 真实渲染 ----------------
const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')
const { LibraryDb } = await import('../../packages/dsh-bundle-litagent/src/service/db.ts')
const db = new LibraryDb({
  dbPath: join(root, '..', '03-code', 'data', 'app.db'),
  storageRoot: join(root, '..', '03-code', 'storage', 'pdfs'),
  allowWrite: false,
})
const renderer = new PageImageRenderer({ renderTimeoutMs: 20000 })
const pdf = db.assetPath('1.17')
const imgDir = join(root, '.tmp', 'verify', 'img')
mkdirSync(imgDir, { recursive: true })

const save = (name, buf) => {
  const p = join(imgDir, name)
  writeFileSync(p, buf)
  return p
}

const rFull = await renderer.render({ pdfPath: pdf, pageNo: 1, region: 'full', maxEdge: 1500, format: 'jpeg' })
const rTL = await renderer.render({ pdfPath: pdf, pageNo: 1, region: 'top-left', maxEdge: 1500, format: 'jpeg' })
const rBR = await renderer.render({ pdfPath: pdf, pageNo: 1, region: 'bottom-right', maxEdge: 1500, format: 'jpeg' })
const rRect = await renderer.render({ pdfPath: pdf, pageNo: 1, region: [0, 0, 0.5, 0.5], maxEdge: 1500, format: 'jpeg' })
const rSmall = await renderer.render({ pdfPath: pdf, pageNo: 1, region: 'full', maxEdge: 700, format: 'jpeg' })

save('full.jpg', rFull.bytes)
save('top-left.jpg', rTL.bytes)
save('bottom-right.jpg', rBR.bytes)

check(
  'B1 真实渲染：象限输出尺寸 == 整页输出尺寸',
  rTL.width === rFull.width && rTL.height === rFull.height,
  `full=${rFull.width}x${rFull.height} tl=${rTL.width}x${rTL.height}`,
)
check(
  'B2 真实渲染：象限 scale ≈ 2× 整页 scale',
  Math.abs(rTL.scale / rFull.scale - 2) <= 0.02,
  `full=${rFull.scale.toFixed(3)} tl=${rTL.scale.toFixed(3)} ratio=${(rTL.scale / rFull.scale).toFixed(4)}`,
)
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)
check(
  'B3 真实渲染：象限像素内容与整页不同（真的裁了，不是同一张图）',
  sha(rTL.bytes) !== sha(rFull.bytes) && sha(rBR.bytes) !== sha(rFull.bytes) && sha(rTL.bytes) !== sha(rBR.bytes),
  `full=${sha(rFull.bytes)} tl=${sha(rTL.bytes)} br=${sha(rBR.bytes)}`,
)
check(
  'B4 归一化等价：rect [0,0,0.5,0.5] 与 region=top-left 字节完全相同（缓存键已归一化）',
  sha(rRect.bytes) === sha(rTL.bytes),
  `rect=${sha(rRect.bytes)} tl=${sha(rTL.bytes)} cacheKey相同=${rRect.cacheKey === rTL.cacheKey}`,
)
check(
  'B5 maxEdge=700 ⇒ 输出长边 700（输出图语义）',
  Math.max(rSmall.width, rSmall.height) === 700,
  `${rSmall.width}x${rSmall.height}`,
)
check(
  'B6 象限字节 < 整页字节（同样 token 更少字节）',
  rTL.bytes.length < rFull.bytes.length,
  `${(rTL.bytes.length / 1024).toFixed(0)}KB < ${(rFull.bytes.length / 1024).toFixed(0)}KB`,
)
check(
  'B7 页面元数据与 region 无关（widthPt/heightPt/pageCount 同页一致）',
  rFull.page.widthPt === rTL.page.widthPt && rFull.page.pageCount === rTL.page.pageCount,
  JSON.stringify(rFull.page),
)

await renderer.dispose()
db.close()
console.log(`images: ${imgDir}`)
const failed = results.filter((r) => !r.ok)
console.log(`\nV2 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
