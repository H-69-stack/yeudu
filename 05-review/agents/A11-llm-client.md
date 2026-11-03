# A11 · LLM 客户端（三家协议 / 流式解析 / 重试 / 记账）

审查对象：`03-code/server/services/llm/client.js`（458 行，SHA256 `91e3a5b5…472227e`，全系统唯一出站 HTTP 出口）
关联调用方：`03-code/server/services/chat/{agent,loop,pipeline,retrieval,refine}.js`、`03-code/server/services/translate/{pipeline,engines/*}.js`、`03-code/server/logger.js`、`03-code/server/errors.js`
基线：`05-review/_context.md`（严重度按「现在会造成什么后果」判；每条证据带 `文件:行号` + 原文摘录）
审查方式：静态逐行 + 用假 `fetch` 驱动真实 `client.js` 的探针（不写仓库、不发真网络）+ 对 7317 实例的只读 curl

## 结论

1. 协议实现的主干是**对的**：`tool_calls` 确实按 `index` 累积再拼（不是「最后一片覆盖」），半行、跨 chunk、多事件挤一个 chunk、`: keep-alive` 注释行、`[DONE]` 这五类分帧场景里四类正确，**只有 CRLF 行尾会整条流归零**。三家协议的鉴权头、`max_tokens` 必填性、取文本字段、usage 字段名都与官方一致，**错的是调用方与流式分支的接线**（system 丢、tools 丢、硬编码 OpenAI 协议）。
2. 最要紧的两个缺陷都不在「协议」而在「收尾」：一是**流中中止/超时抛裸 `AbortError`（`code:20`）**，绕过 `E_CANCELED`/`E_TIMEOUT` 归一化，最终以 `{"code":20}` 下发给前端；二是 **`[DONE]` 后与异常路径都不 `reader.cancel()`**，每次对话留一个不关闭的流（用户点「停止」后上游仍在生成，照样计费）。
3. 重试策略与文件头写明的契约（「仅 429/5xx/网络重试 1 次，4xx 不重试」）不符：**4xx 也重试**、**429 的 `Retry-After` 完全无视**（实测 `retry-after: 7` 只等了 1012ms）、**流式出口完全没有重试**，同时翻译链路在 client 之外又套了一层重试，单批最多 4 次上游请求。
4. 记账只有一半：翻译侧按批累加正确，**对话的工具循环每轮覆盖而非累加**，多轮问答的 token 成本系统性偏低；日志确实不落 prompt 正文（好消息），但 `logger.redact → JSON.parse` 在特定上游错误体上会抛 `SyntaxError`，把「记日志」变成新的故障点。
5. 与 translate/engines **没有第二份 fetch/SSE 实现**（都是委托 client.js），重复的是「重试策略」——收敛点是唯一的：重试只留一层、4xx 与 429 分开、流式在未产出 delta 前可重试。

> ⚠️ 基线更正：`_context.md` 与 `03-code/STATUS.md:155` 均称「真实引擎无 key、未验证」。实测 7317 实例上 `POST /api/translate/test {"engine":"deepseek"}` 返回 `{"ok":true,…,"latencyMs":776}`（真实译文），`secret.json` 里有 deepseek key。**因此 openai 非流式路径（translate 用）已被真实验证过**；本文对「零验证」的判断只对 anthropic / gemini / 流式三条路径成立。

## findings

按严重度降序。每条都给出「如果真实调用，会怎么坏」的预言，便于下一轮带 key 逐条打钩。

---

### F1（high）流中中止/超时抛裸 `AbortError`，前端收到 `code:20`

**现象**：`httpJson` 的 `try/catch` 只包住 `fetch`（`client.js:74-80`），**`res.text()` 在 catch 之外**（81）；`sseEvents` 整个生成器没有任何 `try/catch`（272-299）。于是两类中止——`AbortSignal.timeout()` 到期、上层 `ctl.abort()`——都会让 `res.text()` / `reader.read()` reject 一个 `DOMException(AbortError)`，而 `E_CANCELED`/`E_TIMEOUT` 的映射只发生在 fetch 阶段，接不到这个错误。

**证据**：
- `client.js:81` — `const text = await res.text();`（不在 try 内）
- `client.js:273` — `const reader = res.body.getReader();`
- `client.js:277` — `const { value, done } = await reader.read();`（整个 `sseEvents` 272-299 无 try/finally）
- 上游这一层：`client.js:313-315` 已把 fetch 阶段的 `TimeoutError`/`AbortError` 归一化，说明**作者知道要归一化，只是漏了 body 阶段**

**动态验证**（`a11_probe3.mjs`，假 fetch + body 不吐字节，`timeoutMs=120`）：
```
### N 非流式：连上但不吐 body（timeoutMs=120）
  fake-fetch: hasSignal= true aborted= false
  fake-fetch: abort event fired at body level
{"settled":"rejected","THREW":"DOMException","code":20,"name":"AbortError","message":"The operation was aborted."} elapsed= 130
```
流中 abort（`a11_probe2.mjs`，abort-aware 假流）：
```
### H2 流中 abort（abort-aware 假流）→ 抛出什么
{"THREW":"DOMException","code":20,"name":"AbortError","message":"The operation was aborted.","deltasSeen":2,"elapsed":66}
```
对照：**调用前**已 abort 时是正确的（`{"settled":"rejected","THREW":"AppError","code":"E_CANCELED","message":"请求已取消"}`，`a11_probe3.mjs` P 用例）。

**影响（如果真实调用会怎么坏）**：`agent.js:108` 的「整轮 90s 上限」与用户点「停止」（`agent.js:68-73 cancelTurn`）都走 `ctl.abort()`；异常在 `agent.js:233` 被 `const code = e.code || (clientClosed ? 'E_CANCELED' : 'E_UPSTREAM');` 接住——`DOMException.code` 是**数字 20 且 truthy**，于是 `code=20` 一路穿透：SSE 下发 `event: error` / `data: {"code":20,"message":"The operation was aborted."}`，同时 `persistAssistant({ truncated:false, errorCode:20 })` 把 20 写进 `messages.prompt_tokens` 旁边的错误字段。前端拿到一个它不认识的数字码 → 落到通用错误提示；`E_CANCELED`(409) / `E_TIMEOUT`(504) 的语义全丢。非流式（翻译）超时同样：`res.text()` 抛 AbortError → `withRetry` 看不到 `E_TIMEOUT`（不重试）→ `errors.js:57-63` 归一化成 `E_INTERNAL` 500「未分类的服务端异常」，用户等 60s 后看到 500。
附带风险：`postStream` 没有默认超时（`client.js:301-302` 只透传 `p.timeoutMs`，对比 `httpJson:64` 的 `|| 60000`），一旦调用方不传（如 `streamChat` 的 gemini 分支 `client.js:453` 就没传）就**永久挂起**——探针 G 实测 3s 后仍 `STILL-HANGING`。

**建议**：把 `res.text()` 与整个 `for await` 包进 `try/catch`，统一收口：
`if (opts.signal?.aborted) throw new AppError('E_CANCELED',…); if (e.name === 'AbortError' || e.name === 'TimeoutError') throw new AppError('E_TIMEOUT',…)`；`agent.js:233` 改成 `typeof e.code === 'string' ? e.code : (clientClosed ? 'E_CANCELED' : 'E_UPSTREAM')`；`postStream` 补 `timeoutMs || config` 级默认值。

**effort**：S（三处各 5-10 行）。

---

### F2（high）`[DONE]` 与异常退出都不 `cancel()` reader，连接与计费都不收尾

**现象**：`sseEvents` 是 async generator，**没有 `finally`**；`openaiChatStream` 在 `[DONE]` 上 `break`（362），for-await 只会调用 `generator.return()`，`res.body.getReader()` 拿到的 reader 从未 `cancel()`/`releaseLock()`。`onDelta` 抛错、上层 abort、`E_UPSTREAM` 空内容抛错，三条异常路径同样不 cancel。

**证据**：
- `client.js:362` — `if (data === '[DONE]') break;`
- `client.js:272-299` — 全函数无 `finally`，无 `reader.cancel()`、无 `reader.releaseLock()`。

**动态验证**（`a11_sse_probe.mjs` F 用例：30ms 慢时钟流，末尾 `[DONE]`，`[DONE]` 之后还有 keep-alive）：
```
### F break 后底层 reader 是否 cancel/释放
{"text":"partial","streamRecord":{"start":true}}
```
`streamRecord` 只有 `start`，没有 `canceled` —— 底层 `ReadableStream` 没有被取消。

**影响（如果真实调用会怎么坏）**：每一轮对话（含正常结束）都留一个未消费完的 SSE 响应体。正常 `[DONE]` 时上游已发完，浪费的是连接与 fd；**用户中途「停止」时后果是钱**：`ctl.abort()` 使 fetch 失败，但 reader 不 cancel，上游（DeepSeek/OpenAI）继续生成到 `max_tokens`，这部分照样计费，而系统只知道「已取消」。连续使用/频繁取消时 socket 与内存单调增长；网关侧对「半读连接」通常按进行中计入并发配额。

**建议**：`sseEvents` 改成
`try { for(;;){…} } finally { try { await reader.cancel(); } catch {} }`，
并在 `[DONE]` 分支不 break 而是 `await reader.cancel(); break;`（或统一靠 finally）。顺带补 `releaseLock()`。

**effort**：S。

---

### F3（medium）分帧只认 `\n\n`：CRLF 上游会让整条流归零

**现象**：`sseEvents` 用 `buf.indexOf('\n\n')` 找事件边界，只认 LF。若上游按 `\r\n` 分行（HTTP 规范允许，部分网关/反向代理/自建推理服务默认 CRLF），边界永远匹配不到；缓冲一路累积到流结束，落到 292-298 的**残留分支**：把整个流当成一个事件，所有 `data:` 行 `join('\n')` 后 `JSON.parse` 必然失败 → `continue` 吞掉 → 0 个 delta。

**证据**：`client.js:280` — `let idx = buf.indexOf('\n\n');`（289 行同样）；残留分支 `client.js:292-298`。

**动态验证**（`a11_sse_probe.mjs` B 用例，同一条流的行尾从 LF 换成 CRLF）：
```
### A 正常LF + tool_calls 分 index 累积 → text "ok"（正常）
### B CRLF(\r\n\r\n) 分帧
{"THREW":"AppError","code":"E_UPSTREAM","message":"LLM 流式返回空内容"}
```
同一批用例里其余四类分帧**都正确**，逐条对照结论：

| 场景 | 结论 | 证据 |
|---|---|---|
| (a) 一个 chunk 里半行 | ✅ 正确（buffer 拼接，只按空行交付） | D：中文多字节按 5 字节切开仍得 `中文引号「测试」✓` |
| (b) 一个事件跨多个 chunk | ✅ 正确 | D 同上 |
| (c) 多事件挤一个 chunk | ✅ 正确（`while (idx >= 0)` 循环） | E → `text "XY"` |
| (d) `data: [DONE]` | ✅ 正确（`data === '[DONE]'` 精确 break） | F 用例返回 `"partial"` 后停止 |
| (e) `: keep-alive` 注释行 | ✅ 正确（`filter(l => l.startsWith('data:'))` 丢弃） | C → `text "ab"` |
| (f) CRLF 行尾 | ❌ **整条流失败** | B → `E_UPSTREAM 空内容` |

**影响（如果真实调用会怎么坏）**：上游正常生成、正常计费，用户界面**一个字都不显示**，只得到「LLM 流式返回空内容」。因为翻译走非流式，症状会呈现为「翻译一切正常、一问一答全挂」，极易被误判成密钥/模型问题；日志里没有上游报文，只能抓包。换网关或加一层企业代理就能触发。

**建议**：每轮 `buf += decoder.decode(...)` 之后立刻 `buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n')`（在找边界前），或把边界改为 `/\r?\n\r?\n/` 的 `search`；残留分支也改成同样的事件解析而不是整段 join。

**effort**：S。

---

### F4（medium）Claude 流式：system 被删、tools 不转发、`finishReason` 恒 `null`

**现象**：`anthropicChatStream` 确实支持顶层 `p.system`（417 行），但**所有调用方都把 system 放在 `messages[0]`**（`chat/pipeline.js:136` `const messages = [{ role: 'system', content: system }];`），而 418 行把 role=system 的消息**直接过滤丢弃**，也不提升到顶层 `system`。body 里没有 `tools` 字段（412-419），也不解析 `content_block_start`/`input_json_delta`；返回 `finishReason: null` 写死（441），不读 `message_stop`、不处理 `type==='error'`。

**证据**：
- `client.js:418` — `messages: p.messages.filter((m) => m.role !== 'system'),`
- `client.js:441` — `return { text, promptTokens, completionTokens, finishReason: null, latencyMs: Date.now() - t0 };`

**动态验证**（`a11_sse_probe.mjs` L 用例：传入 `messages=[{role:'system'},…]` + `tools=[…]`）：
```
"sentBody": {"model":"claude-sonnet-4","max_tokens":1600,"temperature":0.3,"stream":true,
             "messages":[{"role":"user","content":"hi"}]},
"headers": {"Content-Type":"application/json","x-api-key":"sk-ant-fake-A11","anthropic-version":"2023-06-01"},
"out": {"text":"hi","promptTokens":5,"completionTokens":7,"finishReason":null,"latencyMs":0}
```
**system 与 tools 都没有出现在 body 里**，`finishReason` 为 null。

**影响（如果真实调用会怎么坏）**：填上 claude key 之后，聊天回复的人格/引用格式/语言约束（system 里那几百字，含 `[p1#5]` 引用协议）全部失效 —— 模型按裸问题回答，前端 `parseCitations` 解析不到引用，`assembleCitations` 拿到空数组，回答里挂着「未找到依据」；tool 调用永远为空（`out.toolCalls` 不存在）；`max_tokens` 截断与正常结束无法区分，长答案被腰斩也不报错。属于「配好 key 就必然坏」的路径。

**建议**：入口处统一 `const sysMsg = p.system || (p.messages.find(m => m.role === 'system') || {}).content;`，放进顶层 `system`，再从 messages 里剔除；转发 `tools` 并解析 `content_block_start`（tool_use）+ `input_json_delta`；`finishReason` 取 `message_delta.delta.stop_reason`；`json.type === 'error'` 抛 `E_UPSTREAM`。

**effort**：M。

---

### F5（medium）工具循环硬编码 OpenAI 流式接口，绕过协议分派

**现象**：`loop.js` 直接 `import { openaiChatStream }`，每轮都调它，完全不经过 `streamChat`（`client.js:448-457` 的 `protocol` 分派）。provider=claude/gemini 时，请求会打到 `${baseUrl}/chat/completions`（Anthropic 是 `/v1/chat/completions`，根本不存在）。

**证据**：`03-code/server/services/chat/loop.js:49-52`
```js
const call = (withTools) =>
  openaiChatStream({
    provider,
    model,
    messages,
```

**动态验证**（间接、代码级）：探针 L/M 证明 —— `anthropicChatStream` 收到 `tools` 直接丢弃；`streamChat({provider:'gemini', tools})` 走 `geminiChat` 后 `out` 里没有 `toolCalls`（`a11_sse_probe.mjs` M：`"out": {"text":"答案"}`）。claude 分支的真实 404 未打（无 key，见盲区），但 URL 由 `resolveProvider('claude').baseUrl = 'https://api.anthropic.com/v1'` 拼 `/chat/completions`，路径不存在是确定的。

**影响（如果真实调用会怎么坏）**：`chat.engine=tools` + provider=claude/gemini 时，工具对话 100% 失败，用户看到的是 `E_UPSTREAM 'LLM 返回 HTTP 404：<上游 HTML/JSON 片段>'`；日志同款文案，没有任何线索指向「协议用错了」。gemini 更隐蔽：即便把分派改对，`geminiChat` 也不支持 tools（`client.js:451-455` 把 messages 压成一段文本），工具调用会静默消失、模型只能瞎猜。

**建议**：`loop.js` 改为调 `streamChat`（并让 `anthropicChatStream` 支持 tools）；在 `runToolLoop` 入口对 `resolveProvider(provider).protocol !== 'openai-chat'` 的 provider 显式抛 `E_ENGINE_UNCONFIGURED('该 provider 暂不支持工具调用')`，而不是发一个必然 404 的请求。

**effort**：M。

---

### F6（medium）重试策略三层不一致：4xx 也重试、`Retry-After` 无视、流式零重试、翻译双层叠加

**现象**：
1. 所有非 429 的 4xx 都被归一成 `E_UPSTREAM`（`client.js:88-92`），而 `E_UPSTREAM` 在 `RETRYABLE` 里 → **400/401/403/404 也会重试 1 次**，与文件头 9 行「4xx（除 429）不重试」直接矛盾。
2. 重试等待是**固定 1s**，从不读 `Retry-After`（138-139），也不带抖动。
3. 流式出口 `postStream`（301-324）**没有 `withRetry`**：瞬时 5xx/断连在对话路径上一次就死。
4. `translate/pipeline.js:214-248` 在 client 之外又套了 `for attempt 1..2`，每层都拿满 client 的 1 次重试 → **单批最多 4 次上游请求**。

**证据**：
- `client.js:116` — `const RETRYABLE = new Set(['E_RATE_LIMITED', 'E_UPSTREAM', 'E_NETWORK', 'E_TIMEOUT']);`
- `client.js:138-139` — `log.warn('llm.retry', { code, attempt: i + 1, retryDelayMs: opts.retryDelayMs ?? 1000 }); await sleep(opts.retryDelayMs ?? 1000);`

**动态验证**（`a11_sse_probe.mjs` I/J/K + `a11_probe3.mjs` R/S）：
```
### I HTTP 400 是否重试（fetch 次数）        {"fetchCalls":2,"code":"E_UPSTREAM","message":"LLM 返回 HTTP 400：invalid model"}
### J 429 + Retry-After=7 的重试间隔          {"fetchCalls":2,"code":"E_RATE_LIMITED","waitedMs":1012}
### K HTTP 500 重试次数                      {"fetchCalls":2,"code":"E_UPSTREAM","message":"LLM 返回 HTTP 500：bad thing"}
### R 流式出口 HTTP 500 是否重试              {"code":"E_UPSTREAM","message":"LLM 返回 HTTP 500：boom","fetchCalls":1}
### S 流式出口 HTTP 429                      {"code":"E_RATE_LIMITED","message":"LLM 限流（429）"}（detail 无 retry-after）
```
`retry-after: 7` 只等了 **1012ms**；400 被重试；流式 500 一次不重试。

**影响（如果真实调用会怎么坏）**：模型名写错/欠费/参数不合法这类**永远不会成功的 4xx** 被无意义重放，用户多等 1s+、账单页/网关日志里多一条请求；429 后 1 秒硬闯，把限流窗口越撞越长（翻译 2 并发 × 2 层重试放大到 4 倍瞬时压力，可能触发更长的封禁）；反过来，对话流式遇到瞬时 5xx 直接失败而翻译能扛过 —— 同一个上游抖动下「翻译成功、问答失败」。非幂等的对话在 withRetry 层被重放 1 次，翻译链路每次 attempt 都是**一次独立的完整生成**（不是续传），5xx 若发生在生成之后，重复计费与重复回答都真实存在。

**建议**：新增不可重试码（4xx → `E_BAD_UPSTREAM`，`RETRYABLE` 只留 429/5xx/网络/超时）；`const ra = Number(res.headers.get('retry-after')); await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : base)` 并加抖动；流式在「还没吐任何 delta 且无 toolCalls」时允许重试 1 次；`translateBatch` 传 `retry:false`（client 已支持 `p.retry === false`，`openaiCompatible.js:36-44` 目前没传），把重试收敛到唯一一层。

**effort**：M。

---

### F7（medium）流内 `error` 事件与结束原因被静默吞掉，截断当成功

**现象**：`openaiChatStream` 只读 `choices[0].delta.content`、`tool_calls`、`usage`；上游在流中下发 `data: {"error":{...}}`（内容过滤、参数错误、过载）时没有 `choices` → `choice` 为 undefined → 直接走到下一轮；循环结束只看「有没有文本」，有文本就返回成功。

**证据**：`client.js:369-374`
```js
const choice = json.choices && json.choices[0];
const delta = choice && choice.delta && choice.delta.content;
if (delta) {
  text += delta;
  if (p.onDelta) p.onDelta(delta);
}
```
（全函数没有 `json.error` 分支；`[DONE]` 与 `finish_reason` 只被记录，不驱动任何行为。）

**动态验证**（`a11_probe3.mjs` Q 用例：先来一个 delta，再来 `data: {"error":{"message":"content filter triggered",…}}`）：
```
### Q 流中上游下发 {"error":{...}} 事件
{"settled":"resolved","v":{"text":"部分","promptTokens":null,"completionTokens":null,"finishReason":null,"toolCalls":[]}}
```
上游错误**完全消失**，且被当作成功返回。

**影响（如果真实调用会怎么坏）**：被内容策略截断的回答会当正常回答入库、展示、并（在 agent 路径里）参与后续摘要压缩，用户以为模型答完了；OpenAI 的 `finish_reason:"length"` 不会触发任何「已达上限」提示，长回答腰斩无告警；DeepSeek 若在流尾不带 usage chunk（探针场景），本次调用 token 全为 null 但仍算成功。排障时日志里只有 `translate/chat finished`，没有上游原因。

**建议**：解析到 `json.error` 就 `throw new AppError('E_UPSTREAM', summarizeUpstream(json, ''), { provider })`；`finish_reason === 'length'` 时在返回值里加 `truncated:true` 让上层提示；`[DONE]` 之前从未见到完成信号时按异常结束处理。

**effort**：S。

---

### F8（medium）多轮工具对话 usage 覆盖而非累加，记账系统性偏低

**现象**：`runToolLoop` 每轮把 `out.promptTokens` **赋值**给 `promptTokens`（不是相加），而文本 `text` 是累加的；`quotaHit` / `roundsExhausted` 两条出口（147、156）同样覆盖。对照翻译侧：`pipeline.js:379-380` 是 `usage.promptTokens += u.promptTokens || 0`（正确累加）。

**证据**：`03-code/server/services/chat/loop.js:69-70`
```js
promptTokens = out.promptTokens == null ? promptTokens : out.promptTokens;
completionTokens = out.completionTokens == null ? completionTokens : out.completionTokens;
```
**动态验证**：纯静态（赋值链清楚，无需运行时）；对照 `03-code/server/services/translate/pipeline.js:379-380`。

**影响（如果真实调用会怎么坏）**：一次 5 轮工具问答，前 4 轮「带着工具结果整段重发上下文」的 prompt token 全部丢失，`messages` 表（`session.js:150-151` 写 `prompt_tokens`/`completion_tokens`）只记最后一轮；而最后一轮的 prompt 通常是最大的 → 记账可能既非总量也非均值，成本统计、配额判断、前端「本次消耗」全部失真。翻译侧同一数据库里是准的，两者不可比。

**建议**：`promptTokens = (promptTokens || 0) + (out.promptTokens || 0)`（两者都为 null 时保持 null），并把 `rounds`、每轮 latency 一起记进 usage。

**effort**：S。

---

### F9（low）日志脱敏可能产出非法 JSON，`JSON.parse` 无保护 → 记日志自身抛异常

**现象**：`write()` 用 `JSON.parse(redact(fields))` 重建字段；`REDACT_RULES` 第三条把 `api_key=xxx` / `authorization: xxx` 整体换成 `$1:"***REDACTED***"`。当这些字样出现在**普通字符串值内部**（上游错误体被 `e.message` 带进来时就是），替换后引号不配对 → `JSON.parse` 抛 `SyntaxError`，而 `write()` 没有任何兜底。

**证据**：
- `03-code/server/logger.js:59` — `fields: fields && typeof fields === 'object' ? JSON.parse(redact(fields)) : fields ?? undefined,`
- `03-code/server/logger.js:14` — `[/"?(api[_-]?key|authorization|apikey)"?\s*[:=]\s*"?[^",\s}]+"?/gi, '$1:"***REDACTED***"'],`

**动态验证**（`a11_logger_probe.mjs`，真实 import `logger.js`）：
```
trailing-backslash  => JSON.parse THREW: Unexpected token 'a', ...""message":api_key:"*"... is not valid JSON
quoted-key-eq       => JSON.parse THREW: Unexpected token 'a', ...""message":api_key:"*"... is not valid JSON
bearer              => JSON.parse THREW: Unexpected token 'A', ...""message":Authorizat"... is not valid JSON
upstream-body-with-key => OK   （带转义引号的 JSON 片段反而安全）
newline-and-quote      => OK
chinese-prompt         => OK
```
好消息：**prompt 正文/图片 data URI 不会被写进日志**（`llm.retry` 只记 `code/attempt/retryDelayMs`；`chat.turn_failed` 只记 `chatId/code/message/keptChars`；全仓 grep 没有把 content/messages 塞进 log 的调用点）。

**影响（如果真实调用会怎么坏）**：某些自建代理/免费网关的 4xx 错误体里带 `api_key=...` 或 `Authorization: Bearer ...` 原文，它经 `summarizeUpstream` 进 `e.message`，再被 `chat.turn_failed`/`translate.batch_attempt_failed` 记录 → logger 在 catch 块里抛 `SyntaxError` → 原始错误被替换、日志丢失、SSE 里下发 500。正好是「故障排查时把故障放大」。同时注意：`client.js:91-92` 把上游 body 摘要（≤300 字）塞进**返回给前端的 message**，这是既有设计（便于自诊），本次不作为缺陷，但和本条叠加会让上游细节出现在浏览器与磁盘两处。

**建议**：`try { parsed = JSON.parse(redact(fields)); } catch { parsed = redact(fields); }`（退回纯字符串），或改成「遍历 JSON 树的字符串值逐个脱敏再 stringify」。

**effort**：S。

---

### F10（low）`engines/test` 无超时、错误误导：baseUrl 拼错时只能说「空内容」

**现象**：`testEngine` 调 `engine.translate` 时不传 `timeoutMs`/`signal`（709-719），而 client 对非流式的默认是 60s（64 行）**再加 1 次重试** → 连通性测试最长约 121s 才失败；若 baseUrl 指向一个返回 200 HTML 的地址（门户页、反代默认页），链路只会在 `openaiChat:178` 报「LLM 返回空内容」。

**证据**：
- `03-code/server/services/translate/pipeline.js:713-718` — `const out = await engine.translate([text], { srcLang: 'auto', tgtLang: …, promptFp: promptFingerprint(resolveTemplate(config)), model: resolveModel(engine.id) });`（无 `timeoutMs`、无 `signal`）
- `client.js:178` — `if (!text) throw new AppError('E_UPSTREAM', 'LLM 返回空内容', { provider: prov.id, model: p.model });`

**动态验证**（`a11_probe3.mjs` O 用例，200 + HTML）：
```
### O 200 + HTML（baseUrl 指错站点）
{"settled":"rejected","THREW":"AppError","code":"E_UPSTREAM","name":"AppError","message":"LLM 返回空内容"}
```
另外：真实 `POST /api/translate/test {"engine":"claude"}` 无 key 时 `http_code=400 time_total=0.001743s`，说明**无 key 在发请求之前就短路了**（`requireEngine` 先抛），这条路径是对的；有 key 但 baseUrl 拼错才会落入上面那个误导性错误。

**影响（如果真实调用会怎么坏）**：设置页点「测试连接」，用户看到的要么是空白等待 1-2 分钟然后「LLM 返回空内容」（完全指不到 baseUrl 写错），要么是上游 HTML 片段；`_context.md` 里「配置错误应可自诊」的意图在这条路径上没达成。

**建议**：`testEngine` 传 `timeoutMs: 8000, retry: false`（client 已支持）；`openaiChat` 空内容时检查 `content-type`/响应体前 120 字，若是 HTML 就给「上游返回了 HTML（baseUrl 可能指向了网站首页/反代页面）」；并在 detail 里带 `url: safeUrl`（已存在，接上即可）。

**effort**：S。

---

## 覆盖与盲区

**已覆盖（有明确结论，含动态证据）**
- 五类 SSE 分帧场景（半行/跨 chunk/多事件/[DONE]/注释行）逐条对照，另加 CRLF 与 UTF-8 多字节跨界（探针 A–F）。
- `tool_calls` 按 index 累积：**实现正确**（探针 A：多参数工具 `{"workNo":"A001","pageNo":3}` 完整还原）。附带记一笔：`loop.js:92-97` 对坏 JSON `catch { args = {} }` 会静默空参，但这是 loop 的地方，非 client。
- 三家协议：body 字段、鉴权头（`Bearer`+`api-key` / `x-api-key`+`anthropic-version` / `?key=`）、`max_tokens` 必填性（OpenAI 可选、Anthropic 默认 4096/1600）、取文本字段（`choices[0].message.content` / `content.parts[].text` / 按 `type==='text'` 拼接）、usage 字段名（`prompt_tokens` / `usageMetadata.promptTokenCount` / `input_tokens`）**全部正确**；错的是 system 位置接线与流式分支的 tools。
- 重试/超时/取消/usage/日志落盘/无 key 短路，全部有运行时证据（见下一节）。
- 与 translate/engines 的重复：**没有第二份 fetch/SSE 实现**，engines 三个适配器都委托 client.js；重复只在「重试策略」（client 1 次 + pipeline 2 次）。收敛方案见 F6 建议。

**盲区（未验证，下一轮带 key 时优先补）**
1. **未对真实 Anthropic / Gemini 端点发起任何请求**（无 key）。F4/F5 的协议差异是「代码 + 官方文档」比对 + 假 fetch 断言 body 得出；claude/gemini 的真实 SSE 帧（`ping` 事件、`content_block_start` 顺序）未实测。
2. **未制造真实 429**（不敢对线上 DeepSeek 账号刷限流），`Retry-After` 是假 fetch 注入响应头证明的；`Retry-After` 也可能是 HTTP-date 格式，当前实现连数值形态都不读，结论不受影响。
3. **未验证多模态图片链路**：`chat/pipeline.js:152-159` 把图片拼 `data:${mt};base64,…`，但 DeepSeek 的 chat 不接受图片 part，前端是否拦截未查（属对话代理范围）。日志侧已确认 data URI 不入盘。
4. **budget/配额模块是否消费 usage 未确认**：只确认 `session.js:150-151` 会把 usage 落库；若配额按 token 判定，F8 的偏差会传导到配额。
5. **未跑 04-test**：本次全程只读 + 临时探针（探针只写 `%TEMP%`），没有执行仓库测试（避免写 `03-code/data/`）。
6. **web 前端对 `code:20` 的处理**未审（`web/` 属其他代理范围），F1 的用户可见后果按「前端会遇到未知数字码」推断。

## 动态验证记录

环境：`node v24.19.0`（Windows）。所有探针通过 `import` 真实 `03-code/server/services/llm/client.js`、在内存里替换 `globalThis.fetch` 与 `secrets.providers.*`，**不写仓库、不发真网络**（baseUrl 指向 `http://127.0.0.1:9`）。

### 1) 静态基线

```
$ certutil -hashfile server\services\llm\client.js SHA256
91e3a5b50dd74a0505f324def0e21861ba01cc676b13aa03d303cae3d472227e   （client.js，458 行）
$ Get-ChildItem data\logs → app-2026-11-03.log 96316B（今日日志；grep 'module":"llm"' 无命中，说明流式路径尚未真实报过错）
```

### 2) SSE 分帧探针 `%TEMP%\a11_sse_probe.mjs`（node v24.19.0）

```
### A 正常LF + tool_calls 分 index 累积
{"text":"ok","toolCalls":[{"id":"call_1","name":"lit_read","arguments":"{\"workNo\":\"A001\",\"pageNo\":3}"}],"usage":[11,22],"fetchCalls":1}
### B CRLF(\r\n\r\n) 分帧
{"THREW":"AppError","code":"E_UPSTREAM","message":"LLM 流式返回空内容","detail":{"provider":"deepseek"}}
### C keep-alive 注释行
{"text":"ab"}
### D 事件跨 chunk / 中文多字节跨界
{"text":"中文引号「测试」✓"}
### E 一个 chunk 里多个事件
{"text":"XY"}
### F break 后底层 reader 是否 cancel/释放
{"text":"partial","streamRecord":{"start":true}}          ← 没有 canceled
### G 上行连上但不吐数据（未传 timeoutMs）
{"won":"STILL-HANGING-after-3s","elapsed":3014}            ← 无超时，永久挂起
### H 流中 abort（旧版用例，假流不感知 signal，结论作废，改用 probe2 的 H2）
{"resolved":true,...}
### I HTTP 400 是否重试（fetch 次数）
{"fetchCalls":2,"code":"E_UPSTREAM","message":"LLM 返回 HTTP 400：invalid model"}
### J 429 + Retry-After=7 的重试间隔
{"fetchCalls":2,"code":"E_RATE_LIMITED","waitedMs":1012}
### K HTTP 500 重试次数
{"fetchCalls":2,"code":"E_UPSTREAM","message":"LLM 返回 HTTP 500：bad thing"}
### L anthropic 流：messages 里的 system 去哪了
{"sentBody":{"model":"claude-sonnet-4","max_tokens":1600,"temperature":0.3,"stream":true,
             "messages":[{"role":"user","content":"hi"}]},
 "headers":{"Content-Type":"application/json","x-api-key":"sk-ant-fake-A11","anthropic-version":"2023-06-01"},
 "out":{"text":"hi","promptTokens":5,"completionTokens":7,"finishReason":null,"latencyMs":0}}
### M gemini 协议走 streamChat 时被压平的消息
{"requestedUrlHostPath":"http://127.0.0.1:9/v1beta/models/gemini-2.0-flash:generateContent?key=***",
 "sentBodyKeys":["contents","generationConfig"],
 "contents":[{"role":"user","parts":[{"text":"system: SYS-PERSONA\n\nuser: Q1"}]}],"out":{"text":"答案"}}   ← 无 toolCalls
[stderr] 三条 {"module":"llm","event":"llm.retry","fields":{"code":"…","attempt":1,"retryDelayMs":1000}} —— 证明重试日志不含 prompt
```

### 3) abort / body 读超时 / HTML 探针

`%TEMP%\a11_probe2.mjs`（abort-aware 假流）：
```
### H2 流中 abort（abort-aware 假流）→ 抛出什么
{"THREW":"DOMException","code":20,"name":"AbortError","message":"The operation was aborted.","deltasSeen":2,"elapsed":66}
Warning: Detected unsettled top-level await at …（N 用例在没有 abort 感知的假流上挂住，改用 probe3 重测）
```

`%TEMP%\a11_probe3.mjs`：
```
### N 非流式：连上但不吐 body（timeoutMs=120）
  fake-fetch: hasSignal= true aborted= false
  fake-fetch: abort event fired at body level
{"settled":"rejected","THREW":"DOMException","code":20,"name":"AbortError","message":"The operation was aborted."} elapsed= 130
### O 200 + HTML（baseUrl 指错站点）
{"settled":"rejected","THREW":"AppError","code":"E_UPSTREAM","name":"AppError","message":"LLM 返回空内容"}
### P 调用前 signal 已 abort
{"settled":"rejected","THREW":"AppError","code":"E_CANCELED","name":"AppError","message":"请求已取消"}
### Q 流中上游下发 {"error":{...}}
{"settled":"resolved","v":{"text":"部分","promptTokens":null,"completionTokens":null,"finishReason":null,"toolCalls":[]}}
### R 流式出口 HTTP 500 是否重试
{"code":"E_UPSTREAM","message":"LLM 返回 HTTP 500：boom","fetchCalls":1}
### S 流式出口 HTTP 429
{"code":"E_RATE_LIMITED","message":"LLM 限流（429）"}
```

### 4) 日志脱敏探针 `%TEMP%\a11_logger_probe.mjs`

```
trailing-backslash  => JSON.parse THREW: Unexpected token 'a', ...""message":api_key:"*"... is not valid JSON
quoted-key-eq       => JSON.parse THREW: Unexpected token 'a', ...""message":api_key:"*"... is not valid JSON
bearer              => JSON.parse THREW: Unexpected token 'A', ...""message":Authorizat"... is not valid JSON
upstream-body-with-key => OK
newline-and-quote      => OK
chinese-prompt         => OK
```

### 5) 对运行中实例的只读 curl（未启停服务）

```
$ curl -s http://127.0.0.1:7317/api/translate/engines
[{"id":"deepseek","name":"DeepSeek","needsKey":true,"configured":true,…,"model":"deepseek-chat",…
 {"id":"qwen",…"configured":true,…,"model":"qwen-plus",…
 {"id":"openai",…"configured":false…},{"id":"gemini",…"configured":false…},{"id":"claude",…"configured":false…}]

$ curl -s -w '[http_code=%{http_code} time_total=%{time_total}s]' -X POST /api/translate/test -d '{"engine":"deepseek"}'
{"ok":true,"engine":"deepseek","model":"deepseek-chat","sample":"敏捷的棕色狐狸跃过那只懒狗。","latencyMs":776}
[http_code=200 time_total=0.778058s]        ← 真实出站调用，非 mock

$ curl -s -w '[http_code=%{http_code} time_total=%{time_total}s]' -X POST /api/translate/test -d '{"engine":"claude"}'
{"error":{"code":"E_LLM_KEY_MISSING","message":"引擎「Claude」未配置 apiKey（请在设置页填写）","detail":{"engine":"claude"},"traceId":"4ee706e9"}}
[http_code=400 time_total=0.001743s]        ← 无 key 在发请求前短路（1.7ms，未触网）

$ curl -s /api/settings | …  → llm.provider=deepseek, providers.deepseek={baseUrl:"https://api.deepseek.com",hasKey:true,apiKeyMasked:"sk-…0962"},
                               providers.qwen={baseUrl:"",hasKey:true,apiKeyMasked:"sk-…GDbQ"}, engines={}
$ curl -s /api/health → {"ok":true,"version":"1.0.0-m1","dbDriver":"node:sqlite","works":424,…}
```

### 6) 基线核对

```
$ Get-Item data\secret.json  → LastWriteTime 2026/11/3 20:32:53（有 key）
$ Select-String data\logs\app-2026-11-03.log -Pattern 'translate|llm|settings.secret'
  … translate.start {jobId:38,"no":"1.8","engine":"deepseek","model":"deepseek-chat","total":285…}
    translate.finished {jobId:38,…,"cacheHits":285,"batches":0,"requests":0…}      ← 全缓存命中，未触网
    … request.rejected {path:"/api/translate/test","code":"E_LLM_KEY_MISSING","message":"引擎「Claude」未配置…"}
```
结论：`STATUS.md:155`「真实引擎无 key、未验证」已过期 —— deepseek 非流式路径今天真实跑通过（0.78s 返回译文），本轮 F1/F3/F6/F7 对流式的结论仍缺真实上游证据。
