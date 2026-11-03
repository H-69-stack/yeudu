# A02 · 代码质量与可维护性（热点大文件）

> 评审对象：03-code/（server / web / userscript / scripts）、04-test、02-design
> 口径：05-review/_context.md（10 条不变量、severity 五级、effort S/M/L/XL）
> 只读评审：未修改 03-code / 04-test / 02-design 任何文件；未触碰 7317 服务；未执行 npm install。

## 结论

1. **"大文件"这个直觉基本是错的**：最长的 buildPages.js（923 行 / 非空 752）由 8 个纯函数分步组成、零 IO、有 174 行单测，是全项目可维护性最好的模块之一；真正病态的是 `page-image-source.js` 里 **322 行的单个工厂函数**和 `pipeline.js` 里 **220 行的 runJob**。
2. 最贵的可维护性负债不是行长，而是**同一段编排写了两份**：chat 的 SSE 骨架在 `agent.js` 与 `pipeline.js` 中逐行复制（约 30 行 ×2），并且**已经漂移**——legacy 侧有幂等守卫，tools 侧没有，异常路径会重复插一条 assistant 消息。
3. 阈值治理的真实状态是"**绝大多数已进 config，少数关键的重试/渲染默认值被写了 2～3 份**"：config.js 已覆盖 30%、8KB、1.25、columnRules 四键、budget、检索预算等；但 `1500 / 1650000 / 0.85 / 8000` 在 config、page-image-source、lit-page-image 三层各写一遍，`700ms + 尝试 2 次` 在 downloader 与 translate 各写一遍。
4. **注释质量是显著优点**（解释"为什么"、带实测依据），且 153 处 `§x.y` 设计文档引用经交叉核验 **0 处悬空**——风险不是"引用错了"，而是"改阈值时必须去翻 194KB 文档"。
5. 最大的"零风险高收益"动作是清理：`03-code/.tmp/` 躺着 **42 个一次性脚本 + 5.5MB 的 app.db.bak**，`web/` 下 **3 个孤儿预览页**仍被 HTTP 200 提供、全树 0 处引用，`npm test` 之外还有一堆没有入口的手工脚本。

## 一、结构诊断（Q1：逐文件，含真实度量）

度量方法：非空行 = `Get-Content | Measure-Object -Line`（不计空行，即 briefing 里的口径）；总行数/函数跨度/缩进深度由 `node` 脚本实测（见"动态验证记录" V1/V3）。**注意：报告里凡是转述 briefing 的行数都已经是"非空行"口径。**

| 文件 | 总行 / 非空 | 最长函数 | 跨度 | 非空 | 缩进深度* | 模块级可变状态 | 职责数 | 可单测 |
|---|---|---|---|---|---|---|---|---|
| services/pdf/buildPages.js | 923 / 752 | `detectColumns` L191 | 149 | 142 | 4 | 0（纯函数） | 1（双侧栏检测）+ 若干 `??` 兜底参数 | ✅ 已测（174 行） |
| services/translate/pipeline.js | 812 / 763 | `runJob` L252 | **220** | **208** | 4 | 2（`runners`/`jobStats`） | **6** | ❌ 无测试（需 DB+SSE+引擎） |
| services/chat/render/page-image-source.js | 675 / 611 | `createPageImageRenderer` L320 | **323** | **307** | 5 | 10（全部闭包内） | **7** | ❌ 无测试（要真 Chromium） |
| services/downloader.js | 661 / 601 | `processJob` L186 | 117 | 110 | 5 | 6（queue/controllers/progress/activeCount/lastRequestAt/booted） | **6** | ❌ 无测试（downloader.test.js 只测纯函数） |
| services/llm/client.js | 459 / 435 | `openaiChatStream` L331 | 75 | 74 | 4 | 0 | 1 | ✅ 结构上易测（纯 fetch 包装），但 ❌ 实际无测试 |

\* 缩进深度为 `node` 脚本按 2 空格折算实测值；`runJob` 实测报 26，是内部模板字符串/多行参数的续行造成的虚高，人工核对为 **4 层**（`pool` 回调 → `try` → `if` → 事务），故表中填 4。

**逐文件结论**

- **buildPages.js（923 行）——不是问题，是本项目最好的结构。** 8 个 S 步（groupLines → detectColumns → orderLines → mergeParagraphs → classifyRole/classifyRich → joinContinuations → dropRepeatedMarginalia → hoistDropCaps → buildPagesFromRaw）各自单进单出、纯函数、零 IO，头注释明写"§16.2 S1–S7，纯函数、零 IO"。最长函数 142 行偏长，但它是**算法密度**（6 档宽度假设 + 跨栏行剔除 + 容差细化），拆开反而更难读。**建议：不动。**
- **pipeline.js / runJob（220 行，208 非空）——最该拆的一个。** 一个函数里同时做：取 job/asset/work、构引擎链、cacheKey 命中判定与写入、算 pageTotals/pageDone、定义 `pushProgress` 闭包、排序分批、`pool` 并发、单批 `upsert + indexTranslation` 同事务、页面级 SSE 推送、失败指纹记账、终态判定与 `finishJob`、写 jobStats、打日志。局部可变变量 ≥9 个（doneSegments / failedSegments / batchesDone / requests / batchCount / usage / startedAt / lastProgressAt / cursor）。它同时耦合 DB、SSE、并发、计费四类副作用，**任何一类出问题都无法在测试里单独复现**——这是它 0 测试的直接原因。
- **page-image-source.js / createPageImageRenderer（323 行，307 非空）——结构性最差。** 一个工厂函数体内嵌了 10 个闭包（`serialize`、`touchIdle`、`dispose`、`ensureBrowser`、`handleRoute`、`ensurePage`、`diagTail`、`renderOnPage`、`withDeadline`、`render`）和 10 个闭包可变状态（`browser/browserContext/launching/page/diag/idleTimer/queue/docs/cache/executablePath`）。其中 `handleRoute` 是一段完整的"假 origin HTTP 服务器"（404/fulfill/vendor 白名单），把它塞进渲染器工厂里纯属就近放置。**但它默认关闭（`chat.pageImage.enabled: false`）、只在 `lit_page_image` 工具路径可达**，所以严重度必须降级：可维护性差 ≠ 现在会坏。
- **downloader.js / processJob（117 行）——中等偏长，但六段职责是"一条线性状态机"，可读性好于 runJob**（每一步都有 `markStatus` 显式落库，DB 即真相这条不变量在代码上是看得见的）。真正的结构隐患在 `bootDownloader` 的 try/catch 半包（见 F3）。
- **llm/client.js——五个文件里最健康的**：`httpJson` 是唯一 fetch 点，`withRetry`/`combineSignal`/`safeUrl` 抽得干净，三个协议各 40 行左右。唯一硬伤是 `max_tokens` 默认值同协议两套（4096 vs 1600）。

## 二、重复实现诊断（Q2）

**① `services/segment.js`（220 行）与 `services/pdf/spaceFix.js`（341 行）——不是同一件事的两个版本，是两件事。** 证据：segment.js 导出的是"文本清洗 / 分句 / 分段 / 编号协议"（`cleanPageText`/`splitSentences`/`splitParagraphs`/`buildBatches`/`buildNumberedPrompt`/`parseNumberedResult`），调用方是 pipeline.js（`buildBatches`）、buildPages.js（`splitParagraphs`/`cleanParagraphText`）、engines/shared.js（编号协议）；spaceFix.js 导出的是"PDF 负字距吞空格后的词表 + DP 回切"（`buildVocabulary`/`restoreSpaces`/`restoreSpacesInItems`/`fixSplitLetters`/`plausibleGlueSplit`），调用方是 extractor.js 与 buildPages.js。两者唯一的语义交叠是"都在处理空格/断词"，但一个是排版层、一个是语言层，**不建议合并，建议在文件头互相加一行交叉引用**（现在 segment.js 头注释讲了 NFKC，spaceFix.js 没提 segment.js，读者容易以为重复）。

**② `chat/agent.js` 与 `chat/pipeline.js` 的边界——划得很清楚，但骨架被复制了两份。** 边界由 `config.chat.engine`（`legacy` / `tools`）分派，agent.js 头注释 L9-10 明确写了"legacy 是回退通道，改 config 就能退回旧行为"——这是**有意的双轨设计，不是历史垃圾**，且 `session.js`/`citations.js`/`prompts.js`/`runtime.js` 已被抽走共用。问题在于**编排骨架没抽**：`res.writeHead(...'text/event-stream')` → `send()` → `setInterval` 心跳 → `AbortController` + `registerTurn` → 90s 定时器 → `cleanup()` → `res.on('close')` 这 30 行在 agent.js:90-122 与 pipeline.js:198-228 **逐行相同**（只有 `engine: 'legacy'` / `'tools'` 一个字段不同），pipeline.js 自己的头注释 L12-13 也承认"其余……全部与 legacy 同构"。**而它已经漂移了**（F2）：legacy 侧用 `persistAssistant` 带 `persisted` 幂等守卫，tools 侧直接 `insertAssistantMessage`，异常路径没有守卫。

**③ 三个引擎文件（openaiCompatible / gemini / claude）——重复度最高，但危害最低。** 实测共用行（trim 后非空行多重集）：`gemini.js` vs `claude.js` 共用 37 行 / 较大文件 44 行 = **84%（Jaccard 0.740）**；`openaiCompatible.js` vs `claude.js` = 66%（0.550）。差异只有 3 处：`name`、`desc` 字符串、以及 `call` 里调 `geminiChat`/`anthropicChat`/`openaiChat`（openaiCompatible 多一个 `baseUrl` 参与 `configured` 判断）。真正的重活已经在 `engines/shared.js:31 translateItems()` 里了，所以这三个文件本质是**声明式适配器**，重复的是对象字面量的 12 个字段。**合并建议**：`createAdapterEngine(cfg, { name, desc, call })` 工厂 + 三个 8 行文件，净减约 90 行；风险极低（有 `registry.js` 的 `getEngine` 每次重建做兜底，且 `tool-registry.test.js` 覆盖了 engine 列表）。**优先级放在清理类，不放在重构类。**

## 三、配置 vs 硬编码（Q3 表）

先纠一个口径问题：briefing 提到的 `1200 / 2400 / 400 / maxItems=4` 在本代码里**找不到对应物**——引擎 `maxItems` 的真实来源是 `registry.js:55-56` 的 `Number(o.maxItems || config.translate.batchItems || 6)`，默认 **6**；`3600 / 1600 / 600 / 800000 / 300000` 全部在 config.js 里（chat.retrieveChars / chat.selectionChars / extract.paragraphChars / budget.*）。**不能写"魔法数字遍地"。** 真实分布如下：

| 参数 | 值 | 位置 | 状态 | 建议 |
|---|---|---|---|---|
| PDF 最小体积 / 下载超时 / 最大字节 / 重定向数 / 恢复轮数 | 8192 等 | config.download.* | ✅ 已配置 | — |
| 翻译批大小 / 批字符 / 并发 / 温度 / maxTokens | 6 / 3000 / 2 / 0.3 / 4000 | config.translate.* → registry → engines | ✅ 已配置 | — |
| 段落切分 / 段间距 / 栏规则 ×4 / 角色阈值 ×5 | 600 / 1.25 / 1.0,[0.3,0.7],3,0.35 / 0.45,2,0.1,40,90 | config.extract.* → extractor.js:201-205 → buildPages | ✅ 已配置 | — |
| 检索 / 选区 / 历史 / 工具轮次预算 | 3600 / 1600 / 4 / 8+5 | config.chat.* | ✅ 已配置 | — |
| 角色阈值 ×5（同一组值的第二份） | 同上 | **buildPages.js:17-23 `DEFAULT_ROLE_RULES`** | ⚠️ 与 config 双份 | 删掉 export，或反过来让 config 引用它 |
| 单源尝试次数 | 2 | downloader.js:225 | ❌ 硬编码 | `download.attemptsPerSource` |
| 失败后间隔 | 700ms | downloader.js:271 **且** pipeline.js:242 | ❌ 硬编码 ×2（同值） | `*.retryDelayMs` |
| 退避序列 + 抖动 | [1000,4000,15000] × (0.8~1.2) | downloader.js:308 | ❌ 硬编码 | `download.backoffMs` |
| 翻译每引擎尝试 / 打转检测 | 2 / 2 | pipeline.js:217 / pipeline.js:363 | ❌ 硬编码 | 前者进 config，后者加注释即可 |
| 进度落库频率 | 300 | pipeline.js:354 `flushEvery` | ❌ 硬编码 | `translate.progressFlush` |
| 翻译并发（二次兜底） | `config... \|\| 2` | pipeline.js:439 | ⚠️ 配置值 + 代码兜底双写 | 删 `\|\| 2`，让 config 唯一 |
| SSE 心跳 | 15000 | agent.js:103 **且** pipeline.js:211 | ❌ 硬编码 ×2 | `chat.heartbeatMs` |
| 整轮上限（二次兜底） | `config... \|\| 90000` | agent.js:108 / pipeline.js:215 | ⚠️ 双写 | 删兜底 |
| chat max_tokens 默认 | **4096** vs **1600** | client.js:243 vs client.js:414 | ❌ 同协议两套默认 | 统一为 1600（与 config 一致） |
| 渲染 maxEdge / maxPixels / jpegQuality | 1500 / 1650000 / 0.85 | config.chat.pageImage.*** → lit-page-image.js:111-122 → **page-image-source.js:569-573 再兜一次** | ⚠️ 三层 | 只在 config 定义，渲染器要求显式传入 |
| 渲染超时 | 8000 | config:60 → lit-page-image.js:92 → page-image-source.js:323 | ⚠️ 三层 | 同上 |
| 空缝倍率 caps / maxCrossShare | [0.4..0.7] / 0.35 | buildPages.js:216/221（`opts.X ??`，但**无调用方传**） | ❌ 名义可配、实际硬编码 | 要么接进 config.extract.columnRules，要么删参数 |
| 版面微系数 | 0.93 / 0.8 / 120 / 320 / 1.4 / 1.12 / 0.82 / 60 / 30 / 200 / 0.08 / 0.3 / 4 / 1.5 / 20 / 0.04 / 0.4 …（≥25 处） | buildPages 各函数体内 | ❌ 纯字面量 | **不建议全进 config**：先提成文件顶部 `const LAYOUT = {...}` 集中命名即可 |
| lit_read / lit_translation 截断 | 6000 / 200 / 20000 | lit-read.js:33,44 / lit-translation.js:29,46 | ❌ 硬编码 | 工具参数默认值，低优先 |

判断：**阈值治理已经做了 80%**，剩下的是"同一语义多处默认"而不是"散落不可配"。所以最有价值的改动不是建大配置表，而是**消除重复定义**（谁是真源要唯一）。

## 四、注释与命名（Q4）

**正面**：注释整体是"为什么"，而且带实测依据，是全项目最强的工程习惯之一。例如 downloader.js:5 `真相：download_jobs 表是唯一事实源，内存队列只是它的投影（§9.4）`；buildPages.js:268 `（实测 12pt 的缝被算成 5.2pt，直接过不了 minGapPct）。所以用真实行边界细化它。`；shared.js:4-7 解释"为什么解析失败要逐段补译而不是整批失败"；agent.js:9-10 解释"两种引擎为什么并存"。

**`§x.y` 当注释的依赖风险（实测结论与直觉相反）**：全树 **153 处 `§` 标记、49 个不同章节号、分布在 64 个文件**；把 02-design 下所有 md 的一级~六级编号标题抓出来（111 个编号标题）做集合比对，**悬空引用 0 处**。所以风险不是"引用已经错了"，而是两点：(a) 重构/合并模块后 `§` 会静默变成谎言，没有任何机制能发现；(b) 有若干**纯指针型注释**——只给章节号不给理由，读者必须打开 194KB 文档才能判断能否改。典型：downloader.js:86 `幂等检查顺序见 §15.2`、downloader.js:61 `启动恢复：悬挂状态重置为 queued（§9.4 恢复策略 ①）`、buildPages.js:2 `§16.2 S1–S7`。**建议**：给纯指针型注释补一句"理由"（现有其它注释已经这么做了，只是这几处漏了）；不要把 `§` 全删——它是与设计文档唯一的可追溯连接。

**局部漂移 3 处**（都不是"注释说谎"，而是"承诺 > 实现"）：
1. buildPages.js:783 JSDoc 声明 `lineGapRatio?:number`，代码读的是 `paragraphGapRatio`（L384/L845）——传 `lineGapRatio` 会被静默忽略。
2. buildPages.js:10 `参数全部可配（extract.roleRules / lineGapRatio 等）`——同上，`lineGapRatio` 不存在。
3. engines/shared.js:47-53 的 try/catch 两个分支都 `throw`，等价于没有 catch，`FATAL` 集合因此从未生效。

## 五、死代码 / 半成品（Q5：结论全部来自 grep 调用点，不是感觉）

| 对象 | 结论 | 证据 |
|---|---|---|
| `page-image-source.js` | **有调用链，但是条件通道**：`chat/tools/index.js:12` 与 `chat/tools/lit-page-image.js:20` 都 import `getSharedRenderer`；注册条件是 `config.chat.pageImage.enabled !== true → return { registered: false }`（tools/index.js:40-41），默认 false。所以它是"写完了、测过、默认关着的可选能力"，**不是死代码也不是半成品** | tools/index.js:40-41 |
| `routes/layout.js` + `services/layout/*` | **活代码，且被前端在用**：`app.js:22,59` 挂载；`web/assets/reader.js:243` `api.post('/api/works/${no}/layout', ...)`、L256 取消、L267 订阅 SSE。`services/layout/refine.js` 另有 `scripts/verify-refine.js` 引用 | app.js:59 / reader.js:243 |
| `web/preview-optimized.html` / `reader-preview.html` / `reader-preview2.html` | **孤儿**：全树内容 grep 0 命中（含 .md/.txt），但 `app.js:77` 的 `express.static(WEB_DIR, …)` 让它们仍可被任意访问；实测 `200 / 13958B`、`200 / 9844B`。合计 30.8KB / ~400 非空行 | V5 curl |
| `scripts/make-preview.js`（212 非空行） | **一次性产物**：`package.json` 的 scripts 只有 `start/import/import:dry/test/fts:rebuild`，make-preview 无入口；全树除自身头注释外 0 引用。同目录另有 `probe-batch.js`、`verify-refine.js` 也是手工脚本（scripts/ 共 3 个文件） | V5 |
| `03-code/.tmp/`（42 个文件 / 5.54MB） | **全部是一次性探查脚本 + 一份数据库备份**：38 个 `.mjs`（`dbg_*`/`probe*`/`scan_*`/`reextract*`…）、1 个 `.py`、`app.db.bak`（5.49MB）、`server.log`（0 字节）。没有 .gitignore（本项目无 git），也没有任何引用 | V4 |
| `services/segment.js` 的 `cleanPageText` / `splitSentences` | **未被直接调用，但间接活**：`cleanParagraphText`（L46）内部调 `cleanPageText`，`splitParagraphs`（L133）内部调 `splitSentences`；只有测试直接 import 它们 | batches.test.js:6 |

## 六、findings

### F1 · `translate/pipeline.js` 的 `runJob` 是 220 行 / 6 职责 / 9 个可变局部的多副作用函数，且 0 测试
- **严重度**：medium ｜ **effort**：M
- **现象**：`runJob` 从 L252 到 L471，一个函数里串联了"取数据 → 构引擎链 → 缓存判定与回写 → 进度计算 → 分批 → 并发 → 事务落库 → SSE 推送 → 失败记账 → 终态判定 → 统计 → 日志"共 6 类职责，局部可变变量 ≥9 个。它是整个翻译链的唯一执行入口（`startTranslate` → `runJob`），却没有一行测试（`server/test/*.test.js` 18 个文件里没有 import 它）。
- **证据**：
  ```js
  async function runJob(jobId, { engineIds }) {
  ...
    const batches = buildBatches(ordered.map((s) => s.text), {
  ```
  L252 起，跨度 220 行、208 非空行；缩进实测 4 层（`pool` 回调 → `try` → 条件 → 事务）。
- **影响**：改翻译链任何一段（缓存、并发、SSE 字段）都要读 220 行才能确认无冲突；出问题时无法用单测定位到"缓存命中判定"还是"进度上报"还是"终态判定"——只能整链跑真引擎（本项目无 key，等于**无法验证**）。
- **建议**：按副作用切三段纯化——`planBatches()`（纯：段 → 批 + pageTotals）、`translateOneBatch(batch)`（返回结果/错误，不碰 DB）、`commitBatch()` + `finalizeJob()`；SSE 推送收敛到一个 `emit` 包装里（现在 `emit` 已有，直接复用）；中间产物用 return 值而非闭包变量传递。
- **风险比**：中。SSE 事件契约与 DB 写入顺序是不变量 8/9 的落地处，重构必须用现有 155 个测试 + 一个 mock 引擎跑通（`AGENTLIT_MOCK_ENGINE=1` 已有开关）。

### F2 · tools 引擎的异常落库没有幂等守卫，与 legacy 侧已漂移——异常路径可能给同一轮插两条 assistant 消息
- **严重度**：medium ｜ **effort**：S
- **现象**：`chat/pipeline.js` 在同一函数的成功分支（L322）和 catch 分支（L361）各调一次 `insertAssistantMessage`，**没有 `persisted` 标志**；而 legacy 侧 `chat/agent.js:128-130` 是 `const persistAssistant = (...) => { if (persisted) return assistantMsgId; persisted = true; … }`。也就是说：L322 落库之后、`res.end()`（L350）之前若抛错（`send('done')` 写已销毁的 socket、`log.info` 抛、`assembleCitations` 之外任何意外），catch 会**再插一条**。
- **证据**：
  ```js
  const assistantMsgId = insertAssistantMessage(chat, {   // L322
  ...
      insertAssistantMessage(chat, {                       // L361  (catch 内)
        content: assistantText,
        citations,
  ```
  对照 agent.js:128 `const persistAssistant = ({ truncated, errorCode = null, … }) => {` / L129 `if (persisted) return assistantMsgId;`。
- **影响**：触发条件窄（落库后、结束时抛错），但一旦触发就是**历史里出现两条相同回答**，且 `truncated=0` 与 `truncated=1` 并存，前端回看与后续摘要（`historyTurns=4`）都会把它当两轮。这正是"同一段编排写两份"的典型代价。
- **建议**：把 `persistAssistant`（含守卫）从 agent.js 提到 `chat/session.js` 或新建 `chat/turn.js`，两个引擎都只调它；顺手统一 catch 分支要带哪些字段（legacy 丢 `contextMeta`、tools 写 `{engine:'tools',partial:true}`，也应一致）。
- **风险比**：低-中（改动只碰收尾路径，可用 `page-image-inject.test.js` 同款的 mock 引擎测）。

### F3 · `bootDownloader` 的 try/catch 只包住同步段：readdir 失败会让**服务起不来**，catch 分支则静默放弃恢复
- **严重度**：medium ｜ **effort**：S
- **现象**：`try` 块里只有 `const dir = tmpDir()` 是同步的，后面整条 `fsp.readdir(...).then(...)` 链是异步的，**异常不会进 catch**。而 `index.js:27` 是 `await bootDownloader()`，`main().catch` 直接 `process.exit(1)`——所以 `.tmp` 目录不可读（权限、被清理工具删掉、Windows 文件锁）会让整个服务**起不来**，而不是"跳过残片清理继续启动"。反过来，若 `tmpDir()` 同步抛错走进 catch，则 `booted = true` 之后**既不入队也不 pump**：DB 里所有 `queued` 任务永久停在 queued（不变量 4 的"内存队列只是投影"这条自愈能力失效），而 `booted` 只被测试读取（`export { booted }` 在 L660），生产代码无人观察。
- **证据**：
  ```js
  try {
    const dir = tmpDir();
    return fsp
      .readdir(dir)
  ...
  } catch {
    booted = true;
  }
  return Promise.resolve();
  ```
- **影响**：一条常见运维动作（清理 tmp / 目录权限变更）能让服务无法启动且报错栈指向 `readdir` 而非"清理失败、已跳过"；另一条分支则是"重启后下载任务永不自动恢复"的静默降级。
- **建议**：改成 `async function bootDownloader()`，`try { await fsp.readdir(...) } catch (e) { log.warn('download.boot_tmp_unreadable', {...}) }`，**残片清理失败绝不能阻断入队与 `pump()`**；把"入队 + pump"放到 try 之后无条件执行。
- **风险比**：低（启动路径，改完 `node server/index.js` 一次即可验证）。

### F4 · chat 的 SSE 编排骨架在 `agent.js` 与 `pipeline.js` 中逐行复制（约 30 行 ×2），修 bug 必须改两处
- **严重度**：medium ｜ **effort**：M
- **现象**：`res.writeHead` 的四行头 → `send(event,payload)` → `setInterval` 心跳 15s → `AbortController` + `rt.registerTurn` → 90s 整轮定时器 → `cleanup()` → `res.on('close')` 中止上游，这 7 个步骤在 agent.js:90-122 与 pipeline.js:198-228 **除 `engine: 'legacy'|'tools'` 外完全相同**。pipeline.js 头注释 L12-13 自己写明"其余（SSE 头、心跳、90s 整轮上限、客户端断开→中止、部分产出保留并标 truncated、引用程序装配）全部与 legacy 同构"。
- **证据**：
  ```js
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
  ...
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15000);
  ```
  agent.js:90-103 / pipeline.js:198-211，两段 `diff` 只差 engine 字段与一行注释。
- **影响**：F2 就是这套复制的既成后果；后续任何"心跳改 10s""断线要落 usage""超时要推 error 帧"的改动，漏改一侧 → 两个引擎行为不一致，而 `config.chat.engine` 默认是 `legacy`，**用户实际跑的那一侧可能正是没被改的那一侧**。
- **建议**：抽 `chat/sse-turn.js`：`openTurn(res, {chatId, messageId, ctl, engine, timeoutMs}) → { send, onClose, cleanup }` + `persistAssistant`（含幂等守卫）。两个引擎只保留各自的"取模型输出"部分，net 减约 120 行重复。
- **风险比**：中（触及两个入口 + 前端 4 种事件契约；建议先抽 `persistAssistant`（F2）再抽 SSE 头，分两步走）。

### F5 · 7 个热点模块零测试，而 `npm test` 的 glob 只覆盖 `server/test/*.test.js`
- **严重度**：medium ｜ **effort**：L
- **现象**：`npm test` = `node --no-warnings --test "server/test/*.test.js"`。实测这 18 个测试文件 import 的模块里，**没有**：`translate/pipeline.js`、`llm/client.js`、`downloader.js`（`downloader.test.js` 存在但没 import 它）、`chat/agent.js`、`chat/render/page-image-source.js`、`layout/refine.js`、`extractor.js`。有测试的是 `buildPages.js` / `segment.js` / `spaceFix.js` 等纯函数。04-test 下的 e2e（如 `e2e-multimodal-upload.mjs`）不在 test glob 里，等于手工用例。
- **证据**：
  ```json
  "test": "node --no-warnings --test \"server/test/*.test.js\"",
  ```
  package.json:15（scripts 全量：`start / import / import:dry / test / fts:rebuild`）。
- **影响**：155 个测试全部绿灯给人"有测试"的错觉，但**所有跨模块副作用路径（下载状态机、翻译批处理、chat 编排、LLM 重试）都在测试覆盖之外**；这直接放大了 F1–F4 的风险，也是为什么这些文件会长成"只能整体跑"的形状。
- **建议**：不追求覆盖率，只补 4 条**离线可跑**的契约测试：①`processJob` 用 `AGENTLIT_MOCK_ENGINE`/本地 http stub 跑通 done+failed+needs_manual 三态；②`withRetry` 对 429/500/超时的重试次数；③`runJob` 用 mock 引擎 + 临时 DB 跑"缓存全命中"路径（应 0 次上游调用）；④tools 引擎的重复落库（F2 回归）。最后把 04-test 的 e2e 挂进 `test:e2e` 脚本。
- **风险比**：无（只加测试）。

### F6 · `page-image-source.js` 的 `createPageImageRenderer` 是 323 行单函数（10 闭包 + 10 状态），并把 5 个阈值写成了第二份默认值
- **严重度**：low ｜ **effort**：M
- **现象**：一个工厂函数里塞了完整的浏览器生命周期（惰性 launch / disconnected 自愈 / 空闲回收 / 串行化队列 / PDF 文档登记表 / LRU 缓存 / 超时熔断 / 诊断汇聚）**外加一个假 origin 的 HTTP 路由实现**（`handleRoute`，含 `/doc.pdf`、`/vendor/*` 白名单、404 策略）。同时 `render()` 内又写了一份 `1500 / 1_650_000 / 0.85` 的默认值，与 config.js:58-74 和 lit-page-image.js:111-122 构成三层重复。**注意它默认关闭（`enabled:false`），只经 `lit_page_image` 工具可达。**
- **证据**：
  ```js
  export function createPageImageRenderer(opts = {}) {
  ...
      const maxEdge = Number(request.maxEdge) || 1500;
      const maxPixels = Number(request.maxPixels) || 1_650_000;
  ```
  L320、L569-570；对照 config.js:60-73 的 `renderTimeoutMs/maxEdge/maxPixels/jpegQuality` 与 lit-page-image.js:92 的 `|| 8000`。
- **影响**：现在不改也能跑（默认关）；但它把"浏览器资源管理"和"静态资源白名单 HTTP 语义"耦在一个函数里，任何一侧的 bug 都只能整体调试（无测试、要真 Chromium）。三层默认值意味着"改 config 里的 maxEdge 却没传参"时会静默回落到代码里的 1500，排查成本高。
- **建议**：拆 3 个文件——`render/browser-pool.js`（ensure/dispose/touchIdle/serialize）、`render/vendor-gate.js`（handleRoute 纯函数，入参 `(pdfjs, docs)`，**这个可以直接单测**）、保留 `page-image-source.js` 作 `render()` 编排；默认值改为必填参数（由 `lit-page-image.js` 从 config 传），删掉三处 `||`。
- **风险比**：中-高（默认关闭 ⇒ 收益有限），**建议排在最后，甚至本迭代不做**。

### F7 · 重试策略分裂在两个模块、三处硬编码，且"尝试次数"的语义与 DB 的 `attempts` 列不同
- **严重度**：low ｜ **effort**：S
- **现象**：downloader 的"每个候选源试 2 次、每次间隔 700ms"写死在 `processJob` 内层；外层另有 `config.download.maxAttempts` 与硬编码退避表 `[1000,4000,15000]`；translate 的"每个引擎试 2 次、间隔 700ms"在 `runJob` 里另写了一份完全相同的常量。DB 的 `download_jobs.attempts` 只统计"外层轮次"，一次 `processJob` 可能实际发出 2×候选数 个请求，日志里的"重试 N 次"因此偏低。
- **证据**：
  ```js
      for (let attempt = 1; attempt <= 2; attempt += 1) {
  ...
          await sleep(700);
  ```
  downloader.js:225 / 271；同值常量另见 pipeline.js:217 `for (let attempt = 1; attempt <= 2; attempt += 1) {` 与 :242。
- **影响**：调参必须改代码；两个模块的重试语义（谁退避、退避多久、是否换源）不一致却没有文档；`attempts` 列与实际请求数不符会让"为什么重试这么多次"这类问题无法从 DB 回答。
- **建议**：`config.retry = { attemptsPerSource, retryDelayMs, backoffMs:[...], maxAttempts }`，两模块共用；`attempts` 列改记"实际请求数"或再加一列 `requests`。
- **风险比**：低。

### F8 · 三个引擎适配器 84% 行相同，可合并为工厂（低收益但极低风险）
- **严重度**：low ｜ **effort**：S
- **现象**：`gemini.js` 与 `claude.js` 共用 37 行（较大文件 44 行，Jaccard 0.740）；`openaiCompatible.js` vs `claude.js` 共用 66%。差异是 `name`、`desc`、`call` 里调哪个 chat 函数（以及 openaiCompatible 的 `baseUrl` 参与 `configured`）。
- **证据**：
  ```js
  export function createGeminiEngine(cfg) {
    return {
      id: cfg.id,
      name: 'Gemini',
  ```
  gemini.js:12-15；claude.js:11-14 除 `name/desc/…Chat` 外逐字相同。
- **影响**：新增一家"OpenAI 兼容"厂商（如 ollama/自建）必须复制第 4 份；改 `needsKey/supportsAuto/limits` 语义要改 3 处。
- **建议**：`createAdapterEngine(cfg, { name, desc, needsBaseUrl, call })`，三文件各留 8 行；`registry.js` 的 `getEngine` 每次重建已保证配置热生效，不受影响。
- **风险比**：极低（`tool-registry.test.js` 覆盖工具/引擎枚举）。

### F9 · 一次性产物留在了源码树：`03-code/.tmp/`（42 文件 / 5.54MB）+ 3 个孤儿预览页 + 无入口的 `make-preview.js`
- **严重度**：low ｜ **effort**：S
- **现象**：`03-code/.tmp/` 下有 38 个 `.mjs` 调试脚本（`dbg_gap`/`probe5`/`scan_en`/`reextract_all`…）、1 个 `.py`、一个 **5.49MB 的 `app.db.bak`** 和一个 0 字节 `server.log`；`web/` 下 `preview-optimized.html` / `reader-preview.html` / `reader-preview2.html` 全树 0 引用却仍被 `express.static` 提供（实测 200）；`scripts/make-preview.js`（212 非空行）没有 npm 入口，只有 3 个文件的 `scripts/` 目录里全是手工脚本。
- **证据**：`03-code` 全树内容 grep `reader-preview|preview-optimized|make-preview` → **0 命中**（除 `make-preview.js` 自身头注释）；`curl -o NUL -w "%{http_code} %{size_download}" http://127.0.0.1:7317/reader-preview2.html` → `200 13958`。
- **影响**：新读者打开 03-code 会看到 42 个不明用途脚本与一个 5.5MB 数据库副本（**含 settings 表，即 apiKey 的存储形态**，虽然只出网不出去，但"备份含密钥"是数据卫生问题）；`web/` 目录被当成"随便丢文件"的地方会让静态暴露面持续扩大。
- **建议**：删 `.tmp/`（或整体移到 `05-review/` 之外的临时区并加 `.gitignore`）；删 3 个预览页或移进 `docs/preview-snapshots/`（若想留作视觉回归基线，就接进一个脚本）；`make-preview.js` 要么进 npm scripts（`preview`），要么删。**若仓库将来进 git，先加 `.gitignore`（`data/`、`.tmp/`、`node_modules/`、`*.db.bak`）。**
- **风险比**：零（纯删除，无引用）。

### F10 · 注释/文档与代码的局部漂移 3 例（含 1 处配置项的无效兜底）
- **严重度**：low ｜ **effort**：S
- **现象**：①`buildPagesFromRaw` 的 JSDoc 声明了不存在的 `lineGapRatio`，代码实际读 `paragraphGapRatio`（文件头 L10 的"参数全部可配（… lineGapRatio 等）"同样错）；②`DEFAULT_ROLE_RULES`（buildPages.js:17-23）与 `config.extract.roleRules`（config.js:108-114）是同一组 5 个数值的两份定义，而 extractor.js:201-205 永远传 config 那份 ⇒ `DEFAULT_ROLE_RULES` 只是死兜底；③`engines/shared.js:47-53` 的 try/catch 两个分支都 `throw`，`FATAL` 集合从未生效。
- **证据**：
  ```js
   * @param {{paragraphChars?:number, roleRules?:Object, lineGapRatio?:number, columnRules?:Object}} [opts]
  ```
  buildPages.js:783；对照 L384 `const gapRatio = opts.paragraphGapRatio ?? 1.25;`。
  ```js
    try {
      raw = await call(prompt);
    } catch (e) {
      if (e && FATAL.has(e.code)) throw e;
      throw e;
    }
  ```
  shared.js:47-53。
- **影响**：调用方按 JSDoc 传参会被静默忽略（且没有任何告警）；改角色阈值时如果只改 `DEFAULT_ROLE_RULES`（看起来"就是默认值"）不会生效，反之亦然；`FATAL` 的意图（缺 key/未配置/取消不应逐段重试）在代码里读不出来——实际行为靠"异常向上抛"碰巧正确，一旦有人为了"容错"把 catch 改成 `continue`，就会把 `E_LLM_KEY_MISSING` 放大成 N 次无意义请求。
- **建议**：①JSDoc 与头注释改成 `paragraphGapRatio`；②删 `DEFAULT_ROLE_RULES` 的 export，改从 config 取，或让 config 的默认值引用它（二选一，别两份）；③`shared.js` 的 try/catch 直接删掉（等价于现在），若要保留 FATAL 语义就写成 `if (!FATAL.has(e.code)) { /* 记录，由上层决定 */ } throw e;` 并说明"暂不做局部重试"。
- **风险比**：极低。

## 七、改哪 5 处收益最大（按"可读性收益 / 风险"排序）

1. **删 `.tmp/` + 3 个孤儿预览页 + `make-preview.js` 去留决策（F9）** — 收益：源码树少 42 个文件 / 5.5MB / ~400 行无主 HTML；风险：零（0 引用，已用 curl 复核）。半天内可完成，且立刻改善"新人第一次打开 03-code"的观感。
2. **三引擎合一（F8）** — 收益：净减 ~90 行同构代码，"新增一家兼容厂商"从复制 45 行变成填 8 行；风险：极低（有 registry 重建兜底 + tool-registry 测试）。
3. **重试参数集中（F7）** — 收益：消除跨模块重复常量与 `attempts` 语义歧义，调参从改代码变成改配置；风险：低（只动常量搬运 + 一处列语义）。
4. **抽 `chat/sse-turn.js` + 统一 `persistAssistant`（F2+F4 一起做）** — 收益：消除 F2 的真 bug 隐患，`config.chat.engine` 两条路从此不会各自漂移；净减 ~120 行；风险：中（两个入口 + 前端 4 类事件契约），建议分两步：先 `persistAssistant`（1 小时、可回归），再抽 SSE 头。
5. **拆 `runJob`（F1）** — 收益：单点可读性提升最大（220 行 → 3 个 ~60 行函数 + 1 个纯函数 `planBatches`），并为 F5 的 mock 引擎测试铺路；风险：中（触及 DB 同事务与 SSE 帧顺序两处不变量），必须在 `AGENTLIT_MOCK_ENGINE=1` 下用现有测试 + 一条新增"全命中缓存"用例验证。

**明确不推荐现在动**：`buildPages.js`（纯函数 + 已测 + 长函数是算法密度使然）、`page-image-source.js` 拆分（F6，默认关闭、收益有限，且真渲染器无法在 CI 里验证）。**这两处的"大"不是缺陷**，如果评审结论被压缩成"把大文件拆小"，方向就错了。

## 八、覆盖与盲区

**已覆盖**：5 个热点大文件的结构度量（跨度/非空行/缩进/状态变量/最长函数）；`segment.js` vs `spaceFix.js`、`agent.js` vs `pipeline.js`、三引擎重复度；config 与硬编码的逐项对照（30+ 项）；`§` 注释与设计文档的交叉核验（153 处 / 49 章节 / 0 悬空）；`page-image-source` 调用链、`routes/layout.js` 与 `services/layout/*` 的前端使用、3 个预览页与 `make-preview.js` 的存活状态；测试覆盖矩阵（11 个热点模块 × 有无 import）。

**盲区（未验证，请勿当作结论）**：
1. **web/ 前端 4 个大文件（chat.js 650 / reader.js 526 / list.js 518 / work.js 312 非空行）未做结构诊断**——本轮配额给了服务端；`web/assets/*.js` 是零构建原生 JS，很可能有全局状态与事件绑定的重复，需单独一轮。
2. **`services/layout/refine.js`（358 非空行）未细读**：只确认了它被 `routes/layout.js` 与 `reader.js` 使用、prompt 以英文长字符串内嵌在 L43 附近。它是否也存在"prompt 与代码耦合"和长函数问题，未核。
3. **`extractor.js`(391) / `artworks.js`(418) / `storage.js`(417) / `fts.js`(423)** 只在调用链层面扫过，未做逐函数诊断。
4. **F5 的"零测试"判断基于 `import` 语句匹配**，不排除有测试通过间接方式（HTTP 层 e2e）触达这些模块；04-test 下 7 个 e2e 脚本未执行（它们不在 `npm test` glob 内，且可能依赖真实数据）。
5. **`runJob` 的 9 个局部变量是人工计数**（读 L252-471 时数出），未用 AST 工具核；`createPageImageRenderer` 的 10 个闭包同理。
6. **未做性能/内存方面的结论**（不在本轮问题清单内）；`jobStats`/`progress` 这类内存 Map 是否会随 job 增长泄漏，未核。

## 九、动态验证记录

> 全部命令在 `D:\A-knowledge\agent工作流优化` 下执行；脚本通过 pwsh here-string 管道给 `node`（避免写临时文件）。

**V1 — 行数口径（证明 briefing 的 752/763/611 是非空行）**
```
PS> node -e '...split(/\r?\n/) ... console.log(f + " totalLines=" + L.length)'
=== server/services/translate/pipeline.js  totalLines=812  functions=22
=== server/services/pdf/buildPages.js  totalLines=923  functions=13
=== server/services/chat/render/page-image-source.js  totalLines=676  functions=14
=== server/services/downloader.js  totalLines=661  functions=23
=== server/services/llm/client.js  totalLines=459  functions=14
```
（`measure-object -line` 口径：pipeline 763 / buildPages 752 / page-image-source 611 / downloader 601 / client 435 —— 与非空行数一致，故 briefing 行数 = 非空行。）

**V2 — 最长函数与跨度（按"下一个顶层 function 的上一行"为终点）**
```
=== server/services/translate/pipeline.js  totalLines=812  functions=22
   nonblank=208  L252-471  async function runJob(jobId, { engineIds }) {
   nonblank=89   L73-168  export function startTranslate(no, opts = {}) {
=== server/services/pdf/buildPages.js  totalLines=923  functions=13
   nonblank=142  L191-339  export function detectColumns(lines, pageWidth, opts = {})
   nonblank=127  L786-917  export function buildPagesFromRaw(rawPages, opts = {}) {
   nonblank=125  L62-190  export function groupLines(items, opts = {}) {
=== server/services/chat/render/page-image-source.js  totalLines=676  functions=14
   nonblank=307  L320-642  export function createPageImageRenderer(opts = {}) {
   nonblank=73   L197-275  function readPdfjsVersion(root) {
=== server/services/downloader.js  totalLines=661  functions=23
   nonblank=110  L186-302  async function processJob(jobId) {
   nonblank=63   L331-395  export async function fetchPdf(url, opts) {
=== server/services/llm/client.js  totalLines=459  functions=14
   nonblank=74   L331-405  export async function openaiChatStream(p) {
   nonblank=65   L232-300  export async function anthropicChat(p) {
```

**V3 — 缩进深度实测（用于结构诊断表，runJob 的 26 为续行虚高）**
```
=== server/services/translate/pipeline.js
   span=220  L252  maxNestDepth=26  async function runJob(jobId, { engineIds }) {
   span= 96  L73   maxNestDepth=16  export function startTranslate(no, opts = {}) {
=== server/services/pdf/buildPages.js
   span=149  L191  maxNestDepth=4  export function detectColumns(lines, pageWidth
=== server/services/chat/render/page-image-source.js
   span=323  L320  maxNestDepth=5  export function createPageImageRenderer(opts =
=== server/services/downloader.js
   span=117  L186  maxNestDepth=5  async function processJob(jobId) {
   span= 67   L430  maxNestDepth=6  async function drainPdf(res, ctx) {
=== server/services/llm/client.js
   span= 75   L331  maxNestDepth=4  export async function openaiChatStream(p) {
```

**V4 — 三引擎重复度（trim 后非空行多重集交集）与 `.tmp` 规模**
```
gemini.js vs claude.js: nonblank=44/43  sharedLines=37  jaccard=0.740  (84% of the larger file)
openaiCompatible.js vs claude.js: nonblank=50/43  sharedLines=33  jaccard=0.550  (66% of the larger file)
openaiCompatible.js vs mock.js: nonblank=50/75  sharedLines=15  jaccard=0.136  (20% of the larger file)
.tmp files=42  bytes=5538865  mjs=38
scripts/ files=3
web preview pages=preview-optimized.html, reader-preview.html, reader-preview2.html
```

**V5 — 孤儿文件是否仍被 HTTP 提供（只读 curl，未动服务）**
```
PS> foreach ($u in @('reader-preview2.html','preview-optimized.html','index.html')) { curl.exe -s -o NUL -w "%{http_code} %{size_download}" "http://127.0.0.1:7317/$u" }
reader-preview2.html -> 200 13958
preview-optimized.html -> 200 9844
index.html -> 200 4890
```
配合内容 grep：`03-code` 全树 `reader-preview|preview-optimized|make-preview` → `No matches found`（含 .md/.txt/.json）。

**V6 — `§` 注释与设计文档交叉核验（抓 02-design 下编号标题做集合比对，未通读大文档）**
```
docHeadingsNumbered=111  distinctSectionRefsInCode=49
danglingRefs(count)=0
--- sample resolvable:
  §16.3  <- 03-code/server/services/extractor.js:2
  §16.2  <- 03-code/server/config.js:101
  §7     <- 03-code/server/db.js:2
  §9.5   <- 03-code/server/app.js:2  03-code/server/index.js:3
  §2     <- 03-code/server/config.js:2
```
（另有 153 处 `§` 标记分文件统计：downloader.js 11 / translate/pipeline.js 8 / artworks.js 7 / importer.js 7 / storage.js 7 / config.js 5 / chat/context.js 5 / chat/prompts.js 5 / buildPages.js 5 / cacheKey.js 5 / index.js 4 / llm/client.js 4 …共 64 个文件。）

**V7 — 测试覆盖矩阵（扫 server/test/*.test.js 的 import 语句）**
```
NO-TEST  server/services/translate/pipeline.js
NO-TEST  server/services/llm/client.js
NO-TEST  server/services/downloader.js
NO-TEST  server/services/chat/agent.js
TESTED   server/services/chat/pipeline.js   <- services/chat/pipeline.js
NO-TEST  server/services/chat/render/page-image-source.js
NO-TEST  server/services/layout/refine.js
NO-TEST  server/services/extractor.js
TESTED   server/services/pdf/buildPages.js  <- services/pdf/buildPages.js
TESTED   server/services/segment.js         <- services/segment.js
TESTED   server/services/pdf/spaceFix.js    <- services/pdf/spaceFix.js
```
`server/test/` 共 18 个文件；`package.json` scripts 只有 `start / import / import:dry / test / fts:rebuild`。

**V8 — 调用链 grep（原文命令与命中）**
```
grep 'spaceFix|services/segment'  → extractor.js:18 (buildVocabulary, restoreSpacesInItems) / buildPages.js:14 (restoreSpaces) / pipeline.js:16 (buildBatches) / engines/shared.js:9 (编号协议)
grep 'page-image-source'          → tools/lit-page-image.js:20 与 tools/index.js:12 两处 import；另 2 处仅注释
grep 'layout|preview-optimized'   → app.js:22,59 挂载 routes/layout.js；web/assets/reader.js:243,256,267 三处调用
grep 'maxItems|maxChars|batchItems' → registry.js:55-56 `Number(o.maxItems || config.translate.batchItems || 6)`（默认 6，非 briefing 所述 4）
```
