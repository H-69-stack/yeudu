/**
 * 独立验证 V4：工具层契约 + 成本闸方向（不看编码者的测试，自己搭一棵最小 cordis 树）。
 *
 *   node --import tsx .tmp/verify/v4-tool.mjs
 *
 * 覆盖：
 *   1) status 枚举只有 ok/no_pdf；Provider throw ⇒ 工具 reject（绝不降级成 status）；
 *   2) 成本闸边界：第 20 次放行、第 21 次拒绝（used > max 而非 >=）；
 *   3) 插件重载（另起一棵树 / 新投影表）后计数不清零（读会话日志，不是内存计数）；
 *   4) seam：换成另一个假 Provider，工具层源码不变仍工作（尺寸/字节来自 Provider）；
 *   5) no_pdf 只由 assetPath===null 产生，且此时不碰引擎；
 *   6) maxCallsPerSession=0 ⇒ 不注册（模型看不到按钮）；
 *   7) image block：ok ⇒ text+image 各 1；no_pdf ⇒ 只有 text。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const tempDir = join(root, '.tmp', 'verify-temp')
mkdirSync(tempDir, { recursive: true })
process.env.TEMP = tempDir

const { Context, Service } = await import('@deepseek-ai/cordis')
const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { default: SystemPromptService } = await import('@deepseek-ai/dsh-system-prompt')
const { default: ToolsService } = await import('@deepseek-ai/dsh-tools')
const { default: PageImageUsage } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-usage.ts')
const tool = await import('../../packages/dsh-bundle-litagent/src/tools/lit-page-image.ts')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} :: ${detail}`)
}

class FakePageImages extends Service {
  static inject = []
  renders = 0
  fail = null
  constructor(ctx) {
    super(ctx, 'pageImages')
  }
  async render(request) {
    this.renders += 1
    if (this.fail) throw this.fail
    return {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x11, 0x22, 0x33]),
      mediaType: 'image/jpeg',
      width: 777,
      height: 999,
      scale: 1.234,
      rect: [0, 0, 1, 1],
      page: { widthPt: 570, heightPt: 759, pageCount: 8 },
      cacheKey: `fake|${request.pageNo}|${request.region}`,
    }
  }
  async dispose() {}
}

class StubLibrary extends Service {
  constructor(ctx) {
    super(ctx, 'library')
  }
  assetPath(no) {
    return no === '9.99' ? null : `/fake/${no}.pdf`
  }
}

class StubAttachments extends Service {
  saves = 0
  constructor(ctx) {
    super(ctx, 'attachments')
  }
  async saveImage(input) {
    this.saves += 1
    return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: input.mediaType, bytes: input.data.length, width: 777, height: 999 }
  }
}

class StubLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
  }
  async resolveModelInfo() {
    return { inputModalities: ['text', 'image'] }
  }
}

async function mount({ session, maxCallsPerSession = 20 } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPromptService)
  await ctx.plugin(ToolsService)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(StubLibrary)
  await ctx.plugin(StubAttachments)
  await ctx.plugin(StubLlm)
  await ctx.plugin(PageImageUsage)
  await ctx.plugin(FakePageImages)
  await ctx.plugin(tool, { maxCallsPerSession })
  const definition = ctx.tools.get('lit_page_image')
  const pageImages = ctx.get('pageImages')
  const attachments = ctx.get('attachments')
  const usage = ctx.get('pageImageUsage')
  // 真 Session：只补 requestHeader（工具用它做执行期路由复核）
  const s = session ?? Session.create(SessionId(`s-${Math.random().toString(36).slice(2, 8)}`))
  if (!Object.hasOwn(s, 'requestHeader')) {
    Object.defineProperty(s, 'requestHeader', {
      value: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }),
      configurable: true,
    })
  }
  const exec = {
    signal: new AbortController().signal,
    agent: { session: s, options: { provider: 'deepseek', model: 'deepseek-flash' } },
  }
  return { ctx, definition, pageImages, attachments, usage, session: s, exec, dispose: () => ctx.fiber.dispose() }
}

/** 模拟工具执行器：`tool/call` 在 execute **之前**入日志（packages/core/tools/src/batch.ts）。 */
function beginCall(session, callId, name = 'lit_page_image') {
  session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
}

// ---------------- 1. status 枚举 ----------------
{
  const rig = await mount()
  const statusEnum = rig.definition.output.schema.properties.status.enum
  check('1a output.status 枚举恰好 [ok, no_pdf]（结构上排除第三态）', JSON.stringify(statusEnum) === JSON.stringify(['ok', 'no_pdf']), JSON.stringify(statusEnum))
  check('1b 工具已注册（真 cordis 树）', rig.definition !== undefined, `name=${rig.definition?.name}`)
  await rig.dispose()
}

// ---------------- 2. Provider throw ⇒ 工具 reject（不降级成 status） ----------------
{
  const rig = await mount()
  rig.pageImages.fail = new Error('lit_page_image: render timed out after 8000ms（页面渲染超时）。')
  beginCall(rig.session, 'c-fail')
  let error
  try {
    await rig.definition.execute({ no: '1.17', pageNo: 1 }, rig.exec)
  } catch (e) {
    error = e
  }
  check(
    '2 引擎报错 ⇒ 工具 reject（绝不返回 status:"no_pdf"/空图）',
    error instanceof Error && /timed out|渲染超时/u.test(error.message),
    error === undefined ? '被吞成了正常返回（严重契约破坏）' : `throw: ${error.message.slice(0, 90)}`,
  )
  await rig.dispose()
}

// ---------------- 3. 成本闸：第 20 次放行 / 第 21 次拒绝 ----------------
{
  const rig = await mount()
  const s = rig.session
  // 前 19 次历史调用（每次都真的执行一遍，模拟真实会话）
  let okCount = 0
  for (let i = 1; i <= 19; i += 1) {
    beginCall(s, `hist-${i}`)
    const v = await rig.definition.execute({ no: '1.17', pageNo: 1 }, rig.exec)
    if (v.status === 'ok') okCount += 1
  }
  // 第 20 次
  beginCall(s, 'call-20')
  const twentieth = await rig.definition.execute({ no: '1.17', pageNo: 1 }, rig.exec)
  check('3a 第 20 次调用被放行（used=20 不超上限）', twentieth.status === 'ok', `status=${twentieth.status} 已成功 ${okCount}+1 次，used=${rig.usage.used(s)}`)
  // 第 21 次
  beginCall(s, 'call-21')
  let error
  try {
    await rig.definition.execute({ no: '1.17', pageNo: 1 }, rig.exec)
  } catch (e) {
    error = e
  }
  check(
    '3b 第 21 次调用被拒绝，且消息含"上限"',
    error instanceof Error && /上限/u.test(error.message),
    error === undefined ? '第 21 次被放行（边界写成 >= 会只允许 19 次；写成 >max 才是 20 次）' : `throw: ${error.message.slice(0, 80)}`,
  )
  check('3c 边界方向：拒绝发生在 used=21 时（即 used > max）', rig.usage.used(s) === 21, `used=${rig.usage.used(s)}`)

  // ---------------- 4. 插件重载后计数不清零 ----------------
  const rendersBefore = rig.pageImages.renders
  await rig.dispose() // 卸载整棵树（= 插件重载）
  const rig2 = await mount({ session: s }) // 同一 Session，新的投影表/新的工具实例
  check('4a 重载后 used 仍等于日志里的 21（不是归零）', rig2.usage.used(s) === 21, `used=${rig2.usage.used(s)}`)
  beginCall(s, 'call-22')
  let error2
  try {
    await rig2.definition.execute({ no: '1.17', pageNo: 1 }, rig2.exec)
  } catch (e) {
    error2 = e
  }
  check(
    '4b 重载后调用仍被拒（配额没有白送）',
    error2 instanceof Error && /上限/u.test(error2.message),
    error2 === undefined ? '重载后白送了配额（进程内计数器式缺陷回归）' : `renders 重载前=${rendersBefore} 重载后=${rig2.pageImages.renders}`,
  )
  await rig2.dispose()
}

// ---------------- 5. seam：换 Provider，工具层零改动 ----------------
{
  const rig = await mount()
  beginCall(rig.session, 'c-seam')
  const v = await rig.definition.execute({ no: '1.17', pageNo: 2, region: 'top-left' }, rig.exec)
  check(
    '5 假 Provider 的尺寸/字节原样进结果（工具不认识引擎）',
    v.image?.width === 777 && v.image?.height === 999 && v.image?.bytes === 6 && v.image?.scale === 1.23,
    JSON.stringify({ w: v.image?.width, h: v.image?.height, bytes: v.image?.bytes, scale: v.image?.scale, region: v.image?.region, frac: v.image?.coversPageFraction }),
  )
  const blocks = rig.definition.output.render({}, v)
  const imageBlocks = blocks.filter((b) => b.type === 'image').length
  check('5b ok ⇒ [text, image] 各 1 个', blocks.length === 2 && imageBlocks === 1, `blocks=${blocks.map((b) => b.type).join(',')}`)
  await rig.dispose()
}

// ---------------- 6. no_pdf 只由 assetPath===null 产生 ----------------
{
  const rig = await mount()
  beginCall(rig.session, 'c-nopdf')
  const v = await rig.definition.execute({ no: '9.99', pageNo: 1 }, rig.exec)
  check(
    '6 no_pdf 由 assetPath===null 产生，且不碰引擎',
    v.status === 'no_pdf' && rig.pageImages.renders === 0 && rig.attachments.saves === 0,
    `status=${v.status} renders=${rig.pageImages.renders} saves=${rig.attachments.saves}`,
  )
  const blocks = rig.definition.output.render({}, v)
  check('6b no_pdf ⇒ 只有 text block（不产 image）', blocks.length === 1 && blocks[0].type === 'text', blocks.map((b) => b.type).join(','))
  check('6c no_pdf 文案指向 lit_search', /lit_search/u.test(v.guidance), v.guidance.slice(0, 60))
  await rig.dispose()
}

// ---------------- 7. 参数错误 ----------------
{
  const rig = await mount()
  const cases = [
    ['region 与 rect 同时给', { no: '1.17', pageNo: 1, region: 'full', rect: [0, 0, 0.5, 0.5] }],
    ['pageNo=0', { no: '1.17', pageNo: 0 }],
    ['no 为空', { no: '  ', pageNo: 1 }],
    ['rect 越界', { no: '1.17', pageNo: 1, rect: [0, 0, 1.5, 1] }],
  ]
  const out = []
  for (const [label, args] of cases) {
    beginCall(rig.session, `c-${label}`)
    try {
      await rig.definition.execute(args, rig.exec)
      out.push(`${label}:未抛`)
    } catch {
      out.push(`${label}:throw`)
    }
  }
  check('7 参数错一律 throw（且不触达引擎）', out.every((x) => x.endsWith('throw')) && rig.pageImages.renders === 0, out.join(' '))
  await rig.dispose()
}

// ---------------- 8. maxCallsPerSession=0 ⇒ 不注册 ----------------
{
  const rig = await mount({ maxCallsPerSession: 0 })
  check('8 maxCallsPerSession=0 ⇒ 工具不注册（彻底关掉视觉通道）', rig.definition === undefined, `get('lit_page_image')=${String(rig.definition)}`)
  await rig.dispose()
}

const failed = results.filter((x) => !x.ok)
console.log(`\nV4 SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) })}`)
process.exit(failed.length === 0 ? 0 : 1)
