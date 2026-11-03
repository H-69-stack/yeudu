// P3 设计验证探针（架构师自用，不属于实现代码；不放 dsh-impl 下）
// 目的：独立验证「浏览器渲染 + 长边归一 + 象限裁剪」这三个设计前提，不采信二手结论。
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('D:/A-knowledge/agent工作流优化/dsh-impl/anchor.js')
const { chromium } = require('playwright')

const VENDOR = 'D:/A-knowledge/agent工作流优化/03-code/web/assets/vendor/pdfjs'
const FILES = {
  '4.4': 'D:/A-knowledge/agent工作流优化/03-code/storage/pdfs/4.4__a-survey-on-large-language-model-based-autonomous-agents.pdf',
  '1.17': 'D:/A-knowledge/agent工作流优化/03-code/storage/pdfs/1.17__software-agents.pdf',
}

const html = `<!doctype html><html><body style="margin:0"><canvas id="c"></canvas>
<script type="module">
const pdfjs = await import('/vendor/pdf.min.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'
window.__load = async (url) => { window.__doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise; return window.__doc.numPages }
// rect: null=整页；否则 [x0,y0,x1,y1] 归一化裁剪；longEdge=输出图（裁剪后）长边像素
window.__render = async (pageNo, longEdge, rect, type, quality) => {
  const pg = await window.__doc.getPage(pageNo)
  const vp0 = pg.getViewport({ scale: 1 })
  const fx = rect ? rect[2] - rect[0] : 1
  const fy = rect ? rect[3] - rect[1] : 1
  // 关键语义：maxEdge 约束的是【输出图】长边，因此裁剪会自动放大 scale（= 提高有效分辨率）
  const scale = longEdge / Math.max(vp0.width * fx, vp0.height * fy)
  const vp = pg.getViewport({ scale })
  const canvas = document.getElementById('c')
  canvas.width = Math.max(1, Math.floor(vp.width * fx))
  canvas.height = Math.max(1, Math.floor(vp.height * fy))
  await pg.render({
    canvasContext: canvas.getContext('2d'), viewport: vp,
    ...(rect ? { transform: [1, 0, 0, 1, -Math.floor(vp.width * rect[0]), -Math.floor(vp.height * rect[1])] } : {}),
  }).promise
  return { url: canvas.toDataURL(type, quality), w: canvas.width, h: canvas.height, scale }
}
window.__ready = true
<\/script></body></html>`

const server = createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html) }
    if (req.url.startsWith('/doc/')) {
      const key = req.url.slice(5).replace('.pdf', '')
      res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(readFileSync(FILES[key]))
    }
    if (req.url.startsWith('/vendor/')) {
      const name = req.url.slice(8)
      if (!/^(pdf(\.worker)?(\.min)?\.mjs)$/u.test(name)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(`${VENDOR}/${name}`))
    }
    res.writeHead(404); res.end()
  } catch (e) { res.writeHead(500); res.end(String(e)) }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const t0 = Date.now()
const browser = await chromium.launch()
const launchMs = Date.now() - t0
const page = await browser.newPage()
const ctx = browser

const cases = [
  ['4.4', 1, 1500, null, 'image/png', undefined],
  ['1.17', 1, 1500, null, 'image/png', undefined],
  ['1.17', 1, 1500, null, 'image/jpeg', 0.85],
  ['1.17', 1, 1500, [0, 0, 0.5, 0.5], 'image/png', undefined],    // 1/4 象限，长边铺满 1500
  ['1.17', 1, 1500, [0, 0, 0.5, 0.5], 'image/jpeg', 0.85],
  ['4.4', 1, 1500, null, 'image/jpeg', 0.85],
  ['4.4', 1, 1500, [0, 0, 0.5, 0.5], 'image/png', undefined],     // 矢量页象限
]

for (const key of Object.keys(FILES)) {
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.__ready === true)
  const pages = await page.evaluate((u) => window.__load(u), `/doc/${key}.pdf`)
  console.log(`--- ${key} pages=${pages}`)
  for (const [k, pageNo, longEdge, rect, type, q] of cases.filter(c => c[0] === key)) {
    const t = Date.now()
    const r = await page.evaluate(([p, le, rc, ty, qq]) => window.__render(p, le, rc, ty, qq), [pageNo, longEdge, rect, type, q])
    const bytes = Buffer.from(r.url.split(',')[1], 'base64').length
    const tag = `${type.split('/')[1]}${q ? '@' + q : ''}${rect ? ' crop=' + JSON.stringify(rect) : ' full'}`
    console.log(`  p${pageNo} longEdge=${longEdge} ${tag}  ${r.w}x${r.h}  ${(bytes / 1024).toFixed(0)}KB  ${Date.now() - t}ms`)
  }
}
console.log(`launch=${launchMs}ms`)
await browser.close()
server.close()
