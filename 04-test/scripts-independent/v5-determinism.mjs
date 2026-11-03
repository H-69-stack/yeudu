/**
 * 独立验证 V5：确定性 + 缓存失效。
 *
 *   node --import tsx .tmp/verify/v5-determinism.mjs
 *
 * 1) 打印 `DIGEST=<sha256>`（由 shell 起**两个独立进程**比对；同版本内必须一致）；
 * 2) 同一进程内相同参数 → 命中缓存、字节一致；
 * 3) 复制一份 PDF 到 .tmp，渲染后改 mtime ⇒ cacheKey 变化（R-P3-17：缓存不拿旧 PDF）；
 * 4) 内容相同但 mtime 变了 ⇒ 像素应一致（说明 mtime 只进键、不影响渲染结果）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const tempDir = join(root, '.tmp', 'verify-temp')
mkdirSync(tempDir, { recursive: true })
process.env.TEMP = tempDir
process.env.TMP = tempDir
process.env.TMPDIR = tempDir

const sha = (b) => createHash('sha256').update(b).digest('hex')
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
const renderer = new PageImageRenderer({ renderTimeoutMs: 20000 })
const pdf = db.assetPath('1.17')

const a = await renderer.render({ pdfPath: pdf, pageNo: 1, region: 'full', maxEdge: 1500, format: 'jpeg' })
const b = await renderer.render({ pdfPath: pdf, pageNo: 1, region: 'full', maxEdge: 1500, format: 'jpeg' })
check('1 同参数两次 ⇒ 字节一致（同进程）', sha(a.bytes) === sha(b.bytes), `sha256:${sha(a.bytes).slice(0, 16)} x2`)
console.log(`DIGEST=${sha(a.bytes)}`)

// ---- 3/4. mtime 失效 ----
const copyPath = join(root, '.tmp', 'verify', 'copy-1.17.pdf')
mkdirSync(join(root, '.tmp', 'verify'), { recursive: true })
copyFileSync(pdf, copyPath)
const before = await renderer.render({ pdfPath: copyPath, pageNo: 1, region: 'full', maxEdge: 1500, format: 'jpeg' })
const t = statSync(copyPath).mtime
utimesSync(copyPath, t, new Date(t.getTime() + 60_000))
const after = await renderer.render({ pdfPath: copyPath, pageNo: 1, region: 'full', maxEdge: 1500, format: 'jpeg' })
check(
  '2 mtime 改变 ⇒ cacheKey 改变（R-P3-17 缓存不拿旧 PDF）',
  before.cacheKey !== after.cacheKey,
  `before=${before.cacheKey.slice(-24)} after=${after.cacheKey.slice(-24)}`,
)
check(
  '3 mtime 只进缓存键、不影响像素（内容相同 ⇒ 字节一致）',
  sha(before.bytes) === sha(after.bytes),
  `sha256:${sha(before.bytes).slice(0, 16)} vs ${sha(after.bytes).slice(0, 16)}`,
)
check('4 复制件的像素与原文件一致（同内容同渲染）', sha(before.bytes) === sha(a.bytes), `sha256:${sha(before.bytes).slice(0, 16)}`)

await renderer.dispose()
db.close()
const failed = results.filter((x) => !x.ok)
console.log(`\nV5 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
