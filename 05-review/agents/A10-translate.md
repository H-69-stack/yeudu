# A10 translate — 翻译管线评审（pipeline / cacheKey / engines / SSE）

- 评审对象：`03-code/server/services/translate/**`、`03-code/server/routes/translate.js`、`03-code/web/assets/{reader,translate}.js`、`03-code/server/test/{cacheKey,batches,dual-index}.test.js`
- 评测口径：`05-review/_context.md`（severity 按"现在造成的后果"，effort=S/M/L/XL）
- 动态环境：`http://127.0.0.1:7317` 已有实例在跑，只做只读 GET；库文件 `03-code/data/app.db` 以 `readOnly: true` 打开
- 采集时间：2026-11-03（job 时间戳 1793715489668 ≈ 2026-11-03）

## 结论

1. 管线的主干（建 job → 缓冲击穿 → 批次翻译 → 同事务写译文+索引 → SSE 推送）是通的，但**所有"不 happy"的路径都缺一环**：失败不中止、终局一律发 `done`、命中不修索引、取消不防重入。
2. 最严重的不是翻译质量，而是**状态与索引的记账**：40 个 job 全部 `done`（含失败任务的语义被抹平），`translations` 3532 行 **100% 指向已删除的段**，而 `translations_fts` 是 **0 行** —— 译文侧全文检索现在是彻底失效的，UI 上却看不出任何异常。
3. 内容寻址（同文本共用一行译文）本身是对的，但**只做了"合并"没做"回收"**：重抽不删 `translations`、命中不重建索引、backfill 跳过悬空行，于是"482 行 ↔ 492 段"这类对不上的数字是结构性的，不是一次事故。
4. 缓存键与渲染后的 prompt 不是一一对应（键丢 srcLang 与 work.note，但 prompt 用它们），"改完条件重跑"会静默命中旧译文——这是会用错的地方。
5. 成本视图（`requests/batches/usage`）只在内存里，且计数口径是"每批 1 次"，与真实 HTTP 次数（最多 4×）差一个量级；落库需要的只是 `translate_jobs` 加几列。

## 附：pipeline.js 函数流程图（811 行）

```
POST /api/works/:no/translate
└─ startTranslate(no, opts)                       73-166
   ├─ 参数校验 / scope∈{all,pages,rest} → scope_pages(JSON)
   ├─ 查活跃 job：asset_id+engine+tgt_lang+status IN(queued,running,paused)
   │     (无 scope 条件)                           96-101
   ├─ 命中 paused → UPDATE status=running → ensureRunner → runJob() 复用同一行 104-116
   ├─ 其它命中 → 直接 return 现有 job（幂等）
   └─ 新建 job(queued) → runJob(jobId,{engineIds:[primary,...fallback]})
                                            .catch(→finishJob(failed)+emit done) 160-166
runJob(jobId, {engineIds})                        252-470
   ├─ loadSegments(asset, scope) 169-185 → sortByAnchor 188-197 → chain=engineChain 125-136
   ├─ 逐段：buildCacheKey → SELECT 1 FROM translations(cache_key)
   │        命中 → hits++ / UPDATE hits+last_hit_at / emit progress（不建索引）281-290
   ├─ 未命中段 → buildBatches(texts,{maxChars,maxItems}) → batchObjects → pool(≤min(2,conc))
   │     每批：cursor 切片 → 死打转检测 → requests++ → translateBatch()
   │           translateBatch: for engine in chain → for attempt 1..2 → engine.translate
   │               成功：长度校验/空串校验 → tx{ INSERT translations ON CONFLICT DO UPDATE
   │                     + indexTranslation(seg.id, engine=job.engine) }   385-413
   │               失败：E_CANCELED→return；其余 failedSegments+=len   431-437
   ├─ runner.canceled → finishJob(paused)+emit paused                      442-446
   └─ status = failedSegments===0 ? done : doneSegments>0 ? done : failed
        finishJob(status) → emit('done') → jobStats.set(内存)               448-458
GET /api/jobs/translate/:id → progressFromDb(498-544) 每段一次 SELECT 1 → 覆盖 job 行
GET .../events → streamTranslateEvents(647-684) listeners+15s heartbeat；断连即 abort
POST .../cancel → cancelTranslateJob(692-706) canceled+abort+status=paused
```

## findings

### F1（high）任务终局：部分失败、乃至全部失败，都记成 `done` 并推 `done` 事件

**现象**：`runJob` 收尾只有两种出口，`failedSegments>0` 时只要还译出过一段，job 就是 `done`；彻底失败时 status 才是 `failed`，但**事件名仍是 `done`**，前端 toast 仍是绿色「翻译完成」。库里 40 个 job 全部 `status=done`，一条 `failed` 都没有。

**证据**

`03-code/server/services/translate/pipeline.js:448-451`
```js
  const status = failedSegments === 0 ? 'done' : doneSegments > 0 ? 'done' : 'failed';
  finishJob(jobId, status, status === 'failed' ? 'E_UPSTREAM' : null, status === 'failed' ? '全部批次失败' : null, { doneSegments, failedSegments });
  const finalPayload = buildProgress(jobId, { total: segments.length, done: doneSegments, failed: failedSegments, pageTotals, pageDone, startedAt });
  emit(jobId, 'done', {
```

`03-code/web/assets/reader.js:327-334`
```js
  es.addEventListener('done', async (ev) => {
    const p = JSON.parse(ev.data);
    $('progressLine').textContent = `完成：${p.doneSegments}/${p.totalSegments} 段（失败 ${p.failedSegments}），请求 ${p.requests ?? 0}，缓存命中 ${p.cacheHits ?? 0}`;
    es.close();
    es = null;
    $('btnCancel').hidden = true;
    await loadSegments();
    toast('翻译完成', 'ok');
```

**影响**
- 前端没有 `failed` 事件分支，用户看到的永远是"完成 + 绿色 toast"，失败只体现在一行小字 `（失败 N）`；
- 部分失败不会被识别为需要重试的状态：`failedSegments>0` 的 job 是 `done`，下次点"翻译"会走 `status IN ('queued','running','paused')` 之外的路径 → 新建一个 job，全篇重来（命中已译的，失败段重新打一遍），但失败段的记录（`failed_segments`）**不会被任何重试逻辑消费**；
- 监控/日志无法从 `translate_jobs` 统计失败率（40/40 done）；
- 致命错误（缺 key/未配置）在 `translateBatch` 里被直接抛出（`pipeline.js:240`），`runJob` 的 catch 不区分致命与暂时（`pipeline.js:431-437`）→ **不中止**，剩下每一批都照样走一遍、照样 `failedSegments+=len`，最后 status 仍是 `done`（只要第一段成功过）。这是"配置坏了但看起来跑完了"的最短路径。

**建议**：状态三态化 `done / partial / failed`（schema CHECK 加 `partial`，或复用 `error_code='E_PARTIAL'` 而不改 status）；`failedSegments>0 && doneSegments>0` → `partial`，且**只在 `failedSegments===0` 时发 `done`**，否则发 `failed`/`partial` 事件并在 reader 里加分支（红色 toast + 「重试失败段落」按钮）；`translateBatch` 抛出的 E_LLM_KEY_MISSING/E_ENGINE_UNCONFIGURED 在 `runJob` 里应立即 `return finishJob(failed)`，不要继续把剩余批次跑成失败。

**effort**: M（状态机 + 前端分支 + 一个"只重跑失败段"的 scope）

### F2（high）命中缓存的任务永不重建译文索引；重抽把它清零后，译文检索永久为 0

**现象**：`translations_fts` 实测 **0 行**，而 `translations` 有 3532 行。`GET /api/works/1.8/search?q=智能体&side=dst` 返回 `{"hits":0,...,"reason":"rewritten-no-hit"}`；换英文 `q=agent&side=dst` 也 0。译文在阅读页里能显示（走 `translations` 按 cache_key 取），但**搜不到**。

**证据**：三条路径叠加，缺一不可。

1) 重抽清索引、不重灌：`03-code/server/services/extractor.js:244-248`
```js
  tx(() => {
    deleteIndexForAsset(asset.id);
    // 段 id 会变：译文索引必须跟着清，否则会指向已删除的段（搜到却取不回来）
    deleteTranslationIndexForAsset(asset.id);
    run('DELETE FROM segments WHERE asset_id = ?', [asset.id]);
```
2) 命中路径不写索引：`pipeline.js` 命中分支只 `hits += 1` / `UPDATE translations SET hits...`，**没有 `indexTranslation`**；索引只在未命中的落库事务里写（`pipeline.js:411`）。
3) 于是"重抽后的第一次全命中运行"= 索引永远是空的。实测 job 40：`{"status":"done","totalSegments":285,"doneSegments":285,"requests":0,"cacheHits":285}` —— **requests=0、全命中**，一行索引都不会补。job 39（259/259）、job 40 都发生在这批 asset 重抽后 2–4 秒（`updated_at` 集中在 1793715484531–1793715487492），即"重抽 → 立刻全命中重译 → 索引保持 0"。
4) 唯一的补救 `backfillTranslationIndex` 跳过悬空行（`03-code/server/services/fts.js` 的 `if (!seg) { skipped += 1; continue; }`），而 3532 行**全是悬空的**（见 F3）→ 补救也会全跳过；`migrate.js` 的 `rebuildTranslationIndex()` 只在启动时跑一次，启动后每次重抽又会清零。

**影响**：`D22`（双索引）在"重抽过的文献"上等于没做；搜索功能静默退化（返回 0 而不是报错），用户以为库里没有；`dual-index.test.js` 全绿，但测试里没有"重抽 → 全命中重译"这个序列（见文末覆盖核查）。

**建议**：命中分支也要 `indexTranslation(seg.id, {engine, tgtLang, text})`（幂等，代价是一次 DELETE+INSERT），或把 `translations_fts` 做成**由 translations 表派生**、在 `progressFromDb`/`loadSegments` 命中时批量补齐；`extractor` 重抽后调一次 `backfillTranslationIndex(asset 范围)`；`assertMigration` 增加"可达译文数 > 0 时 fts 行数 ≥ 某比例"的断言。

**effort**: S（命中分支加一行）+ S（extractor 重抽收尾补一次 backfill）

### F3（high）内容寻址只合并不回收：3532 行译文 100% 悬空，`segment_id` 已失去意义

**现象**：`translations` 3532 行，`NOT EXISTS(SELECT 1 FROM segments WHERE id=t.segment_id)` 命中 **3532/3532**；`JOIN segments` 可达 **0**；`extract_version` 混存 6 个版本（1→1301、2→307、3→798、4→567、6→77、9→482），其中 2965 行与当前 asset 版本不一致。translation 行只增不减：每重抽一次，旧行全部变孤儿，新文本再插新行。

**证据**
- `extractor.js:244-248`（同上）：删 `segments`、清索引，**不删 `translations`**；`translations.asset_id` 是 `ON DELETE SET NULL`，重抽不删 asset，也就没有级联；
- `pipeline.js:391-392` 的 upsert 只更新 `dst_text / segment_id / last_hit_at`，**`segment_id` 被"最后一次写入者"覆盖**，同文本的其他段（twin）从此指向一个段；
- `fts.js` 的 `searchTranslation` 用 `WHERE segment_id = ? AND engine = ? AND tgt_lang = ?` 回读译文 → twin 段命中时 `textDst=null`（`searchTranslation` 的既有注释与 `dual-index.test.js:96` 都指出过这个模式，但只覆盖了 segment_id 有效的情况）。

**判断：是 bug，不是 feature。** 内容寻址本身没问题（同文本共用译文省 token 是对的），错在把 `segment_id` 当成"归属"写进唯一行——它天然是一对多。按现状这条链是：合并（正确）→ 重抽（旧行留库，`extract_version` 已经能把它们全部判为 stale）→ **没有任何地方消费 stale 这个事实**（没有清理、没有统计、搜索还会因为悬空而跳过）。

"482 行 ↔ 492 段"（STATUS.md:354）就是这个结构的产物：482 是 job16 落库的 mock 译文行，492 是当时的 `total_segments`，而现在同一 asset 的可翻段是 **536**（`GET /api/jobs/translate/16` 返回 `totalSegments:536, doneSegments:0`）。三个数字口径不同（译文行 / job 快照 / 当前段数），永远不会相等。

**影响**
- 库无界增长（现在 3532 行里 84% 以上是过期数据，且只看 `extract_version` 就能扔掉）；
- 统计口径混乱：`STATUS.md`、`expectedTranslationIndexCount`（按 `src_text` join 算 540）、`doneSegments`（按 cacheKey 算）各不相同，谁都不是"已译段数"；
- twin 段搜索回读不到译文（F2 的另一面）；
- 重译成本：命中判断只看 cache_key，旧行不会被清理，`hits` 统计被历史行稀释。

**建议**：给 `translations` 增加 `(asset_id, src_text_hash)` 的派生视图做统计；在 `extractor` 事务内 `DELETE FROM translations WHERE asset_id=? AND extract_version<>?`（或标记 `retired_at`）；把 `segment_id` 语义改名为 `last_segment_id` 或删掉，回读改成 `WHERE asset_id=? AND src_text=? AND engine=? AND tgt_lang=?`。

**effort**: M（schema 语义 + 清理 + 回读改造）

### F4（medium）缓存键与渲染后的 prompt 不是一一对应：改 srcLang / 改 work.note 重跑会静默命中旧译文

**现象**：`buildCacheKey` 的输入是 `engine|model|tgtLang|promptFp|extractVersion|normalizedText`，**不含 srcLang、不含 work.title/note**；但 `renderPrompt` 会把这三者都拼进真正的 prompt。于是"请求不同 → 键相同 → 直接复用上次译文"，且 UI 只标 `cached`，没有任何提示。

**证据**

`03-code/server/services/translate/cacheKey.js:28-36`（键的组成）
```js
export function buildCacheKey(p) {
  const parts = [
    String(p.engine || ''),
    String(p.model || ''),
    String(p.tgtLang || ''),
    String(p.promptFp || ''),
    String(p.extractVersion ?? ''),
    normalizeForHash(p.text),
  ];
```
`03-code/server/services/translate/prompts.js:98-109`（渲染时注入的内容）
```js
  const out = tpl
    .replace(/\$\{langFrom\}/g, langName(srcLang))
    .replace(/\$\{langTo\}/g, langName(tgtLang))
    .replace(/\$\{text\}/g, sourceText)
    .replace(/\$\{sourceText\}/g, sourceText);
  ...
  if (work && work.title) {
    const ctx = `[Background — for terminology consistency only. Do NOT translate, quote or repeat this part in your output.]\nPaper: ${work.title}${work.note ? `\nFocus: ${work.note}` : ''}`;
    return `${ctx}\n\n${out}`;
  }
```
`promptFp` 只是**模板**的 sha256（`promptFingerprint(template)`），不是渲染后的哈希；`works.note` 可以被 PATCH 编辑（`server/routes/works.js:71` 的 allowed 列表里有 `note`），424/424 条文献 note 非空 → 它是实际参与翻译指令的字段。

**影响**
- 把 `srcLang` 从 `auto` 改成 `en`（或反过来）重跑同一篇：键不变 → 100% 命中 → **用户以为"按新语言设置重译了"，其实一条都没发**；
- 改 `work.note`（术语偏好）后重译：同样全命中，术语修正不生效；
- 反过来的风险：文献含多语种时，`srcLang=auto` 与 `srcLang=en` 对同一段会产生**不同质量的译文**，但只保留先到的那一份，后到的设置无法纠正（"把英文当德文译"的场景不会由键导致，而会由"用旧译文覆盖新设置"导致）；
- `normalizeForHash`（NFKC + 空白折叠）会把 `A\nB` 与 `A B` 归一成同键：本库实测 5202 段 → 5017 个不同 text，185 段共用 key（`References` 9 篇、`Introduction` 5 篇这类是真重复，属于合理合并）；但换行有语义的段（诗歌、代码块、表格行）会被错误合并。当前库里 `空 text=0 / 首尾空格=0`，属于**潜在**而非**正在发生**。

**建议**：`promptFp` 改成 `sha256(渲染后的 system prompt)`（含 langFrom/langTo/work 上下文），这样键自然覆盖所有影响输出的输入；或在 `buildCacheKey` 里显式加 `srcLang` 与 `workNoteHash`，并在 `cacheKey.test.js:39`（"srcLang 不进键"）旁边补一条"srcLang 变化 → miss"的用例。

**effort**: S

### F5（medium）回退链在现网恒为空；即使真回退，译文仍记在 primary 名下

**现象**：`config.translate.fallbackEngines = ['openai']`，而 `/api/translate/engines` 实测 `openai configured:false`（gemini、claude 同样 false）→ `engineChain` 静默丢弃，链上只剩 primary。第二个问题：批次里若真的用了 fallback，落库的 `engine/model` 仍是 `job.engine/job.model`。

**证据**

`03-code/server/services/translate/engines/registry.js:124-136`
```js
/** 引擎链：主引擎 + 备用链，去重、过滤掉未配置的（§9.1.3 [7]） */
export function engineChain(primary, fallback) {
  const ids = [primary, ...(fallback || [])].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = getEngine(id);
    if (e && e.configured) out.push(e);
  }
  return out;
}
```
`03-code/server/services/translate/pipeline.js:401-411`（节选，中间为其余列/占位）
```js
                job.engine,
                job.model,
                ...
            indexTranslation(seg.id, { engine: job.engine, tgtLang: job.tgt_lang, text: out[i] });
```
`pipeline.js:417` 只把 `fallbackCount` 记进内存 usage，不落库、不进键。

**影响**
- 用户配的那个 fallback（openai）永远不会被用；`configured:false` 的引擎被**无日志**丢弃，运维看不到"回退没生效"；
- 更深的问题：`buildCacheKey` 用的是 `job.engine/job.model`（`pipeline.js` 键计算处），所以 fallback 产出的译文会被记成 primary 的译文，下次同 asset 用 primary 请求时**直接命中**这些"别的模型译的"文本——成本归因、质量排查、A/B 全部失真；
- `E_ENGINE_UNCONFIGURED` / `E_LLM_KEY_MISSING` 两个码在这里被吞成一个"skip"，用户点翻译时看到的是"跑完了"，不是"你配的回退不可用"。

**建议**：`engineChain` 丢弃 fallback 时 `log.warn('translate.fallback_dropped', {id, reason})` 并写进 job 的 `error_message`（非致命）；落库的 `engine/model` 改为 `usedEngine`，或至少新增 `via_engine` 列；缓存键改成 `usedEngine` 口径 + 记录 `engine` 明细，避免"跨模型命中"。

**effort**: S

### F6（medium）批次组装：`slice(cursor, cursor+texts.length)` 假设批次与段一一对应，而 `buildBatches` 会跳过空段

**现象**：`buildBatches(ordered.map(s => s.text))` 返回的批次里**空/纯空白文本会被跳过**（单测 `batches.test.js:21` 明确锁死了这个行为），但 `runJob` 用 `cursor` 顺序切 `ordered` 来配对，二者一旦不等长，**后面所有段的译文整体错位一格**，把 A 段的译文写进 B 段的 cache_key 与 segment_id。

**证据**

`03-code/server/services/translate/pipeline.js:339-350`
```js
  const batches = buildBatches(ordered.map((s) => s.text), {
    maxChars: engine.limits.maxChars,
    maxItems: engine.limits.maxItems,
  });

  // 把 batch 的文本映射回 segment 对象（buildBatches 只处理字符串，这里按顺序切回）
  let cursor = 0;
  const batchObjects = batches.map((texts) => {
    const slice = ordered.slice(cursor, cursor + texts.length);
    cursor += texts.length;
    return slice;
  });
```
`batches.test.js:21` 的断言（`buildBatches：空段被跳过、不占用批次`）证明"批次元素数 ≠ 输入段数"是**设计上的正常情况**；而 `pipeline.js:229-236` 只校验 `out.length !== batch.length`（引擎返回条数），不校验 `slice.length === texts.length`。

**影响**：`segments.text` 由提取器生成，实测当前库 `空 text=0 / 纯空白=0`，所以**现在不会触发**；但这是零成本可触发的数据损坏（一条 `text=' '` 的段 → 该段之后全部错位 → 译文写错行、索引写错 rowid、`doneSegments` 却照常 +1）。`cleanPageText` 的 NFKC/折叠逻辑在 extractor 里，未来放宽截断阈值就可能产出空段。

**建议**：`loadSegments` 就过滤掉 `trim()===''` 的段（与 `buildBatches` 的语义对齐），或在切片后断言 `slice.length === texts.length` 并在不等长时抛 `E_INTERNAL`（宁可失败不要错位）；`buildBatches` 改成返回 `{texts, indices}` 让调用方按 index 配对。

**effort**: S

### F7（medium）任务生命周期：cancel→立即 resume 会跑起两个 runJob；SSE 断连即中止任务

**现象**：`cancel` 把 `runner.canceled=true` 并 `abort()`，但 `startTranslate` 的 resume 分支只要看到 `status='paused'` 就 `resumed.canceled=false` + 换新 `AbortController` + 再调一次 `runJob`，**没有"是否已在跑"的判断**；而 `runJob` 的每批都从 `runner.ctl.signal` 现取 signal（`pipeline.js:377`），所以旧循环拿到的是**新 controller**、不会中止 → 两个 `runJob` 并发写同一个 job 行、同一批段各译一遍（重复计费 + 计数互覆）。

**证据**

`03-code/server/services/translate/pipeline.js:104-116`（节选，`runJob` 的实参已省略）
```js
    if (active.status === 'paused') {
      run("UPDATE translate_jobs SET status='running', finished_at=NULL WHERE id=?", [active.id]);
      const resumed = ensureRunner(active.id);
      resumed.canceled = false;
      resumed.ctl = new AbortController();
      runJob(active.id, {...})
```
`pipeline.js:377`（signal 在批内现取）
```js
          signal: runner.ctl.signal,
```
`pipeline.js:431-432`：只有 `E_CANCELED` 才 `return`，而旧循环的下一次 `translateBatch` 入口检查 `ctx.signal.aborted` 时看到的是**未 abort 的新 signal**。

**影响**：用户点"取消"后马上点"继续翻译"（`reader.js` 的 continueTranslate 是同一个 POST）就会双跑；两个循环各自 `requests += 1`、各自 `emit progress`，最终 `finishJob` 互相覆盖，`jobStats` 只留最后一个。现网 40 个 job 全 done、无 paused，说明这条路径还没被踩到，但它是"点了继续"最自然的手势。

**另**：`cleanup`（`pipeline.js:672-680`）在最后一个 SSE 客户端断开且 job 还在 running 时直接 `abort()` → **刷新页面 = 任务暂停**；而 `maybeReattachJob` 只在 `status ∈ running/queued` 时重订阅，paused 后不会自动恢复，用户必须手动再点一次。

**建议**：`runners` 里存 `Promise`（`runner.promise`），resume 前 `if (runner?.promise && runner.canceled === false) return getTranslateJob(id)`；或者 resume 时先等旧 promise settle（带 5s 超时）；`cancel` 的 abort 用**闭包捕获的 ctl**（`const ctl = runner.ctl; ctl.abort()`）并在 `translateBatch` 里接收 `ctl` 而不是 `runner.ctl`。断连策略改为"延迟 X 秒无订阅才暂停"，避免刷新即停。

**effort**: M

### F8（medium）进度口径：`progressFromDb` 忽略 `scope`，且用"当前库"反推历史 job → 已完成的任务可能显示 0/N

**现象**：job 16（asset 2，mock，`total_segments=492`）现在返回 `{"status":"done","totalSegments":536,"doneSegments":0,"failedSegments":0,"cacheHits":0}`——一个已完成的任务显示 0/N。`progressFromDb` 每次 GET 都按当前段表重算（`5202` 段级 N 次 `SELECT 1 AS hit`），把 job 行里存的 `total_segments/done_segments` 覆盖掉；返回体的 `requests` 恒为 0。

**证据**

`03-code/server/services/translate/pipeline.js:502-521`
```js
  const rows = all(
    `SELECT id, page_no, text FROM segments
      WHERE asset_id = ? AND ${TRANSLATABLE}
      ORDER BY page_no ASC, ord ASC`,
    [job.asset_id],
  );
  ...
    const key = buildCacheKey({
      engine: job.engine,
      model: job.model,
      tgtLang: job.tgt_lang,
      promptFp: job.prompt_fp,
      extractVersion: asset.extract_version,
      text: r.text,
    });
    if (get('SELECT 1 AS hit FROM translations WHERE cache_key = ?', [key])) {
```
`pipeline.js:617-631`：`totalSegments: prog.totalSegments ?? job.total_segments`、`requests: prog.requests ?? 0`；而 `progressFromDb` 的 `requests/cacheHits` 取自内存 `jobStats`（`pipeline.js:526` `const stats = jobStats.get(jobId) || {}`）→ 重启后、或任何不在内存里的历史 job，这两个值恒为 0（实测 job16 `requests:0, cacheHits:0, lastRun:null`）。

**影响**：`scope='pages'/'rest'` 的 job（API 合约支持，`_context` 的数据模型里也有 `scope_pages`）在进度上永远显示全篇；历史 job 的统计随库漂移（job16：492 → 536 → 0/536），"这次翻了多久/多少段"的报表不可信；`flushEvery=300`（`pipeline.js:354`）意味着每 300ms 一次进度 tick，每次 `progressFromDb` 都对 5202 条段各跑一次 `SELECT 1`（SSE 首帧 + 每次 GET job 都跑一遍）。`progressFromDb` 还会把 `job.prompt_fp` 当键、用 `asset.extract_version`（当前值）而不是 `t.extract_version`，重抽后一律判 miss。

**建议**：`progressFromDb` 加 `AND page_no IN (scope_pages)` 或直接用 `job.scope_pages` 过滤；已完成（`status='done'` 且 `finished_at` 非空）的 job 直接返回快照字段，不再反推；命中判定改为 `EXISTS` 单条聚合 SQL（`SELECT count(*) FROM translations t JOIN segments s ON ... WHERE cache_key IN (...)`）或一次 `IN` 批查。

**effort**: S

### F9（medium）成本与限流只存在于内存，且计数口径比真实 HTTP 少一个数量级

**现象**：`requests` 每批 +1（不是每 HTTP 请求），`usage` 只在未命中路径累加，`jobStats` 只在内存。重启后 `/api/jobs/translate/16` 的 `lastRun` 就是 `null`；`translate_jobs` 表**没有** `requests/batches/usage/cost` 任何一列（实测列清单只有 19 个基础列）。

**证据**

`pipeline.js:369`（每批一次）
```js
      requests += 1;
```
`pipeline.js:214-243`（每批最多 2 个引擎 × 2 次尝试）+ `server/services/llm/client.js` 的 `openaiChat` 内部再包一层 `withRetry(..., {retries: 1})` → 单"批"最多 4 次 HTTP，`requests` 记 1；`shared.js:64-70` 在编号解析缺项时**逐段补译**（每段一次 HTTP），也不计入 `requests`（`pipeline.js:371-382` 没有传 `onStats`，`fallbackCount` 直接丢掉）。
`pipeline.js:458` `jobStats.set(jobId, {...})` + `pipeline.js:638` `lastRun: jobStats.get(job.id) || null`；`finishJob`（`600-607`）只写 `status/error/done_segments/failed_segments`。

**影响**：用户看到的"这次花了多少"（token/请求数）系统性偏低（1/2~1/4 量级），重启后归零；没有 cost 字段就没有预算视图；`fallbackCount` 丢失让 F5 的"回退是否生效"无法从数据判断。

**落库的最小改动方案（不实施）**
1. `ALTER TABLE translate_jobs ADD COLUMN requests INTEGER NOT NULL DEFAULT 0, ADD COLUMN batches INTEGER NOT NULL DEFAULT 0, ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0, ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0, ADD COLUMN cost_usd REAL`；
2. `pushProgress()` 里顺带 `UPDATE translate_jobs SET requests=?, batches=?, prompt_tokens=?, completion_tokens=?`（和 `done_segments` 更新的时机一致，节流已有 `flushEvery`）；
3. `requests` 语义改成"HTTP 尝试次数"：在 `translateBatch` 里 `ctx.onAttempt()` 每进一次 `engine.translate` 就 +1，`openaiChat` 的 `withRetry` 通过 `onAttempt` 回调透传（或用 `usage` 里加 `attempts`）；
4. `getTranslateJob` 的 `requests/cacheHits` 优先读 job 列（永远可读），`lastRun` 仅作"进程内实时视图"。

**effort**: S（列 + 3 处写入）/ M（若要把 cost 按模型单价算对）

### F10（low）引擎层：三套封装与 `client.js` 重复；`shared.js` 的 FATAL 集合是死代码；`E_*` 边界靠两处维护

**现象**：`registry.js`（138 行）同时承担选择、回退、连通性测试、密钥取用、默认模型；`shared.js` 的 try/catch 两支都 `throw`，`FATAL` 集合永远不生效；`configured`（引擎自报）与 `client.js` 运行时抛的 `E_LLM_KEY_MISSING/E_ENGINE_UNCONFIGURED` 是两套判定，语义边界靠人肉对齐。

**证据**

`03-code/server/services/translate/engines/shared.js:47-53`
```js
  let raw = null;
  try {
    raw = await call(prompt);
  } catch (e) {
    if (e && FATAL.has(e.code)) throw e;
    throw e;
  }
```
（`const FATAL = new Set(['E_LLM_KEY_MISSING', 'E_ENGINE_UNCONFIGURED', 'E_CANCELED'])` 在 `shared.js:14`，但两个分支行为完全相同 → 该集合在任何路径上都不产生效果）

`registry.js:111-112`（引擎自报 configured 的判定）
```js
    if (engine.needsKey && !engine.hasKey) {
      throw new AppError('E_LLM_KEY_MISSING', `引擎「${engine.name || id}」未配置 apiKey（请在设置页填写）`, { engine: id });
```
`03-code/server/services/llm/client.js:153-155`（运行时再判一次）
```js
  if (!prov.hasKey) throw new AppError('E_LLM_KEY_MISSING', `provider「${prov.id}」未配置 apiKey`, { provider: prov.id });
  if (!prov.baseUrl) throw new AppError('E_ENGINE_UNCONFIGURED', `provider「${prov.id}」缺少 baseUrl`, { provider: prov.id });
  if (!p.model) throw new AppError('E_ENGINE_UNCONFIGURED', `provider「${prov.id}」缺少 model`, { provider: prov.id });
```
`03-code/server/services/translate/engines/openaiCompatible.js:21-23` 又用 `cfg.hasKey && Boolean(cfg.model) && Boolean(cfg.baseUrl)` 再判一遍 `configured`。

**影响**：三处 `configured` 判定，任一处改口径（比如 baseUrl 允许空、用默认地址）就会出现"列表显示可用、调用报未配置"的不一致；`registry.testEngine`（`pipeline.js:709-720`，直接 `engine.translate([text])` 不走 chain）与真实链路的差异也无法从这一层看出。功能上目前没坏，属于可维护性债。

**建议**：`shared.js` 删掉空 try/catch 与 FATAL（或真的用它做"不重试"判定）；把 `configured` 收敛成 `client.js` 单一谓词（`hasKey && model && baseUrl` 一处定义，引擎只暴露 `needsKey`）；`registry` 拆出 `selectEngine`（纯策略）与 `probe`（连通性）两件事，`buildEngines` 改成模块级缓存而不是每次调用重建。

**effort**: M

## 覆盖与盲区

**读到了（按行数降序）**：`pipeline.js`（811 行，全文）→ `web/assets/reader.js`（563，关键段 167-350）→ `server/services/fts.js`（451，索引/检索/backfill 全部）→ `extractor.js`（436，只看 240-330 重抽事务）→ `segment.js`（248，buildBatches/编号协议定位）→ `web/assets/translate.js`（194，renderDst/stats）→ `engines/registry.js`（138，全文）→ `prompts.js`（118，全文）→ `routes/translate.js`（113，全文）→ `engines/shared.js`（72，全文）→ `openaiCompatible.js`（51）→ `gemini.js`（45）→ `claude.js`（44）→ `cacheKey.js`（40）→ `types.js`（29）→ `migrate.js`（启动重建索引段）→ `server/test/{batches,cacheKey,dual-index}.test.js`。

**没读/没验证**：
1. **cancel→resume 双 runner 未实测**：需要真跑一次带 LLM 的任务（会写库、花钱），只读纪律下不做；结论来自代码路径（`pipeline.js:104-116` + `377` 的 signal 现取）。
2. **回退引擎未触发**：现网 `openai/gemini/claude` 全 `configured:false`，`mock` 只在单测里用；F5 的"记账错位"是代码推断，无运行证据。
3. **translations_fts=0 的成因链**是"代码路径 + 库内现状"的合理化解释：日志只到 `app-2026-10-31.log`（有 `backfilled/skippedStale/indexed` 记录），无法确认是哪一次重抽 + 哪一次全命中运行造成的；`data/_tmp/{seed-zh.mjs,window.mjs}` 是改过库的临时脚本（`window.mjs` 还按 `CAST(segment_id AS INTEGER)` 的老结构删索引），可能污染了当前状态。
4. **搜索侧的 `rewritten-no-hit` / `no-hit-no-rewrite`** 现象（中文 query 被 rewrite 成英文后 0 命中）超出本管线范围，归 A09/搜索侧；只把它当作"dst 侧搜不到"的旁证。
5. `02-design` 只按代码注释引用了 D21（缓存键含 extractVersion）/ D22（双索引同事务），**未读设计文档原文**，若设计与实现有出入需要交叉核对。
6. 未审计 `routes/segments.js`、`refine`（精修）链路、`works/export` 的 Markdown 质量——属于其他 agent 的范围。

## 动态验证记录

> 全部为只读操作；服务 `127.0.0.1:7317` 未重启。DB 探针用 `node:sqlite` 的 `DatabaseSync({readOnly:true})`。

**1) 引擎配置与限额（证明 fallback 恒空、batchItems=6）**
```
$ curl.exe -s http://127.0.0.1:7317/api/translate/engines      # 原样返回是一个 5 元素数组
[{"id":"deepseek","name":"DeepSeek","needsKey":true,"configured":true,"supportsAuto":true,
  "maxChars":3000,"maxItems":6,"concurrency":2,"model":"deepseek-chat","desc":"OpenAI 兼容协议（…）"},
 {"id":"qwen",...,"configured":true,...},
 {"id":"openai",...,"configured":false,...},
 {"id":"gemini",...,"configured":false,...},
 {"id":"claude",...,"configured":false,...}]
```
（`...` 处为 name/desc 等不相关字段的省略；关键是 `openai/gemini/claude` 三个 fallback 候选全是 `configured:false`，且限额 `maxItems:6` 与 config 默认一致）

**2) 全命中任务的计数（证明 `requests` 语义 = 每批 1 次，且命中不建索引）**
```
$ curl.exe -s http://127.0.0.1:7317/api/jobs/translate/40
{"jobId":40,"status":"done","engine":"deepseek","model":"deepseek-chat","tgtLang":"zh-CN","srcLang":"auto","scope":"all",
 "totalSegments":285,"doneSegments":285,"failedSegments":0,"totalPages":10,"donePages":10,
 "requests":0,"cacheHits":285,"anchorPage":null,"errorCode":null,"errorMessage":null,
 "createdAt":1793715489668,"startedAt":1793715489668,"finishedAt":1793715489693,
 "lastRun":{"requests":0,"batches":0,"cacheHits":285,"usage":{"promptTokens":0,"completionTokens":0,"fallbackCount":0},
            "finishedAt":1793715489693}}
```
（job 创建到完成 **25ms**、`batches:0`，说明 285 段全部命中，一次上游请求都没发；而 `translations_fts` 仍是 0 行 → 命中路径不写索引）

**3) 已完成任务显示 0/N（证明 progressFromDb 用当前库反推）**
```
$ curl.exe -s http://127.0.0.1:7317/api/jobs/translate/16
{"jobId":16,"status":"done","engine":"mock","model":"mock-v2",...,"totalSegments":536,"doneSegments":0,
 "failedSegments":0,"totalPages":14,"donePages":0,"requests":0,"cacheHits":0,...,"lastRun":null}
```
（库内该 job 的 `total_segments` 是 492，返回 536 → 被 `progressFromDb` 覆盖；`lastRun:null` 证明内存态在重启后丢失）

**4) 译文侧搜索（证明 dst 索引为空）**
```
$ curl.exe -s "http://127.0.0.1:7317/api/works/1.8/search?q=智能体&side=dst"
{"q":"智能体","assetId":4,"hits":0,"degraded":null,"rewritten":true,"keywords":"智能体","rewriteMocked":false,
 "reason":"rewritten-no-hit","results":[]}

$ curl.exe -s "http://127.0.0.1:7317/api/works/1.8/search?q=agent&side=dst"
{"q":"agent","assetId":4,"hits":0,"degraded":null,"rewritten":false,"keywords":null,"rewriteMocked":false,
 "reason":"no-hit-no-rewrite","results":[]}

$ curl.exe -s "http://127.0.0.1:7317/api/works/1.8/search?q=可信&side=src"
{"q":"可信","assetId":4,"hits":0,"degraded":null,"rewritten":true,"keywords":"trust trustworthiness credibility",
 "rewriteMocked":false,"reason":"rewritten-no-hit","results":[]}
```
（同一次会话早些时候 `q=智能体&side=dst` 曾返回 `hits:5` 但全部 `"hitLang":"src"`、`"textDst":null` —— 命中的是英文原文，不是译文；两次结果都指向"dst 侧一条可检索的译文都没有"）

**5) SSE 终局（证明不发 `done`、不 `end()`）**
```
$ curl.exe -sN --max-time 3 "http://127.0.0.1:7317/api/jobs/translate/40/events"
event: progress
data: {"jobId":40,"totalSegments":285,"doneSegments":285,"failedSegments":0,"donePages":10,"totalPages":10,
       "cacheHits":285,"batchesDone":0,"requests":0,"elapsedMs":2190041,"at":1793717679709,"status":"done",
       "engine":"deepseek","model":"deepseek-chat","tgtLang":"zh-CN"}

curl_exit=28 elapsed_ms=3031
```
（`status` 已经是 done，流里没有 `event: done`，连接也不关闭 → 只能靠客户端自己判断；`elapsedMs=2190041` 说明 36 分钟后 `/jobs/:id` 仍在实时反推进度）

**6) 库现状（一次查询）**
```js
// 探针脚本（node:sqlite DatabaseSync({readOnly:true})，等价于 node -e "...")
{
 "segments": 5947,
 "translations": 3532,
 "translations_fts": 0,
 "segments_fts": 5232,
 "tr_dangling": 3532,
 "tr_reachable": 0,
 "assets_version": [{"v":0,"n":1},{"v":4,"n":13}],
 "tr_version": [{"v":1,"n":1301},{"v":2,"n":307},{"v":3,"n":798},{"v":4,"n":567},{"v":6,"n":77},{"v":9,"n":482}],
 "tr_stale": 2965,
 "job_cols": "id,asset_id,status,engine,model,src_lang,tgt_lang,prompt_fp,scope,scope_pages,total_segments,done_segments,failed_segments,anchor_page,error_code,error_message,created_at,started_at,finished_at",
 "jobs_by_status": [{"status":"done","n":40}]
}
```

**7) 测试覆盖核查（grep 工具对 `server/test/*.test.js` 的 `test(` 匹配，仅列这三个文件）**
```
batches.test.js   :8 maxItems 切分 / :13 maxChars 切分 / :21 空段被跳过、不占用批次 / :26 超长段独占一批
                  / :33 全空→空批列表 / :37 编号 / :41 正常解析 / :47 覆盖率<60%→null / :52 缺项空串占位
                  / :57 超长段按句切 / :64 cleanPageText / :72 splitSentences
cacheKey.test.js  :18 确定性 / :22 换模型→miss / :26 改指纹→miss / :30 换语言/引擎→miss / :35 版本+1→miss
                  / :39 srcLang 不进键 / :44 空白/NFKC / :50 正文不同→不同键 / :54 \u0000 分隔 / :60 normalizeForHash
dual-index.test.js:67 原文侧 / :74 译文侧命中（D22 核心）/ :82 不无中生有 / :87 去重 / :96 mergeHits textDst
                  / :112 rowid 替换不堆积 / :122 deleteTranslationIndexForAsset / :128 buildMatchExpr
```
未覆盖：`runJob` 的部分失败→status、命中路径不重建索引、cancel→resume、编号缺项在 pipeline 层的降级、scope=pages 的进度口径、`buildBatches` 跳空段与 `slice` 配对的错位（F6）。
