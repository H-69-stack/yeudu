# A07 错误处理 / 超时 / 取消 / 故障恢复

审计对象：`03-code/server`（Express 4 + node:sqlite，Node v24.19.0），只读审计 + 对 7317 端口做只读 curl 探针。
工作量：全仓 catch 分类（非测试 139 处）、异常出口与 logger 精读、6 条状态机/恢复路径核对、5 组动态验证。

## 结论

1. **错误兜底在"最后一米"是缺的**：工具层把所有异常吞成一行模型可见文本、registry.js 全文没有 logger；进程级没有 `unhandledRejection`/`uncaughtException` 处理器（Node 24 实测直接 exit 1，且日志不留痕）。
2. **取消是"半传递"**：HTTP→pipeline→LLM fetch 这一段有 AbortController 且有效；但 agent 工具（loop.js:91-99）不检查 signal，精排（refine.js:339）把 abort 变成 `break` 后**照常落库**并把状态改写回 `done`。
3. **状态机有三处漏恢复**：`assets.extract_status='extracting'` 无启动恢复（永久卡死）、下载的 `verifying` 全程不可达、layout 任务纯内存且任意 id 都能造出永不推进的 `queued` 幻影（已动态复现）。
4. **SSE 是"永不结束"的**：任务 done 之后连接仍挂着走 15s 心跳（已复现，curl 5s 超时未关），因此 `server.close()` 必然挂到 5s 兜底 `process.exit(0)`，`closeDb()/closeLogger()` 被跳过。
5. **超时矩阵有一格是空的**：PDF 抽取（`routes/segments.js:29 → extractor.js:187`）既无超时也拿不到 signal，且 `readFileSync` 同步读全文件；其余 LLM/下载/工具/DB 都有值（见下方矩阵）。

## findings

### 1. 工具层把所有异常吞成"模型可见的一句话"，日志零记录 [high]

**现象**：`registry.run()` 的 catch 把任何异常变成 `{ok:false, error:e.message}` 交给模型，不写日志、不写 stack；`03-code/server/services/chat/registry.js` 全文没有 `createLogger`。同一个 `for (const c of calls)` 循环里不检查 `signal.aborted`，`toolCtx` 里也没有 signal。

**证据**（`03-code/server/services/chat/registry.js:230-238`）：
```js
      } catch (e) {
        const aborted = e && (e.code === 'E_CANCELED' || e.name === 'AbortError');
        return {
          ok: false,
          error: String(e && e.message ? e.message : e),
          errorCode: aborted ? TOOL_ERROR.ABORTED : null,
          ms: Date.now() - t0,
        };
      }
```
（`03-code/server/services/chat/loop.js:91-99`：`for (const c of calls) {` … `const r = await registry.run(c.name, args, toolCtx);`）

**影响**：工具内部的真实缺陷（TypeError、`E_PATH_OUT_OF_SCOPE`、磁盘满、Playwright 崩溃）只以一行中文进入对话，`data/logs/app-*.log` 里查不到任何一行。用户报"AI 说读不了这页"时，日志无法回答是路径越界还是渲染器没装。取消同理：点停止后本轮剩余工具照跑（最多 8 个），其中 `lit_update_note` 会**继续写笔记**。

**建议**：catch 里 `log.error('tool.failed', {name, code, stack: e.stack})`；`toolCtx` 带上 signal，循环每一步前查 `signal.aborted`；超时改用 AbortSignal 而不是 `Promise.race`（registry.js:118-132 超时后底层 work 仍在跑）。

**effort**：S

### 2. 精排"取消"后照常落库，状态被改写回 done [high]

**现象**：`refineWork` 用 `signal.aborted → break` 退出页循环，但 break 之后照旧执行批量 UPDATE；`runLayoutJob` 见 `out.applied > 0` 就把状态置 `done`，覆盖 `cancelLayoutJob` 刚写下的 `canceled`。

**证据**（`03-code/server/services/layout/refine.js:338-339` 与 `:369-372`）：
```js
  for (let p = 0; p < limit; p += 1) {
    if (opts.signal && opts.signal.aborted) break;
...
  if (!opts.dryRun && toPersist.length) {
    tx(() => {
      const stmt = 'UPDATE segments SET role=?, tier=?, align=?, ratio=?, is_math=? WHERE id=?';
```
（`03-code/server/services/layout/job.js:92`：`runner.status = 'done';`；`:140-145` cancelLayoutJob 先置 canceled）

**影响**：用户点取消后，段属性仍被部分改写（不可回滚），并且状态从 `canceled` 变成 `done`——"取消"变成了"部分应用且显示成功"。日志里 `data/logs/app-2026-11-03.log` 有两条 1.5s 内完全相同的 `layout.refine.persisted {assetId:4, rows:94, applied:69}`（13:07:48.500 / 13:07:49.164），说明同一次精排的落库可以被重复触发。

**建议**：break 后直接 `throw new AppError('E_CANCELED', ...)`（落库前再查一次 aborted）；`runLayoutJob` 收尾时若 `runner.status === 'canceled'` 不覆盖；同一 asset 的 layout job 加互斥/幂等键。

**effort**：S

### 3. 没有 unhandledRejection / uncaughtException，Node 24 直接杀进程 [high]

**现象**：`server/index.js` 全文只有 SIGINT/SIGTERM 两个 process 监听（还有 `server.on('error')` 只设 exitCode 不退出）。`db.js:12` 反而执行 `process.removeAllListeners('warning')`，把进程级监听整体摘掉再装自己的白名单。

**证据**（`03-code/server/index.js:70-77`）：
```js
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
...
main().catch((e) => {
  process.stderr.write(`启动失败：${e.stack || e.message}\n`);
  process.exit(1);
});
```

**影响**：实测 Node v24.19.0 下 `Promise.reject(new Error('boom'))` 无人处理 → 打印堆栈并 **exit 1**（见动态验证记录 1）。服务没有 supervisor/自动重启，所以一个漏 catch 的 promise（例如某个 `.then` 链上抛出的 `JSON.parse` 错误、某个 timer 里的同步 throw）会让整个进程消失：正在跑的下载（DB 里停在 `downloading`）、翻译、所有 SSE 一起断，且 `app-*.log` 里**没有任何记录**，只有启动终端的 stderr。事后无法判断"为什么昨天下午服务挂了"。

**建议**：加 `process.on('unhandledRejection')` / `process.on('uncaughtException')` → `log.error` 带 stack；uncaughtException 后走 `shutdown()` 但保留 exitCode=1；再配一个进程守护（pm2/systemd/nssm）。

**effort**：S

### 4. 非 AppError 的 5xx 把内部英文 message 原样透给前端 [high]

**现象**：`toAppError` 把未知异常的 `e.message` 直接塞进 AppError，errorMiddleware 只清 `detail`、不清 `message`；body-parser 的 `entity.too.large` 没有映射到现成的 `E_TOO_LARGE`。

**证据**（`03-code/server/errors.js:56-65`）：
```js
export function toAppError(e) {
  if (isAppError(e)) return e;
  const err = new AppError(
    e && e.code && ERROR_CODES[e.code] ? e.code : 'E_INTERNAL',
    (e && e.message) || '未知异常',
    null,
  );
```
（`03-code/server/middleware/error.js:45`：`message: appErr.message || ERROR_CODES[appErr.code]?.message || '服务端异常',`）

**影响**：实测 POST 1.2MB JSON 到 `/api/translate/test` → `500 {"code":"E_INTERNAL","message":"request entity too large"}`。正确结果应是 413 `E_TOO_LARGE`；前端按 code 分支永远拿不到体积超限，只能按英文 message 猜。日志侧同时多一条 error 级 + 全栈（含 `D:\...\node_modules\body-parser\...` 绝对路径）。任何 SqliteError/ENOENT 的 message 也会以同样方式透出（`detail` 被清空，`message` 没有）。

**建议**：`isInternal` 时对外 message 固定为 `ERROR_CODES.E_INTERNAL.message`，原文只进日志；给 body-parser 的 `entity.too.large` / `charset.unsupported` / `encoding.unsupported` 加 code 映射。

**effort**：S

### 5. logger 的脱敏规则会把 fields 的 JSON 打坏，日志调用本身抛异常 [medium]

**现象**：`write()` 先 `redact(fields)` 再 `JSON.parse`；规则 3 的替换串 `'$1:"***REDACTED***"'` 把 key 两侧的引号吃掉了，产物不是合法 JSON。

**证据**（`03-code/server/logger.js:14` 与 `:59`）：
```js
  [/"?(api[_-]?key|authorization|apikey)"?\s*[:=]\s*"?[^",\s}]+"?/gi, '$1:"***REDACTED***"'],
...
    fields: fields && typeof fields === 'object' ? JSON.parse(redact(fields)) : fields ?? undefined,
```

**影响**：实测 `log.info('x', {apiKey:'x'})` → `SyntaxError: Expected property name or '}' in JSON at position 1`（动态验证记录 2），且 `write()` 没有 try/catch。当前没有调用点传这种字段名（settings.js:104 只记 `Object.keys(patch.providers)`），所以是**定时炸弹**：一旦有人为了排障写出 `log.error('llm.failed', {apiKey})`（或某处把配置对象整个丢进日志），一次日志调用就会抛异常——而它最常被调用的地方正是各个 catch 和 errorMiddleware，等于"错误处理本身失败"，原始错误被掩盖。

**建议**：先 `JSON.stringify` 再对字符串做替换（或把规则 3 写成 `'"$1":"***REDACTED***"'`）；`write()` 外包 try/catch，日志永不抛。

**effort**：S

### 6. bootDownloader 的 try 只护同步段，catch 分支既不填队列也不 pump [medium]

**现象**：`try { const dir = tmpDir(); return fsp.readdir(dir).then(...).then(...) } catch { booted = true; }`——异步链不在 try 覆盖内；而 catch 命中时既不把 queued 任务推进队列，也不调用 `pump()`。

**证据**（`03-code/server/services/downloader.js:68-82`）：
```js
  try {
    const dir = tmpDir();
    return fsp
      .readdir(dir)
      .then((files) => Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true }))))
      .then(() => {
        for (const j of all("SELECT id FROM download_jobs WHERE status='queued' ORDER BY created_at ASC")) queue.push(j.id);
        booted = true;
        ...
        pump();
      });
  } catch {
    booted = true;
  }
```

**影响**：两条坏路。(a) `fsp.readdir` 的 rejection 冒到 `index.js:27` 的 `await bootDownloader()` → `main().catch` → 打印"启动失败"并 exit 1，**整个服务起不来**（而 `index.js:32-37` 的 resyncStorage 失败只是 log.warn，同一层级的容错口径不一致）。(b) 同步异常（如 `tmpDir()` 里 mkdir 抛 EPERM）走 catch：`booted=true` 但队列空、不 pump，所有 `queued` 任务永久停摆，直到有人手动新建一个下载才顺带 pump，且**一行日志都没有**——调用方（index.js）却以为恢复成功。

**建议**：改成 `try { await ... } catch (e) { log.error('download.boot_failed', {message:e.message}); }`，并在 catch 里也执行"填队列 + pump()"。

**effort**：S

### 7. 两个 SSE 端点永不结束 → 优雅退出只能靠 5s 强退 [medium]

**现象**：translate 的 `streamTranslateEvents` 和 layout 的 `streamLayoutEvents` 都只在客户端断开时 cleanup，服务端在 `done`/`error`/终态首帧之后**从不 `res.end()`**；心跳 interval 一直跑到连接关闭。

**证据**（`03-code/server/services/translate/pipeline.js:674-683`，`layout/job.js:128-137` 同构）：
```js
    if (runner.listeners.size === 0 && ['running', 'queued'].includes(currentStatus(jobId))) {
      runner.canceled = true;
      runner.ctl.abort();
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
```

**影响**：实测对**已 done** 的 job 40 打开 `/api/jobs/translate/40/events`：首帧 progress（status=done）之后连接一直开着，`curl -m 5` 以 28（超时未关）退出，此后每 15s 一条心跳——任务面板每打开一次就多一条永不释放的连接和定时器。`index.js:60-69` 的 `server.close()` 会等这些连接，等不到就落到 `setTimeout(() => process.exit(0), 5000)`：`closeDb()`/`closeLogger()` 全被跳过（WAL 靠 SQLite 下次打开自恢复，但写流缓冲的日志丢失，且退出码是 0，把一次不完整关闭伪装成成功）。

**建议**：emit `done`/`error`/`paused` 后 `cleanup(); res.end()`；首帧若已是终态直接 end；shutdown 里主动遍历 SSE 连接 end 后再 server.close()。

**effort**：M

### 8. layout 状态机纯内存：任意 jobId 都能造出永久 queued 的幻影，且重启后全丢 [medium]

**现象**：`runners` 是 `Map` + `nextJobId` 内存自增；`streamLayoutEvents` 对**不存在**的 id 调 `ensureRunner(jobId)` 凭空建一条 `status:'queued'` 的 runner；没有任何回收/TTL；`boot`（index.js:27-29）只恢复 downloader 与 translate。

**证据**（`03-code/server/services/layout/job.js:53-54`、`:108-110`）：
```js
  const jobId = nextJobId;
  nextJobId += 1;
...
export function streamLayoutEvents(id, res) {
  const jobId = Number(id);
  const runner = ensureRunner(jobId);
```

**影响**：实测 `GET /api/jobs/layout/999999/events` 返回 **200 + `data: {"jobId":999999,"status":"queued"}`** 且永不结束；随后 `GET /api/jobs/layout/999999` 返回 `{"jobId":999999,"status":"queued"}`——一次 GET 就在 Map 里留下一条永不推进、永不回收的状态（可无限制造 → 内存泄漏；前端永远转圈）。重启后 `nextJobId` 归 1，旧 jobId 只会拿到 `'unknown'` 或撞上新 job，正在跑的精排结果（已 compute 未 persist 的部分）全部丢失，且没有任何提示。

**建议**：`streamLayoutEvents`/`getLayoutJob` 先做存在性检查，不存在直接 404/end；runner 加 TTL 回收；layout job 至少把 id/status/startedAt/finishedAt 落库，boot 时把 `running` 改 `failed('E_INTERRUPTED')`。

**effort**：M

### 9. 部分段失败仍标 done；"打转放弃"那一拍无日志无错误码 [medium]

**现象**：最终状态由 `failedSegments === 0 ? 'done' : doneSegments > 0 ? 'done' : 'failed'` 决定——只要有一段译成功，整单就是 done，`error_code` 为 NULL。打转检测放弃某批时只 `failedSegments += ...; pushProgress(true); return;`，不写日志。

**证据**（`03-code/server/services/translate/pipeline.js:363-368` 与 `:448-449`）：
```js
      if (attemptsSoFar >= 2) {
        // 打转检测：同一批连续失败 2 次 → 记 failed，不再重试
        failedSegments += batch.length;
        pushProgress(true);
        return;
      }
```
```js
  const status = failedSegments === 0 ? 'done' : doneSegments > 0 ? 'done' : 'failed';
```

**影响**：285 段里 60 段反复失败 → `status='done'`、`error_code=NULL`、`translate.finished` 记 `status:done`；job 卡片按 done 展示，只有阅读器进度条那一行会写"失败 N"（`web/assets/reader.js:329`）。而 done 的 job 不会被 `startTranslate` 复用（active 只查 `queued/running/paused`），用户想补齐只能整篇重跑。事后从日志判断不出是"引擎挂了"还是"本地打转保护放弃了"——放弃那一拍没有任何记录。

**建议**：done 且 failed>0 时写 `error_code='E_PARTIAL'`（或在最终事件里带 `partial:true`）；打转放弃加一条 `log.warn('translate.batch_given_up', {jobId, size, code})`；为同一 asset 提供"只补失败段"的入口。

**effort**：S

### 10. 抽取状态无启动恢复；下载状态机的 `verifying` 不可达 [medium]

**现象**：`extractAsset` 一开始就把 `extract_status` 写成 `extracting`，之后才抽取；进程若在此期间被杀，没有任何 boot 逻辑把它改回去。另一头 `verifying` 在 CHECK 约束、`ACTIVE_STATUSES`、boot 的 UPDATE 里都在，但全仓没有一处 `markStatus(..., 'verifying')`。

**证据**（`03-code/server/services/extractor.js:183`）：
```js
  run("UPDATE assets SET extract_status='extracting', extract_error=NULL, updated_at=? WHERE id=?", [Date.now(), asset.id]);
```
（`03-code/server/services/downloader.js:27`：`const ACTIVE_STATUSES = ['queued', 'resolving', 'downloading', 'verifying'];`；boot 的 `:65` 与 `schema.sql:99` 同样列了 verifying）

**影响**：抽取中被强退/崩溃 → asset 永久 `extracting`：`startTranslate` 抛"文本尚未抽取完成"（pipeline.js:84-86）、`startLayout` 抛 E_EXTRACT_FAILED（job.js:49-51），boot 只恢复 `download_jobs` 与 `translate_jobs`，没人救它；只能靠手动再点一次抽取（若前端在 extracting 态不渲染按钮，就成了死状态）。`verifying` 则是反过来：状态机/前端若按它显示"校验中"，永远不会出现——文档、schema、CHECK、boot 四处声称的 6 态实际只有 5 态。

**建议**：boot 时 `UPDATE assets SET extract_status='pending' WHERE extract_status='extracting'`（可配合 updated_at < 启动时间）；要么在 `assertPdfFile` 通过后真写一次 `verifying`，要么从 schema/ACTIVE 里删掉它。

**effort**：S

## 超时矩阵（问题 3 的完整回答）

| 操作 | 有无超时 | 值 | 来源 | 备注 |
|---|---|---|---|---|
| LLM 非流式 | 有 | 60000ms | 硬编码默认 `client.js:64``opts.timeoutMs \|\| 60000` | chat 传 90000，translate/retrieval 各自覆盖 |
| LLM 流式 | 有（整条流总时长） | 90000ms | config.js:88 → agent.js:272 / pipeline.js:276 | 不是首字节超时：长回答超过 90s 会被掐断；`res.text()`/读 body 无独立预算 |
| 聊天一轮（总预算） | 有 | 90000ms | config.js:88 → agent.js:108 / pipeline.js:215 | `turnTimer` 到期 abort，UI 表现为"已取消"而非"超时" |
| 工具调用 | **仅 1/5 个工具有** | 8000ms | config.js:63 → lit-page-image.js:92 | `withTimeout` 是 `Promise.race`，超时后底层 work 继续跑；其余工具是同步 DB 查询，无超时但也不阻塞 |
| 检索意图分类 | 有 | 3000ms | 硬编码 `retrieval.js:74` | — |
| PDF 下载（单次尝试） | 有 | 45000ms | config.js:22 → downloader.js:236/346 | 覆盖 fetch+流式读（同一 signal），但**单个 job 总时长无上限**（多候选 × 2 次 × 退避） |
| PDF 抽取 | **无** | — | — | `routes/segments.js:29 → extractAsset → readRawPages`；`opts.signal` 从未被传入，`fs.readFileSync` 同步整文件，`getPage/getTextContent` 无 deadline |
| FTS 重建 | 无 | — | `cli/fts-rebuild.js` | CLI 一次性任务，可接受；但 `deleteIndexForAsset` 与 `indexSegments` **不在同一事务**，中断会留下"有段无索引"的静默缺搜 |
| DB 查询 | 仅锁等待 | 5000ms | `db.js:39 PRAGMA busy_timeout` | 同步 API，长查询无上限（会顶住事件循环） |
| HTTP 请求 | 未配置 | Node 默认 requestTimeout=300000 | index.js 未设 `server.requestTimeout` | 抽取请求 >5min 时 Node 先掐连接，后台抽取继续跑 |
| SSE 流 | 无结束条件 | 心跳 15000ms | pipeline.js / job.js / agent.js | 见 finding 7 |

## 取消传播矩阵（问题 4）

| 环节 | 是否传 AbortSignal | 证据/缺口 |
|---|---|---|
| HTTP `req.on('close')` → ctl.abort() | 是 | agent.js:117 / chat/pipeline.js:223 / translate pipeline cleanup |
| chat pipeline → loop → LLM fetch | 是 | loop.js:57 把 signal 传给 openaiChatStream；每轮开头查 aborted（loop.js:66） |
| chat → **工具** | **否** | `toolCtx` 无 signal（chat/pipeline.js:268-277），`registry.run` 用 `Promise.race` 假超时，循环内不查 aborted → 见 finding 1 |
| translate → 引擎 → fetch | 是 | batch 前查 `ctx.signal.aborted`（pipeline.js:218），引擎把 signal 透传 |
| translate 客户端断开 → job | 是（转 paused） | cleanup 里 listeners 归零则 abort，job 转 paused 可续译 |
| layout 取消 | **半** | signal 确实进到 refine 的 LLM 调用，但 break 后仍落库（finding 2） |
| downloader 取消 | 是 | ctl.abort → fetch/流循环检查 → E_CANCELED；cancelJob 另清 .part |
| 抽取取消 | **否** | 没有任何调用点传 signal |

**"客户端断开后服务端还烧不烧 token"**：聊天这一路不会（abort 传到 fetch），但**工具侧会**——已开始的工具跑完、本轮剩余工具照跑；翻译这一路会在下一批开始前发现 aborted（最多多烧一个在飞的批次）。

## 状态机核对（问题 5）

- **下载 8 态**（schema.sql:99）：`queued→resolving→downloading→done|needs_manual|failed`，`verifying` 不可达；`canceled` 只能由 cancelJob 从任意非终态写入，且 `retryJob` 允许 `failed/needs_manual/canceled` → queued。boot 把 `resolving/downloading/verifying` 重置为 queued 并重跑，**能覆盖所有非终态**（这一点是健全的）。
- **翻译 5 态**：`queued` 从来没被写入过（startTranslate 直接插 `running`）；boot 把 `running/queued` 改 `paused`，用户下次点"继续翻译"才会重跑——覆盖完整，只是"paused 不会自动续跑"是设计选择。
- **抽取 4 态**（pending/extracting/ready/failed/needs_ocr）：**`extracting` 没有恢复**（finding 10），是唯一真正的"无法退出"状态。
- **layout 5 态**：纯内存、不落库、无 boot 恢复，且可为任意 id 造出 `queued`（finding 8）。
- 当前 DB 快照：download_jobs 4 done / 24 needs_manual（无人自动收敛，靠人工），translate_jobs 最近 5 条全 done 且 failed_segments=0。

## 动态验证记录

**1) Node 24 对未捕获 rejection 的默认行为（证明"一个漏掉的 promise 会杀进程"）**
```
PS> node -e "process.on('exit',c=>console.log('exit code',c)); Promise.reject(new Error('boom-unhandled'));"
exit code 1
Error: boom-unhandled
    at [eval]:1:66
    ...
Node.js v24.19.0
LASTEXITCODE=1
```
→ 打印堆栈后 **exit code 1**；服务无 supervisor，且 app-*.log 不会有记录（stderr 才看得到）。

**2) logger 脱敏 → JSON.parse 抛异常（真实模块，非模拟）**
```
PS> node -e "import('./server/logger.js').then(m=>{ m.initLogger({}); const l=m.createLogger('probe');
        try{ l.info('probe.redact',{apiKey:'x'}) }catch(e){ console.log('THREW:', e.name,'/',e.message) }
        try{ l.info('probe.redact2',{authorization:'Bearer abc'}) }catch(e){ console.log('THREW:', e.name,'/',e.message) }
        l.info('probe.ok',{engine:'deepseek'}); console.log('case3 survived'); })"
--- case1: apiKey ---
THREW: SyntaxError / Expected property name or '}' in JSON at position 1 (line 1 column 2)
--- case2: authorization ---
THREW: SyntaxError / Expected property name or '}' in JSON at position 1 (line 1 column 2)
--- case3: no secret key ---
case3 survived
```

**3) layout 幻影 job（一次 GET 造出永不推进的状态）**
```
PS> curl.exe -s -N -m 6 -D - http://127.0.0.1:7317/api/jobs/layout/999999/events
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Transfer-Encoding: chunked

event: progress
data: {"jobId":999999,"status":"queued","at":1793717415969}

elapsed_ms=6029 curl_exit=28      ← 28 = 超过 -m 6 仍未结束

PS> curl.exe -s -m 3 http://127.0.0.1:7317/api/jobs/layout/999999
{"jobId":999999,"status":"queued","error":null,"result":null}   ← 幻影状态已被固化
```

**4) translate SSE 在任务已 done 后仍不关闭**
```
PS> curl.exe -s -N -m 5 -D - http://127.0.0.1:7317/api/jobs/translate/40/events
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8

event: progress
data: {"jobId":40,"totalSegments":285,"doneSegments":285,"failedSegments":0,...,"status":"done","engine":"deepseek","tgtLang":"zh-CN"}

elapsed_ms=5037 curl_exit=28      ← 首帧已是终态，连接仍挂住（心跳 15s 无限续）
```

**5) body-parser 错误未映射：超限上传变 500 + 英文内部文案**
```
PS> curl.exe -s -D - -X POST http://127.0.0.1:7317/api/translate/test -H 'Content-Type: application/json' --data-binary "@1.2MB.json"
HTTP/1.1 500 Internal Server Error
X-Trace-Id: dd674a3e
{"error":{"code":"E_INTERNAL","message":"request entity too large","detail":null,"traceId":"dd674a3e"}}
```
（同日志：`{"level":"error","event":"request.failed","fields":{"traceId":"dd674a3e",...,"stack":"PayloadTooLargeError: request entity too large\n at readStream (D:\\A-knowledge\\...\\node_modules\\raw-body\\index.js:163:17)..."}}` —— 正确应为 413 `E_TOO_LARGE`）

**6) 复核：同一精排被落库两次（日志）**
```
PS> Select-String -Path 03-code/data/logs/app-2026-11-03.log -Pattern 'layout.refine.persisted' | Select-Object -Last 4
{"ts":"...13:07:48.500Z","module":"layout.refine","event":"layout.refine.persisted","fields":{"assetId":4,"rows":94,"applied":69}}
{"ts":"...13:07:49.164Z","module":"layout.refine","event":"layout.refine.persisted","fields":{"assetId":4,"rows":94,"applied":69}}
{"ts":"...13:25:51.456Z","module":"layout.refine","event":"layout.refine.persisted","fields":{"assetId":5,"rows":677,"applied":966}}
```

**7) catch 分类（启发式扫描，非测试文件 139 个 catch 块）**
```
other = 67   next(e) = 41   silent(空块/仅注释) = 11   rethrow = 8   return-兜底 = 7   log-only = 5
```
其中 `next(e)` 41 处（集中在 routes/，都有 try/catch 包裹，Express 4 的 async 路由无漏网）、`log-only` 5 处（`routes/assets.js:246`、`chat/agent.js:229`、`chat/retrieval.js:108`、`fts.js:337`、`index.js:35`）、`return-兜底` 7 处（`security.js:74`、`translate/pipeline.js:595`、`extractor.js:329/410`、`importer.js:321`、`storage.js:377`、`migrate.js:192`）。**最危险的三处静默 catch** 依次是：`chat/registry.js:230-238`（吞掉工具异常且无日志，finding 1）、`downloader.js:79-81`（catch 后既不 pump 也不记日志，finding 6）、`translate/pipeline.js:363-368`（打转放弃只加计数不落日志，finding 9）。

**8) 服务与 DB 现状（只读）**
```
PS> curl.exe -s http://127.0.0.1:7317/api/health
{"ok":true,"version":"1.0.0-m1","dbDriver":"node:sqlite","dbPath":"D:\\A-knowledge\\...\\data\\app.db","works":424,"activeJobs":0,...}
PS> node -e "...new DatabaseSync('data/app.db',{readOnly:true})..."
translate_jobs: [{"id":40,"status":"done","total_segments":285,"done_segments":285,"failed_segments":0}, ... 全 done]
downloads: [{"status":"done","n":4},{"status":"needs_manual","n":24}]
chats: [{"id":39,...},{"id":38,...},{"id":37,...}]
```

## 覆盖与盲区

- **没跑 shutdown**：明确禁止重启/停止 7317 端口服务，finding 7 的"5s 强退导致 closeDb/closeLogger 跳过"是代码推断（index.js:60-69）+ SSE 不关闭的实测前提，没有真的发 SIGTERM。
- **没跑真实下载/翻译中断**：无 LLM key（真实调用会立刻 E_LLM_KEY_MISSING），且 POST 写库超出"只读调用"授权范围，所以下载/翻译状态机只有静态 + DB 快照证据；`drainPdf` 的中断清理路径（`.part` 删除）未在真实中断下验证。
- **没做并发/压力测试**：SSE 连接泄漏与 layout Map 增长只证到"能造出来"，没有量化增长速率或 OOM 阈值。
- **web 侧只抽查了 `reader.js:329`**（是否展示 failedSegments），没有逐个审计前端 EventSource 的关闭时机，因此"永久占连接"的实际用户可见影响取决于前端是否主动 close。
- **未通读** `02-design`（按纪律只 grep 定位），也未逐字读 `chat/session.js`、`chat/attachments.js`、`fts.js` 全文，工具超时/错误路径以外的次要 catch 只做了启发式分类而非逐条判定。
- **`page-image-source.js` 的 `withDeadline`/`withTimeout` 双层超时**只做了 grep 级核对，没有验证"超时后浏览器资源是否真的回收"（其内部 8000ms 与 registry 的 8000ms 同时到期，谁先触发未测）。
