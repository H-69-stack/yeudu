# A03 · 依赖管理 / 供应链 / 文档一致性

> 审阅人：A03-deps-docs　日期：2026-11-03　口径：`05-review/_context.md`
> 只读范围：`03-code/{server,web,userscript,scripts,package.json,.npmrc,*.md}`、`04-test`、`02-design`、`data/app.db`（readOnly）。未修改任何被审文件。
> 动态证据采集于 Node v24.19.0 / npm 11.17.0，服务为已在跑的 7317 实例（仅 curl 只读调用）。

## 结论

1. 依赖声明本身是准的：express 实装 4.22.3、pdfjs-dist 实装 6.4.299，与 `package.json` 声明和 lock 完全一致；但 `engines: node >=22.5.0` 比 pdfjs-dist 自己要求的 `>=22.13.0` 低 8 个小版本，而 `node:sqlite` 在 22.13 之前需要 `--experimental-sqlite` 才能导入——这不是"建议版本"，是启动即失败。
2. **FREEZE 清单已经不能当基线**：v5（最新、且文首声明"本节优先"）13 个文件里 4 个已漂移（config.js / app.js / reader.html / reader.css），全表 105 行里 35 行漂移，另有 217 个在冻结范围内的文件从未入清单（含 469KB 的 quickjs-eval.wasm、22KB 的 spaceFix.js）；v5 自述的验证脚本 `04-test/e2e-multimodal-upload.mjs`、`smoke-attachments-http.mjs` 已不在磁盘上，验证不可复现。
3. 供应链的真正短板不在 pdf.js（vendor 的 `pdf.min.mjs`/`pdf.worker.min.mjs` 与 `node_modules/pdfjs-dist/legacy/build/` 逐字节一致，sha256[:16] 分别为 `bccc24ea711db8e4`、`145d2dd3ab0c8615`），而在 **marked / DOMPurify / highlight.js：无版本清单、无 SRI（全站 `integrity=` 0 命中）、无 license 落盘**——5.5MB 手拷目录里的这三个文件可以被静默替换，而 DOMPurify 是对话 Markdown 渲染的 XSS 唯一屏障。
4. 文档数字全线过期：README 说 69 个用例（实测 155）、迁移到 `user_version=1`（实测 4）、标题 M2（实际 M5）、"纯 JS 无原生模块"（盘上躺着 38MB 预编译 `skia.win32-x64-msvc.node`）；STATUS 说 107/107、`user_version=2`、索引行数 492（实测 translations_fts 0 行）。
5. 缺失的文档按"接手者最缺"排序：① 部署/升级 runbook ② 数据恢复流程 ③ 故障排查手册 ④ API 参考（设计文档 §8 有契约表但记 38 条、实现 44 条，且过滤参数在实现里被静默忽略）。

## findings

### F1【high】FREEZE 冻结清单已失效，不能再当"已验证版本"基线

**现象**：`FREEZE.md` 标题仍是 `# 冻结清单（FREEZE）· v2`，但正文已叠到 v5；v5（2026-11-03）声明"本节优先、13 个文件取代旧值"。逐条手算这 13 个文件的 sha256 前 16 位与 bytes：**9 一致、4 不一致**。全表 105 个清单项：**70 一致、35 不一致、0 缺失**。同时冻结范围（`server/**`、`web/**`、`userscript/**`）实测 322 个文件，清单只覆盖 105 个 → **217 个文件从未被哈希**，其中包含未覆盖源码 14 个（`server/services/chat/render/page-image-source.js` 28KB、`server/services/pdf/spaceFix.js` 22KB、`server/routes/layout.js`、`server/services/layout/refine.js`、`server/cli/replay-chat.js` 等）和 pdf.js 数据面（cmaps/standard_fonts/wasm/iccs，含 `quickjs-eval.wasm` 469KB）。v5 第 15 行引以为证的 `04-test/e2e-multimodal-upload.mjs` 与 `04-test/smoke-attachments-http.mjs` **两个 Test-Path 均为 False**。

**证据**（原文）：
- `03-code/FREEZE.md:7`：`> **v5 变更（2026-11-03，多模态输入/输出 + persona 语气/Markdown）**：以下 13 个文件的哈希**取代 §2 及 v3/v4 节中同名行的旧值**（本节优先）。`
- `03-code/FREEZE.md:21`：`> | a1810688471aa99f | 3336 | server\app.js |` —— 实测 `server\app.js` = `e5a9723dec61c998` / 3416 字节。
- `03-code/FREEZE.md:15`：`> 验证：单测 **136/136**；真实 E2E \`04-test/e2e-multimodal-upload.mjs\` A1/A2/B1/B2 全过；**HTTP 路由冒烟 \`04-test/smoke-attachments-http.mjs\` 11/11 PASS**…`

v5 四条漂移明细（actual vs manifest）：

| 文件 | 实际 sha256[:16]/bytes | v5 记录 | 判定 |
|---|---|---|---|
| `server\config.js` | `8ca79d901fb15164` / 14450 | `a383640904d54525` / 13873 | 不一致 |
| `server\app.js` | `e5a9723dec61c998` / 3416 | `a1810688471aa99f` / 3336 | 不一致 |
| `web\reader.html` | `5bb6e4e82429521f` / 7467 | `98eca6731087480f` / 7213 | 不一致 |
| `web\assets\reader.css` | `0bc706a680ab8054` / 24975 | `0ea42cc8a1470871` / 21102 | 不一致 |

另外 3 个高价值漂移样本：`server/schema.sql` 实际 `8421816aa4bd6ce7`/15694 vs v4 `967a80f771423d35`/15122；`server/migrate.js` 实际 `3d30aacb0e9b17de`/11883 vs v4 `50ac4e145b21a4dc`/10695；`userscript/lit-uploader.user.js` 实际 `bf6e3db1fc4a5e26`/25638 vs v2 记载 12329（版本也从 `@version 1.1.0` 升到 `1.2.0`，而 FREEZE 未更新）。

**影响**：这份清单是"哪些文件已被验证过"的唯一记录（项目无 git、无 CI）。现在按它判断，会把 33% 已漂移的文件误当已验证版本，且 v5 之后的改动（config.js 的上限组、app.js 路由挂载、reader.html/reader.css 前端）完全没有复核记录；217 个未覆盖文件里含 `spaceFix.js`（22KB，PDF 断词修复）与 `page-image-source.js`（28KB，渲染沙箱）这类高危模块。v5 的两份 E2E 证据已丢，"已通过"变成不可复现的口头声明。

**建议**：① 用脚本重算并发布 v6，**范围收窄为源码白名单**（排除 `cmaps/`、`standard_fonts/`、`wasm/`、`iccs/` 等第三方数据面，改为记录 pdfjs-dist 版本号即可）；② 把生成/校验做成 `npm run freeze` / `npm run freeze:check`（退出码非 0 即失败），纳入唯一的验收门禁；③ 清单头部自动写入"本次覆盖 N 个文件 / 生成时间 / 生成命令"，标题去掉手写的 v2；④ 补回或删除对两份 E2E 脚本的引用，别让"验证过"指向不存在的文件。
**effort**：M

### F2【high】vendor 第三方 JS 无版本清单、无 SRI、无 license——可被静默替换

**现象**：`web/assets/vendor/` 实测 **322 个文件 / 5,549,391 字节**，`Get-ChildItem -Include *.json,*.md,*.txt` 返回**空**（无 VERSIONS/无 README/无 license 清单）。能从文件内容读到的版本只有四处：`md/marked.min.js` → `marked v12.0.2`（MIT）、`md/purify.min.js` → `DOMPurify 3.1.6`（Apache-2.0 + MPL-2.0）、`md/highlight.min.js` → `Highlight.js v11.9.0 (git: f47103d4f1)`（BSD-3-Clause）、`md/github.min.css` **无任何版本串**。引用点无 SRI：全站 grep `integrity=|crossorigin` = **0 命中**。pdf.js 本体 Apache-2.0 的 LICENSE/NOTICE **未随 vendor 落盘**（vendor 内只有 cmaps/iccs/standard_fonts/wasm 各自的数据文件 LICENSE_*）。反向的正面结论：`web/assets/vendor/pdfjs/pdf.min.mjs`（523,774B / `bccc24ea711db8e4`）与 `pdf.worker.min.mjs`（1,321,307B / `145d2dd3ab0c8615`）与 `node_modules/pdfjs-dist/legacy/build/` 同名文件**逐字节一致**，版本串 `"6.4.299"` 与 lock 一致——但"vendor 取自 legacy 构建"这个映射**没有任何文字记录**，只能靠本次手算证明；且它与 `node_modules/pdfjs-dist/build/pdf.min.mjs`（458,904B / `57456c8e0c81e46b`）**不是同一份**，下次有人从 `build/` 重新拷一次就会静默换成另一套构建。

**证据**（原文）：
- `03-code/web/reader.html:124-126`：`<script src="assets/vendor/md/marked.min.js"></script>` / `.../purify.min.js` / `.../highlight.min.js`（三条均无 `integrity` / `crossorigin`）。
- `03-code/web/assets/vendor/md/purify.min.js:1`：`/*! @license DOMPurify 3.1.6 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 */`（版本只存在于注释里，无外部校验手段）。

**影响**：这三个文件是人类可直接编辑的 JS，而 DOMPurify 是对话 Markdown 渲染的**唯一 XSS 屏障**（`purify` 在 124-126 行与 marked/highlight 同批加载）；没有期望哈希，替换/篡改/降级都不会被任何门禁发现（FREEZE 也未覆盖 `web/assets/vendor/**`）。license 缺失同时是分发合规风险——pdf.js 的 Apache-2.0 与 Foxit/Liberation 字体的授权条款目前只有数据子目录有 LICENSE。
**建议**：① 新增 `web/assets/vendor/VERSIONS.md`：每行 `文件 | 版本 | sha256[:16] | 来源(npm 包名@版本/路径) | license`；② `reader.html` 的三条 `<script>` 加 `integrity="sha384-…"` + `crossorigin="anonymous"`（同源也接受 SRI）；③ 把 `node_modules/pdfjs-dist/LICENSE` 拷成 `vendor/pdfjs/LICENSE`，并在 VERSIONS.md 注明"取自 legacy/build"；④ 把 vendor 清单也纳入 F1 的 `freeze:check`。
**effort**：S

### F3【high】playwright 未声明为依赖：page-image 能力与全部渲染 E2E 靠兄弟项目绝对路径借用

**现象**：`package.json` 只有 express + pdfjs-dist，**无 playwright、无 optionalDependencies**；`server/config.js` 默认 `pageImage.enabled=false` 且注释明确"本项目不装 playwright"。但 `04-test` 的 12 个渲染探针里至少 2 个把 playwright 的模块路径硬编码成**另一个项目的绝对路径**：`D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/playwright`（实测该目录存在=True，`03-code/node_modules/playwright`=False）。`v6-playwright-child.mjs`、`v4-tool.mjs` 等同样围绕 `lit_page_image` 做验证。即"多模态页面截图"这条链路的依赖是**本机路径巧合**，不是声明。

**证据**（原文）：
- `03-code/server/config.js:62`：`playwrightModule: '',   // 本项目不装 playwright；留空则先试 require('playwright')，失败即报 E_RENDERER_UNAVAILABLE`
- `04-test/probe-render-register.mjs:23`：`const PLAYWRIGHT_MODULE = 'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/playwright';`（`:55` 同文件把它塞进 `config.chat.pageImage.playwrightModule`）

**影响**：换机器、改目录名、删掉兄弟项目，`lit_page_image` 立刻 `E_RENDERER_UNAVAILABLE`，且 04-test 的渲染验证全部跑不起来——而 FREEZE v5 / 设计文档都把这条能力记为"已验证"。这不是"可选功能缺失"，是"已验证结论不可复现"。
**建议**：① `package.json` 增加 `optionalDependencies: { "playwright": "^1.x" }`（或 `devDependencies` + README 明写 `npx playwright install chromium`）；② 探针里的绝对路径改成 `process.env.LIT_PLAYWRIGHT_MODULE ?? 'playwright'`；③ README 补一节"启用页面截图通道的前置条件"（playwright + Chromium + TEMP 可写）。
**effort**：S

### F4【high】文档数字全线过期：README/STATUS/FREEZE 与实测不符（逐条 X/Y）

**现象**：README 与 STATUS 是接手者的第一入口，但其中的版本号、用例数、schema 版本、模块清单全部停在 M1/M2 时代。

| 位置 | 文档说 X | 实测 Y |
|---|---|---|
| `README.md:1` | `# Agent 工作流文献管理系统 · M2` | 已到 M5（FREEZE v5，2026-11-03 多模态） |
| `README.md:14` | `npm install     # express + pdfjs-dist（纯 JS，无原生模块）` | 盘上 38MB 预编译原生二进制（见 F6） |
| `README.md:24` | `迁移到 user_version=1` | `PRAGMA user_version` = **4** |
| `README.md:39` | `npm test` → `单元测试（69 个用例，零网络）` | `tests 155 / pass 155 / fail 0` |
| `README.md` 目录树（:53-73） | 缺 `reader.html`/`reader.js`/`viewer.js`/`translate.js`/`chat.js`、`routes/{segments,translate,layout,chat}`、`services/{chat,layout,engines,cli}` | 这些文件均存在 |
| `STATUS.md:1` | `# M1 交付状态（2026-10-31）` | 最新记录到 :637 的 155 用例（M5 时代） |
| `STATUS.md:130,159` | `69 个用例` / `npm test 全绿 69/69` | 155 |
| `STATUS.md:311,358` | `user_version = 2` / `迁移后：user_version=2  索引行数=492` | user_version=4；`translations_fts` 实测 **0 行**（segments 5947 / translations 3532） |
| `STATUS.md:399,425,452` | `npm test 107/107` | 155 |
| `STATUS.md:423` | `覆盖率文案由 70–80% 改为 76%–85%` | 无法复算（仅 14 个 asset / 424 works，见盲区） |
| `FREEZE.md:15` | `单测 136/136` + 两份 E2E 脚本 | 155；两份脚本不存在 |

**证据**（原文）：
- `03-code/README.md:24`：`首次启动会自动：建 \`data/app.db\`（7 张表 + FTS5）→ 迁移到 \`user_version=1\` → 恢复悬挂的下载任务 → 扫描下载目录做自愈校验。`
- `03-code/README.md:39`：`| \`npm test\` | 单元测试（69 个用例，零网络） |`
- `03-code/STATUS.md:358`：`迁移后：user_version=2  索引行数=492  应索引段数=492  segment_id 非空=482`
- `03-code/package.json:6`：`"description": "Agent 工作流文献管理系统 · 本地 Web 服务（M1：总览 / 详情 / 下载 / 本地打开 PDF）",`

**影响**：接手者按 README 的 `user_version=1` 判断迁移状态，会误以为库结构差 3 个版本；按"69 个用例"估工作量会低估一倍；按目录树找模块会找不到对话/翻译/布局三条主链。STATUS 里同一指标并存 69/107/155 三个值且无时间戳区分，等于没有结论。
**建议**：① README 的用例数改为不写死数字（写 `npm test` 命令 + "以实际输出为准"），或生成式写入；② schema 版本改为指向 `server/migrate.js` 的 `SCHEMA_VERSION` 常量而非写死；③ STATUS 顶部加"截至 <日期> / 当前 Milestone"，历史数字统一加"（M1 期）"前缀；④ `package.json` description 与 README 标题同步到当前 Milestone。
**effort**：S

### F5【medium】`engines: node >=22.5.0` 低于真实下限，声明支持的 Node 上服务启动即失败

**现象**：`package.json` 声明 `>=22.5.0`；但依赖 `pdfjs-dist@6.4.299` 自己声明 `engines: {"node":">=22.13.0 || >=24"}`，且 `server/db.js` 在模块顶层直接 `await import('node:sqlite')`——`node:sqlite` 在 22.5 引入时需 `--experimental-sqlite`，直到 22.13 才免 flag。`npm start` 脚本只带 `--no-warnings`，**没有** `--experimental-sqlite`。本机 v24.19.0 实测：不带任何 flag 导入 `node:sqlite` 成功且 stderr 为空；带 `--experimental-sqlite` 也仍被接受。

**证据**（原文）：
- `03-code/package.json:7-9`：`"engines": { "node": ">=22.5.0" },`
- `03-code/server/db.js:19`：`const { DatabaseSync } = await import('node:sqlite');`
- `node_modules/pdfjs-dist/package.json`：`"engines": { "node": ">=22.13.0 || >=24" }`

**影响**：在 22.5–22.12 上 `npm install` 只打一行 warning（`engines` 默认非强制），`npm start` 则在 import 阶段抛 `ERR_UNKNOWN_BUILTIN_MODULE`/`ExperimentalWarning` 相关错误并退出——用户得到的是"启动失败"而不是"Node 版本太低"。这条与不变量 10（零原生模块、依赖 Node 内置能力）直接相关，下界写错等于给不变量 10 挖了个坑。
**建议**：改为 `">=22.13.0"`（与 pdfjs-dist 对齐）或干脆 `">=24"`（本机与实测环境）；若必须兼容 22.5–22.12，则在 `start` 脚本加 `--experimental-sqlite` 并在 README 写明。顺带加 `.npmrc` 的 `engine-strict=true`，让版本不符在 install 阶段就失败。
**effort**：S

### F6【medium】`.npmrc omit=optional` 是全局静音开关，且盘上仍躺着 38MB 原生二进制（"零原生模块"在包层不成立）

**现象**：`.npmrc` 只有两行，第二行 `omit=optional`。后果有三层：
① **它不只作用于 pdfjs**——将来任何依赖把关键能力放在 `optionalDependencies` 都会被静默跳过（本次已发生：pdfjs 的 `@napi-rs/canvas` 被跳过，服务端渲染图像因此不可用，`extractor.js` 还要猴补 console 把它打的三条 polyfill 告警吞掉）。
② 实测 `npm ls --depth=0` 输出 `├── @napi-rs/canvas-win32-x64-msvc@1.1.0 extraneous`——`node_modules/@napi-rs/` 下有 `skia.win32-x64-msvc.node` 27.48MB + `icudtl.dat` 10.37MB（合计 38MB 预编译原生二进制），是 omit 生效前的历史残留；`package-lock.json` 里仍列 **11 个** `@napi-rs/canvas*` 条目（11 条 `"optional": true`）。
③ `node_modules` 顶层 70 个目录，其中 `@napi-rs/canvas`（元包）**不存在**，只有平台包——这是 `npm install --omit=optional` 分两次装的典型残留形态。

**证据**（原文）：
- `03-code/.npmrc:1-2`：`# 零原生模块：pdfjs-dist 的可选依赖 @napi-rs/canvas 只用于服务端渲染图像，本项目不需要` / `omit=optional`
- `03-code/README.md:14`：`npm install     # express + pdfjs-dist（纯 JS，无原生模块）`

**影响**：`npm ci` 会删掉这个 extraneous 目录（不同 npm 版本行为不同），本地"能跑"与"CI 能跑"可能分叉；对交接而言更糟的是文档写"无原生模块"、盘上有 38MB `.node`，"看代码觉得符合不变量 10"与"实际磁盘状态"不一致。omit=optional 的全局性也没有任何注释说明范围。
**建议**：① 重新生成 lock 时先删 `node_modules/@napi-rs` 与 lock 中 11 条 `@napi-rs/*`（`npm install --omit=optional` 后 `npm prune`），让磁盘与声明一致；② `.npmrc` 注释改成"**全局** omit optional：本项目不使用任何依赖的可选能力；若将来需要页面截图，改用显式 dependency"；③ 文档措辞改为"无**必需**原生模块"。
**effort**：S

### F7【medium】`^` 范围与 D17「锁死 pdf.js 版本」决策冲突

**现象**：`pdfjs-dist` 声明为 `^6.4.299`。有 `package-lock.json`（lockfileVersion 3）锁着 6.4.299，所以**本机可复现**；但 caret 给了"允许漂移"的许可——`npm update`、删 lock 重装、或换 npm 版本重建 lock，都会静默拿到 6.x 任意新版本。而项目的设计决策 D17 明确要求"锁死 pdf.js 版本，升级须走 `extract_version+1`"，`extractor.js` 也把 `PDFJS_VERSION = '6.4.299'` 写进抽取结果的版本标记，用于判定缓存是否失效。

**证据**（原文）：
- `03-code/package.json:19`：`"pdfjs-dist": "^6.4.299"`
- `03-code/server/services/extractor.js:20`：`export const PDFJS_VERSION = '6.4.299';`

**影响**：pdf.js 小版本升级会改变段落切分/空白处理，`translations` 缓存以 `(asset,page,ord)` 为键——抽取行为一变，旧译文与段落的对应关系可能错位，而 `extract_version` 不会自动 +1。当前靠 lock 兜住，属于"侥幸成立"。
**建议**：`pdfjs-dist` 改精确版本 `"6.4.299"`（express 可保留 caret，风险低）；`PDFJS_VERSION` 改为从 `pdfjs-dist/package.json` 读取（单一真相源）；在 README/FREEZE 记一句"升级 pdf.js = 同时 +1 extract_version 并重抽"。
**effort**：S

### F8【medium】API 契约表落后于实现：8 条端点无文档、2 条文档端点不存在，且过滤参数被静默忽略

**现象**：`02-design/架构设计文档.md` §8「REST API 契约表」（:518-653，含 8.7 SSE 协议细节）记录了 **38 条**路径；实现层 11 个路由组共注册 **44 条**（`server/app.js:49-61` 的 11 个 `api.use(...)`）。差异：**实现有、文档无 8 条**——`/assets/import-from-inbox`、`/chats/:id/attachments`、`/chats/:id/attachments/:attId`、`/jobs/layout/:id`、`/jobs/layout/:id/cancel`、`/jobs/layout/:id/events`、`/works/:no/layout`、`/works/lookup`；**文档有、实现无 2 条**——`/assets/:id`、`/works/1.1/download`（后者是笔误）。更麻烦的是行为层面：对运行中的实例实测 `GET /api/works?pageSize=1&downloadStatus=done` 返回 `total:424` 且首条 `downloadStatus:"needs_manual"`——**过滤参数被忽略，返回 200 + 未过滤数据**。

**证据**（原文）：
- `02-design/架构设计文档.md:518`：`## 8. REST API 契约表`
- `03-code/server/app.js:49-61`：`const api = express.Router()` 后连续 11 行 `api.use(healthRoutes/worksRoutes/…/chatRoutes())`（文档未登记其中 layout/chat 新增路径）

**影响**：契约表存在但过期，"有接口文档"是假象；`works` 列表的筛选参数名/语义在 38 条表里也没有说明是否生效，调用方只能靠试——而试出来的 200 响应是错的（未过滤），这比 404 更难排查。
**建议**：① 用 F1 的 `freeze:check` 同思路加一个端点清单生成器（扫 `r.(get|post|patch|put|delete)` → 与 §8 表格比对，缺失即失败）；② 把 8 条新端点补进 §8.3/8.5/8.6，删掉 2 条不存在的；③ 对已实现但忽略的参数，在表里显式标注"参数暂不生效"或直接实现。
**effort**：M

### F9【medium】缺失的运维文档：部署/升级 runbook、数据恢复流程、故障排查手册、04-test 运行说明

**现象**：`03-code/README.md` 共 105 行，只有"一条 npm start + 两条 import"；`02-design/架构设计文档.md` 用整篇讲设计与契约，但对"怎么部署、怎么升级、坏了怎么救"只有零散的句子（VACUUM INTO 备份、只前滚不回滚、Node 22 experimental 风险）。实现侧**已有**备份能力（`server/db.js` 的 `VACUUM INTO`），但**没有任何文档说明备份文件落在哪、怎么回灌、PDF 为什么不备份**。`04-test` 12 个探针无 README、无 package.json、无运行说明，其中 2 个依赖兄弟项目的 playwright（F3），且目录里混着 Chromium 用户目录残留（`LOCK`/`CURRENT`/`LOG`/`db`、空 `corrupt.pdf`）。

**证据**（原文）：
- `03-code/server/db.js:152`：`// VACUUM INTO 不允许目标已存在：同日多次迁移时加时间后缀，保留最近几份即可`
- `03-code/README.md` 全文（105 行）无部署/升级/故障排查/数据恢复章节；`04-test` 下无 README/package.json（实测仅 12 个 `.mjs` + 2 份 `.md` 报告）

**影响**：接手者最缺的不是 API 参考（§8 至少有 38 条可以补），而是"**这库怎么起来、坏了怎么救**"：没有 runbook 就无法在第二台机器上验证（Node 版本、npm install 参数、DB 迁移、备份恢复）；`data/app.db` 11.9MB 是唯一真相（424 works），备份存在但没有恢复步骤文档 = 出事时只能猜。
**建议**（按"接手者最缺"排序，也是建议的实施顺序）：① `README`/`docs/runbook.md`：环境要求（Node ≥22.13）、启动、导入、端口、日志位置、升级步骤（备份 → 停服 → 换代码 → 迁移 → 冒烟）；② `docs/recovery.md`：`VACUUM INTO` 产物位置与命名、如何回灌、PDF 不备份的后果（`storage/pdfs` 需单独保）、`download_jobs` 悬挂如何重置；③ `docs/troubleshooting.md`：`E_RENDERER_UNAVAILABLE`、`E_NO_SOURCE`、job 卡 queued、`E_UPSTREAM` 的判据与处置；④ API 参考（可从 F8 的表格自动生成）。
**effort**：M

### F10【low】`--no-warnings` 与 db.js 全局摘除 warning 监听构成双重静音（当前未掩盖任何告警）

**现象**：`package.json` 的 5 个脚本**全部**带 `--no-warnings`，同时 `server/db.js` 在模块顶层 `process.removeAllListeners('warning')` 后自建一个只放行非-`node:sqlite` 告警的监听器。实测：Node v24.19.0 下 `import('node:sqlite')` **stderr 完全为空**（不带 `--no-warnings` 也一样），`node --test` 155 个用例全程零 warning——即今天这两道静音**没有掩盖任何东西**。它们掩盖的是 22.x 时代的 `ExperimentalWarning` 与 pdfjs 缺 canvas 的三条 polyfill 告警（后者其实由 `extractor.js` 猴补 `console.warn` 另行处理）。

**证据**（原文）：
- `03-code/package.json:11`：`"start": "node --no-warnings server/index.js",`
- `03-code/server/db.js:11-15`：`// 一次性过滤 node:sqlite 的 ExperimentalWarning（白名单式，不影响其它告警）` / `process.removeAllListeners('warning');` / `if (w.name === 'ExperimentalWarning' && /SQLite|node:sqlite/i.test(w.message)) return;`

**影响**：两道机制都是**无条件、永久**的，没有旁路。将来升级 Node（如 node:sqlite 弃用/行为变更告警）或依赖出现 deprecation 时，"日志干净"会被误读成"没有问题"；`removeAllListeners('warning')` 还会删掉第三方库自己注册的 warning 监听（若有）。
**建议**：二选一即可——保留 `db.js` 的白名单过滤（意图清晰、可加日志），从 5 个脚本里删掉 `--no-warnings`（实测无需）；或反之。再补一句 `AGENTLIT_SHOW_WARNINGS=1` 旁路，便于排障时打开。
**effort**：S

## 覆盖与盲区

**已覆盖（有实测证据）**
- 依赖版本一致性：`package.json` vs 实装 vs lock vs 依赖自身 engines（express / pdfjs-dist）。
- `.npmrc`、`node_modules/@napi-rs` 残留、lock 里 11 条可选包。
- vendor 全部 322 个文件的清单、大小、可读版本串、SRI 缺失、pdf.js 与 legacy build 的逐字节对照。
- `engines` 与 `node:sqlite` 实际行为（v24.19.0 实测）、`--experimental-sqlite` 接受性。
- FREEZE v5 的 13 行逐条重算 + 全表 105 行的 70/35 比对 + 冻结范围 322 文件的覆盖率。
- README/STATUS/FREEZE 的过期数字逐条对照；`data/app.db` 的 user_version 与 6 张表计数（readOnly）。
- API 端点清单：实现 44 条 vs 设计文档 38 条的差集；`/api/health`、`/api/works` 的实调行为。
- userscript 的 `@connect` 白名单（无 `@require`/`@updateURL`，无远程代码注入面）。
- 04-test 目录内容与 playwright 绝对路径依赖。

**盲区（未验证，不猜）**
1. **无 git、无 CI**：35 个漂移文件"是谁、何时、改了什么"无法归因，只能报"不一致"。
2. **未在 Node 22.5–22.12 实测**（本机仅 v24.19.0）：F5 的"启动即失败"依据是 pdfjs-dist 的 engines 声明 + node:sqlite 需 flag 的公开事实，非本机复现。
3. **未做 `npm audit`**（registry 404）：express 4.22.3 的传递依赖（qs/send/cookie 等）的 CVE 级别未评估，本报告不含任何安全补丁结论。
4. **marked/purify/highlight 未能与官方产物比对哈希**：本机无对应 npm 包，只读了内嵌版本串，无法证明它们是原版（也无法证伪）。
5. **04-test 的 12 个探针未执行**：部分需 playwright + Chromium（借自 deepseek-harness-master，按要求未触碰该目录），部分会改运行态 config；因此"渲染栈已验证"的结论本轮不采信也不否定。
6. **02-design 189.6KB 只按关键词定位片段**，未逐节核对设计与实现的其它不一致（只核了 §8 端点表）。
7. **PDF 文本覆盖率 76–85% 无法复算**：需对 14 个本地 PDF 实跑抽取（会写库）。只能给出旁证口径：`assets=14` / `works=424`，即"有 PDF 的条目"仅占 3.3%，任何全库口径的覆盖率表述都不成立。
8. **`data/app.db` 只读查询**未做表结构级核对（如索引是否与 schema.sql 一致），属其他子代理范围。

## 动态验证记录（命令 + 真实输出）

**1) 依赖实装版本**
```
> node -e "for (const p of ['express','pdfjs-dist']) { const j=require('./node_modules/'+p+'/package.json'); console.log(p, j.version, JSON.stringify(j.engines||null)); }"
express 4.22.3 {"node":">= 0.10.0"}
pdfjs-dist 6.4.299 {"node":">=22.13.0 || >=24"}
```

**2) npm ls（extraneous 原生包）**
```
> npm ls --depth=0
agent-workflow-literature-system@1.0.0-m1 D:\A-knowledge\agent工作流优化\03-code
├── @napi-rs/canvas-win32-x64-msvc@1.1.0 extraneous
├── express@4.22.3
└── pdfjs-dist@6.4.299
```
```
> Get-ChildItem node_modules\@napi-rs -Recurse -File | Select @{n='MB';e={[math]::Round($_.Length/1MB,2)}},Name
10.37 icudtl.dat
 0.09 sbom.cdx.json
27.48 skia.win32-x64-msvc.node
```

**3) .npmrc**
```
> Get-Content .npmrc
# 零原生模块：pdfjs-dist 的可选依赖 @napi-rs/canvas 只用于服务端渲染图像，本项目不需要
omit=optional
```
lock 内 `"node_modules/@napi-rs/` 条目 11 条，`"optional": true` 11 条。

**4) node:sqlite 与告警（不带 --no-warnings）**
```
> node --input-type=module -e "const m = await import('node:sqlite'); console.log('exports:', Object.keys(m).join(','))" 2>&1
exports: DatabaseSync,Session,StatementSync,backup,constants,default
```
（stderr 为空；带 `--no-warnings` 时输出相同。`node --experimental-sqlite -p "process.version"` → `v24.19.0`，flag 仍被接受。）

**5) 单元测试真实数量**
```
> node --test "server/test/*.test.js"
tests 155 / pass 155 / fail 0 / duration_ms 784
```
（全程无 warning 输出。`package.json:39` 的 README 文案"69 个用例"过期 86 个。）

**6) 运行时与 DB 实况（7317 实例，只读）**
```
> curl.exe -s http://127.0.0.1:7317/api/health
{"ok":true,"version":"1.0.0-m1","dbDriver":"node:sqlite","downloadDirWritable":true,"missingAssets":0,"activeJobs":0,"works":424}

> curl.exe -s "http://127.0.0.1:7317/api/works?pageSize=1&downloadStatus=done"
{"total":424,"page":1,"pageSize":1,"items":[{…"downloadStatus":"needs_manual"…}]}   ← 过滤参数未生效

> node --input-type=module -e "…new DatabaseSync('data/app.db',{readOnly:true})…"
{"user_version":4,"works":424,"assets":14,"segments":5947,"translations":3532,"translations_fts":0}
```
（对照 `STATUS.md:358` 的 `user_version=2 / 索引行数=492 / segment_id 非空=482`。）

**7) FREEZE v5 逐条重算（sha256 前 16 位 + bytes）**
```
> (Get-FileHash -Algorithm SHA256 文件).Hash.ToLower().Substring(0,16)
OK      server\services\chat\attachments.js              072f195b8283e0db/9839
DRIFT   server\config.js                                 8ca79d901fb15164/14450  vs a383640904d54525/13873
DRIFT   server\app.js                                    e5a9723dec61c998/3416   vs a1810688471aa99f/3336
OK      server\routes\chat.js                             f093e8601401e245/7096
OK      server\services\chat\pipeline.js                 cea015809aa15697/14656
OK      server\services\chat\session.js                  facfc2e5db100341/9794
OK      server\services\chat\persona\lit-research.js     3009d74d15048493/4159
OK      server\errors.js                                 6e16da034021c644/2628
OK      server\middleware\security.js                    32453afd8d87426d/5868
OK      server\test\attachments-multimodal.test.js       839836f81f1ffd7a/6632
DRIFT   web\reader.html                                  5bb6e4e82429521f/7467   vs 98eca6731087480f/7213
OK      web\assets\chat.js                               2d10aaf8a15ec4db/27925
DRIFT   web\assets\reader.css                            0bc706a680ab8054/24975  vs 0ea42cc8a1470871/21102
v5 => OK=9 DRIFT=4
```
全表（去 blockquote 前缀后按 v5>v4>v3>§2 去重，105 条）：`MATCH=70 MISMATCH=35 MISSING=0`；有效行 v5=13 / v4=16 / v3=4 / §2=72。
```
> Test-Path 04-test\e2e-multimodal-upload.mjs   → False
> Test-Path 04-test\smoke-attachments-http.mjs  → False
```

**8) vendor 与 pdfjs 构建对照**
```
> (Get-FileHash -Algorithm SHA256 …)
web\assets\vendor\pdfjs\pdf.min.mjs          bccc24ea711db8e4  523774   = node_modules\pdfjs-dist\legacy\build\pdf.min.mjs
web\assets\vendor\pdfjs\pdf.worker.min.mjs   145d2dd3ab0c8615 1321307   = node_modules\pdfjs-dist\legacy\build\pdf.worker.min.mjs
node_modules\pdfjs-dist\build\pdf.min.mjs    57456c8e0c81e46b  458904    ← 非 legacy，不同
```
```
> Get-ChildItem web/assets/vendor -Include *.json,*.md,*.txt   → 空
> 全站 Select-String "integrity=|crossorigin"                   → 0 命中
> vendor 文件数 / 总字节                                        → 322 / 5,549,391
```

**9) 路由端点与文档差集**
```
> Select-String -Path server\routes\*.js -Pattern "r\.(get|post|patch|put|delete)\(\s*'([^']+)'"
42 条唯一路径 + 2 处多行写法（assets.js:171-172、chat.js:156-157） = 44
每文件：assets 5 / chat 9 / download 1 / health 1 / import 1 / jobs 4 / layout 4 / segments 3 / settings 6 / translate 8 / works 6
```
```
> 设计文档 §8 提取路径 → 38 条
实现有文档无 8 条：/assets/import-from-inbox, /chats/:id/attachments, /chats/:id/attachments/:attId,
                  /jobs/layout/:id, /jobs/layout/:id/cancel, /jobs/layout/:id/events, /works/:no/layout, /works/lookup
文档有实现无 2 条：/assets/:id, /works/1.1/download
```

**10) playwright 借用（未触碰 deepseek-harness-master，仅 Test-Path）**
```
> Test-Path D:\A-knowledge\agent工作流优化\deepseek-harness-master\node_modules\playwright  → True
> Test-Path 03-code\node_modules\playwright                                              → False
> 04-test\probe-render-register.mjs:23  硬编码同一绝对路径（:55 注入 config.chat.pageImage.playwrightModule）
```
