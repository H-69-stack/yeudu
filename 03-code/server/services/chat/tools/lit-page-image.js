/**
 * `lit_page_image` —— 看某一页的**页面外观**（移植自 dsh-impl 的 `tools/lit-page-image.ts`）。
 *
 * 契约要点（照 dsh，别自创）：
 *   1) **两态**：`status` 只有 `ok` / `no_pdf`，且 `no_pdf` **只能**由「该文献没有本地 PDF 文件」
 *      产生（dsh `lit-page-image.ts` 同语义）。渲染失败/超时/环境问题一律**抛错**，不降级成空值。
 *   2) 文本段是**固定 5 行**、前缀稳定：不写本机路径、不写 PDF 正文、不写时间戳。
 *   3) 图片以附件形式落盘，value 里带 `attachmentId`（pipeline 负责把它变成前端可显示的 image 事件）。
 *
 * 配额（渲染次数闸）**不在本文件里数**：03-code 的 `registry.createRegistry` 已经有跨轮配额，
 * 数据源是落库的工具调用日志（`session.countToolCalls`，进程重启不丢），判定在调用**执行前**
 * 用 `已发生 >= 上限`——与 dsh 的 `used > max`（`page-image-usage.ts:14`，used 含本次）等价，
 * 都是"一个会话最多 max 次"，不会白送也不会少给。重复造一个进程内计数器反而会在重启后归零。
 * 默认值由 `tools/index.js` 在注册时写进 `config.chat.maxCallsPerSession`。
 */
import { defineTool } from '../registry.js';
import { resolveWork } from './_resolve.js';
import { statStoragePath } from './_sandbox.js';
import { saveImage } from '../attachments.js';
import { getSharedRenderer } from '../render/page-image-source.js';
import { config } from '../../../config.js';
import { clampMaxEdge, coversPageFraction, REGION_PRESET_NAMES, regionRect } from '../render/render-geometry.js';

const TOOL_NAME = 'lit_page_image';

/** 取渲染器；不可用即抛（不降级成"这页没有内容"）。 */
function rendererOrThrow() {
  const { renderer, error } = getSharedRenderer({
    pdfjsDir: config.chat.pageImage.pdfjsDir || undefined,
    playwrightModule: config.chat.pageImage.playwrightModule || undefined,
    renderTimeoutMs: config.chat.pageImage.renderTimeoutMs,
    idleTimeoutMs: config.chat.pageImage.idleTimeoutMs,
  });
  if (!renderer) {
    throw Object.assign(
      new Error(`${TOOL_NAME} 渲染器不可用：${error?.message ?? error}（code=${error?.code ?? 'E_RENDER_FAILED'}）`),
      { code: error?.code ?? 'E_RENDER_FAILED' },
    );
  }
  return renderer;
}

/**
 * 五段固定文本（与 dsh `renderText` 一致）：第 N/M 页、能力边界、可再取区域、png、省 token。
 * 刻意不含路径/时间/正文 ⇒ 同输入同输出（前缀稳定，便于比对与缓存）。
 */
function render(_args, value) {
  if (value.status === 'no_pdf') {
    return [
      `文献 ${value.no} 没有本地 PDF：本工具只能渲染已下载的 PDF 页面。`,
      `替代方案：用 lit_read 读已有正文；或先下载该文献的 PDF 再来看图。`,
    ].join('\n');
  }
  const pct = Math.round((value.image.coversPageFraction || 1) * 100);
  return [
    `第 ${value.pageNo}/${value.page.pageCount} 页已渲染（region=${value.image.region}，${value.image.width}x${value.image.height} px，覆盖页面 ${pct}%）。`,
    `这是页面外观，不是 OCR：极小的字仍可能读错；正文引用优先用 lit_read。`,
    `- 图形/表格的细节：用 region='top-left'|'top-right'|'bottom-left'|'bottom-right' 再看一块`,
    `  （同样的 token 成本，分辨率约提高 2 倍）。`,
    `- 细线条/公式/需要绝对清晰：加 format='png'。`,
    `- 只想确认版式、想省 token：maxEdge=800。`,
  ].join('\n');
}

export const tool = defineTool({
  name: TOOL_NAME,
  description:
    '把文献某一页渲染成图片来看（一次一页）。用于看版面、图形、表格、公式，或正文未抽取的扫描件；文字引用仍应优先用 lit_read。看小字用 region 分块（同样的 token 成本下分辨率约提高 2 倍），需要绝对清晰用 format="png"。',
  parameters: {
    no: {
      type: 'string',
      required: true,
      description: '文献编号，例如 "4.6"；不知道编号先用 lit_search 查',
    },
    pageNo: { type: 'number', required: true, description: '页码，从 1 开始' },
    region: {
      type: 'string',
      enum: REGION_PRESET_NAMES,
      description: '区域预设：full（整页）或四个象限；与 rect 互斥，二选一',
    },
    rect: {
      type: 'array',
      items: { type: 'number' },
      description: '自定义分数矩形 [x0,y0,x1,y1]，取值 0–1，左上原点；与 region 互斥',
    },
    maxEdge: {
      type: 'number',
      description: '输出图长边上限，默认 1500，夹取到 600–2048；只想确认版式用 800',
    },
    format: { type: 'string', enum: ['jpeg', 'png'], description: '编码格式，默认 jpeg；细线条/公式用 png' },
  },
  timeoutMs: Number(config.chat.pageImage?.renderTimeoutMs) || 8000,
  execute(args) {
    const no = String(args.no == null ? '' : args.no).trim();
    const pageNo = Number(args.pageNo);
    if (!no) throw new Error('缺少文献编号 no（例如 "4.6"）');
    if (!Number.isInteger(pageNo) || pageNo < 1) throw new Error(`pageNo 必须是 ≥1 的整数（收到 ${String(args.pageNo)}）`);
    if (args.region && args.rect) throw new Error('region 与 rect 互斥：只能给其中一个');

    const region = args.region || args.rect || 'full';
    regionRect(region); // 非法枚举/越界矩形在渲染之前就抛

    const { asset } = resolveWork(no);
    // **no_pdf 的唯一来源**：没有 pdf 资产，或资产文件在磁盘上不存在。
    // 路径必须先过存储根沙箱（_sandbox 会拒绝越界与绝对路径）。
    const stat = asset?.storage_rel_path ? statStoragePath(asset.storage_rel_path) : null;
    if (!asset || !stat || !stat.exists) {
      return { no, pageNo, status: 'no_pdf', page: null, image: null, guidance: '改用 lit_read 读正文，或先下载 PDF' };
    }

    const maxEdge = clampMaxEdge(args.maxEdge ?? config.chat.pageImage.maxEdge);
    const format = args.format === 'png' ? 'png' : 'jpeg';
    const renderer = rendererOrThrow();
    return renderer
      .render({
        pdfPath: stat.abs,
        pageNo,
        region,
        maxEdge,
        maxPixels: config.chat.pageImage.maxPixels,
        format,
        jpegQuality: config.chat.pageImage.jpegQuality,
      })
      .then((out) => {
        const ref = saveImage({
          bytes: out.bytes,
          mediaType: out.mediaType,
          width: out.width,
          height: out.height,
        });
        return {
          no,
          pageNo,
          status: 'ok',
          page: out.page,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: out.width,
            height: out.height,
            region: Array.isArray(region) ? `rect` : String(region),
            coversPageFraction: coversPageFraction(region),
            scale: Number(out.scale.toFixed(3)),
            rect: out.rect,
          },
          guidance: '图像是页面外观，不是 OCR；引用原文优先 lit_read',
        };
      });
  },
  render,
});
