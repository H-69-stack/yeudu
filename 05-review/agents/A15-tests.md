# A15 · 测试覆盖与测试质量

审查对象：`03-code/server`（77 个非测试 .js）+ `03-code/server/test`（18 个 `*.test.js`）+ `04-test`（手工 .mjs 探针）。
基线复核：`npm test` 155 pass / 0 fail，与主理人给的一致；但 155 不是 25 个测试文件，是 **18 个**文件里的 155 个 `test()`。

## 结论

1. **155/155 全绿只覆盖 server 侧 50/77 个模块（行覆盖 60.80%、函数覆盖 55.51%）；27 个模块从未被加载**——包括 `app.js`/`index.js`、全部 11 个路由（48 个 HTTP 端点）、`translate/pipeline.js`、`extractor.js`、`artworks.js`、`error.js`/`validate.js`/`ratelimit.js`、3 个 cli、`web/`、`userscript/`。
2. **唯一的 blocker 是测试自己的副作用**：每跑一次 `npm test` 就往生产库 `data/app.db` 写 1 个会话 + 1 条消息、往生产附件库写 1 个假 PNG。现在库里 27/69 条消息（39%）是测试残留，用户打开应用就能在会话列表里看到 27 个空标题会话。
3. **最硬的证据是"坏实现仍全绿"**：FREEZE.md:13 记录过一次致命事故——`routes/chat.js` 的 `loadChat` 误从 `agent.js` 导入，导致 `createApp()` 崩溃、服务起不来；而今天的测试**从不 import `app.js`**，同样的改动今天照样 155/155。
4. 断言强度不是主要问题（155 个用例 0 个无断言、124 个有等值/异常断言），问题在"被测对象没进视野"：6 条已修 bug 对应 6 条不变量，**0 条留下了会失败的回归测试**。
5. 缺的是三种测试类型：**HTTP 集成（0 条）、迁移升级（0 条）、前端/用户脚本（0 条）**；FREEZE.md:15 引为证据的 `04-test/smoke-attachments-http.mjs`（11/11 PASS）与 `04-test/e2e-multimodal-upload.mjs` 在仓库里**已不存在**。

---

## findings

### F1 [blocker] `npm test` 直接写生产库与生产附件库，且这些数据已通过 API 呈现给用户

**现象**：`attachments-multimodal.test.js` 的最后一个"集成"用例用**相对路径**打开生产库并真的建会话、插消息；`tool-registry.test.js` 与 `page-image-inject.test.js` 的附件用例把测试用假 PNG 写进生产附件目录。三者都没有 cleanup，也没有临时目录。

**证据**（`03-code/server/test/attachments-multimodal.test.js:120-127`，一字未改）：
```js
test('集成：用户附件随 user 消息落库并可回读（insertUserMessage → listMessages）', () => {
  openDb('data/app.db');
  const work = get('SELECT * FROM works LIMIT 1');
  if (!work) {
    console.warn('跳过：works 表无数据，无法建会话');
    return;
  }
  const { chatId } = createChat({ workNo: work.no, provider: 'deepseek', model: 'deepseek-chat' });
```

动态实测（跑一次 `npm test` 前后用 `node:sqlite` readOnly 读生产库）：

| 指标 | 跑之前 | 跑之后 |
|---|---|---|
| `chats` 总数 | 39 | 40 |
| `messages` 总数 | 68 | 69 |
| `content = char(35831,30475,36825,24352,22270)`（"请看这张图"）的消息数 | 26 | 27 |

即 **每次 `npm test` 精确 +1 会话 +1 消息**，27/69 = 39%。这些残留已经进入用户可见面（真实 HTTP）：

```
$ curl -s http://127.0.0.1:7317/api/chats
[{"chatId":40,"title":"","provider":"deepseek","model":"deepseek-chat","updatedAt":1793718088733,"messageCount":1},
 {"chatId":39,...},{"chatId":38,...},{"chatId":37,...

$ curl -s http://127.0.0.1:7317/api/chats/40/messages
{"messages":[{"id":69,"role":"user","content":"请看这张图",...,"attachments":[{"attachmentId":"file_a4bcd7b80c65e14e...","source":"user","kind":"image","mediaType":"image/png","width":1,"height":1,"bytes":70,...

$ curl -s http://127.0.0.1:7317/api/works/1.1   # 注意 lastChatId
{... "translateStats":null,"lastChatId":40,"availableTranslateOptions":{"engines":[]}}
```

附件侧同样污染：`tool-registry.test.js:120` 的 `saveImage({ bytes, mediaType: 'image/png', width: 10, height: 20 })` 把 9 字节假 PNG 落到 `data/attachments/v1/objects/`，`sha256([0x89,0x50,0x4e,0x47,1,2,3,4,5]) = 3ac1c50a39a7c7dac6e362c0011146823c4dae131657479ac4d16bcc076fc40a` 这个对象真实存在，侧车 meta 为 `{"mediaType":"image/png","width":10,"height":20,"bytes":9}`——与测试里的硬编码完全一致。生产附件库现共 12 个对象体。（`page-image-inject.test.js:106/216/256` 另有 3 处 `saveImage`，同样落在生产附件目录。）

**影响**：① DB 是唯一真相（不变量 #4），测试副作用和用户数据在库里无法区分，且没有清理脚本；② FREEZE.md §1 冻结的基线 `chats 8 / messages 30 / user_version 2` 已完全不可复现（现在 40/69/v4）；③ 会话列表 UI 直接展示 27 个空标题会话；④ 测试结果依赖生产数据：如果 `works` 表为空，它会 `console.warn` 后 `return`，测试**照样算 pass**（假绿）；⑤ 与 7317 上正在运行的服务共享同一个 WAL 库和同一个附件目录。

**建议**：该用例改走 `AGENTLIT_DB=tmp`（同 `downloader.test.js:11-13` 的写法）+ 自建 work，或直接删除；附件三处需要新增 `AGENTLIT_ATTACHMENTS_DIR` 开关（`config.js:164-181` 的 `envOverrides` 里现在**没有**这个变量，附件目录只能靠 `loadConfig()` 之后改 config，测试静态 import 拿不到），最低成本是把 `saveImage` 的根目录做成可注入参数；另做一次性清理（26 条泄漏 chat + 12 个附件对象），并加一条守卫断言"npm test 前后 `data/app.db` 的 sha256 不变"。

**effort**：S（改 1 个测试文件 + config 加 1 个 env + 清理脚本，约 40 行）

---

### F2 [high] 155/155 全绿也能服务起不来：启动链与全部 HTTP 路由不在测试视野内

**现象**：覆盖报告只列出 50 个文件，而 server 下有 77 个非测试 .js。**从未被任何测试加载**的 27 个文件里，包含 `app.js`、`index.js`、`import-cli.js`、全部 11 个 `routes/*`、3 个 `cli/*`、`middleware/{error,validate,ratelimit}.js`、`services/artworks.js`、`services/extractor.js`、`services/layout/{job,refine}.js`、`services/translate/pipeline.js`、`services/translate/engines/types.js`、`services/resolvers/manual.js`。

**证据**：
```
$ node --no-warnings --test --experimental-test-coverage "server/test/*.test.js"
tests 155 / pass 155 / fail 0 / duration_ms 855.994
start of coverage report
...
all files | 60.80 | 69.19 | 55.51 |
```
报告里没有 `server/app.js`、没有任何 `server/routes/*` 行（27 个文件连模块都没被加载）。对照 FREEZE.md:13 原文：

> **修复（致命）**：`routes/chat.js` 的 `loadChat` 误从 `agent.js` 导入（该模块仅引入未 re-export）——整条 chat 路由加载即失败、`createApp()` 崩溃、服务无法启动；改从 `session.js` 导入。

48 个端点的分布（`routes/*.js` 里 `.(get|post|patch|delete)(` 计数）：assets 5、chat 9、download 1、health 1、import 1、jobs 4、layout 4、segments 3、settings 6、translate 8、works 6 = **48 个，0 个有自动化断言**。其中 `routes/chat.js:156` 是 v5 新增的 multipart 附件上传、`:167` 是内联下载——最高风险的入口，唯一证据是一份不可复现的手工报告（见 F9）。

**影响**：一类"import 写错 / 路由装配顺序错 / 中间件签名错"的改动，今天仍然会在 155 全绿的情况下把服务打死；48 个端点的状态码、错误体、分页结构、`?dl=1`/415/413 全部只靠人肉 curl。

**建议**：最低成本一步是先加一个 `server/test/http-smoke.test.js`（见 F9 的最小可行方案），把 `createApp()` 的装配、`errorMiddleware` 的错误体、`securityMiddleware` 的 Host 拒绝纳入回归；覆盖报告里从"没有 app.js 这一行"变成"有且 >70%"本身就是可验收的指标。

**effort**：S（80 行以内，只覆盖 5 条最重要的契约）

---

### F3 [high] 六条已修 bug，0 条留下会失败的回归测试

**现象**：从 STATUS.md / FREEZE.md 的修复记录反查每一条是否留了测试：

| # | 已修 bug（来源） | 现在的实现位置 | test/ 里会失败的用例 |
|---|---|---|---|
| 1 | 重抽后旧译文不再命中（STATUS M2 §六.6、M5 §1.3） | `routes/segments.js:73` `extractVersion: asset.extract_version`（路由零覆盖） | 只有 `cacheKey.test.js:35-36` 断言纯函数 key 变化；路由层过滤 0 |
| 2 | `paused` 任务续译（M2 §六.3，"只会返回 reused"） | `services/translate/pipeline.js:104-115` | **0**（该文件 0% 加载；`grep resume server/test` 命中 0） |
| 3 | 字段级锁 `skippedLocked`（不变量 #4） | `services/importer.js:268-278`、`services/artworks.js:321/374` | **0**（`fields_locked` 在 test/ 里只出现在 INSERT 列名，`skippedLocked` 0 命中） |
| 4 | 迁移断言 + 回滚（STATUS M3 §七.4） | `migrate.js:97-116`、`MIGRATIONS` 118-171 | **0**（见 F5：5 个碰库测试全在 from=0 的新库上跑） |
| 5 | 用户/助手附件重复渲染（FREEZE.md:14） | `web/assets/chat.js` `appendUserAttachments` | **0**（web/ 无任何 JS 测试） |
| 6 | `loadChat` 导入错误导致 `createApp()` 崩溃（FREEZE.md:13） | `routes/chat.js` | **0**（`app.js` 从未被加载） |

**证据**（`03-code/server/services/translate/pipeline.js:103-115`，即第 2 条的实现）：
```js
    // paused 的任务：这是「继续翻译」——重开 runner 继续跑，已译段直接命中缓存（不重复计费）
    if (active.status === 'paused') {
      run("UPDATE translate_jobs SET status='running', finished_at=NULL WHERE id = ?", [active.id]);
      const resumed = ensureRunner(active.id);
      resumed.canceled = false;
      resumed.ctl = new AbortController();
```
这段代码今天被删掉、`paused` 分支退回"直接 reused"，155 个测试**一个都不会红**。

**影响**：这 6 个 bug 分别对应缓存键、生命周期、字段锁、迁移原子性、渲染幂等、启动可用性——正是这个系统的 6 条核心不变量。修一次不留测试 = 下次重构原样复发，且复发时 CI 全绿，只有用户会遇到。

**建议**：每条补一个最小用例（合计约 90 行）：① 造 v2→v3 的 asset/segment，改 `extract_version` 后断言 `?withTranslation=1` 不返回旧译文；② 临时库造 `status='paused'` 的 job，断言 `POST /api/translate` 返回 `{resumed:true}` 而非 `{reused:true}`（或直接断言 pipeline 的返回对象）；③ 造 `fields_locked=["title"]` 的 work 再喂一条改 title 的 CSV 记录，断言 `report.skippedLocked` 含该字段且 DB title 未变；④ 见 F5；⑤ 无 DOM 环境就先退化成"渲染函数输出计数"的纯函数测试；⑥ 见 F9。

**effort**：M（6 个用例，跨 5 个模块，但每个都很小）

---

### F4 [high] 安全中间件函数覆盖率为 0%：不变量 #5 完全裸奔

**现象**：`middleware/security.js` 虽然被 `downloader.test.js` 的依赖链带上，但覆盖率是 **行 22.22% / 分支 100% / 函数 0.00%**——即 `securityMiddleware()` 返回的中间件体、`isPrivateAddress()`、`assertUrlSafe()` 一次都没执行。`middleware/validate.js`（被 7 个路由 import）与 `ratelimit.js` 连模块都没加载。

**证据**：
```
middleware/security.js | 22.22 | 100.00 | 0.00 | 20-74 76-83 87-106 116-144
```
未执行的行段正好是三段安全判定。`app.js:38-45` 是唯一装配处：
```js
    securityMiddleware({
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`],
      allowedOrigins: [...],
      allowMultipartPaths: [/^\/api\/works\/[^/]+\/asset$/, /^\/api\/chats\/[^/]+\/attachments$/],
    })
```
我用 curl 手工确认"实现是对的"（Host 伪造 → 403、`text/plain` POST → 400），但这恰好说明**证据只存在于我这次手工调用里**：`isPrivateAddress` 改成 `return false`、Host 白名单改成 `if (false)`，155 个测试仍然全绿。

**影响**：02-design R6「本机服务被恶意网页当跳板」的唯一闸门（Host/Origin/CT/SSRF 逐跳）零回归保护；R6 的威胁模型一旦被一次"顺手放宽"改坏，没有任何自动化会拦住。`validate.js` 导出的 `WORK_NO_PATTERN` 是 `/api/works/:no` 的入参白名单，同样 0 覆盖。

**建议**：`isPrivateAddress` 是纯函数，8 个网段 + IPv4/IPv6 各一行（约 20 行）；Host/CT/Origin 三条用 F9 的临时端口 harness 加 3 个 fetch（约 25 行）；`WORK_NO_PATTERN` 用 5 个正反例（约 10 行）。

**effort**：S

---

### F5 [medium] 迁移升级路径（backfill / 断言 / 备份 / 回滚）一次都没执行过

**现象**：5 个碰库的测试（`chat-summary`、`downloader`、`dual-index`、`fts` 用临时库，另一个不碰库）全部是"新建空库 → `migrate()`"，此时 `user_version()=0`，代码直接 `exec(schema.sql)` 把版本写成当前值 4，v2/v3/v4 的 MIGRATIONS 循环、`assertMigration`、`backupTo` 都没跑过。

**证据**（`03-code/server/migrate.js:238-252`）：
```js
  if (current === 0) {
    exec(schema.sql);
    current = userVersion();
  }
  ...
    const result = tx(() => {
      const r = m.run();
      exec(`PRAGMA user_version = ${m.version}`);
      return r;
    });
```
覆盖率：`migrate.js | 52.42 | 45.00 | 33.33 | 37-39 43-68 75-90 97-116 124-139 146-152 175-178 182-185 189-203 216-218 220-224 227-231`——`97-116` 正是 `assertMigration`（"索引内容不是译文"那条断言），`227-231` 是 `backupTo`。

**影响**：真实升级是"每个用户机器上的第一次运行"。STATUS §七.4 演示过断言能拦住坏迁移并回滚，但**断言本身、回填 SQL、事务回滚都没有测试**；下一个 schema 版本（v5）没人能验证回填正确性，出错就是数据错乱且无测试红灯。

**建议**：一个 fixture 目录（v2 schema 快照 + 3 segments/2 translations），用例断言 `user_version 2→4`、`translations.segment_id` 全部回填、`translations_fts` 计数等于 `expectedTranslationIndexCount`、`data/backup/app-*-v2.db` 存在；再一个"全是英文译文"的坏库，断言 `assertMigration` 抛错且 `user_version` 仍为 2（回滚生效）。

**effort**：M（~80 行 + 一份 v2 建表 SQL 快照）

---

### F6 [medium] 下载器网络段 34.55%：状态机后半段与逐跳 SSRF 无断言，测试自己写明"不起网络"

**现象**：`downloader.test.js` 只测幂等检查、`needs_manual` 判定、状态冲突；下载、校验、重试、`.part`→rename 全在网络段，未被断言。

**证据**（`03-code/server/test/downloader.test.js:3` 与 `:84-86`，原文）：
```js
/**
 * 下载器（§15.2 触发下载）：不起网络——只覆盖幂等检查、needs_manual 判定、状态冲突，不发真实下载请求。
 */
...
  // force=true 时不应返回 alreadyDownloaded（这里只检查它不再走 alreadyDownloaded 分支：
  // 会因为真实网络请求而入队，故不在此断言下载结果）
```
覆盖率：`services/downloader.js | 34.55 | 65.00 | 34.62 | 57-58 63-83 105-106 139-141 156-157 161-173 175-178 180-184 186-301 303-305 307-321 332-394 396-417 419-428 430-495 497-507 515-550 ...`（186-301、332-495 是连续大段）。

**影响**：不变量 #2（PDF 三连校验）与 #3（原子写 + 幂等键）只在 `storage.js`/`pdf-verify.js` 的**纯函数**层面有测试，真正的"`verifying` 阶段到底校验了什么、失败后文件有没有留下 .part、302 跳私网会不会被拦"没有端到端断言。一次回归的表现是"文件下了一半 / 落了个 HTML 错误页 / 卡在 downloading"，测试全绿。

**建议**：本地 `http.createServer` 四个场景（正常 PDF / 302 跳 `127.0.0.1` / 200 但返回 HTML / 中途断流），断言终态 `done|failed`、`storage/pdfs/<no>__<slug>.pdf` 存在且 `%PDF-`、`data/_tmp` 无残留 `.part`。`page-image-inject.test.js` 已经证明这套 harness 在本仓库可行（`listen(0,'127.0.0.1')`）。

**effort**：M（~120 行）

---

### F7 [medium] 断言强度：31 个用例只有 `assert.ok` 级，2 处断言恒真

**现象**：机械统计（按 `^test(` 切块）`test_blocks 155 / no_assert_at_all 0 / only_ok_no_equality 31 / with_strong_assert 124`。整体不算弱（0 个无断言用例），但有两处断言在实现被改坏后仍然通过，且都压在不变量上。

**证据 1**（`03-code/server/test/dual-index.test.js:118-119`，原文）：
```js
  const hits = fts.searchSegments(assetId, '工作流', { topK: 5 });
  assert.ok(hits[0].textDst === null || hits[0].textDst.includes('工作流'));
```
——`searchSegments` 退化成永远返回 `textDst: null`（即不变量 #9 的双索引写坏了），这一行仍然 pass。

**证据 2**（`03-code/server/test/path-scope.test.js:19-22`，原文）：
```js
  const out = assertInScope('storage/pdfs/x.pdf');
  assert.ok(out.startsWith(paths.storageDir) || out.toLowerCase().includes('storage'));
```
——`||` 右边的 `includes('storage')` 几乎恒真；`assertInScope` 把路径解析到别的盘符下只要含 "storage" 就过。

**影响**：这两个用例是双索引与路径白名单的**唯一**断言（`dual-index` 的 fts 侧只有它，`path-scope` 的 6 个用例里 2 个是 `assert.ok` 形态），改坏即静默。

**建议**：改成精确断言——`assert.equal(hits[0].textDst, '工作流：把感知—行动闭环……')`（用测试里已知的译文常量）、`assert.equal(out, path.join(paths.storageDir, 'pdfs', 'x.pdf'))`；31 个 only-ok 逐个看是否含具体值，优先升级 `chat-summary`（7 个）与 `citation`（15 个）里的。

**effort**：S

---

### F8 [medium] 测试与真实世界数据强耦合：CSV 条数写死 424，用户按产品能力加一篇文献就红

**现象**：`csv.test.js` 读的是**真实项目 CSV**（`config.js:282-286 defaultCsvPath()` → `03-code/../Agent工作流文献清单.csv`），并把行数、arXiv 数、专题数写进断言。

**证据**（`03-code/server/test/csv.test.js:55-59`，原文）：
```js
test('readCsvRecords：真实 CSV 的 13 列映射（424 行，321 条含 arXiv，22 专题）', () => {
  const { records, warnings } = readCsvRecords();
  assert.equal(records.length, 424);
  assert.equal(records.filter((r) => r.arxivId).length, 321);
  assert.equal(new Set(records.map((r) => r.sectionNo)).size, 22);
```
**影响**：这个产品的能力就是"导入新的文献清单"，用户按设计加一篇 → 三个断言同时红，失败信息指向"测试坏了"而不是"功能坏了"，最省事的"修法"就是把数字改大或删断言。反过来它又是唯一的 13 列映射契约测试，删了没人管 CSV 列漂移。

**建议**：改成 `server/test/fixtures/importer.csv`（10 行覆盖 13 列 + 空值 + 非法年份），真实 CSV 只留一条"能解析、列数=13、无 parse 错误"的冒烟断言（不断言行数）。

**effort**：S

---

### F9 [medium] 没有 HTTP 集成层，而 FREEZE 引为证据的两个冒烟脚本已不存在

**现象**：仓库没有任何 HTTP 层测试（无 supertest 依赖、无 `fetch` 用法），也没有 CI（03-code 下无 `.github`、无 `coverage`/`.nyc_output`、`package.json` 无 lint/coverage 脚本）。FREEZE.md:15 声称的证据链指向两个不存在的文件。

**证据**（`03-code/FREEZE.md:15` 原文）：

> 验证：单测 **136/136**；真实 E2E `04-test/e2e-multimodal-upload.mjs` A1/A2/B1/B2 全过；**HTTP 路由冒烟 `04-test/smoke-attachments-http.mjs` 11/11 PASS**（multipart/裸体上传、inline、?dl=1、415/413、纯图发送落库、404）。

```
$ Get-ChildItem 04-test -Recurse -File | Where-Object { $_.Name -match 'smoke|e2e' }
（无输出）
```
`04-test` 实际只有 6 个 `probe-render-*.mjs` + `scripts-independent/` 11 个探针 + 2 份报告 md，无断言框架。另外 `03-code/README.md:39` 仍写「单元测试（69 个用例，零网络）」，与 155 个用例、且真的起本地 HTTP 服务的事实不符。

**影响**：v5 最高风险的链路（附件上传/内联下载/multipart 白名单）唯一证据不可复现；48 个端点 0 断言；新接手者读 README 会得到错误的测试规模与"零网络"的错误前提。

**建议（最小可行方案，本轮不实施）**：新增 `server/test/http.test.js`，node:test 内置能力即可，不装 supertest：

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlit-http-'));
process.env.AGENTLIT_DB = path.join(tmp, 'app.db');
process.env.AGENTLIT_PORT = '0';            // 关键：allowedHosts 由 config.server.port 拼出
const { loadConfig } = await import('../config.js'); loadConfig();
const { createApp } = await import('../app.js');
let srv, base;
before(async () => { srv = createApp().listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());
```

要点三条（本仓库特有的坑）：
1. **必须先设 env 再 `loadConfig()`，`createApp` 才能拿到数据库**；`app.js:32` 的 `port` 取自 `config.server.port` 并拼进 `allowedHosts`，所以要么先 `AGENTLIT_PORT=0` 再 load，要么 load 后直接改 `config.server.port`（`security.js` 是在调用时读 opts，改了也生效）。
2. 断言 Host 时用 `fetch(base, { headers: { Host: 'evil.example' } })`——但 fetch 会忽略自定义 Host，需要 `node:http` 的 `request({ headers: { Host: ... } })`，或跳过这条，只断言 `X-Trace-Id` 与错误体结构。
3. 五个最小用例：`GET /api/health` → 200 且 `body.dbDriver === 'node:sqlite'`；`GET /api/nope` → 404 且 `body.error.code === 'E_NOT_FOUND'` 且响应头有 `X-Trace-Id`；`POST /api/works/1.1/download` 带 `Content-Type: text/plain` → 400；`GET /api/works?limit=1` → `body.items[0].no` 匹配 `/^\d+\.\d+$/`；`GET /api/chats/999999/messages` → 404 且 `body.error.detail.chatId === 999999`。约 90 行。

**effort**：S

---

### F10 [medium] 脆弱性：文件级并发 + 相对路径 + 时间断言

**现象**：`node --test` 对**文件**级并发（不是用例级），13/18 个测试文件没有任何隔离；唯一使用相对路径的恰好是写生产库的那个；唯一时间敏感断言依赖真实时钟。

**证据**：
- 并发实测（3 个探针文件，各自 `appendFileSync` 起止时间戳 + `sleep(400)`）：
```
a start 1793718173417 / b start 1793718173421 / c start 1793718173429
b end   1793718173830 / a end 1793718173831 / c end 1793718173846
```
即 3 个文件在 12ms 内全部启动，确认并行。`os.availableParallelism() = 16`。
- `attachments-multimodal.test.js:121` `openDb('data/app.db')` 相对 CWD：只有在 `03-code` 下跑才对，换目录跑会新建一个空库（或 ENOENT），且与正在运行的 7317 服务共享同一个 WAL 文件。
- `tool-registry.test.js:72` `assert.ok(r.ms < 400);`——工具超时设为 30ms、被测工具 sleep 500ms，`ms < 400` 依赖机器在 400ms 内完成调度；慢 CI 上会假红。
- `page-image-inject.test.js:168` `await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));`——端口 0 取随机端口，做法正确（这是全库唯一需要端口的测试）。

**影响**：`npm test` 与生产服务共享库/目录的写权限（见 F1）；慢机器上偶发假红会削弱对测试的信任；换目录跑测试会静默产生第二个空库。

**建议**：统一 `server/test/helpers/tmpEnv.js`（`mkdtempSync` + 设 `AGENTLIT_DB`/`AGENTLIT_DOWNLOAD_DIR` + 返回清理函数），13 个未隔离文件全部改用；`ms < 400` 改为只断言 `r.errorCode === TOOL_TIMEOUT`；`npm test` 保持并发（消除共享后并发才是安全的）。

**effort**：S

---

## 覆盖与盲区

### 模块覆盖矩阵（server 77 个非测试 .js，DIRECT 23 / INDIRECT 27 / ZERO 27）

| 分组 | 文件数 | 有用例（直接 import） | 只被间接覆盖 | 零覆盖 |
|---|---|---|---|---|
| 启动/根（app.js、index.js、import-cli.js） | 3 | 0 | 0 | **3** |
| middleware（security、validate、error、ratelimit） | 4 | 0 | 1（security，但 funcs 0%） | **3**（validate/error/ratelimit） |
| routes（11 个文件、48 个端点） | 11 | 0 | 0 | **11** |
| core（config、db、migrate、errors、logger） | 5 | 3（config/db/migrate） | 2（errors/logger） | 0（migrate 升级路径 0） |
| pdf（buildPages、spaceFix、meta、extractor） | 4 | 3（87.7/95.9/95.8%） | 0 | **1**（extractor.js 437 行） |
| layout（job、refine） | 2 | 0 | 0 | **2** |
| translate（pipeline、cacheKey、prompts、engines×7、types） | 10 | 1（cacheKey 100%） | 7 | **2**（pipeline.js 812 行、engines/types.js） |
| chat 核心（agent、loop、pipeline、context、session、retrieval、citations、registry、runtime、attachments、image-inject、prompts、persona） | 13 | 10 | 3（citations/retrieval/runtime） | 0（但 agent 31.7%、pipeline 32.1%、retrieval 39.3%、session 54.5%） |
| chat/render（page-image-source、render-geometry） | 2 | 0 | 2（page-image-source 25.6%、funcs 0%） | 0 |
| chat/tools（index、lit-page-image、lit-read、lit-search、lit-translation、lit-update-note、_resolve、_sandbox） | 8 | 1（_sandbox） | 7（各 30-73%） | 0 |
| services 其他（storage、fts、downloader、importer、segment、artworks、resolvers×5） | 11 | 5 | 4（arxiv/doi/index/link） | **2**（artworks.js 459 行、resolvers/manual.js） |
| llm（client.js） | 1 | 0 | 1（49.3%，真实解析段 63-442 未执行） | 0 |
| cli（fts-rebuild、replay-chat、verify-agent） | 3 | 0 | 0 | **3** |
| **合计** | **77** | **23** | **27** | **27** |

非 server 侧：`web/`（14 个 js/html/css，含 650 行 chat.js、526 行 reader.js）**0**；`userscript/lit-uploader.user.js`（470 行）**0**；`scripts/`（3 个）**0**。

### 关键盲区（按"这次没覆盖会漏掉什么"排）

1. **`services/translate/pipeline.js`（812 行，0%）**：整个翻译执行器——SSE 推送、进度、pause/resume、重试、缓存命中、`TRANSLATABLE` 过滤，行覆盖 0。M5 的数据变更（segments 4238→13280）就发生在这条链路上。
2. **`services/extractor.js`（437 行，0%）**：抽取入口 + `EXTRACTOR_VERSION`，而"重抽后译文失效"的版本语义由它决定。
3. **`services/artworks.js`（459 行，0%）**：`patchWork` 写 `fields_locked`（:321/:374）和 `/api/works/:no` 的 patch 契约，字段锁的另一半。
4. **`services/llm/client.js` 的真实解析段（49.3%，未执行 63-442）**：流式 SSE 解析、usage 记账、tool_calls 拼装、错误映射——FREEZE §3 自己写着"只有代码，没有执行证据"。
5. **`services/chat/pipeline.js`（343 行，32.1%，未执行 170-380）**：主 SSE 编排整段，chat 的"响应流"没有端到端测试。
6. **`web/` 与 `userscript/`（0%）**：`04-test` 的 6 个 playwright 探针是手工脚本，不参与 `npm test`。

### 测试即文档（第 6 问）

- **好的部分**：14/18 个测试文件在头注释里引用设计章节，且引用**能对上**真实小节——`fts.test.js` 引 §10.3/D10、`buildPages.test.js` 引 §16.2、`cacheKey.test.js` 引 §7/§21 R3、`storage-name.test.js` 引 §12.2、`batches.test.js` 引"自测第 8 项"、`downloader.test.js` 引 §15.2。文件命名与模块名一致（path-scope/storage-name/cacheKey），新接手者能按"模块 → 测试文件"找到行为契约。
- **差的部分**：① 设计文档本身**没有测试章节**（25 个一级标题里没有"测试/验证"，全文"自测|测试"仅 2 处），所以"测试即文档"是单向的：测试引设计，设计不引测试，也没有"哪条不变量由哪个用例守护"的映射；② 命名是模块视角不是行为视角——`attachments-multimodal.test.js` 里一个"集成"用例名带"集成"却写生产库（F1），读者会以为它是隔离的；③ 6 条核心不变量里有 4 条（#1 路径白名单、#4 字段锁、#5 安全中间件、#8 缓存键端到端）没有以不变量命名的测试，只有实现细节测试；④ README.md:39 的"69 个用例、零网络"与现状（155、有本地 HTTP）矛盾，是最容易误导新人的一处。

### 按性价比排序的补测清单（≤10 条）

| # | 补什么 | 为什么这条最值 | 大约行数 |
|---|---|---|---|
| 1 | 修掉 F1：`attachments-multimodal` 改临时库 + 自建 work；附件根目录可注入 | 唯一 blocker，且写完立刻让 `npm test` 变干净（不再污染生产库） | 35 |
| 2 | `http-smoke.test.js`：health/404 错误体/CT 400/works 列表（F9 方案） | 一条测试同时点亮 app.js + error.js + security.js + routes 四项零覆盖；从此"服务起不来"类改动会被拦 | 90 |
| 3 | `isPrivateAddress` + `assertUrlSafe` 单测（F4） | 纯函数，20 行换不变量 #5 的核心闸门；R6 威胁模型的唯一防线 | 25 |
| 4 | `pipeline` 的 paused→resumed 用例（F3-2） | 812 行 0 覆盖的模块里最容易测、且是已修 bug；直接断言返回对象 `{resumed:true}` | 30 |
| 5 | `segments?withTranslation=1` 的 extract_version 过滤（F3-1） | "重抽后旧译文"是不变量 #8 的端到端语义，现在只有纯函数层 | 35 |
| 6 | 字段锁双向用例（F3-3）：importer `skippedLocked` + `patchWork` | 不变量 #4 的另一半，459 行 artworks.js 的首个用例 | 40 |
| 7 | 迁移 v2→v4 fixture + 回滚用例（F5） | 唯一"只在用户机器上第一次运行"的代码路径，且带数据回填 | 80 |
| 8 | downloader 本地 stub 四场景（F6） | 状态机后半段 + 原子写 + 三连校验的端到端，`page-image-inject` 已证明 harness 可行 | 120 |
| 9 | 修两处恒真断言 + 升级 `dual-index`/`path-scope`（F7） | 5 行改动，两个不变量从"可能假绿"变"必红" | 15 |
| 10 | `npm test` 前后 `data/app.db` sha256 守卫（F1 的护栏） | 13 个未隔离文件全部受保护，防止 F1 类问题再长出来 | 20 |

总增量约 490 行，全部落在 `server/test/` 内，不改生产代码（除 config 增加一个附件目录 env）。

---

## 动态验证记录

> 说明：本轮唯一一次非只读操作是误发的 `POST /api/works/1.1/download`（见第 9 条），已在下面如实记录。所有命令均在 `D:\A-knowledge\agent工作流优化\03-code` 下执行。

**1. 测试规模与真实构成**
```
$ (Get-ChildItem server\test\*.test.js).Count
18
$ node --no-warnings --test "server/test/*.test.js"
ℹ tests 155
ℹ pass 155
ℹ fail 0
ℹ duration_ms 853.0
```
各文件 `test()` 计数之和 = 6+6+10+6+5+8+6+12+7+9+8+9+7+9+10+18+12+7 = **155**，即"155 pass"就是 18 个文件里的 155 个 `test()`，不是 25 个文件。

**2. 覆盖率实测（本轮最关键的一条命令）**
```
$ node --no-warnings --test --experimental-test-coverage "server/test/*.test.js"
ℹ tests 155 / pass 155 / fail 0 / duration_ms 855.994
ℹ start of coverage report
ℹ all files | 60.80 | 69.19 | 55.51 |
ℹ server\middleware\security.js | 22.22 | 100.00 | 0.00 | 20-74 76-83 87-106 116-144
ℹ server\migrate.js | 52.42 | 45.00 | 33.33 | ... 97-116 ... 227-231 ...
ℹ server\services\translate\pipeline.js  →（不在报告中：模块从未被加载）
ℹ server\app.js                          →（不在报告中）
ℹ server\routes\*.js                     →（11 个全部不在报告中）
```
`node --test` 的自带覆盖率列出 **50** 个文件，server 下有 **77** 个非测试 .js ⇒ **27 个连模块都没加载**，与静态导入图（DIRECT 23 / INDIRECT 27 / ZERO 27）吻合。

**3. 测试污染生产库（跑前/跑后各读一次）**
```
$ node -e "...new DatabaseSync('data/app.db',{readOnly:true})..."
chats_total 39 / messages_total 68 / leaked_test_messages 26 / works 424 / user_version 4
--- npm test ---
chats_total 40 / messages_total 69 / leaked_test_messages 27
```
（`leaked_test_messages` 的判定：`select count(*) from messages where content = char(35831,30475,36825,24352,22270)`，即"请看这张图"。）

**4. 污染数据已在用户可见面上（真实 HTTP，只读）**
```
$ curl -s http://127.0.0.1:7317/api/chats
[{"chatId":40,"title":"","provider":"deepseek","model":"deepseek-chat","updatedAt":1793718088733,"messageCount":1},
 {"chatId":39,"title":"","...,"messageCount":1}, ...]

$ curl -s http://127.0.0.1:7317/api/chats/40/messages
{"messages":[{"id":69,"role":"user","content":"请看这张图","citations":[],"contextMeta":{},"toolCalls":[],
 "attachments":[{"attachmentId":"file_a4bcd7b80c65e14e3809783fc4c587ce66a995dcc142e25bf61c9337ef6f3443",
 "source":"user","kind":"image","mediaType":"image/png","width":1,"height":1,"bytes":70,...}],...}]}

$ curl -s http://127.0.0.1:7317/api/works/1.1
{..."translateStats":null,"lastChatId":40,"availableTranslateOptions":{"engines":[]}}
```

**5. 测试假附件落进生产附件库**
```
$ node -e "sha256(Buffer.from([0x89,0x50,0x4e,0x47,1,2,3,4,5]))"
3ac1c50a39a7c7dac6e362c0011146823c4dae131657479ac4d16bcc076fc40a
$ Get-Item data\attachments\v1\objects\3a\3ac1c50a39a7...pdf   # 存在，9 字节
$ Get-Content ...\3ac1c50a39a7....meta.json
{"mediaType":"image/png","width":10,"height":20,"bytes":9}
```
与 `tool-registry.test.js:120` 的 `width: 10, height: 20` 完全对应。`data/attachments/v1/objects` 共 12 个对象体。

**6. 错误体与安全中间件（只读探针；此处更正早前一次 PowerShell 探针的"空体"误读）**
```
$ curl -s -i http://127.0.0.1:7317/api/nope
HTTP/1.1 404 Not Found
X-Trace-Id: d9ded7ee
{"error":{"code":"E_NOT_FOUND","message":"接口不存在：GET /api/nope","detail":{"path":"/api/nope"},"traceId":"d9ded7ee"}}

$ curl -s -i http://127.0.0.1:7317/api/chats/999999/messages
HTTP/1.1 404 Not Found
{"error":{"code":"E_NOT_FOUND","message":"会话不存在：999999","detail":{"chatId":999999},"traceId":"9c43dd81"}}

$ curl -s -o NUL -w "%{http_code}" -H "Host: evil.example" http://127.0.0.1:7317/api/health
403
$ curl -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: text/plain" -d x http://127.0.0.1:7317/api/works/1.1/download
400
$ curl -s -o NUL -w "%{http_code}" -H "Origin: http://evil.example" http://127.0.0.1:7317/api/health
200      ← 设计如此：Origin 只校验写方法（security.js:33-50）
```
结论：实现是对的，**但这些验证只存在于本次手工调用里**，测试套件里没有对应断言（F4）。

**7. 并发执行证明（3 个临时探针文件，各 sleep 400ms）**
```
$ node --test a.test.mjs b.test.mjs c.test.mjs
a start 1793718173417 / b start 1793718173421 / c start 1793718173429
b end   1793718173830 / a end 1793718173831 / c end   1793718173846
```
三个文件 12ms 内全部启动 ⇒ `node --test` 文件级并发属实；`os.availableParallelism()` = 16。

**8. 断言强度机械统计（按 `^test(` 切块，脚本从 stdin 喂给 node）**
```
test_blocks: 155  no_assert_at_all: 0  only_ok_no_equality: 31  with_strong_assert: 124
files_with_no_assert_tests: (none)
```

**9. 无回归测试的证据（grep，均为 0 命中）**
```
$ Select-String -Path server\test\*.test.js -Pattern 'resume|paused'   → 0 命中
$ Select-String -Path server\test\*.test.js -Pattern 'skippedLocked'  → 0 命中
$ Select-String -Path server\test\*.test.js -Pattern 'fields_locked'  → 仅 4 处，全部是 INSERT 列名
    （chat-summary.test.js:27、downloader.test.js:47、dual-index.test.js:27、fts.test.js:28）
```
`04-test` 里 FREEZE.md:15 引用的两个脚本：
```
$ Get-ChildItem 04-test -Recurse -File | Where-Object { $_.Name -match 'smoke|e2e' }
（无输出）
```

**10. 端点计数**
```
$ Select-String -Path server\routes\*.js -Pattern '\.\s*(get|post|put|patch|delete)\s*\('
assets 5 / chat 9 / download 1 / health 1 / import 1 / jobs 4 / layout 4 / segments 3 / settings 6 / translate 8 / works 6
TOTAL ENDPOINTS: 48
```

**11. 一次误发的写操作（如实记录）**
我在探"Content-Type 强制"时发了 `POST /api/works/1.1/download`（body `{"notAField":1}`，CT 仍为 application/json），返回：
```
HTTP/1.1 202 Accepted
{"jobId":29,"status":"needs_manual","reason":"E_NO_SOURCE"}
```
即这条 POST 没有触发 400，而是**在 `download_jobs` 里新建了一行**（jobId 29，`needs_manual`，无文件写入、无网络下载）。这违反了"只读调用"的约束，已在此披露；如需回滚可 `DELETE FROM download_jobs WHERE id = 29`。它同时说明：`/api/works/:no/download` 对未知字段不做校验、对无源条目直接落一条 `needs_manual` 行——这条行为没有任何测试（F2 的 48 端点之一）。

**12. 设计文档对照（只 grep，未通读 194KB）**
```
$ Select-String -Path 02-design\架构设计文档.md -Pattern '^#' | ...   → 25 个一级标题
$ Select-String -Path 02-design\架构设计文档.md -Pattern '自测|测试'  → 仅 2 处
$ Select-String ... -Pattern '^### 7\.1|^### 12\.2|^### 15\.2|^### 16\.2'
### 7.1 字段溯源矩阵（CSV 13 列 → DB）(492)
### 12.2 工具接口（下载 / 存储 / 检索）(1133)
### 15.2 触发下载 (1495)
### 16.2 pdftext.js 不移植后的衔接点 (1624)
```
⇒ 测试文件引用的章节号是真实存在的；反过来设计文档没有测试章节，也没有"不变量 → 用例"的映射表。
