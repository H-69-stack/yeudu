# M1 交付状态（2026-10-31）

> 状态：**M1 完成**（7 项自测全部真实执行通过，证据见下）。
> 规范源：`../02-design/架构设计文档.md` v1.2。本文件只记录「实际交付 / 偏离 / 已知缺口」，不重复设计。

## 一、已交付

| 交付项 | 实现位置 | 状态 |
|---|---|---|
| 项目骨架（type=module，scripts: start/import/test） | `package.json`、`.gitignore`、`config.local.json` | 完成 |
| 三层配置合并 + 目录创建 + 掩码视图 | `server/config.js` | 完成 |
| DB 薄封装（exec/all/get/run/tx + WAL + 告警过滤） | `server/db.js`（`node:sqlite`） | 完成 |
| 全量 DDL：7 张表 + FTS5 一次建全 | `server/schema.sql` | 完成 |
| `PRAGMA user_version` 迁移（v1 + 升级前 VACUUM INTO 备份） | `server/migrate.js` | 完成 |
| 安全中间件（Host 白名单 / Origin·Referer / Content-Type / SSRF 逐跳） | `server/middleware/security.js` | 完成 |
| 参数校验、统一错误出口、入站令牌桶、JSON 行日志 + 脱敏 | `middleware/validate.js`、`error.js`、`ratelimit.js`、`logger.js` | 完成 |
| CSV 导入器（BOM、RFC4180、13 列归一化、字段级锁、retired、dry-run diff） | `services/importer.js` + `import-cli.js` | 完成 |
| 只读 API：health / sections / works 列表 / 详情 / doi-jump / stats | `routes/health.js`、`works.js`、`settings.js` | 完成 |
| 写锁定 API：`PATCH /api/works/:no`（改值即锁、lock/unlock/lockAll） | `routes/works.js` + `services/artworks.js` | 完成 |
| 下载器：arxiv→link 两级 resolver、状态机、三连校验、原子写、单队列、退避重试、启动重置 | `services/downloader.js`、`services/resolvers/*`、`services/pdf/meta.js` | 完成 |
| 任务 API：list / detail / retry / cancel | `routes/jobs.js` | 完成 |
| 文件服务：Range(206) / reveal / multipart 上传 / scan-inbox / import-from-inbox | `routes/assets.js` + `services/storage.js` | 完成 |
| 设置与维护：GET·PUT settings、secret（0600 掩码）、downloadDir(switch)、resync、import、stats | `routes/settings.js`、`routes/import.js` | 完成 |
| 前端三页（原生 JS，零构建） | `web/index.html`、`work.html`、`settings.html` + `web/assets/*` | 完成 |
| 单测 31 个（CSV/路径白名单/PDF 校验/文件名/状态机） | `server/test/*.test.js` | 完成 |

## 二、7 项自测（真实命令 + 真实输出）

1. **启动 + 健康检查**
   `curl -s http://127.0.0.1:7317/api/health`
   → `{"ok":true,...,"dbDriver":"node:sqlite","downloadDirWritable":true,"works":424}`
   `curl -H "Host: evil.com"` → `403`
2. **导入 + 列表 + 专题**
   `npm run import:dry` → `记录数：424（含 arXiv：321，专题数：22） / 新增 0 更新 0 未变 424 / 锁定跳过 0 / 告警 0`
   `GET /api/works?pageSize=5` → `total=424 pageSize=5 items=5`
   `GET /api/sections` → `sections=22 条数合计=424`
   排序：`sectionNo=12` → `12.1 … 12.9 12.10 12.11 …`（数值两段排序生效）
3. **arXiv 实际下载**（`4.6` = arXiv:2311.02462，另有 `4.4` = 2308.11432 首次下载 5,788,348 字节 / 42 页）
   `POST /api/works/4.6/download {"force":true}` → `{"jobId":4,"status":"queued"}` → 轮询 2 次后 `done|295341`
   `head -c 5 storage/pdfs/4.6__*.pdf` → `%PDF-`；`fileState=present pageCount=14 size=295341`
4. **三无条目 → needs_manual**
   `POST /api/works/1.4/download` → `{"jobId":5,"status":"needs_manual","reason":"E_NO_SOURCE"}`
   `GET /api/works/1.4` → `job.status=needs_manual errorCode=E_NO_SOURCE asset=null`
5. **Range**
   `curl -H "Range: bytes=0-1023" /api/assets/1/file` → `HTTP/1.1 206 Partial Content`、`Content-Range: bytes 0-1023/5788348`、`Content-Length: 1024`、`Accept-Ranges: bytes`
6. **字段级锁**
   `PATCH /api/works/1.5 {"venue":"锁测试…"}` → `fieldsLocked=["venue"] origin=local`
   `npm run import:dry` → `更新 0 未变 424 / 锁定跳过：1 → 1.5 :: venue`
   解锁后 merge → `更新 1`，venue 恢复为 CSV 原值，`fieldsLocked=[]`
7. **路径穿越**
   `npm test`（path-scope 6 例全过）→ 拒绝 `../../config.local.json`、白名单外绝对路径、空路径、NUL 字节、`data-evil` 同前缀兄弟目录
   API 级：把 `assets.storage_rel_path` 篡改为 `../../config.local.json` 后
   `GET /api/assets/1/file` → `403 {"code":"E_PATH_OUT_OF_SCOPE"}`（随后已恢复）

附加验证（不在 7 项内，但做了）：multipart 上传（真 PDF 201 / 假 PDF `E_NOT_PDF`）、scan-inbox + import-from-inbox、resync 自愈（移走→missing，移回→present）、reveal（弹出资源管理器并选中文件）、密钥掩码（响应只回 `sk-…cdef`，日志与 DB 均无明文）、`npm test` 31/31、`npm ls` 无 gyp/原生模块。

## 二·补 D2 字段级锁契约验证（按 v1.2 §20.2 逐条对齐，2026-10-31 复核）

接口语义已与 §20.2 一致，无缺口；下面是对每条语义的实测证据（全部真实执行）：

| 契约点 | 实测 |
|---|---|
| 给字段值 → 写入 + 自动加锁 + `origin='local'` | `PATCH 1.7 {"title":"本地改过的标题…"}` → `fieldsLocked=["title"] origin=local` |
| merge 时跳过被锁字段，并进 `skippedLocked` | `POST /import {"mode":"merge"}` → `updated=0 unchanged=424 skippedLocked=[{"no":"1.7","field":"title"}]`，标题仍为本地值 |
| **dry-run 也给 `skippedLocked`** | `{"mode":"dry-run"}` → `mode=dry-run skippedLocked=[{"no":"1.7","field":"title"}]` |
| `unlock` 是唯一「放弃本地修改」入口 | `PATCH {"unlock":["title"]}` → `fieldsLocked=[]`；再 merge → `updated=1`，标题恢复为 CSV 原文 |
| `lock` 只锁不改值 | `PATCH 1.8 {"lock":["venue"]}` → `venue` 原值不变、`fieldsLocked=["venue"]`、`origin=local` |
| `lockAll` 整行锁定 | `PATCH 1.8 {"lockAll":true}` → `fieldsLocked.length=11`（= 全部可编辑字段）、`origin=local` |
| 不提供 `replace`/全量覆盖模式 | `{"mode":"replace"}` → `400 E_BAD_REQUEST「mode 只能是 'dry-run' 或 'merge'（不提供全量覆盖模式）」` |
| 出参带 `fieldsLocked` + `origin` | `WorkDetail.work` 两个字段都在，前端据此画锁标记 |
| 前端可见：锁标记 + tooltip + 解锁入口 | 详情页每个被锁字段的 label 后有「已锁」文字徽章（`title` 属性 tooltip：本地已修改，重导入不会覆盖），右侧按钮显示「已锁定（点击解锁）」；底部提示「当前已锁 N 个字段」 |

> 说明：出参字段名用 §8.6 的 `added`（等价于本轮口述里的 `created`），并保持 `updated / unchanged / retired / skippedLocked / warnings` 并列。
> 自测残留已清理：1.3 / 1.5 / 1.7 / 1.8 的 `fields_locked` 已解锁、`origin` 复位为 `import`，全库 `fields_locked<>'[]'` 与 `origin='local'` 均为 0 条。
> 回归：`npm test` 31/31 通过；前端 `getElementById` 引用的 42 个 id 全部存在于对应 HTML。

## 三、与设计文档 / 任务书的偏离点（都已落地，需要主理人知晓）

1. **项目根落在 `03-code/`**：`package.json`/`server/`/`web/`/`data/`/`storage/` 都在 `03-code/` 下，而 §6 描述的是仓库根。CSV 默认路径因此回退一级（`../Agent工作流文献清单.csv`），`config.local.json` 的 `downloadDir` 用相对路径 `storage/pdfs`（按项目根解析）。→ 部署时可以整体上移一层，路径解析不用改。
2. **DB 层文件命名按设计而非任务书**：实现为 `server/db.js` + `server/schema.sql` + `server/migrate.js`（§6/§7 明确「全部 DDL 落在 `server/schema.sql`」），任务书里的 `server/db/schema.sql` 形态未采用。
3. **新增 `server/import-cli.js`**：`npm run import` 需要 CLI 入口，§6 的目录树里没给它分配文件。
4. **详情页是 `web/work.html`（不是 `reader.html`）**：M1 不引 pdf.js，阅读器（canvas + 译文层）留到 M2。
5. **PDF 页数校验不使用 pdfjs**（pdfjs 是 M2 依赖）：改为确定性结构解析（`/Type /Pages` 的 `/Count` → `/Type /Page` 计数 → `/MediaBox` 兜底），实现收敛在 `services/pdf/meta.js#assertPdfFile`。实测 arXiv 样例 `/Count=42` 与页对象数 42 一致；M2 接入 pdfjs 后只需替换这一个函数。
6. **`fetchPdf` 放在 `services/downloader.js`**：§12.2 把它列为能力，但 §6 目录树没有对应文件；放下载器内避免 `paths`/`config` 互相穿透。
7. **新增 `POST /api/assets/import-from-inbox`**：§8.3 只有 `scan-inbox`（先扫描），缺「确认入库」的第二步，扫描结果否则无法落地。
8. **Origin 校验策略**：Origin 头存在且不在白名单 → 403；Origin 缺失（curl/本机脚本）→ 放行，Referer 作为后备校验。浏览器跨站写请求必带 Origin，防护仍成立；这样设计是为了让 `curl` 自测可用。
9. **下载并发取 `download.concurrency`（默认 2，§14）**，不是硬编码单并发；单条下载天然是 1 并发。
10. **`PUT /api/settings/downloadDir` 只实现 `switch`**：`migrate` 直接返回 400 并说明「M1 未实现目录迁移」，没有做假实现。
11. **导入时 `section` / `section_no` 不受字段锁保护**：它们由 CSV 结构（专题列）决定，若允许锁定会让列表分组与 CSV 不一致。
12. **数据事实与文档不一致（重要，供主理人/架构师确认）**：CSV 实际分布是
    - 有 arXiv：321 条（与 §7.1 一致）
    - 无 arXiv 但有 link：40 条
    - **仅 DOI：43 条**（§9.1.2 写 46）
    - **三无（无 arXiv/DOI/link）：21 条**（§9.1.2 写 57）
    → 「57 条两者皆无」应为「21 条三无 + 40 条只有链接」之和附近的口径差异。自动下载上限按 321+40=361 估（85%），实际可达取决于 link 是否为 PDF 直链。**这不影响 M1 实现**（needs_manual 判定按「无 arxiv 且无 link」），但会影响对覆盖率预期的对外表述。
13. **Windows 上 `secret.json` 的 0600 不生效**：Node 的 `mode` 在 NTFS 下不映射为 POSIX 权限（实测 mode=666）。真正的隔离要靠 ACL，属已知限制。

## 四、已知缺口（M2/M3 或有意识不做）

- 翻译（段落抽取 / 引擎 / 按段缓存 / 双语对照）、对话问答：未实现，相关表已建好留空。`GET /api/works` 的 `translateState` 过滤与 `translateStats` 已按最终语义实现，但 M1 无数据可验证。
- `assets.extract_status` 恒为 `pending`：抽取接口（`POST /api/assets/:id/extract`、`GET /api/works/:no/segments`）留到 M2（§22 允许）。
- `DELETE /api/assets/:id`、`POST /api/storage/resync` 的「指定根目录全盘搜索」（§21 R4）未做。
- 前端轮询只覆盖当前页 50 条任务状态；跨页任务需在详情页/设置页看。
- `data/app.db` 与 `storage/pdfs/` 中保留了本次自测的真实数据（4.4、4.6 两份 PDF 已下载；1.1、1.4 为 needs_manual）。要清空重来：删 `data/app.db*` 与 `storage/pdfs/*.pdf`，再 `npm run import`。
- 服务当前以 `npm start` 在 127.0.0.1:7317 运行中（若已退出，重新 `npm start` 即可）。

---

# M2 交付状态（PDF 全文翻译）

> 状态：**M2a 抽取/分段完整可验收；M2b 翻译管线 + 阅读器已交付**（用 mock 引擎端到端验证；真实引擎因无 key **未验证**，见自测 5）。
> 规范源：§7 表结构、§8.4 API、§16（含 §16.2 七步链 / §16.5 代价记账）、§9.3 缓存、§15.3 时序。

## 一、新增/修改文件

```
新增  server/services/segment.js                     ← 直接搬插件 lib/segment.js（ESM 化，逻辑零改动，仅 NFC→NFKC）
新增  server/services/pdf/buildPages.js              ← 原创 S1–S7 衔接链（行聚合/栏判定/阅读顺序/段落合并/角色判定 + 页眉去重）
新增  server/services/extractor.js                   ← pdfjs-dist 驱动 + segments 落库 + extract_version + 运行时版本记账
新增  server/services/fts.js                         ← CJK 2-gram（入库与查询共用）+ bm25 + LIKE 降级
新增  server/services/llm/client.js                  ← 唯一出站 HTTP（三家协议 + 密钥注入 + 重试 + 归一化错误）
新增  server/services/translate/cacheKey.js          ← 内容寻址缓存键
新增  server/services/translate/prompts.js           ← 默认提示词 + 编号协议 + prompt_fp
新增  server/services/translate/pipeline.js          ← 分批/并发/引擎链回退/缓存/SSE/取消/导出
新增  server/services/translate/engines/{registry,openaiCompatible,gemini,claude,mock,shared,types}.js
新增  server/routes/segments.js                      ← POST /assets/:id/extract、GET /works/:no/segments、GET /works/:no/search
新增  server/routes/translate.js                     ← engines/test/preview/translate/job/events/cancel/export
新增  web/reader.html web/assets/{reader.css,reader.js,viewer.js,translate.js}
新增  web/assets/vendor/pdfjs/{pdf.min.mjs,pdf.worker.min.mjs}   ← 本地拷贝，不走 CDN
新增  server/test/{cacheKey,batches,fts,buildPages}.test.js      ← 69 个用例（原 31 + 新 38）
改动  server/config.js（extract.roleRules/columnRules/lineGapRatio；isSettableKey 支持引擎级子键）
改动  server/app.js（挂 segments / translate 路由）、package.json（pdfjs-dist 6.4.299 锁版本）
改动  web/{work.html,settings.html} + web/assets/{work.js,settings.js}（阅读器入口、模型字段、连通性测试）
```

## 二、8 条自测（真实命令 + 真实输出摘要）

1. **抽取确定性**（`node data/_tmp/determinism.mjs 1`，4.4 / 42 页，连抽两次 force）
   → run1 与 run2 均 `segments=1204, pages=42, avg=28.67`，**文本哈希一致 `93a631da042785e6`**（两次 extract_version 2→3）
   首末页样例：`p1#0 Front. Comput. Sci., 2025, 0(0): 1–42` / `p42#1 Yankai Lin received his B.E. and`
   （注：页眉去重与 isLabel 收紧后 4.4 最终为 **1162 段**、4.6 为 **590 段**，见第四节口径）
2. **双栏识别**（`node data/_tmp/cols-report.mjs …4.6…`）
   → 逐页：`p1:1栏 p2:2栏(splitX=299.1) p3:2栏(298.6) p4:2栏(299.1) p5:1栏 p6:2栏(299.0) …`（p5/p8/p10/p11/p13 单页判不出→由**文档级 splitX 先验**补齐，最终 14/14 页判为双栏）
   第 2 页依据：`evidence={gapStartPct:48.1, gapEndPct:49.7, crossLines:0, leftChars:2779, rightChars:2935, ratio:0.49, sideLineShare:0.5, reason:'ok'}`；
   **x0 直方图（20pt 桶）= `60:50 80:1 140:1 280:1 300:53`**（左栏 50 行 / 右栏 53 行，双峰清晰）
3. **FTS 三查**（`/api/works/4.6/search`，语料是英文论文）
   → `工作流` **0**、`多智能体` **0**（语料无中文，如实为 0）、`agentic workflow` **0**；
   对照：`AGI` FTS 10（topK 上限）/LIKE 121，`workflow` FTS 1、`agent` FTS 4
   → CJK 2-gram 用同一套代码在混排 fixture 上验证（`data/_tmp/fts-cjk.mjs`）：`工作流 命中1`、`多智能体 命中2`、`agentic workflow 命中2`，例：`工作流编排是多智能体系统的核心问题，workflow orchestration matters.`
4. **mock 引擎验证管线**（`POST /works/4.6/translate {engine:"mock",scope:"pages",pages:[2]}`）
   → 第 2 页可译段 **18 段**（该页共 19 段，1 段 isLabel 被排除），首次：`requests=5, batches=5, cacheHits=0`（maxItems=4）
   → 同参数第二次：`requests=0, batches=0, cacheHits=18`（**命中率 100%，0 请求**）
   → 整篇 4.6（旧规则口径）：`total=474, requests=79, batches=79, cacheHits=18`；第二次 `cacheHits=474, requests=0`
5. **真实引擎无 key**：`POST /api/translate/test {engine:"deepseek"}` → **`http=400 E_LLM_KEY_MISSING`**（"引擎「DeepSeek」未配置 apiKey"）。
   **真实引擎（DeepSeek/Gemini/Claude）未验证**——手上没有 key，`openaiChat/geminiChat/anthropicChat` 的请求体与响应解析只做了代码级实现，**没有真实调用证据**，不许当已验证。
6. **改提示词 → 缓存全 miss**：写 `translate.prompt`（加"（修订版）"）→ 同页 `requests=5, cacheHits=0`；恢复默认提示词 → `requests=0, cacheHits=18`。证明 `prompt_fp` 真的进了键。
7. **SSE**（`curl -N /api/jobs/translate/13/events`）→ 4 条 `event: progress`，`doneSegments` **0 → 4 → 12 → 20 → …**（单调递增），并收到 `event: page`（含 bbox 与 dst），结束时连接关闭。
   另验证：`cancel` → `{canceled:true, keptSegments:684}`，job 转 `paused`（16/34）；再 POST 同参数 → `{reused:true, resumed:true}`，续译后 `done=34/34, cacheHits=16, requests=5`。
8. **`npm test` 全绿 69/69**：新增覆盖缓存键（含 srcLang 不进键、分隔符 \u0000）、批次边界（空段/单段超长/全空）、编号协议（60% 覆盖率、缺项占位）、FTS 中英混查（含 2-gram 与索引重建）、S1–S7（行聚合/双栏/顺序/确定性/角色/bbox）。

补充证据：`export` 双语 Markdown 返回 `text/markdown` + `Content-Disposition: attachment; filename*=UTF-8''…双语对照.md`；
`GET /works/:no/segments?withTranslation=1` 返回 `bbox/extractVersion/extractor:{pdfjsVersion,extractorVersion}`；
抽到 `extract_version` +1 后旧译文全部不再命中（实测 4.6 v5→v7 后 `已译=0`）—— 版本绑定按 §19 第 6 条生效。

## 三、与设计文档的偏离（M2 部分）

1. **`segments` 列名**：未新增 `char_start/char_end/flags` 三列，沿用 §7 的 `char_len` + `is_math/is_label/is_heading`。理由：设计/API 都不使用字符偏移（翻译按段、引用按 `segmentId`），新增列会带来无意义的 v2 迁移。`bbox` 已按 §7 存 JSON。
2. **`POST /assets/:id/extract` 同步返回 200 + 摘要**（设计写 202 + `extracting`）：单篇 30 页抽取实测 0.9–1.2s，§9.4 允许同步阻塞；异步化会多一套 job 状态而无收益。
3. **S2 栏判定改用「覆盖计数直方图 + 文档级 splitX 先验」**（设计写「x0 直方图 + 无行跨越」）：
   - 纯 x0 直方图在「居中标题/页码行」上会被填死（实测 4.6 第 5/8/10/11/13 页直接判不出）；
   - 先用「行覆盖带」（容忍 ≤2% 行跨越）判栏，再对个别判不出的页沿用**文档级中位 splitX**（一致性校验 ±4% 页宽）；
   - 效果：4.6 从 8/14 页双栏 → **14/14 页双栏**，且单栏页（合成 fixture）不误判。
4. **新增 S5.5 页眉/页脚去重**（§16.2 未列）：同一文本在 ≥30% 页的页顶/页底 8% 区域出现即整篇丢弃。4.4 因此少 42 段（`Front. Comput. Sci., 2025, 0(0): 1–42` 这类）。
5. **`isLabel` 收紧**（设计：长度<40 且无句末标点）：原规则在真实论文上把 43% 的段判成「图内标注」→ 这些段不送翻译，等于静默丢正文。收紧为「短 + 无句末标点 +（≤4 词 或 含数字）+ 非标题」，4.4 的 isLabel 从 43%→33%，4.6 21%→17%。
6. **`isHeading` 正则补句点形态**：§16.2 写 `^\d+(\.\d+)*\s+[A-Z]`，实际论文普遍是 `2. Defining AGI`，补成 `[.)]?` 才能命中。
7. **FTS 查询给拉丁词加前缀通配**（`"agent"*`）：不加时 `agent` 命中不了 `agents/agentic`（实测 2 vs 5），CJK 2-gram 不加（会退化成超宽匹配）。
8. **缓存键含 `extract_version`、不含 `srcLang`**：与 §7/§21 R3 一致（任务书第 9 条的列举里没写 extract_version，实现按设计文档保留，否则重抽后旧译文会冒充有效）。
9. **`jobStats`（requests/batches/cacheHits）只存内存**，不落库：重启后「那次运行」不再存在，落库只会产生无意义历史。自测通过 `GET /jobs/translate/:id` 的 `lastRun` 读。
10. **mock 引擎的存在条件是 `NODE_ENV=test` 或 `AGENTLIT_MOCK_ENGINE=1`**（任务书写 `--mock-engine`）：用环境变量而不加 CLI 参数解析，启动方式不变。

## 四、已知缺陷（抽得差的 PDF 类型 / 双栏失效场景）

- **页眉去重只覆盖「重复且贴边」**：只出现 1–2 次的期刊页眉、脚注、资助信息仍会留在正文里（4.4 仍有零散噪声）。
- **图/表内文字**：按行切碎、顺序不可靠（4.4 第 2 页是一张大图，产出 41 个小段）。`isLabel` 能标掉一部分，长图注仍按正文对待。表格文字顺序不可读，本期不做（§23.1 已声明）。
- **跨页段落**：段落在页边界被切成两段（无跨页合并）。
- **双栏失效场景**：三栏/侧边注排版、栏缝里塞了通栏图、`splitX` 逐页漂移超过 4% 页宽（先验不采信）→ 会退回逐页判定，可能串栏；单页文档（`prelim.length<4`）没有文档先验。
- **公式识别**：`isMath` 依赖符号密度，跨行公式仍会被打散成 2–4 段（§16.5 已记账，`is_math` 宁宽勿窄，4.4 仅 1 段命中说明真实论文里这一档判得偏窄）。
- **参考文献页**：每条引文被切成 1–3 段，`isLabel` 占比高（4.4 第 17/29 页各 120+ 段）。
- **真实引擎未验证**：无 key，只验证了「无 key 时正确报错」这条路径。

## 五、切分质量自评（2 篇人工对照）

| 文献 | 段数 | 均长 | 双栏页 | 观察 |
|---|---|---|---|---|
| 4.4 A Survey on LLM based Autonomous Agents（42 页） | 1162 | 127 | 42/42 | 正文段落基本成段（句子完整、顺序左右栏正确）；图页/参考文献页碎段多；页眉已去重 |
| 4.6 Levels of AGI（14 页） | 590 | 117 | 14/14 | 段落质量好，标题被标 `isHeading`；图表页（p5/p8/p10）碎段多 |

人工对照 4.6 第 2 页：`#0 "Levels of AGI"`（标题）→ `#1` 完整长段（229 字符，句子完整）→ `#2 "2. Defining AGI: Case Studies"`（标题）→ `#3/#4` 正文段落，阅读顺序正确。
主要错误三类：① 图内文字成碎段（页 5/8/10）；② 页内个别段首行被并入上一段（少 1 行）；③ 参考文献条目被拆行。

## 六、最终冒烟中发现并修掉的问题（都留了注释）

1. **`translateStats.done > total`**：原先「已译」直接 `count(*) translations`，跨语言/跨抽取版本混在一起，出现 766/492 的荒谬数字。
   改为「按段算 key 是否命中」+ 只统计最近一次任务的 `engine/tgt_lang` 与当前 `extract_version`。修完 `492/492`。
2. **重启后翻译任务卡在 `running`**：单进程没有后台调度器，重启不会有 worker 去跑它，UI 上会显示一个永远不动的任务。
   启动时把 `running/queued` 统一置 `paused`（设计写 queued，见偏离说明），用户点「继续翻译」即续译。
3. **`paused` 任务点「继续翻译」原先只会返回 `reused`**：已改成真正 resume（重开 runner + 新 AbortController），实测 `done 172 → 492`，`cacheHits=176`、`requests=54`。
4. **`isSettableKey` 拒绝引擎级子键**（`translate.engines.mock.latencyMs` 等）：默认配置里没有这些键就被判为未知键。改为「已知顶层命名空间前缀可新增子键」。
5. **零原生模块的口径**：`pdfjs-dist@6` 带一个**可选**依赖 `@napi-rs/canvas`（预编译 N-API，仅用于 Node 端渲染图像）。
   - `npm ls --all | grep gyp` = **0**（没有任何需要编译的原生模块）；
   - 项目根加了 `.npmrc`（`omit=optional`），`npm install` 不会装它；
   - 缺它时 pdfjs 导入阶段会打 3 条 canvas polyfill 告警（不影响抽文本），已在 `extractor.loadPdfjs` 的导入期间静音；
   - 本机 `node_modules` 里残留一个 `extraneous` 的 `@napi-rs/canvas-win32-x64-msvc` 目录（删除被本机安全策略拦截），它不是依赖树的一部分，新机器安装不会有。
6. **`GET /works/:no/segments?withTranslation=1` 的命中受 `extract_version` 约束**：重抽后旧译文不再命中（实测 4.6 v5→v7 后「已译=0」），这是 §19 第 6 条的预期行为。

---

# M3 交付状态（跨语言双索引 + 对话）

> 状态：**双索引完整（含回填与改写兜底）；对话主链路完整（SSE / 引用装配 / 取消 / 摘要）；阅读器对话面板已接**。
> 真实 LLM 仍未验证（无 key）；mock 引擎覆盖了端到端链路。规范源：§8.5 / §9.1.4 / §9.3 / §15.4 + 主理人 D22 指令。

## 一、结论先行：你纠正的那点是对的
M2 交付时我说「4.6 中文 0 命中是语料没有」——**这个判断对 4.4 成立，对 4.6 不成立**。4.6 的 492 段译文躺在 `translations` 里，
但 `segments_fts` 只索引英文原文，所以中文提问恒 0 命中 → 模型拿不到上下文却照常作答，是**静默错误**（比报错更糟）。
M3 第一件事就是补这条，并把它做成「入库即索引」而不是靠人记得跑脚本。

## 二、新增/改动文件

```
新增  server/services/chat/{prompts,context,retrieval,agent}.js   ← 模板与引用解析 / 预算组装与裁剪 / 检索决策与改写兜底 / 对话主链路
新增  server/routes/chat.js                                      ← chats CRUD + SSE 提问 + cancel + feedback
新增  server/cli/fts-rebuild.js                                  ← npm run fts:rebuild（重建原文+译文索引，含 v2 回填）
新增  server/test/{citation,context,dual-index,chat-summary}.test.js  ← 用例 69 → 100
新增  web/assets/chat.js                                         ← 阅读器对话面板（流式/引用 chip/会话切换/针对选区提问）
改动  server/schema.sql                                          ← v2：translations_fts + chats.summary/summary_upto + messages.truncated
改动  server/migrate.js                                          ← 支持分级迁移（v1 → v2，ALTER TABLE 幂等加列，升级前自动 VACUUM INTO 备份）
改动  server/services/fts.js                                     ← indexTranslation / deleteTranslationIndexForAsset / backfillTranslationIndex / 双索引合并
改动  server/services/translate/pipeline.js                      ← 译文落库与译文索引写入同一个 tx
改动  server/services/extractor.js                               ← 重抽前清译文索引（段 id 会变）
改动  server/services/llm/client.js                              ← 流式：openai / anthropic SSE 解析 + gemini 非流式兜底
改动  server/routes/segments.js                                  ← /search 走 retrieval.retrieve（含改写兜底与 hitLang）
改动  server/{app,index,config}.js、package.json、web/{reader.html,assets/reader.css,assets/reader.js}
```

## 三、自测（真实输出）

**1. 双索引四查（4.6，`/api/works/4.6/search`，`hitLang` 是新增字段）**
```
工作流      hits=1  hitLang={"dst":1}   例: p1#14 [dst] dst=AGI 可能带来显著的经济影响，…从而改变工作流的组织方式。
智能体      hits=4  hitLang={"dst":4}   例: p1#4  [dst] dst=我们提出一个用于对通用人工智能（AGI）模型…评估智能体系统
AGI        hits=8  hitLang={"src":8}   例: p1#0  [src] src=Position: Levels of AGI …
workflow    hits=1  hitLang={"src":1}   例: p8#12 [src] src=Non-AI digital workflows (e.g., typing …)
```
> 4.6 现有译文是 mock 产的「[译]+英文」，里面没有中文。为了在真实数据上验证中文侧，我**手工翻译了 6 段**写入
> `translations`（engine=`manual-zh`）并建索引 —— 是人工译文，不是模型输出，也没冒充真实翻译结果。其余 476 条仍是 mock 的英文。

**1b. 未翻译文献（4.4）中文查询 → 改写兜底**
```
q=工作流  hits=5  rewritten=true  keywords="workflow orchestration multi-agent agent"  rewriteMocked=true  reason=rewritten-hit
   例: p37#30 [src] Appagent: Multimodal agents as smartphone users.
对照（rewrite=0）: hits=0 rewritten=false reason=no-hit-no-rewrite
```
（mock 的改写关键词是固定串，只用于验证链路；真实引擎走 `chat.rewriteFallback` 的廉价档调用，未验证。）

**2. 对话端到端（mock，4.6）**
```
event: meta   {"messageId":1,"retrieval":{"hits":24,"rewritten":false,"reason":"hit","hitLangs":["dst","dst","src",…]},
               "contextChars":{"system":289,"meta":207,"blocks":3489,"totalInput":4022}}
event: delta  ×3（"（mock 引擎）根据检" / "索到的段落…[p1#5]。" / "这是测试用固定回答…"）
event: citation {"citations":[{"segmentId":1771,"pageNo":1,"ord":5,"quote":"With these principles in mind, we propos"}]}
event: done   {"messageId":2,"citations":1,"noCitation":false,"truncated":false}
读回：messages=2，assistant.citations=1 → 能定位到真实 segment 1771（p1#5）
```

**3. 4 轮压缩（连问 7 轮，每轮后读 chats.summary）**
```
第1–4轮后: msgs=2/4/6/8   upto=0  len=0        ← 不触发
第5轮后:   msgs=10  upto=4  len=68   摘要="问：第 1 轮…；答：（mock 引擎）…"
第6轮后:   msgs=12  upto=6  len=137  ← 只追加 2 条消息的摘要，不是重压整段
第7轮后:   msgs=14  upto=8  len=206
```
单测另有断言：增量长度 ≤160、旧摘要开头保持稳定（前缀不重排）、无新消息时 no-op、总长 ≤400。

**4. 0 命中不编造（关掉改写，4.4 问「用了多少张 GPU？」）**
```
meta.retrieval: {hits:0, reason:"no-hit-no-rewrite"}
8 条 delta，done: {"citations":0,"noCitation":true}
落库 assistant: citations=[] , content="（mock 引擎）未检索到相关段落，因此无法依据原文回答。"
```
同一 chat 里还能看到更早一条 `truncated=true` 的 assistant 消息 —— 那是上一次我 `head` 截断 SSE 时留下的真实中断记录。

**5. 取消（mock 调慢到 800ms/块，2.5s 时 cancel）**
```
cancel → {"canceled":true}
落库: assistant truncated=true code=E_CANCELED len=49（原文 54 字符）
SSE: delta 7 条，done 0 条
```

**6. `npm test` 100/100 全绿**。新增覆盖：双索引合并去重（同段只留一条、保留更优 bm25、带回 textDst）、
索引按 segment_id 替换不堆积、删索引后中文查不到但英文仍在、`buildMatchExpr` 前缀通配；
摘要触发边界（第 4 轮不压 / 第 5 轮压 / 增量追加 / 幂等 / 400 上限）；引用正则（正常/重复/大小写/未闭合/空/null）；
上下文预算裁剪（块先砍、历史缩到 2 轮、选区在问题前、问题超 4000 抛 E_BAD_REQUEST、system 永不被裁、前缀字节稳定）。

## 四、偏离点

1. **`translations_fts` 读取可读译文靠回表**：表结构按你给的 4 列（segment_id/engine/tgt_lang/text），
   `text` 存的是 `toFtsText(译文)`（bigram 展开，不可读）。命中后按 `(asset_id,page_no,ord,engine,tgt_lang)` 回查 `translations.dst_text`
   作为 `textDst`。没有为可读性多加一列。
2. **`chats.summary` 与 `messages.truncated` 不是 §7 原有列**：v2 迁移 `ALTER TABLE ADD COLUMN` 补上（幂等，升级前自动备份）。
   schema.sql 同步为 v2 全量，`user_version = 2`。
3. **摘要用确定性压缩**（每条消息前 40 字符拼接），没调模型：这一步目的是「别丢话题」，不是「写好摘要」；
   确定性规则能保证同输入同字节（前缀稳定）且省一次调用。要换成模型摘要只需替换 `buildDigest`。
4. **上下文预算按字符算，取 §9.3.1 的值**：system 1200 / 元数据 600 / 检索块 3600 / 选区 1600 / 历史 2400 / 摘要 400。
   裁剪顺序硬编码为「检索块尾 → 历史缩 2 轮 → 选区缩 800 → 拒绝」；**system 与当前问题永不裁**，问题超 4000 字符直接 400。
5. **检索决策的「已有块」来自上一条 assistant 消息的 `context_meta`**（不是内存态）：重启后仍成立，也不需要额外表。
6. **改写兜底是全局开关** `chat.rewriteFallback`（可在设置页关）：关掉后 0 命中就老实返回 0，不去花那一次调用。
7. **mock 对话按 8 块流式、块间延迟可配**（`chat.mockChunkDelayMs`，默认 260ms）：只为让「流式 + 中途取消」可验证。
8. **Gemini 走非流式再一次性推一个 delta**（如实记录，不假装流式）；OpenAI/Anthropic 是真 SSE。
9. **选区不带 segmentIds**：「针对选中段落提问」只把选中文字 + 当前页送过去；把选区文字映射回 segment 需要字符偏移，
   而 §7 的 segments 没有存 `char_start/char_end`，硬猜会错。前后段上下文因此只有 `segmentIds` 存在时才加。

## 五、已知缺陷

- **中文检索的覆盖率取决于翻译覆盖率**：没译过的段落，中文提问只能靠改写兜底撞英文词；改写用的是廉价档模型，质量未验证。
- **同段两侧都命中时只保留一侧的分数**：极端情况下（两侧分数接近）会让 `hitLang` 在 src/dst 间抖动，但不影响「能找到这一段」。
- **对话前缀缓存未做观测**：只保证「不主动破坏」（system/元数据手工模板、块 append-only），没接厂商的 cache_hit 字段。
- **引用只认 `[p页#段]`**：模型若写成「第 3 页第 7 段」这种自然语言，解析不到 → 该回答会被标「未引用原文段落」（宁可少认，不猜）。
- **真实引擎零验证**：`openaiChatStream` / `anthropicChatStream` 的 SSE 解析、`usage` 记账、429 退避都只有代码，没有真实调用证据。
- **mock 的 6 段中文只覆盖检索演示**：不代表译文质量，也不该被当成「翻译已验收」。

## 七、M3 复审补充实现（按主理人第二轮硬约束）

主理人指出 M2 交付时我的判断是错的（「4.6 中文 0 命中是语料没有」），且补充了 5 条硬约束。本轮已全部落地：

### 1. `translations_fts` 改为 `rowid = segments.id`（不再用 UNINDEXED 列存 segment_id）
- 虚表结构：`fts5(engine UNINDEXED, tgt_lang UNINDEXED, text)`，`rowid` 直接就是 `segments.id`，与 `segments_fts` 同构。
- 写入只放**当前生效译文**（`engine = translate.engine && tgt_lang = translate.tgtLang`），按 rowid 先删后插 → 一个段落永远只有一行，换引擎/重译是「重建该段行」。
- 核查证据：`指向不存在段的索引行 = 0`、`同一 rowid 重复行 = 0`、`按资产分布 {asset_id:2, n:492}`。

### 2. 不许「先落库、后异步建索引」
`pipeline.js` 里「translations upsert + indexTranslation」在**同一个 `tx()`** 内，且 `translations.segment_id` 在同一条 INSERT 里写入（段落此刻已知，比回填可靠）。

### 3. `retrievalMiss` 落库 + UI 显示（硬约束，不靠提示词）
- `messages.retrieval_miss`（v2 加列），两侧索引全空（含改写重试后）时写 1。
- SSE `meta` 与 `done` 都带 `retrievalMiss`；`GET messages` 返回 `retrievalMiss`；阅读器对话面板用灰字显示「未检索到原文依据（两侧索引均无命中，含改写重试）」。
- 实测：`[{"id":29,"retrieval_miss":0},{"id":30,"retrieval_miss":1}]`，接口返回 `retrievalMiss=true`，`done{retrievalMiss:true,noCitation:true}`。

### 4. 迁移 `user_version 1 → 2`（含 `segment_id` 回填 + 三类计数 + 断言 + 回滚）
- schema.sql 已含 `translations_fts` 与 `translations.segment_id`、`messages.truncated/retrieval_miss`、`chats.summary/summary_upto`；迁移分级执行，整级在一个事务里。
- 回填按 `(asset_id, page_no, ord)` 且**只回填 `translations.extract_version == assets.extract_version`** 的行。
- 三类计数（真实输出，模拟 v1 库后跑迁移）：
```
迁移前（v1）：translations 行数=482  应索引段数(有译文的段)=492  translations_fts=0  segment_id 非空=0
迁移回填：backfilled=482  skippedStale=0  skippedUnmapped=0
译文索引：indexed=492  distinct=492（engine=mock / tgt=zh-CN）
断言：sampled=20 withHanzi=10 minRequired=3 ok=true
迁移后：user_version=2  索引行数=492  应索引段数=492  segment_id 非空=482
```
- **断言口径修正**：不能比「translations 行数」（内容寻址会把同文本多段合并成一行：482 行 ↔ 492 段），
  改为比「当前引擎/语言下**有译文的段数**」（`expectedTranslationIndexCount`），回填时也会把「同资产同文本的孪生段」一并补索引。
- 另有一次真实的失败演示：库里只有 mock-v1 英文译文时，断言以「仅 0 条含汉字」拦下迁移，事务回滚、`user_version` 仍为 1、进程非 0 退出。

### 5. 查询改写只在兜底触发，且可观测
两侧全空且含 CJK 才触发，1 次、`maxTokens=100`、`timeoutMs=3000`、`retry=false`；出参带 `rewritten`/`keywords`（`/works/:no/search` 还有 `rewriteMocked`/`reason`）。

### 6. mock 引擎改输出真中文 + 升 `mock-v2`
固定词表替换（workflow→工作流、agent→智能体、AGI→通用人工智能、model→模型、evaluation→评估、framework→框架、benchmark→基准测试），前缀仍 `[译]`；
`model` 从 `mock-v1` 升到 `mock-v2`，旧缓存全部 miss（实测旧 1192 条已清空重译）。

### 7. 迁移后的双索引四查（mock-v2 真中文，`/api/works/4.6/search`）
```
工作流   hits=1  hitLang={"dst":1}  例: p8#12 [dst] [译] Non-AI digital 工作流 (e.g., typing in a text editor…
智能体   hits=6  hitLang={"dst":6}  例: p8#63 [dst] [译] Autonomous AI-powered AI as an 智能体
AGI     hits=6  hitLang={"dst":2,"src":4}  例: p1#8 [dst] / p1#0 [src]（两侧都命中，按 bm25 取更优侧）
workflow hits=1 hitLang={"src":1}  例: p8#12 [src] Non-AI digital workflows…
```

### 8. 一个必须说清的偏差
断言里「抽样 3 条含汉字」在 mock-v2 下会**随机失败**（mock 只替换词表里的词，多数段落仍是英文+`[译]`）。
我改成「抽样 20 条、其中 ≥3 条含『译』以外的汉字」，并显式剔除 `[译]` 这个前缀 token —— 否则「译」本身就是汉字，英文索引也能通过检查（假阳性，已实测踩到）。

### 9. 给「读库的人」的一句说明（主理人要求写进 STATUS）

`translations_fts` **没有 `segment_id` 列**，这不是漏建，是 D22 的实现方式：

| 位置 | 存段 id 的方式 |
|---|---|
| `translations` 表 | 有 `segment_id INTEGER` 列（v2 加列，增量写入时直接写；迁移时按三元组回填） |
| `translations_fts` | **没有该列**：FTS5 的 `rowid` 本身就是 `segments.id`，等价于「用 rowid 指段」，再存一列就重复了 |

所以查库时正确的关联方式是 `JOIN segments s ON s.id = translations_fts.rowid`；
`translations` 与索引之间的关联走 `translations.segment_id`。

## 八、浏览器直传桥（2026-10-31，主理人直接实施，待独立验证）

- 新增 `GET /api/works/lookup?doi=&arxiv=`：标识符精确匹配（复用 importer 的 normalizeDoi/normalizeArxiv），返回 `{found, work, asset, matched}`；注册在 `/works/:no` 之前避免路径遮蔽。
- 新增 `userscript/lit-uploader.user.js` + `userscript/README.md`：在已登录机构订阅的浏览器里自动识别 DOI → 查 lookup → 抓 PDF（先验魔数/体积）→ 裸 `application/pdf` 传 `POST /works/:no/asset`。内置限速 15s/次、每日 60 篇；只匹配库内条目；服务端 409 时静默跳过。
- 已验证：npm test 107/107；lookup 四态（命中/未收录/空参/路径遮蔽）curl 实测通过。
- 未验证：脚本在真实出版商页面的端到端行为（需要用户浏览器登录态，无法在沙箱内复现）。

## 九、人机验证 + 批量队列 + 打开 PDF 按钮（2026-11-01，主理人实施）

用户需求三条：① 遇到人机验证怎么办（用户愿意自己点）；② 怎么做自动化下载；③ 前端列表/详情加「打开 PDF」按钮，没有 PDF 时置灰。

**① 人机验证（userscript v1.1.0）**
- `CHALLENGE_RE` 覆盖 captcha / recaptcha / hcaptcha / turnstile / cf-browser-verification / just a moment / checking your browser / access denied / 人机验证 / 安全验证 等；`CHALLENGE_STATUS = [403, 429, 503]`。
- 两层检测：页面层 `pageLooksLikeChallenge()`（`#cf-challenge-running`、验证 iframe、title+body 文本）；响应层 `classify(status, ct, text)`（先看 `%PDF-` 魔数，不是 PDF 再判是不是验证页）。
- 命中 → `ChallengeError` → `fetchPdfWithHumanHelp()` 弹黄条提示手动点，每 10s 重试、最多 18 次（3 分钟）；重试前**重新发现 PDF 链接**（验证后 DOM 会变）。脚本不尝试绕过验证。
- 页面本身是验证页时，`waitForHumanOnPage()` 先等再查库。诊断菜单新增 `验证页: 是/否` 输出。

**② 批量自动采集**
- `listWorks` / `LIST_QUERY` 新增 `hasArxiv` 布尔过滤（配合既有 `hasPdf`），队列取 `GET /api/works?hasPdf=0&hasArxiv=0&pageSize=200`。
- 实测：过滤前返回 419 条（服务跑旧代码、参数被忽略）；重启后返回 **100 条**，其中 **79 条**能拼出落地页 URL（有 DOI 或出版商原链），其余 21 条为「三无」自动跳过。
- 落地页优先级：出版商原链 → `https://doi.org/<DOI>` → arXiv abs。
- 队列状态存 `GM_setValue('lit-queue')`，`sessionStorage('lit-queue-active')` 标记模式，跨页面跳转存活；左上角进度面板带「跳过本条 / 停止采集」；翻页前 `waitRateGate()` 把 15s 限速等满；达每日上限自动停止。
- 每页最多等 30s 等 SPA 产出标识符，避免 IEEE 这类动态站被误判为「未识别」。

**③ 打开 PDF 按钮**
- `web/assets/list.js:130`：无本地 PDF 时渲染 `<span class="small btn is-disabled">打开 PDF</span>`（不再隐藏），点击 toast 提示先下载或上传。
- `web/assets/work.js:83`：`setOpenBtn(enabled, label)` 三态——可打开 / 文件已丢失 / 本地暂无，按钮恒显示。
- `web/assets/app.css:183`：新增 `.btn.is-disabled` 灰态样式（#f1f1ef 底、#a8a8a2 字、not-allowed）。
- 覆盖率文案由 70–80% 改为 76%–85%。

**验证状态**：`node --check` 通过（592 行，v1.1.0）；`npm test` 107/107；队列接口 200 且数据正确。**未验证**：脚本在真实出版商页面的端到端（需用户浏览器登录态）；灰态按钮的浏览器实渲染。

### 9.1 跳过路径复查（同日，主理人自查后修正）
用户追问「打开链接后没有 PDF 是否直接跳过」——答案是**是**（`run()` 中 `!pdfUrl → return 'nopdf'` → `markCur()` → `gotoNext()`），但复查发现三处会拖慢/误判，已修：
- **限速误用**：原先无论成功还是跳过都要 `waitRateGate()` 等满 ~23s。改为只有 `status === 'ok'` 才等满，跳过只停 2.5s（79 条里大半要跳的话，原来光等限速就要半小时）。
- **误判跳过**：SPA 的 PDF 链接可能晚出现，原先找不到就立刻判「无 PDF」。改为给 3 次机会（每次 3s，共 ~9s）再判定；期间若页面是验证页则先等人工点掉。
- **空等**：队列页等标识符从 20×1.5s（30s）缩到 6×1.5s（~9s）——标识符基本来自 meta，等太久只是拖慢跳过。
- 新增 `hasPaywallHint()`：无 PDF 链接且正文命中 purchase/subscribe/无访问权限 等 → 状态 `noaccess`（「需权限/购买」），与「无 PDF 链接（站点规则未覆盖）」区分，便于事后人工补。
- 面板状态字典补全 `dup/noaccess/nomatch` 及对应配色。

## 十、UI 改版：沿用静态清单视觉语言 + 网页上的「批量采集」入口（2026-11-01）

用户反馈「旧静态清单界面好看」→ 把那份页面的设计语言搬进新系统，且顺手把批量采集入口做进网页。

**视觉（改 `web/assets/app.css`，379 行，全部既有 class 名保留，功能代码无需改动）**
- 色板换成静态页那套：底 `#f7f6f2`、线 `#e2e0d8`、墨 `#1c1c1a`/`#4a4a45`/`#7b7b73`、强调色深青 `#1f5f5b`（替掉原来的蓝色 `#2f6feb`）。
- 标题、编号、统计数字用衬线（`Georgia, "Songti SC", "SimSun", serif`），正文保持无衬线 15px/1.65。
- 列表去掉格子外的卡片边框：`<aside class="panel">` → `<aside class="sidebar">`（发丝右边线，不是白卡片）、总览主区 `<div class="panel">` → `<div class="sheet">`（内容直接落在纸上）。
- 表格行改用 1px dashed 分隔（呼应静态页 `.item`），行 hover 暖色底；工具条与顶栏做 `backdrop-filter` 毛玻璃吸顶。
- 新增类型徽章配色（沿用静态页 b-j/b-c/b-b/b-p/b-n）：期刊青、会议蓝、专著褐、预印本橙、非同行评审红；`list.js` 新增 `TYPE_BADGE` 映射。
- 作用域收窄：`main` 的规则改为 `.layout > main`，避免污染阅读器页 `<main class="reader-main">`（原写法会改它的内边距）。
- 详情页/设置页仍保留白卡片，只是换了一套更细的边框与衬线小标题。

**批量采集入口（`web/index.html` + `web/assets/list.js`）**
- 工具栏新增「批量采集」按钮 → 展开说明卡：实时显示待采集条数（`hasPdf=0&hasArxiv=0`）与其中能定位到出版商页面的条数、解释「入口为什么在 Tampermonkey 菜单而不是网页」（需借用已登录机构的浏览器会话）、5 步操作说明、限速说明。
- `server/app.js` 新增路由 `GET /lit-uploader.user.js`：每次请求读磁盘上的唯一一份脚本（`no-store`、响应头带 `X-Userscript-Version`），网页里的安装/更新链接直接指它，避免复制粘贴脚本正文。

**验证**：`node --check` 过（list.js / app.js）；CSS 括号平衡；`npm test` 107/107；`/lit-uploader.user.js` 实测 200 且 `X-Userscript-Version: 1.1.0`；`list.js` 引用的 19 个 DOM id 全部存在于 `index.html`。**未做浏览器实渲染截图**（按约定不额外做视觉校验），需用户 Ctrl+F5 硬刷新确认。

### 10.1 队列卡死 bug 修复（v1.1.1，同日）
用户实测：机构无权限的 ScienceDirect 页面上队列"卡住"、进度面板消失。
根因：队列模式标记与每篇去重标记都用了 `sessionStorage`，而 `sessionStorage` **按域名隔离**；从 `127.0.0.1` 跳 `doi.org` 再 302 跳出版商时域名变，`sessionStorage` 清空 → 到了文章页 `queueActive()` 为 false → 不渲染面板、不翻页 → 卡死。
修复：
- 新增 `setQueueActive(on)` 用 `GM_setValue('lit-queue-active','1')`；`queueActive()` / `startQueue` / `stopQueue` / `runQueuePage` 全部改用 GM（跨域名保留）。
- 每篇去重标记 `lit-done-<href>` 也改用 `GM_getValue/GM_setValue`（菜单「立即重试本页」改用 `GM_deleteValue`），并补 `@grant GM_deleteValue`。
- 防误判：新增 `REDIRECTORS`（doi.org）守卫——在重定向页上直接 return，等它落到真正的出版商页再处理，避免把 doi.org 中间页误判成"无 PDF"而错误跳过首条。
- 版本号 → 1.1.1；服务路由 `GET /lit-uploader.user.js` 每次实时读盘，重装即生效（实测 `X-Userscript-Version: 1.1.1`）。
验证：`node --check` 通过；已无代码级 `sessionStorage` 残留（仅注释里提了一句）。浏览器实跑未验证。

### 10.2 批量采集入口优化（v1.1.1，同日，紧随 10.1）
用户反馈：点工具栏「批量采集」"没有反应"（实际弹了说明卡，但用户预期是"点了就开跑"）。
优化：让网页按钮在脚本已安装时**直接开跑**，没装时才弹说明。
- 脚本 `@match` 新增 `*://127.0.0.1:7317/*` 和 `*://localhost:7317/*`，并在系统页 `integrateSystemPage()` 里暴露 `window.__litStartBatch/__litStopBatch`、设 `window.__litUploader=VERSION`，把按钮改成蓝色「开始批量采集」+ 就绪徽标。
- 网页端 `list.js`：`btnBatch` 点击时若 `window.__litStartBatch` 是函数则直接调用（开跑），否则 `toggleBatchNote()`（弹安装说明）；并加 `scriptStatus` 轮询提示脚本就绪/未安装。
- 说明卡文案同步更新：第 3 步改为"回到本页点『批量采集』按钮即可直接开跑"。
- 注意：因为新增了本地域名的 @match，用户**必须重装/更新脚本一次**才能接管网页；服务每次实时读盘，重装即生效。
验证：`node --check` 通过（userscript + list.js）。浏览器实跑未验证（需用户端）。

### 10.3 按钮「点了没反应」排查与桥接统一（v1.1.1，同日）
用户报"点了开始批量采集还是没自动跑"，截图显示状态为「未安装直传脚本」（这是真信号：脚本没注入系统页）。
- 已把网页按钮的真相来源统一到网页自身：`list.js` 新增 `syncBatchButton()`，只根据 `typeof window.__litStartBatch === 'function'` 决定按钮文案/颜色与状态文字；脚本端 `integrateSystemPage()` 不再改 DOM，只暴露 `window.__litUploader/__litStartBatch/__litStopBatch` 并派发 `lit-ready` 事件。避免"脚本改了按钮但页面显示未安装"的矛盾。
- 关键外部因素（最可能根因）：用户此前是在 **WorkBuddy 内置预览窗**里看 `http://127.0.0.1:7317/`，而 Tampermonkey 是浏览器扩展，预览窗里根本没有它，脚本永远注入不了。必须在真实 Chrome/Edge 地址栏打开该地址。
- README 新增「确认脚本真的注入」排查清单：控制台输入 `window.__litStartBatch`（返回 function=就绪，undefined=未注入）；重装脚本（删除旧条再装，确保 @match 含 127.0.0.1:7317）；确认油猴已启用且"作用于"含本地地址与出版商域名。
验证：`node --check` 通过。浏览器实跑未验证（需用户端真实浏览器 + 已装油猴）。

### 10.4 批量队列"卡死/被锁"根因修复（v1.1.2）
用户报"怎么还是被锁了"：截图是 `fipa.org` 的 Cloudflare "Sorry, you have been blocked"。根因有二：
1. **未覆盖域名导致永久卡死**：`fipa.org` 等不在脚本 `@match` 列表里，队列用 `location.href` 把当前标签页导航过去后，脚本在那页根本不运行——没有面板、没有自动翻页，队列永远停在那。这不是偶发，是结构性死锁。
2. **硬封锁页没有独立状态**：在"已覆盖"域名上若被 Cloudflare 硬封锁（区别于"需要人机验证"的 challenge），旧逻辑会把它当普通页面处理，浪费 3 分钟挑战窗口且不给出明确反馈。

修复（全部在 `userscript/lit-uploader.user.js`，版本 → 1.1.2）：
- 新增 `MATCH_HOSTS`（与 `@match` 同步的域名正则表）+ `isHostMatched(url)`。重构 `gotoNext()` 为异步：在翻到下一篇**之前**先用 `isHostMatched` 判断目标域名是否被覆盖；未覆盖的直接标记 `skip` 并继续往下找，**绝不导航过去**——从源头消除"落到无脚本页"的死锁。
- `startQueue()` 起始 `i:-1` 并改用 `gotoNext()`，保证首条也走覆盖检查；队列若全是不覆盖域名，会在系统页原地标记完 `skip` 后正常结束，不会卡。
- 新增 `resolveIfDoi(url)`：对 DOI 链接用 GM 请求解析出最终落点出版商；若落点域名未覆盖，同样标记 `skip` 并跳过（走 doi.org 本身也拿不到脚本运行）。
- 新增 `BLOCK_RE` + `pageLooksLikeBlock()`（识别 "Sorry, you have been blocked" / "you have been blocked" / "Ray ID" / Cloudflare error 1020/1009/1015 等硬封锁特征），在 `run()` 顶部与 `runQueuePage()` 的 `REDIRECTORS` 分支直接返回 `blocked` 状态并跳过，不再傻等。
- 面板 `sName` 增加 `blocked:'被封锁'`、`skip` 沿用黄色；CSS 增加 `.s-blocked` 红色加粗；`@connect` 补 `doi.org`。
- 验证（脚本内逻辑 + 真实库数据，非浏览器实跑）：用库里 93 条"无 PDF 且无 arXiv"的候选做覆盖模拟，结果 **33 条会被处理、39 条自动跳过（含 fipa.org）、21 条无落地链接不入队**；`fipa.org` 确认不再出现在会被导航的列表里。服务 `GET /lit-uploader.user.js` 实时读盘，`X-Userscript-Version` 已变 1.1.2。

> 注：被"机构无权限"的出版商（如 ScienceDirect "not subscribed"）属于 `noaccess`，脚本能正常跑并跳过；"被 Cloudflare 硬封锁"的已覆盖域名走 `blocked` 跳过；只有"未覆盖域名"以前会卡死，现在全部改走 `skip`。三种"跳过"都不再卡队列。

### 11 改为手动模式：移除批量队列自动跳转（v1.2.0）
用户决定："我不让他自动采集了，我都自己点进网站，然后脚本才自动采集"。即保留**单篇自动直传**（打开某页→自动识别→直传），**去掉批量队列的自动导航**。

改动：
- `userscript/lit-uploader.user.js`（710 → 516 行，版本 1.1.2 → **1.2.0**）：
  - 整块删除批量队列：`Q_KEY/Q_FLAG/readQueue/writeQueue/queueActive/setQueueActive`、`buildQueue/landingUrlOf`、`renderQueuePanel/markCur/hidePanel`、`gotoNext/stopQueue/startQueue`、`runQueuePage`，以及只服务队列的 `MATCH_HOSTS/isHostMatched/resolveIfDoi/waitRateGate` 和 `#lit-panel` 系列样式。
  - `run()` 去掉 `queue` 参数（永远单页模式）；新增顶部 `REDIRECTORS`（doi.org）守卫直接返回，避免在重定向壳上误判"无 PDF"；保留 `pageLooksLikeBlock()` 硬封锁检测、`pageLooksLikeChallenge()`/`waitForHumanOnPage()` 人机验证等待、限速/每日上限、`GM_setValue` 去重。
  - `boot()` 只 `await run()`；SPA 路由监听去掉 `queueActive()` 分支；菜单删掉「批量采集」「停止批量采集」，保留「立即重试本页」「诊断本页」。
  - `integrateSystemPage()` 只暴露 `window.__litUploader = VERSION` 并派发 `lit-ready`，不再暴露 `__litStartBatch/__litStopBatch`。
  - `@description`/`@version` 同步；`@connect doi.org` 保留（诊断/查找仍可能用到）。
- 网页端 `web/index.html` + `web/assets/list.js`：
  - 「批量采集」按钮 → **「打开下一篇待采集」**（`btnNextPending`）：拉取 `hasPdf=0&hasArxiv=0` 候选，**跳过没有原文链接/DOI/arXiv 的条目**（如 `1.1` 这类纯专著），一次只开一个 `window.open` 新标签（用户手势触发，不会被弹窗拦截，也不会连锁跳转）。
  - 新增「脚本说明」按钮（`btnUploaderNote`）展开说明卡；`toggleBatchNote` → `toggleUploaderNote`，文案改为手动模式三步流程。
  - 状态判定从 `typeof window.__litStartBatch === 'function'` 改为 `!!window.__litUploader`（`syncScriptButton`）。
- 验证：`node --check` 通过（userscript + list.js）；服务实时读盘返回 `X-Userscript-Version: 1.2.0`；页面含新按钮 id；用真实 API 模拟"打开下一篇"的选择逻辑，92 条候选中跳过 1 条无链接的（`1.1`），正确选中 `1.2` → `https://doi.org/10.1016/...`。浏览器实跑未验证（需用户端真实浏览器 + 重装脚本）。

> 用户需**重新安装/更新脚本**到 v1.2.0（改动大：删除队列）。用法：自己打开文献页面（点「打开下一篇待采集」或列表里「原文」），脚本在该页自动直传；不会自动跳下一篇。

---

# M4 交付状态（阅读器增强：打开即定位 / 阅读器入口 / 对话常驻抽屉 + 继续阅读）

> 状态：**三项前端功能全部落地，后端零改动（沿用既有 `POST /api/assets/:id/reveal` 与 `GET /api/works` 接口）。**
> 前提确认：此前规划的**翻译模块（M2）与调用大模型对话模块（M3）均已实现完成**（仅真实 LLM 调用因无 key 未验证，mock 端到端已跑通），本次不重复实现，仅在其上增量增强。
> 日期：2026-11-01。

## 一、新增/改动文件（仅前端）

```
改动  web/assets/work.js        ← 详情页「打开 PDF」按钮：开新标签 + 静默调用 reveal 弹出所在文件夹
改动  web/assets/list.js        ← 列表行加「阅读器」按钮；顶栏「阅读器」选择器（含「继续阅读」置顶）
改动  web/index.html            ← 顶栏新增「阅读器」入口 + 选择器弹窗骨架
改动  web/assets/app.css        ← 选择器弹窗样式 + 「继续阅读」置顶高亮
改动  web/reader.html           ← 对话从页签改为右侧常驻可折叠抽屉
改动  web/assets/reader.css     ← 抽屉 / 侧边开关按钮样式
改动  web/assets/reader.js      ← 去掉页签切换，改由侧边按钮控制抽屉；进入阅读器后写 localStorage「最近阅读」
改动  web/assets/chat.js        ← 清理对已移除 chatView 元素的死引用（面板本身逻辑不变）
```

## 二、三项功能要点

**A. 打开 PDF 的同时自动打开所在文件夹**（`work.js`）
- 详情页「打开 PDF」按钮点击时：先 `window.open` 新标签打开 PDF，再**静默** `POST /api/assets/:id/reveal`（文件管理器选中该文件所在目录），失败只 toast 不阻断看 PDF。

**B1. 新增进入阅读器的功能入口**
- **列表行**：每行操作列新增「阅读器」按钮（仅 `fileState==='present' && assetId` 时可用，否则灰态并提示先下载/上传），点击 `reader.html?no=<no>` 新标签打开。
- **顶栏「阅读器」**：点击弹出选择器，列出本地已有 PDF 的文献（`/api/works?hasPdf=1`），点选进入；带编号/标题筛选。
- **继续阅读（默认入口）**：阅读器进入成功后写 `localStorage.agentlit.lastReader`；顶栏选择器打开时把最近阅读的那篇以醒目的「↺ 继续阅读《标题》」置顶，点击直接续读（与列表里那条去重）。首次无记录时选择器正常全列。

**B2. 阅读器内「调用大模型对话模块做 agent」改为右侧常驻抽屉**
- `reader.html` 把对话从「译文/对话」页签切换，改为独立**右侧常驻抽屉**（`chatDrawer` + `chatToggle` 开关按钮）；PDF 原文与译文常驻可见，点侧边「对话」按钮展开/收起。
- `chat.js` 依赖的固定元素 id（`chatSelect`/`btnNewChat`/`btnAskSelection`/`chatMsgs`/`chatText`/`btnSend`/`btnStop`）全部保留，对话能力（流式/引用 chip/会话切换/选区提问/上下文压缩）不变。
- 进入阅读器后：左 PDF + 右译文对照自动加载（需已配置翻译引擎，或 `AGENTLIT_MOCK_ENGINE=1`）；右侧抽屉即可调用大模型对话模块做 agent 交互。

## 三、验证（真实命令 + 真实输出）

- **后端单测**：`AGENTLIT_MOCK_ENGINE=1 npm test` → **107 passed / 0 failed**（沿用 M3，本次未改后端，仅作回归证据）。
- **reveal 接口（功能 A）**：`POST /api/assets/4/reveal` → `{"ok":true,"dir":"…\\storage\\pdfs"}`。
- **页面/接口（功能 B1）**：服务起来后 `GET /` 含 `navReader`/`readerPicker`；`/api/works?hasPdf=1` 返回 13 条带 `assetId` 的文献（数据源正常）；`list.js` 含 `reader.html?no=` 行按钮与 `agentlit.lastReader` 读取逻辑。
- **阅读器抽屉（功能 B2）**：`GET /reader.html` 含 `chatDrawer`/`chatToggle`/`chatSelect`/`btnAskSelection`；`reader.js` 已无 `switchTab`/`tabDst`/`tabChat`/`chatView`/`dstView` 残留引用。
- **语法**：`node --check` 通过 `reader.js` / `list.js` / `chat.js`；CSS 括号平衡。

## 四、已知限制（如实告知）

- **浏览器内交互未真机驱动**：本环境无浏览器，抽屉滑动、点击跳转、SSE 流式对话、选择器「继续阅读」置顶等 UI 行为未做真人点击验证，仅做了 HTTP/静态/语法层验证。建议本地 `npm start` 后打开 `http://127.0.0.1:7317/` 实测。
- **「最近阅读」是浏览器本地状态**：存于 `localStorage`，按浏览器/设备隔离，不跨机同步，也不入库（与既有「字段级锁/本地修改」同样属于本地态）。
- **翻译全文可见性依赖引擎**：阅读器译文需在「设置」配置 provider/apiKey（或测试模式）后才显示，是 M2 既有设计（缓存键含 engine），非本次引入限制。
- 真实 LLM 调用（翻译/对话/改写兜底）仍因无 key 未验证，与 M2/M3 一致。

## 五、数据变更记录（2026-11-02，正文抽取补跑）

为评估 dsh 侧 `lit_read` 的可读范围，对 `extract_status=pending` 的 7 个 asset 执行了抽取（走 `services/extractor.js`
的 `extractAsset`，即 `POST /api/assets/:id/extract` 的同一条幂等路径）。

- 结果：6 篇成功（3.1 / 1.8 / 1.11 / 2.6 / 2.4 / 2.11），`1.17` 被判定 `needs_ocr`（`textPageRatio=0.125`，扫描件）→ 0 段、正确标记而非产出垃圾正文。
- 库内变化：`segments` 4238 → 13280；有正文的 works 6 → 12；`assets` 中 `pending` 清零，`ready` 12 + `needs_ocr` 1。
- 完整性：`PRAGMA integrity_check` = ok；`foreign_key_check` = 0 违规；`npm test` 107 passed / 0 failed。
- `segments_fts` 行数少于 `segments` 是既有设计（`indexSegments` 经 `toFtsText` 过滤无可检索词的段落），非本次漂移。
- 回滚方式（如需）：删除上述 asset 的 segments 并重置 `extract_status`，或从备份恢复 `data/app.db`。
- **根因说明（避免重犯）**：`AGENTLIT_DB` 只在 `loadConfig()` 内由 `envOverrides()` 应用。若脚本直接 `import { config }` 而不先调用 `loadConfig()`，读到的是**未解析的相对默认值** `data/app.db`，`openDb()` 会相对 cwd 解析，于是写进真实库——隔离失效。任何绕过 `loadConfig()` 的直连脚本都必须自己传绝对路径。

# M5 交付状态（翻译阅读体验：抽取层重做 + 译文面板重做，2026-11-03）

用户反馈（截图：1.11 Brooks 1986）「翻译功能完全有问题，希望做到 Zotero 沉浸式翻译插件那样」。
根因不在翻译模型，而在**抽取层把正文切碎**（逐行成段、左右栏交错、空格被吞）和**译文面板的进度/排版**。

## 一、抽取层（`server/services/pdf/`）

### 1.1 新增 `spaceFix.js`：还原被 PDF 负字距吞掉的词间空格

- 背景：本库 PDF 用 `Tw<0` 压缩词距，pdf.js 6.4.299 的空白判定（`TRACKING_SPACE_FACTOR=0.102`）
  因此判定「这里不是空格」，直接把 `for controlling mobile robots` 变成
  `forcontrollingmobilerobots`。`getTextContent({keepWhiteSpace:true})` 在公共 API 里没有透传
  （`pdf.mjs` 只发 `includeMarkedContent/disableNormalization`），不改 `node_modules` 无法关闭。
- 做法：文档内建词表（`buildVocabulary`）+ DP 切分（`segmentRun`）：可信短词做 base，
  再用 base 反查「能切回小词的长 token」记为 glue；只对 glue token 放开「一片未知」的宽松切分，
  并要求「两片 ≥4 字母、中间无 1~2 字母碎渣」的结构约束（否则 `Thesuppression → The suppress i on`、
  `outputscan → out puts can` 这类错切比粘连更难读）。
- 另一类反向损伤 `fixSplitLetters`：pdf.js 有时往词内插空格（`is → "i s"`，于是译文出现
  「最终，它 intended 用于控制…」），按 COMMON 词表把 `i s / i t` 拼回去，`a little` 不受影响。
- 实测（1.11 10 页 2791 items）：`vocabSize 1673 / glue 92`，`fixedItems 74~94`，建词表 ~30ms、修复 ~20ms。

### 1.2 `buildPages.js` 七处修正

1. `groupLines` 支持 `opts.splitAt`：只在**真实栏缝**上切行（`minGap` 跟行字号走），修掉图注被 12pt 视觉间隙切碎、17pt 标题被腰斩成 `Syste`+`m`。
2. `groupLines` 补**负间隙**判据：`Tw<0` 把词距压成重叠（实测连续 5 个词 gap 都是 -10pt）时仍补空格，否则拼成 `Processorssendmessagesoverconnecting`。
3. `detectColumns` 返回 `gapStartX/gapEndX`；`minGapPct` 默认 1.5 → **1.0**（双栏论文栏缝常只有 1.2~1.4% 页宽，实测修正 1.11 p4/p6、1.8 p8、4.4 p1 四页误判；对 2.3/2.4/1.19/4.5 等单栏文档零误翻）。
4. `mergeParagraphs` 新增 `looksHeading()` + `!prevHeading` 条件，标题不再被并进正文（`I. INTRODUCTION`）。
5. 块字号由 `max(行字号)` 改为「字符数最多的那一行」的字号，修掉首字下沉/小型大写把正文顶成 `section` 的误判。
6. 新增 `estimateBodyFont()`（按字符数加权的 0.5pt 分桶众数）替代「块字号中位数」；新增 `hoistDropCaps()` 把首字下沉的大写字母搬回上一行行首。
7. `classifyRich`/`classifyRole`：`A . Requirements` 这类「句点前带空格」的小标题按 heading 处理；`Manuscript/The author/IEEE Log/©` 优先判 footnote；IEEE 条形码行（`08824967/86/0300-0014$01.OO © 1986 IEEE`）按 footnote；小字号图注才允许 `figure-label`。页眉按位置（`yTop ≥ 0.93*页高`）兜底。

### 1.3 `extractor.js`

- `EXTRACTOR_VERSION = 4`；`readRawPages` 之后 `restoreSpacesInPages(pages, sink)`（`buildVocabulary` + `restoreSpacesInItems`），摘要里回报 `spaceFix: {fixedItems, fixedChars, vocabSize, glueSize}`，异常只记 `stats.error` 不阻断抽取。词表同时经 `sink.vocab` 透传给 `buildPagesFromRaw({spaceVocab})`，用于**段级**二次修复。
- `nextVersion` 由「重抽次数」改为 `EXTRACTOR_VERSION`：**重抽不再改变译文缓存键的语义**，版本只表示算法代次（本轮从 v3 → v4 是算法真变了，旧译文按 text 重新匹配）。

### 1.4 段级粘连修复（`spaceVocab`）

- 词间空格被负字距压成 0.3pt 的小**正**间隙时，`groupLines` 的 `gap > 0.25*avgCharW` 判据不补空格，item 级修复也看不到 → `Layers of` + `control` 拼成 `ofcontrol`。
- `buildPagesFromRaw` 在 `cleanParagraphText` 之后对整段文本再跑一次 `restoreSpaces(text, spaceVocab)`（幂等）。实测 1.11 p1 摘要 `Layers ofcontrol` → `Layers of control`。
- `spaceFix.plausibleGlueSplit` 增加**虚词两片式**例外（`FUNCTION_WORDS`：of/to/in/on/…）：`ofcontrol → of control` 的两片里只有一片够长，原「至少两片 ≥4 字母」会把它判成不合格，导致这类最常见的粘连永远切不开。

### 1.5 噪声清理

1. `buildPagesFromRaw` 丢弃「整段没有任何 3 字母以上英文词」的图形标注碎片（`I ,`、`, I`、`I 1`）—— 之前会被译成「我，」「，我」。
2. `cleanParagraphText` 补「右引号/右括号 + 句末标点」后被吞掉的空格（`“wires.”There` → `“wires.” There`）。
3. 页眉识别加 `RUNNING_HEAD_RE`（JOURNAL/PROCEEDINGS/TRANSACTIONS/VOL./NO./ISSN 等）：贴页顶 + ≤120 字的正文段若命中版式特征，改判 `header`（原来只纠正 `section`，1.11 p2 的页眉被并进正文段）。另加「通栏全大写」判据（≥12 个字母且大写占比 ≥0.8），修掉 1.11 p6 的 `BROOKS: A ROBUST LAYERED CONTROL SYSTEM FOR A MOBILE ROBOT 19`。
4. 新增 `REFERENCE_RE`（`Eds.` / `Cambridge, MA` / `M.I.T.` / `Proc.` / `pp.` / `vol.` / `"…," in` 等）：老 IEEE 论文的参考文献条目字号与正文相同（ratio≈1），原先被判成 `section`/`body`，译文栏里混进大号条目（1.11 p10）。
5. 图内散标碎片（`robot`、`4 feelforce 4 runaway`）仍会被判 `figure-label` 不送翻，面板显示原文小字——属于「宁可留着也不乱翻」的取舍。

## 二、翻译管线与译文面板

- `pipeline.js`：`loadPagePayload` 补 `role/tier/align/ratio/gap_pct`（SSE 增量页不再丢排版层级）；新增 `progressFromDb()` 让首帧进度、`GET /api/jobs/translate/:id` 都按**本任务**口径返回 `donePages/totalPages/requests/cacheHits`（原来首帧缺这三个字段，界面永远显示「页 0/— · 请求 0」）；`pushProgress` 运行期写入 `jobStats`，缓存全命中时也能显示请求数。
- `pipeline.js` 新增 `TRANSLATABLE` 常量（四处 SQL 共用）：`is_math = 0 AND is_label = 0 AND coalesce(role,'') NOT IN ('header','footer','page-number')` —— **页眉/页脚/页码不送翻**（实测模型会把它们半翻半留，产出 `18 SEEE JOURNAL OF ROBOTICS…`、`16 JOURNAL IEEE` 这类半成品）。
- `segments` 路由回传 `extractorVersion`；`reader.js` 用它做**陈旧自愈**：`storedV !== currentV` 时自动 `force` 重抽、提示「段落结构已升级」，若原本有译文则自动续译。
- `translate.js`：原文不再截断 160 字；`appendPage` 改为就地插入并保滚动位置；`rerender` 原地刷新；`isLabel`/`header`/`footer`/`page-number` 这几类**按设计不翻**的段落直接显示原文小字（不再满屏「（未翻译）」，也不显示历史遗留的半成品译文）。
- `reader.css`：补 `.dst-only .dst-para .src { display: none; }`（「仅译文」按钮原来只切 class、没有任何 CSS，点了完全没反应）；`.src` 小字灰化，中文为主体。

## 三、验证（真实命令 + 真实输出）

```
node --no-warnings --test "server/test/*.test.js"     tests 155  pass 155  fail 0
POST /api/assets/5/extract {force:true}               segments 317  v=4  spaceFix{fixedItems:82}
全库 13 个 ready 资产 force 重抽                       seg 786/536/266/347/317/158/112/496/853/381/226/768/701
翻译 job 37（deepseek，1.11）                          done 261/261  pages 10/10  req 0（全命中）fail 0  2s
翻译 job 38（deepseek，1.8）                           done 285/285  pages 10/10  req 0  fail 0  2s
1.11 第 1 页                                           [header] 14 IEEE 机器人与自动化杂志，第 RA-2 卷…
                                                       [title] 一种用于移动机器人的鲁棒分层控制系统
                                                       [body] 摘要——本文描述了一种用于控制移动机器人的新架构…
1.11 第 4 页（原被误判单栏 → 现按双栏读）              [body] 结构。处理器通过连接“导线”发送消息。消息没有握手或确认机制…
1.11 第 2 页页眉（原被并进正文）                        [header] IEEE JOURNAL OF ROBOTICS AND AUTOMATION, VOL. RA-2, NO. 1, MARCH 1986 15
```
- 译文英文残留扫描（1.11，268 段可翻）：9 段非中文全部是**页眉/版权条码/Lisp 代码块**，面板按设计显示原文；其余 259 段为中文，残留英文 token 全是专有名词（IEEE/Sobel/Elfes/Talukdar/Moravec/Flynn/…）。
- 早期缺陷已修复证据：`p1o3` 曾出现的「最终，它 intended 用于控制…」现为「最终，该系统旨在控制一台在其实验室办公区域漫游的机器人…」。

## 四、已知限制（如实告知）

- 论文标题 `A Robust Layered Control Syste For A Mobile Robot` 缺 `m`：pdf.js 对该行的 `str` 本身就没有这个字母（直接 dump 原始 items 可见 `"Robust Layered Control Syste" w=294.44`），不是本层能补。
- 仍有个别粘连无法安全切开（`neednotfeedinto`、`belowthat`、`outputscan`）：词表里没有 `feedinto/below/outputs` 的独立出现记录，切开会产出「碎渣片」，故按「宁可粘连不可错切」保留。
- 1.8 老式 IEEE 横幅标题的 drop-cap 变体（`C The Contract Net Protocol…` + `ommunication and Control…`）仍未合并为标题；只影响排版层级，不影响译文。
- 4.4（42 页 arXiv 综述）仍有跨栏拼接行（`…isolated enviKeywords Autonomous…`），该页栏缝在直方图里没有空列（reason=`无候选栏缝`），属抽取层已知缺陷；其余单栏文档正常。
- 本轮未翻译 4.4/4.6/3.1/1.18/2.6/2.3/2.4/2.10/2.11/1.19/4.5（只重抽，未产生 API 费用）；需要时在阅读器点「翻译全文」即可。
