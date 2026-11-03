# 评审共享上下文（所有子代理必读）

> 本文件由主理人在 fan-out 前写定，作为 15 个子代理的共同事实基线。
> **它不是设计文档的替代品**，只保证"所有人对同一系统、同一评级口径说话"。

## 0. 硬性纪律

1. **只读**：`D:\A-knowledge\agent工作流优化\03-code\server|web|userscript|scripts` 与 `04-test/`、`02-design/` 一律**不得修改、不得格式化、不得创建文件**。
   （`03-code/FREEZE.md` 是冻结清单，冻结范围 = `server/**`、`web/**`、`userscript/**`、`data/app.db`。）
2. **只写**：`D:\A-knowledge\agent工作流优化\05-review\` 目录（报告写到 `05-review\agents\`）。
3. 不要启动/重启/停止 7317 端口上的服务（已有实例在跑）。需要动态验证时用 `curl http://127.0.0.1:7317/...` 只读接口。
4. 不要 `npm install` / `npm audit`（本机 registry 不可达，会 404）。不要删 `node_modules`。
5. 不要碰 `deepseek-harness-master/`（479MB 的解包产物，与本系统无关）。

## 1. 被评对象

`D:\A-knowledge\agent工作流优化\03-code\` —— **Agent 工作流文献管理系统**（本地单机 Web 服务）。
把 424 条文献 CSV 升级为本地工作台：总览检索 → 详情 → PDF 下载（arXiv/官方链接两级）→ 阅读器（pdf.js 原文 + 双语对照）
→ 全文翻译（按段抽取/按段缓存/页面级增量）→ 跨语言双索引检索 → 对话问答（工具调用引擎）→ 多模态输入。

- 规范源：`02-design/架构设计文档.md`（v1.2，194KB）+ `02-design/架构改造-对话agent参照dsh.md` + `02-design/多模态输入输出设计.md`
- 交付状态：`03-code/STATUS.md`（M1/M2/M3/M4/M5 逐项记录，含"未验证"声明）、`03-code/FREEZE.md`（哈希冻结清单）
- 技术栈：Node.js ESM（`type: module`）、Express 4、**`node:sqlite`（Node 内置，非 better-sqlite3）**、pdfjs-dist 6、原生 JS 前端（零构建）
- 启动：`npm start` → http://127.0.0.1:7317/ ；导入：`npm run import` ；测试：`npm test`（`node --test server/test/*.test.js`）

## 2. 已核实的事实基线（主理人实测，可直接引用）

| 事实 | 值 |
|---|---|
| Node / npm | v24.19.0 / 11.17.0（`package.json` 声明 `>=22.5.0`） |
| 运行时依赖 | 只有 2 个直接依赖：`express ^4.22.3`、`pdfjs-dist ^6.4.299` |
| 单测 | `npm test` → **155 pass / 0 fail**，约 0.9s，25 个测试文件 |
| 源码规模 | ~130 个 js/html/css/sql 文件，约 13k 行；最大单文件 763 行 |
| 版本控制 | **无 git 仓库**（`03-code` 下无 `.git`），无 CI 配置 |
| 数据库 | `03-code/data/app.db` 11.9MB（WAL 另 5MB），424 works；备份在 `data/backup/` |
| 服务状态 | 127.0.0.1:7317 正在监听 |
| 真实 LLM | **零真实调用**（无 key）。所有 LLM 路径只有代码 + mock 证据 |
| 前端依赖 | vendor 内联：pdf.js 523KB + worker 1.3MB、marked/purify/highlight 约 177KB |

## 3. 模块地图（分工时按此切片，避免重复）

```
03-code/
├── server/
│   ├── index.js           启动编排（配置→开库→迁移→恢复悬挂 job→自愈→监听→优雅退出）
│   ├── app.js             Express 组装（security → rateLimit → json(1mb) → 11 个路由 → static → error）
│   ├── config.js  317行   五层配置合并 env > secret.json > settings 表 > config.local.json > 默认
│   ├── db.js 145行        node:sqlite 薄封装 exec/all/get/run/tx + WAL + 告警过滤
│   ├── schema.sql 241行   7+ 张表 + FTS5，user_version 迁移到 v3
│   ├── migrate.js 252行   分级迁移 + VACUUM INTO 备份
│   ├── errors.js 57行     AppError + 21 个错误码（E_*）
│   ├── logger.js 66行     JSON 行日志 + 脱敏
│   ├── middleware/        security(126) validate(82) error(57) ratelimit(22)
│   ├── routes/            health works download jobs assets settings import segments translate layout chat
│   ├── services/
│   │   ├── artworks.js 418行 / importer.js 317行 / storage.js 417行 / downloader.js 601行
│   │   ├── pdf/{meta.js 98, buildPages.js 752, spaceFix.js 341} + extractor.js 391
│   │   ├── layout/{refine.js 358, job.js 130}
│   │   ├── fts.js 423行    CJK 2-gram + 双索引（原文/译文）
│   │   ├── llm/client.js 435行  唯一出站 HTTP 出口，三家协议 + 流式
│   │   ├── translate/     pipeline(763) cacheKey prompts engines/{registry,shared,openaiCompatible,gemini,claude,mock,types}
│   │   ├── chat/          agent(299) pipeline(343) loop(148) registry(212) session(208) context(157)
│   │   │                  retrieval(131) citations(28) prompts(112) persona/lit-research(57)
│   │   │                  attachments(230) image-inject(87) render/{page-image-source(611), render-geometry(99)}
│   │   │                  tools/{index,lit-search,lit-read,lit-translation,lit-page-image,lit-update-note,_resolve,_sandbox}
│   │   └── resolvers/     index arxiv doi link manual
│   ├── cli/               fts-rebuild.js replay-chat.js verify-agent.js
│   └── test/              25 个 *.test.js（node:test）
├── web/                   index/work/settings/reader .html + assets/{api,ui,list,work,settings,reader,viewer,translate,chat}.js
│                          + app.css(403) reader.css(424) + vendor/{pdfjs,md}
├── userscript/lit-uploader.user.js 470行  Tampermonkey 浏览器直传（人机验证等待 / 批量队列）
└── scripts/               make-preview.js verify-refine.js probe-batch.js
```

## 4. 核心不变量（评"破坏它=缺陷"用）

1. **路径白名单**：所有文件读写必须过 `assertInScope`（realpath 前缀 ∈ downloadDir/data/storage），越界 `E_PATH_OUT_OF_SCOPE`。
2. **PDF 三连校验**：前 5 字节 `%PDF-` + 页数 ≥ 1 + 体积 ≥ 8KB，三者同时成立才算下载成功；HTTP 200 不算成功。
3. **原子写**：先写 `<downloadDir>/.tmp/*.part`，校验通过后同盘 rename；文件名 `<no>__<slug>.pdf` 是幂等键。
4. **DB 是唯一真相**：下载状态机 `queued→resolving→downloading→verifying→done|failed|needs_manual`，内存队列只是投影。
5. **字段级锁**：`PATCH /api/works/:no` 改过的字段进 `fields_locked`，重导入跳过并计入 `skippedLocked`。
6. **密钥只写不读**：`data/secret.json`，GET 只回掩码 `sk-…cdef`，日志与前端拿不到明文。
7. **仅 127.0.0.1**：Host 白名单 + 写接口 Origin 校验 + `application/json` 强制 + 出站 URL 逐跳 SSRF 校验。
8. **缓存键**：`sha256(engine|model|tgtLang|promptFp|extractVersion|normalizedText)`，**不含 srcLang**；重抽/改模型/改提示词 → 全部 miss（设计行为）。
9. **双索引同 tx**：`translations` upsert 与 `translations_fts` 写入必须在同一个事务；`translations_fts.rowid = segments.id`。
10. **零原生模块**：`@napi-rs/canvas` 是 pdfjs 的可选依赖，`.npmrc` 有 `omit=optional`，不得引入需要编译的依赖。

## 5. 评级口径（全队统一，必须套用）

**严重度 severity**（按"现在就会造成什么后果"判，不按"改起来难不难"）

| 级别 | 判据 | 例子 |
|---|---|---|
| `blocker` | 已经能导致数据丢失/损坏、服务无法启动、任意文件读写、密钥泄露、或静默给出错误结论（假成功/假引用） | 迁移失败但 user_version 前进；未校验的路径拼进 fs |
| `high` | 特定条件下必触发的功能错误、可被本机其他进程利用的越权、整条链路静默降级 | 取消后 job 卡死；FTS 与表不一致 |
| `medium` | 边界情况失败、可维护性显著劣化、缺测试覆盖的核心路径 | 长文档抽取 OOM 风险 |
| `low` | 代码味道、命名、注释、文档滞后、可选优化 | 魔法数字、重复代码 |

**优先级 priority**（由主理人汇总时按 `severity × 影响面 × 修复成本` 定，子代理只给 severity 和 effort，不要自己编 P0/P1）

**effort**：`S`（≤半天，单文件）／`M`（1–2 天，跨 2–3 文件）／`L`（3–5 天，跨模块，需迁移或契约变更）／`XL`（>1 周，需要架构调整或外部依赖）

**证据要求**：每条 finding 必须给出 `文件路径:行号` + **真实代码片段（原文，不改写）**。没有行号的结论视为无效。
读不到/跑不了的部分，写进 `coverage_gaps`，**不许猜**。

## 6. 用户要求的 8 个维度（报告里必须能对上号）

代码质量 · 性能 · 安全性 · 可维护性 · 错误处理 · 测试覆盖 · 依赖管理 · 文档

## 7. 输出契约（每个子代理都要遵守）

1. **写一份完整报告**到 `05-review/agents/<agent-id>.md`：包含 `## 结论`、`## findings`（每条一个小节：现象/证据/影响/建议/effort）、`## 覆盖与盲区`、`## 动态验证记录`（跑过什么命令、得到什么真实输出）。
2. **返回一个 JSON 对象**（这是你的最终回答，不要加任何解释、不要包在 ```json 代码块里），字段：
   - `agent`：如 `"A08-pdf-extract"`
   - `files_read`：字符串数组（相对 `D:\A-knowledge\agent工作流优化` 的路径）
   - `findings`：数组，每项 `{ "title", "severity", "file", "lines", "evidence", "impact", "fix", "effort" }`
     - `title` ≤ 40 字；`evidence` ≤ 200 字（必须是原文代码摘录）；`impact` ≤ 120 字；`fix` ≤ 150 字
     - **最多 10 条**，按 severity 降序；宁少勿滥，不要凑数
   - `metrics`：对象，放你测出来的数字（如 `{"testFiles":25,"untestedModules":9}`），没有就 `{}`
   - `coverage_gaps`：字符串数组，≤ 6 条
   - `report_path`：报告文件绝对路径
3. 中文回答。`file` 路径从 `03-code/` 起写（如 `03-code/server/routes/assets.js`），`lines` 写 `"120-160"` 这种区间。
