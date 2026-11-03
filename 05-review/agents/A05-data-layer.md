# A05 数据层（schema / 索引 / 事务 / 迁移 / FTS 一致性）

审核对象：`03-code/server/schema.sql`、`server/db.js`、`server/migrate.js`、`server/services/fts.js`、`server/services/extractor.js`、`server/services/translate/pipeline.js`、`server/services/artworks.js`、`server/services/storage.js`、`server/index.js`、`server/cli/fts-rebuild.js`，以及实库 `03-code/data/app.db`（只读开库实测）。
环境：Windows / node v24.19.0（`node:sqlite`）/ 现网服务 7317 只在跑（仅只读 curl）。

## 结论

1. **数据层最重的不是 schema 而是 FTS 一致性**：段重抽只删段与译文索引，却不迁移 `translations.segment_id`，实库里 3532 条译文 100% 指向已不存在的段，`translations_fts` 活行为 0 —— 中文检索恒 0 命中（现网 API 实测 `hits:0`，而同表 `LIKE '%合同网%'` 有 146 行），且英文命中也不再回填译文（`textDst:null`），属静默给错误结论。
2. **唯一的两条修复路径同时失效**：`backfillTranslationIndex` 只按 `segment_id` 单路回填并显式跳过悬空行，`npm run fts:rebuild` 修不好；翻译走缓存命中分支时又完全不重建索引，因此重跑翻译也不会自愈。若哪天触发 v2 形状修复，断言会因 `actual=0` 直接让服务起不来。
3. schema 本身没有结构级错误（表/约束/FK 方向合理，`foreign_keys=ON` 确实开着），问题集中在**索引错配**：缺 `translations(segment_id)`、`download_jobs(work_id)`、`translate_jobs(asset_id)`，而 `idx_segments_asset` 与 UNIQUE 自动索引完全同构白占 94KB，`idx_works_year`/`idx_works_arxiv` 被 `IFNULL()` 包裹后永远用不上。
4. 迁移是 fail-closed 的好设计（整级一个事务、升级前 `VACUUM INTO`、断言+回滚），且实测 `PRAGMA user_version` 在事务内确实会回滚——"版本前进但数据没迁"不成立。真正的迁移问题在**可运维性**：备份零保留策略（已 12 份 27.1MB＝库体 2.3 倍），版本口径三处不一致（STATUS.md 写 2 / schema.sql 写 3 / 实库 4）。
5. 体积只增不减：WAL 5.05MiB 常驻（未设 `journal_size_limit`，`wal_autocheckpoint` 用默认 1000 页）、freelist 179 页不回收、3532 条译文里 2965 条 `extract_version` 陈旧永不复用也永不清除；`segments_fts` 影子表吃掉全库 47%。

## findings

### F1（blocker）段重抽只清译文索引、不迁移 `translations.segment_id`，导致 3532 条译文全悬空、中文检索恒 0 命中

**现象**：`extractAsset()` 在事务里先删两套 FTS 索引再 `DELETE FROM segments`，注释明确写了"段 id 会变，译文索引必须跟着清"，但 `translations` 表里指向段的 `segment_id` 列既不删除也不按 `(asset_id,page_no,ord)` 重映射。重抽后新段 id 与旧 `segment_id` 完全脱钩，译文行成为永久孤儿。

**证据**（`03-code/server/services/extractor.js:244-248`，一字未改）：

```js
  tx(() => {
    deleteIndexForAsset(asset.id);
    // 段 id 会变：译文索引必须跟着清，否则会指向已删除的段（搜到却取不回来）
    deleteTranslationIndexForAsset(asset.id);
    run('DELETE FROM segments WHERE asset_id = ?', [asset.id]);
```

`03-code/server/schema.sql:145` 的设计假设与实际实现不符：

```sql
  segment_id      INTEGER,          -- v2：译文所属段落（重抽后靠 extract_version 失效，不再 join 猜）
```

实库实测（只读）：`translations` 3532 行、`segment_id` 非空 3532 行、**悬空 3532 行（100%）**、`JOIN segments ON segments.id=translations.segment_id` 活行 **0**；`translations_fts` 活行 **0**。当前 3 个已译资产的 segments 现 id 区间 80579–82044，而译文 `segment_id` 区间 1766–69920，零重叠。

现网 API 铁证：

```
GET /api/works/1.8/search?q=合同网&rewrite=0&topK=3
{"q":"合同网","assetId":4,"hits":0,...,"reason":"no-hit-no-rewrite","results":[]}

同库: SELECT count(*) FROM translations WHERE asset_id=4 AND dst_text LIKE '%合同网%'  → 146
      SELECT count(*) FROM translations_fts WHERE translations_fts MATCH '"合同 同网"' → 0
```

英文侧同样受损：`GET /api/works/1.8/search?q=contract net&rewrite=0&topK=2` 返回 `hits:2`，但两条结果 `"textDst":null`（回表查 `translations WHERE segment_id=?` 查不到，见 `03-code/server/services/fts.js:270-273`）。

**影响**：中文提问对已翻译的 3532 段恒 0 命中，检索层拿不到任何上下文却照常作答（即 STATUS.md:225 自己定义的"静默错误，比报错更糟"）；已产出的 3532 条译文失去与段落的关联，UI 里译文详情、引用定位、`tr_done` 统计全部失效。这是数据关系层面的损坏，不是运行时降级。

**建议**：重抽事务内增加一步"按 `(asset_id,page_no,ord)` 把 `translations.segment_id` 重映射到新段 id，映射不到的置 `segment_id=NULL` 并按 `cache_key` 保留"；`extract_version` 语义保持（它管缓存失效），不要再用它替代段关联。同时给 `translations` 加 `(asset_id,page_no,ord)` 唯一约束或回填脚本，并在重抽后立即重建译文索引。

**effort**：L（要改 extractor + 回填 + 补测试，还要对现库跑一次历史数据修复）。

### F2（high）两条修复/自愈路径同时失效：`fts:rebuild` 跳过全部悬空行，缓存命中分支永不重建索引，启动无自愈

**现象**：`backfillTranslationIndex()` 是全库唯一的重建入口，但它只按 `segment_id` 反查段，查不到就 `skipped += 1` 跳过——F1 造成 3532 行全悬空，于是重建结果 `indexed=0`。另一条路是重跑翻译：`translations` 缓存命中时只 `hits+1`，既不写 FTS 也不修正 `segment_id`，所以"把译文重新跑一遍"同样不会自愈。

**证据**（`03-code/server/services/fts.js:151-158`）：

```js
  for (const r of rows) {
    const seg = get('SELECT id FROM segments WHERE id = ?', [r.segment_id]);
    if (!seg) {
      skipped += 1; // 段已被删除：不塞索引，避免指向不存在的段
      continue;
    }
    indexTranslation(r.segment_id, { engine: r.engine, tgtLang: r.tgt_lang, text: r.dst_text });
```

（`03-code/server/services/translate/pipeline.js:283-286`）：

```js
    const row = get('SELECT cache_key FROM translations WHERE cache_key = ?', [key]);
    if (row) {
      hits += 1;
      run('UPDATE translations SET hits = hits + 1, last_hit_at = ? WHERE cache_key = ?', [Date.now(), key]);
```

启动路径也不自愈：`03-code/server/index.js:21-37` 只有 `openDb → migrate → bootDownloader → bootTranslateJobs → resyncStorage`；`migrate()` 在 `user_version=4` 时直接跳过（`03-code/server/migrate.js:215-218`）。

**影响**：故障不可自愈，只能靠人工改库。更糟的是它会让"自动修复"变成"服务起不来"：`schemaNeedsV2()` 一旦判定形状需修（`migrate.js:174-203`），v2 迁移里的 rebuild 得 `actual=0`，而 `expectedTranslationIndexCount` 对当前引擎 qwen 为 112（deepseek 1347 / mock 211，`settings.translate.engine=qwen`），断言不满足即抛错、整事务回滚、进程非 0 退出（`migrate.js:97-116`、`migrate.js:248`）。fail-closed 在缺自愈的前提下等价于 fail-dead。

**建议**：`backfillTranslationIndex` 增加第二路回填——`segment_id` 悬空时按 `(asset_id,page_no,ord)` 找新段，找不到再按 `cache_key` 反查 `src_text` 相同的段；启动时若 `expected>0 && actual===0` 打日志并触发一次增量重建（不要静默跳过）；缓存命中分支在同一事务里补一次 `indexTranslation`。

**effort**：M（fts.js + pipeline.js + index.js 三处小改，加一条测试）。

### F3（medium）索引错配：缺 `translations(segment_id)` 导致每次命中回表全表扫；`idx_segments_asset` 与 UNIQUE 自动索引完全重复；`idx_works_year`/`idx_works_arxiv` 被 `IFNULL()` 废掉

**现象**：检索命中后逐条回表查译文用的 `WHERE segment_id = ? AND engine = ? AND tgt_lang = ?` 没有任何可用索引；`segments` 上显式建的 `idx_segments_asset(asset_id,page_no,ord)` 与表内 `UNIQUE(asset_id,page_no,ord)` 生成的 `sqlite_autoindex_segments_1` 列序完全一致，纯冗余；`works` 的两个条件索引在真实查询里被函数包裹，优化器弃用。

**证据**（`03-code/server/services/fts.js:271`）：

```js
      'SELECT dst_text FROM translations WHERE segment_id = ? AND engine = ? AND tgt_lang = ? LIMIT 1',
```

EXPLAIN 实测：`SCAN translations`（3532 行全扫，topK=24 即一次请求 24 次全表扫；`EXPLAIN` 输出见动态验证记录 V5）。`03-code/server/schema.sql:128`：

```sql
CREATE INDEX IF NOT EXISTS idx_segments_asset ON segments(asset_id, page_no, ord);
```

库内 `idx_segments_asset` 与 `sqlite_autoindex_segments_1` 各 23 页，冗余的那份白占 94KB（23×4096）。`idx_works_year` / `idx_works_arxiv`（`schema.sql:44,46`）在 `03-code/server/services/artworks.js:139,149` 被 `IFNULL(w.year,0) >= ?`、`IFNULL(w.arxiv_id,'') <> ''` 包裹后，实测均为 `SCAN w`（去掉函数的等价写法才 `SEARCH ... USING INDEX`）。

**影响**：当前数据量（3532 行）下单次检索只多 6.6ms，可忽略；但这是 O(命中数 × 全表行数) 的形态，译文表随翻译量线性增长（每篇论文约 160 段，3532 行只对应 3 个资产），上千篇时会成为检索主瓶颈。冗余索引则是纯写放大 + 空间浪费。

**建议**：加 `CREATE INDEX idx_tr_segment ON translations(segment_id, engine, tgt_lang)`（或直接把 `(segment_id,engine,tgt_lang,dst_text)` 做成覆盖索引）；删 `idx_segments_asset`（UNIQUE 索引已覆盖同样前缀）；把 `IFNULL` 条件改写成 `(w.year IS NULL OR w.year >= ?)` 或直接去掉函数包裹，否则删掉这两个死索引。

**effort**：S。

### F4（medium）列表页每行两个相关子查询命中无索引表：`download_jobs(work_id)` / `translate_jobs(asset_id)` 缺索引

**现象**：作品列表的 `BASE_SELECT` 用相关子查询为每一行取"最近一次下载任务"，`download_jobs` 上只有 `uq_download_active(work_id) WHERE status IN (...)` 部分唯一索引和 `(status,created_at)`，前者谓词不匹配（外层要任意状态），后者前缀是 status；`translate_jobs` 同样只有 `uq_translate_active(asset_id,engine,tgt_lang)` 部分唯一索引，取 `ORDER BY id DESC LIMIT 1` 用不上。

**证据**（`03-code/server/services/artworks.js:31-34`）：

```js
  LEFT JOIN download_jobs dj ON dj.id = (
    SELECT j.id FROM download_jobs j WHERE j.work_id = w.id
     ORDER BY (CASE WHEN j.status IN ('queued','resolving','downloading','verifying') THEN 0 ELSE 1 END), j.id DESC
     LIMIT 1)
```

EXPLAIN 实测该子查询为 `SCAN download_jobs` + `USE TEMP B-TREE FOR ORDER BY`（V5）；`translate_jobs WHERE asset_id=? ORDER BY id DESC LIMIT 1`（`artworks.js:224`）同样是 `SCAN translate_jobs`。列表 424 行 → 单次请求 424 次子查询。

**影响**：目前 `download_jobs` 28 行、`translate_jobs` 40 行，实测列表接口不慢；一旦历史任务表增长（每次重试都插行），列表与列表轮询会成为热点，且 `ORDER BY (CASE...)` 的临时 B-TREE 无法消除。

**建议**：加 `CREATE INDEX idx_download_work ON download_jobs(work_id, id DESC)` 与 `CREATE INDEX idx_translate_asset ON translate_jobs(asset_id, id DESC)`；或把"最近一次任务"物化成 `assets.last_job_id`/`works.last_download_id` 列（写入时更新，读时零子查询）。

**effort**：S（加索引即可，物化列是 M）。

### F5（medium）默认列表排序是 SQL 表达式，任何索引都用不上：`SCAN works` + 两次 `TEMP B-TREE`

**现象**：作品编号 "4.6" 需要按"段号.序号"两段整数排序，排序键被写成 `substr/instr` 表达式并在子查询外 `ORDER BY`，无法走 `idx_works_section(section_no,no)`；按 `updated_at` 排序、会话列表按 `updated_at` 排序同样是临时 B-TREE。

**证据**（`03-code/server/services/artworks.js:14`）：

```js
export const NO_ORDER_SQL = `CAST(substr(no,1,instr(no,'.')-1) AS INTEGER), CAST(substr(no,instr(no,'.')+1) AS INTEGER)`;
```

EXPLAIN 实测（默认列表）：`SCAN w` + `USE TEMP B-TREE FOR ORDER BY` ×2（V5）；`SELECT ... FROM chats WHERE archived=0 ORDER BY updated_at DESC` 也是 `SCAN chats` + `TEMP B-TREE`（`idx_chats_work(work_id,updated_at DESC)` 前缀不匹配）。

**影响**：424 行时无感，但这是列表首屏的必经路径，且每次分页都重排全表；作品数到数千后首屏明显变慢，`LIMIT/OFFSET` 分页还会随页深退化。

**建议**：加持久化排序列 `sort_major INTEGER, sort_minor INTEGER`（导入/补丁时写入，`idx_works_sort(sort_major,sort_minor)`），排序改为直接引用；会话列表加 `idx_chats_archived_updated(archived, updated_at DESC)`。

**effort**：M（要改写入路径 + 回填 + 索引）。

### F6（medium）体积只增不减：WAL 无上限、freelist 不回收、2965 条陈旧译文缓存永不复用也不清理

**现象**：`openDb()` 只设四个 pragma，没有 `wal_autocheckpoint`、没有 `journal_size_limit`，`closeDb()` 也不做 `wal_checkpoint(TRUNCATE)`；`auto_vacuum=OFF` 且从不 `VACUUM`；`translations` 没有 DELETE 路径，重抽/换引擎/升级 extractor 只会让旧行沉淀。

**证据**（`03-code/server/db.js:37-40`）：

```js
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
```

实测：`journal_size_limit=-1`（永不截断）、`wal_autocheckpoint=1000`（默认，约 4MB 才 checkpoint）、`freelist_count=179`（733KB 已释放但未还给文件系统）、`app.db-wal=5,294,232 B`（库体 11.9MiB 的 42%，长期存在）。`translations` 3532 行中 **2965 行** `extract_version <> 4`（当前 `EXTRACTOR_VERSION=4`），这些行按缓存键规则永远不会再命中（`pipeline.js:283` 只按 `cache_key` 查，不清旧版本）。`segments_fts_data` 单表 1429 页 / 5.85MB，占全库 47%。

**影响**：磁盘与读放大持续劣化；WAL 长期不 checkpoint 会让每次读都要跨 wal 索引页，且在 `synchronous=NORMAL` 下崩溃恢复窗口变大。旧译文行还干扰"已翻译段数"统计口径：`artworks.js:28` 的 `tr_done` 只数 `extract_version = a.extract_version` 的译文，实测 asset 2 = 0/482、asset 4 = 287/1539、asset 5 = 280/1511——库里有译文但 UI 计数严重偏低。

**建议**：`openDb` 增加 `PRAGMA journal_size_limit=8388608` 与显式 `wal_autocheckpoint`；`closeDb` 加 `wal_checkpoint(TRUNCATE)`；迁移或 CLI 里加一次 `DELETE FROM translations WHERE extract_version <> ?`（或归档到历史表）；`auto_vacuum=INCREMENTAL` + 定期 `PRAGMA incremental_vacuum`（`VACUUM INTO` 后替换亦可）。

**effort**：S（pragma + 一条清理 SQL）；incremental vacuum 需要重建库，算 M。

### F7（medium）迁移备份零保留策略，已堆积 12 份 27.1MB（库体 2.3 倍），且代码注释声称"保留最近几份"

**现象**：升级前 `VACUUM INTO` 到 `data/backup/`，文件名带 `from` 版本与日期戳，目标已存在时加 `HHMMSS` 只加一层后缀；没有任何清理/轮转代码，也没有在入库时检查剩余磁盘。`db.js` 的注释写着"保留最近几份即可"，但从来没有实现。

**证据**（`03-code/server/db.js:152`）：

```js
  // VACUUM INTO 不允许目标已存在：同日多次迁移时加时间后缀，保留最近几份即可
```

（`03-code/server/migrate.js:226-231`）备份调用点，只写不删：

```js
    if (from > 0) {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const target = path.join(paths.dataDir, 'backup', `app-${stamp}-v${from}.db`);
      backupTo(target);
```

实测 `data/backup/`：**12 个 .db，合计 28,438,528 B（27.1MB）**——其中 10 个是同一天 12:42:01→12:44:39 之间每 4 秒一份的成功备份（`app-20261031-v1-044201` … `-044439`），说明当时有循环重试/反复启动；最新一份 `app-20261103-v3.db` 4.88MB。全仓 `grep backup` 仅有 `db.js:150 backupTo` 与 `migrate.js:229` 两个写入点，无 `unlink`/`readdir` 清理逻辑。

**影响**：每次迁移/+27MB，迁移是"重启即可能触发"的路径，长期会撑爆磁盘；更危险的是 `VACUUM INTO` 需要目标库同量级临时空间，磁盘将满时备份会失败并直接阻断启动（fail-closed，但没有预检和告警）。文档侧没有任何保留策略说明。

**建议**：`migrate.js` 在备份前做两件事——`fs.statfs` 可用空间 < 3×库体则拒迁并明确报错；保留最近 N=3 份、按 `mtime` 清理更老的（含同日后缀文件）。CLI 增加 `npm run backup:prune`，文档写清保留策略与手工恢复步骤（`03-code/data/backup/README`）。

**effort**：S。

### F8（low）版本口径三处不一致：实库 v4、schema.sql 写 3、STATUS.md 写 2

**现象**：`schema.sql` 自称"全量 DDL 唯一事实源"，末尾却仍把 `user_version` 写成 3，而 `migrate.js` 的 `TARGET_VERSION` 是 4；STATUS.md 描述 v2 时写 `user_version = 2`，之后从未更新。实库只读实测为 4。

**证据**（`03-code/server/schema.sql:255`）：

```sql
PRAGMA user_version = 3;
```

（`03-code/server/migrate.js:32`）：

```js
export const TARGET_VERSION = 4;
```

（`03-code/STATUS.md:311`）：

```text
schema.sql 同步为 v2 全量，`user_version = 2`。
```

**影响**：不造成数据错误（新库路径 `migrate.js:238-243` 执行 schema.sql 后再跑 v4，且 v4 的 `addColumnIfMissing` 全是 no-op，结果是正确的 4）；但会误导排障：按 schema.sql 判断"当前 schema 是 v3"的人会以为还差一个迁移，STATUS.md 又让人以为只有 v2。属于"唯一事实源"名不副实。

**建议**：schema.sql 末尾写 `PRAGMA user_version = 4;` 并在 CI 里断言 `TARGET_VERSION === schema.sql 的值`（一条 grep 即可）；STATUS.md 该段加注"v2 时期描述，现为 v4"。

**effort**：S。

### F9（low）约束缺口：枚举列全是自由文本，`assets` 可 present 而无路径，`chats.archived` 无 CHECK

**现象**：`segments.role/tier/align` 的取值域只写在注释里，没有任何 CHECK，写入端拼错/新增枚举时库不拦；`messages.truncated/retrieval_miss/tool_calls`（v2/v3 加列）同样无 CHECK；`chats.archived` 无 `CHECK(archived IN (0,1))`，而 `works.retired` 有；`assets.storage_rel_path` 可空，但 `file_state='present'` 的行必须能定位文件（`resyncStorage` 依赖它）。

**证据**（`03-code/server/schema.sql:120-122`）：

```sql
  role            TEXT,                    -- 版面角色：title/author/abstract/section/body/caption/figure-label/equation/footnote/reference/header/footer/page-number/quote/list-item/unknown
  tier            TEXT,                    -- 排版层级：h1/h2/body/small（驱动字号与对齐）
  align           TEXT,                    -- left/center
```

（`03-code/server/schema.sql:215`）：

```sql
  archived   INTEGER NOT NULL DEFAULT 0,
```

（`03-code/server/schema.sql:57` 的 `storage_rel_path TEXT,` 可空，而 `file_state` 语义要求 present 必有路径）。

**影响**：当前没有脏数据（实测 `segments.role` 取值均在枚举内），但坏值只能在 UI 层表现为"排版异常/检索缺失"，排障成本高；`present` 无路径会让 `resyncStorage` 把它算成 missing 并回写状态，产生抖动。

**建议**：`role/tier/align` 加 `CHECK (role IN (...))`（或在写入层用 JS 常量枚举 + 入库校验），`chats.archived` 加 `CHECK(archived IN (0,1))`，加 `CHECK (file_state <> 'present' OR storage_rel_path IS NOT NULL)`。注意 SQLite 加 CHECK 需重建表，适合与 F3 的索引迁移合并成一次 v5。

**effort**：M（表重建）；只做 JS 侧校验则 S。

### F10（low）`tx()` 不是真可重入：无 SAVEPOINT，嵌套内层异常被外层吞掉会静默提交

**现象**：`tx()` 用模块级计数器把嵌套调用"扁平化"，只有最外层 `BEGIN IMMEDIATE`/`COMMIT`；内层不建 savepoint，也不会独立回滚。若外层 `try { tx(inner) } catch {}` 吞掉内层异常，内层的部分写入会跟着外层 COMMIT 一起落库。另外函数签名是同步的，若误传 async 函数会在 `await` 之前就 COMMIT。

**证据**（`03-code/server/db.js:113-128`）：

```js
export function tx(fn) {
  if (txDepth > 0) {
    txDepth += 1;
    try {
      return fn();
    } finally {
      txDepth -= 1;
    }
  }
  const d = requireDb();
  d.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    d.exec('COMMIT');
```

实测 SQLite 对嵌套 `BEGIN IMMEDIATE` 的行为：`cannot start a transaction within a transaction`（V3），因此扁平化本身是必要的、不是错的；错在没有 savepoint 语义。当前 6 个调用点（`artworks.js:367`、`downloader.js:516`、`extractor.js:244`、`importer.js:308`、`storage.js:296`、`migrate.js:248`）经逐个核对**均无嵌套、均为同步函数**，所以现在没有实际损坏。

**影响**：潜在雷区而非现网故障——未来任何人在事务里调用带 `tx()` 的公共函数（例如在 `resyncStorage` 的 tx 里调 `patchWork`），内层失败会变成"半提交"，且不会有任何报错；这是数据一致性问题里最难查的一类。

**建议**：改为计数器 + `SAVEPOINT tx_sp_N`：`txDepth>0` 时 `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`，保留扁平化的外部 API；同时在 `tx()` 入口断言 `fn.constructor.name !== 'AsyncFunction'`，并在 dev 下打一条 warning。

**effort**：S。

## 覆盖与盲区

- 已读全文：`server/schema.sql`(255)、`server/db.js`(160)、`server/migrate.js`(269)、`server/services/fts.js`(451)、`server/index.js`(78)、`server/cli/fts-rebuild.js`(50)、`server/routes/segments.js`(117)。
- 已读片段：`extractor.js:220-339`、`translate/pipeline.js:265-424`、`artworks.js:10-213`、`storage.js:280-349`、`downloader.js:505-560`、`importer.js:270-324`。
- 实库只读实测覆盖：pragma、行数、索引/表清单、`dbstat` 页占用、11 条真实查询的 `EXPLAIN QUERY PLAN`、3 个资产的译文悬空率、`extract_version` 分布、文件体积、backup 清单。
- **未做**：没有运行 `npm test`/`npm run fts:rebuild`（会写库且任务禁止；rebuild 的效果由代码 + 只读 SQL 推断，未实际执行）；没有读 `04-test` 全部用例（无法确认是否有针对"重抽后译文索引"的回归测试）；没有读 web/userscript（与本轮无关）；没有在 02-design 里核对 `segment_id` 的原始设计意图（只按 schema.sql:145 的注释判断）。
- **无法证明**：现库 5947 段的 `extract_version` 分布是 1/2/3/4/6/9，说明历史上 extractor 迭代过多次，我无法还原"哪一次重抽"删掉了 asset 4/5 的旧段，只能证明当前状态（译文 100% 悬空）。若再次重抽 assets 4/5，现有 1539+1511 条译文会再次失联且依旧不可自愈（除非先修 F1/F2）。
- 结论的不确定项：`translations_fts` 为空是否曾被 `fts:rebuild` 修好过又被打回，无法从库里区分（`fts5` 影子表无时间戳）；按代码推断，只要经历过一次段重抽就会回到当前状态。

## 动态验证记录

**V1 只读 pragma / 行数 / 索引清单**（`node --input-type=module`，`new DatabaseSync('data/app.db',{readOnly:true})`）：

```
user_version {"user_version":4}
journal_mode {"journal_mode":"wal"}
wal_autocheckpoint {"wal_autocheckpoint":1000}
journal_size_limit {"journal_size_limit":-1}
foreign_keys {"foreign_keys":1}
tables assets,chats,download_jobs,messages,segments,segments_fts,settings,translate_jobs,translations,translations_fts,works
virtual_fts segments_fts,translations_fts
named_indexes 13   autoindexes 5
freelist 179 page_count 3049
```

行数（同一连接，`SELECT count(*)`）：

```
works=424 assets=14 segments=5947 segments_fts=5232 translations=3532 translations_fts=0 chats=38 messages=67 download_jobs=28 translate_jobs=40 settings=9
```

**V2 悬空译文与陈旧缓存**：

```
{"alive":0,"total":3532,"dangling":3532}
{"n":2965}          -- translations.extract_version <> 4
```

**V3 嵌套事务与 user_version 回滚**（`:memory:` 库，验证 migrate.js 的回滚前提）：

```
嵌套 BEGIN IMMEDIATE → Error: cannot start a transaction within a transaction
BEGIN IMMEDIATE; PRAGMA user_version = 4; ROLLBACK; → PRAGMA user_version 仍为 3
```

**V4 现网 API（只读 curl，服务未重启）**：

```
curl "http://127.0.0.1:7317/api/works/1.8/search?q=合同网&rewrite=0&topK=3"
{"q":"合同网","assetId":4,"hits":0,"degraded":null,"rewritten":false,"keywords":null,"rewriteMocked":false,"reason":"no-hit-no-rewrite","results":[]}

curl "http://127.0.0.1:7317/api/works/1.8/search?q=contract%20net&rewrite=0&topK=2"
{"q":"contract net","assetId":4,"hits":2,...,"reason":"hit","results":[
 {"segmentId":81574,"pageNo":8,"ord":12,"text":"CONTRACT NET PROTOCOL SPECIFICATION","score":-11.608560040182068,"hitLang":"src","textDst":null},
 {"segmentId":81444,"pageNo":3,"ord":20,"text":"IV. THE CONTRACT NET PROTOCOL","score":-11.363946745823416,"hitLang":"src","textDst":null}]}
```

**V5 EXPLAIN QUERY PLAN（实测输出；长 SQL 用 `…` 省略，只留决定计划的谓词）**：

```
-- fts.js:271 回表
EXPLAIN QUERY PLAN SELECT dst_text FROM translations WHERE segment_id = ? AND engine = ? AND tgt_lang = ? LIMIT 1
  3 0 SCAN translations

-- artworks.js:31-34 列表页每行相关子查询
EXPLAIN QUERY PLAN SELECT j.id FROM download_jobs j WHERE j.work_id = ? ORDER BY (CASE WHEN j.status IN ('queued','resolving','downloading','verifying') THEN 0 ELSE 1 END), j.id DESC LIMIT 1
  SCAN download_jobs
  USE TEMP B-TREE FOR ORDER BY

-- artworks.js:224
EXPLAIN QUERY PLAN SELECT id, status FROM translate_jobs WHERE asset_id = ? ORDER BY id DESC LIMIT 1
  SCAN translate_jobs

-- 默认列表（works 全扫 + 两次临时 B-TREE）
SCAN w
USE TEMP B-TREE FOR ORDER BY
USE TEMP B-TREE FOR ORDER BY

-- 对照：条件去掉 IFNULL 后
EXPLAIN QUERY PLAN SELECT ... FROM works w WHERE w.year >= ?      → SEARCH w USING INDEX idx_works_year (year>?)
EXPLAIN QUERY PLAN SELECT ... FROM works w WHERE w.arxiv_id IS NOT NULL → SEARCH w USING INDEX idx_works_arxiv (arxiv_id>?)
（真实查询是 IFNULL(w.year,0) >= ? / IFNULL(w.arxiv_id,'') <> '' → 退化为 SCAN w）

-- 正常用上索引的对照（说明不是全局问题）
messages: SEARCH messages USING INDEX idx_messages_chat (chat_id=?)
segments: SEARCH segments USING INDEX idx_segments_asset (asset_id=? AND page_no=? AND ord>?)
chats:    SCAN chats + USE TEMP B-TREE FOR ORDER BY
```

**V6 体积与备份**（PowerShell，只读）：

```
app.db 12488704 B
app.db-shm 32768 B
app.db-wal 5294232 B
backup files=12 bytes=28438528
```

`data/backup/` 清单（节选）：`app-20261031-v1.db` 2.27MB、`app-20261031-v2.db` 2.23MB、`app-20261031-v1-044201.db` … `-044439.db`（10 个，2026-10-31 12:42:01→12:44:39，每 4 秒一份）、`app-20261102-v2.db` 4.34MB、`app-20261103-v3.db` 4.88MB。

**V7 页占用（`dbstat` 聚合，字节 = pages × 4096）**：

```
segments         379 pages / 1.55MB
translations     380 pages / 1.55MB
segments_fts_data   1429 pages / 5.85MB   ← 占全库 47%
segments_fts_content 253 pages / 1.04MB
translations_fts_data 164 pages / 667KB   ← 活行 0，纯墓碑
idx_segments_asset    23 pages  == sqlite_autoindex_segments_1 23 pages
```

**V8 写入点取证（确认没有触发器、没有第二条清理路径）**：

```
grep "DELETE FROM segments|assets|translations" 03-code/server → 仅 extractor.js:248 一处删段
grep "DELETE FROM translations_fts" → fts.js:76(按段 rowid)、:104(单行)、:117(按资产)、migrate.js:77(全清)
grep "CREATE TRIGGER" → 0 命中（FTS 全靠手写调用）
```

**V9 bbox 存储成本抽样**：`segments` 5947 行，`bbox` 文本合计 163,182 B，平均 27.4 B/行（样例 `"[48.19,726.68,242.33,754.52]"`）；`text` 合计 977,222 B，平均 164.3 B/行（与 `char_len` 平均值 164.3 相等，说明 `char_len` 就是 `length(text)`）。平均行原始字节 ≈ 198 B（不含页开销与索引）。
