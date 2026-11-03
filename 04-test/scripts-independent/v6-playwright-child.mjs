/**
 * V6 R-P3-1 子进程：用 `module.registerHooks` 让 'playwright' 不可解析 ⇒ 构造期必须抛错。
 * 必须独立进程：模块缓存一旦命中 'playwright'，resolve 钩子就不会再被调用。
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'playwright' || specifier.startsWith('playwright/')) {
      throw new Error('SIMULATED: playwright 被依赖裁剪（MODULE_NOT_FOUND）')
    }
    return nextResolve(specifier, context)
  },
})

const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')
try {
  new PageImageRenderer({})
  console.log('NO_THROW')
} catch (error) {
  console.log(`THROW::${String(error?.message ?? error).replaceAll('\n', ' ')}`)
}
