// 验证事实 §8：Node 侧 pdfjs 的 getOperatorList().argsArray 是否为 null
// 目的：独立确认 "(b) Node 侧直取内嵌位图" 是否开箱可用
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PDF = 'D:/A-knowledge/agent工作流优化/03-code/storage/pdfs/1.17__software-agents.pdf'
const CANDIDATES = [
  ['03-code 6.4.299 legacy', 'D:/A-knowledge/agent工作流优化/03-code/node_modules/pdfjs-dist/legacy/build/pdf.mjs'],
  ['03-code 6.4.299 build', 'D:/A-knowledge/agent工作流优化/03-code/node_modules/pdfjs-dist/build/pdf.mjs'],
  ['harness 6.3.289 build', 'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/pdfjs-dist/build/pdf.mjs'],
]

for (const [label, entry] of CANDIDATES) {
  console.log(`\n=== ${label}`)
  console.log(`    ${entry}`)
  const origLog = console.log
  const origWarn = console.warn
  let pdfjs
  try {
    console.log = () => {}
    console.warn = () => {}
    pdfjs = await import(pathToFileURL(entry).href)
  } catch (e) {
    console.log = origLog; console.warn = origWarn
    console.log(`  import FAILED: ${e.code ?? e.message}`)
    continue
  } finally {
    console.log = origLog; console.warn = origWarn
  }
  console.log(`  version=${pdfjs.version}`)
  try {
    const data = new Uint8Array(readFileSync(PDF))
    const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
    const page = await doc.getPage(1)
    const ops = await page.getOperatorList()
    const hasFns = Array.isArray(ops.fnArray)
    console.log(`  getOperatorList: keys=${Object.keys(ops).join(',')}`)
    console.log(`  fnArray=${hasFns ? ops.fnArray.length : String(ops.fnArray)}  argsArray=${ops.argsArray === null ? 'null' : Array.isArray(ops.argsArray) ? ops.argsArray.length : String(ops.argsArray)}`)
    if (!hasFns) { console.log('  -> 无法枚举 operator，取不到 objId'); continue }
    const OPS = pdfjs.OPS
    const idx = []
    for (let i = 0; i < ops.fnArray.length; i++) if (ops.fnArray[i] === OPS.paintImageXObject) idx.push(i)
    console.log(`  paintImageXObject 命中 ${idx.length} 处`)
    for (const i of idx.slice(0, 3)) {
      const args = ops.argsArray?.[i]
      console.log(`    idx=${i} args=${args === null || args === undefined ? 'null/undefined' : JSON.stringify(Array.isArray(args) ? args.slice(0, 3) : args)}`)
    }
    // 尝试 page.objs 路径（若 args 拿不到就得靠它）
    try { console.log(`  page.objs type=${page.objs?.constructor?.name} has=${typeof page.objs?.has} get=${typeof page.objs?.get}`) } catch (e) { console.log(`  page.objs probe threw: ${e.message}`) }
    await doc.destroy()
  } catch (e) {
    console.log(`  RUN FAILED: ${e.constructor?.name}: ${e.message}`)
  }
}
