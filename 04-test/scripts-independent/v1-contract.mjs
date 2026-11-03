/**
 * 独立验证 V1：契约完整性 —— 环境/协议故障必须 throw，不得伪装成业务空值。
 * 不修改被测代码；只驱动 PageImageRenderer 的公开 API。
 *
 *   node --import tsx .tmp/verify/v1-contract.mjs
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const tempDir = join(root, '.tmp', 'verify-temp')
mkdirSync(tempDir, { recursive: true })
process.env.TEMP = tempDir
process.env.TMP = tempDir
process.env.TMPDIR = tempDir

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} :: ${detail}`)
}

const { LibraryDb } = await import('../../packages/dsh-bundle-litagent/src/service/db.ts')
const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')

const dbPath = join(root, '..', '03-code', 'data', 'app.db')
const storageRoot = join(root, '..', '03-code', 'storage', 'pdfs')
const db = new LibraryDb({ dbPath, storageRoot, allowWrite: false })
const pdf = db.assetPath('1.17')

// ---------- 1. pdf.js 资源目录残缺（只有两个 js 的"精简目录"） ----------
{
  const dir = join(root, '.tmp', 'verify', 'trim-pdfjs')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'build'), { recursive: true })
  const src = join(root, 'node_modules', 'pdfjs-dist', 'build')
  copyFileSync(join(src, 'pdf.min.mjs'), join(dir, 'build', 'pdf.min.mjs'))
  copyFileSync(join(src, 'pdf.worker.min.mjs'), join(dir, 'build', 'pdf.worker.min.mjs'))
  let error
  try {
    new PageImageRenderer({ pdfjsAssetDir: dir })
  } catch (e) {
    error = e
  }
  check(
    '① 资源目录残缺 ⇒ 构造期 throw（不是"降级为无图"）',
    error instanceof Error,
    error === undefined ? '没有抛错（危险：静默降级）' : `throw: ${error.message.slice(0, 150)}`,
  )
}

// ---------- 2. 入口文件不成对（缺 worker） ----------
{
  const dir = join(root, '.tmp', 'verify', 'no-pair')
  rmSync(dir, { recursive: true, force: true })
  for (const d of ['build', 'standard_fonts', 'cmaps']) mkdirSync(join(dir, d), { recursive: true })
  const src = join(root, 'node_modules', 'pdfjs-dist')
  copyFileSync(join(src, 'build', 'pdf.min.mjs'), join(dir, 'build', 'pdf.min.mjs'))
  // 只放一个假字体/字符映射，让"资源面"非空，专测成对断言
  writeFileSync(join(dir, 'standard_fonts', 'fake.pfb'), 'x')
  writeFileSync(join(dir, 'cmaps', 'fake.bcmap'), 'x')
  let error
  try {
    new PageImageRenderer({ pdfjsAssetDir: dir })
  } catch (e) {
    error = e
  }
  check(
    '② API/worker 不成对 ⇒ 构造期 throw（版本错配结构性排除）',
    error instanceof Error && /pdf\.worker\.min\.mjs/u.test(error.message),
    error === undefined ? '没有抛错' : `throw: ${error.message.slice(0, 150)}`,
  )
}

const renderer = new PageImageRenderer({ renderTimeoutMs: 15000 })
console.log(`renderer: pdfjs=${renderer.pdfjsVersion} chromium=${renderer.executablePath}`)

// ---------- 3. 页码越界 ⇒ reject（不是 status/空图） ----------
{
  let error
  try {
    await renderer.render({ pdfPath: pdf, pageNo: 999, maxEdge: 1500 })
  } catch (e) {
    error = e
  }
  check(
    '③ 页码越界 ⇒ reject 且消息含合法范围（R-P3 契约）',
    error instanceof Error && /out of range|越界/u.test(error.message),
    error === undefined ? '没有抛错（严重：会被读成"这页没有内容"）' : `throw: ${error.message.slice(0, 120)}`,
  )
  // 越界后渲染器应仍可用（设计：页码越界属于参数错，页面健康 ⇒ 保留复用）
  const after = await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 900, format: 'jpeg' })
  check('③b 越界报错后同页仍可渲染（错误未污染渲染页）', after.bytes.length > 1024, `${after.width}x${after.height} ${after.bytes.length}B`)
}

// ---------- 4. PDF 路径不存在 ⇒ reject ----------
{
  let error
  try {
    await renderer.render({ pdfPath: join(root, '.tmp', 'verify', 'does-not-exist.pdf'), pageNo: 1 })
  } catch (e) {
    error = e
  }
  check('④ PDF 不存在 ⇒ reject', error instanceof Error, error === undefined ? '没有抛错' : `throw: ${error.message.slice(0, 120)}`)
}

// ---------- 5. pageNo 非法（0 / 非整数）----------//
{
  const cases = [0, -1, 1.5]
  const thrown = []
  for (const pageNo of cases) {
    try {
      await renderer.render({ pdfPath: pdf, pageNo })
      thrown.push(`${pageNo}:未抛`)
    } catch (e) {
      thrown.push(`${pageNo}:throw`)
    }
  }
  check('⑤ 非法 pageNo(0/-1/1.5) 一律 throw', thrown.every((t) => t.endsWith('throw')), thrown.join(' '))
}

// ---------- 6. region 非法 ⇒ throw ----------
{
  const cases = ['middle', [0, 0, 0, 0], [0.6, 0, 0.4, 1], [0, 0, 1.2, 1]]
  const out = []
  for (const region of cases) {
    try {
      await renderer.render({ pdfPath: pdf, pageNo: 1, region })
      out.push(`${JSON.stringify(region)}:未抛`)
    } catch (e) {
      out.push(`${JSON.stringify(region)}:throw`)
    }
  }
  check('⑥ 非法 region 一律 throw', out.every((t) => t.endsWith('throw')), out.join(' '))
}

await renderer.dispose()

// ---------- 7. TEMP 不可写 ⇒ launch 失败且消息点出 TEMP（R-P3-3）----------
{
  // 只读目录用 icacls 造成（Windows 没有 chmod 语义）；子进程在 tsx 加载后才把 TEMP 指过去。
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(root, '.tmp', 'verify', 'v1-temp-child.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 180_000,
  })
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`
  const threw = out.includes('THROW::')
  const noThrow = out.includes('NO_THROW::')
  check(
    '⑦ TEMP 不可写 ⇒ throw 且消息提到 TEMP/临时目录（不得返回空图）',
    threw && /TEMP|TMP|临时目录/u.test(out),
    threw ? `THROW::${out.split('THROW::')[1]?.slice(0, 220)}` : `未抛错（NO_THROW=${noThrow}）输出首 300 字：${out.slice(0, 300)}`,
  )
}

db.close()
const failed = results.filter((r) => !r.ok)
console.log(`\nV1 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
