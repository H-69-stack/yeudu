/**
 * V6 R-P3-2 子进程：PLAYWRIGHT_BROWSERS_PATH 指空目录 ⇒ 构造期必须抛错。
 * 为什么必须独立进程：playwright 在**模块加载时**缓存浏览器注册表路径，
 * 同一进程里改 env 不会生效（改了也测不到真实行为）。
 */
const { PageImageRenderer } = await import('../../packages/dsh-bundle-litagent/src/service/page-image-source.ts')
try {
  new PageImageRenderer({})
  console.log('NO_THROW')
} catch (error) {
  console.log(`THROW::${String(error?.message ?? error).replaceAll('\n', ' ')}`)
}
