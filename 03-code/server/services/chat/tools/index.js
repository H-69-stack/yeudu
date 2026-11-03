/**
 * 工具清单（唯一注册处）。
 *
 * `config.chat.tools` 里列了哪个名字，就只注册哪个 —— 与 dsh `cordis.patch.yml` 的
 * 「列出即启用、`disabled: true` 即关闭」语义对齐：**没列出的工具模型根本看不到**。
 */
import { tool as litRead } from './lit-read.js';
import { tool as litSearch } from './lit-search.js';
import { tool as litTranslation } from './lit-translation.js';
import { tool as litUpdateNote } from './lit-update-note.js';
import { tool as litPageImage } from './lit-page-image.js';
import { getSharedRenderer } from '../render/page-image-source.js';
import { config } from '../../../config.js';

/**
 * 全部已实现的工具（名字与 dsh litagent 的 tools/lit-*.ts 保持一致）。
 *
 * 唯一例外是 `lit_page_image`：它**条件注册**（见下方 `registerPageImage`）——
 * 只有 `chat.pageImage.enabled === true` **且**渲染器真的可解析（playwright + Chromium +
 * pdf.js 资产面齐全）时才进这张表。解析失败不抛、不降级，只是"模型看不到这个工具"，
 * 与 dsh「`maxCallsPerSession <= 0` 就不注册」同一思路（dsh `lit-page-image.ts:254`）。
 */
export const ALL_TOOLS = {
  lit_search: litSearch,
  lit_read: litRead,
  lit_translation: litTranslation,
  lit_update_note: litUpdateNote,
};

/**
 * 条件注册视觉通道工具。
 *
 * 为什么在这里写配额默认值：`registry.createRegistry` 才是配额的唯一执行者
 * （数据源 = 落库的工具调用日志），工具层不重复计数。所以这里把
 * `chat.pageImage.maxCallsPerSession` 折算进 `chat.maxCallsPerSession`，
 * 优先级：`chat.maxCallsPerSession.lit_page_image`（显式配置）> `chat.pageImage.maxCallsPerSession`（默认 20）。
 * @returns {{registered:boolean, reason?:string}}
 */
function registerPageImage() {
  const cfg = config.chat.pageImage || {};
  if (cfg.enabled !== true) return { registered: false, reason: 'chat.pageImage.enabled 不是 true（默认关闭）' };

  const perTool = config.chat.maxCallsPerSession || {};
  const explicit = Number(perTool.lit_page_image);
  const quota = Number.isFinite(explicit) ? explicit : Number(cfg.maxCallsPerSession);
  if (!(Number.isFinite(quota) && quota > 0)) {
    return { registered: false, reason: `配额 ${String(cfg.maxCallsPerSession)} ≤ 0 ⇒ 不注册该工具` };
  }

  // 渲染器可解析性：构造即做启动期断言（缺 playwright / Chromium / pdf.js 资产 ⇒ 这里就失败）。
  // 注意只"装配"不"启动浏览器"——真正的 launch 发生在第一次 render。
  const probe = getSharedRenderer({
    pdfjsDir: cfg.pdfjsDir || undefined,
    playwrightModule: cfg.playwrightModule || undefined,
    renderTimeoutMs: cfg.renderTimeoutMs,
    idleTimeoutMs: cfg.idleTimeoutMs,
  });
  if (!probe.renderer) {
    return { registered: false, reason: `渲染器不可用：${probe.error?.message ?? probe.error}` };
  }

  ALL_TOOLS.lit_page_image = litPageImage;
  config.chat.maxCallsPerSession = { ...perTool, lit_page_image: quota };
  return { registered: true, reason: `quota=${quota}` };
}

export const PAGE_IMAGE_STATUS = registerPageImage();

/**
 * 按配置里的名字清单装配工具数组（顺序即 schema 顺序）。
 * @param {string[]} names
 * @returns {{tools:Array, unknown:string[]}}
 */
export function buildTools(names) {
  const tools = [];
  const unknown = [];
  for (const n of Array.isArray(names) ? names : []) {
    const t = ALL_TOOLS[n];
    if (t) tools.push(t);
    else unknown.push(n);
  }
  return { tools, unknown };
}
