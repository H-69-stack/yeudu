/**
 * V1 ⑦ 的子进程：把 TEMP/TMP 指到**只读目录**后渲染一次。
 * 目的：验证 R-P3-3（TEMP 不可写）是否 throw 且消息可操作，而不是返回空图。
 *
 * 由 v1-contract.mjs 以 `node --import tsx` 启动；TEMP 在 tsx 加载**之后**才改，
 * 否则 tsx 自己的临时缓存会先失败，测不到被测代码。
 */
import { join } from 'node:path'

const root = process.cwd()
const roTemp = join(root, '.tmp', 'verify', 'ro-temp')
process.env.TEMP = roTemp
process.env.TMP = roTemp
process.env.TMPDIR = roTemp

const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')
const { LibraryDb } = await import('../../packages/dsh-bundle-litagent/src/service/db.ts')
const db = new LibraryDb({
  dbPath: join(root, '..', '03-code', 'data', 'app.db'),
  storageRoot: join(root, '..', '03-code', 'storage', 'pdfs'),
  allowWrite: false,
})
const pdf = db.assetPath('1.17')
const renderer = new PageImageRenderer({ renderTimeoutMs: 15000 })
try {
  const out = await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 600 })
  console.log(`NO_THROW::${out.width}x${out.height} ${out.bytes.length}B`)
} catch (error) {
  console.log(`THROW::${String(error?.message ?? error).replaceAll('\n', ' ')}`)
} finally {
  await renderer.dispose().catch(() => {})
  db.close()
}
