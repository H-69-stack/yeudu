# A13-frontend — 前端（零构建四页 + SSE + XSS + 状态同步）评审报告

评审范围：`03-code/web/` 全部非 vendor 文件（4 页 HTML + 9 个 JS + 2 个 CSS），关联到 `03-code/server/` 的 SSE/路由实现与 `03-code/scripts/make-preview.js`。
方法：先按行数降序读最大三文件（chat.js 682 / reader.js 563 / list.js 543），再扫 work/viewer/settings/translate/api/ui；对 4 个页面与 24 个静态资源做 curl 实测；对 SSE/取消/重抽链路回读服务端 4 个文件确证。

## 结论

1. 零构建本身可用，但**没有模块边界**：跨文件靠 `window.marked/DOMPurify/hljs`、`window.__litUploader`、`localStorage['agentlit.*']` 三套隐式契约，且模块顶层就做了能力快照（`MD_OK`），删错一个 `<script>` 只会静默降级成纯文本，不会报错。
2. **最严重的一处是 SSE 语义与服务端不匹配**：`EventSource` 断线自动重连时服务端把 `close` 当"用户取消"直接 abort 任务（`pipeline.js:673-681`），前端 `es.onerror` 是空函数、不回连不核对状态，一次网络抖动就能把长时付费翻译静默打成 paused 且进度条永久冻住。
3. **XSS 面基本干净**（全站只有 3 个 innerHTML 落点，其中 2 个经 DOMPurify），唯一的漏点是详情页把 CSV 里的 `link` 字段直接当 `href`（`work.js:59`），而列表页 `landingUrl()` 有 scheme 白名单——同一语义两套实现，一处有防线一处没有。
4. 资源生命周期不完整：pdf.js 文档从不 `destroy()`，`RenderTask` 从不 `cancel()`，`setScale()` 会把正在渲染的 canvas 再渲染一次；其余（IntersectionObserver、resize、splitter 监听）都有成对清理。
5. 可用性问题集中在两处：列表页下载中每 1.2 s 全量重建 50 行 `<tbody>`（焦点/选中丢失），以及点击态用 `<span class="btn is-disabled" onclick>` 实现（键盘完全不可达、模态与抽屉无焦点管理）。

## findings

### 1. [high] EventSource 断线 → 服务端把任务当取消 abort，前端空 onerror 导致进度永久冻结

**现象**：翻译/精排进度用 `EventSource` 订阅。浏览器在连接断开后会自动重连，但**重连前那次 `close` 已经触发服务端 cleanup**：`runner.listeners.size === 0 && status === running` → `runner.canceled = true; runner.ctl.abort()`，任务被写成 `paused`。前端 `es.onerror` 是空实现，既不提示也不重新对账，`#progressLine` 停在最后一帧"翻译中 42% · 51/120 段"。用户看到的是一个永远不动的进度条，而任务其实已经停了；只有再点「继续翻译」才会恢复。

**证据**（`03-code/web/assets/reader.js:354-356`，两处相同）：
```js
  es.onerror = () => {
    // EventSource 自带重连；这里只在关闭后提示
  };
```
（`03-code/server/services/translate/pipeline.js:673-681`）
```js
  const cleanup = () => {
    clearInterval(heartbeat);
    runner.listeners.delete(listener);
    // 客户端断开 → 中止上游（已译段保留，job 转 paused，可续译）
    if (runner.listeners.size === 0 && ['running', 'queued'].includes(currentStatus(jobId))) {
      runner.canceled = true;
      runner.ctl.abort();
    }
  };
  res.on('close', cleanup);
```

**影响**：笔记本合盖/切 Wi-Fi/代理闪断等常见场景下，一次 1 秒的抖动 = 整条翻译任务静默中止（已译段保留但不再继续），前端无任何错误提示，用户无从判断该不该重试；精排同理（`refineEs.onerror` 在 reader.js:299-301 也是空的）。全站 grep `visibilitychange|pagehide|beforeunload|last-event-id` 命中 0 —— 没有任何页面隐藏/卸载钩子，也没有断点续传语义。

**建议**：`es.onerror` 里区分 `readyState === EventSource.CLOSED`（真断，需提示+给"继续"按钮）与 `CONNECTING`（自动重连中，显示"连接中断，重连中…"）；重连成功后拉一次 `/api/jobs/translate/:id` 与本地 `jobId` 对账，状态非 running 就按服务端状态收尾；服务端给 SSE 加 `retry:`/`Last-Event-ID` 或把"客户端断开"与"用户取消"区分开（例如只在收到显式 cancel 时 abort）。

effort：M

### 2. [high] 详情页「链接」把 CSV 元数据直接当 href，缺 scheme 白名单 → `javascript:` 可执行

**现象**：`render()` 渲染 10 个字段时唯一不是纯文本的落点是「链接」，`w.link` 原样进 `el('a', {href})`。`w.link` 来自导入的 CSV（外部元数据，可被任意编辑器/抓取脚本改写），`href="javascript:..."` 会被浏览器当作可执行 URL，点击即以本应用同源身份执行任意脚本，可调用全部写接口（切换下载目录、导入、批量下载、删除、reveal 文件）。同一仓库的列表页对同一字段有白名单，两处语义已经分叉。

**证据**（`03-code/web/assets/work.js:59`）：
```js
  add('链接', w.link ? el('a', { href: w.link, target: '_blank', rel: 'noreferrer', text: w.link }) : '—');
```
对照（`03-code/web/assets/list.js:336-343`）：
```js
  if (/^https?:\/\//i.test(link) && !/^https?:\/\/([a-z0-9-]+\.)?doi\.org\//i.test(link)) return link;
```

**影响**：CSV 是外部可写输入（导入/自愈/人工维护），一旦含 `javascript:` 载荷，详情页点一下「链接」即执行脚本；配合本机 7317 的全部写 API（切换下载目录、`/api/import`、批量下载）可造成数据篡改与越界落盘。当前没有任何 CSP 兜底（4 个页面均无 `<meta http-equiv="Content-Security-Policy">`）。

**建议**：把 `landingUrl()` 抽到 `ui.js` 成为唯一实现（顺带消掉 work.js:156-163 的重复副本），两处统一走 scheme 白名单 + `try { new URL(v) }` 校验；对非 http(s) 的链接只显示文本不加 `href`。

effort：S

### 3. [medium] pdf.js 文档从不 destroy、RenderTask 从不 cancel；缩放时同 canvas 并发 render

**现象**：`Viewer` 类没有 `destroy()`，`open()` 直接把 `this.doc` 覆盖成新文档，旧 `PDFDocumentProxy`（含 worker 内的字体/图像缓存）只等 GC；`renderPage()` 把 `page.render(...)` 的 `RenderTask` 丢弃，从不 `cancel()`；`setScale()` 对全部页 `canvas.width = 1` 清位图并 `rendered.delete(i)`，随后对可见页重新 `renderPage()`——如果此时旧 render 还没结束，就会出现同一 canvas 上两次 `render()`，pdf.js 会抛 `Cannot use the same canvas during multiple render() operations`，被 catch 成 `console.error` + `rendered.delete`，结果是该页空白，直到再滚动/再缩放才重试。

**证据**（`03-code/web/assets/viewer.js:263-289`）：
```js
      entry.canvas.width = 1; // 清空旧位图，renderPage 会按新缩放重设
      entry.canvas.height = 1;
      entry.textLayer.textContent = '';
      entry.hlLayer.textContent = '';
      this.rendered.delete(i);
```
（`03-code/web/assets/viewer.js:166`）
```js
      await page.render({ canvasContext: ctx, viewport }).promise;
```
（`03-code/web/assets/viewer.js:50-56`，`open()` 开头只调 `teardown()`，`teardown()` 只 disconnect IO + 移除 scroll/resize，不动 `this.doc`）

**影响**：连续点缩放（HUD 的 ＋/－ 或 Ctrl+滚轮）时高概率出现整页空白 + 控制台报错；换文档时文档级内存不释放（当前 `open()` 每次页面加载只调用一次，属潜伏问题，一旦以后支持"在阅读页里换文献"就会立刻暴露）。全站 grep 无 `destroy()`、无 `RenderTask`。

**建议**：`renderPage` 把 `const task = page.render(...)` 存进 `this.renderTasks` Map，重绘前 `task.cancel()`；`setScale` 先取消全部在飞任务再清 canvas；给 `Viewer` 加 `destroy()`（`this.doc?.destroy()`）并在 `open()` 开头与 `beforeunload` 调用。

effort：M

### 4. [medium] 下载进行中每 1.2 s 全量重建 50 行 tbody：焦点丢失、DOM 抖动

**现象**：`pollJobs()` 每 1.2 s 拉一次 `/api/jobs/download?limit=50`，改完内存里的状态后无条件 `renderRows()`；`renderRows()` 先 `tbody.textContent = ''` 再为 50 行逐行重建（每行 7 个 `td` + 标题/作者两个 `div` + 5 个操作元素，约 20 个节点），单次替换 1000+ 节点。轮询期间键盘用户焦点落在某行按钮上时，节点被销毁 → 焦点掉回 `body`；正在拖选文本/滚动条位置也会被重置。

**证据**（`03-code/web/assets/list.js:262`）：
```js
  renderRows();
  if (activeCount === 0) {
```
（`03-code/web/assets/list.js:109-113`）
```js
function renderRows() {
  const tbody = $('rows');
  tbody.textContent = '';
  $('empty').hidden = state.items.length > 0;
```

**影响**：只要有任一下载任务在跑（批量为 424 条时可能持续数十分钟），列表就不可用键盘操作、选中与滚动被打断；1.2 s 一次的重建也让主线程持续出现 layout/paint（50 行 × 9 次/秒级渲染）。分页 50 条本身没问题（服务端分页，不是全量 424），问题在"无 diff 重建"。

**建议**：`pollJobs` 改成对每行做定点更新（只改 `.download` 单元格的文本/按钮 disabled 状态，行本身复用；行 DOM 建一次并缓存 key→节点），`renderRows()` 只在 `loadWorks()` 后调用；轮询间隔在 `document.hidden` 时降到 5 s 或暂停（配合 visibilitychange）。

effort：M

### 5. [medium] 打开阅读页会在无确认的情况下强制重抽并自动重发付费翻译

**现象**：`loadSegments()` 发现 `extractVersion !== extractorVersion` 时，自动 `POST /api/assets/:id/extract {force:true}`（重写段落），然后如果旧数据里有译文（`hadTranslation`）就**直接 `triggerTranslate()`** 重新发起一次翻译任务。整个过程没有确认框、没有"是否继续翻译"提示，只事后 toast。

**证据**（`03-code/web/assets/reader.js:147-158`）：
```js
      const job = await api.post(`/api/assets/${detail.asset.id}/extract`, { force: true });
      ...
    await loadSegments();
    // 旧译文是按旧段落存的，重排后自然对不上；此前译过的话直接接着译，省一次点击。
    if (hadTranslation) triggerTranslate();
```

**影响**：抽取算法每升级一次，所有历史文献在**第一次被打开时**都会被静默重抽并重新翻译一遍全文——直接产生 LLM 费用（用户不知道、也无法在发起前拦下），还会覆盖已存译文。这在"本地单人工具 + 自有 apiKey"场景下等于按次扣费，属于静默副作用。

**建议**：重抽是数据迁移，应在设置页显式触发（或服务端启动时批量迁移）；前端只提示"段落结构已升级，需要重排，是否现在执行？"；译文重建必须由用户点按钮，至少给一个"不再自动翻译"的开关。

effort：S

### 6. [medium] 零构建下的三套隐式契约，改一页会静默打断另一页

**现象**：没有打包器，跨文件依赖全靠全局与约定：
1. **`window.marked / window.DOMPurify / window.hljs`**：由 `reader.html:124-126` 三个 classic script 注入，`chat.js:14` 与 `translate.js:9` 在**模块求值期**就做了 `const MD_OK = Boolean(window.marked && window.DOMPurify)` 快照。只要以后有人把这三个标签改成 `defer`/`type="module"`/搬到 head 之后，或删掉其中一个，`MD_OK` 就是 `false`，聊天与译文全部静默降级成纯文本（连 console 警告都没有）。
2. **`window.__litUploader`**：列表页每 300 ms 探测一次，最多 8 s，读的是油猴脚本注入的全局版本号；userscript 改名或不注入，按钮就永远显示"未安装直传脚本"，无其他信号。
3. **`localStorage['agentlit.*']`**：`agentlit.lastReader` 由 reader.js 写、list.js 读（JSON 结构无版本、无 try/catch 校验），`agentlit.pdfScale/pdfFrac/dstScale/chatW` 是布局契约，改字段名会静默丢用户设置。

**证据**（`03-code/web/assets/chat.js:14`）：
```js
const MD_OK = Boolean(window.marked && window.DOMPurify);
```
（`03-code/web/assets/translate.js:9`）：
```js
const MD_OK = Boolean(window.marked && window.DOMPurify);
```
（`03-code/web/assets/list.js:316`）：
```js
  const ready = !!window.__litUploader;
```

**影响**：最易打断的耦合排序：(1) reader.html 的 3 个 vendor script → 影响 chat/translate 的 Markdown 渲染；(2) `agentlit.lastReader` 的 JSON 形状 → 影响总览页「阅读器」入口的续读；(3) `#dialog/#modal` 这类全局 id 与 app.css 的 class 语义（`.btn/.is-disabled`）→ 改一处样式会同时改掉另外两页的按钮态。

**建议**：把 MD 渲染能力做成 `ui.js` 里带就绪检测的 `renderMarkdown()`（缺库时 `console.warn` 一次），页面里改用一个 `assets/vendor/md/loader.js` 动态 import 并 `await`；`window.__litUploader` 改成一个带超时事件的 `CustomEvent` 握手；localStorage 键集中到 `storage.js` 并做 try/catch + 版本号。

effort：M

### 7. [medium] 可访问性：可点 `span` 键盘不可达、表头无 scope、灰态只靠颜色

**现象**：列表行里"打不开"的操作不是 `<button disabled>` 而是 `<span class="btn is-disabled" onclick>`——没有 `tabindex`、没有 `role="button"`、没有 `aria-disabled`，Tab 键永远聚焦不到；`.btn.is-disabled` 只是把 `color` 改成 `#a8a49b`（纯颜色差异）。表格 7 个 `<th>` 全部没有 `scope="col"`，也没有 `<caption>`。

**证据**（`03-code/web/assets/list.js:137-142`）：
```js
        : el('span', {
            class: 'small btn is-disabled',
            text: '打开 PDF',
            title: '本地还没有 PDF：先点「下载」，或去出版商页面下载后上传',
            onclick: () => toast(`${item.no} 本地还没有 PDF，先下载或上传`, 'warn', 3000),
          }),
```
（`03-code/web/assets/app.css`，`.btn.is-disabled` 仅设 `color:#a8a49b`）
（`03-code/web/index.html:79-85`）`<th style="width:64px">编号</th>` 等 7 个表头均无 `scope`

**影响**：键盘用户无法触发这两类按钮的提示（也就不知道"为什么不能点"）；色觉障碍用户看不出灰态；屏幕阅读器把表格读成无表头的单元格序列。这是这批页面里唯一系统性的 a11y 缺口（reader.html 的 aria-label/role 做得很好，index/work/settings 则基本没有 aria）。

**建议**：统一用 `<button type="button" disabled aria-disabled="true" title="...">`（原生 disabled 自带灰态与不可聚焦语义，不需要 onclick 兜底提示，把原因放 `title`+`aria-describedby`）；给 `<th>` 加 `scope="col"`、表格加 `<caption class="sr-only">`；`.is-disabled` 补 `cursor: not-allowed` 与虚线边框，不只靠颜色。

effort：S

### 8. [medium] 模态与对话抽屉没有焦点管理，抽屉关闭时仍可 Tab 进去

**现象**：`#readerPicker` 是 `<div class="modal" hidden>`，打开/关闭只切 `hidden`：无 `role="dialog"`、无 `aria-modal`、无 `aria-labelledby`、无 Esc 关闭、打开时不把焦点移入、关闭后不还原焦点；遮罩点击靠 `e.target === modal` 判断。右侧对话抽屉同理：`<aside class="chat-drawer" aria-hidden="true">` 收起时 CSS 只做 `transform: translateX(100%)`（仍参与布局与 Tab 序），而抽屉里全是可聚焦控件（输入框、附件按钮、发送/停止）。

**证据**（`03-code/web/index.html:101`）：
```html
    <div class="modal" id="readerPicker" hidden>
```
（`03-code/web/reader.html:91` + `03-code/web/assets/reader.css:269-276`）：
```css
.chat-drawer {
  position: fixed; top: var(--drawer-top, var(--topbar-h)); right: 0; bottom: 0;
  width: var(--chat-w, 360px); box-sizing: border-box;
  transform: translateX(100%); transition: transform .25s ease;
```
（`03-code/web/assets/list.js:450-454` 只有关闭按钮与遮罩点击，没有 keydown/Esc）

**影响**：键盘用户打开"选择阅读器"后 Tab 仍在背景页面上跑；对话抽屉收起时 Tab 会进入一个屏幕外、`aria-hidden="true"` 的区域，屏幕阅读器与视觉焦点完全脱节（axe 的 `aria-hidden-focus` 违规）；Tab 顺序里始终有两套隐藏控件的坑。

**建议**：模态改成 `<dialog>` + `showModal()`（原生 Esc/焦点约束/backdrop）或手写 focus trap + Esc；抽屉收起时改用 `visibility: hidden`（配合 transition 延迟）或 `inert` 属性，并在打开时 `focus()` 首个输入框、关闭时把焦点还给 `#chatToggle`。

effort：M

### 9. [medium] 精排取消：服务端不发终止事件，前端不关 SSE → 连接悬挂 + 取消后又弹一条错误

**现象**：`cancelRefine()` 只 `POST .../cancel` 然后 toast，**没有 `refineEs.close()`**；服务端 `cancelLayoutJob()` 只 `ctl.abort()` + 改状态，**不 `emit` 任何终止事件**，SSE 的 15 s 心跳继续。abort 之后 `runLayoutJob` 的异常路径会在 `startLayout` 的 `.catch` 里 `emit('error', {code:'E_INTERNAL', message:'This operation was aborted'})`，于是用户先看到"已取消精排"，紧接着又看到红色的"精排出错：E_INTERNAL …"。

**证据**（`03-code/web/assets/reader.js:253-261`）：
```js
async function cancelRefine() {
  if (!refineJobId) return;
  try {
    await api.post(`/api/jobs/layout/${refineJobId}/cancel`, {});
    toast('已取消精排', 'ok', 3000);
  } catch (e) {
    toast(`取消精排失败：${e.message}`, 'err');
  }
}
```
（`03-code/server/services/layout/job.js:149-155`）
```js
export function cancelLayoutJob(id) {
  const jobId = Number(id);
  const runner = ensureRunner(jobId);
  runner.ctl.abort();
  if (runner.status !== 'done') runner.status = 'canceled';
  return { canceled: true, jobId };
}
```

**影响**：每取消一次就漏一条 SSE 连接（心跳每 15 s 一次，直到用户离开页面）；取消被 UI 呈现成"成功"但随后报错，用户会以为取消失败；`btnRefineCancel` 的显隐只能靠后续 error 事件恢复，若 abort 被下游吞掉（`refineWork` 不抛）则按钮永久卡在"取消精排"。

**建议**：`cancelLayoutJob` 里 `emit(jobId,'canceled',{})` 并让 `streamLayoutEvents` 在 canceled 后 `res.end()`；前端 `cancelRefine()` 收到响应后立刻 `refineEs.close()` 并复位按钮，同时给 `refineEs` 加 `canceled` 监听；`runLayoutJob` 的 catch 对 aborted 情况不再发 `error`（或以 `canceled` 事件代替）。

effort：S

### 10. [low] 可删资产与重复实现：3 个 preview 页面（30.9 KB）+ make-preview.js（9.4 KB）已无引用

**现象**：`web/preview-optimized.html`（9,844 B / 158 行）、`web/reader-preview.html`（7,052 B / 126 行）、`web/reader-preview2.html`（13,958 B / 224 行）和 `scripts/make-preview.js`（9,363 B / 225 行）**在任何 server 路由、任何 HTML/JS 引用中都找不到**（全仓 grep `reader-preview|preview-optimized|make-preview|preview2` 只命中 make-preview.js 自己的注释）。反过来，**`web/assets/vendor/md/*` 仍是必需品**：reader.html:124-126 引用 3 个 js，chat.js/translate.js 依赖其全局（175 KB，不可删）。另外 `api.js` 已被全部 5 个页面模块正确复用（`list/work/settings/reader/chat` 均 `from './api.js'`），但仍有 3 处裸 `fetch`：`chat.js:443`（流式，必须裸）、`chat.js:598`（multipart，理由成立）、`api.js:59`（uploadPdf 自身）；`landingUrl` 有 2 份实现（list.js:336 / work.js:156），`const $ = (id)=>document.getElementById(id)` 在 list/reader/settings/work 各写一遍（4 份）。

**证据**（`03-code/scripts/make-preview.js:3`，唯一自引用）：
```js
 * 用法：node scripts/make-preview.js <workNo> <fromPage> <toPage> [outFile]
```

**影响**：仓库里留着 4 个"看起来能跑、其实已经和当前接口脱节"的预览页（它们的 CSS/JS 是内联老版本，容易误导后来者按老结构改代码）；重复的 `$`/`landingUrl` 让第 2 条 finding 的修复必须改两处，容易只改一处。

**建议**：删除 3 个 preview html 与 make-preview.js（合计约 40 KB，无运行时影响）；`landingUrl` 与 `$` 收进 `ui.js` 统一导出。

effort：S

## 覆盖与盲区

**已覆盖（有静态或动态证据）**
- 4 个页面 + 24 个静态资源全部 curl 实测，引用资源 0 个 404（详见下节）；`/assets/app.js` 404 但无任何页面引用，属可忽略。
- 模块化：window 全局 4 组、localStorage 5 个键、`window.__litUploader` 握手；api.js 复用率 100%（5/5 模块），裸 fetch 3 处。
- XSS：全站 `innerHTML/insertAdjacentHTML/outerHTML/document.write` 共 4 处（chat.js:29 DOMPurify 包裹、translate.js:65 DOMPurify 包裹、chat.js:289 静态字符串、ui.js:12 `html:` 逃生口但**当前零调用方**）；`el()` 的 `text:` 走 textContent；列表/详情/设置全部用 `el({text})` 或 `createTextNode`。
- SSE：reader.js 两条流（translate / layout）+ chat.js 的 fetch 流；取消按钮真实发出 `POST /cancel`（translate 走 `paused` 事件收尾——服务端 `cancelTranslateJob` 会 emit paused，前端有监听，链路完整）；chat 的 `stop()` 里硬编码的 `messages/0/cancel` 无害（`routes/chat.js:137` 只用 `:id`，忽略 `:mid`，`cancelTurn` 对无在飞轮次返回 `{canceled:false}` 而不抛错）。
- 资源生命周期：IntersectionObserver/resize/scroll/splitter/mousemove 监听均有配对清理；`Viewer` 无 destroy、无 RenderTask cancel（见 finding 3）。
- 缓存策略：`maxAge: 0` 实测不造成重复下载——带 `If-None-Match` 请求 vendor 资源返回 **304 Not Modified**（ETag 生效）。
- a11y：reader.html 的 aria 标注完整（`aria-label`×5、`role="separator"`、`aria-expanded`），index/work/settings 基本空白。
- 死文件：3 个 preview html + make-preview.js 确认零引用；vendor/md 确认在用（不可删）。

**盲区（未验证/无法验证）**
- **vendor 库版本号无法确认**：`purify.min.js` / `marked.min.js` / `highlight.min.js` 是压缩产物，`version:"x.y.z"` 与 `versionString` 两种正则均 0 命中，没能确定 DOMPurify 具体版本；因此"是否存在已知 mXSS 绕过"这一判断未做（当前 `USE_PROFILES:{html:true}` 配置本身是常规用法，未见配置层缺陷）。
- **未做真实浏览器 E2E**：没有启动浏览器复现"缩放并发 render 空白页"，finding 3 的最终结论基于 pdf.js 的公开行为 + 代码路径推理；finding 1 的"断线→paused"链路是静态确证（服务端 cleanup 逻辑 + 前端空 onerror），未做断网实验。
- **chat.js 的附件渲染**（`appendImage`/`renderAttachmentCard` 把 `a.url` 直接写进 `href/src`）只确认来源是服务端 attachment 元数据（同源 `/api/attachments/...`），未追到服务端该字段的生成处，故未列为 finding。
- **未做性能实测**（无 Lighthouse/无 Performance 面板）：finding 4 的节点量是静态估算（50 行 × ~20 节点），首屏阻塞只做了资源大小统计（reader 首屏需 1.8 MB pdf.js + 175 KB md + 40 KB css）。
- **02-design 未通读**：只按要求不做全文阅读，未与设计文档中前端模块/契约章节逐条比对，因此"实现与设计是否一致"未评估。
- **未审 userscript**（`03-code/userscript/lit-uploader.user.js`，25 KB，仅确认可 200 访问并被 list.js 引用）。
- **未跑测试**：04-test 未执行，前端无单元测试可跑（测试均为服务端）。

## 动态验证记录

环境：服务已在 7317 运行（未启停），PowerShell 5.1.26100，curl.exe。

**1) 四个页面 HTTP 状态（脚本标签顺序与存在性）**
```
PS> foreach ($p in @('/','/index.html','/work.html','/settings.html','/reader.html')) { curl.exe -s -o $out -w "%{http_code} %{size_download}b %{content_type}" ($base + $p) }
GET /            -> 200 4890b text/html; charset=UTF-8
GET /index.html  -> 200 4890b text/html; charset=UTF-8
GET /work.html   -> 200 3545b text/html; charset=UTF-8
GET /settings.html -> 200 6042b text/html; charset=UTF-8
GET /reader.html -> 200 7467b text/html; charset=UTF-8
```
脚本引用顺序（reader.html，classic 脚本先于 module，顺序正确）：
```
reader.html:124: <script src="assets/vendor/md/marked.min.js"></script>
reader.html:125: <script src="assets/vendor/md/purify.min.js"></script>
reader.html:126: <script src="assets/vendor/md/highlight.min.js"></script>
reader.html:127: <script type="module" src="assets/reader.js"></script>
index.html:112: <script type="module" src="assets/list.js"></script>
work.html:77:    <script type="module" src="assets/work.js"></script>
settings.html:131: <script type="module" src="assets/settings.js"></script>
```

**2) 逐个资源验证（含体积）**
```
/assets/app.css                             200|15333|text/css
/assets/app.js                              404|137|application/json     ← 无任何页面引用，可忽略
/assets/list.js                             200|20598|application/javascript
/assets/work.js                             200|13532|application/javascript
/assets/settings.js                         200|8340|application/javascript
/assets/reader.js                           200|22628|application/javascript
/assets/reader.css                          200|24975|text/css
/assets/chat.js                             200|27925|application/javascript
/assets/translate.js                        200|7382|application/javascript
/assets/viewer.js                           200|12616|application/javascript
/assets/api.js                              200|2597|application/javascript
/assets/ui.js                               200|2971|application/javascript
/assets/vendor/pdfjs/pdf.min.mjs            200|523774|application/javascript
/assets/vendor/pdfjs/pdf.worker.min.mjs     200|1321307|application/javascript
/assets/vendor/md/marked.min.js             200|35479|application/javascript
/assets/vendor/md/purify.min.js             200|21496|application/javascript
/assets/vendor/md/highlight.min.js          200|121727|application/javascript
/assets/vendor/md/github.min.css            200|1309|text/css
/lit-uploader.user.js                       200|25638|text/javascript     ← list.js:419 的「装脚本」链接可用
/favicon.ico                                404|133|application/json     ← 每页控制台一条 404，无功能影响
```
结论：**引用资源 0 个 404，不存在白屏级缺文件**。

**3) 缓存策略实测（maxAge: 0 是否等于每次重下 1.8 MB）**
```
PS> curl.exe -s -D - -o NUL http://127.0.0.1:7317/assets/vendor/pdfjs/pdf.min.mjs
HTTP/1.1 200 OK
Cache-Control: public, max-age=0
Last-Modified: Sat, 31 Oct 2026 04:20:06 GMT
ETag: W/"7fdfe-1a1902faf5f"
Content-Length: 523774

PS> 带 ETag 复访：
pdf.min.mjs If-None-Match -> 304 Not Modified
reader.js  If-None-Match -> 304 Not Modified
reader.js  If-Modified-Since -> 304 Not Modified
```
结论：`maxAge: 0` 只取消强缓存，ETag 弱缓存仍生效，重复访问是 304 不是重下——**"每次刷新重下 1.8 MB"不成立**，代价仅为每资源一次条件请求。

**4) 死文件引用关系（可删性）**
```
PS> Select-String -Path web\preview-optimized.html,web\reader-preview.html,web\reader-preview2.html,scripts\make-preview.js -Pattern 'reader-preview|preview-optimized|make-preview|preview2'
scripts\make-preview.js:3: * 用法：node scripts/make-preview.js <workNo> <fromPage> <toPage> [outFile]
（其余 3 个文件 0 命中；全仓 server/ 下 grep 'preview|make-preview' 亦 0 命中）

web\preview-optimized.html   9,844 bytes   158 lines
web\reader-preview.html      7,052 bytes   126 lines
web\reader-preview2.html    13,958 bytes   224 lines
scripts\make-preview.js      9,363 bytes   225 lines
三个 preview 合计 30,854 bytes
vendor 目录总计 5.29 MB（其中 md/ 0.17 MB 仍在使用）
```

**5) 全局能力探测（grep 实证）**
```
PS> Select-String -Path web\assets\*.js -Pattern 'visibilitychange|beforeunload|pagehide|last-event-id'
（0 命中 —— 无页面切换/卸载钩子、无 SSE 断点续传）

PS> Select-String -Path web\assets\*.js -Pattern '(?<![.\w])fetch\('
api.js:27:  res = await fetch(path, init);
api.js:59:  const res = await fetch(`/api/works/${encodeURIComponent(no)}/asset`, { method: 'POST', body: fd });
chat.js:443: const res = await fetch(`/api/chats/${this.chatId}/messages`, {
chat.js:598: const res = await fetch(`/api/chats/${this.chatId}/attachments`, { method: 'POST', body: fd });

PS> Select-String -Path web\assets\*.js -Pattern 'window\.__|window\.marked|window\.DOMPurify|window\.hljs'
chat.js:14 / 28 / 29 / 31 / 34, translate.js:9 / 64 / 65, list.js:316 / 323

PS> Select-String -Path web\assets\*.js -Pattern 'const \$ = '
list.js:22  reader.js:14  settings.js:8  work.js:21   （4 份重复）
```

**6) SSE 取消/生命周期链路（服务端确证）**
```
routes/chat.js:137  r.post('/chats/:id/messages/:mid/cancel', ...)  → 只用 :id，cancelTurn(Number(req.params.id))
services/chat/agent.js:68-74  cancelTurn：!cur 时 return {canceled:false, reason:'no-inflight'}（不抛错）
services/translate/pipeline.js:442-444  runner.canceled → finishJob(...,'paused') + emit('paused')  ← 前端有监听，链路完整
services/layout/job.js:149-155  cancelLayoutJob：只 abort + 改 status，无 emit、无 res.end  ← finding 9
services/translate/pipeline.js:673-681  客户端 close → listeners 空 → ctl.abort()  ← finding 1
```
