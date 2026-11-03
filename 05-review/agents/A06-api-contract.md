# A06 · HTTP 路由层与 API 契约

评审对象：`03-code/server/routes/` 全部 11 个文件 + 其直接依赖的 service 出口（artworks / downloader / translate.pipeline / layout.job / chat.agent / chat.session / settings / errors / validate / app.js / db.js）。
方法：逐文件读代码 + 在已运行的 7317 实例上做只读 curl（GET/DELETE 到不存在端点）验证，真实输出见文末「动态验证记录」。
口径：与 `05-review/_context.md` 一致（severity 按「现在会造成什么后果」判，effort：S≤半天单文件 / M 1–2 天 / L 3–5 天 / XL >1 周）。

## 结论

1. 路由分层总体是干净的：works/segments/translate/download/jobs 多数端点走 `parseInput` + `throw AppError`，错误信封由 `errorMiddleware` 统一产出，`E_*` 码与 `errors.js` 的 21 个码一致（未发现拼错或裸字符串成为唯一出口的情况）。
2. 真正的破口集中在**两类**：一是「状态机与并发」——`cancelJob` 的 UPDATE 没有状态守卫、且会清扫整个 `.tmp` 目录的 `*.part`（会误删另一个并发下载的在途文件）；二是「长连接终态」——translate 的 SSE 在**全部批次失败时仍发 `done`**（前端弹「翻译完成」绿 toast），且服务端**从不 `res.end()`**。
3. 四处「同族端点行为分裂」值得一并修：`/assets/:id/file` 文件丢失时手搓 `410` 却配 `code: E_NOT_FOUND`、layout 任务端点对不存在 id 返回 `200 unknown`/幽灵 SSE、`/works/:no/search` 不做 `no` 正则校验（404 而非 400）、以及**请求体超限统一落成 `500 E_INTERNAL` 而不是 `413 E_TOO_LARGE`**（实测，`toAppError` 不认 body-parser 的 `entity.too.large`）。
4. 契约漂移是**字段名与口径级**而非结构级：`WorkDetail` 文档写 `job` 实现返回 `downloadJob`；search 文档 `{query,topK:24,degraded:boolean}` 实现 `{q,topK:20,degraded:null}`；extract 文档 202 实现 200（STATUS.md 已承认）。
5. 文档里承诺但未实现的 `DELETE /api/assets/:id` 与 `downloadDir?mode=migrate` 都**没有前端入口**（web 全量 grep 无 DELETE 调用），所以不存在「点了没反应」的假按钮；风险只对按文档写代码的 API 消费者成立。

---

## 一、端点 × 输入校验 × 状态码 × 错误码 × 副作用（11 个路由文件）

说明：「校验」列写实际生效的机制；「错误码」只列该端点自身会产出的码（未走 `validate.js` 的标 `手写`）。

| 文件 | 端点（行号） | 校验 | 状态码 | 错误码 | 副作用 |
|---|---|---|---|---|---|
| health.js | `GET /health`（12） | 无参 | 200 | — | 无（`isDirWritable` 只做 `accessSync(W_OK)`） |
| works.js | `GET /sections`（29） | 无参 | 200 | — | 无 |
| works.js | `GET /works`（33） | `validate` L11-24（13 个键，page≤100000、pageSize≤200） | 200/400 | E_BAD_REQUEST | 无（2 条查询：COUNT + 页） |
| works.js | `GET /works/lookup`（43） | 手写：`typeof string` + `length>200` | 200/400 | E_BAD_REQUEST | 无 |
| works.js | `GET /works/:no`（59） | `assertNo`（WORK_NO_PATTERN） | 200/400/404 | E_BAD_REQUEST/E_NOT_FOUND | 无 |
| works.js | `PATCH /works/:no`（68） | `assertNo` + 字段白名单（11 个）+ 服务层逐字段校验 | 200/400/404 | E_BAD_REQUEST/E_NOT_FOUND | **写** works（单 tx）+ `fields_locked` + `origin='local'` |
| works.js | `GET /works/:no/doi-jump`（84） | `assertNo` | 200/400/404 | E_BAD_REQUEST/E_NOT_FOUND | 无 |
| download.js | `POST /works/:no/download`（13） | `assertNo` + `source∈auto/arxiv/link` | 200/202/400/404 | E_BAD_REQUEST/E_NOT_FOUND | **写** download_jobs + 入队 |
| jobs.js | `GET /jobs/download`（13） | `validate`（status 8 值 / limit 1-200） | 200/400 | E_BAD_REQUEST | 无 |
| jobs.js | `GET /jobs/download/:id`（28） | 无（`Number()`） | 200/404 | E_NOT_FOUND（文案含 `NaN`） | 无 |
| jobs.js | `POST /jobs/download/:id/retry`（36） | 无 | 202/404/409 | E_NOT_FOUND/E_CONFLICT | **写** status→queued + 入队 |
| jobs.js | `POST /jobs/download/:id/cancel`（44） | 无 | 200/404 | E_NOT_FOUND | **写** status→canceled + **删全目录 .part** |
| assets.js | `GET /assets/:id/file`（93） | 无整数校验（`Number`） | 200/206/404/410/416 | E_NOT_FOUND（410 处手写 JSON） | **写** `assets.file_state='missing'` |
| assets.js | `POST /assets/:id/reveal`（153） | 无整数校验 | 200/404 | E_NOT_FOUND | 起资源管理器（无 DB 写） |
| assets.js | `POST /works/:no/asset`（171） | `assertNo` + 大小 + multipart 手写解析 + `force` 走 **query** | 201/200/400/404/409/413/422/403 | E_BAD_REQUEST/E_NOT_FOUND/E_CONFLICT/E_TOO_LARGE/E_NOT_PDF/E_PATH_OUT_OF_SCOPE | **写盘** + assets + 可能 `extract_version+1` |
| assets.js | `POST /assets/scan-inbox`（281） | 无 | 200 | E_PATH_OUT_OF_SCOPE | 扫描 + 可能移动文件（见盲区） |
| assets.js | `POST /assets/import-from-inbox`（290） | 手写：no 正则 + 文件名不含 `..` `/` `\` | 201/400/403/404/409 | E_BAD_REQUEST/E_PATH_OUT_OF_SCOPE/E_NOT_FOUND/E_CONFLICT | **复制文件** + 写 assets |
| settings.js | `GET /settings`（38） | 无参 | 200 | — | 无（密钥已掩码） |
| settings.js | `PUT /settings`（42） | 拍平 + `FORBIDDEN_KEYS`/`isSettableKey` → `ignored[]` | 200/400 | E_BAD_REQUEST | **写** settings 行（部分键静默忽略） |
| settings.js | `PUT /settings/secret`（75） | 手写类型判断 | 200/400 | E_BAD_REQUEST | **写** secrets 文件（明文密钥，只写不读） |
| settings.js | `PUT /settings/downloadDir`（111） | 手写：绝对路径 + mode | 200/400/409（+潜在 500） | E_BAD_REQUEST/E_CONFLICT | **mkdir + 写配置 + resync 改 assets.file_state** |
| settings.js | `POST /storage/resync`（143） | `Boolean(body.deep)` | 200 | — | **写** assets.file_state |
| settings.js | `GET /stats`（152） | 无参 | 200 | — | 无 |
| import.js | `POST /import`（11） | `mode∈dry-run/merge` | 200/400 | E_BAD_REQUEST | merge 时**写** works（dry-run 无） |
| segments.js | `POST /assets/:id/extract`（23） | `Number.isInteger` 整数校验 | 200/400/404/422/500 | E_BAD_REQUEST/E_NOT_FOUND/E_NEEDS_OCR/E_EXTRACT_FAILED | **写** segments + `extract_status` |
| segments.js | `GET /works/:no/segments`（36） | `assertNo` + `validate`（page/from/to/withTranslation/engine/tgtLang） | 200/400/404 | E_BAD_REQUEST/E_NOT_FOUND | 无 |
| segments.js | `GET /works/:no/search`（85） | **手写**：q 必填、topK 仅上限 | 200/400/404 | E_BAD_REQUEST/E_NOT_FOUND | 无（检索可能触发改写的 LLM 调用） |
| translate.js | `GET /translate/engines`（21） | 无参 | 200 | — | 无 |
| translate.js | `POST /translate/test`（25） | **无校验**（engine/tgtLang/sample 直传） | 200/400/502 | E_BAD_REQUEST/E_UPSTREAM/E_LLM_KEY_MISSING | **外部请求（计费）** |
| translate.js | `POST /translate/preview`（35） | pipeline 内校验 text≤2000 | 200/400/502 | E_BAD_REQUEST/E_UPSTREAM/E_LLM_KEY_MISSING | **外部请求（计费）** |
| translate.js | `POST /works/:no/translate`（44） | `assertNo` + scope/pages 数组（**未校验元素**） | 202/200/400/404/409/422/500 | E_BAD_REQUEST/E_NOT_FOUND/E_CONFLICT/E_EXTRACT_FAILED/E_NEEDS_OCR/E_ENGINE_UNCONFIGURED | **写** translate_jobs + 后台跑 |
| translate.js | `GET /jobs/translate/:id`（72） | 无 | 200/404 | E_NOT_FOUND | 无（进度重算为 N+1 查询） |
| translate.js | `GET /jobs/translate/:id/events`（80） | 无 | 200(SSE)/404 | E_NOT_FOUND | 建 runner + 15s 心跳 |
| translate.js | `POST /jobs/translate/:id/cancel`（88） | 无 | 200/404 | E_NOT_FOUND | **写** status→paused（有守卫） |
| translate.js | `GET /works/:no/translation/export`（96） | 手写 `bilingual` | 200/404 | E_NOT_FOUND | 无 |
| layout.js | `POST /works/:no/layout`（16） | `assertNo`；`maxPages` 无非数字校验 | 202/400/404 | E_BAD_REQUEST/E_NOT_FOUND | 建**内存** runner（不落 DB） |
| layout.js | `GET /jobs/layout/:id`（34） | 无 | **200 恒** | —（永不 404） | 无 |
| layout.js | `GET /jobs/layout/:id/events`（42） | 无 | **200 恒** | — | 为任意 id 建幽灵 runner + 心跳 |
| layout.js | `POST /jobs/layout/:id/cancel`（50） | 无 | **200 恒** | — | 改内存状态 |
| chat.js | `POST /chats`（102） | 手写 workNo 必填 | 201/400/404 | E_BAD_REQUEST/E_NOT_FOUND | **写** chats |
| chat.js | `GET /chats`（112） | `String(workNo)` | 200 | — | 无 |
| chat.js | `GET /chats/:id/messages`（120） | **未走 validate**：`Number(limit) \|\| 50` | 200/404 | E_NOT_FOUND | 无 |
| chat.js | `POST /chats/:id/messages`（133） | 引擎内部校验 content | 200(SSE)/400/404 | E_BAD_REQUEST/E_NOT_FOUND/E_LLM_KEY_MISSING/E_UPSTREAM | **写** messages + **外部 LLM 调用** |
| chat.js | `POST /chats/:id/messages/:mid/cancel`（137） | 无（`mid` 未使用） | 200/404 | E_NOT_FOUND | 中止当前轮 + 落 partial |
| chat.js | `POST /messages/:id/feedback`（145） | 服务层校验 `-1/0/1` | 200/400/404 | E_BAD_REQUEST/E_NOT_FOUND | **写** messages.feedback |
| chat.js | `POST /chats/:id/attachments`（156） | 手写 multipart + 魔数嗅探 + 长边≤4096 | 201/400/404/413/415 | E_BAD_REQUEST/E_NOT_FOUND/E_TOO_LARGE/E_UNSUPPORTED | **落盘**（内容寻址）+ 返回引用 |
| chat.js | `GET /chats/:id/attachments/:attId`（167） | 无 | 200/404 | E_NOT_FOUND | 无 |
| chat.js | `DELETE /chats/:id`（188） | 无 | 200/404 | E_NOT_FOUND | **删** chats（messages 级联） |

> **注（body 超限）**：`E_TOO_LARGE`(413) 只在 body 已被解析、handler 内做大小检查时才产出。若 body 超过 `express.json` 的 `1mb` 或 `express.raw` 的 `maxBytes + 8MiB`，抛错的是 body-parser（`entity.too.large`，`status: 413`），`toAppError` 只认 `ERROR_CODES` 里的 code，于是变成 **500 `E_INTERNAL`**（实测，见 finding 3 与动态验证 16）。表里的 413 是 handler 路径的期望值，不是超限 body 的实际出口。

**Q1 归纳**：没走 `validate.js` 的参数集中在 6 处——`/works/lookup`（手写但完整）、`/works/:no/search`（手写且无下限）、`/chats/:id/messages`（手写且无钳制下限）、`/assets/*`（`:id` 完全无整数校验）、`/translate/test|preview`、`/settings/*`（手写）。「该 4xx 却返回 500」有两条路径：① **body 超限 → 500 `E_INTERNAL`（实测）**，② `PUT /settings/downloadDir` 的 `mkdirSync` 抛原生 `EEXIST/EPERM`，`toAppError` 同样归成 `E_INTERNAL`（见 finding 10）。「错误码与 errors.js 对不上」的不是拼写，而是**语义与状态码**：`assets.js:114` 用 `E_NOT_FOUND` 配 `410`（见 finding 4），以及 layout 三个端点**不产出任何错误码**（见 finding 6）。

---

## 二、路由注册顺序与路径遮蔽

**works：lookup 必须在前，当前正确。**
`works.js:42-57` 先注册 `/works/lookup`，注释写明理由；`/works/:no`（59）在后。若把两者顺序调换，`lookup` 会命中 `:no` 分支被 `assertNo` 拦下：

```js
// works.js:99-103
function assertNo(no) {
  if (!WORK_NO_PATTERN.test(String(no || ''))) {
    throw new AppError('E_BAD_REQUEST', `编号格式不合法（应为 "段号.序号"）：${no}`, { field: 'no', value: no });
  }
}
```

后果：userscript 直传桥（STATUS.md §八）整条链路变成 400，而且**不是 500、不是空结果，是一条看起来合理的参数错误**，很难在回归里被发现。当前实现正确，风险是「未来有人按路径长度或字母序重排」。

**assets：不存在遮蔽风险，但存在未来风险。**
`/assets/:id/file`、`/assets/:id/reveal` 都是 3 段；`/assets/scan-inbox`、`/assets/import-from-inbox` 是 2 段。Express 按段数匹配，**任意顺序都不会互相遮蔽**（已确认：`GET /api/assets/abc/file` 落到 `:id` 分支返回「资产不存在：abc」，`POST /api/assets/import-from-inbox` 落到静态段）。真正的同族风险是：设计 §8.3 才有、实现缺的 `DELETE /api/assets/:id` 也是 2 段——若将来按「先写通用再写特例」的习惯把它排在 `scan-inbox` 之前，`DELETE /api/assets/scan-inbox` 会被当成 `:id` 吞掉。当前无该路由，所以这只是「改动顺序会怎样」的答案，不构成 finding。

**其余文件无同段数冲突**：`/jobs/download` 与 `/jobs/download/:id`、`/chats` 与 `/chats/:id`、`/works/:no/segments` 与 `/works/:no` 段数不同；跨文件同名前缀由 `app.js` 的 `api.use` 顺序（health,works,download,jobs,assets,settings,import,segments,translate,layout,chat）决定，works 先于 segments 挂载，但两者路径不重叠。

---

## 三、分页与计数（GET /api/works）

- **total 每页都重算**，而且是对「带两个相关子查询的派生表」做 COUNT：

```js
// artworks.js:161-163
const wrapped = `SELECT * FROM (${baseSql})${derived.length ? ` WHERE ${derived.join(' AND ')}` : ''}`;
const total = get(`SELECT count(*) AS n FROM (${wrapped})`, [...params, ...derivedParams]).n;
```

  `baseSql` 的每一行都含 `seg_total`（`count(*) from segments`）与 `tr_done`（`count(*) from translations`）两个相关子查询。424 行数据下实测整页 7.5ms（`pageSize=5`，含 COUNT），**现在不慢**，但它随行数线性增长且每次翻页重复计算，属于「可维护性/性能退化」而非当下故障。
- **pageSize 双重上限**：`validate` 的 `max: 200`（works.js:23）+ `listWorks` 里的 `Math.min(p.pageSize||50, 200)`（artworks.js:118）。两层一致，`?pageSize=500` 实测 400。
- **越界 page 返回 200 + 空数组**（实测 `page=99999` → `{"total":424,"page":99999,"pageSize":5,"items":[]}`），不报错。对前端是好事（翻到尾部不炸），但 `page` 契约上没有「实际页码被钳制」的回写，客户端要自己用 `total/pageSize` 判断。
- **排序在 SQL 里做，不在 JS**：`NO_ORDER_SQL` 用两次 `CAST(substr(...))` 拆段号/序号按数值排（`artworks.js:14`，注释「不能用字符串排，否则 12.10 < 12.2」）。理由充分：分页必须作用在**已排序**集合上，JS 排序只能对已取出的 50 条排，无法与 `LIMIT/OFFSET` 组合。代价是 `ORDER BY` 表达式无法走索引（`idx_works_section(section_no,no)` 用的是字符串 `no`），全表排序后再 LIMIT。
- **bleed bug**：同一行 `ORDER BY ${sortCol} ${dir}` 在 `sort=no` 时只有一个 `dir`，而 `NO_ORDER_SQL` 是两列（见 finding 8）。

---

## 四、幂等与并发

**同 work 并发两次 `POST /download`**：不会插两行活跃 job。`createDownload`（downloader.js:91-149）是**全同步**函数（`get`/`run` 都是 node:sqlite 同步调用，中间没有 `await`），单进程内 check-then-insert 不可能被打断：

```js
// downloader.js:99-104（活跃任务复用）
const active = get(`SELECT * FROM download_jobs WHERE work_id = ? AND status IN ('queued','resolving','downloading','verifying') ORDER BY id DESC LIMIT 1`, [work.id]);
if (active) return { code: 200, body: { jobId: active.id, status: active.status, reused: true } };
```

第二层兜底是 schema.sql:101-102 的部分唯一索引 `uq_download_active ON download_jobs(work_id) WHERE status IN (...)`。所以结局是 **202 新建 + 200 reused**，不是 409、也不是两行 job。若真有跨进程并发（同一 db 两个 node 进程），索引会抛约束错误，而 `createDownload` 的 INSERT **没有 try/catch 转 409**，会落到 `E_INTERNAL 500`——当前单机单进程不会触发，属于「顺序/部署被改动才会怎样」的答案。

**PATCH /api/works/:no 并发改同一字段**：单进程内不可能交错。`patchWork` 是同步函数，且用的是 `tx()`（db.js:113-139，`BEGIN IMMEDIATE`/`COMMIT`，`txDepth` 处理嵌套），全仓 7 个 `tx()` 调用点都是同步箭头函数。代价是**没有任何乐观锁**：没有 ETag/`If-Match`/`version` 字段，`400` 也没有基于 `updated_at` 的比对。多标签页场景下「A 页改 title、B 页改 note」不会互相覆盖（不同字段），但「两页同时改同一字段」是后写者赢，且 `fields_locked` 会让先写者的值被锁定后仍被后写者覆盖。前端无并发编辑入口（详情页是整表提交），所以现在是理论问题。

---

## 五、长连接契约（SSE）

| 维度 | `/api/translate/jobs/:id/events` | `/api/chats/:id/ask`（`POST /chats/:id/messages`） |
|---|---|---|
| 头 | `text/event-stream; charset=utf-8` + `Cache-Control: no-cache, no-transform` + `Connection: keep-alive` + `X-Accel-Buffering: no` | 同左（legacy 与 tools 都设） |
| 心跳 | `setInterval(() => res.write(': heartbeat\n\n'), 15000)` | 同 |
| 终态帧 | `done` / `paused` / `error` | `done` / `error` |
| 出错如何收尾 | **只有 `runJob` 整体抛异常或无引擎时才发 `error`**；全部批次失败走 `done`；发完**不 `res.end()`** | `send('error', { code, message })` 后 `cleanup(); if (!res.writableEnded) res.end();` |
| 客户端能否区分「正常结束」与「上游失败」 | **不能**：两者都是 `done`，payload 里没有 `status`/`errorCode` | 能：`error` 事件的 `data.code` 是 `E_UPSTREAM`/`E_CANCELED`/… |

translate 侧的关键证据（三处）：

```js
// pipeline.js:448-451
const status = failedSegments === 0 ? 'done' : doneSegments > 0 ? 'done' : 'failed';
finishJob(jobId, status, status === 'failed' ? 'E_UPSTREAM' : null, status === 'failed' ? '全部批次失败' : null, { doneSegments, failedSegments });
const finalPayload = buildProgress(jobId, { ... });
emit(jobId, 'done', { ...finalPayload, usage, cacheHits: hits, requests, batches: batchObjects.length });
```

`buildProgress`（472-488）的字段只有 `jobId,totalSegments,doneSegments,failedSegments,donePages,totalPages,cacheHits,batchesDone,requests,elapsedMs,at`——**没有 status**。而 `streamTranslateEvents`（647-684）从 `res.writeHead` 到函数结尾**没有任何 `res.end()`**，唯一结束途径是客户端 `close`。

前端 `reader.js:327-335` 的 `done` 处理器无条件 `toast('翻译完成','ok')` 并 `es.close()`；`error` 处理器（343-353）只在 `ev.data` 存在时提示，且**不 close**——服务端 `event: error` 与浏览器原生断线 `onerror`（354-356，空实现）共用一个监听器，只能靠 `ev.data` 有无区分。

对照 layout（`layout/job.js:116-147`）：同构，同样不 `res.end()`，且 `ensureRunner(id)` 会为不存在的 id 造 runner。

STATUS.md §二 自测 7 记录「`curl -N …/events` → 4 条 progress，**结束时连接关闭**」——与当前实现不符：关闭连接的是浏览器端 `es.close()`（收到 `done` 后），不是服务端。用 curl 订阅一个已 `done` 的 job 不会收到任何终态帧，也不会被服务端断开。

---

## 六、契约漂移（对照 02-design/架构设计文档.md §8.1-§8.7）

| 端点 | 文档写 | 实现是 | 判定 |
|---|---|---|---|
| `GET /api/works/:no` | §8.2（558）WorkDetail 含 **`job`**、`asset`、`translateStats`、`lastChatId` | `downloadJob`（artworks.js:277）；实测 `job === undefined` | **字段名漂移**，且同一概念在列表里叫 `job`（`WORK_LIST` 的 `job` 列） |
| `GET /api/assets/:id/file` | §8.3（584）错误码 `E_NOT_FOUND`，括号注「missing 时 410 + `X-File-State`」 | 410 + 手写 `{error:{code:'E_NOT_FOUND',…}}`（assets.js:114） | **文档自相矛盾**（code 的 http 是 404），实现照抄了这个矛盾 |
| `POST /api/chats/:id/messages` | §8.5（611）事件 `meta/delta/citation/done/error` | legacy/tools 均产出这 5 类，且 `done`/`error` 后 `res.end()`；tools 额外有 `tool/tool_result/image`（M3 后加） | **一致**（额外事件文档未列，属 M3 增补） |
| `GET /api/works/:no/search` | §8.4（594）入参 `q` 必填 + `topK?=24`；出参 `{query, degraded:boolean, results}` | `topK` 默认 **20**、无下限；出参键 **`q`**；`degraded` **恒 `null`**（segments.js:93-95） | 3 处漂移 |
| `POST /assets/:id/extract` | §8.4（592）202 `{extractStatus:'extracting'}` | 同步 200（segments.js:30，且三元两边同值） | 漂移，STATUS.md §二已承认 |
| `POST /api/works/:no/asset` | §8.3（582）201；错误码无 `E_CONFLICT` | 新建 201 / 同内容 200 / 冲突 409 | 文档缺 `E_CONFLICT`（实现更正确） |
| `PUT /api/settings/downloadDir` | §8.6（623）`migrate` → 202 `{moveJobId}`；错误码 `E_PATH_OUT_OF_SCOPE` | `migrate` → 400「M1 未实现」；**从不返回 `E_PATH_OUT_OF_SCOPE`** | 未实现 + 该码在此端点从未产出 |
| `DELETE /api/assets/:id` | §8.3（586）200 `{fileDeleted}` | 路由不存在 → 404「接口不存在」 | 未实现（STATUS.md:102 承认） |

---

## 七、缺失 API 对前端意味着什么

- `DELETE /api/assets/:id`：全量 grep `03-code/web`（排除 vendor）**没有任何 `api.delete` / `method:'DELETE'`**，命中的 `delete` 都是 `lockSet.delete` / `searchParams.delete` / `viewer.rendered.delete`。**没有删除按钮，所以不存在「点了没反应」或静默失败**。实测 `DELETE /api/assets/1` → 404「接口不存在：DELETE /api/assets/1」。
- `PUT /settings/downloadDir?mode=migrate`：`web/assets/settings.js:81` 固定发 `{ path, mode: 'switch' }`，UI 上**没有「迁移」选项**，所以同样不存在假按钮。实现侧是**如实拒绝**（400 + 明确文案），不是假成功——这一点实现方做对了（STATUS.md §三 偏离第 10 条）。
- 结论：这两处缺失的风险不在浏览器用户，而在**按文档写脚本的人**（userscript、批处理、未来 UI）——他们会拿到 404/400，而不是文档承诺的 202/200。要么补实现，要么在文档里标「M1 未实现」。

---

## findings

### 1. [high] 取消下载不校验状态且清扫整个 `.tmp`，会踩掉另一个并发下载的在途文件

**现象**：`POST /jobs/download/:id/cancel` 对**任意** job 调用都会把状态改成 `canceled`（包括已 `done`/`failed` 的），并删除 `.tmp` 目录下**所有** `*.part`。

**证据**：

```js
// 03-code/server/services/downloader.js:636-648
run(`UPDATE download_jobs SET status='canceled', error_code='E_CANCELED', error_message='用户取消', finished_at=? WHERE id = ?`, [Date.now(), Number(id)]);
...
try {
  const dir = tmpDir();
  const files = await fsp.readdir(dir);
  await Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true })));
} catch { /* 清理失败不影响状态机 */ }
```

`.part` 文件名与 job 无关，是随机串：

```js
// 03-code/server/services/downloader.js:335
const partAbs = assertInScope(path.join(tmpDir(), `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.part`));
```

下载成功后靠 rename 落盘：`const finalPath = await commitAtomic(partAbs, finalAbs);`（downloader.js:483）。`config.download.concurrency = 2`。

**影响**：两篇同时下载时取消其中一篇，另一篇的 `.part` 被删，`commitAtomic` 的 rename 抛 `ENOENT`，该任务失败（用户视角：取消 A 却把 B 弄挂了）。另外对已 `done` 的 job 调 cancel 会把「成功」改写成「已取消」，随后 `retryJob`（只放行 failed/needs_manual/canceled）会把一个已完成的下载判为可重试，重复拉取。**这是状态机被破坏 + 并发互踩，属于「特定条件必触发功能错误」。**

**建议**：UPDATE 加 `AND status IN ('queued','resolving','downloading','verifying')`（同文件 `cancelTranslateJob` 已是这个写法），并对 0 行受影响的情况返回 409/409 而不谎报 `{canceled:true}`；`.part` 名带 `jobId` 前缀，清理只删本 job 的文件；进程启动时的全量清扫（downloader.js:67-73）保持不变。

**effort**：S

---

### 2. [high] 翻译全部批次失败仍发 `done`，前端弹「翻译完成」；且 SSE 服务端从不收尾

**现象**：上游全挂（key 失效、429、网络）时，`runJob` 把 DB 记成 `failed`/`E_UPSTREAM`，但事件流最后发的仍是 `event: done`；payload 里没有 status/errorCode。前端据此弹绿色「翻译完成」。同时 `streamTranslateEvents` 没有任何 `res.end()`，任务结束也不关连接。

**证据**：

```js
// 03-code/server/services/translate/pipeline.js:448-457
const status = failedSegments === 0 ? 'done' : doneSegments > 0 ? 'done' : 'failed';
finishJob(jobId, status, status === 'failed' ? 'E_UPSTREAM' : null, status === 'failed' ? '全部批次失败' : null, { doneSegments, failedSegments });
const finalPayload = buildProgress(jobId, { ... });
emit(jobId, 'done', { ...finalPayload, usage, cacheHits: hits, requests, batches: batchObjects.length });
```

```js
// 03-code/web/assets/reader.js:327-335
es.addEventListener('done', async (ev) => {
  const p = JSON.parse(ev.data);
  $('progressLine').textContent = `完成：${p.doneSegments}/${p.totalSegments} 段（失败 ${p.failedSegments}），…`;
  es.close();
  ...
  toast('翻译完成', 'ok');
});
```

**影响**：静默假成功——用户看到绿色「翻译完成」，不会再点「继续翻译」，读到的却是原文；一次运行可能白等十几分钟。这是 10 条不变量里「HTTP 200 不算成功」同源的问题：**事件流上的 `done` 也不算成功**。附带：每个订阅连接必须由客户端主动 close，服务端才释放 listener + 15s 心跳；curl/脚本订阅已完成的 job 会永久挂着（实测只有一帧 `progress`，无终态、无断开）。STATUS.md §二 自测 7「结束时连接关闭」的结论在当前实现下不成立。

**建议**：`status === 'failed'` 时改为 `emit(jobId, 'error', { code: 'E_UPSTREAM', message: '全部批次失败' })`，或在 `done` payload 里加 `status`/`errorCode` 让客户端分支；发完终态帧后 `res.end()`（chat 侧 `pipeline.js:349-350` 已是这个模式）；前端 `done` 处理器按 `p.status` 或失败段数分支，别再无条件 `toast(ok)`。

**effort**：S（服务端 2 行 + 前端 1 个分支）；若同时补「终态后 end + 前端不再依赖 close」，M

---

### 3. [medium] 请求体超限一律落成 `500 E_INTERNAL`，而不是 `413 E_TOO_LARGE`

**现象**：body 超过 `express.json` 的 `1mb`（全局）或 `express.raw` 的 `maxBytes + 8MiB`（上传路由）时，body-parser 抛 `entity.too.large`，`toAppError` 不认它的 `status/code`，最终返回 500 + `E_INTERNAL` + `detail:null`。

**证据**：

```js
// 03-code/server/errors.js:56-62
export function toAppError(e) {
  if (isAppError(e)) return e;
  const err = new AppError(
    e && e.code && ERROR_CODES[e.code] ? e.code : 'E_INTERNAL',
    (e && e.message) || '未知异常',
    null,
  );
```

```js
// 03-code/server/app.js（全局 body 解析）
api.use(express.json({ limit: '1mb' }));
```

实测（POST 到不存在的路由，body 2MB，parser 先于路由命中，无任何写入）：

```
POST /api/nope   Content-Type: application/json   body = 2,097,160 bytes
HTTP 500
{"error":{"code":"E_INTERNAL","message":"request entity too large","detail":null,"traceId":"b3052e4b"}}

POST /api/works  （同 body）
HTTP 500
{"error":{"code":"E_INTERNAL","message":"request entity too large","detail":null,"traceId":"a4dc30ab"}}
```

**影响**：① 设计 §8.1 要求「前端按 code 分支」，`E_INTERNAL` 会走「服务端异常，请重试」的通用文案，用户看到的不是「文件太大」而是「未知异常」；② 这类错误会进 `log.error`（`isInternal` 分支，error.js:26-28）并带堆栈，把「用户传了个大文件」记成服务端故障，干扰排查；③ `POST /api/import` 是现实触发点——批量导入的 JSON 很容易过 1MB，导入失败却报「未分类的服务端异常」。

**建议**：在 `errorMiddleware` 里先做一层映射：`err.type === 'entity.too.large' || err.status === 413` → `E_TOO_LARGE`；`err.type` 以 `entity.parse.failed` → `E_BAD_REQUEST`；或在 `toAppError` 里按 `e.status`/`e.type` 兜底。顺带把 `express.raw` 的 `limit` 与 `config.download.maxBytes` 的关系写进注释（现在的 `maxBytes + 8MiB` 是为了让 handler 的大小检查先于 parser 生效，但超过该值仍是 500）。

**effort**：S

---

### 4. [medium] `GET /assets/:id/file` 文件丢失时手搓 `410` 却配 `E_NOT_FOUND`，且 GET 写库

**现象**：资产行存在但磁盘文件不在时，路由自己写 JSON 响应（不经 `errorMiddleware`），HTTP 410 而 `code` 是 `E_NOT_FOUND`（其映射 http 是 404）；同时这个 GET 会改写 `assets.file_state`。

**证据**：

```js
// 03-code/server/routes/assets.js:107-121
if (!fsSync.existsSync(abs)) {
  run("UPDATE assets SET file_state='missing', missing_since=?, updated_at=? WHERE id=?", [...]);
  res.setHeader('X-File-State', 'missing');
  res.status(410).json({
    error: { code: 'E_NOT_FOUND', message: '文件不在了（可能被移动或删除）',
             detail: { assetId: asset.id, relPath: asset.storage_rel_path }, traceId: req.traceId },
  });
```

**影响**：设计 §8.1 明确「前端按 `code` 分支，不按 message」。`E_NOT_FOUND` 的既定语义是「资产不存在」，前端会走「记录没了」的分支（通常提示刷新/回列表），而真实情况是「文件丢了，可重新下载」——两者 UI 完全不同。这是 11 个路由里**唯一**绕过 `errorMiddleware` 手写信封的地方，`code` 与 http 语义冲突也写进了文档 §8.3（404 与 410 并存），属于把矛盾固化。GET 带写副作用还会让「只读打开阅读器」变成一次数据库写。

**建议**：在 `errors.js` 增加 `E_FILE_MISSING: { http: 410 }`（或 `E_ASSET_FILE_MISSING`）并 `throw new AppError(...)`，让 `X-File-State` 由中间件之外的显式 `res.setHeader` 处理或改成 body 字段；`file_state='missing'` 的更新挪到 `resyncStorage`/显式 POST。

**effort**：S

---

### 5. [medium] `GET /jobs/translate/:id` 的进度与 job 记录脱钩：`done` 任务报 `0/536`

**现象**：实测一个 `status=done` 的历史任务返回 `totalSegments: 536, doneSegments: 0`。

**证据**：

```
GET /api/jobs/translate/13
{"jobId":13,"status":"done","engine":"mock","model":"mock-v1","tgtLang":"ko","srcLang":"auto",
 "scope":"pages","totalSegments":536,"doneSegments":0,"failedSegments":0,"totalPages":14,"donePages":0,
 "requests":0,"cacheHits":0,…}
```

```js
// 03-code/server/services/translate/pipeline.js:616-627
const prog = progressFromDb(job.id) || {};
return {
  ...
  totalSegments: prog.totalSegments ?? job.total_segments,
  doneSegments: prog.doneSegments ?? job.done_segments,
```

**影响**：`progressFromDb` 恒返回数值，所以 `??` 右侧是死代码——**DB 里写入的 `total_segments`/`done_segments` 永远不会被读**。而 `progressFromDb` 是按「当前 asset 的全部可译段」重算的（502-507 的 SQL 不带 `scope` 过滤），于是：① `scope='pages'` 的任务把整篇 536 段当分母，进度百分比永久偏低；② 翻译缓存被清理/换模型/换 `promptFp` 后 `doneSegments` 归零，**已完成的任务显示 0%**。前端 `maybeReattachJob`（reader.js:171-173）拿这个数字判断，用户看到的「已完成」与「0/536」并存。附带性能：`progressFromDb` 对每个段各做一次 `get('SELECT 1 AS hit FROM translations WHERE cache_key = ?')`（pipeline.js:521），536 段 = 536 次查询，每次 `GET /jobs/translate/:id` 都跑一遍（实测 6.8ms，属可接受但不该在热路径）。

**建议**：写入时按 scope 算好 `total_segments` 并让读取优先用它（把 `??` 两侧反过来，或在 `progressFromDb` 里按 job.scope 过滤）；「当前缓存命中数」与「本任务完成数」拆成两个字段；N+1 改成一条 `SELECT cache_key FROM translations WHERE asset_id=? AND extract_version=?` 建 Set。

**effort**：S（字段口径）/ M（去 N+1 + 口径拆分 + 前端适配）

---

### 6. [medium] layout 任务端点对不存在的 id 返回 `200 unknown`，`/events` 还会凭空造 runner

**现象**：`GET /jobs/layout/999999` 返回 200 `{"jobId":999999,"status":"unknown",…}`；订阅它的 `/events` 返回 200 SSE 并推送一帧 `status:"queued"`，之后永久挂心跳。

**证据**：

```js
// 03-code/server/services/layout/job.js:105-113
export function getLayoutJob(id) {
  const n = Number(id);
  const r = runners.get(n);
  return { jobId: n, status: r ? r.status : 'unknown', error: r && r.lastError ? r.lastError : null, result: r && r.result ? r.result : null };
}
```

```js
// 03-code/server/services/layout/job.js:118（SSE 入口）
const runner = ensureRunner(id);
```

实测（先 GET 详情，再 GET events，再 GET 详情）：

```
GET /api/jobs/layout/999999        → 200 {"jobId":999999,"status":"unknown","error":null,"result":null}
GET /api/jobs/layout/999999/events → 200 SSE  event: progress / data: {"jobId":999999,"status":"queued",…}
GET /api/jobs/layout/999999        → 200 {"jobId":999999,"status":"queued",…}   ← 幽灵 runner 被持久化了
```

**影响**：① 同族端点行为分裂——`/jobs/download/:id`、`/jobs/translate/:id` 都是 404，只有 layout 是 200，客户端必须为它写特例；② layout runner 纯内存，进程重启后所有历史 job 变成 `unknown`，前端无法区分「从未存在」与「重启丢失」，也无法提示「请重新跑版式分析」；③ `/events` 对任意 id 造 runner，等于给任何请求分配一个永不结束的连接（资源泄漏面），而且它给客户端的是 `queued` ——**一个永远不会推进的假状态**。

**建议**：`getLayoutJob` 先查 DB（或至少对未知 id 抛 `E_NOT_FOUND`）；`streamLayoutEvents` 对未知 id 抛 `E_NOT_FOUND`，不要 `ensureRunner`；若要支持「重启后仍在跑」的错觉，应把 layout job 落库（与 translate_jobs 对齐），否则明确返回 410/404。

**effort**：S（404 对齐）/ M（落库）

---

### 7. [medium] 查询参数校验缺面：`topK=-1` 返回全篇、search 不校验 `no`、chat `limit` 只钳上限

**现象**：`GET /works/4.6/search?q=AGI&topK=-1` 实测返回 `hits: 98`（整篇），而 `topK` 的设计意图是「≤100 条」。

**证据**：

```js
// 03-code/server/routes/segments.js:93-95
const topK = Math.min(Number(req.query.topK) || 20, 100);
const allowRewrite = req.query.rewrite !== '0';
let degraded = null;
```

`Math.min` 只有上限。实测对照：默认 → 20 条；`topK=5` → 5；`topK=0` → 20（`0 || 20`）；`topK=-1` → **98**（SQLite `LIMIT -1` 视为不限）。同类问题：

```js
// 03-code/server/services/chat/session.js:79
params.push(Math.min(Number(limit) || 50, 200));
```

`?limit=-5` → `-5` 透传 → `LIMIT -5` 同样不限（库内会话只有 2 条消息，**无法用数据证明**，仅代码路径推定）。另外 `GET /works/:no/search` 没有走 `assertNo`：

```js
// 03-code/server/routes/segments.js:87-88
const work = getWorkRow(req.params.no);
if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${req.params.no}`);
```

实测 `/works/abc/search?q=AGI` → 404「条目不存在：abc」，而 `/works/abc` → 400「编号格式不合法」。同族资源的同类非法输入，一个 400 一个 404，客户端无法按 code 稳定分支。

**影响**：单次响应体积无上界（`topK=-1` 把整篇 98 段全文 + 译文塞进一个 JSON，实测 `hits:98`；424 条文献里最长的那篇会更大）；契约上 `q` 的「必填/≤200」有了，`topK` 的下界没有；`no` 的校验口径三处不一致（works.js 400、segments.js 404、assets 无）。

补充一处**参数通道**不一致（不单列 finding）：同一个「强制替换」语义，上传走 query，导入走 body——

```js
// 03-code/server/routes/assets.js:204（上传）
const force = req.query.force === '1' || req.query.force === 'true';
```

```js
// 03-code/server/routes/assets.js:308（导入，报错文案也写 force=true）
throw new AppError('E_CONFLICT', '该条目已有本地 PDF；如需替换请带 force=true', {
```

未走 `validate.js` 的端点因此连「force 在哪」都要逐个看代码。userscript 直传用的是 `?force=1`（STATUS.md §八），所以现在是可用的，只是契约没有统一。

**建议**：search 改为 `parseInput`（`topK: {type:'int', min:1, max:100, default:20}`），并加 `assertNo(req.params.no)`；chat 的 limit 用 `Math.max(1, Math.min(Number(limit)||50, 200))`；把「非数字路径参数」统一为 400（现在是 404 + 文案里出现 `NaN`，见动态验证 6）。

**effort**：S

---

### 8. [medium] `sort=no&order=desc` 只对第二段降序，第一段永远是升序

**现象**：`GET /works?sort=no&order=desc` 返回 `1.19 1.18 … 1.1 2.11 2.10 … 2.6`——段号（第一列）升序、段内序号（第二列）降序。

**证据**：

```js
// 03-code/server/services/artworks.js:14
export const NO_ORDER_SQL = `CAST(substr(no,1,instr(no,'.')-1) AS INTEGER), CAST(substr(no,instr(no,'.')+1) AS INTEGER)`;
```

```js
// 03-code/server/services/artworks.js:173
const rows = all(`${wrapped} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`, [...params, ...pageParams]);
```

`NO_ORDER_SQL` 是逗号分隔的两列，拼进 `ORDER BY` 后只有一个 `dir` 修饰末尾那列。

**影响**：API 契约上 `order=desc` 对 `sort=no` 语义破损——调用方要求倒序却拿到「段升序、段内倒序」。当前 UI 无入口（`list.js` 固定 `order:'asc'`，只有 `sort` 可切），所以用户看不到；但这是公开参数组合，任何脚本/userscript/未来排序按钮都会踩。另外 `sort=no` 的表达式无法命中 `idx_works_section`，全表排序。

**建议**：`sort=no` 时单独拼 `ORDER BY CAST(...section...) ${dir}, CAST(...ord...) ${dir}`；或给 `works` 加两个派生列/生成列（`no_section`、`no_ord`）并建索引，顺带解决排序不能走索引的问题。

**effort**：S

---

### 9. [medium] 契约漂移与未实现端点（文档 §8 与实现的差距）

#### 9.1 字段名/默认值/取值域漂移

**现象**：抽查三个端点，字段名、默认值、取值域与 §8 不一致。

**证据**：

```
GET /api/works/1.4 → 顶层键 = work, asset, downloadJob, translateStats, lastChatId, availableTranslateOptions
                      job === undefined
GET /api/works?pageSize=1 → item 键含 …, downloadStatus, extractStatus, job, translate, …
```

```js
// 03-code/server/services/artworks.js:277（WorkDetail 组装）
    downloadJob: job,
```

```js
// 03-code/server/routes/segments.js:98-108（search 出参）
res.json({ q, assetId, hits: out.hits.length, degraded, rewritten, keywords, rewriteMocked, reason, results });
```

配合 segments.js:93-95：`topK` 默认 20（文档 24）、`degraded` 恒 `null`（文档 `boolean`）、出参键 `q`（文档 `query`）。另有 `POST /assets/:id/extract` 文档 202 实现 200。

**影响**：前端/脚本按文档写会读不到字段（`query`、`degraded`、`job`），或拿到永远为 null 的「降级检索」信号——这个字段本该告诉调用方「改写失败，退回关键词检索」，恒 null 等于把降级路径对客户端隐藏了（内部其实有 `rewriteMocked`/`reason` 但文档未提）。同一概念在列表里叫 `job`、详情里叫 `downloadJob`，前端必须记两套名字。

**建议**：一次对齐，二选一：改文档（把 `job`→`downloadJob`、`query`→`q`、`topK` 默认 20、`degraded` 标注恒 null 或删除）或改实现（补 `query` 别名、真算 `degraded`、统一 `job`）。`degraded` 建议真算（改写失败/超时即 true）。

**effort**：S

---

#### 9.2 文档承诺但未实现的端点：`DELETE /assets/:id`、`migrate` 迁移

**现象**：`DELETE /api/assets/1` 实测 404「接口不存在」；`PUT /settings/downloadDir {mode:'migrate'}` 抛 400。

**证据**：

```
$ curl -s -X DELETE http://127.0.0.1:7317/api/assets/1
{"error":{"code":"E_NOT_FOUND","message":"接口不存在：DELETE /api/assets/1","detail":{"path":"/api/assets/1"},"traceId":"2e28f15c"}}
```

```js
// 03-code/server/routes/settings.js:120-123
if (mode === 'migrate') {
  // M1 不做目录迁移（要逐个 rename 数百个文件 + 后台 job），如实拒绝而不是假装成功
  throw new AppError('E_BAD_REQUEST', 'M1 未实现目录迁移（migrate）；请用 switch 模式并手动移动文件', { mode });
}
```

**影响**：实现方在这里**做对了**——如实拒绝，没有假成功；STATUS.md §四/§三 也承认了缺口。对前端的影响是零：`web` 全量 grep 无 `DELETE` 调用、`settings.js:81` 固定 `mode:'switch'`，**没有「点了没反应」的入口**。真正的代价是 API 消费者的预期落差与文档可信度：`DELETE /assets/:id` 还牵扯「删文件 + 删 segments/translations + 清缓存」的级联（设计 §8.3 的 `?deleteFile=0/1`），补起来不是 S。

**建议**：短期在 §8.3/§8.6 标注「M1 未实现」并在 `GET /health` 或 `/api/health` 的 `version` 旁暴露能力集（可选）；长期补 `DELETE`（需级联事务 + `assertInScope` + 前端二次确认）与 `migrate`（后台 job + 逐文件 rename + 断点续迁）。

**effort**：L（补实现）/ S（只改文档标注）

---

### 10. [low] `PUT /settings/downloadDir` 没有路径白名单，且先 `mkdir` 后校验可写

**现象**：这个端点是唯一「接受任意绝对路径并对其做文件系统操作」的入口，从不返回设计承诺的 `E_PATH_OUT_OF_SCOPE`；且 `mkdirSync` 在 `isDirWritable` 之前执行。

**证据**：

```js
// 03-code/server/routes/settings.js:125-126
fs.mkdirSync(target, { recursive: true });
if (!isDirWritable(target)) throw new AppError('E_CONFLICT', `目标目录不可写：${target}`, { path: target });
```

`target` 只校验了「非空字符串 + 绝对路径」（116-119），没有 `assertInScope`，也没有「必须在某个挂载点/用户目录下」的约束。对照不变量 1（`assertInScope` 路径白名单）与设计 §8.6 的错误码 `E_PATH_OUT_OF_SCOPE`。

**影响**：① 任意绝对路径都会被 `mkdir -p`（包括用户并不打算当下载目录的路径），而校验失败时目录已经建了——半个副作用留在盘上；② 若 `target` 指向一个已存在的文件或不可写位置，`mkdirSync` 抛原生 `Error`（`EEXIST`/`EPERM`），被 `catch` 后 `next(e)`，`errorMiddleware` 不认识该错误 → `E_INTERNAL 500`，而设计期望的是 `409/403`；③ 单机 + `127.0.0.1` + Origin 校验把这个原语的攻击面压得很小（本机进程本来就能 `mkdir`），所以是 low 而不是 high。

**建议**：先做 `assertInScope`/根目录白名单（或至少限制到「用户可写且非系统目录」）再 `mkdir`；`mkdirSync` 的 `EEXIST`/`EPERM`/`EACCES` 映射为 `E_CONFLICT`/`E_PATH_OUT_OF_SCOPE`；要么实现 `E_PATH_OUT_OF_SCOPE` 的产出，要么把它从 §8.6 删掉。

**effort**：S

---

## 覆盖与盲区

1. **并发取消的运行时未复现**：finding 1 的「误删另一 job 的 `.part`」由代码路径推定（`335` 随机文件名 + `483` rename + `642-648` 全目录删除 + `concurrency: 2`），没有在真实服务上同时跑两个下载再取消其一——那会产生真实外网下载与写盘。**结论强度：代码级确证，运行时未复现。**
2. **chat SSE 未做动态验证**：`config.chat.engine` 默认 legacy，真实 LLM 零调用约束下无法在跑着的服务上触发一轮对话（也不能为了验证而写 messages 行）。「chat 有 done/error 且会 `res.end()`、translate/layout 没有」的对比结论来自 `chat/pipeline.js:337-372` 与 `reader.js` 的代码对照，未用 curl 实证。
3. **写接口基本没打**：`POST /download`、`POST /works/:no/asset`、`PATCH /works/:no`、`PUT /settings*` 都没在运行实例上调用（只读纪律），幂等/并发结论依赖「node:sqlite 同步调用 + 单进程 + schema 部分唯一索引」的代码事实，未做双连接/双进程压测。
4. **`410` 分支未动态触发**：验证它需要把真实 PDF 移走（属改动数据），本报告只引用代码与文档。
5. **02-design 只按 grep 定位到 §8（518-707）与相关小节**，未通读 194KB 全文；§9 的安全性条款只做了交叉引用，未逐条比对。
6. **前端只抽查了调用点**（`reader.js`、`chat.js`、`list.js`、`settings.js`），没有浏览器端到端验证「失败任务在 UI 上到底显示什么」——finding 2 的 UI 后果是基于 `reader.js:327-335` 的代码推断。

## 动态验证记录

全部为只读调用（`GET`，以及一次 `DELETE` 打到不存在的端点），未写库、未启停服务。命令统一用 `curl.exe`（PowerShell 里 curl 是别名，必须写 `.exe`）。

```powershell
$B='http://127.0.0.1:7317/api'
curl.exe -s -o $tmp -w "%{http_code} %{time_total}s" "$B/works?page=99999&pageSize=5"
```

**1) 分页越界（200 + 空 items）**

```
GET /works?page=99999&pageSize=5
HTTP 200 0.007498s
{"total":424,"page":99999,"pageSize":5,"items":[]}
```

**2) page 下界（validate 拦下）**

```
GET /works?page=0
HTTP 400 0.001862s
{"error":{"code":"E_BAD_REQUEST","message":"参数 page 不能小于 1","detail":{"field":"page","value":"0"},"traceId":"7069524a"}}
```

**3) pageSize 上界（注意 detail.value 是字符串）**

```
GET /works?pageSize=500
HTTP 400 0.001705s
{"error":{"code":"E_BAD_REQUEST","message":"参数 pageSize 不能大于 200","detail":{"field":"pageSize","value":"500"},"traceId":"49860d87"}}
```

**4) 排序 desc 只作用于第二列**

```
GET /works?pageSize=12&sort=no&order=desc
HTTP 200 0.005828s
{"total":424,"page":1,"pageSize":12,"items":[{"id":19,"no":"1.19",…},{"no":"1.18"},…]}
```

（完整序列：`1.19 1.18 1.17 1.16 1.15 1.14 1.13 1.12 1.11 1.10 1.9 1.8` — 段号升序、段内降序；对照 `order=asc` 为 `1.1 … 1.8`。）

**5) lookup 空参**

```
GET /works/lookup
HTTP 400 0.001653s
{"error":{"code":"E_BAD_REQUEST","message":"需要至少一个可归一的 doi 或 arxiv 标识符","detail":{"fields":["doi","arxiv"]},"traceId":"07e36cfe"}}
```

**6) 非数字路径参数 → NaN 出现在文案里（404 而非 400）**

```
GET /jobs/download/abc
HTTP 404 0.001826s
{"error":{"code":"E_NOT_FOUND","message":"下载任务不存在：NaN","detail":{"jobId":null},"traceId":"4b507465"}}

GET /chats/abc/messages
HTTP 404 0.001709s
{"error":{"code":"E_NOT_FOUND","message":"会话不存在：NaN","detail":{"chatId":null},"traceId":"68a69906"}}

GET /assets/abc/file
HTTP 404 0.001698s
{"error":{"code":"E_NOT_FOUND","message":"资产不存在：abc","detail":{"assetId":"abc"},"traceId":"d56cb1df"}}
```

**7) layout 任务不存在 → 200 unknown，订阅后变 queued（幽灵 runner 被持久化）**

```
GET /jobs/layout/999999
HTTP 200 0.001666s
{"jobId":999999,"status":"unknown","error":null,"result":null}

GET /jobs/layout/999999/events   （-m 2 由 curl 主动断开）
event: progress
data: {"jobId":999999,"status":"queued","at":1793717672081}

GET /jobs/layout/999999          （再查）
HTTP 200
{"jobId":999999,"status":"queued","error":null,"result":null}
```

**8) 对照：translate 的同类请求是 404（含响应头）**

```
GET /jobs/translate/999999/events
HTTP/1.1 404 Not Found
X-Trace-Id: 617d3c53
Content-Type: application/json; charset=utf-8
Content-Length: 122

{"error":{"code":"E_NOT_FOUND","message":"翻译任务不存在：999999","detail":{"jobId":999999},"traceId":"617d3c53"}}
```

**9) `done` 的翻译任务报 0/536（进度口径错）**

```
GET /jobs/translate/13
{"jobId":13,"status":"done","engine":"mock","model":"mock-v1","tgtLang":"ko","srcLang":"auto","scope":"pages",
 "totalSegments":536,"doneSegments":0,"failedSegments":0,"totalPages":14,"donePages":0,"requests":0,"cacheHits":0,
 "anchorPage":null,"errorCode":null,"errorMessage":null,"createdAt":1793420639468,"startedAt":1793420639468,
 "finishedAt":1793420643510,"lastRun":null}
```

**10) search 不校验 no / topK 无下限**

```
GET /works/abc/search?q=AGI
HTTP 404 0.001783s
{"error":{"code":"E_NOT_FOUND","message":"条目不存在：abc","detail":null,"traceId":"29f658d3"}}

GET /works/4.6/search?q=AGI&topK=-1
HTTP 200 0.007178s
{"q":"AGI","assetId":2,"hits":98,"degraded":null,"rewritten":false,"keywords":null,"rewriteMocked":false,
 "reason":"hit","results":[{"segmentId":80579,"pageNo":1,"ord":0,"text":"Position: Levels of AGI …","score":-6.374…,"hitLang":"src","textDst":null}, …]}
```

（对照：默认 `topK` 20 条；`topK=5` 5 条；`topK=0` 20 条；`topK=-1` **98 条 = 整篇**。`degraded` 恒 `null`，出参键是 `q` 不是 `query`。）

**11) 文档承诺的 DELETE 不存在**

```
DELETE /assets/1
HTTP 404
{"error":{"code":"E_NOT_FOUND","message":"接口不存在：DELETE /api/assets/1","detail":{"path":"/api/assets/1"},"traceId":"2e28f15c"}}
```

**12) 404 兜底信封（走 errorMiddleware，与第 7 号形成对照）**

```
GET /api/nope
HTTP 404
{"error":{"code":"E_NOT_FOUND","message":"接口不存在：GET /api/nope","detail":{"path":"/api/nope"},"traceId":"ca0a23ed"}}
```

**13) health（运行态基线）**

```
GET /health
HTTP 200
{"ok":true,"version":"1.0.0-m1","dbDriver":"node:sqlite",
 "dbPath":"D:\\A-knowledge\\agent工作流优化\\03-code\\data\\app.db",
 "rootDir":"D:\\A-knowledge\\agent工作流优化\\03-code",
 "downloadDir":"D:\\A-knowledge\\agent工作流优化\\03-code\\storage\\pdfs",
 "downloadDirWritable":true,"missingAssets":0,"activeJobs":0,"works":424}
```

**14) works 详情与列表的字段名对照（finding 9.1 的证据）**

```
GET /works/1.4
顶层键 = work, asset, downloadJob, translateStats, lastChatId, availableTranslateOptions
job === undefined
downloadJob = {"jobId":5,"status":"needs_manual","source":"manual","url":null,"errorCode":"E_NO_SOURCE",
               "errorMessage":"该条目没有 arXiv 编号也没有可用链接，只能人工获取", …}

GET /works?pageSize=1
item 键 = id,no,sectionNo,section,authors,title,year,venue,type,note,arxivId,doi,isbn,link,sourceNote,
          origin,fieldsLocked,assetId,fileState,downloadStatus,extractStatus,job,translate,pageCount,fileSize,lastReadAt
job = {"jobId":6,"status":"needs_manual","errorCode":"E_NO_SOURCE", …}
```

**15) 裸数组契约（GET /jobs/download）与 lookup 命中形态**

```
GET /jobs/download?limit=1
isArray = true, len = 1
元素键 = jobId,no,title,status,source,url,httpStatus,bytesDone,bytesTotal,attempts,errorCode,errorMessage,
         nextRetryAt,createdAt,startedAt,finishedAt,updatedAt

GET /works/lookup?arxiv=2311.02462
HTTP 200
{"found":true,"work":{"no":"4.6","title":"Levels of AGI…","year":2023,"venue":"arXiv:2311.02462","doi":null,
 "arxivId":"2311.02462"},"asset":{"id":2,"fileState":"present",…}}
```

**16) body 超限 → 500 `E_INTERNAL`（不是 413）**

探测方式：POST 到**不存在**的路由，body 2MB。`express.json({limit:'1mb'})` 在路由之前执行，解析器直接抛错，因此该请求不会落库、不会产生任何写入；用它把「超限 body 的错误映射」从业务逻辑里隔离出来测。

```powershell
$f = Join-Path $env:TEMP 'a06_big.json'
$payload = '{"q":"' + ('x' * (2 * 1024 * 1024)) + '"}'
[System.IO.File]::WriteAllText($f, $payload)
curl.exe -s -X POST -H "Content-Type: application/json" --data-binary "@$f" -w "`nHTTP %{http_code}`n" "http://127.0.0.1:7317/api/nope"
```

```
body bytes = 2097160
### POST /api/nope（路由不存在）但 body 2MB > express.json limit 1mb
{"error":{"code":"E_INTERNAL","message":"request entity too large","detail":null,"traceId":"b3052e4b"}}
HTTP 500
### POST /api/works 同理确认 parser 先于路由
{"error":{"code":"E_INTERNAL","message":"request entity too large","detail":null,"traceId":"a4dc30ab"}}
HTTP 500
```

期望值：`413` + `E_TOO_LARGE`（`errors.js:16` 里已定义），实际 `500` + `E_INTERNAL` + `detail:null`。

