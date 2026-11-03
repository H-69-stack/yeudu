/**
 * 独立验证 V3：出网阻断（唯一网络闸门 = context.route）+ 不占端口。
 *
 *   node --import tsx .tmp/verify/v3-egress.mjs
 *
 * 不读探针结论，自己构造页面内出网尝试：
 *   1) http/https 外部域、IP 字面量、非假 origin 的任意 URL ⇒ 必须 abort；
 *   2) 渲染本地 PDF 的全过程 ⇒ 被拦计数必须为 0（没有偷偷发出去的请求）；
 *   3) 假 origin 内未知路径 ⇒ 404（不是 abort，也不是外发）；
 *   4) `data:` 资源 ⇒ 放行（否则 pdf.js 会误伤）；
 *   5) 渲染前后本机 LISTEN 端口集合不变（设计 §17-8：不占端口）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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

/** Windows：取 LISTENING 的本地地址集合（只看端口，不看 pid）。 */
function listenPorts() {
  if (process.platform !== 'win32') return null
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
  const ports = new Set()
  for (const line of out.split('\n')) {
    if (!/LISTENING/u.test(line)) continue
    const cols = line.trim().split(/\s+/u)
    const local = cols[1] ?? ''
    const port = local.split(':').pop()
    if (port) ports.add(port)
  }
  return ports
}

const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')
const { LibraryDb } = await import('../../packages/dsh-bundle-litagent/src/service/db.ts')
const db = new LibraryDb({
  dbPath: join(root, '..', '03-code', 'data', 'app.db'),
  storageRoot: join(root, '..', '03-code', 'storage', 'pdfs'),
  allowWrite: false,
})
const pdf = db.assetPath('1.17')

const before = listenPorts()
const renderer = new PageImageRenderer({ renderTimeoutMs: 20000 })

// ---- 1. 正常渲染：全过程被拦计数必须为 0 ----
const r = await renderer.render({ pdfPath: pdf, pageNo: 1, region: 'full', maxEdge: 1200, format: 'jpeg' })
check(
  '1 正常渲染本地 PDF 期间外发请求 = 0（blocked 计数为 0）',
  renderer.blockedRequestCount() === 0,
  `blocked=${renderer.blockedRequestCount()} image=${r.width}x${r.height}`,
)

// ---- 2. 页面内主动出网：三种目标都必须 BLOCKED ----
const attempts = await renderer.probeEgress()
check('2a 页面内 fetch(http://example.com/…) ⇒ BLOCKED', attempts.outcome === 'BLOCKED', `outcome=${attempts.outcome} blocked=${attempts.blocked} sentinel=${JSON.stringify(attempts.sentinel)}`)
check('2b addInitScript 哨兵记到了这次尝试（可观测）', attempts.sentinel.some((s) => s.startsWith('fetch ')), JSON.stringify(attempts.sentinel))

// 自己再加两个目标（不复用实现的探针方法）：IP 字面量 + https 域
const page = await renderer.ensureRendererPage()
const extra = await page.evaluate(async () => {
  const out = []
  for (const url of ['http://192.0.2.1/x', 'https://example.com/y', 'http://lit-page.invalid.evil.com/z']) {
    try {
      await fetch(url, { mode: 'cors' })
      out.push(`${url} → ALLOWED`)
    } catch {
      out.push(`${url} → BLOCKED`)
    }
  }
  return out
})
check(
  '2c IP 字面量 / https 外部域 / 仿冒域 一律 BLOCKED',
  extra.every((line) => line.includes('BLOCKED')),
  extra.join(' | '),
)
check(
  '2d 被拦请求确实记到了 diag.blocked（不只靠 catch）',
  renderer.blockedRequestCount() >= 4,
  `blocked=${renderer.blockedRequestCount()}`,
)

// ---- 3. 假 origin 内未知路径 ⇒ 404（不是 abort/不是外发） ----
const paths = await renderer.probeOriginPaths(['/nope.txt', '/vendor/build/../../etc/passwd', '/doc.pdf?doc=deadbeefdeadbeef'])
check(
  '3 假 origin 内未知/越界路径一律 404（origin 内没有第二个出口）',
  paths.every((p) => p.status === 404),
  paths.map((p) => `${p.path.slice(0, 40)}→${p.status}`).join(' '),
)

// ---- 4. data: 资源放行（route.continue，不 abort） ----
const dataResult = await page.evaluate(async () => {
  try {
    const res = await fetch('data:text/plain,hello')
    return `ok ${res.status} ${await res.text()}`
  } catch (error) {
    return `blocked ${String(error?.message ?? error)}`
  }
})
check('4 data: 资源放行（否则 pdf.js worker/字体可能被误拦）', dataResult.startsWith('ok 200'), dataResult)

// ---- 5. 端口：渲染前后 LISTEN 集合不变 ----
const after = listenPorts()
let portOk = null
let portDetail = '未判定（非 win32）'
if (before !== null && after !== null) {
  const added = [...after].filter((p) => !before.has(p))
  portOk = added.length === 0
  portDetail = `before=${before.size} after=${after.size} 新增=${added.join(',') || '（无）'}`
}
check('5 渲染期间不新增任何 LISTEN 端口（无本地 HTTP 服务）', portOk, portDetail)

await renderer.dispose()
db.close()
const failed = results.filter((x) => !x.ok)
console.log(`\nV3 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
