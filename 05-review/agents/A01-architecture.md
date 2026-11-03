# A01 架构评审：分层、模块职责与依赖关系

> 范围：`03-code/server`（95 个 ESM 模块 / 300 条内部 import 边）+ `app.js`/`index.js`/`migrate.js`/`db.js` 启动编排 + STATUS.md 偏离点。
> 口径：按"现在会造成什么后果"定严重度；只读 03-code，唯一写操作发生在 `05-review/agents/_scratch/app-copy.db`（`data/app.db` 的副本）。
> 取证时间：2026-11-03 22:38–22:52（Asia/Shanghai），7317 实例运行中。

## 结论

1. 分层在**代码依赖方向**上基本成立：95 模块、300 边、**真实环 0 个**，`config(41) / db(31) / errors(29) / logger(21)` 是仅有的四个高扇入底座；但 `routes/*` 里有 5 处直接 SQL（含 1 处写操作），"routes 不写 SQL"的自我约束只在 works.js 一个文件里兑现。
2. 真正贵的不是分层，而是**启动编排 + 派生索引**：`migrate()` 跑在 `applyDbSettings()` 之前，迁移期看到的引擎是 `deepseek`，运行期是 `qwen`；而唯一能把译文索引从 DB 重建回来的函数在现网数据上产出 **indexed=0 / expected=1347**。
3. 后果已经发生、不是理论：现网 `translations_fts` **0 行**、`translations.segment_id` **3532/3532 全部悬空**，`GET /api/works/1.8/search?q=计算机汇刊` 返回 `hits:0`，而该资产下确实存在含"IEEE计算机汇刊"的译文 —— 中文检索静默失效。
4. "数据库是唯一真相"**不成立**：DB 是任务状态的真相，但不是派生索引的真相（不可重建），也不是代价记账的真相（`jobStats` 在内存，重启后 `GET /jobs/translate/1` 显示 done 但 requests=0/cacheHits=0/lastRun=null）。
5. 问到的"路径遮蔽"**不存在**：`/api/works/lookup` 注册在 `/api/works/:no` 之前且未被吞，三种请求各有实测响应（见"排除项"）；中间件顺序没有实质问题，唯一异味是 `allowMultipartPaths` 白名单里两个路径当前根本没有对应路由。

## findings

### F1｜译文索引在现网库已归零，且没有任何路径能把它重建回来 — blocker

> **与 A05-data-layer 重叠**：`A05-data-layer.md:8/16/56` 的 F1/F2 已把"3532 条悬空 + `translations_fts` 0 行 + 两条修复路径同时失效 + 启动无自愈"讲全，合并时以 A05 为主干。本节只补两个架构视角：①启动链上没有任何"索引 vs 译文"对账步骤（这是 Q6"DB 是唯一真相"的第一个反例）；②`backfillTranslationIndex` 与 `expectedTranslationIndexCount` 用了两套口径（id 反查 vs 内容 join），迁移断言因此自比自。

**现象**：`translations` 3532 行、`translations_fts` 0 行；3532 行的 `segment_id` 全部指向不存在的段；`backfillTranslationIndex()` 扫完后 `indexed=0`，同时"应索引段数"算出 1347。中文检索因此恒 0 命中。

**证据**：

- `03-code/server/schema.sql:145`（全库唯一一条没有 `REFERENCES` 的跨表列）：
  ```
  segment_id      INTEGER,          -- v2：译文所属段落（重抽后靠 extract_version 失效，不再 join 猜）
  ```
  `PRAGMA foreign_key_list(translations)` 实测只有 `{"table":"assets","from":"asset_id","on_delete":"SET NULL"}`；`PRAGMA table_info` 无触发器（`type='trigger'` 为空），即没有任何机制清理或重链悬空行。
- `03-code/server/services/fts.js:152-156`（回填按"id 存在性"取数，段没了就跳过，而不是按文本重新定位）：
  ```
      const seg = get('SELECT id FROM segments WHERE id = ?', [r.segment_id]);
      if (!seg) {
        skipped += 1; // 段已被删除：不塞索引，避免指向不存在的段
        continue;
      }
  ```
- `03-code/server/services/fts.js:191-200`（"应索引段数"用的是另一套口径：内容 join）：
  ```
       JOIN translations t
         ON t.asset_id = s.asset_id AND t.src_text = s.text AND t.engine = ? AND t.tgt_lang = ?
        AND t.segment_id IS NOT NULL
      WHERE a.extract_version = s.extract_version AND s.is_math = 0 AND s.is_label = 0${extra}
  ```
- 动态（副本只读）：`count translations_fts=0 / segments_fts=5232 / translations=3532 / segments=5947`；`segment_id dangling=3532`；`backfillTranslationIndex({engine:'deepseek',tgtLang:'zh-CN'}) => {"indexed":0,"expected":1347,"skipped":2907}`。
- 动态（真实接口，`rewrite=0` 避免触发 LLM 改写）：
  - `GET /api/works/1.8/search?q=计算机汇刊&rewrite=0` → `{"hits":0,"reason":"no-hit-no-rewrite","results":[]}`
  - 同资产 `GET /api/works/1.8/search?q=protocol&rewrite=0` → `{"hits":3,...}`（原文侧正常）
  - 而副本里该资产的译文含 `"IEEE计算机汇刊，第C-29卷，第12期，1980年12月"`。

**影响**：`_context` 不变量⑨（双索引同事务、`translations_fts.rowid=segments.id`）在数据层已经破了，且破得不可自愈：唯一的重建入口 `backfillTranslationIndex`（也是 `cli/fts-rebuild.js:47` 的唯一手段）在当前数据上必然产出 0 行。用户侧症状是"中文问英文文献搜不到"，接口如实返回 `no-hit-no-rewrite`，**没有任何信号能区分"库里没有这条译文"和"索引坏了"**；默认 `rewrite=1` 时还会退化成一堆额外的查询改写 LLM 调用，把失效伪装成"能搜到一部分"。`GET /api/health` 只报 `missingAssets/activeJobs/works`，对索引健康状况零观测。

**建议**：① `translations.segment_id` 改 `REFERENCES segments(id) ON DELETE CASCADE`，或彻底删除该列、索引一律按 `(asset_id, extract_version, 原文)` 定位；② `backfillTranslationIndex` 的取数口径改成与 `expectedTranslationIndexCount` 同一套 join（现在一个是 id、一个是文本）；③ 启动时做一次 `expected vs translationIndexCount()` 对账，不一致就重建，重建失败写进 `/api/health`（加 `translationIndex: {rows, expected}` 字段）。

**effort**：M

### F2｜启动顺序：迁移在 DB 设置生效之前跑，迁移期的"当前引擎"和运行期不是同一个 — high

**现象**：`index.js` 先 `migrate()` 再 `applyDbSettings(all)`，而 `migrate()` 内部的"当前引擎/目标语言"来自 `config`（此时只有 `config.local.json` 的值）。

**证据**：

- `03-code/server/index.js:21-24`：
  ```
    openDb(cfg.server.dbPath);
    const mig = migrate();
    applyDbSettings(all);
    ensureDirs();
  ```
- `03-code/server/services/fts.js`（`activeTranslationTarget()` 只读 config）：
  ```
  export function activeTranslationTarget() {
    return { engine: String((config.translate && config.translate.engine) || ''), tgtLang: String((config.translate && config.translate.tgtLang) || 'zh-CN') };
  }
  ```
- `03-code/server/migrate.js:76-78`（迁移期无条件清空 + 按"错引擎"回填）：
  ```
    const active = activeTranslationTarget();
    exec('DELETE FROM translations_fts');
    const bf = backfillTranslationIndex({ engine: active.engine, tgtLang: active.tgtLang });
  ```
- `03-code/server/migrate.js:103-105`（断言用同一个错目标算期望值，自比自）：
  ```
    const expected = expectedTranslationIndexCount(indexStats.engine, indexStats.tgtLang);
    const actual = translationIndexCount();
    if (actual !== expected) {
  ```
- 动态：`03-code/config.local.json` 写 `"engine": "deepseek"`，`settings` 表实有 `translate.engine = qwen`；直接调用真实模块打印：
  ```
  A) activeTranslationTarget() after loadConfig()  [what migrate() sees] = {"engine":"deepseek","tgtLang":"zh-CN"}
  B) activeTranslationTarget() after applyDbSettings() [what app runs with] = {"engine":"qwen","tgtLang":"zh-CN"}
  ```

**影响**：① 任何走到 v2 的库，索引按 `deepseek` 重建、应用按 `qwen` 查询，143 条 qwen 译文永远搜不到；② 断言自比自，这类偏移永远不会失败，等于给坏数据盖章"迁移成功"；③ `exec('DELETE FROM translations_fts')` 是无条件全清，一旦重跑就把当前引擎的索引一起删掉，而 `assertMigration` 在 `indexStats.distinct === 0` 时直接 `return {checked:false}`（migrate.js:98-101），连抽样都跳过 —— 这是 F1 那种"索引 0 行却无人报错"能够长期存在的机制。④ 顺带回答"两次 `ensureDirs()`"：第一次（index.js:18）是为了 `openDb()` 能建 `data/` 目录；第二次（:24）是因为 `applyDbSettings()` 可能改了 `download.downloadDir`/日志目录。两次都"必要"，但它们是"配置分两阶段读"的直接产物，掩盖了真正缺失的东西：**目录合法性与索引一致性应该在设置生效后统一校验一次**，而现在 `ensureDirs()` 只 mkdir，什么都不验。

**建议**：把"DB 设置优先"做成单一入口（`loadConfig({db})`：openDb → 读 settings → 定稿 config → migrate），并把 `migrate(target)` 改成显式入参而不是内部读 `config`；迁移里的 `DELETE` 改成只删目标 `(engine,tgt_lang)` 的行，不要全表清。

**effort**：S

### F3｜routes 直接写业务 SQL 与状态，绕过服务层状态机 — high

**现象**：46 个注册端点里有 5 处路由内直接 SQL，其中 1 处是写操作；`assets.file_state` 因此有两个写者。

**证据**：

- `03-code/server/routes/assets.js:108-112`（路由把资产标 missing，含 `missing_since` 语义）：
  ```
        run("UPDATE assets SET file_state='missing', missing_since=?, updated_at=? WHERE id=?", [
          Date.now(),
          Date.now(),
          asset.id,
        ]);
  ```
- `03-code/server/routes/health.js:13` 与 `:22`（健康检查自己拼统计 SQL）：
  ```
      const missingAssets = get("SELECT count(*) AS n FROM assets WHERE file_state='missing'").n;
  ```
  ```
        works: get('SELECT count(*) AS n FROM works WHERE retired = 0').n,
  ```
- `03-code/server/routes/segments.js:44`（同一文件 :89 又写了一遍几乎一样的查询）：
  ```
      const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
  ```
- 对照：`03-code/server/routes/works.js` 文件头明确写着"只做参数校验+调服务+序列化"，而 assets/health/segments 三个文件不遵守。

**影响**：`file_state` 的写者有 downloader 的校验失败路径和路由的 410 分支，`missing_since` 只在两处各自成立；下一轮只要给资产状态加一列（`missing_reason`/`last_seen_at`）就必须同时改服务层和路由层，且漏改不会有测试失败。这是"改需求时会爆发"的典型负债：分层不是靠纪律维持，而是靠"没人加字段"维持。

**建议**：把 `markAssetMissing(id)`、`countMissingAssets()`、`getPdfAsset(workId)` 收进 `services/storage.js` / `services/artworks.js`，路由只调用；加一条测试：扫 `routes/*.js` 禁止出现 `FROM ` / `UPDATE ` 字面量（works.js 已经做到，说明这条规则是可执行的）。

**effort**：S

### F4｜`bootDownloader()` 的恢复动作是 fire-and-forget，`await` 是假的，失败静默 — high

> **与 A02-code-quality 重叠**：`A02-code-quality.md:127` 的 F3 已描述"try 只包同步段、readdir 失败服务起不来、catch 静默放弃"，合并时以 A02 为主干。本节只补状态机视角：`booted` 只在 `.then()` 内部置位，因此诚实响应 `activeDownloadCount()`/`pump()` 的时间窗口与原意不符。

**现象**：`index.js:27 await bootDownloader()` 实际等待的是 `return Promise.resolve()`，真正的恢复链在后台跑。

**证据**：`03-code/server/services/downloader.js:62-84`：
```
export function bootDownloader() {
  const now = Date.now();
  const reset = run(
    `UPDATE download_jobs SET status='queued', next_retry_at=NULL WHERE status IN ('resolving','downloading','verifying')`,
  );
  // 清掉上次进程留下的 .part 残片
  try {
    const dir = tmpDir();
    return fsp
      .readdir(dir)
      .then((files) => Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true }))))
      .then(() => {
        for (const j of all("SELECT id FROM download_jobs WHERE status='queued' ORDER BY created_at ASC")) queue.push(j.id);
        booted = true;
        ...
```
（函数末尾另有 `return Promise.resolve();`）

**影响**：`readdir → rm 残片 → 填充内存队列 → booted=true → pump()` 整条链的 rejection 无人处理（`.then` 链没有 `.catch`，`await` 的在 mock 上永远是已决议的 Promise）；而 `booted = true` 只写在 `.then` 里 —— rm 或 DB 查询失败时 `booted` 停在 false，`pump()` 永远不会被调用，DB 里那批被重置成 `queued` 的任务会永远排队。§9.4"重启自动恢复悬挂任务"这条承诺因此**没有可观测的成功信号**（日志只在 `reset.changes > 0` 时打一行）。现网 `download_jobs` 里 24 条 needs_manual + 4 条 done，暂时没有 queued，所以这个坑还没踩到。

**建议**：改成 `async` 函数 + `try/catch/finally`，`await` 每一步；失败时 `log.error` 并在 `/api/health` 暴露 `downloadBooted: booted`；`.part` 清理不应阻塞队列恢复（两件事拆开，清理失败只 warn）。

**effort**：S

### F5｜依赖方向倒置三处：service→middleware、route→route、route→引擎内部件 — medium

**现象**：分层箭头有三处反向，其中一处的后果是"缓存键契约有两个实现"。

**证据**：

- `03-code/server/services/downloader.js:20`（服务层依赖中间件；而 `middleware/security.js` 同时装着入站 Host/Origin 校验和出站 SSRF 的 `assertUrlSafe`/`isPrivateAddress`，两个方向的安全职责同文件）：
  ```
  import { assertUrlSafe } from '../middleware/security.js';
  ```
- `03-code/server/routes/chat.js` → `import ... from './assets.js'`（route 引 route，路由模块互相共享校验辅助）。
- `03-code/server/routes/segments.js:12-16`（路由越过 `translate/pipeline` 直接拿四件内部件）：
  ```
  import { retrieve } from '../services/chat/retrieval.js';
  import { getWorkRow } from '../services/artworks.js';
  import { buildCacheKey } from '../services/translate/cacheKey.js';
  import { promptFingerprint, resolveTemplate } from '../services/translate/prompts.js';
  ```

**影响**：`buildCacheKey` 是不变量⑧（`sha256(engine|model|tgtLang|promptFp|extractVersion|normalizedText)`）的唯一实现，路由自己再拼一遍，意味着"prompt 指纹/引擎/模型"的槽位语义在 pipeline 之外还有第二个调用点；改缓存键算法时漏改路由不会有测试失败，只会静默缓存击穿（多花 LLM 钱，而现网零真实调用，这个坑会拖到接真 key 那天）。`downloader → middleware` 让服务层单元测试被迫加载 Express 相关的中间件模块。

**建议**：`assertUrlSafe`/`isPrivateAddress` 移到 `services/net/ssrf.js`（middleware 反过来 import）；cacheKey 的计算收进 `services/translate/preview.js`；chat.js 需要的路由辅助提到 `services/artworks.js`。

**effort**：M

### F6｜内存态边界：`jobStats`/下载队列/对话 inflight 重启即丢，且丢的方式对用户是"静默归零" — medium

**现象**：三处内存态中，两处的丢失对用户不可见，一处的丢失恰好是干净设计。

**证据**：

- `03-code/server/services/translate/pipeline.js:37-42`（注释自己承认）：
  ```
   * 最近一次运行的计数（内存态，不持久化）：请求数、批次数、缓存命中数。
   * 持久化没有意义（重启后没有「那次运行」这个概念），但自测与排障需要看得到。
   * @type {Map<number, {requests:number,batches:number,cacheHits:number,usage:Object,finishedAt:number}>}
   const jobStats = new Map();
  ```
- `03-code/server/services/translate/pipeline.js:325-327`：`GET /api/jobs/translate/:id 走 progressFromDb，只读 DB 拿不到这两个内存计数，界面上会一直显示「请求 0」。`
- 动态：`GET /api/jobs/translate/1` → `{"status":"done","totalSegments":536,"doneSegments":0,"donePages":0,"requests":0,"cacheHits":0,"lastRun":null}` —— 任务行说 done，进度与代价记账全是 0/null。
- 对话侧：`PRAGMA table_info(messages)` 无 `status` 列（id,chat_id,role,content,citations,context_meta,provider,model,prompt_tokens,completion_tokens,latency_ms,error_code,feedback,created_at,truncated,retrieval_miss,tool_calls,attachments）；`services/chat/runtime.js:5` 的 `inflight = new Map()` 只用于接线取消。→ 中断的 assistant 消息整条不落库，不会留下"永远 streaming"的脏行。
- 下载侧：`queue/controllers/progress/lastRequestAt/booted` 都是内存（downloader.js:29-38），但 `activeDownloadCount()` 查 DB，所以状态展示是对的。

**影响**：§16.5 的"代价记账"在重启后归零，与"DB 是唯一真相"矛盾；用户看到的 token/请求数不可跨会话核对。下载队列属于"DB 是真相、内存是投影"的正确形态；对话属于"不落库=不存在"的干净选择 —— 这两条应该写进不变量，而 `jobStats` 是唯一真的越界项。

**建议**：把 usage/requests/batches/cacheHits 落到 `translate_jobs` 列或一张 `job_runs` 表（M2 的 40 条 done 任务已经证明这些数字现在无处安放）；`jobStats` 只保留为运行期加速；把"assistant 消息要么完整落库要么不存在"补进不变量文档。

**effort**：M

### F7｜`db.js` 在 import 副作用里改全局进程状态，且与 `--no-warnings` 重复 — medium

> **与 A03-deps-docs 重叠**：`A03-deps-docs.md:160-166` 已记录 `removeAllListeners('warning')` 与 `--no-warnings` 的重复，合并时以 A03 为主干。本节只补分层视角：`db.js` 是扇入 31 的底层模块，它改的是**整个进程**的 warning 监听器集合，任何后续模块再注册 warning 监听都会被它 `removeAllListeners` 掉（取决于 import 顺序）。

**现象**：模块加载时清空全进程的 `warning` 监听者，再装一个自己的。

**证据**：`03-code/server/db.js:11-17`：
```
// 一次性过滤 node:sqlite 的 ExperimentalWarning（白名单式，不影响其它告警）
process.removeAllListeners('warning');
process.on('warning', (w) => {
  const msg = `${w.name}: ${w.message}`;
  if (w.name === 'ExperimentalWarning' && /SQLite|node:sqlite/i.test(w.message)) return;
  process.stderr.write(`${msg}\n`);
});
```
而 `03-code/package.json` 的四个 npm script 全部带 `--no-warnings`：
```
"start": "node --no-warnings server/index.js",
"import": "node --no-warnings server/import-cli.js",
"test": "node --no-warnings --test \"server/test/*.test.js\"",
"fts:rebuild": "node --no-warnings server/cli/fts-rebuild.js"
```

**影响**：`--no-warnings` 已经把目标解决了，这段代码等于用"削减全局可观测性"换零收益；`removeAllListeners('warning')` 会静默清掉任何其它模块（现在或将来）注册的告警监听，行为取决于 import 顺序；它是 import 期副作用，测试里只要 import 了 `db.js` 就会污染同进程其它测试的告警捕获。此外 `await import('node:sqlite')` 的顶层 await 让 `db.js` 成为"加载即挂起"的模块，`config.js` 之类纯数据模块的测试也被迫进入异步加载路径。

**建议**：删掉 12-17 行，依赖启动参数；如确需过滤，用 `process.on('warning', fn)` 而不动已有监听者，并把这段移到 `index.js`/`import-cli.js` 的入口而非库模块。

**effort**：S

### F8｜STATUS.md 13 条偏离里有 3 条是架构级负债（其余 10 条无害） — medium

**挑出的 3 条与"为什么贵"**：

1. **#1 项目根落在 `03-code/`**（`03-code/STATUS.md:79`）—— "部署时可以整体上移一层，路径解析不用改"这句承诺没有任何测试保障：`config.js` 用模块自身位置推 `ROOT`，而 `storage/pdfs`、CSV 默认 `../Agent工作流文献清单.csv`、log/tmp 全挂在这一个隐式根上，DB 里存的还是 `storage_rel_path` 相对路径。改一次部署形态就要重新验证 4 条路径族 + 424 条资产的 rel_path 语义，`resync` 若判错会把全部资产标 missing。
2. **#10 `PUT /api/settings/downloadDir` 只实现 switch**（`03-code/STATUS.md:88`）—— 物理存储的位置是不可变属性，但代码把它当可变配置：换目录后 `assets.storage_rel_path` 全部失效，而唯一修复路径（§21 R4 的全盘搜索 resync）正是 `03-code/STATUS.md:102` 承认"未做"的部分。改需求"换磁盘/换机器/多库"会同时牵动 `storage`/`downloader`/`resync`/`assets` 四个模块。
3. **#5 PDF 页数校验不用 pdfjs**（`03-code/STATUS.md:83`）—— 现在 pdfjs 已是硬依赖并承担抽取权威（`03-code/server/services/extractor.js:26`: `export const PDFJS_VERSION = '6.4.299';`；`:42`: `pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');`），但下载准入的"页数≥1"仍由手写结构解析 `services/pdf/meta.js#assertPdfFile` 判定 → 同一个 PDF 存在两个页数权威，罕见结构（对象流/`/Kids` 嵌套）下准入与抽取会给出不同结论，而修正口径要重新判定已入库的 424 条资产。

其余 10 条（文件命名、页面命名、新增 CLI、`fetchPdf` 位置、Origin 缺失即放行、`section` 不受字段锁、Windows 0600、CSV 口径差、并发配置、import-from-inbox）判为**无害实现选择或已知限制**：它们不会在下一轮改需求时把改动扩散到多个模块。ISSUE：#8"Origin 缺失即放行"在只监听 127.0.0.1 的前提下是可接受的，但一旦打包成桌面壳（自定义 scheme / `file://`，Origin 可能为 `null`）就会放开整条写路径 —— 属于"环境需求变化时爆发"，不是"改需求爆发"，故不列入 3 条。

**影响**：这 3 条都不是 bug，但都把"一个需求改动"放大成"跨模块迁移 + 存量数据重新判定"，是下一轮最容易变成 blocker 的种子。

**建议**：按 #5 → #10 → #1 的顺序处理（#5 只需把 `assertPdfFile` 的页数分支换成 pdfjs 已加载的 `getDocument`，#10 需要先补 §21 R4 的 resync，#1 需要把 `ROOT` 变成显式配置项并加一条"路径族"测试）。

**effort**：L

### F9｜唯一的绕路 import + 11 处 `../../../` 深度逃逸，且没有 lint/测试兜底 — low

**现象**：`services/layout/refine.js` 用 `../../services/...` 绕出同目录层级；另有 11 处跨越 3 层以上。

**证据**：

- `03-code/server/services/layout/refine.js:18`（同目录应为 `../llm/client.js`）：
  ```
  import { openaiChat, hasKey } from '../../services/llm/client.js';
  ```
- 同类深度逃逸（`../../../`，共 11 处），例如 `03-code/server/services/chat/tools/lit-read.js:8`：
  ```
  import { all } from '../../../db.js';
  ```
  以及 `03-code/server/services/translate/engines/registry.js:8-9`。

**影响**：单看每一处都无害（解析结果正确），它的价值在于证明"没有可执行的路径规则"：任何文件搬家都能悄悄制造同类路径，而 155 个测试照样全绿。这类问题只有在做目录重构时才暴露，且是"重构当天才发现"的那种。

**建议**：加一条 `node:test` 扫描（正则遍历 `server/**/*.js`，禁止 import 路径含超过 2 个 `..`、禁止 `../../services/`），或引入 import 边界检查脚本进 `npm test`。

**effort**：S

### F10｜`securityMiddleware` 的 multipart 白名单预授权了两个不存在的路由，且白名单与路由表没有对齐测试 — low

**现象**：`app.js:43` 把两条正则作为"允许 multipart 的路径"交给安全中间件，但全库 46 个已注册端点里**没有** `POST /api/works/:no/asset`，也**没有** `POST /api/chats/:id/attachments`。白名单描述的是"曾经存在或计划存在"的路由，而不是现存路由。

**证据**：

- `03-code/server/app.js:42-44`：
  ```
    allowMultipartPaths: [
      /^\/api\/works\/[^/]+\/asset$/,
      /^\/api\/chats\/[^/]+\/attachments$/,
  ```
- 46 条路由全表（本轮已逐文件抽取）中不含上述任一路径：`assets.js` 是 `GET /assets/:id/file`、`POST /assets/:id/reveal`、`POST /assets/scan-inbox`、`POST /assets/import-from-inbox`；`chat.js` 是 `POST /chats`、`GET /chats`、`GET /chats/:id/messages`、`POST /chats/:id/messages`、`POST /chats/:id/messages/:mid/cancel`、`POST /messages/:id/feedback`、`GET /chats/:id/attachments/:attId`、`DELETE /chats/:id`。
- 反过来看：现存真正收 multipart 的端点（若有）并不在白名单里，说明这张表从未与路由表核对过。

**影响**：今天无害（正则匹配不到任何处理器）。风险是**安全策略以"路径字符串"为唯一事实来源，且这份来源没有编译期/测试期约束**：后续任何人按白名单补上 `POST /api/works/:no/asset`，就自动继承一个 Content-Type 豁免（跳过 `securityMiddleware` 的 JSON 强制），而评审时看不到这层耦合；反过来新增真正的上传端点时，忘记改白名单会让请求在中间件被 415/400 直接拒掉，错误信息指向 Content-Type 而不是"你没登记白名单"。这是"配置与代码两份真相"的最小实例，与 F1（断言口径分裂）是同一类病。

**建议**：①把 `allowMultipartPaths` 改成"由路由自己在挂载时声明"（如 `router.post('/works/:no/asset', multipart(), h)`，中间件读 `req.route` 而不是正则表）；或 ②保留正则，但加一条测试：启动 `createApp()` 后遍历 `allowMultipartPaths`，用 `app._router.stack`（或对每条正则发一个 `OPTIONS`）断言匹配到真实注册的路由，不匹配就 fail。成本约 20 行，能永久锁死这类漂移。

**effort**：S

### 排除项（Q2 / Q3：实测未构成问题，但需要留档）

- **Q2 依赖图**：`modules=95 edges=300`，**CYCLES=0**，UNRESOLVED=0。扇入 Top：`config.js 41 / db.js 31 / errors.js 29 / logger.js 21 / services/fts.js 9 / services/llm/client.js 9 / services/storage.js 9`。扇出 Top：`app.js 15 / services/chat/agent.js 13 / services/chat/pipeline.js 12 / routes/segments.js 11 / routes/assets.js 9 / services/extractor.js 9 / services/translate/pipeline.js 9 / index.js 8 / services/downloader.js 8`。**没有真正的循环依赖**。值得注意的两个形状：`services/fts.js` 扇入 9（被 routes、extractor、translate/pipeline、chat/retrieval 同时写索引）——它是事实上的"横切索引层"，451 行里混了四件事（段索引、译文索引、检索、迁移辅助）；`services/chat/` 内部扇出很高（agent 13 / pipeline 12），但它自己是一个竖切子系统，不外溢。
- **Q3 路由遮蔽**：`app.js:49-61` 的 11 个 `api.use(...)` 顺序与 `/api` 挂载没有问题；`works.js` 里 `/works/lookup` 确实注册在 `/works/:no` 之前，且三种请求都落到正确处理器（见动态验证记录 #8）。`/lit-uploader.user.js` 在静态挂载之前（`app.js:63`），顺序正确。唯一异味已提升为独立条目 **F10**（见下）。

## 覆盖与盲区

- **02-design 未通读**（架构设计文档 194KB，按指令只 grep 定位）：我只对照了 §6 目录树、§9.4 恢复策略、§16.5 代价记账、§21 R4 四处，且是以 STATUS.md 的引用为准去核对，没有独立回读设计原文。因此"实现与设计的偏离清单是否完整"我不能背书。
- **web/ 与 userscript/ 未审查**：本轮问题限定在 server 分层，前端是否绕开 API 直连 DB/文件、userscript 的直传是否真的走 `/api/works/lookup`，都没有验证（`/works/lookup` 的注释声称"浏览器直传脚本用"，我只验证了 HTTP 行为，没有验证脚本侧调用）。
- **测试与实现的对应关系未验证**：155 test pass 来自 `_context`，我没有跑 `npm test`。按 grep，`server/test/dual-index.test.js:62` 是**手工**调 `fts.indexTranslation()` 造索引，绕过了真实的 `extract → translate` 生命周期 —— 我怀疑这是 F1 长期未被发现的原因，但**没有跑测试证实**，属推断。
- **真实 LLM 引擎未验证**（无 key）：F5"缓存键漏改会静默花钱"是基于代码路径的推断；`translate.engine` 现网是 qwen 但零真实调用，qwen 引擎实现是否存在/是否可路由，我没有验证。
- **`app.db` 是活库**：所有库内数字以 22:40 复制的 `_scratch/app-copy.db` 为准；23:00 之后若实例继续写入（`/api/jobs/...` 轮询、resync），现网数值可能已变，但结构性结论（悬空 100%、索引 0 行）不会因几十行写入而反转。
- **未回答的**：F1 的"为什么 3532 条 segment_id 全悬空"我只证明了结果，没有还原出是哪一次 `extract`（`extract_version+1`）造成的 —— 需要历史上 M2 期的抽取日志，而日志目录本轮没查。
- 未评估性能（无压测）；未评估依赖管理（`package.json` 只有 2 个 dependencies，无 devDependencies，`npm audit` 按指令不跑）。

## 动态验证记录

> 全部命令在 `D:\A-knowledge\agent工作流优化` 下执行；`curl.exe` 只读调用 7317；`node` 只对 `_scratch/app-copy.db` 副本操作（唯一一次写回填也只落在副本）。

**1. 内部 import 图（`node 05-review/agents/_scratch_A01_graph.mjs`）**
```
modules=95 edges=300
--- TOP FAN-IN ---
 41 config.js
 31 db.js
 29 errors.js
 21 logger.js
  9 services/fts.js
  ...
--- TOP FAN-OUT ---
 15 app.js
 13 services/chat/agent.js
 12 services/chat/pipeline.js
 11 routes/segments.js
```
（脚本内以 `CYCLES` 计数强连通分量，输出 `CYCLES=0 UNRESOLVED=0`）

**2. 启动顺序（`node 05-review/agents/_scratch_A01_order.mjs`，先复制 app.db+wal+shm 到副本）**
```
counts: translations_fts= 0 segments_fts= 5232 translations= 3532 segments= 5947
translations per work/engine: [{"no":"1.11","engine":"deepseek","n":1511},{"no":"1.8","engine":"deepseek","n":1396},{"no":"4.6","engine":"mock","n":482},{"no":"1.8","engine":"qwen","n":143}]
sample: [{"no":"1.8","engine":"deepseek","segment_id":12395,"dst":"IEEE计算机汇刊，第C-29卷，第12期，1980年12月"}, ...]
A) activeTranslationTarget() after loadConfig()  [what migrate() sees] = {"engine":"deepseek","tgtLang":"zh-CN"}
B) activeTranslationTarget() after applyDbSettings() [what app runs with] = {"engine":"qwen","tgtLang":"zh-CN"}
```

**3. 悬空引用（`node -e` 内联 SQL 查副本）**
```
translations total      = 3532
segment_id not null     = 3532
segment_id dangling     = 3532
segments min/max id     = {"mn":79793,"mx":85739}
dangling by engine      = [{"engine":"deepseek","n":2907},{"engine":"mock","n":482},{"engine":"qwen","n":143}]
download_jobs by status = [{"status":"done","n":4},{"status":"needs_manual","n":24}]
translate_jobs by status= [{"status":"done","n":40}]
```

**4. 回填口径 vs 断言口径（`node 05-review/agents/_scratch_A01_fts.mjs`）**
```
target seen by migrate() = {"engine":"deepseek","tgtLang":"zh-CN"}
expectedTranslationIndexCount(deepseek,zh-CN) = 1347
expectedTranslationIndexCount(qwen,zh-CN) = 112
expectedTranslationIndexCount(mock,zh-CN) = 211
translationIndexCount() now = 0
backfillTranslationIndex({engine:deepseek}) = {"indexed":0,"expected":1347,"skipped":2907}
translationIndexCount() after backfill = 0
=> assertion compares actual 0 vs expected 1347
```

**5. 中文检索实测（工作 1.8，资产 id=4）**
```
GET /api/works/1.8/search?q=计算机汇刊&rewrite=0
{"q":"计算机汇刊","assetId":4,"hits":0,"degraded":null,"rewritten":false,"keywords":null,"rewriteMocked":false,"reason":"no-hit-no-rewrite","results":[]}

GET /api/works/1.8/search?q=protocol&rewrite=0&topK=3
{"q":"protocol","assetId":4,"hits":3,"degraded":null,"rewritten":false,"reason":"hit","results":[
 {"segmentId":81574,"pageNo":8,"ord":12,"text":"CONTRACT NET PROTOCOL SPECIFICATION","score":-5.91910368108969,"hitLang":"src","textDst":null}, ...]}
```

**6. 重启后代价记账归零（`curl /api/jobs/translate/1`，DB 里该 job 为 done）**
```
{"jobId":1,"status":"done","engine":"mock","model":"mock-v1","tgtLang":"zh-CN","scope":"pages","totalSegments":536,
 "doneSegments":0,"failedSegments":0,"totalPages":14,"donePages":0,"requests":0,"cacheHits":0,"anchorPage":2,
 "errorCode":null,"errorMessage":null,"createdAt":1793420286059,"startedAt":1793420286059,"finishedAt":1793420286096,"lastRun":null}
```

**7. 外键与触发器（`node 05-review/agents/_scratch_A01_fk.mjs`，副本）**
```
translations FKs: [{"id":0,"seq":0,"table":"assets","from":"asset_id","to":"id","on_update":"NO ACTION","on_delete":"SET NULL","match":"NONE"}]
indexes on translations: ["sqlite_autoindex_translations_1","idx_tr_asset"]
triggers: []
views: []
```
`messages` 列实测无 `status`：`id,chat_id,role,content,citations,context_meta,provider,model,prompt_tokens,completion_tokens,latency_ms,error_code,feedback,created_at,truncated,retrieval_miss,tool_calls,attachments`

**8. 路径遮蔽（Q3）四连测**
```
GET /api/works/lookup?doi=10.9999/definitely-not-here
  → 200 {"found":false,"matched":{"doi":"10.9999/definitely-not-here","arxiv":null}}      ← 命中 lookup，未被 :no 吞

GET /api/works/lookup
  → 400 {"error":{"code":"E_BAD_REQUEST","message":"需要至少一个可归一的 doi 或 arxiv 标识符",
                  "detail":{"fields":["doi","arxiv"]},"traceId":"1d1dd910"}}             ← 是 lookup 自己的报错

GET /api/works/lookup/bogus
  → 404 {"error":{"code":"E_NOT_FOUND","message":"接口不存在：GET /api/works/lookup/bogus", ...}}
     ← 未匹配任何 /api 路由，落到 notFoundHandler，仍是 JSON 信封

GET /api/works/1.1
  → 200（work 1.1 Cybernetics，"availableTranslateOptions":{"engines":[]}）
```

**9. 运行时生效配置 vs 磁盘配置**
```
GET /api/settings → translate.engine = qwen（config.local.json 写的是 deepseek）
settings 表实有: translate.engine=qwen / translate.engines.deepseek.model=deepseek-chat /
                 translate.engines.mock.latencyMs=30 / translate.refineEngine=deepseek / translate.prompt=''
PRAGMA user_version = 4
```

**10. 依赖清单与启动参数（`node -e` 读 package.json）**
```
deps: {"express":"^4.22.3","pdfjs-dist":"^6.4.299"}
scripts: {"start":"node --no-warnings server/index.js","import":"node --no-warnings server/import-cli.js",
          "import:dry":"node --no-warnings server/import-cli.js --dry-run",
          "test":"node --no-warnings --test \"server/test/*.test.js\"","fts:rebuild":"node --no-warnings server/cli/fts-rebuild.js"}
```
