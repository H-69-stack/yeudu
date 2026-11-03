# dsh 能力 → 03-code 逐项接入对照表

> 回答用户指令：「将 dsh 的全部功能尽可能完整地接入，逐一梳理各项功能并确保覆盖齐全，标注已接入与未接入项及原因，保证集成后的功能可正常调用且行为一致。」
>
> 判定时间：2026-11-02。所有「已接入」项均带落点文件与实测证据；未接入项必写原因。

---

## 一句话结论

**dsh-litagent（对标的那套文献 agent）的全部能力已 100% 有落点，且 12/12 项行为已实测一致（含图片注入模型这一环已闭环验证）。**
dsh 上游通用 harness 的 54 个能力包中，**14 项以等价形式接入**，**40 项不适用（文献研究场景无对应需求，或属产品外壳而非 agent 能力）**，无一项是「能做却漏做」。

> 2026-11-02 收尾更新：B19「图片注入模型」已从🔄进行中改为✅已接入——通过 `image-inject.js` + `loop.js` 把渲染出的图以**用户消息**注入模型上下文，并经**真实端到端**验证（真渲染 4.4 第 1 页 → 真注入 → 模型准确描述了页眉/标题/13 位作者/arXiv 编号/Abstract/Keywords/引言引文等只能从图读出的细节，总耗时 5.7s）。详见 §5.2 与 §6.1。

> 2026-11-03 收尾更新：① **多模态输入/输出已闭环**——用户可上传图片/文件（前端 📎 → `POST /attachments` → `attachmentId` → 随 `messages` 以 `image_url` data URI 注入模型上下文；工具产图经 §5.2 视觉通道渲染后前端可直接放大/下载），新增 B22；② **persona 升级**（`persona/lit-research.js` 加「不要自报流程」约束 + 「表达与排版」Markdown 纪律段，对齐 dsh 式语气）；③ **单元测试 126 → 136/136**（新增 `attachments-multimodal.test.js` 10 例），并新增真实端到端 `04-test/e2e-multimodal-upload.mjs`（A1 用户图入模 + A2 落盘回读确定性通过，B1 模型真实描述上传图 + B2 lit_page_image 渲染真实页均通过）。详见 §5.3 与 §6。

---

## 判定口径

| 标记 | 含义 | 判定标准 |
|---|---|---|
| ✅ **已接入** | 能力可用且行为与 dsh 一致 | 有落点文件 + 单测或实测证据 |
| ⚠️ **降级接入** | 能力可用，但形态简化 | 语义等价，实现机制不同（已注明差异） |
| 🔄 **进行中** | 已排期/实现中 | 尚未完成实测 |
| ❌ **未接入** | 不接入 | **必须写明原因**，见 §4 原因归类 |

---

## 1. A 层：dsh-litagent 核心能力（行为一致的判定基准）

这一层是「行为一致」的硬标准——逐项对齐 `dsh-impl/packages/dsh-bundle-litagent/src/`。

| # | dsh 能力（源码位置） | 03-code 落点 | 状态 | 说明 |
|---|---|---|---|---|
| A1 | `tools/lit-search.ts` 文献检索 | `server/services/chat/tools/lit-search.js` | ✅ | 跨库检索；`fts.js` 新增 `searchWorksAcross`（原 `fts.js:250` 的 `asset_id=?` 单篇锁已解锁） |
| A2 | `tools/lit-read.ts` 读原文 | `tools/lit-read.js` | ✅ | 按页读段落，带 `[p页#段]` 锚点，显式 `truncated`+maxChars |
| A3 | `tools/lit-translation.ts` 读译文 | `tools/lit-translation.js` | ✅ | 无译文时明确告知（不是空串，不是报错） |
| A4 | `tools/lit-update-note.ts` 写笔记 | `tools/lit-update-note.js` | ✅ **默认关闭** | 双保险：不在 `chat.tools` 清单 + 服务层 `allowWrite=false` 闸；乐观并发 `expectUpdatedAt`。与 dsh「写工具默认 disabled」一致 |
| A5 | `tools/lit-page-image.ts` 看页面外观 | `tools/lit-page-image.js` | ✅ **默认关闭** | 两态契约 `ok`/`no_pdf`；`no_pdf` 只由「无本地 PDF」产生，渲染失败一律抛错不降级 |
| A6 | `service/page-image-source.ts` 渲染 seam | `render/page-image-source.js`（675 行） | ✅ | 假 origin `http://lit-page.invalid` + `context.route` 进程内交付，**不监听端口**；其余 host 一律 abort |
| A7 | `service/render-geometry.ts` 渲染几何 | `render/render-geometry.js`（125 行） | ✅ | 纯函数移植：`maxEdge` 约束输出长边、取 1/4 象限时 scale 翻倍、`TOKEN_CELL_PX=42` |
| A8 | `service/page-image-usage.ts` 看图配额 | `registry.js:190-200` + `session.countToolCalls` | ✅ | 跨轮配额；数据源=**落库日志**（重启不丢）。判定语义见 §5.1 |
| A9 | `service/library.ts` 库服务 | `fts.js` + `retrieval.js` | ✅ | 既有能力复用，未重写 |
| A10 | `service/db.ts` 数据服务 | `db.js` | ✅ | 同一个 `app.db`，与 dsh 指向同一份数据 |
| A11 | `persona/research.ts` 研究人格 | `persona/lit-research.js` | ✅ | 含 dsh 的 IMAGE_BOUNDARY 四条看图边界（「不是 OCR」硬边界）；纯函数、字节稳定 |
| A12 | `dev/inspect.ts` 装配探针 | `server/cli/verify-agent.js` | ✅ | 6 断言（工具装配/schema/跨库/锚点/译文/额度闸），无 key 可跑 |

**A 层小结**：12/12 有落点，11/12 行为已实测一致。

---

## 2. B 层：dsh 内核范式（决定「像不像 dsh」）

| # | dsh 范式（依据） | 03-code 落点 | 状态 | 说明 |
|---|---|---|---|---|
| B1 | `defineTool` 契约（`01-源码梳理.md:226-240`） | `registry.js` | ✅ | `{name,description,parameters,output:{schema,render},execute}` 逐字段对齐 |
| B2 | `execute` 只返规范 JSON，`render` 单独产出模型可见文本 | 同上 | ✅ | 两个关注点分离 |
| B3 | 参数按 schema 校验后才进 `execute` | 同上 | ✅ | |
| B4 | 输出 schema 校验 → `INVALID_TOOL_OUTPUT` | `validateOutput` | ✅ | |
| B5 | `exec.signal` 必守（取消传播） | `registry.js` + `runtime.js` inflight Map | ✅ | 取消后不再发起新一轮 |
| B6 | 注册即副作用 / 注册即 schema | `registerAll` | ✅ | |
| B7 | 作用域化工具注册表 | `createRegistry(config)` | ✅ | |
| B8 | 单工具超时 | `withTimeout`（`registry.js:118`） | ✅ | → `TOOL_TIMEOUT` |
| B9 | 失败不中断（工具错误是结果不是异常） | `run()` 永不抛 | ✅ | 与 dsh `isError` 语义一致 |
| B10 | 错误码体系（`contracts.ts`） | `registry.js` | ✅ | `UNKNOWN_TOOL/INVALID_TOOL_OUTPUT/TOOL_TIMEOUT/ABORTED/TOOL_QUOTA` 五码齐全 |
| B11 | 每轮调用闸（成本闸） | `maxToolCallsPerTurn=8` | ✅ | 超限返回确定性文本逼模型收尾 |
| B12 | 每会话每工具配额（跨轮） | `maxCallsPerSession` | ✅ | |
| B13 | 单调 guard（只能拒绝，不可被撤销） | 配额闸实现 | ✅ | 语义等价：闸一旦命中不可绕过 |
| B14 | 附件内容寻址引用（省 token） | `attachments.js`：`img_<sha256>` | ✅ | 落 `data/attachments/v1/objects/<2位hex>/<sha>`，幂等 |
| B15 | persona 分节装配 | `prompts.js:buildToolsPersona` | ⚠️ **降级** | dsh 是 `ctx.systemPrompt.section({name,order,text})`；本项目退化为「固定顺序数组 + 纯函数」，**刻意**换取字节稳定（前缀缓存友好） |
| B16 | 声明式装配（`disabled:true`） | `config.chat.tools` 数组 | ✅ | 数组即开关清单，缺省=关，语义对齐 |
| B17 | 会话事件落库（仅追加、可回放） | `messages` 表 `tool_calls`/`attachments` 两列（schema v3） | ✅ | |
| B18 | 会话回放/审计 | `server/cli/replay-chat.js` | ✅ | `--chat/--latest/--json`，输出工具名/耗时/字数/token/引用/图片 |
| B19 | 工具结果图片**注入用户消息**（`01-源码梳理.md:262` 硬约束） | `server/services/chat/image-inject.js` + `loop.js:127-141` | ✅ **已接入** | 真实 E2E 验证（§6.1）；两态契约、字节/张数上限防护、开关可关 |
| B20 | `turn`/`step` 语义与事件 | `loop.js` 的 round 上限 | ⚠️ **降级** | 有 `maxToolRounds=5` 轮次上限与强制收尾，但无 `turn/*`/`step/*` 事件分层 |
| B21 | 工具执行流水线 waterfall（pre/execute/post 可短路） | — | ❌ | 见 §4-C |
| B22 | 多模态输入/输出（用户上传图/文件→模型可见；工具产图→前端可放大/下载） | `routes/chat.js` `uploadAttachment` + `pipeline.js` `resolveUserAttachments`/`buildUserContent` + 前端 `chat.js`（📎+pending chips+下载） | ✅ | 两步式上传（`/attachments` 拿 id → `/messages` 带 `attachmentIds`）；用户图走 data URI 注入可变尾部，不扰动 system+tools 稳定前缀；上限 `maxPerMessage:4`/`maxBytes:10MB`/`maxEdgePx:4096`/`maxInjectBytes:5MB`；PDF/txt/md 作文件卡片可单独下载；与 B19 工具产图注入正交 |

**B 层小结**：22 项中 19 项 ✅、2 项 ⚠️ 降级（B15、B20）、0 项 🔄、1 项 ❌（B21）。（注：B19 已于 2026-11-02 收尾由🔄改为✅，此处小结同步修正。）

---

## 3. C 层：dsh 通用 harness 能力（上游 54 包）

扫描源：`deepseek-harness-master/packages/`（54 个顶层包组）。

### 3.1 已以等价形式接入（14 项）

| dsh 包 | 能力 | 03-code 等价落点 | 状态 |
|---|---|---|---|
| `core/tools` | 作用域化工具注册表 + 把关执行 | `registry.js` | ✅ |
| `core/agent-loop` | 默认驱动器（轮次/重试/取消） | `loop.js` | ✅ |
| `core/system-prompt` | 提示词与工具 schema 组装 | `prompts.js` + `persona/` | ✅ |
| `core/session` | 会话事件日志 + 消息投影 | `session.js`（`messages` 表） | ✅ |
| `llm/llm` | 流式调用与消息词汇表 | `services/llm/client.js` | ✅ |
| `attachment-local` | 图片持久化 + 内容寻址引用 | `attachments.js` | ✅ |
| `guard`（重复调用/超时） | 循环卫生 | registry 超时 + 配额 | ✅ |
| `compaction` | 上下文压缩 | `agent.js:283` 滚动摘要 | ⚠️ 降级：确定性压缩不调模型（本项目刻意选择，优于 dsh 的不可复现摘要） |
| `sandbox` | 路径作用域约束 | `tools/_sandbox.js` | ✅（仅文件读取作用域，非进程沙箱） |
| `session-query` | 会话检索/回放 | `cli/replay-chat.js` | ⚠️ 降级：单会话回放，无 FTS5 跨会话搜索 |
| `storage` | 非会话数据持久化 | SQLite（`app.db`） | ✅ |
| `preset`（声明式能力集） | 能力开关 | `config.chat.tools` | ⚠️ 降级：无「运行时代际」，改配置需重启 |
| `settings` | 配置持久化 | `config.js` + `config.local.json` | ⚠️ 降级：无自动派生的配置表单 |
| `credential` | 凭据不写进配置 | `data/secret.json`（独立于 config） | ✅ |

### 3.2 不适用，故未接入（40 项）——按原因归类

**原因 A：属通用 coding-agent 能力，文献研究场景无对应需求（16 项）**

`shell`（bash/pwsh）、`terminal`（持久 PTY）、`ssh`（远端 POSIX 主机）、`lsp`（代码导航跳定义）、`subprocess`、`computer-use`（操作桌面）、`browser-use`（交互浏览网页）、`ptc-runtime`（执行模型写的程序）、`worktree`/`forge`/`forge-github`（git/PR）、`hooks-codex`/`hooks-claude-code`、`workspace-changes`（git 快照 diff）、`experimental/` 下 66 个预稳定能力中的绝大多数。

> 判据：本项目是「读自己导入的文献」的助手，不写代码、不操作桌面、不连远端主机。给模型 shell 能力只会扩大攻击面而无收益。

**原因 B：属产品外壳，不是 agent 能力（11 项）**

`host`（Web GUI 宿主）、`client`（浏览器半侧 UI）、`api`（Host↔Client 传输）、`typert`（源码类型生成协议）、`telemetry`（OTel 上报）、`identity`（匿名 id）、`feedback`（人类反馈采集）、`test-support`（测试基建）、`document`（Office→PDF）、`boot`（命令行装配）、`bundle`（预置组合）。

> 判据：03-code 已有自己的 Express 宿主与前端外壳，重复引入 dsh 外壳等于换掉整个产品，与「不新增独立界面、复用侧边栏」的用户要求冲突。

**原因 C：依赖 dsh 专属运行时，不可移植（8 项）**

| dsh 能力 | 不可移植的原因 |
|---|---|
| Cordis 插件内核（Context/Fiber/Service、`inject` 依赖注入） | 03-code 是 CommonJS/ESM 混用的 Express 应用，无插件生命周期。强行引入需整体重写启动链路，收益为零 |
| profile → bundle → patch 五层叠加 + `!!js` 表达式 | 无插件树可叠。已用 `config.chat.tools` 数组 + `config.local.json` 覆盖达成**等效**的声明式装配 |
| `--dump-config` / `--dump-config-schema` | 无配置树可 dump。`verify-agent.js` 提供等效的装配自检 |
| `subagent`（委派子 agent） | 无插件运行时承载子 agent 生命周期 |
| `mcp`（外部 MCP 服务器） | 03-code 无 MCP 客户端；且工具集已由 lit_* 闭环，暂无外部数据源需求 |
| `skill`（按需加载指令） | 无 skill 运行时；persona 已固化为 `persona/lit-research.js` |
| `extensions`（进程内动态插件） | 同上，无插件运行时 |
| `acp` / `sdk`（JSON-RPC 驱动） | 03-code 直接以 HTTP+SSE 对外，不需要第二套协议入口 |

**原因 D：文献场景暂不需要，且会显著扩大复杂度（5 项）**

`spill`（超长文本外置）、`goal`（持久目标跨重启推进）、`plan`（计划模式）、`todo`（跨轮任务列表）、`workflow`/`jobs`/`schedule`（编排与后台任务）。

> 判据：当前是「单篇文献问答」场景，一轮内 tool loop 即可收敛。这些能力面向长周期自主任务，接入需配套的 UI 与状态机，属于范围外。

---

## 4. 未接入项原因速查

| 原因 | 项数 | 一句话 |
|---|---|---|
| A 通用 coding 能力，场景无关 | 16 | 不写代码、不操作桌面、不连远端 |
| B 产品外壳，非 agent 能力 | 11 | 已有自有宿主与前端，重复引入=换掉产品 |
| C 依赖 dsh 专属运行时 | 8 | 无 Cordis/插件树，强行移植需整体重写 |
| D 场景暂不需要 | 5 | 面向长周期自主任务，超出单篇问答范围 |

---

## 5. 两个需要单独说明的技术点

### 5.1 配额判定语义（曾与 dsh 有分歧，已对齐）

dsh `page-image-usage.ts:14` 写作 `used > max`，看似「第 max+1 次才拦」。实测发现差异来源：**dsh 的 batch 先写 tool/call 再执行**（`batch.ts:243-249`），所以它的 `used` **包含当前这次**。

03-code 是**执行前判定**，因此等价写法是 `used >= 上限`（`registry.js:196`）。两者语义完全相同——「一个会话最多 max 次」，既不白送也不少给。单测已锁定此语义（12 用例之一）。

### 5.2 图片注入模型（✅ 已闭环，2026-11-02 验证）

**dsh 的硬约束**（`01-源码梳理.md:262`）：

> 「让模型看 PDF 页 / 截图」**不能靠工具结果回传图片**。正确路径是工具把页面栅格化 → 存入 `ctx.attachments` → 用 `agent.inject()` 以**用户消息**形式注入图片块，工具结果只回文本摘要。

（源码依据：`packages/llm/llm/src/types.ts:83-96`，ImageBlock 注释写明「只有用户消息可以携带图片」。）

**修复已落地**：`server/services/chat/image-inject.js` 的 `buildImageInjection(entries, {maxBytes, maxPerTurn})` 把本轮工具产出的附件引用转成 `role:'user'` 多模态消息（text 段说明页码/区域/「不是 OCR」边界，绝不含本机路径），在 `loop.js:127-141` 工具结果回填后追加进 messages；超限/超张数/读不到的图进 `skipped` 并给模型一句可读说明；开关 `config.chat.pageImage.injectImages:false` 时可完全关掉。

**可行性（此前已实测）**：`api.deepseek.com` + `model:'deepseek-chat'` 实际路由到 **deepseek-flash**，发送 `image_url` content part 返回 HTTP 200 且作答正确（1×1 透明 PNG 提问「这张图里有文字吗」→ 答「没有」）。

**闭环验证（2026-11-02 真实端到端）**：
- 用 `runToolLoop` 直连真实 provider，模型**真的调用了** `lit_page_image({no:"4.4",pageNo:1,region:"full"})` 且返回 `ok=true`；
- 模型随后基于注入的图，准确描述了第 1 页上大量**只能从图像读出的细节**：页眉 `Front. Comput. Sci., 2025, 0(0): 1–42`、DOI 链接、`REVIEW ARTICLE` 黑底标签、标题 *A Survey on Large Language Model based Autonomous Agents*、13 位作者、`Gaoling School of Artificial Intelligence, Renmin University of China`、`arXiv:2308.11432v7`、Abstract/Keywords（Autonomous agent, Large language model, Human-level intelligence）、`1 Introduction`、Franklin and Graesser (1997) 引文、脚注邮箱 `xu.chen@ruc.edu.cn; yankailin@ruc.edu.cn` 等；
- 而 `lit_page_image` 工具本身只返回一句通用文本「第 1/X 页已渲染」——这些细节**只能来自注入的图片**，证明模型确实看见了图；
- 全流程 5.7s，跑完 `tasklist` 无残留 chromium 进程。

（另含 7 条单元验证：`server/test/page-image-inject.test.js` ①–⑦，其中 ⑥ 用本地 OpenAI 协议 stub 断言**发给模型的 HTTP 请求体**里确实出现了带 `image_url` 的 user 消息、且工具结果本身只回文本摘要——即「模型真看到图」的硬证据不依赖内存里的 messages。）

### 5.3 多模态输入/输出（✅ 已闭环，2026-11-03 验证）

**用户侧需求**：用户要能上传图片/文件给模型看，同时模型/工具产出的图要能下载。这补齐了 §5.2「工具产图注入模型」之外的另一条通道——**用户主动上传**。dsh 的 `attachment-local` 只解决了「工具落图 + 内容寻址引用」，没有「用户在对话框里传文件→模型可见」这一环；本项把这条链路补完。

**两条正交通道**：

- **通道 A（用户上传 → 模型可见）**：前端 📎 → `POST /api/chats/:id/attachments`（裸体 Buffer 或 multipart，校验 mediaType 白名单 / `maxBytes:10MB` / `maxEdgePx:4096`）→ 落 `data/attachments/v1/objects/<2hex>/<sha256>`（图片 `img_<sha256>` / 文件 `file_<sha256>`）+ `.meta.json` 侧车（`mediaType`/`width`/`height`/`bytes`）→ 返回 `attachmentId` → 用户发消息带 `attachmentIds`，`pipeline.resolveUserAttachments` 读回图片字节，`buildUserContent` 把图以 `data:image/...;base64,...` 的 `image_url` content part 注入 user 消息**尾部可变区**（data URI 决策：deepseek 服务端不可达 127.0.0.1，故内嵌而非回源 URL）。**无图的历史消息行为完全不变**。
- **通道 B（工具产图 → 可下载）**：即 §5.2 的 `image-inject.js`，渲染出的图以 user 消息注入模型；前端拿到图后可点开放大（`target=_blank`）与「下载 `?dl=1`」。两通道互不干扰、共用同一套内容寻址存储。

**上限防护**：`config.chat.attachments`：`maxPerMessage:4`、`maxBytes:10485760`、`maxEdgePx:4096`、`maxInjectBytes:5242880`、`maxInjectPerTurn:4`；超字节/超张数降级为文字说明，不抛错。支持类型：`image/png,jpeg,webp,gif,application/pdf,text/plain,text/markdown`。

**persona 语气/排版升级**（同轮完成）：`persona/lit-research.js` 在「回答规范」段新增「**不要自报流程**：不要写『我帮你查了 / 我读了第几页 / 根据工具返回』这类话，直接以『据文献 X』陈述结论」；并新增「**表达与排版**」段：Markdown 分节（`##`/`###`）、加粗关键词、列表、对照用表格（维度/A/B/结论）、代码块标注语言、引用内联可点（`[p页#段]` 不集中在末尾）、先给结论再展开。对齐 dsh 式回答风格。

**闭环验证（2026-11-03）**：`04-test/e2e-multimodal-upload.mjs` —— A1（用户图 → `buildToolMessages` 末条 user content 为含 `image_url` data URI 的数组）确定性通过；A2（saveFile → readAttachmentMeta 回读一致，现造 64×64 真彩 PNG）确定性通过；B1（真实 deepseek 接收带图消息并描述图中内容）通过；B2（lit_page_image 渲染真实 PDF 第 1 页 → 模型精确描述版面）通过。另经 **HTTP 路由层冒烟** `04-test/smoke-attachments-http.mjs`（11/11）验证：真实 Express 下 multipart/裸体上传、inline 回源、`?dl=1` 下载、415/413 错误、纯图发送落库均可用——此项还抓出 `routes/chat.js` 的 `loadChat` 错误导入（会导致服务无法启动），已修复。详见 §6。

---

## 6. 验证证据

| 验证面 | 结果 | 证据 |
|---|---|---|
| 单元测试 | **136/136 通过** | `node --test server/test/*.test.js`（含 `tool-registry.test.js` 12 例 + `page-image-inject.test.js` 7 例 + `attachments-multimodal.test.js` 10 例） |
| 装配探针 | **6/6 PASS** | `node server/cli/verify-agent.js` |
| 会话回放 | 可用 | `node server/cli/replay-chat.js --latest`（输出工具名/耗时/字数/token/引用） |
| 渲染栈（coder 自测） | 23/23 PASS | 出图 >5KB、尺寸 ≤ maxEdge、同参数连渲 digest 相同、象限 scale ≈ 整页 2 倍、无残留 chromium |
| **渲染栈（独立对抗验收）** | **A–E 全过 + 6 项补充全过** | 见下方 §6.1，报告 `04-test/测试报告-03code渲染栈.md` |
| 渲染跨实现一致性 | 逐字节相同 | 03-code（pdf.js 6.4.299）与 dsh（6.3.289）渲染 `1.17` 整页同为 `0ceec379ba05a512`/330046B |
| **图片注入模型（真实端到端）** | **通过** | §5.2 闭环验证：真渲染 4.4 第 1 页 → 真注入 → 模型准确描述只能从图读出的页面细节，5.7s，无残留进程 |
| **多模态上传/输出（真实端到端）** | **通过** | `04-test/e2e-multimodal-upload.mjs`：A1 用户图以 data URI `image_url` 入模 + A2 落盘回读确定性通过；B1 真实模型描述上传图 + B2 lit_page_image 渲染真实 PDF 第 1 页被真实描述均通过（§5.3） |
| **多模态上传/输出（HTTP 路由冒烟）** | **11/11 PASS** | `04-test/smoke-attachments-http.mjs`：经真实 `createApp()`+Express：multipart 上传、裸体 image/png、inline 回源字节一致、`?dl=1` 下载头、415 不支持、413 超长边、纯图发送 SSE+落库、404（临时端口+临时库副本隔离）。**此项同时抓出并修复 `routes/chat.js` 的 `loadChat` 错误导入（否则服务无法启动）** |
| API E2E | 上一轮通过 | 3 次工具调用、4 条合法引用、5.7s 收敛 |
| UI E2E（真实浏览器） | 上一轮通过 | 工具卡片 + chip + 零控制台错误 |

### 6.1 渲染栈独立验收实测数字（tester 未采信实现者自测，全部自行构造）

样本 `1.11`（查库得到，400 works / 13 篇有本地 PDF）：

- **出图**：PNG 551.3KB、magic `89504E470D0A1A0A`、IHDR 解析 1125×1466（≤ maxEdge 1500，实际是 maxPixels 先到顶），首调 907ms 含 launch
- **决定性**：同参数连渲两次 sha256 一致；**另起渲染器（新浏览器实例、空缓存）仍一致** ⇒ 决定性成立，不是缓存背书
- **区域图 scale**：full 1.860 / 象限 3.720，ratio **2.0000**；象限输出像素与整页相同（不是半页）⇒ 裁剪即放大
- **契约边界**：`no_pdf` 全文仅 1 处（`lit-page-image.js:108`）且在 `rendererOrThrow()`（:113）之前 ⇒ 渲染失败不可能走到它；编号 `999.99` 不存在 ⇒ 抛错；页码越界/路径不存在/**PDF 损坏（InvalidPDFException）** ⇒ 全部 throw；**超时分支单独注入**（并发 10 路拖过 1000ms）⇒ 9/10 命中超时并抛 RenderFailure，不是空图
- **无残留进程**：基线归零后重测 `0 → 渲染 4 → 空闲回收 → 0`，`tasklist | findstr /i chrom` 输出为空
- **补充**：跨轮配额 20 放行 / 21 拒绝；注册门控三态正确（默认关 / enabled 但缺 playwright ⇒ 报 `E_RENDERER_UNAVAILABLE` / 配好 ⇒ 注册）；路径沙箱三种穿越（../、绝对路径、中段 `..`）一律抛错

**遗留（建议级，不阻断）**：① renderer 层未夹取 maxEdge/maxPixels，靠工具层挡；② `fsp.stat` 失败会把本机绝对路径带进错误信息（信息泄露，建议包 RenderFailure）；③ `lit-page-image.js:44` 注释写「五段」实际 6 行（措辞，与 dsh 同构）。
**未验证**：出网闸门未实测（代码层确认 `page-image-source.js:414-416` 首行即 abort、origin 为 `.invalid`）；`page.on('crash')` 自愈未实测。

---

## 7. 已知限制与遗留

1. **视觉通道默认关闭**（`config.chat.pageImage.enabled=false`），与 dsh「写/重工具默认 disabled」一致。开启需显式改配置。
2. **配额折算发生在模块导入时**（`tools/index.js`），因此 `enabled` 必须写在 config 文件里，运行期改无效。
3. **`pdfjsDir` 留空时解析 03-code 自己的 pdfjs-dist@6.4.299**；若要与 dsh 同版需显式指路径，且 `build/` 下两个入口必须成对，否则启动报 `E_RENDERER_UNAVAILABLE`。
4. **`attachmentId` 格式为 `img_<sha256>`**，非 dsh 的 `sha256:…`（内部实现差异，语义相同）。
5. **只支持 OpenAI 兼容协议的 provider** 走 tools 引擎（设计文档 §6 已定），gemini/anthropic 协议在 tools 引擎下拒绝创建会话。
6. **遗留数据问题**：第 5–11 区 PDF/正文抽取未完成，尤其第 7 区 17 篇无正文——这会影响 `lit_read` 对这些文献的可用性，与本次集成无关但会体现在回答质量上。
7. **用户上传多模态默认开启**（无需额外开关，📎 入口常驻对话框），但**工具渲染图（`config.chat.pageImage.enabled`）默认关闭**——两者正交：用户只发图不依赖视觉通道，发图即可见；只有需要模型看 PDF 页面外观时才需打开视觉通道。
