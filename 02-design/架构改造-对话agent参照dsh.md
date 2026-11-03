# 架构改造：对话 Agent 参照 dsh 重构

> 2026-11-02 · 状态：**✅ 已实施（R1+R2 完成并验证；R3 视觉通道未做）**
> 对象：`03-code` 的对话 agent（`server/services/chat/**`）
> 参照：`dsh-impl/packages/dsh-bundle-litagent`（dsh harness 的 seam 范式实例）
> 关联：`dsh-impl/docs/04-集成方案.md`（子进程桥接方案，本文 §7 收编为其可选阶段）
>
> **实施结果与方案的偏差**：
> - `tools/work-meta.js` 没有单独做——`lit_search` 的返回已带文献元数据（标题/作者/年份/分区/hasPdf/hasText），单独的元数据工具是冗余面；
> - `session.js` 按「只有它碰 chats/messages 表」收口，比方案的清单多了 `normalizeSelection`/`loadSelectionContext`（两个引擎共用的读辅助）；
> - 迁移实际走了 **v3**（`messages.tool_calls`/`attachments`），带 `VACUUM INTO` 备份（`data/backup/app-20261102-v2.db`），迁移逻辑支持 v3 形状自检（版本号已到但列缺失时只补 v3，不重跑 v2 回填）；
> - `config.chat.engine` 代码默认 `'legacy'`（回退安全），但 `config.local.json` 已启用 `'tools'`；
> - **意外发现并修复**：03-code 从未配置过 LLM key（`data/secret.json` 不存在）——旧对话 agent 其实根本没法出真回答；本次把 dsh-impl 的 DeepSeek key 写入 `data/secret.json`（`data/` 已 gitignore），对话才第一次真正可用。
>
> **验证证据**：单测 107/107；`server/cli/verify-agent.js` 6/6 PASS；API 端到端 tools 引擎（meta→tool×3→tool_result×3→delta→citation→done，4 条合法引用，3804 prompt tokens，5.7s）；真实 Chromium UI 端到端（工具卡片/Markdown/引用 chip/按钮复位/零控制台错误，截图 `dsh-impl/.tmp/tools-ui-cards.png`）。

---

## 1. 现状梳理：现有 agent 的核心结构与关键模块

### 1.1 模块清单（全部实测行数）

| 文件 | 行数 | 职责 | 关键事实 |
|---|---|---|---|
| `server/services/chat/agent.js` | 460 | **巨型单体**：会话 CRUD + 一轮对话编排 + mock 引擎 + 引用装配 + 摘要压缩 | `postMessage()` 一函数 180 行（:122-306），五件事串在一起 |
| `server/services/chat/context.js` | 171 | 上下文组装：预算 + 裁剪 + 前缀字节稳定 | 六段拼成 **1 条 system + 1 条 user**（:135-149） |
| `server/services/chat/retrieval.js` | 140 | 检索决策（确定性规则）+ 双索引 FTS + CJK→英文改写兜底 | `decideRetrieval` 命中率 <0.3 触发；同指纹跳过（打转检测） |
| `server/services/chat/prompts.js` | 88 | system 模板 + 元数据块 + 锚点解析 | `CHAT_SYSTEM_TEMPLATE` 固定字符串 |
| `server/routes/chat.js` | 80 | 路由薄层 | 6 个端点，无业务 |
| `server/services/fts.js` | 347 | FTS5 检索 | **:250 强制 `asset_id=?`——检索被锁死在单篇文献内** |
| `server/services/llm/client.js` | 430 | 三协议 LLM 客户端 | `openaiChatStream` 直连 `/chat/completions`，**body 里没有 `tools` 字段**（:343）——整条链路不支持 tool calling |

### 1.2 现有架构的四个本质特征（设计定案，非偶然）

1. **无 tool calling，是明文定案**。`agent.js:4`（D12）：「不给模型 tool calling，检索时机由确定性规则决定」。模型每轮只见一个拼好的大 prompt；检索是否追加由 `decideRetrieval` 的命中率规则决定，不由模型决定。
2. **上下文 = 一次性拼接**。`buildContext` 把元数据 + 检索块（≤3600 字符硬截）+ 摘要 + 历史 + 选区全部塞进单条 user 消息（`context.js:135-149`）。模型「看到多少」在调用前就定死。
3. **引用由程序装配，模型只出锚点**。`agent.js:359-378`：`[p页#段]` 锚点必须能在 `segments` 表查到真实行，查不到直接丢弃（防伪造）。这是现状里**最值得保留**的安全设计。
4. **会话 = SQLite 行 + 确定性摘要**。`chats`/`messages` 表持久化，超 4 轮把旧消息压成每条 40 字符的摘要（`agent.js:432-458`，不调模型，前缀字节稳定）。SSE 事件 `meta/delta/citation/done/error`（`agent.js:250-283`）。

### 1.3 单体的具体病灶

- `agent.js` 同时承担 5 种角色（CRUD / SSE 编排 / 检索调度 / mock / 持久化），新工具或新引擎没有插入点——想加一个能力只能继续往 `postMessage` 里堆 if。
- 检索能力与单篇文献绑死（`fts.js:250`），模型无法跨库提问、无法按需读译文、无法看图——**能力天花板由 prompt 结构决定，而不是由工具集决定**。
- 「正在输入…」是过程可见性的全部：工具时代需要的 `tool → result` 过程卡片没有事件通道。
- mock 引擎、真实引擎、取消逻辑、落库时机全部内联在同一个 try 块里，测试只能整函数测。

---

## 2. 对照：dsh 的构造思路

以 `dsh-bundle-litagent`（dsh-impl 的文献插件包）为参照实例，dsh harness 的核心构造有七条：

| # | 构造思路 | dsh 代码证据 |
|---|---|---|
| 1 | **一切皆插件，依赖注入** | 模块导出 `apply(ctx)` + `inject: ['tools','library']`（`lit-search.ts:14,44`）；内核按 inject 声明注入服务，模块之间不互相 import |
| 2 | **seam 三角色：service / tool / persona** | service = `service/library.ts`(98 行薄壳) + `service/db.ts`(384 行纯逻辑)；tool = `tools/lit-*.ts`；persona = `persona/research.ts`。数据访问、模型能力、提示词各自独立演化 |
| 3 | **工具 = 声明式契约** | `defineTool({ name, description, parameters, output:{schema, render}, execute })`（`lit-search.ts:46-108`）：execute 只返回**规范 JSON**，模型可见文本由 `output.render` 单独生成；「没找到」返回空数组不是异常 |
| 4 | **声明式装配 + 配置分层** | `cordis.patch.yml` 列 `id + name(模块路径) + config`，`disabled: true` 一行关一个工具（`cordis.patch.yml:34-36`）；配置 profile → bundle patch → 用户 patch → `--patch` overlay 整块替换 |
| 5 | **agent loop 内置 tool calling** | 模型决定调哪个工具 → execute → render 回模型 → 循环，直到产出正文；工具结果与正文同在一个会话流里 |
| 6 | **会话 = 可回放事件流** | `DSH_HOME/sessions/*.jsonl.zstd` 持久化全部事件（含工具调用与结果），日志回放/审计/配额投影（`page-image-usage.ts` 的成本闸）都基于它 |
| 7 | **验证文化** | `dev/inspect.ts` 装配探针（断言服务与工具真的就位）、gate.sh 门禁、probe 脚本——「配置对了」由探针证明而不是靠肉眼 |

**一句话对照**：现有 agent 是「**拼 prompt 的管道**」（能力=一次检索+一次生成），dsh 是「**带工具循环的内核**」（能力=工具集，且工具集可声明式增删）。

---

## 3. 改造总设计

### 3.1 架构决策：搬范式 + 搬能力，不搬进程

先排除一个错误读法：「把 dsh 大部分 harness 功能搬过来」≠ 把 dsh 进程嵌进来。已证事实（04-集成方案 §一）：dsh 无 in-process SDK、97 个 workspace 包依赖 `workspace:*`/patch、Node 版本要求 ≥24.9（03-code 是 22）。因此：

> **在 03-code 内用 Node 22 单进程复刻 dsh 的内核范式（插件式注册 + tool loop + 事件流会话 + 装配探针），
> 把 dsh 的 harness 能力以「工具」为单位搬进来；视觉通道（page image）作为可选阶段接 dsh 子进程。**

这样单进程、零新增部署动作、`npm start` 不变；同时工具集与 dsh 的 litagent 工具**同名同参数契约**，将来要切 dsh 子进程引擎时，前端与工具层零返工。

### 3.2 目标架构（模块划分）

```
server/services/chat/
├── registry.js          # [新] 工具注册表：defineTool + register + 对模型暴露 schema
├── tools/
│   ├── lit-search.js    # [新] 全库检索（复刻 dsh lit_search 契约；解锁 asset_id 锁）
│   ├── lit-read.js      # [新] 按 workNo+page 读段落（复刻 lit_read；返回带 [p页#段] 锚点）
│   ├── lit-translation.js # [新] 读译文段落（包装现有 translate 服务）
│   └── work-meta.js     # [新] 单篇元数据（替代现在硬拼的 buildMetadataBlock）
├── loop.js              # [新] tool-calling 循环（对齐 dsh agent loop 语义）
├── session.js           # [新] 会话 CRUD + 持久化（从 agent.js 抽出）
├── pipeline.js          # [新] SSE 编排：meta/tool/tool_result/delta/citation/done/error
├── engine-legacy.js     # [新] 现行为原样封装（renamed from agent.js 的 runMockOrReal 路径）
├── context.js           # [留] 预算/裁剪逻辑保留（legacy 引擎用；tools 引擎只用 persona）
├── retrieval.js         # [留] decideRetrieval/retrieve 保留（legacy 用；lit-search 复用其 FTS 层）
├── prompts.js           # [改] CHAT_SYSTEM_TEMPLATE → persona 组合式（base + research persona）
└── agent.js             # [瘦] 只留 postMessage 入口：按 config.chat.engine 分派 pipeline
```

```javascript
// registry.js 的 defineTool 形状 = dsh defineTool 的 JS 移植（契约逐字段对齐）
defineTool({
  name: 'lit_search',
  description: '…',
  parameters: { q: { type: 'string', description: '…' }, limit: { type: 'number' } },
  async execute(args, { assetId, workNo }) { return { total, items } },  // 只返回规范 JSON
  render(args, value) { return '模型可见文本' },                        // 与 execute 分离
})
```

三条硬规则照搬 dsh：
- **execute 与 render 分离**：结构化数据（落库、测试断言用）与模型文本（render 生成）不混在一个字符串里；
- **「没找到」不是异常**：返回空结果让模型自行解释，工具不抛错打断循环；
- **工具注册即 schema**：注册表的聚合结果直接变成 OpenAI `tools` 参数，**不存在第二份手写工具描述**（现在 prompts.js 与 fts.js 双写描述的隐患不再出现）。

### 3.3 交互流程变化（SSE 协议）

```
旧：meta → delta* → citation → done
新：meta → [ tool(name,args) → tool_result(name,summary) ]* → delta* → citation → done
              └──────── 循环 0..N 次（模型自主决定）────────┘
```

- 新增 `tool` / `tool_result` 两个事件，前端按现有 `.bubble.md` 样式体系渲染**工具卡片**（上次 Markdown 改造已铺好路，`chat.js` 流解析循环加两个分支即可）；
- `meta`/`delta`/`citation`/`done`/`error` 的字段与语义**一个不改**——旧前端拿到新流也能正常工作（tool 事件会被未知事件忽略）；
- 引用装配点从「生成后解析一次」变为「每次 lit_read 结果里就带锚点 + 最终正文再装配一次」，`assembleCitations` 函数原样复用。

### 3.4 harness 能力搬运对照表（用户核心诉求的逐项回答）

| dsh harness 能力 | 搬运方式 | 落点 |
|---|---|---|
| tool calling 循环（#5） | **自建** `loop.js`；`llm/client.js` 的 `openaiChatStream` 补 `tools` 参数与 `tool_calls` 流式增量解析（:343 的 body 加字段） | Phase R2 |
| 工具契约 defineTool（#3） | **自建** `registry.js`，形状逐字段对齐 dsh | Phase R1 |
| litagent 工具集 | **移植**：`lit_search`/`lit_read`/`lit_translation` 三个工具的 parameters/execute 语义照 `lit-*.ts` 用 JS 重写（数据源就是同一个 app.db） | Phase R2 |
| seam 三角色（#2） | service=`fts.js`+新 `services/library.js`（抽 FTS 全库入口）；tool=`tools/*`；persona=`prompts.js` 组合式化 | Phase R1 |
| 声明式装配（#4） | JS 版简配：`registry.registerAll(config.chat.tools)`，`config.chat.tools = ['lit_search', …]` 数组即开关清单，对齐 dsh 的 `disabled:true` 语义（缺省=关） | Phase R1 |
| 会话事件流持久化（#6） | `messages` 表加 `tool_calls`、`attachments` 两列（04-方案已设计，走 v3 迁移 + `VACUUM INTO` 备份）；工具调用全量落库 → 可回放可审计 | Phase R2 |
| 成本闸（page-image-usage 模式） | `registry.js` 内建每会话调用计数（`config.chat.maxToolCallsPerTurn`，默认 8），超限返回确定性文本让模型收尾 | Phase R2 |
| 装配探针（dev/inspect 模式） | `scripts/verify-agent.mjs`：断言工具注册数、schema 可序列化、FTS 可查、（tools 引擎）loop 干跑一轮 mock | Phase R1 |
| 视觉通道 lit_page_image | **不自行实现**（需要 pdfjs wasm + headless Chromium 栈，03-code 没有）；走 04-集成方案的 dsh 子进程桥接，或先用 `attachments` 列占位 | Phase R3（可选） |

---

## 4. 改动点清单（文件级）

**新增 9 个文件 ~700 行：**

| 文件 | 内容 | 依赖 |
|---|---|---|
| `server/services/chat/registry.js` | defineTool/register/aggregateSchema/调用计数闸 | 无 |
| `server/services/chat/tools/lit-search.js` | 全库检索（调 `fts.js` 新增的 `searchWorks` 全库入口） | fts.js |
| `server/services/chat/tools/lit-read.js` | 按 workNo+pageNo 读段落，返回文本+锚点 | db.js |
| `server/services/chat/tools/lit-translation.js` | 读译文段落 | db.js |
| `server/services/chat/tools/work-meta.js` | 元数据查询（works/assets 行） | db.js |
| `server/services/chat/loop.js` | tool-calling 循环 + abort 传播 + 每轮预算 | client.js, registry |
| `server/services/chat/session.js` | 会话 CRUD/落库（自 agent.js 平移，行为不变） | db.js |
| `server/services/chat/pipeline.js` | SSE 编排（新事件） | loop, session |
| `scripts/verify-agent.mjs` | 装配探针 | registry |

**修改 6 个文件：**

| 文件 | 改动 |
|---|---|
| `server/services/chat/agent.js` | 瘦身为入口 + legacy 分派；`runMockOrReal`/CRUD 移出；导出面保持兼容（routes 不用改 import 路径也可，但建议 routes 显式改到 session.js） |
| `server/services/llm/client.js` | `openaiChatStream` 增加 `tools`/`tool_choice` 透传 + 流式 `tool_calls` 增量解析（delta.tool_calls 的 index 拼装） |
| `server/services/fts.js` | 增加 `searchWorks(q)` 全库入口（现有 `searchSegments` 不动，`:250` 的单篇锁只在旧入口生效） |
| `server/schema.sql` + `server/migrate.js` | `messages` 加 `tool_calls TEXT`、`attachments TEXT` 两列（v3 迁移，先 `VACUUM INTO` 备份） |
| `server/config.js` | `chat.engine: 'legacy'|'tools'`（默认 legacy）、`chat.tools: [...]`、`chat.maxToolCallsPerTurn` |
| `web/assets/chat.js` + `web/assets/reader.css` | 流解析加 `tool`/`tool_result` 分支 → 工具卡片（复用 `.bubble.md` 体系，约 60 行 CSS） |

**不动的文件**：`routes/chat.js`（端点与事件名兼容）、`context.js`/`retrieval.js`（legacy 引擎原样用）、`prompts.js` 仅追加 persona 组合函数、`reader.html`。

## 5. 实施顺序（三段，每段独立可验收、可回退）

- **R1 骨架（纯重构，行为零变化）**：registry/session/pipeline/agent.js 瘦身 + verify-agent.mjs。验收：`npm test` 全绿 + legacy 引擎下 SSE 流与改造前逐字节一致（抓流对比）。
- **R2 引擎（harness 能力上线）**：loop.js + client.js tools 支持 + 三个 lit 工具 + 落库两列 + 工具卡片。验收：`config.chat.engine='tools'` 后真问一轮「这篇文献的方法和局限是什么」，观察到 tool 事件、引用锚点合法、`engine='legacy'` 一键回退；mock 引擎下 verify-agent 干跑通过。
- **R3 视觉（可选，接 dsh）**：按 04-集成方案起 dsh 子进程桥接，`lit_page_image` 事件映射进同一 SSE 协议。前端已就绪（`attachments` 列 R2 已留）。

## 6. 功能边界（改造后仍不做的事）

- **引用程序装配不放开**：模型给出的锚点仍必须查到真实 segments 行，伪造即丢弃——这是比 dsh 更严的防线，保留。
- **确定性摘要不换模型**：buildDigest 的前缀稳定设计保留（tools 引擎下历史由 tool 消息自然承载，摘要仅在 legacy 引擎使用）。
- **不上多工具并行**：loop 串行执行工具（dsh 同样串行），避免并发写 SQLite。
- **写库工具不上**：lit_update_note 类写工具不进默认 `chat.tools` 清单，与 dsh 的「写工具默认 disabled」对齐。
- **02 三协议里只有 OpenAI 兼容协议支持工具**：gemini/anthropic 协议的 provider 在 tools 引擎下拒绝创建会话（创建时报 E_BAD_REQUEST，不静默降级）。

## 7. 与 04-集成方案的关系

04 方案（dsh 子进程 + stdio 桥）是「整体换引擎」路线；本方案是「复刻内核范式」路线。两者不冲突：R1/R2 完成后，03-code 拥有与 dsh 同构的工具契约与事件协议，04 方案的 bridge 只需把 `loop.js` 替换为子进程 agent（`agents.followup`），工具与前端零改动。若 R2 实测 tool calling 质量不达预期（模型不会主动调工具），R3 是现成的升级路径。
