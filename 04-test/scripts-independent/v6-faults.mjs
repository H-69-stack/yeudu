/**
 * 独立验证 V6：环境/协议故障的注入（不改被测代码）。
 *
 *   node --import tsx .tmp/verify/v6-faults.mjs
 *
 * 覆盖 R-P3-1（playwright 不可解析）、R-P3-2（chromium 未安装）、
 * R-P3-6（渲染超时不得伪装成空页）、R-P3-13（取消必须传播）、R-P3-16（热渲染耗时）。
 *
 * 注入手段：
 *   - playwright 不可解析：`module.registerHooks` 的 resolve 钩子抛错（零文件改动）；
 *   - chromium 未安装：`PLAYWRIGHT_BROWSERS_PATH` 指空目录；
 *   - 超时/取消：把 renderer 的 `ensureRendererPage` 换成"永不 resolve 的假页"，
 *     这样走的是真实的 withDeadline/serialize 代码路径。
 */
import { mkdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
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

// ---------- R-P3-2：chromium 未安装 ⇒ 构造期抛错且消息给安装命令 ----------
// 必须独立进程：playwright 在模块加载时缓存浏览器注册表路径，同进程改 env 测不到真实行为。
{
  const emptyDir = join(root, '.tmp', 'verify', 'empty-browsers')
  mkdirSync(emptyDir, { recursive: true })
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(root, '.tmp', 'verify', 'v6-browsers-child.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', PLAYWRIGHT_BROWSERS_PATH: emptyDir },
    timeout: 120_000,
  })
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`
  const threw = out.includes('THROW::')
  check(
    'R-P3-2 chromium 未安装 ⇒ 构造期 throw 且提示 npx playwright install chromium',
    threw && /install chromium/u.test(out),
    threw ? out.split('THROW::')[1]?.slice(0, 200) : `未抛错：${out.slice(0, 200)}`,
  )
}

// ---------- R-P3-6 / R-P3-13：超时与取消 ----------
/**
 * 造一个"渲染永远卡住"的 renderer：假页直接放进真实 `page` 槽位，
 * 让 ensureRendererPage 复用它、超时/取消后的 discardPage() 真的会 close 它。
 * browserContext 也填上，避免走"上下文不可用"的旁路。
 */
function hangingRenderer(timeoutMs) {
  const renderer = new PageImageRenderer({ renderTimeoutMs: timeoutMs })
  const state = { closed: 0 }
  const fakePage = {
    isClosed: () => false,
    on: () => {},
    addInitScript: async () => {},
    setDefaultTimeout: () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    close: async () => {
      state.closed += 1
    },
    evaluate: () => new Promise(() => {}),
  }
  renderer.page = fakePage
  renderer.browserContext = { route: async () => {}, newPage: async () => fakePage }
  renderer.ensureBrowser = async () => ({
    version: () => 'fake-chromium',
    isConnected: () => true,
    on: () => {},
    newContext: async () => renderer.browserContext,
    close: async () => {},
  })
  return { renderer, state }
}

{
  const { renderer, state } = hangingRenderer(1200)
  const started = Date.now()
  let timeoutError
  try {
    await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 900 })
  } catch (e) {
    timeoutError = e
  }
  const elapsed = Date.now() - started
  check(
    'R-P3-6 渲染卡死 ⇒ 超时 reject（不返回空图/不返回 status）',
    timeoutError instanceof Error && /timed out|超时/u.test(timeoutError.message),
    timeoutError === undefined ? '没有抛错（危险：会把卡死读成"这页没内容"）' : `throw( ${elapsed}ms ): ${timeoutError.message.slice(0, 90)}`,
  )
  check('R-P3-6b 超时后渲染页被关闭（清理路径真的走了）', state.closed >= 1, `close() 调用 ${state.closed} 次`)
  await renderer.dispose()
}

{
  // 取消：abort 之后必须立刻 reject（不必等 1200ms 超时）
  const { renderer, state } = hangingRenderer(8000)
  const controller = new AbortController()
  const t0 = Date.now()
  setTimeout(() => controller.abort(new Error('用户取消了这次渲染')), 150)
  let abortError
  try {
    await renderer.render({ pdfPath: pdf, pageNo: 1, maxEdge: 900, signal: controller.signal })
  } catch (e) {
    abortError = e
  }
  const cancelMs = Date.now() - t0
  check(
    'R-P3-13 取消 ⇒ 立即 reject（远早于 renderTimeoutMs=8000）',
    abortError instanceof Error && /取消|abort/u.test(abortError.message) && cancelMs < 1500,
    abortError === undefined ? '没有 reject' : `${cancelMs}ms: ${abortError.message.slice(0, 80)}；close ${state.closed} 次`,
  )
  await renderer.dispose()
}

// ---------- R-P3-16：热渲染耗时（真浏览器，未命中缓存） ----------
{
  const renderer = new PageImageRenderer({ renderTimeoutMs: 20000 })
  const measure = async (region) => {
    const samples = []
    for (let i = 0; i < 5; i += 1) {
      const t = Date.now()
      // 用不同 maxEdge 打掉缓存（同成本档），测纯渲染路径
      await renderer.render({ pdfPath: pdf, pageNo: 1, region, maxEdge: 1499 - i, format: 'jpeg' })
      samples.push(Date.now() - t)
    }
    samples.sort((x, y) => x - y)
    return samples[2]
  }
  const fullMs = await measure('full')
  const quadMs = await measure('top-left')
  check('R-P3-16 热渲染整页中位数 ≤400ms', fullMs <= 400, `${fullMs}ms`)
  check('R-P3-16b 热渲染象限中位数 ≤250ms', quadMs <= 250, `${quadMs}ms`)
  await renderer.dispose()
}


// ---------- R-P3-1：playwright 不可解析 ⇒ 构造期抛错且消息可操作 ----------
// 必须独立进程：模块缓存命中 'playwright' 后 resolve 钩子不会再被调用（前面几段已加载过它）。
{
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(root, '.tmp', 'verify', 'v6-playwright-child.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 120_000,
  })
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`
  const threw = out.includes('THROW::')
  check(
    'R-P3-1 playwright 不可解析 ⇒ 构造期 throw 且消息含安装提示',
    threw && /playwright|install chromium/u.test(out),
    threw ? out.split('THROW::')[1]?.slice(0, 200) : `未抛错：${out.slice(0, 200)}`,
  )
}

db.close()
const failed = results.filter((x) => !x.ok)
console.log(`\nV6 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
