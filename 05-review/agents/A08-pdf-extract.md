# A08 · PDF 抽取与版面分析（S1–S7 链路）

审阅范围：`03-code/server/services/pdf/meta.js`、`pdf/buildPages.js`、`pdf/spaceFix.js`、`services/extractor.js`、`services/layout/refine.js`、`services/layout/job.js`、`routes/layout.js`，以及 `test/pdf-verify.test.js`、`test/spaceFix.test.js`、`test/buildPages.test.js`、`03-code/STATUS.md`。
所有结论都带 `文件:行号` 与原文摘录；行号按**编辑器口径**（本仓库文件混用 `\r\n` 与单独 `\r`，`wc -l`/`Get-Content` 会比编辑器少数十至 124 行，实测行数：buildPages 922、spaceFix 417、extractor 437、meta 119、refine 396、job 156 —— 任务书给的 752/341/391/98/358/130 是 `\r` 合并后的计数）。

---

## 结论

1. 「三连校验」里的页数**不是解析**：`meta.js` 用 latin1 全文正则投票（`/Type /Page` 计数、`/Count` 取 max、`/MediaBox` 兜底），14 篇真实 PDF 里 13 篇与 pdf.js 一致，但 2.11 被书签树的 `/Count 9` 顶成 9 页（真实 8 页）；`%PDF-` + 9KB 垃圾、加密 PDF、截断到 99% 的坏文件都能通过校验。
2. S2 在真实语料上主体可用（4.4 39/42、4.6 12/14 逐页判成双栏），但它**没有离群否决**：4.4 的 p41/p42（作者简介页）被误判成 `splitX=345.3`，这两个值离中位数 46.9pt > ±23.8pt 容差，直接让**整篇 42 页**的文档级先验失效，而先验本该救的 p2/p17/p29（图页 + 两页参考文献，240+ 碎段）依旧单栏串行。
3. 三栏页会返回 `columns:2 / reason:"ok"`，阅读顺序按 y 交错成 C2→C1→C3、42 行变 42 段，且没有任何断言、日志或降级标记能发现——这是 S2 最危险的失败模式（同时也是 STATUS 缺陷④的实质）。
4. `spaceFix` 的 glue 路径在 4.4 上把 34 个 token 判成粘连，其中 **28 个本来是完整英文单词**（`independently → in depend ently`），29/42 页文本被改写；后果是库内 FTS 搜 `independently` 0 命中、搜 `in depend ently` 1 命中，译文输入被人为污染。
5. 其余问题多属「静默」类而非「崩溃」类：抽取失败会把 asset 永久钉在 `extracting`、S5.5/页眉兜底在 14 页的 4.6 上一段 header 都没判出、layout 目录零测试且取消状态被 `done` 覆盖——都不影响当前可见产物，但让质量退化无法被观测。

---

## findings

### F1（high）spaceFix 的 glue 词表把完整英文单词切碎，污染入库文本与全文检索

**现象**：`buildVocabulary` 用「一个长 token 能否被常用词切成多片」作为「它是粘连词」的证据，而常用词表是内联的 ~700 词（`spaceFix.js:20` 起的模板字符串）。任何由常用词拼得出来的正常单词都会命中；判成 glue 后 `restoreSpaces` 用宽松模式（允许一片未知）去切它。

**证据**
- 准入与切分，`03-code/server/services/pdf/spaceFix.js:311-314`：
  ```js
  if (w.length < 8 || COMMON.has(w) || base.has(w)) continue;
  const probeVoc = { freq: base, glue: new Set() };
  if (morphScore(w, probeVoc) > 0) continue; // 形如 xxx-ation / xxx-ing 的合法派生词
  if (segmentRun(w, probeVoc)) glue.add(w);
  ```
  `03-code/server/services/pdf/spaceFix.js:373-379`：
  ```js
  const gluey = isGlue(run, voc);
  const trusted = !gluey && (run.length < 5 || morphScore(run, voc) > 0);
  ...
  const pieces = segmentRun(run, voc, { requireAllKnown: !gluey });
  ```
- 用 pdf.js 读 4.4 原文 → `buildVocabulary` → `restoreSpaces`（脚本 t7.mjs），**输入是 pdf.js 给的、带空格的正确字符串，输出被改坏**：
  ```
  "models were proposed independently, with limited"      -> "models were proposed in depend ently, with limited"
  "ing greater flexibility and enhanced explainability."  -> "...enhanced explain ability."
  "which can result in inconsistencies or deviations"     -> "...in in consistencies or deviations"
  "E-mail: xu.chen@ruc.edu.cn;yankailin@ruc.edu.cn"       -> "E-mail: xu.chen@ruc.edu.cn;yankai lin@ruc.edu.cn"
  "Toolformer 2023-2"                                    -> "Tool former 2023-2"
  "MemorySandbox [37] implements long-term and"           -> "MemoryS a ndbox [37] implements long-term and"
  ```
- 4.4 的 34 个 glue token 里，`toolformer/explainability/handcrafting/inconsistencies/meaningful/memorysandbox/representative/understandable/informative/overwriting/successfully/environmental/informing/annotations/introspective/underperforms/inaccuracies/functionality/vulnerabilities/showcases/outlines/partisan/applicability/overcoming/teamwork/extendable/adaptability/remarkable/beforehand/outstanding/developmental/infrastructure/independently` 均为完整词（真粘连只有 `emotionprompt` 一类）。1.11 的 74 个 glue 里除 `forcontrollingmobilerobots` 这类真粘连外，也混入 `buildability/testability/applicability/functionality/informal/aversion/overhead/somewhat/reachable/rangefinders`。
- 库内后果（只读 API，见动态验证记录 V5）：
  ```
  q='independently'   hits=0      q='in depend ently'  hits=1
  q='explainability'  hits=0      q='explain ability'  hits=1
  q='meaningful'      hits=0      q='mean' (fuzzy) 6 条全是 "mean ingful"
  ```
  4.4 库内文本逐段扫描：`represent ative` 10 段、`in depend ently` 5、`success fully` 4、`hand crafting` 4、`Tool former` 3、`envir on mental` 3、`vulner a bilities` 2、`an notations` 2、`in trosp ective` 2、`mean ingful` 2 —— 约 37/786 段（4.7%）带坏词，`fixedItems=69`、29/42 页被改动。

**影响**：① 入库正文被改坏，阅读器里直接可见（4.4 是被反复引用的主力样张）；② FTS 索引建在坏文本上，用户搜原词永远 0 命中，M3 对话取证也走同一条检索（`routes/segments.js:85`）；③ 翻译输入被污染，模型会把 `in depend ently` 当成三个词处理；④ 修好之后必须**重抽 13 个 ready 资产**，否则坏词永久留在库里。

**建议**：glue 准入改成多条件合取：原 token 文档频次 == 1、不在 `COMMON`、`morphScore==0`、切出的**每一片**都 ≥3 字母且至少两片命中 `COMMON`；更省事的做法是只对「无空格且 `item.hasEOL === false` 且宽度与词长明显不符」的 item 启用 glue 路径，带空格的 item 一律走 `requireAllKnown` 严格模式——这一条就能保住 `independently/explainability` 这类。改完补一条回归测试：`restoreSpaces('we propose independently, with limited')` 必须零改动。

**effort**：M

---

### F2（medium）S2 把三栏页判成双栏且返回 `reason:"ok"`，阅读顺序交错、每行成段，无任何降级信号

**现象**：`detectColumns` 的「窄行」定义是「宽度 ≤ cap×页宽 **且** 中心偏离页中心 > centerTol」，三栏页的**中栏**行中心恰好≈页中心，于是整列被排除在统计之外；中栏因此成为覆盖计数直方图里最长的一段空 run，被当成栏缝。返回 `columns:2` 后，`orderLines` 把中栏每条行都判成跨栏行（它的 x 区间跨过 splitX），band 在每一行处断开。

**证据**
- `03-code/server/services/pdf/buildPages.js:326`：`return { columns: 2, splitX: (gapStartX + gapEndX) / 2, gapStartX, gapEndX, evidence };`
- `03-code/server/services/pdf/buildPages.js:345`：`const isCross = (l) => l.x1 - l.x0 > 0.7 * pageWidth || (l.x0 < col.splitX - 1 && l.x1 > col.splitX + 1);`
- 合成三栏页（三栏 x=40/232/424、栏宽 140、栏缝 40、14 行，脚本 t11.mjs），detectColumns 返回：
  ```
  {"columns":2,"splitX":302,"gapStartX":180,"gapEndX":424,
   "evidence":{"gapStartPct":29.4,"gapEndPct":69.3,"crossLines":14,"narrowLines":28,"reason":"ok","sideLineShare":0.5,"ratio":0.5}}
  ```
  段落顺序（42 行 → 42 段）：
  ```
  page1 cols=2 splitX=302 reason=ok paras=42
    [0] C2 line 0 ...  [1] C1 line 0 ...  [2] C3 line 0 ...
    [3] C2 line 1 ...  [4] C1 line 1 ...  [5] C3 line 1 ...
  ```
- 对照组（两栏 + 6/10 行横跨栏缝的图内文字）仍正确判双栏、图内文字聚成末段——说明问题只出在「第三栏恰好压住 splitX」这一几何。

**影响**：三栏/双栏+侧边注/正文旁带脚注栏的 PDF，正文顺序完全错乱：C2 与 C1、C3 逐行交错，段落合并彻底失效（每行一段），下游翻译按错误顺序重组句子。用户看到的是一篇读不通的译文，而 `evidence.reason` 写着 `ok`、`sideLineShare 0.5`，从任何摘要里都看不出这一页坏了。本库 14 篇尚无三栏样本，故定 medium，但它是**静默**失败，值得在支持三栏之前先把检测补上。

**建议**：`detectColumns` 返回前加自检——把 splitX 两侧之外的行按中心分到 L/R 后，若 L 或 R 内部仍存在一条 ≥ 20pt 的空带（直方图第二个空 run），判 `columns:3` 并降级为 `columns:1, reason:'multi-column'`；`buildPagesFromRaw` 汇总 `degraded:[{pageNo, reason}]` 写进 extract 摘要与 `/api/works/:no/segments` 顶层，让前端能提示「本页版面未识别」。测试用一个三栏 fixture + 断言 `columns === 1`。

**effort**：M

---

### F3（high）一页误判就能否决整篇的文档级 splitX 先验；4.4 因此丢掉 3 页该有的分栏

**现象**：文档级先验要求**所有**双栏页的 splitX 都落在中位数 ±4% 页宽内（`every`），否则整篇不启用。4.4 的 p41/p42 被误判成 `splitX≈345.3`（作者简介页，左侧 5pt 有照片/边注），与中位数 298.5 差 46.9pt，超过 ±23.8pt 容差 → `docSplitX = null` → p2/p17/p29 这三页判不出栏的页拿不到先验，只能按单栏输出。

**证据**
- `03-code/server/services/pdf/buildPages.js:803-807`：
  ```js
  if (twoColPages.length >= Math.max(2, Math.ceil(prelim.length * 0.4))) {
    const xs = twoColPages.map((p) => p.col.splitX).sort((a, b) => a - b);
    const median = xs[Math.floor(xs.length / 2)];
    const consistent = xs.every((x) => Math.abs(x - median) <= firstWidth * 0.04);
    if (consistent) docSplitX = median;
  ```
- `03-code/server/services/pdf/buildPages.js:817`：`if (left.length >= 3 && right.length >= 3 && share >= 0.3 && leftChars > 0 && rightChars > 0) {`
- 脚本 t14.mjs 实测（纯函数 + 真实 PDF）：
  ```
  4.4_  twoColPages=39/42  pageWidth=595.3  tol=±23.8pt
    splitX 值 = 296.52 ... 298.47(x12) ... 302.02 ... 311.93, 312.03, 345.26, 345.37
    median=298.5  span=48.85pt  outliers= 345.26, 345.37
    未判双栏页 = p2:cap 0.7：无候选栏缝 | p17:cap 0.7：跨栏行 42/63 过多 | p29:cap 0.7：跨栏行 34/60 过多
  4.6_  twoColPages=12/14  pageWidth=612.0  tol=±24.5pt
    median=300.53  span=2.60pt  outliers=(none)  → primor 生效：p5,p8 走 document-prior，14/14 双栏
  1.11  twoColPages=7/10  pageWidth=604.8  tol=±24.3pt
    median=300.72  span=24.80pt  outliers=(none)  → p7 走 document-prior；p8 无候选栏缝、p9「少数侧行占比 0.34 < 0.35」
  ```
- 离群页是谁（t15.mjs）：`OUTLIER page 41 splitX=345.26 / OUTLIER page 42 splitX=345.37`，两页都是作者简介；按这个 splitX 输出的段落已经坏了：
  ```
  page 42 splitX=345.37 paras=8
    [0] 42 Front. Comput. Sci., 2025, 0(0): 1–42
    [1] Yankai Lin received his B.E. and
    [2] Ph.D. degrees from Tsinghua University in 2014 and 2019. After that, h
    [5] ...研究兴趣... "in UniverJing ..."
  ```

**影响**：① 4.4 最差的三页（p2 整页大图、p17/p29 参考文献，STATUS 记各 120+ 段）正是先验该救的三页，因两页离群而全部放弃；② p41/p42 自身的错误 splitX 被当成成功（`reason:'ok'`），正文被切成短语（"received his B.E. and" / "Ph.D. degrees from ..." 分成两段，跨 item 空格丢成 `UniverJing`）；③ 阈值边界同样脆弱：1.11 的 p9 以 `0.34 < 0.35` 之差被判单栏。

**建议**：`consistent` 从「every」改成「多数派」：取 ±4% 内样本数最多的中位值，覆盖 ≥60% 双栏页即启用，并把离群页的 splitX 一并改写成 docSplitX（现在只对 `columns !== 2` 的页生效，离群页反而被保留）；`minSideShare` 0.35 → 0.28。同时在 extract 摘要里输出 `prior: {used, splitX, outliers:[pageNo...]}`，让「先验没生效」这件事可见。测试补一个「39 页一致 + 2 页离群」的 fixture，断言先验仍然生效。

**effort**：S

---

### F4（medium）抽取失败会把 asset 永久钉在 `extracting`：只有 `readRawPages` 在 try/catch 里

**现象**：`extractAsset` 先把状态写成 `extracting`，随后只有 `readRawPages` 被 try/catch 包住并写 `failed`；`restoreSpacesInPages`、`buildPagesFromRaw`、以及后面的整段事务（删索引、删段、逐段 INSERT、建 FTS、UPDATE ready）全部裸奔。

**证据**
- `03-code/server/services/extractor.js:183`：`run("UPDATE assets SET extract_status='extracting', extract_error=NULL, updated_at=? WHERE id=?", [Date.now(), asset.id]);`
- `03-code/server/services/extractor.js:186-195`（唯一被保护的调用）：
  ```js
  try {
    raw = await readRawPages(abs);
  } catch (e) {
    run("UPDATE assets SET extract_status='failed', extract_error=?...
  ```
- `03-code/server/services/extractor.js:197-201`（没有人接住）：
  ```js
  const spaceSink = {};
  const spaceStats = restoreSpacesInPages(raw.pages, spaceSink);
  const built = buildPagesFromRaw(raw.pages, {
  ```

**影响**：任何一步抛错（内存、畸形页、`SQLITE_BUSY`、FTS 约束、`paragraphChars` 配置缺失）→ 路由返回 500，但资产行停在 `extract_status='extracting'` 且 `extract_error` 仍为 NULL（183 行刚把它清空）。前端按钮态、`pipeline.js` 的 TRANSLATABLE 前置（要求 ready）、以及「重抽」的语义都会错乱；确定性失败时每次重试都停在同一状态，库里留下「状态是抽取中、错误是空」的自相矛盾记录。

**建议**：把 197-286 整段包进 `try/catch`，catch 里按 189-194 同样的格式写 `failed` + `extract_error`（截断 500 字），`finally` 里清空 `raw.pages` 引用；顺带把 `E_EXTRACT_BAD_STATE` 之类的中断恢复逻辑写进启动自检（启动时把残留 `extracting` 改成 `failed`，错误写「进程中断」）。

**effort**：S

---

### F5（medium）抽取在请求线程同步跑完，pdf.js 只复用模块不复用 worker

**现象**：PDF 整份读进 Uint8Array，全部页的 `textContent.items` 常驻内存，直到 `buildPagesFromRaw` 用完才可回收；`readRawPages` 的 finally 只 `doc.cleanup()` / `loadingTask.destroy()`。`loadPdfjs` 缓存的是模块，每个文档仍新建 `loadingTask`（pdf.js 会按 loadingTask 建/销毁 worker）。

**证据**
- `03-code/server/services/extractor.js:70`：`const data = new Uint8Array(fs.readFileSync(absPath));`
- `03-code/server/services/extractor.js:32`：`if (pdfjsModule) return pdfjsModule;`（模块单例）
- 实测（t13.mjs，4.4：5.5 MB / 42 页 / 6196 items / 786 段）：
  ```
  baseline rss = 61.8 MB
  readFileSync 5.5 MB in 2 ms;  rss = 72.9 MB
  readRawPages 350 ms  pages=42 items=6196  rss=114.5 MB  heapUsed=23.9 MB
  buildVocabulary 26 ms vocabSize=3250 glue=34
  restoreSpaces 16 ms pagesChanged=29
  buildPages 78 ms pages=42 paras=786
  PEAK rss = 125.4 MB
  ```
  即：单篇 +63.6 MB、~470 ms CPU（其中 pdf.js 解析 350 ms）；`restoreSpacesInPages` 还给每页生成一份 items 副本（`extractor.js:136`）。

**影响**：Node 单线程，这 ~0.5 s 内所有 HTTP 请求排队；并发 n 篇抽取 → 内存 +64n MB、阻塞串行叠加。STATUS 第四节偏离#2 已按 §9.4 接受「同步阻塞」（30 页 0.9–1.2s），所以这不是新问题，但**并发无上限**、也没有任何排队指标；一个人同时点 10 篇 force 重抽就会让服务卡 5 s 以上并吃掉 600 MB+。

**建议**：进程级抽取信号量（并发 1）+ 每次 `await` 前后让出事件循环；更彻底的做法是复用 `layout/job.js` 的 runner 模式，把抽取也做成后台 job（同一套 SSE），顺带把 F4 的失败态统一。内存上：`readRawPages` 改为逐页回调（`buildPagesFromRaw` 支持流式聚合后可把 items 按页释放）。

**effort**：M

---

### F6（medium）`meta.js` 的「页数」是正则投票，不是解析：垃圾文件/加密/截断都能通过，书签 `/Count` 会被当成页数

**现象**：`countPdfPagesFromBuffer` 不解析对象树，只在 latin1 全文里数 `/Type /Page`、取 `/Count` 的最大值、拿 `/MediaBox` 兜底，然后 `Math.max` 取大者；`assertPdfFile` 只用它做「≥1」判断。

**证据**
- `03-code/server/services/pdf/meta.js:31-45`：
  ```js
  const pageRe = /\/Type\s*\/Page(?![sA-Za-z])/g;
  const countRe = /\/Count\s+(\d+)/g;
  ...
  const pages = Math.max(pageObjs, maxCount);
  ```
- 合成样本（t1.mjs，全部 >= 8KB；输出原样）：
  ```
  magic+junk with /Type /Page    size=9031   ACCEPT pageCount=2
  magic+junk with /Count 500     size=9018   ACCEPT pageCount=500
  valid+/Encrypt                 size=9071   ACCEPT pageCount=3
  outline /Count 400 (1 page)    size=9044   ACCEPT pageCount=400
  html with %PDF- inside         size=9036   REJECT E_NOT_PDF :: 文件头不是 %PDF-（实际："<!DOC"）
  ```
- 真实 14 篇 vs pdf.js `numPages`（t2.mjs）：`mismatches = 1 / 14`，唯一不一致是 `2.11  864562  9  9  8`；定位到 `/Count 9` 来自书签树：
  ```
  /Count values= [9,8,6,2] max= 9
  Count=9 @309975 ... <</First 212 0 R/Count 9/Last 213 0 R/Type/Out...
  Count=8 @856211 ... <</Count 8/Type/Pages/Kids[151 0...
  ```
  该 PDF 本身是「线性化 + 二次增量更新」（两个 `startxref`，`Linearized @28`），`/Type /Page` 本体只有 8 个。
- 截断（t5.mjs，4.4 按比例截断）：5%/20%/50%/90% 都被拒；**99% 通过**：`ACCEPT pageCount=38`，pdf.js 随后抛 `Invalid Root reference`。

**影响**：`page_count` 直接写库并展示（`web/assets/work.js:99` 的 `${a.pageCount || '?'} 页`、上传 toast、`reader.js:119` 抽取摘要）；下载阶段判错的 9 页会在抽取时被 pdf.js 的 8 覆盖（`extractor.js:281`），所以错误值只出现在「已下载未抽取」窗口——但 UI 就在这个窗口里给用户看。垃圾/截断 PDF 能进入库占存储，加密 PDF 要到抽取阶段才报 `E_EXTRACT_FAILED`，用户看到的是「抽取失败」而不是「这份 PDF 加密了」。

**建议**：`assertPdfFile` 增加两项廉价铁证——`%%EOF` 必须在尾部 1KB 内、`/Encrypt` 存在即标 `encrypted`（给明确文案而不是失败）；页数以 pdf.js `numPages` 为唯一真值，下载阶段不写 `page_count`（UI 显示 `?`），或把 `countPdfPagesFromBuffer` 改成「`/Type /Pages` 根节点的 `/Count` 优先，且必须 ≥ `/Type /Page` 计数」，避免被书签树污染。补 `pdf-verify.test.js` 用例：书签 `/Count` 不应影响页数、99% 截断应被拒、加密 PDF 应给出专用错误码。

**effort**：S

---

### F7（medium）页眉去重与页眉兜底在真实文档上几乎不触发，删除量也没有任何回报

**现象**：S5.5 只在「≥4 页」且「同一文本在 ≥max(3, ceil(0.3×页数)) 页的页边距出现」时删；页眉兜底要求 `yTop ≥ 0.93×页高` **且** 大写占比 ≥0.8 且字母 ≥12。两条件叠加后，真实论文里 1–2 次的页眉、非全大写页眉、页脚页码都逃过。

**证据**
- `03-code/server/services/pdf/buildPages.js:696`：`if (pages.length < 4) return pages;`
- `03-code/server/services/pdf/buildPages.js:713`：`const threshold = Math.max(3, Math.ceil(pages.length * minPageRatio));`
- `03-code/server/services/pdf/buildPages.js:866`：`const atTop = raw.height > 0 && b.yTop >= raw.height * 0.93;`（868 行起是 `capsHead` 条件）
- `03-code/server/services/pdf/buildPages.js:914`：`dropRepeatedMarginalia(out);`（返回值丢弃，靠函数原地改 `page.paras`）
- 只读 API 实测 4.6（14 页、536 段）角色直方图：`body 497 / section 26 / footnote 5 / reference 3 / quote 3 / title 2` —— **header = 0**；即 14 页里一段页眉都没判出来。4.4 的输出里也仍能看到页脚混进正文：`page 42 [0] 42 Front. Comput. Sci., 2025, 0(0): 1–42`。

**影响**：页眉/页脚留在正文段里，而 `pipeline.js` 的 TRANSLATABLE 是靠 `role NOT IN ('header','footer','page-number')` 排除的——role 判不出来，这些行就会被送去翻译，每页一行噪声，译文里出现「第 3 期」「Journal of ...」之类。同时因为删除动作没有计数、没有日志（914 行只调用不接收返回），无人能知道 S5.5 到底删了几段；STATUS 缺陷①说的「4.4 仍有噪声」就是这么来的。

**建议**：加一条「单位置判定」不依赖跨页重复：`yTop ≥ 0.93×H`（或 `yBottom ≤ 0.07×H`）且字号 < 0.92×bodyFont 且长度 < 80 → `header/footer`；页码单独按 `/^\d{1,4}$/` + 页边区判 `page-number`。把 `dropRepeatedMarginalia` 改成返回 `{pages, removed}` 并把 removed 写进 extract 摘要（`/api/works/:no/segments` 顶层已有 `extractor` 字段可放）。

**effort**：S

---

### F8（low）layout job 的三处状态机漏洞：runners 只增不减、取消被 `done` 覆盖、未知 id 会凭空造 job

**现象**：`runners` 是模块级 Map，只在 `startLayout` 里 `set`，从不 `delete`；`cancelLayoutJob` 把状态改成 `canceled` 后，`runLayoutJob` 因为 `refineWork` 只是 break 出页循环并**正常返回**，走到末尾无条件把状态改回 `done` 并广播 `done`；`streamLayoutEvents` / `cancelLayoutJob` 都用 `ensureRunner`，任意 id 都能新建一个 runner。

**证据**
- `03-code/server/services/layout/job.js:100-102`：
  ```js
  runner.status = 'done';
  runner.result = out;
  emit(jobId, 'done', { jobId, ...out, at: Date.now() });
  ```
- `03-code/server/services/layout/job.js:149-154`：
  ```js
  const runner = ensureRunner(jobId);
  runner.ctl.abort();
  if (runner.status !== 'done') runner.status = 'canceled';
  return { canceled: true, jobId };
  ```
- `03-code/server/services/layout/job.js:116-118`：`const runner = ensureRunner(jobId);`（SSE 入口），未知 id 也会挂上 15s 心跳（136 行）。

**影响**：用户点「取消」后 SSE 仍收到 `done`，前端把任务显示成完成（`reader.js:256` 的 cancel 调用之后状态机被覆盖）；每次精排泄漏一个 Map 条目（长期运行的服务会缓慢增长）；任意 `/jobs/layout/999999/events` 会建出一个永远 queued 的假任务并占住一条 SSE 连接。功能可用，故 low。

**建议**：`runLayoutJob` 结束前先判 `runner.ctl.signal.aborted` → `status='canceled'` + `emit('canceled')`；完成后 `setTimeout(() => runners.delete(jobId), 10*60*1000)` 或维护最近 N 条；`getLayoutJob`/`streamLayoutEvents`/`cancelLayoutJob` 改成 `runners.get` + 404。补 `test/layout-job.test.js`（目前 `layout/` 目录零测试）。

**effort**：S

---

### F9（low）refine 用 140 字符截断的文本判角色，并把 `equation` 单向翻成 `is_math=1`（= 永久不送翻）

**现象**：`buildBlocksPayload` 把每段截到 140 字符再发给模型；`applyItems` 里只要模型说 `equation`，就把 `block.isMath = true`，不看这行有没有数学特征。`is_math=1` 在 `pipeline.js` 的 TRANSLATABLE 里是被排除的，等于把这段从翻译里删掉。

**证据**
- `03-code/server/services/layout/refine.js:85`：`text: text.length > 140 ? text.slice(0, 140) + '…' : text,`
- `03-code/server/services/layout/refine.js:221-224`：
  ```js
  if (it.role === 'equation' && !block.isMath) {
    block.isMath = true;
    changed += 1;
  }
  ```
- `03-code/server/services/layout/refine.js:371`：`const stmt = 'UPDATE segments SET role=?, tier=?, align=?, ratio=?, is_math=? WHERE id=?';`

**影响**：长正文段（>140 字符）被模型按前 140 字判类，一旦被判成 equation，这段就静默退出翻译，且没有「撤回」的入口（下次精排可以改回，但用户不知道少了哪段）；`isLabel` 有保护（200-207 不许改回 equation/caption/body），`is_math` 没有对称保护。因为真实引擎从未跑过（STATUS 缺陷⑦），这条的可观测风险目前为零，定 low。

**建议**：`equation` 翻转要求符号密度证据（复用 `classifyRole` 的 `mathNonAlnumRatio`，或要求 `ratio<1.1 && 无句末标点 && 非字母符号占比 > 0.3`）；payload 截断改 300 字 + 首尾各 100 字；补一条 applyItems 单测（模型把一段 200 字的 body 判成 equation → 应被拒）。

**effort**：S

---

## 已知 7 类缺陷的取舍（修复成本 × 用户可见影响）

| # | 缺陷 | 修复成本 | 用户可见影响（本轮实测） | 判定 |
|---|---|---|---|---|
| ⑥ | 参考文献每条引文切 1–3 段 | **M**：识别 References/参考文献 标题 + 引用块按 `[n]`/作者行起点重聚 | **最高**：4.4 p17/p29 两页各 120+ 段，占 786 段的 30%+，直接放大翻译调用量，检索全是碎片 | **下轮做** |
| ① | 页眉/脚注/资助信息残留 | **S/M**：S5.5 阈值 + 单位置页眉判定 + 删除计数回报（F7） | **高**：4.6 的 header=0、4.4 p42 页脚进正文，每页噪声都送翻译 | **下轮做** |
| ③ | 跨页段落不合并 | **S**：复用 S4.5 `joinContinuations`，按页序拼「上页未收句尾 + 下页小写开头」 | 中：每页交界 1 处，42 页 ≈ 40 处断句 | 随①同批做 |
| ④ | 三栏/侧边注/栏缝通栏图/splitX 漂移 | **L**（真支持三栏）/ **M**（只加检测与降级） | 低-中：本库 14 篇 0 篇三栏；但失败**无声**（F2/F3） | 只做 M 的防御部分；真支持不做 |
| ② | 图/表内文字切碎 | **XL**：需要图表结构理解或 OCR | 中：图内文字多是标签，正确做法是「整块标 figure-label 不送翻」而非读懂 | **永久不做**（按 ① 的 role 机制绕开） |
| ⑤ | 公式跨行被打散 | **L**：需要公式识别/LaTeX 化 | 低：4.4 仅 1 段命中 `isMath`，公式短，错译影响小 | **永久不做** |
| ⑦ | 真实引擎未验证 | **S**（要 key） | 未知：refine 全链路没跑过，F9 的风险未实测 | 下轮「验证」而非「修缺陷」 |

**下轮做 2 类**：⑥ 参考文献切碎（唯一减少段数、直接降翻译成本的修复）、① 页眉/脚注残留（S 级成本、每页可见；③ 跨页段落顺手带上）。
**写进「永久不做」2 类**：② 图表内文字、⑤ 公式跨行——两者都要 OCR/版面理解，投入远超一个翻译代理的收益，且都可以用「整块判 figure-label / equation 后不送翻」这条已有机制绕开。
**④ 三栏**：不进「永久不做」，但本轮只做「检测 + 降级 + 日志」（F2 的 M 级改动），不做三栏支持——没样本、收益不可测。

---

## 覆盖与盲区

- **已覆盖**（逐行读过 + 动态验证）：`meta.js` 全文、`buildPages.js` S1–S7 各阶段与主入口、`spaceFix.js` 词表/切分/DP 全链路、`extractor.js` 读取/事务/查询、`refine.js` 与 `job.js`、`routes/layout.js`、三份相关测试、STATUS 第三至第五节。
- **只用 grep/Select-String 未整读**：`routes/segments.js`、`web/assets/reader.js`、`web/assets/work.js`（只核实了调用点与展示文案）、`pipeline.js` 的 TRANSLATABLE 常量、`config.js` 的 extract 配置项。
- **没验证**：对象流压缩页树（`/ObjStm`）的 PDF 会不会被 `countPdfPagesFromBuffer` 判成 0 页——本库 14 篇都没有 `/ObjStm`；`/XRef` 流式交叉引用、加密但权限空、竖排/扫描件均无样本。
- **没验证**：真实 LLM 精排的效果（F9 只是代码推断，无 key、零调用）；`refineWork` 与 `buildPages` 的 role 判定冲突幅度无法量化。
- **没验证**：并发抽取的真实行为（未启服务、未压测，内存/耗时是单线程基准）。
- **没验证**：4.4/4.6/1.11 之外 11 篇的 S2 分布与 spaceFix 影响面（只跑了这 3 篇；1.11 的段数 317 与 STATUS 的 266 不一致，可能是 STATUS 口径更旧或另有配置，未深究）。

---

## 动态验证记录

> 全部在 `%TEMP%\a08` 下用 `node` 跑纯函数或只读 HTTP；未写 03-code 数据、未启停 7317 服务。行号复核用 `Select-String`/按 `/\r\n|\r|\n/` 切分的脚本（与 VS Code 一致）。

**V1 meta 三连校验合成样本**
```powershell
node t1.mjs   # 造 >=8KB 的 buf -> assertPdfFile
```
```
magic+junk with /Type /Page    size=9031      ACCEPT pageCount=2
magic+junk with /Count 500     size=9018      ACCEPT pageCount=500
valid+/Encrypt                 size=9071      ACCEPT pageCount=3
outline /Count 400 (1 page)    size=9044      ACCEPT pageCount=400
html with %PDF- inside         size=9036      REJECT E_NOT_PDF :: 文件头不是 %PDF-（实际："<!DOC"）
```

**V2 真实 14 篇页数对比（meta vs pdf.js）**
```powershell
node t2.mjs
```
```
1.19  3377044  38  38  38      2.11   864562   9   9   8   <-- MISMATCH
4.4   5788348  42  42  42      4.6    295341  14  14  14
mismatches = 1 / 14
```
2.11 根因：`/Count 9` 出现在 `<</First 212 0 R/Count 9/Last 213 0 R/Type/Out...`（书签树），页面树是 `/Count 8/Type/Pages/Kids[...]`；文件有 `Linearized @28` 与两个 `startxref`。

**V3 截断**
```powershell
node t5.mjs   # 4.4 按比例截断
```
```
5%/20%/50%/90%  ->  REJECT E_NOT_PDF      pdfjs THROW InvalidPDFException: Invalid PDF structure.
99% (5730464 B)->  ACCEPT pageCount=38    pdfjs THROW InvalidPDFException: Invalid Root reference.
```

**V4 spaceFix 切分审计（pdf.js 读真实 PDF，纯函数）**
```powershell
node t7.mjs   # buildVocabulary + restoreSpaces，打印 changed items
```
```
1.11 tokens=1634 glue=74 fixedItems=82 ; 4.4 tokens=3250 glue=34 fixedItems=69 ; 4.6 glue=11
"models were proposed independently, with limited" -> "models were proposed in depend ently, with limited"
"MemorySandbox [37] implements long-term and"      -> "MemoryS a ndbox [37] implements long-term and"
```

**V5 库内检索回归（只读 HTTP，未写库）**
```powershell
curl "http://127.0.0.1:7317/api/works/4.4/search?q=independently"
curl "http://127.0.0.1:7317/api/works/4.4/search?q=in%20depend%20ently"
```
```
q='independently'   http=200 hits=0
q='in depend ently' http=200 hits=1
q='explainability'  http=200 hits=0
q='explain ability' http=200 hits=1
q='meaningful'      http=200 hits=0
```

**V6 S2 合成版面（三栏 / 通栏图 / 标题页）**
```powershell
node t11.mjs
```
```
A threeCol detectColumns = {"columns":2,"splitX":302,...,"reason":"ok","sideLineShare":0.5}
page1 cols=2 splitX=302 reason=ok paras=42
  [0] C2 line 0 ... [1] C1 line 0 ... [2] C3 line 0 ...
B 两栏+6 行通栏图  -> cols=2 splitX=296 paras=3（正文左右分段，图内文字聚成末段）
E 4 页双栏 + 通栏标题页 -> page5 cols=1 reason="cap 0.7：窄行仅 0 行"（先验未误伤标题页）
```

**V7 S2 真实分布与文档级先验**
```powershell
node t12.mjs   # buildPagesFromRaw 全量，打印每页 evidence
```
```
4.4 pages=42 paras=786  per-page:ok x39 | 无候选栏缝 x1 | 跨栏行 42/63 过多 x1 | 跨栏行 34/60 过多 x1
   p2 / p17 / p29 -> cols=1 splitX=null
4.6 pages=14 paras=536  per-page:ok x12 | document-prior:ok(document-prior) x2   (p5,p8 splitX=300.53)
1.11 pages=10 per-page:ok x7 | document-prior x1 (p7) | 无候选栏缝 x1 (p8) | 少数侧行占比 0.34 < 0.35 x1 (p9)
```

**V8 先验被否决的根因（splitX 分布）**
```powershell
node t14.mjs ; node t15.mjs
```
```
4.4  twoColPages=39/42  pageWidth=595.3  tol=±23.8pt
  median=298.5  span=48.85pt  outliers= 345.26, 345.37
  -> consistent=false -> docSplitX=null（整篇 42 页先验失效）
OUTLIER page 41 splitX=345.26 | OUTLIER page 42 splitX=345.37
page 42 splitX=345.37 paras=8
  [0] 42 Front. Comput. Sci., 2025, 0(0): 1–42
  [1] Yankai Lin received his B.E. and
  [2] Ph.D. degrees from Tsinghua University in 2014 and 2019. ...
```

**V9 抽取开销与内存（4.4：5.5MB / 42 页 / 6196 items / 786 段）**
```powershell
node t13.mjs
```
```
baseline rss = 61.8 MB
readFileSync 5.5 MB in 2 ms;  rss = 72.9 MB
readRawPages 350 ms  pages=42 items=6196  rss=114.5 MB  heapUsed=23.9 MB
buildVocabulary 26 ms vocabSize=3250 glue=34
restoreSpaces 16 ms pagesChanged=29
buildPages 78 ms pages=42 paras=786
PEAK rss = 125.4 MB
```

**V10 只读 API 一致性（纯函数结果 vs 库内结果）**
```powershell
curl "http://127.0.0.1:7317/api/works/4.6/segments"
```
```
pageCount=14 extractVersion=4  ->  536 段（与本地 buildPagesFromRaw 完全一致）
角色直方图: body 497 / section 26 / footnote 5 / reference 3 / quote 3 / title 2  -> header 0
逐页段数: p1:23 p2:20 p3:18 p4:19 p5:24 p6:15 p7:17 p8:41 p9:17 p10:61 p11:72 p12:63 p13:63 p14:83
4.4: pages=42 segs=786 extractVersion=4；pages[0].aspect=0.7727975270479134（=1/1.294 硬编码确认）
```
