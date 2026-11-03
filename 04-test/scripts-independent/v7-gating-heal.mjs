/**
 * 独立验证 V7：披露门控（R-P3-10）+ 浏览器断开自愈（§0.5-2）+ 进程残留（R-P3-14）。
 *
 *   node --import tsx .tmp/verify/v7-gating-heal.mjs
 *
 * 崩溃注入说明：本脚本**不** kill 任何外部进程（那会误伤用户自己的 Chrome），
 * 只关掉我们自己 renderer 持有的 browser 句柄，触发真实的 `browser.on('disconnected')` 自愈路径。
 * `page.on('crash')` 需要真正的渲染页崩溃，本脚本不改配置、不制造崩溃 ⇒ 报告中记为未验证。
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

const tool = await import('../../packages/dsh-bundle-litagent/src/tools/lit-page-image.ts')
const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')
const { LibraryDb } = await import('../../packages/dsh-bundle-litagent/src/service/db.ts')

// ---------------- R-P3-10 披露门控 ----------------
const textOnly = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
const imageCapable = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
const throwing = { resolveModelInfo: async () => { throw new Error('provider 挂了') } }

const cases = [
  ['声明只有 text', textOnly, false],
  ['声明 text+image', imageCapable, true],
  ['resolve 抛错（无法判定）', throwing, true],
]
const observed = []
for (const [label, llm, expected] of cases) {
  const got = await tool.isImageCapableRoute(llm, { provider: 'deepseek', model: 'deepseek-flash' })
  observed.push({ label, got, expected })
}
check(
  'R-P3-10 text-only 路由不披露；text+image 披露；无法判定时披露（不静默藏能力）',
  observed.every((o) => o.got === o.expected),
  observed.map((o) => `${o.label}→${o.got}`).join(' / '),
)
const noSelection = await tool.isImageCapableRoute(imageCapable, {})
check('披露门控：provider/model 未定 ⇒ 披露（宁可执行期响亮报错）', noSelection === true, String(noSelection))

// ---------------- 进程数（R-P3-14） ----------------
function chromiumProcs() {
  if (process.platform !== 'win32') return null
  let total = 0
  for (const name of ['chrome.exe', 'chrome-headless-shell.exe']) {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8' })
    total += out.split('\n').filter((l) => l.toLowerCase().includes(name.toLowerCase())).length
  }
  return total
}

const db = new LibraryDb({
  dbPath: join(root, '..', '03-code', 'data', 'app.db'),
  storageRoot: join(root, '..', '03-code', 'storage', 'pdfs'),
  allowWrite: false,
})
const pdf = db.assetPath('1.17')

const procsBefore = chromiumProcs()
const renderer = new PageImageRenderer({ renderTimeoutMs: 20000 })
const first = await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 900 })
const procsLive = chromiumProcs()
check('R-P3-14a 渲染后浏览器进程存在（进程计数器没瞎）', procsBefore === null || procsLive > procsBefore, `before=${procsBefore} live=${procsLive}`)

// ---------------- 断开自愈 ----------------
const browserHandle = renderer.browser
check('自愈前置：renderer 持有 browser 句柄', browserHandle !== undefined, String(browserHandle !== undefined))
await browserHandle.close()
// 等到 disconnected 处理器跑完（事件是异步派发的）
for (let i = 0; i < 40 && renderer.isBrowserConnected(); i += 1) {
  await new Promise((r) => setTimeout(r, 50))
}
check('断开后 isBrowserConnected=false（disconnected 处理器把状态清了）', renderer.isBrowserConnected() === false, String(renderer.isBrowserConnected()))

const healed = await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 900 })
check(
  'R-P3-14b 浏览器被关掉后下一次调用能自愈（重新 launch 并出图）',
  healed.bytes.length > 1024 && renderer.isBrowserConnected() === true,
  `${healed.width}x${healed.height} ${healed.bytes.length}B connected=${renderer.isBrowserConnected()}`,
)
check('自愈后像素与断开前一致（重建不影响确定性）', Buffer.compare(Buffer.from(first.bytes), Buffer.from(healed.bytes)) === 0, `sha前=${first.bytes.length}B 后=${healed.bytes.length}B`)

await renderer.dispose()
const procsAfter = chromiumProcs()
check(
  'R-P3-14c dispose 后无残留 chromium 进程',
  procsBefore === null || procsAfter <= procsBefore,
  `before=${procsBefore} after=${procsAfter}`,
)
db.close()

const failed = results.filter((x) => !x.ok)
console.log(`\nV7 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
