/**
 * 独立验证 V8：格式/缓存细节。
 *
 *   node --import tsx .tmp/verify/v8-cache-formats.mjs
 *
 * 1) 编码签名：jpeg → FFD8FF、png → 89504E47；mediaType 与字节一致；
 * 2) 页面内 doc LRU=2：连开 3 份不同身份（不同 mtime）的 PDF，再回到第 1 份仍能渲染；
 * 3) 进程侧结果缓存 LRU=8：9 组不同参数后 cacheSize 收敛到 8，且最老的被淘汰后仍能重渲。
 */
import { copyFileSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const tempDir = join(root, '.tmp', 'verify-temp')
mkdirSync(tempDir, { recursive: true })
process.env.TEMP = tempDir
process.env.TMP = tempDir
process.env.TMPDIR = tempDir

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} :: ${detail}`)
}

const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')
const { LibraryDb } = await import('../../packages/dsh-bundle-litagent/src/service/db.ts')
const db = new LibraryDb({
  dbPath: join(root, '..', '03-code', 'data', 'app.db'),
  storageRoot: join(root, '..', '03-code', 'storage', 'pdfs'),
  allowWrite: false,
})
const pdf = db.assetPath('1.17')
const renderer = new PageImageRenderer({ renderTimeoutMs: 20000 })

// ---- 1. 签名 ----
const jpeg = await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 700, format: 'jpeg' })
const png = await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 700, format: 'png' })
const isJpeg = jpeg.bytes[0] === 0xff && jpeg.bytes[1] === 0xd8 && jpeg.bytes[2] === 0xff
const isPng = png.bytes[0] === 0x89 && png.bytes[1] === 0x50 && png.bytes[2] === 0x4e && png.bytes[3] === 0x47
check('1a jpeg 字节签名 FFD8FF 且 mediaType=image/jpeg', isJpeg && jpeg.mediaType === 'image/jpeg', `${jpeg.bytes.length}B mediaType=${jpeg.mediaType}`)
check('1b png 字节签名 89504E47 且 mediaType=image/png', isPng && png.mediaType === 'image/png', `${png.bytes.length}B mediaType=${png.mediaType}`)
check('1c png 体积 > jpeg 同参数（设计预期，仅记录）', png.bytes.length > jpeg.bytes.length, `${(png.bytes.length / 1024).toFixed(0)}KB > ${(jpeg.bytes.length / 1024).toFixed(0)}KB`)

// ---- 2. 页面内 doc LRU=2 ----
const dir = join(root, '.tmp', 'verify', 'docs')
mkdirSync(dir, { recursive: true })
const paths = []
for (let i = 0; i < 3; i += 1) {
  const p = join(dir, `doc-${i}.pdf`)
  copyFileSync(pdf, p)
  const t = statSync(p).mtime
  utimesSync(p, t, new Date(t.getTime() + i * 60_000)) // 造 3 个不同的 docKey
  paths.push(p)
}
for (const [i, p] of paths.entries()) {
  await renderer.render({ pdfPath: p, pageNo: 1, maxEdge: 650 + i, format: 'jpeg' })
}
let reopened
try {
  reopened = await renderer.render({ pdfPath: paths[0], pageNo: 2, maxEdge: 640, format: 'jpeg' })
} catch (error) {
  reopened = { error }
}
check(
  '2 doc 缓存容量 2 淘汰后仍能重开第 1 份（LRU 淘汰不破坏可用性）',
  reopened?.error === undefined && reopened.bytes.length > 1024,
  reopened?.error === undefined ? `p2 ${reopened.width}x${reopened.height} ${reopened.bytes.length}B pageCount=${reopened.page.pageCount}` : String(reopened.error).slice(0, 120),
)

// ---- 3. 结果缓存 LRU=8 ----
for (let i = 0; i < 9; i += 1) {
  await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 700 + i * 3, format: 'jpeg' })
}
const size = renderer.cacheSize()
check('3a 结果缓存容量上限 8', size === 8, `cacheSize=${size}`)
const again = await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 700, format: 'jpeg' })
check('3b 被淘汰的键再请求能重渲（不是返回空）', again.bytes.length > 1024, `${again.width}x${again.height} ${again.bytes.length}B`)

await renderer.dispose()
db.close()
const failed = results.filter((x) => !x.ok)
console.log(`\nV8 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
