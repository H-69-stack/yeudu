# 03-code「P3 视觉通道渲染栈」独立验证报告

| 项 | 内容 |
|---|---|
| 被测 | `03-code/server/services/chat/render/page-image-source.js`（675 行）、`render/render-geometry.js`（125 行）、`tools/lit-page-image.js`（152 行）、`config.js` 的 `chat.pageImage` 段 |
| 测试者 | agent-harness-tester（**未采信实现者自测的 23/23**，全部用例自行构造） |
| 环境 | Node v22.22.2 / 03-code 不装 playwright（用 `deepseek-harness-master/node_modules/playwright`）/ Chromium `chromium-1228` / pdfjs-dist **6.4.299** / 库 `data/app.db` 400 works、13 篇有本地 PDF |
| 纪律 | 只读 03-code 源码；未改任何被测文件。探针脚本全在 `04-test/`（见附录）。工具自身会按设计写 `data/attachments`（内容寻址，属正常行为） |
| 结论 | **可以信任**（A–E 全过，另加 6 项对抗性补充；1 条建议级整改 + 2 条未验证） |

> 复现：先 `cd "D:/A-knowledge/agent工作流优化/03-code"`，再 `node --no-warnings "D:/A-knowledge/agent工作流优化/04-test/probe-render-stack.mjs"`。
> 所有探针都把 `TEMP/TMP/TMPDIR` 指到 `04-test/.tmp`（受限 shell 下 `chromium.launch()` 会 `EPERM: mkdtemp`）。

---

## 0. 事实基线（从库里查，不猜路径）

```
facts: works=400 pdfFileExists=13 noPdfAsset=387 assetButFileMissing=0
facts: 样例(有PDF)=1.11,1.17,1.18 样例(无PDF资产)=1.1,1.10,1.12
env:  node=v22.22.2 db=data/app.db storageRoot=storage/pdfs
renderer: {"pdfjsVersion":"6.4.299","pdfjsDir":"…\\03-code\\node_modules\\pdfjs-dist",
           "assetCounts":{"build":6,"standard_fonts":14,"cmaps":168,"iccs":1,"wasm":7},
           "chromiumExecutable":"…\\chromium-1228\\chrome-win64\\chrome.exe"}
```
A/B/C 用 `1.11`（第一篇有本地 PDF 的文献，10 页）；D 的 `no_pdf` 用 `1.1`（387 篇里没有 PDF 资产的一篇）。

---

## A. 真实渲染能出图 —— PASS（5/5）

```
PASS A1 PNG 字节 > 5KB :: 551.3KB（564548B）
PASS A2 PNG magic bytes = 89 50 4E 47 :: 89504E470D0A1A0A
PASS A3 解码宽高 ≤ maxEdge(1500) 且与返回值一致 :: 解码=1125x1466 返回=1125x1466 scale=1.860 pageCount=10
PASS A4 渲染耗时可接受（首调含 launch） :: 907ms（no=1.11 p1，564548B）
PASS A5 非空白图（>50KB） :: 551.3KB（纯白 PNG 通常 <10KB）
```
- 宽高是我**自己从 PNG 头解析**的（IHDR：`b.readUInt32BE(16/20)`），不是采信返回值 ⇒ 1125×1466 与返回值一致。
- 长边 1466 < 1500：是 `maxPixels=1_650_000` 先到顶（面积约束），`maxEdge` 未成约束 —— 几何行为正确（C4 交叉验证）。
- 首调 907ms 含 `chromium.launch()`；热调 30–900ms（见 §X）。

---

## B. 决定性 —— PASS（2/2）

```
PASS B1 同参数连渲两次 digest 相同（同进程，命中结果缓存） :: sha256:750889e041596f79 ×2
PASS B2 跨浏览器实例 digest 相同（真正的决定性，非缓存背书） :: sha256:750889e041596f79 ×2
```
B1 是缓存命中（弱证据）；B2 我另起了一个 `createPageImageRenderer`（新浏览器实例、空缓存），字节 sha256 完全一致 ⇒ **决定性成立**，不是"缓存背书"。

---

## C. 区域 scale（裁剪=放大，不是裁小图）—— PASS（5/5）

```
PASS C1 象限 scale ≈ 2 × 整页 scale :: full=1.860 quad=3.720 ratio=2.0000
PASS C2 象限输出像素 ≈ 整页输出像素 :: full=1125x1466 quad=1125x1466
PASS C3 象限与整页像素内容不同 :: full=6dd9519bff3c10b4 quad=894fe877225f5775
       （quadBytes=255KB < full=340KB，与"同 token、更少字节"的预期一致）
PASS C4 纯函数交叉验证（A4 595.28×841.89）：1.7817 → 3.5634，尺寸 1060x1500 vs 1060x1500
PASS C5 pxPerCell 不再是恒真式 :: full={"cellPx":42,"srcPxPerCell":23.57} quad={"cellPx":42,"srcPxPerCell":11.79}
```
C2 是"裁剪=放大"的**判别性证据**：象限输出尺寸与整页相同（不是半页 562×733）。C5 顺带确认这里**修掉了我在 dsh 侧报过的恒真式问题**（`srcPxPerCell = 42 / scale`，随实际倍率变化，dsh 旧版按区域面积开方是恒真的）。

---

## D. 契约边界 —— PASS（7/7，其中"反向验证"是重点）

| 用例 | 实测 |
|---|---|
| D1 无本地 PDF（`no=1.1`） | `status='no_pdf'`，**不抛错** ✅ |
| D2 资产行存在但文件缺失 | 库里 0 条样本（跳过）；改用 `statStoragePath('no-such-file.pdf')` ⇒ `{exists:false}` ⇒ 同一分支（D1 已覆盖） |
| D3 编号不存在（`999.99`） | **抛错**「库里没有编号为 999.99 的文献：请先用 lit_search 查编号」✅（`_resolve.js:15`） |
| D4 反向-页码越界 | **抛错** `lit_page_image: pageNo 99999 is out of range (1..10)` ✅ |
| D4 反向-PDF 路径不存在 | **抛错** `ENOENT … stat …`（见建议 R2）✅ |
| D4 反向-PDF 内容损坏 | **抛错** `page.evaluate: InvalidPDFException` ✅ |
| D5 工具层 pageNo 越界 | `await tool.execute(...)` **reject**，不 resolve 成 `no_pdf` ✅ |
| D6 代码确认 | `status:'no_pdf'` 全文**只有 1 处**（`lit-page-image.js:108`），且位于 `rendererOrThrow()`（第 113 行）**之前** |

**我如何判断"渲染失败不会静默降级成 no_pdf"**（不靠读注释，靠三条独立证据）：
1. **结构**：`no_pdf` 的唯一 return 点在 `lit-page-image.js:107-109`，判定条件是 `!asset || !stat || !stat.exists`，发生在获取渲染器之前 ⇒ 渲染器还没出现，它的失败不可能走到这行。
2. **执行**：D4 三类故障（越界/缺文件/损坏）+ D5 工具层越界 + 超时注入（§X2'）全部 `throw`/`reject`，无一返回 `status`。
3. **超时分支**（我单独注入验证）：
   ```
   空载：982ms 1582x2048 856254B（no=4.6）
   并发 10 路（renderTimeoutMs=1000）：
     #0 1598ms throw lit_page_image 渲染超时（1000ms）；可改用更小的 maxEdge 重试。
     … 共 9/10 命中超时分支，1 路在 1000ms 内完成
   判定：PASS —— 超时抛 RenderFailure，不是空图、不是 no_pdf
   ```

---

## E. 无残留进程 —— PASS（第一次判定不可信，已重测）

**第一次跑**：基线上已有 6 个 `chrome-headless-shell.exe`（本会话更早的其它进程留下的，后来随其父进程退出）。我只断言了 `after ≤ before`（6→10→6），**这不满足"应为空"的要求**，所以我在基线归零后**重测**：

```
E0 基线（渲染前）：count=0 {}
E1 渲染 3 次后：count=4 {"chrome-headless-shell.exe":4}
E2 空闲 1500ms 后 isBrowserConnected=false（应为 false）
E3 dispose 后：count=0 {}
E4 `tasklist | findstr /i chrom` 原始输出（exit=1）:
(空)
E SUMMARY {"baseline0":true,"launched":4,"idleRecycled":true,"residualAfterDispose":0,"ok":true}
```
进程名确认是 **`chrome-headless-shell.exe`**（不是 `chrome.exe`）—— 这正是你在任务里提醒的点；用 `chrome.exe` 过滤会得到"永远为空"的假断言。空闲回收走的是**与生产完全相同的代码路径**（`touchIdle` → 到期 `dispose()`），我只把阈值调成 1500ms。

---

## X. 任务清单之外的对抗性补充（6 项，PASS 5 / 见下 1 条修正）

```
PASS X1'  极端参数（maxEdge=200000 且 maxPixels=1e12）⇒ 抛错 :: 910ms :: THROW 渲染结果的字节签名不符合 image/png（前 8 字节：）
PASS X1'b 极端参数失败后同实例仍能正常渲染 :: 618x800 146209B
PASS X2   工具层 maxEdge 夹取：99999→1125x1466（≤2048）、10→460x600（≥600）
PASS X3   附件按 attachmentId 可取回 :: id=img_750889e041596f79… bytes=564548 mediaType=image/png
PASS X3'  ok 文本两次调用完全一致（同 attachmentId），含"不是 OCR"与"分辨率约提高 2 倍"
PASS X5   配置默认 chat.pageImage.enabled=false ✅
PASS 沙箱  ../../README.md / C:/Windows/win.ini / sub/../../README.md ⇒ 一律 THROW「非法的资产相对路径」✅
PASS 注册门控（三个独立进程）：
   default              ⇒ registered=false「chat.pageImage.enabled 不是 true（默认关闭）」
   enable-noplaywright  ⇒ registered=false「渲染器不可用：…未找到 playwright…（已尝试：require("playwright") 失败：MODULE_NOT_FOUND）」
   enable-playwright    ⇒ registered=true「quota=20」，buildTools⇒[lit_search,lit_read,lit_translation,lit_page_image]
PASS 跨轮配额边界（registry，maxCallsPerName=20）：
   历史已用=0/18/19 ⇒ 放行（走到 execute）   历史已用=20/21 ⇒ E_TOOL_QUOTA
   ⇒ 与 dsh 的 used > max 同义：20 次放行、第 21 次拒绝
```

**一条修正记录（我自己的错，如实记）**：我第一次的 X1 注入（只把 `maxEdge` 调到 200000）**没触发任何错误**——因为 `maxPixels` 把画布构造性封顶了（scale ≈1.86）。那次 FAIL 是**我的用例无效**，不是实现缺陷。改成两个上限同时放开后才得到上面的 X1' 结果：画布超限后 `canvas.toDataURL()` 返回空串，**被 `assertImageSignature` 拦下并抛错**（防线生效，值得记一功），且失败后同一实例仍能正常渲染。

---

## 问题清单

### R1【建议】renderer 层不夹取 `maxEdge` / `maxPixels`
`page-image-source.js:569-570` 只做 `Number(request.maxEdge) || 1500`，不夹取；夹取只发生在工具层（`lit-page-image.js:111` `clampMaxEdge`）。现在工具是唯一 Consumer ⇒ 风险被挡住；但 X1' 证明一旦两个上限同时放开，就会走到"画布超限 → toDataURL 返回空串 → 靠签名断言兜底"的路径。建议在 renderer 层也加上下限保护（工具层夹取保留，作为双保险）。

### R2【建议】`fsp.stat` 失败会把本机绝对路径带进错误信息
`page-image-source.js:577` 的 `fsp.stat(pdfPath)` 失败时抛的是裸 `ENOENT: … stat 'D:\…\does-not-exist.pdf'`。当前工具层先 `statStoragePath()`，能进入 render 的路径一定存在 ⇒ 实际不会喂给模型；但错误信息里带绝对路径与设计"文本段不含本机路径"的意图相悖，建议包一层 `RenderFailure` 并去掉路径。

### R3【建议】注释与实现不符（措辞）
`lit-page-image.js:44` 写"五段固定文本"，实际 `render()` 产出 **6 行**（第 4 行是缩进续行）——与 dsh 的 `renderText` 同构，行为无误，仅注释不准，容易误导后来者按"5 行"去校验。

### O1【观察】E 项必须用"基线差"判定
我第一次跑 E 时基线上有 6 个残留 `chrome-headless-shell.exe`（来自本会话更早的其它进程，与本栈无关，后来随父进程退出）。若只看 `findstr /i chrom` 是否为空，会误判本栈泄漏。基线归零后重测才拿到干净结论。

### O2【观察】单页 PNG 在 2048 档已达 ~982ms
空载 `4.6 p1 @2048 PNG` = 982ms（默认 `renderTimeoutMs=8000`，余量约 8×）。并发执行时单页会超 1s（§X 并发实测）。默认档（1500）约 30–900ms，正常。

---

## 未验证事项（不冒充已验证）

| # | 项 | 原因 |
|---|---|---|
| U1 | **出网闸门**（非假 origin 一律 `route.abort()`）的实际拦截效果 | 本轮任务未要求；`diag`/`handleRoute` 都在 `createPageImageRenderer` 的**闭包内部**，不改码无法在页面内注入 `fetch`。代码层确认：`page-image-source.js:414-416` 第一行 `if (!url.startsWith(ORIGIN…)) { diag.blocked.push(url); abort() }`，origin 为 RFC 2606 保留域 `http://lit-page.invalid` |
| U2 | `page.on('crash')` 崩溃自愈 | 不制造崩溃（与我在 dsh 侧同一裁决）。已实测的是 `idleTimeoutMs` 回收 + `dispose()` + 回收后重新渲染路径 |
| U3 | 资产行存在但文件缺失的 `no_pdf` 分支 | 库里 0 条这样的样本；改用 `statStoragePath()` 单测覆盖了该分支（`exists:false`） |
| U4 | 真实 Express 服务进程内的长生命周期行为（多轮复用同一渲染器） | 本轮以脚本直调模块验证，未起 HTTP 服务 |

---

## 结论

**这套渲染栈可以信任。** A（真实出图 1125×1466 / 551KB PNG / magic 正确 / 907ms 首调）、B（跨浏览器实例 sha256 一致）、C（象限 scale 精确 2×、输出像素与整页相同）、D（两态契约：`no_pdf` 唯一来源 + 六类故障与超时全部抛错）、E（基线 0 → 渲染 4 → 回收 0，`findstr /i chrom` 为空）**全部 PASS**，另加 6 项对抗性补充也全过（配额边界 20/21、注册门控三态、路径沙箱、附件可取回、文本确定性）。

三处建议（renderer 层上限保护、错误信息脱敏、注释措辞）都不影响"能用"，只是把"目前靠上游挡住的风险"改成"自己挡住"。需要留意的是 U1（出网闸门未实测）—— 它是安全属性，建议下一轮在探针里加一条页面内 fetch 注入（可能需要给 renderer 暴露一个只读的 `diag`）。

---

## 附录：我的探针（全部在 `04-test/`）

| 文件 | 覆盖 |
|---|---|
| `probe-render-stack.mjs` | A/B/C/D + E（首跑）主探针，23 条断言 |
| `probe-render-stack-E.mjs` | E 单独复跑（基线必须为 0） |
| `probe-render-stack-X.mjs` | 对抗性补充（X1 注入无效，已被 X2 取代，保留作记录） |
| `probe-render-stack-X2.mjs` | 修订版：极端参数、超时尝试、文本确定性 |
| `probe-render-stack-timeout.mjs` | 并发负载注入触发超时分支（9/10 命中） |
| `probe-render-register.mjs` | 注册门控三模式（default / enable-noplaywright / enable-playwright） |
