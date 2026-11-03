# Agent 工作流文献管理系统 · M2

把 `../Agent工作流文献清单.csv`（424 条 × 13 列）升级为本地 Web 工作台：
总览检索 → 条目详情 → PDF 下载（arXiv / 官方链接两级）→ **阅读器（pdf.js 原文 + 双语对照）**
→ **全文翻译（按段抽取、按段缓存、页面级增量）** → 双语 Markdown 导出。

> 设计与契约以 `../02-design/架构设计文档.md`（v1.2）为唯一规范源。本目录是它的落地实现。
> 原有静态交付物（`Agent工作流文献清单.{html,md,csv}`、`build/`、`zotero插件1/`）**未被修改**，仍可独立双击打开。

## 怎么启动（一条命令）

```bash
cd 03-code
npm install     # express + pdfjs-dist（纯 JS，无原生模块）
npm start       # → http://127.0.0.1:7317/
```

要在**没有 LLM key** 的情况下验证翻译管线（假引擎，不发任何网络请求）：

```bash
AGENTLIT_MOCK_ENGINE=1 npm start
```

首次启动会自动：建 `data/app.db`（7 张表 + FTS5）→ 迁移到 `user_version=1` → 恢复悬挂的下载任务 → 扫描下载目录做自愈校验。
**数据库是空的**，先导入元数据：

```bash
npm run import:dry   # 只看 diff（不写盘）
npm run import       # 写盘（可重复执行，第二次应显示「未变 424」）
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动服务（仅监听 127.0.0.1，端口 7317） |
| `npm run import` | CSV → `works`（merge，字段级锁生效） |
| `npm run import:dry` | 只输出 diff 报告，不写盘 |
| `npm test` | 单元测试（69 个用例，零网络） |

## 页面

| 路径 | 内容 |
|---|---|
| `/` | 总览：专题侧栏 + 即时搜索 + 类型/下载状态筛选 + 分页 + 每行「详情 / 打开 PDF / 下载 / 原文」+ job 进度轮询 |
| `/work.html?no=4.4` | 详情：元数据、贡献定位、arXiv/DOI/链接跳转、本地 PDF 状态、下载/重下/上传/定位文件、字段级编辑（改后自动锁定） |
| `/reader.html?no=4.6` | 阅读器：左 pdf.js 原文（文字可选中）+ 右译文栏；点译文回跳原文并高亮 `segments.bbox`；对照/仅译文两档；全文翻译、继续翻译、取消、导出双语 Markdown |
| `/settings.html` | 设置：下载目录（switch）、重扫自愈、LLM 供应商（provider / baseUrl / model / apiKey，含连通性测试）、导入、统计 |

## 目录

```
03-code/
├── package.json  config.local.json  .gitignore
├── server/
│   ├── index.js  app.js  config.js  logger.js  errors.js
│   ├── db.js  schema.sql  migrate.js  import-cli.js
│   ├── middleware/{security,validate,error,ratelimit}.js
│   ├── routes/{health,works,download,jobs,assets,settings,import}.js
│   ├── services/{artworks,importer,downloader,storage}.js
│   ├── services/resolvers/{index,arxiv,doi,link,manual}.js
│   ├── services/segment.js       文本清洗/分句/分段/编号协议（移植插件 lib/segment.js）
│   ├── services/pdf/meta.js      PDF 魔数 + 页数 + 体积三连校验
│   ├── services/pdf/buildPages.js 原创 S1–S7：行聚合/栏判定/阅读顺序/段落合并/角色判定
│   ├── services/extractor.js     pdfjs-dist → segments + FTS
│   ├── services/fts.js           CJK 2-gram 索引与检索
│   ├── services/translate/*      管线 / 缓存键 / 提示词 / engines
│   ├── services/llm/client.js    唯一出站 HTTP 出口（密钥只在此读取）
│   └── test/*.test.js
├── web/  index.html  work.html  settings.html  assets/{app.css,api.js,ui.js,list.js,work.js,settings.js}
├── data/     运行时（app.db / logs / secret.json）——gitignored
└── storage/  pdfs（默认下载根）/ inbox（手动拖入）/ tmp
```

## 关键行为（与设计一致的部分）

- **路径白名单**：所有文件读写都过 `assertInScope`（realpath 前缀 ∈ downloadDir / data / storage），越界返回 `E_PATH_OUT_OF_SCOPE`。
- **PDF 校验三连**：前 5 字节 `%PDF-` + 页数 ≥ 1 + 体积 ≥ 8KB，三者同时成立才算成功；HTTP 200 不算成功。
- **原子写**：先写 `<downloadDir>/.tmp/*.part`，校验通过后同盘 `rename`，文件名 `<no>__<slug>.pdf` 即幂等键。
- **下载状态机**：`queued → resolving → downloading → verifying → done|failed|needs_manual`，DB 是唯一真相，内存队列只是投影；启动时把悬挂状态重置为 `queued`。
- **字段级锁（D2 定案）**：`PATCH /api/works/:no` 改过的字段进 `fields_locked`，重导入跳过并计入 `skippedLocked`；`unlock` 可解禁。
- **安全**：仅 127.0.0.1、Host 白名单、写接口 Origin 校验 + `application/json` 强制、出站 URL 逐跳 SSRF 校验、密钥只写不读（GET 只返回掩码）。

## 翻译怎么用

1. 设置页填 provider（默认 `deepseek`）/ `baseUrl` / `model` / `apiKey` → 「测试连通性」。
   key 写到 `data/secret.json`，接口只回 `sk-…cdef` 掩码，日志与前端都拿不到明文。
2. 详情页点「打开阅读器」→ 首次进入会自动抽取文本（约 1–2s），右侧出现段落列表。
3. 点「全文翻译」：从当前可见页开始（`anchorPage`），SSE 按页推送译文；中途关页/取消 → job 转 `paused`，再点「继续翻译」不重译已完成页。
4. 「导出双语 Markdown」下载 `GET /api/works/:no/translation/export?bilingual=1`。

缓存与版本绑定（会影响「明明是译过的」判断）：
- 缓存键 = `sha256(engine|model|tgtLang|promptFp|extractVersion|normalizedText)`，**不含 srcLang**（§21 R3）。
- 改模型 / 改提示词 / 重抽（`POST /api/assets/:id/extract {force:true}` → `extract_version+1`）→ 旧译文一律不再命中，这是设计行为，不是 bug。

## M2 明确没做（M3）

对话问答（`chats/messages` 表已建好留空）、`DELETE /api/assets/:id`、目录迁移（`migrate` 模式）、OCR（扫描件标 `needs_ocr`）、
表格结构化与译文按原版式回填（M2b 已明确不做：web 端没有整页位图打底，字体级重排必然错位）。

## 配置

`config.local.json` 里的路径可写相对路径（相对本目录）。
优先级：`env > data/secret.json > settings 表 > config.local.json > 内置默认`。
环境变量：`AGENTLIT_PORT` / `AGENTLIT_DB` / `AGENTLIT_DOWNLOAD_DIR` / `AGENTLIT_LOG_LEVEL` / `AGENTLIT_LLM_API_KEY` / `AGENTLIT_LLM_BASE_URL`。
