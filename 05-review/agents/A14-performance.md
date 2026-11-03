# A14 性能与可伸缩性（带测量的基线）

> 评审对象：`D:\A-knowledge\agent工作流优化\03-code`（server / web）
> 测量时服务状态：7317 已有一个实例在跑（全程只读 curl，未重启、未停止）
> 测量日期：2026-11-03 · node v24.19.0 · Windows · `node:sqlite` DatabaseSync（同步 API）
> 所有破坏性实验（migrate / resync / 抽取 / FTS 重建 / 扩表）**全部在 `%TEMP%\a14work\*.db` 的库副本上跑**，用 `config.js:167-168` 的 `AGENTLIT_DB` / `AGENTLIT_DOWNLOAD_DIR` 环境变量覆盖；线上 `03-code/data/app.db` 只以 `readOnly:true` 打开。

## 结论

1. **现在真正在拖慢用户的只有一处，而且它不是慢，是错**：`translations_fts` 是空表（3532 条译文 0 条索引），中文查询打在有译文的资产上必走"改写→搜英文"降级 —— 同义查询实测 **940ms vs 8ms（114×）**，还多花一次 LLM 调用。
2. **所有 HTTP 接口本身都不慢**：p50 分别 8.9 / 2.1 / 5.5 / 2.4ms，最慢的列表接口里 SQL 占 5.96ms、JSON 序列化只占 0.08ms（1.3%）；`pageSize=50` 的 4.20ms 里有 **3.59ms（85%）** 花在每行两次相关子查询上。
3. **可伸缩性风险集中在主线程**：单篇抽取 109–930ms、最长一次独占事件循环 **122–145ms**；FTS 全库重建 **1051ms 全同步**。并发两次抽取只有 **0.65×** 加速（≈0.5 才是真并行），400 篇批量导入外推 ≈ **180s 的连续阻塞**。
4. **库体积的 47% 是 FTS 倒排索引碎片**：`segments_fts_data` 5.58MB / 全库 11.91MB，同样 5232 段在新库里只要 0.52MB（**10.7×**）。跑一次 `fts-rebuild` + `VACUUM` 实测 **11.91MB → 6.53MB（-45.2%）**，耗时 1.05s，零代码改动。另有 5.05MB WAL 永不回缩（`journal_size_limit = -1`）。
5. **不要给这个服务加 gzip**：首屏 2046KB 未压缩是真的，但服务只绑 `127.0.0.1`，1.29MB 走回环只要 **3.9ms**，而 gzip 这 10 个文件要 **41.8ms CPU**（brotli q11 要 **2655ms**）—— 压缩是净亏。真正该做的是把已经能用的 ETag/304 换成 `immutable` 长缓存，或者什么都不做。

## 测量表

### T1 API 响应时间（`curl -w`，各 3 次，线上 7317）

| 端点 | p50 | 最慢 | 响应体 | 慢在哪（库副本拆解） |
|---|---|---|---|---|
| `GET /api/works?pageSize=50` | **8.90ms** | **9.10ms** | 43,859 B | SQL+组装 5.96ms、`JSON.stringify` 0.08ms → **SQL 占 98.7%** |
| `GET /api/works/4.6` | 2.06ms | 24.93ms（冷启第一次） | 1,647 B | 逐段 sha256 只在 `keys.size>0` 时跑（4.6 恰好 keys=0） |
| `GET /api/works/4.6/segments` | 5.50ms | 5.81ms | **215,729 B** | SQL 2.56ms（47%）+ JSON 0.83ms（15%）+ Express 写出 ≈2ms |
| `GET /api/health` | 2.40ms | 2.49ms | 338 B | — |

### T2 启动成本（库副本 + 400 个文件的下载目录，`a14_probe5.mjs`）

| 阶段 | ms | 占累计 |
|---|---|---|
| `import config.js` | 1.7 | 1.0% |
| config + logger 就绪 | 3.2 | 2.8% |
| `openDb()` | 6.2 | 6.4% |
| `migrate()`（from=4→4，applied=false） | 4.9 | 9.2% |
| `bootDownloader()` | 22.5 | 22.2% |
| `bootTranslateJobs()` | 6.9 | 26.2% |
| `resyncStorage()`（400 个文件的目录） | **7.5** | 30.5% |
| **`import app.js`（路由 + 服务全图）** | **117.6** | **98.2%** |
| `createApp()` | 3.2 | 100% |
| **累计到 createApp 完成** | **173.7ms** | — |
| `process.uptime()`（含 Node 启动） | 209ms | — |

日志三次独立启动交叉验证（`data/logs/app-2026-11-03.log`）：`migrate.skip` 03:04:11.109 → `resync.done` .119（**10ms**）→ `server.listen` .128（**9ms**）。
纯目录成本：`readdir(400)` **0.64ms**、24×`existsSync` **1.73ms** → **扫 400 个 PDF 的目录成本 2–3ms，不是瓶颈**。

### T3 热路径函数级 p50（库副本，7 次取中位）

| 调用 | p50 | 备注 |
|---|---|---|
| `listWorks({pageSize:1})` | 1.08ms | 基线 |
| `listWorks({pageSize:50})` | **6.46ms** | 线上 HTTP 8.90ms |
| `listWorks({pageSize:200})` | 8.20ms | |
| `listWorks({q:'agent'})` | 5.05ms | 8 列 LIKE 全表扫 |
| `getStats()` | 2.19ms | |
| `getSegments(asset4)` 整篇 | 2.56ms → 215KB | `JSON.stringify` 0.83ms |
| `getSegments(asset4,{page:1})` | 0.13ms | 索引命中 |
| `getWorkDetail('1.8')` 289 段 | **4.39ms** | 逐段 sha256，15.2µs/段 |
| `getWorkDetail('1.11')` 268 段 | 3.56ms | 13.3µs/段 |
| `getWorkDetail` 其余 12 篇 | 0.11–0.56ms | `keys.size=0` → 循环整段跳过 |
| `getTranslateJob(17)` 289 段 | **4.43ms** | `progressFromDb` N+1，15.3µs/段 |
| `exportMarkdown('1.8')` | 5.47ms | 逐段 `get` |

**`listWorks` 成本拆解（库副本，LIMIT 50）**：完整 4.20ms → 去掉两个 count 相关子查询 0.61ms → 只查 works 0.11ms；`count(*)` 包装 0.46ms。
→ **两个相关子查询 = 3.59ms / 4.20ms = 85%**。受控放大到 848 行 works：4.20→3.82ms（不随行数涨），pageSize 10/50/200 = 1.51/4.17/5.49ms → **成本是 O(pageSize)，不是 O(works)**。

### T4 主线程阻塞（真实 PDF，心跳法 + `Promise.all` 对照）

| 场景 | 墙钟 | 事件循环最大停顿 |
|---|---|---|
| 抽取 asset14（701 段） | 633ms | **145ms** |
| 抽取 asset13（768 段） | 400ms | **127ms** |
| 顺序抽两篇 | 566 + 416 = **982ms** | p95 11.6ms |
| `Promise.all` 抽同样两篇 | **641ms** | p95 8.7ms |
| 比值 | **0.65** | ≈0.5 才是真并行，≈1 是完全排队 |
| FTS 全库重建（5232 段，13 个资产） | **1051ms** | 整段不可用（无 yield） |
| 同规模建索引（全新库） | 101ms（0.019ms/段） | 对照：重建路径慢 10× |

抽取进行中一个「等一拍 + `SELECT count(*) FROM works`」的延迟：空闲 p50 0.10 / p95 0.20 / max 0.22ms；抽取中 p50 0.10 / p95 **0.47** / max **3.26ms** —— 简单 DB 请求几乎不受影响，**受影响的是要 CPU 的请求**（列表组装、详情 sha256、215KB JSON 序列化）。

日志全样本抽取耗时（`extract.done.durationMs`，14 次）：109 / 185 / 211 / 334 / 336 / 340 / 355 / 443 / 478 / 637 / 640 / 646 / 685 / 712 / 879 / 930ms → **中位 ≈ 400ms，42 页长文 646–712ms**。

### T5 DB 体积与碎片（真实库 + 受控放大）

| 表/索引 | 真实库 | 5232 段全新库 | 倍数 |
|---|---|---|---|
| **`segments_fts_data`**（倒排索引） | **5.582 MB** | **0.520 MB** | **10.7×** |
| `translations` | 1.484 MB | — | |
| `segments` | 1.480 MB | 1.156 MB | 1.28×（列填充差异） |
| `segments_fts_content` | 0.988 MB | 0.984 MB | 1.00×（内容不膨胀） |
| `translations_fts_data` | 0.637 MB | 0 行数据 | 纯死页 |
| `sqlite_autoindex_translations_1` | 0.281 MB | | |
| `works` | 0.184 MB | | |
| 全库 | **11.91 MB** | | |

受控放大 4×（23,788 段）严格线性 → 每段边际：`segments` **195B**、`segments_fts_content` **197B**、`segments_fts_data` **92B**、`docsize` **10B**；`translations` 含 PK+索引 **519B/行**、`translations_fts` 边际 **≈443B/行**。
**实测修复**：`fts-rebuild`（1051ms）+ `VACUUM` → **12,488,704 B → 6,848,512 B（-45.2%）**，`freelist 179 → 0`。
**WAL**：`app.db-wal = 5,294,232 B (5.049MB)`、`-shm 32,768`、`wal_autocheckpoint=1000`（4MB 阈值）、**`journal_size_limit = -1`**（永不回缩）、`cache_size = -2000`（2MB）、`mmap_size = 0`。

**400 篇 × 1200 段外推**（可翻比例 5232/5947 = 87.98%）：
```
段数 400×1200 = 480,000；可翻段 480,000×0.8798 = 422,400
segments            480,000 × 261B(195+页码头)      ≈ 125.3 MB
segments_fts        content 422,400×197B = 83.2MB
                    data    422,400× 92B = 38.9MB
                    docsize 422,400× 10B =  4.2MB  ≈ 126.3 MB
translations        422,400 × 519B                  ≈ 219.2 MB
translations_fts    422,400 × 443B                  ≈ 187.1 MB
works + messages + 其余                             ≈   3 MB
─────────────────────────────────────────────────────────
索引健康合计 ≈ 665 MB
若维持当前 10.7× 碎片（data 按 1119B/段）：
  segments_fts_data 单独 = 422,400×1119B ≈ 472.8 MB → 合计 ≈ 1.10 GB
```
按**实测真实密度**（14 个 PDF / 5947 段 = 425 段/篇）外推 400 篇：170,000 段 → **235MB / 390MB（带碎片）**。

### T6 内存

| 项 | 数值 | 性质 |
|---|---|---|
| `chat/context.js` 预算上限 | 1200+600+3600+1600+2400+400 = **9800 字符**，+question ≤4000 → **≤13,800 字符** | 按**字符**计，不是 token |
| 换算成 token（0.75 tok/CJK字 + 0.25 tok/ASCII） | 全英文 ≈ **2,450**、中英各半 ≈ **4,900**、全中文 ≈ **7,350** | 对照 `deepseek-chat` 64K 窗口 → 只用到 **4–8%** |
| 语料构成（实测） | `segments` 977,222 字符 **CJK 0.0%**；`translations.dst_text` 204,434 字符 **CJK 52.2%** | 原文全英文 |
| `translate/pipeline.js:184` | `all('SELECT id, page_no, ord, text FROM segments WHERE ...')` **整篇读进内存**，全程持有 `misses` / `batchObjects` 两份引用 | 1200 段 × 平均 164 字符 ≈ 200KB/任务，可控 |
| `page-image-source` 位图峰值 | A4 @ maxEdge 1500 / maxPixels 1.65M → scale 1.781 → 1059×1499px → **6,349,764 B ≈ 6.05 MiB/页** | canvas 复用，只占一块；LRU 8 条 JPEG 结果 |
| `jobStats` / `runners` | 每个翻译任务 `set` 一条，**全文件无 delete/clear** → 无界；单条数百字节 | 40 个 job ≈ 可忽略，属低危泄漏 |

### T7 前端首屏（`curl` 逐资源 + `zlib` 实测压缩）

| 项 | 原始 | gzip(6) | brotli(11) |
|---|---|---|---|
| reader 首屏 10 个资源合计 | **2,095,495 B (2046.4 KB)** | **627,293 B (-70.1%)** | **520,412 B (-75.2%)** |
| 压缩 CPU（10 个文件全量） | — | **41.80ms** | **2,655.01ms** |
| 回环传输 1.29MB（`pdf.worker.min.mjs`） | — | **3.9–4.2ms**（`curl time_total`，TTFB 1.6ms） | — |

- 10/10 资源响应头 `Cache-Control: public, max-age=0` + `ETag`，**无 `Content-Encoding`、无 `Vary`**（显式带 `Accept-Encoding: gzip, br` 仍是 200 且不压缩）。
- `If-None-Match` / `If-Modified-Since` 实测返回 **304**（`app.set('etag', false)` 未影响 serve-static）。
- **首页不加载 pdf.js**：`index.html` 只有 `app.css` + `assets/list.js`；pdf.js 只在 `reader.html → assets/reader.js:10 → assets/viewer.js:11` 链路。

## 瓶颈排序

### 按秒（单次操作阻塞/等待的真实时长）

| # | 项 | 量级 | 触发频率 |
|---|---|---|---|
| 1 | FTS 全库重建（`cli/fts-rebuild.js`） | **1051ms 全阻塞** | 手工/升级时 |
| 2 | 中文查询降级链路（译文索引为空 → 改写 → 搜英文） | **940ms**（对照 8.2ms） | **每次中文检索** |
| 3 | 单篇抽取（主线程，分块 122–145ms） | 109–930ms | 每次抽取 |
| 4 | 400 篇批量导入（外推） | **≈180s**（400×0.45s） | 目标场景 |
| 5 | 清单接口 `pageSize=50` | 6.46ms 函数 / 8.90ms HTTP | 每次翻页 |
| 6 | 详情接口逐段 sha256（1200 段外推） | **≈18ms** | 每次打开详情 |
| 7 | 翻译进度轮询 N+1（809 段） | **≈12.4ms** | 每个轮询周期 + SSE 首帧 |
| 8 | 启动到可服务 | 173.7ms（其中 117.6ms 是模块图） | 每次启动 |
| 9 | 首屏静态资源 | 2.9–7ms（回环） | 每次冷加载 |

### 按 MB

| # | 项 | 当前 | 400 篇外推 |
|---|---|---|---|
| 1 | `segments_fts_data` 碎片 | **5.58MB（47%）** | 472MB（健康时 39MB） |
| 2 | WAL 不回收 | **5.05MB** | 同量级常数 |
| 3 | `translations` + `translations_fts` | 1.48 + 0.64MB | 219 + 187MB |
| 4 | `segments` + `segments_fts_content` | 1.48 + 0.99MB | 125 + 83MB |
| 5 | 全库 | 11.91MB | **665MB 健康 / 1.10GB 现状** |
| 6 | 首屏静态资源 | 2.05MB | 不变（本机不计成本） |

### 投入产出比最高的 3 个动作

1. **跑一次 `node cli/fts-rebuild.js` + `VACUUM`（已有 CLI，零代码改动）** → 库 **-45.2%（省 5.64MB）**，顺带把 3532 条译文补进 `translations_fts`，中文检索 **940ms → 预计 ~8ms**。1.05s 的维护窗口。
2. **把两处"逐段 sha256"改成一条聚合 SQL**（`artworks.js:230-251`、`pipeline.js:511-525`）→ 详情 4.39ms→<0.5ms、进度轮询 4.43ms→<0.5ms，合计每次交互省 **7–30ms**，改 2 个函数。
3. **`listWorks` 的两个相关子查询改 JOIN 聚合**（`artworks.js:27-28`）→ 清单 SQL **-3.59ms（-85%）**，单文件改动。

**明确不建议现在做的**：加 `compression`（回环上净亏 42ms CPU，且会阻塞主线程）；提前上 `worker_threads`（当前单篇手动抽取，145ms 停顿可接受 —— 门槛见 F3）。

## findings

### F1 `translations_fts` 是空表：中文检索静默降级，940ms vs 8ms
- **severity** `high` · **effort** `S`
- **文件**：`03-code/server/services/fts.js:101-113`、`03-code/server/cli/fts-rebuild.js:47`
- **现象**：`translations` 有 **3532 行**，`translations_fts` 有 **0 行**（`_content`/`_docsize` 均 0 行，`_data` 仍占 0.637MB 死页）。唯一能给历史译文补索引的地方是 CLI 的 `backfillTranslationIndex`，但没人跑过。
- **证据**（原文）：
  ```js
  export function indexTranslation(segmentId, p) {
    const id = Number(segmentId);
    if (!Number.isInteger(id) || id <= 0) return;
    run('DELETE FROM translations_fts WHERE rowid = ?', [id]);
  ```
  ```js
  const bf = backfillTranslationIndex(assetId);
  ```
  实测（线上，资产 4 有 1539 条译文）：
  ```
  GET /api/works/1.8/search?q=工作流模式
  {"q":"工作流模式","assetId":4,"hits":1,"degraded":null,"rewritten":true,"keywords":"workflow patterns",
   "reason":"rewritten-hit","results":[{"segmentId":81476,...,"hitLang":"src"}]}   HTTP 200 0.939773s
  GET /api/works/1.8/search?q=workflow%20pattern
  {"reason":"hit","rewritten":false,"hits":2,...}                                   HTTP 200 0.008230s
  ```
- **影响**：每个中文问题都要多一次 LLM 改写（≤3s 超时、计费）才可能命中，且只在**英文原文**里命中；中文译文侧 0 召回。翻译过的资产并未变得可中文检索。
- **建议**：跑一次 `node cli/fts-rebuild.js`（实测 1051ms 补全）；再加一条启动自检 —— `translationIndexCount()` 已存在，若它返回 0 而 `translations` 非空就告警或自动 backfill，防止索引再次静默漂移。
- **动态证据**：见 T5 与「动态验证记录 D4」。

### F2 库体积 45% 可回收：FTS 倒排碎片 10.7×，WAL 永不回缩
- **severity** `medium` · **effort** `S`
- **文件**：`03-code/server/services/fts.js:84-92`、`03-code/server/db.js:32-42`
- **现象**：`segments_fts_data` 5.58MB / 全库 11.91MB（47%），同样 5232 段在全新库只要 0.520MB。原因：每次重抽/重建都 `deleteIndexForAsset` 后逐段重灌，FTS 页碎片只增不减（`segments_fts_content` 0.988 vs 0.984 几乎相同，证明只有倒排索引在膨胀）。WAL 5.05MB 且 `journal_size_limit=-1` 永不回缩。
- **证据**（原文）：
  ```js
  export function indexSegments(assetId, segs) {
    deleteIndexForAsset(assetId);
    for (const s of segs) {
      if (!s || !s.id) continue;
      const idx = toFtsText(s.text);
      if (!idx) continue;
      run('INSERT INTO segments_fts(rowid, text_index) VALUES(?, ?)', [s.id, idx]);
    }
  }
  ```
  ```js
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  ```
  实测：`fts-rebuild`+`VACUUM` → `12,488,704 → 6,848,512 B`（-45.2%），`segments_fts_data 5,853,184 → 1,036,288`，`freelist 179 → 0`。
- **影响**：现在只是 12MB 变 6.5MB 的磁盘问题；按 400 篇 × 1200 段外推，碎片系数不变时库 **1.10GB vs 665MB**（多 435MB）。WAL 长期占 5MB（22% 的增量体积）且崩溃恢复要扫它。
- **建议**：把「重建 + VACUUM」做成 `POST /api/maintenance/rebuild-fts` 或升级脚本的一步；`db.js` 补 `PRAGMA journal_size_limit = 8388608` 与 `PRAGMA wal_checkpoint(TRUNCATE)`（关闭时或定时）。分批插入（每 500 段一次 commit）比一次性大事务更容易触发 checkpoint。
- **动态证据**：见「动态验证记录 D5」。

### F3 抽取与 FTS 重建全在主线程：单块 122–145ms，重建 1051ms 全阻塞
- **severity** `medium` · **effort** `L`
- **文件**：`03-code/server/cli/fts-rebuild.js:36-46`、`03-code/server/services/extractor.js:160`
- **现象**：两者都是同步循环、无分批、无 yield。单篇抽取虽然按页让出事件循环，但**最长一次独占 122–145ms**；并发两次抽取只有 0.65× 加速（≈0.5 才是真并行）。
- **证据**（原文）：
  ```js
  const assets = assetId
    ? all('SELECT id FROM assets WHERE id = ?', [assetId])
    : all("SELECT id FROM assets WHERE extract_status = 'ready'");
  let total = 0;
  for (const a of assets) {
    const segs = all(
      'SELECT id, text, is_math, is_label FROM segments WHERE asset_id = ? AND is_math = 0 AND is_label = 0 ORDER BY page_no, ord',
      [a.id],
    );
    deleteIndexForAsset(a.id);
    indexSegments(a.id, segs.map((s) => ({ id: s.id, text: s.text })));
  ```
  实测：顺序抽两篇 566+416=982ms / `Promise.all` 641ms（**0.65**）；重建 5232 段 1051ms；抽取期心跳 max 145ms。
- **影响**：单用户手动抽取时表现为界面卡 0.1–0.9s；**批量导入 400 篇时是 400×0.45s ≈ 180s 的连续阻塞**，期间列表/详情/JSON 序列化等 CPU 请求全部排队，SSE 进度流停更。
- **建议（量化门槛）**：设 `t_doc` = 单篇抽取墙钟（实测中位 0.4s，P95 0.93s），`g_max` = 最长同步块（实测 145ms），`N` = 期望并发抽取数。判据：**只要 `N ≥ 2` 或 `N×t_doc ≥ 5s`（≈12 篇以上批量）就必须异步化** —— 因为此时用户可感知卡顿 >1s 且 API p95 被 `g_max` 兜底抬高到 145ms。异步化首选 `worker_threads`（零原生模块，不违反不变量 #10），把 `extractAsset` + `toFtsText` 挪进 worker；`fts-rebuild` 至少改成 `await new Promise(setImmediate)` 每资产让一拍。
- **动态证据**：见「动态验证记录 D6」。

### F4 清单接口每行两次相关子查询，占 SQL 时间 85%
- **severity** `low` · **effort** `S`
- **文件**：`03-code/server/services/artworks.js:27-28`、`:163`、`:173`
- **现象**：`pageSize=50` 的 4.20ms 里 3.59ms 是 50 行 × 2 个 `count(*)` 相关子查询；`ORDER BY` 是 `CAST(substr(no,...))` 表达式 → 必然 `USE TEMP B-TREE FOR ORDER BY`。
- **证据**（原文）：
  ```sql
  (SELECT count(*) FROM segments s WHERE s.asset_id = a.id AND s.is_math = 0 AND s.is_label = 0) AS seg_total,
  (SELECT count(*) FROM translations t WHERE t.asset_id = a.id AND t.extract_version = a.extract_version) AS tr_done
  ```
  ```js
  const total = get(`SELECT count(*) AS n FROM (${wrapped})`, [...params, ...derivedParams]).n;
  ...
  const rows = all(`${wrapped} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`, [
  ```
  实测：完整 4.20ms / 去两个子查询 0.61ms / 只查 works 0.11ms；EXPLAIN 显示 `SCAN w` + `CORRELATED SCALAR SUBQUERY 1/2` + `USE TEMP B-TREE FOR ORDER BY`。
- **影响**：现在 HTTP 8.9ms 完全可接受；但每翻一页都白付 3.6ms，且 `tr_done` 数的是 `translations` 行数而非段数（内容寻址合并重复段，会低估），派生过滤 `translateState` 也建在它上面。
- **建议**：把两个 count 改成 `LEFT JOIN (SELECT asset_id, count(*) ...) GROUP BY asset_id` 或维护 `assets.seg_total/tr_done` 计数列（抽取/翻译落库时 `UPDATE`）；排序键改成持久化的 `sort_no_a/sort_no_b` 两列（加索引即可去掉 TEMP B-TREE）。
- **动态证据**：见「动态验证记录 D2」。

### F5 详情接口每次请求对全部段做 sha256（1200 段 ≈ 18ms）
- **severity** `low` · **effort** `S`
- **文件**：`03-code/server/services/artworks.js:230-251`
- **现象**：`GET /api/works/:no` 每次都对整篇可翻段重算 `buildCacheKey` 判"已译"。实测 15.2µs/段。
- **证据**（原文）：
  ```js
    if (keys.size) {
      const segs = all('SELECT text FROM segments WHERE asset_id = ? AND is_math = 0 AND is_label = 0', [asset.id]);
      for (const s of segs) {
        const key = buildCacheKey({
          engine: lastTrJob.engine,
          model: lastTrJob.model,
          tgtLang: lastTrJob.tgt_lang,
          promptFp: lastTrJob.prompt_fp,
          extractVersion: asset.extract_version,
          text: s.text,
        });
        if (keys.has(key)) trDone += 1;
      }
    }
  ```
  实测：`1.8` 289 段/287 keys → **4.39ms**；`1.11` 268 段/280 keys → 3.56ms；其余 12 篇 keys=0 → 0.11–0.56ms（循环被 `if (keys.size)` 跳过）。
- **影响**：当前 4.4ms 可接受；1200 段/篇的规模下每次打开详情 ≈ **18ms 纯 CPU**，且这是 O(N) 无缓存的重复计算（段文本不变、键不变）。
- **建议**：一条 SQL 搞定：`SELECT count(*) FROM segments s JOIN translations t ON t.segment_id = s.id AND t.engine=? AND t.tgt_lang=? AND t.extract_version=? WHERE s.asset_id=? AND s.is_math=0 AND s.is_label=0`（`segment_id` 已存在）；或在 `segments` 加 `tr_key` 缓存列，翻译落库时写入。
- **动态证据**：见「动态验证记录 D3」。

### F6 翻译进度轮询走 N+1：每次 15.3µs/段，SSE 首帧也吃一次
- **severity** `low` · **effort** `S`
- **文件**：`03-code/server/services/translate/pipeline.js:511-525`（被 `:616` 的 `GET /api/jobs/translate/:id` 与 `:667` 的 SSE 首帧调用）
- **现象**：为了算"已完成段数"，对整篇每段算一次 sha256 + 一次 `cache_key` 点查。
- **证据**（原文）：
  ```js
    for (const r of rows) {
      pageTotals.set(r.page_no, (pageTotals.get(r.page_no) || 0) + 1);
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
  实测：`getTranslateJob(17)` = **4.43ms / 289 段 = 15.3µs/段**；日志里 809 段的任务外推 **≈12.4ms**。
- **影响**：翻译进行中前端每个轮询周期都要付一次；1200 段规模下 ≈18ms/次，与批次循环争同一线程。
- **建议**：`progressFromDb` 改成一条聚合 SQL（`LEFT JOIN translations ON cache_key` 或用 `translate_jobs.done_segments` 的持久化计数），并在运行期只信内存计数（`jobStats` 已有），DB 路径只给"重启后恢复"用。
- **动态证据**：见「动态验证记录 D3」。

### F7 启动 173.7ms 里 117.6ms 是模块图加载，migrate/resync 都不是问题
- **severity** `low` · **effort** `M`
- **文件**：`03-code/server/index.js:7-12`
- **现象**：`import` 阶段就把 routes + services 全图拉起来；真正的启动动作（migrate 4.9ms、resync 7.5ms、bootDownloader 22.5ms）加起来才 35ms。
- **证据**（原文）：
  ```js
  import { migrate } from './migrate.js';
  ...
  import { createApp } from './app.js';
  import { bootDownloader, activeDownloadCount } from './services/downloader.js';
  import { bootTranslateJobs } from './services/translate/pipeline.js';
  import { resyncStorage } from './services/storage.js';
  ```
  实测：`import app.js` 单独 **117.6ms**（占 173.7ms 的 68%）；`process.uptime()` 209ms；日志 `migrate.skip → resync.done` 10ms、`→ server.listen` 9ms。**启动日志没有任何阶段耗时字段**。
- **影响**：173.7ms 的启动对本地工具无所谓；真问题是**没有阶段计时**，一旦 resync 或 migration 在 400 篇规模下变慢（如冷缓存第一次 `existsSync` 400 次），无从诊断。
- **建议**：`server.listen` 日志加 `{ tConfig, tDb, tMigrate, tBootDownloader, tResync, tApp }` 六个毫秒字段（`performance.now()` 差值，10 行代码）；`resyncStorage` 在 `>200 个文件` 时按批 `await setImmediate` 让出。不必为 117.6ms 做懒加载 —— 收益 <0.2s 但风险（路由注册顺序）不小。
- **动态证据**：见「动态验证记录 D1」。

### F8 首屏 2046KB 未压缩是真的，但压缩在本机是净亏（别加 gzip）
- **severity** `low` · **effort** `S`
- **文件**：`03-code/server/app.js:77`、`03-code/server/index.js:40`
- **现象**：10 个静态资源 2,095,495 B 全部无 `Content-Encoding`；但服务只绑 `127.0.0.1`，回环传输 1.29MB 只要 3.9ms，而 gzip 这 10 个文件要 41.8ms CPU、brotli q11 要 2655ms。
- **证据**（原文）：
  ```js
  app.use(express.static(WEB_DIR, { index: 'index.html', extensions: ['html'], maxAge: 0 }));
  ```
  ```js
  const server = app.listen(cfg.server.port, '127.0.0.1', () => {
  ```
  实测：`gzipSync(6)` 41.80ms → 627,293B；`brotli q11` 2,655.01ms → 520,412B；`curl` 拉 `pdf.worker.min.mjs` 1,321,307B 用 **0.0039–0.0042s**；带 `Accept-Encoding: gzip, br` 请求仍 200 且不压缩；`If-None-Match` 返回 **304**。
- **影响**：加 `compression` 后每次冷加载多 42ms 主线程阻塞（**与 F3 抢同一个线程**），换来 ~5ms 的传输节省；对一个只监听回环的个人工具是反向优化。真正的浪费是 10 个资源的 304 往返（~10ms）。
- **建议**：**不要加 compression**；改为 `express.static(..., { maxAge: '365d', immutable: true, setHeaders })` 只对 `vendor/`（内容带版本号的目录）设长缓存，HTML/`assets/*.js` 保持 `maxAge: 0`；顺手补一个 `favicon.ico`（日志里每页都有一条 `request.rejected /favicon.ico E_NOT_FOUND`）。
- **动态证据**：见「动态验证记录 D7」。

### F9 chat 上下文预算按"字符"算，只用到窗口的 4–8%
- **severity** `low` · **effort** `S`
- **文件**：`03-code/server/services/chat/context.js:20-39`、`:121-123`
- **现象**：预算 6 段全是"字符数"（1200/600/3600/1600/2400/400 = 9800 字符），不是 token；而本库原文是 **CJK 0.0%** 的纯英文，9800 字符 ≈ **2450 tokens**。
- **证据**（原文，`context.js:20-32`）：
  ```js
  export function budget() {
    const c = config.chat || {};
    return {
      system: c.systemChars ?? 1200,
      meta: c.metaChars ?? 600,
      retrieve: c.retrieveChars ?? 3600,
      selection: c.selectionChars ?? 1600,
      history: c.historyChars ?? 2400,
      summary: c.summaryChars ?? 400,
    };
  }

  const len = (s) => [...String(s || '')].length;
  ```
  实测：`segments` 977,222 字符中 CJK **0**；`translations.dst_text` 204,434 字符中 CJK **52.2%**；按 0.75 tok/CJK字 + 0.25 tok/ASCII字 → 9800 字符 = **2450（全英文）～7350（全中文）tokens**；对照 `config.js:42 maxTokens: 4000` 与 `deepseek-chat` 窗口，只用到 **4–8%**。
- **影响**：不是超限风险，而是**浪费**：中文问英文文献时，检索到的 `retrieveChars: 3600` 字符英文片段只值 ~900 tokens，模型拿不到足够上下文，答案质量被预算而不是窗口限制。
- **建议**：把预算换成 token 预算并用零依赖估算函数（CJK 字 ×0.75 + 其它字符 ×0.25）；`retrieveChars` 提到 12000–16000 字符（≈3–4K tokens）仍然安全，同时把 `meta.chars.totalInput` 改记估算 token 数，便于观察真实占用。
- **动态证据**：见「动态验证记录 D8」。

## 覆盖与盲区

- **视觉通道未实测**：`playwright` 不在 `node_modules`（`Test-Path` 全 False），`page-image-source.js` 的 6.05MiB/页是**按 `render-geometry.js:88` 公式算出来的**，没有 RSS 实测，也没有 render 耗时实测。
- **token 换算是估算**：没有 `tiktoken`/`js-tiktoken`，用的是「0.75 tok/CJK字 + 0.25 tok/ASCII字」经验式，误差可能 ±20%，`chat/context.js` 的真实 token 占用未验证。
- **未做并发压测**：只有单机单用户；`Promise.all` 只测了 2 篇并发抽取，没测 10 个并发 HTTP + 1 个抽取的排队曲线，也没测 SSE 长连接在 145ms 阻塞下的卡顿表现。
- **400 篇外推建立在两个假设上**：段密度 1200 段/篇（实测只有 425 段/篇）与「碎片系数不随规模改善」；线性性只在 5922→23788 段（4×）验证过，未在 10 万段级别验证。
- **未测 WAL checkpoint 停顿**：`busy_timeout=5000` 与 `wal_autocheckpoint=1000` 已记录，但没有在「一边抽取一边读」的情况下测 checkpoint 抢占，无法给出写放大曲线。
- **未看 `02-design` 的性能目标**：按纪律未通读 194KB 设计文档，只按代码与实测判断；如果设计文档里写了明确的性能指标（如"列表 <50ms"），我的结论口径可能与之不同。

## 动态验证记录

> 所有脚本在 `%TEMP%`（`a14_probe5.mjs`…`a14_probe12.mjs`），临时库在 `%TEMP%\a14work\`。**未修改 03-code 下任何文件**（可用 `git status` 复核）。

**D1 启动各阶段耗时（库副本 + 400 文件目录）**
```
$ node --no-warnings %TEMP%\a14_probe5.mjs
== 启动各阶段（ms）==
import config.js                               1.7
config+logger 就绪                               3.2
openDb()                                       6.2
migrate()                                      4.9
bootDownloader()                               22.5
bootTranslateJobs()  [含 import pipeline 全链]    6.9
resyncStorage()                                7.5
import app.js（路由/服务全图）                         117.6
createApp()                                    3.2
累计到 createApp 完成: 173.7 ms
process.uptime() = 209 ms（含 Node 启动 + 本脚本 import）
```

**D2 `listWorks` 成本拆解 + 受控放大**
```
$ node --no-warnings %TEMP%\a14_probe12.mjs
--- 成本构成（works=424，LIMIT 50，ORDER BY 表达式）---
A 完整（两个相关子查询 + dj 子查询）            p50=4.20ms
B 去掉两个 count 相关子查询                  p50=0.61ms
C 只查 works（无 join）                    p50=0.11ms
D count(*) 包装（listWorks 的 total 查询）    p50=0.46ms
--- 10× 后再看 pageSize 的影响 ---
A 完整 pageSize=10 / 50 / 200             p50=1.51 / 4.17 / 5.49ms
$ node --no-warnings -e "...EXPLAIN QUERY PLAN..."   # 线上库副本
SCAN w
SEARCH a USING COVERING INDEX sqlite_autoindex_assets_1 (work_id=? AND kind=?)
LEFT-JOIN
SEARCH dj USING INTEGER PRIMARY KEY (rowid=?)
CORRELATED SCALAR SUBQUERY 1
SEARCH s USING INDEX idx_segments_asset (asset_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH t USING INDEX idx_tr_asset (asset_id=?)
USE TEMP B-TREE FOR ORDER BY
```

**D3 逐段 sha256 的实测成本**
```
$ node --no-warnings %TEMP%\a14_probe6.mjs
no      segs tr_rows last_job    p50(ms)   keys   done
1.19     766       0        -      0.56      0      ?
4.6      536     482       16      0.46      0      ?
1.8      289    1539       40      4.39    287      ?
1.11     268    1511       39      3.56    280      ?
其余 10 篇 …                           0.11-0.18      0
getStats() p50 ≈ 2.19 ms
$ node --no-warnings %TEMP%\a14_probe5.mjs
getTranslateJob(17)  [progressFromDb 逐段 sha256+点查]   p50=4.43ms
exportMarkdown('1.8')  [逐段 get]                      p50=5.47ms
```

**D4 中文检索降级（线上，只读）**
```
$ curl.exe -s "http://127.0.0.1:7317/api/works/1.8/search?q=%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%A8%A1%E5%BC%8F" -w "\nHTTP %{http_code}  %{size_download}B  %{time_total}s\n"
{"q":"工作流模式","assetId":4,"hits":1,"degraded":null,"rewritten":true,
 "keywords":"workflow patterns","rewriteMocked":false,"reason":"rewritten-hit",
 "results":[{"segmentId":81476,"pageNo":4,"ord":1,...,"hitLang":"src","textDst":null}]}
HTTP 200  812B  0.939773s
$ curl.exe -s ".../search?q=workflow%20pattern" -w ...
{"q":"workflow pattern","hits":2,"rewritten":false,"reason":"hit",...}
HTTP 200  1091B  0.008230s
```

**D5 DB 体积 / 碎片 / 修复收益（库副本）**
```
$ node --no-warnings -e "…dbstat…"
segments_fts_data           5853184 B
translations                1556480 B
segments                    1552384 B
segments_fts_content        1036288 B
translations_fts_data        667648 B
--- 修复后 ---
$ node …/fts-rebuild.js && node -e "new DatabaseSync(copy).exec('VACUUM')"
asset 1: 786 段 … asset 13: 768 段        合计 5232 段，1051ms
segments_fts_data  5,853,184 → 1,036,288
file size 12,488,704 → 6,848,512 B（-45.2%），freelist 179 → 0
$ node -e "…SELECT count(*)…"
translations 3532 | translations_fts 0 | translations_fts_content 0 | segments_fts 5232
```

**D6 并发抽取 / 事件循环阻塞（真实 PDF，库副本）**
```
$ node --no-warnings %TEMP%\a14_probe10.mjs
用两篇: 14=…4.5__cognitive-architectures…pdf | 13=…1.19__intelligent-agents…pdf
顺序：566ms + 416ms = 982ms；心跳 {"n":107,"p50":5.76,"p95":11.60,"max":150.38}
并发 Promise.all：641ms；心跳 {"n":87,"p50":5.26,"p95":8.67,"max":110.45}
结论：并行耗时 / 顺序耗时 = 0.65（≈1 表示完全排队，≈0.5 表示真并行）
空闲时一次「等一拍 + count(*)」延迟 {"p50":"0.10","p95":"0.20","max":"0.22"}；抽取进行中 {"p50":"0.10","p95":"0.47","max":"3.26"}
```

**D7 首屏静态资源 + 压缩成本（线上 curl + node zlib）**
```
$ curl.exe -s -o NUL -w "pdf.worker.min.mjs  time_total=%{time_total}s  size=%{size_download}B\n" http://127.0.0.1:7317/assets/vendor/pdfjs/pdf.worker.min.mjs
… 0.004200s / 0.003966s / 0.003905s，size=1321307B
$ curl.exe -s -D - http://127.0.0.1:7317/assets/vendor/md/highlight.min.js
HTTP/1.1 200 OK
Cache-Control: public, max-age=0
ETag: W/"1db7f-1a19bb62ba4"
Content-Length: 121727
（无 Content-Encoding、无 Vary；带 Accept-Encoding: gzip, br 仍不压缩）
$ node --no-warnings %TEMP%\a14_probe11.mjs
10 个文件原始合计 2095495 B = 2046.4 KB
gzipSync(level 6) 全部       p50=41.80ms  → 627293 B
gzipSync(level 9) 全部       p50=56.18ms  → 625783 B
brotliSync(quality 5) 全部   p50=51.38ms  → 585607 B
brotliSync(quality 11) 全部  p50=2655.01ms → 520412 B
```

**D8 语料构成与预算换算**
```
$ node --no-warnings %TEMP%\a14_probe8.mjs
原文 segments: {"cjk":0,"other":833309,"spaces":143913,"total":977222}  CJK 占比= 0.0%
译文 dst_text: {"cjk":106673,"other":85011,"spaces":12750,"total":204434}  CJK 占比= 52.2%
按 0.75 tok/CJK字符 + 0.25 tok/ASCII字符 估：原文 244306 tokens; 译文 104445 tokens
chat 字符预算上限 = 9800 字符 + question ≤ 4000 字符 = 13800 字符
若上下文中英各半 ≈ 4900 tokens；全中文上限 ≈ 7350；全英文下限 ≈ 2450
现有会话体积 Top3: [{"chat_id":11,"chars":1523},{"chat_id":10,"chars":977},{"chat_id":12,"chars":821}]
```

**D9 线上接口基线（`curl -w`，各 3 次，未重启服务）**
```
/api/works?pageSize=50        0.009102 / 0.008149 / 0.008908 s   43859 B
/api/works/4.6                0.024927 / 0.002020 / 0.002060 s    1647 B
/api/works/4.6/segments       0.005751 / 0.005811 / 0.005442 s  215729 B
/api/health                   0.002392 / 0.002135 / 0.002486 s     338 B
```
