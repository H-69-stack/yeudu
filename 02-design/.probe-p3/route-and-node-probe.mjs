// 验证两件事：
//  (1) 事实 §8：「Node 侧 argsArray 为 null」是否成立，以及 (b) 的完整动作（args → objs 异步 → 像素）能否走通
//  (2) 无端口方案：playwright context.route 拦截 + 假 origin 直接喂 PDF 与 pdf.js 字节（取代临时 HTTP 服务）
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PDF = 'D:/A-knowledge/agent工作流优化/03-code/storage/pdfs/1.17__software-agents.pdf'
const PDF_VECTOR = 'D:/A-knowledge/agent工作流优化/03-code/storage/pdfs/4.4__a-survey-on-large-language-model-based-autonomous-agents.pdf'
const PDFJS_03 = 'D:/A-knowledge/agent工作流优化/03-code/node_modules/pdfjs-dist/build'
const PDFJS_HARNESS = 'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/pdfjs-dist/build'

// ---------- (1) Node 侧完整动作 ----------
console.log('===== (1) Node 侧：args → objs 异步 → 像素')
{
  // 注意：Node 下必须用 legacy 构建。非 legacy 的 build/pdf.mjs 在本机会直接炸
  // （'hashOriginal.toHex is not a function' —— 依赖 TypedArray.prototype.toHex）。
  const pdfjs = await import(pathToFileURL(`${PDFJS_03.replace('/build', '/legacy/build')}/pdf.mjs`).href)
  const data = new Uint8Array(readFileSync(PDF))
  const task = pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  const page = await doc.getPage(1)
  const ops = await page.getOperatorList()
  console.log(`  fnArray=${ops.fnArray.length} argsArrayIsNull=${ops.argsArray === null}`)
  const OPS = pdfjs.OPS
  const i = ops.fnArray.findIndex((fn) => fn === OPS.paintImageXObject)
  const objId = ops.argsArray[i][0]
  console.log(`  objId 来源 = argsArray[${i}][0] = ${JSON.stringify(objId)}`)
  // 同步取（事实 §3.1 说会抛）
  let syncResult = 'no-throw'
  try { page.objs.get(objId) } catch (e) { syncResult = `${e.constructor.name}: ${e.message.slice(0, 70)}` }
  console.log(`  同步 get => ${syncResult}`)
  console.log(`  page.objs.has(objId) = ${page.objs.has(objId)}`)
  // 回调式（带超时）
  const decoded = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 5000)
    try {
      page.objs.get(objId, (obj) => { clearTimeout(timer); resolve({ obj }) })
    } catch (e) { clearTimeout(timer); resolve({ error: e.message }) }
  })
  if (decoded.obj) {
    const o = decoded.obj
    console.log(`  回调式成功: ${o.width}x${o.height} kind=${o.kind} dataLen=${o.data?.length} (期望 ${o.width * o.height * 3})`)
  } else console.log(`  回调式失败: ${JSON.stringify(decoded)}`)
  // destroy API 到底叫什么
  const kill = ['destroy', 'cleanup', 'close'].filter((m) => typeof doc[m] === 'function')
  const killTask = ['destroy', 'close'].filter((m) => typeof task[m] === 'function')
  console.log(`  doc 可用销毁方法 = [${kill.join(',')}] ；loadingTask = [${killTask.join(',')}]`)
  if (typeof task.destroy === 'function') await task.destroy()
}

// ---------- (2) route 拦截方案 ----------
console.log('\n===== (2) playwright context.route 假 origin（不占端口）')
{
  const require = createRequire('D:/A-knowledge/agent工作流优化/dsh-impl/anchor.js')
  const { chromium } = require('playwright')
  const ORIGIN = 'http://lit-page.invalid'

  for (const [label, pdfjsDir, pdfPath, pageNo] of [
    ['vendor 6.4.299 × 1.17 p1', PDFJS_03, PDF, 1],
    ['vendor 6.4.299 × 4.4 p1', PDFJS_03, PDF_VECTOR, 1],
  ]) {
    const browser = await chromium.launch()
    const ctx = await browser.newContext()
    const html = `<!doctype html><html><body><canvas id="c"></canvas>
<script type="module">
const pdfjs = await import('/pdf.min.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
window.__pdfjs = pdfjs
window.__open = async () => { window.__doc = await pdfjs.getDocument({ url: '/doc.pdf', isEvalSupported: false }).promise; return window.__doc.numPages }
window.__render = async (pageNo, longEdge, type, quality) => {
  const pg = await window.__doc.getPage(pageNo)
  const vp0 = pg.getViewport({ scale: 1 })
  const scale = longEdge / Math.max(vp0.width, vp0.height)
  const vp = pg.getViewport({ scale })
  const c = document.getElementById('c')
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height)
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise
  return { url: c.toDataURL(type, quality), w: c.width, h: c.height, scale }
}
// 试探外网是否被拦（应失败）
window.__egress = async () => { try { const r = await fetch('http://example.com/x'); return 'REACHED ' + r.status } catch (e) { return 'BLOCKED ' + e.message.slice(0, 40) } }
window.__ready = true
<\/script></body></html>`

    let fulfilCount = 0
    let externalCount = 0
    await ctx.route('**/*', async (route) => {
      const url = route.request().url()
      if (!url.startsWith(ORIGIN)) { externalCount += 1; return route.abort() }
      const path = url.slice(ORIGIN.length)
      const send = (body, ct) => { fulfilCount += 1; return route.fulfill({ status: 200, contentType: ct, body }) }
      if (path === '/' ) return send(html, 'text/html')
      if (path === '/pdf.min.mjs') return send(readFileSync(`${pdfjsDir}/pdf.min.mjs`), 'text/javascript')
      if (path === '/pdf.worker.min.mjs') return send(readFileSync(`${pdfjsDir}/pdf.worker.min.mjs`), 'text/javascript')
      if (path === '/doc.pdf') return send(readFileSync(pdfPath), 'application/pdf')
      return route.fulfill({ status: 404, body: 'nope' })
    })
    const page = await ctx.newPage()
    const t0 = Date.now()
    await page.goto(`${ORIGIN}/`)
    await page.waitForFunction(() => window.__ready === true)
    const bootMs = Date.now() - t0
    const pages = await page.evaluate(() => window.__open())
    const egress = await page.evaluate(() => window.__egress())
    const t1 = Date.now()
    const r = await page.evaluate(([p, le]) => window.__render(p, le, 'image/jpeg', 0.85), [pageNo, 1500])
    const ms = Date.now() - t1
    const bytes = Buffer.from(r.url.split(',')[1], 'base64').length
    const png = await page.evaluate(([p, le]) => window.__render(p, le, 'image/png', undefined), [pageNo, 1500])
    const pngBytes = Buffer.from(png.url.split(',')[1], 'base64').length
    console.log(`  ${label}: pages=${pages} boot=${bootMs}ms render=${ms}ms ${r.w}x${r.h} jpeg=${(bytes / 1024).toFixed(0)}KB png=${(pngBytes / 1024).toFixed(0)}KB`)
    console.log(`    route fulfill=${fulfilCount} 外网请求被拦=${externalCount} egress=${egress}`)
    await browser.close()
  }
}
