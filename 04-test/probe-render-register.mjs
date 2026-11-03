/**
 * 注册门控（三层：配置名单 + enabled + 渲染器可解析 + 配额）实测。
 * 每个 mode 一个独立进程（config 是模块单例，改了不能在同一进程里重新判定）。
 *
 * 用法（cwd=03-code）：
 *   node --no-warnings .../probe-render-register.mjs default
 *   node --no-warnings .../probe-render-register.mjs enable-noplaywright
 *   node --no-warnings .../probe-render-register.mjs enable-playwright
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODE = process.argv[2] ?? 'default';
const OUT = 'D:/A-knowledge/agent工作流优化/04-test';
const TMP = path.join(OUT, '.tmp');
fs.mkdirSync(TMP, { recursive: true });
process.env.TEMP = TMP;
process.env.TMP = TMP;
process.env.TMPDIR = TMP;

const ROOT = 'D:/A-knowledge/agent工作流优化/03-code';
const PLAYWRIGHT_MODULE = 'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/playwright';
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const { config } = await import(mod('server/config.js'));
if (MODE !== 'default') {
  config.chat.pageImage.enabled = true;
  if (MODE === 'enable-playwright') config.chat.pageImage.playwrightModule = PLAYWRIGHT_MODULE;
}
// 视觉通道要真的派给模型，还得出现在 chat.tools 名单里
if (MODE === 'enable-playwright' && !config.chat.tools.includes('lit_page_image')) {
  config.chat.tools.push('lit_page_image');
}

const { PAGE_IMAGE_STATUS, ALL_TOOLS, buildTools } = await import(mod('server/services/chat/tools/index.js'));
const { tools, unknown } = buildTools(config.chat.tools);

console.log(`mode=${MODE}`);
console.log(`  chat.tools=${JSON.stringify(config.chat.tools)}`);
console.log(`  PAGE_IMAGE_STATUS=${JSON.stringify(PAGE_IMAGE_STATUS)}`);
console.log(`  ALL_TOOLS 含 lit_page_image=${Object.hasOwn(ALL_TOOLS, 'lit_page_image')}`);
console.log(`  buildTools⇒${JSON.stringify(tools.map((t) => t.name))} unknown=${JSON.stringify(unknown)}`);
console.log(`  chat.maxCallsPerSession=${JSON.stringify(config.chat.maxCallsPerSession)}`);

const expectRegistered = MODE === 'enable-playwright';
const ok = PAGE_IMAGE_STATUS.registered === expectRegistered && Object.hasOwn(ALL_TOOLS, 'lit_page_image') === expectRegistered;
console.log(`  ⇒ ${ok ? 'PASS' : 'FAIL'}（期望 registered=${expectRegistered}）`);
process.exit(ok ? 0 : 1);
