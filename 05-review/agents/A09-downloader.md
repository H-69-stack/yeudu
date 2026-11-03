# A09-downloader：下载器 / 解析器链 / 存储自愈

评审范围：`03-code/server/services/downloader.js`（660 行）、`services/storage.js`（448 行）、`routes/assets.js`（346 行）、`routes/settings.js`、`services/resolvers/{index,arxiv,doi,link,manual}.js`、相关 `config.js / errors.js / index.js / app.js / services/pdf/meta.js`。
动态基线：`data/app.db` 424 works / 14 assets / 28 download_jobs；`storage/pdfs` 14 个 PDF。

## 结论

1. 实际状态机是 `queued → resolving → downloading → done|needs_manual|failed|canceled`；`verifying` 只存在于读侧（ACTIVE 集合、UI 文案、重启重置 SQL），全文没有一处写入它，校验期状态停在 `downloading`；未发现会永久卡在中间态的代码路径（异常边界外的 `markStatus` 抛错是唯一漏洞）。
2. 真正的自动重试只对 `E_NETWORK / E_TIMEOUT / E_RATE_LIMITED` 生效：所有 4xx/5xx 在 `fetchPdf` 里归一成 `E_UPSTREAM`，而 `E_UPSTREAM` 既在 `isPermanent` 里（直接 break），又满足 `reachableButNotPdf`（直接 needs_manual），因此 `maxAttempts=3` 对单源条目形同不存在——线上 job 28（HTTP 403）就是 attempts=1 直接 needs_manual。
3. 原子写本身成立：`.tmp` 恒由 `tmpDir()` 建在 `downloadDir` 内，`.part → rename` 必定同盘，`EEXIST/EPERM/ENOENT` 都有处理；只有运行期 `PUT /settings/downloadDir` 会让在途下载的 `finalAbs` 落在新目录之外（E_PATH_OUT_OF_SCOPE），并在旧 `.tmp` 留下无人清理的 `.part`。
4. 最实质的静默错误面在自愈：`resyncStorage` 只做 `fs.existsSync`、从不校验内容，实测 14 条里 2 条（1.8、1.11）DB 的 `file_sha256`/`file_size` 已与磁盘不符却仍判 `present`，`GET /assets/:id/file` 还把 DB 里的旧 sha 当 ETag。
5. 并发正确性有两处缺口：`cancelJob` 删掉整个 `.tmp` 的所有 `.part`（含另一路正在写的那份）；下载路径不像上传路径那样删旧文件，配合"按 no 认领"的孤儿认领，同一编号两份文件时会静默指错。

## 问题索引（对应任务书 Q1–Q7）

- Q1 状态机/中间态：F10（verifying 不存在）、F2（失败语义）、F3（取消的副作用）、"无永久卡死路径"见结论 1。
- Q2 原子写/`.part` 残留/ENOSPC：F5（切目录）、F3（残片清理方式）、F7（ENOSPC 错误码）。
- Q3 解析器链失败语义：F2（4xx/5xx 不再往下试）、F9（link 不做直链判定，误判率 = 落地页占比）。
- Q4 重试与退避：F2（HTTP 错误 0 次重试）、F6（arXiv 间隔失效）、F3（force 与活跃 job 的关系：`force` 只绕过"文件已在位"，不打断进行中的 job）。
- Q5 自愈成本与误伤：F1（不校验内容）、F4（按 no 认领会乱指，用户改名保留 `<no>__` 前缀即被静默认领，去掉前缀则判 missing）；成本实测 400 篇 36–51 ms，线性、不构成启动瓶颈。
- Q6 文件名：`<no>__<slug>.pdf` 由 `slugify(title,{maxLen:80})` 生成，14 条现有文件全部能按当前代码复算出来（含 1.8 那条 79 字符的 slug），`parseNoFromFilename` 与 `buildRelPath` 在现有数据上一一对应；冲突语义见 F4。
- Q7 上传/下载竞争：**没有锁，但当前实现下是安全的**——两条路径的 `rename → commitAsset` 之间没有 `await`，`node:sqlite` 又是同步写，DB 写与 rename 落在同一宏任务内不会交错；风险点在"最后写入者赢"而不是"DB 与文件不一致"（见覆盖与盲区 6）。

## findings

### F1（high）自愈只判"文件在不在"，不校验内容，DB 元数据静默陈旧

**现象**：`resyncStorage` 对每条 asset 只做 `fs.existsSync`；存在即 `file_state='present'` 并刷新 `last_verified_at`，不看大小、魔数、页数、sha。走"按编号认领"分支时用 `atomicUpdate` 更新行，而它只写 `storage_rel_path/file_size/file_state`。

**证据**：`03-code/server/services/storage.js:306-315`
```js
      const exists = abs && fs.existsSync(abs);
      const now = Date.now();
      if (exists) {
        present += 1;
        seen.add(path.basename(abs));
        if (a.file_state !== 'present') {
          run(`UPDATE assets SET file_state='present', missing_since=NULL, last_verified_at=?, updated_at=? WHERE id=?`, [now, now, a.id]);
```
`03-code/server/services/storage.js:369`（`atomicUpdate` 的 UPDATE 列表，无 `file_sha256` / `page_count` / `extract_version`）
```js
    `UPDATE assets SET storage_rel_path=?, file_size=?, file_state='present', missing_since=NULL, last_verified_at=?, updated_at=? WHERE id=?`,
```
实测（动态验证记录 2、3）：14 条里 2 条不符——id=4（no=1.8）DB `file_size=3579791 / sha=c7d4f18c…aa82 / page_count=10`，磁盘 3576284 字节、sha=`ba26c222…4845`、mtime 2026-11-03 13:27:04；id=5（no=1.11）DB `1150259` vs 磁盘 `1146328`。`GET /api/assets/4/file` 返回 `ETag: "c7d4f18c8f5eb100"`、`Content-Length: 3576284`——ETag 来自 DB 旧 sha（`routes/assets.js:130`），与实际字节不对应。

**影响**：文件被外部替换/截断/半拷贝时，系统仍宣称"已校验"，抽取与翻译继续基于旧字节产出结论，用户打开 PDF 看到的与译文对不上；浏览器/代理按 ETag 判定未变，可能一直拿到旧缓存。这是"假成功"型的静默错误。

**建议**：`resync` 对 `present` 行做 `statSync().size` + 头 5 字节 + 页数校验（可选 sha256，14 条 × 5MB 约 1s，400 篇可设采样或异步），不一致置 `file_state='corrupt'` 并 `extract_version+1` 触发重抽取；`atomicUpdate` 同步回写 `file_size/file_sha256/page_count`；ETag 改用 `mtimeMs-size` 或读到文件后再算。

**effort**：M

### F2（high）上游 4xx/5xx 一律不重试，`maxAttempts` 对单源条目形同虚设

**现象**：`fetchPdf` 把 `>=400` 与非 200/206 一律抛 `E_UPSTREAM`；`E_UPSTREAM` 同时出现在 `isPermanent` 和 `reachableButNotPdf` 两个判定里，后果是"不重试 + 直接人工"。

**证据**：`03-code/server/services/downloader.js:270`、`278`、`304`
```js
        if (isPermanent(err.code)) break; // 该源结论明确，换下一个源
```
```js
  const reachableButNotPdf = errors.length > 0 && errors.every((e) => e.code === 'E_NOT_PDF' || e.code === 'E_UPSTREAM');
```
```js
  return ['E_NOT_PDF', 'E_TOO_LARGE', 'E_SSRF_BLOCKED', 'E_NO_SOURCE', 'E_UPSTREAM', 'E_PATH_OUT_OF_SCOPE'].includes(code);
```
配合 `361-370`：`if (res.status >= 400) { throw new AppError('E_UPSTREAM', \`上游返回 HTTP ${res.status}\`, …)}`、`if (res.status !== 200 && res.status !== 206) { throw new AppError('E_UPSTREAM', \`未预期的 HTTP ${res.status}\`, …)}`。

**影响**：503/502/连接重置这类瞬时故障与 403/404 一起被当成"结论明确"，attempt 循环第 1 次就 break，随后 `reachableButNotPdf` 为真 → `needs_manual`，`attemptsUsed < maxAttempts` 那段代码根本走不到。线上 job 28 即此形态：`source=link`、`attempts=1`、`status=needs_manual`、`error_code=E_UPSTREAM`、`error_message="…link: E_UPSTREAM 上游返回 HTTP 403"`。321 条有 arXiv 编号的条目几乎全是单源（0 条同时带 link），一次抖动就要人肉点重试。另外 429 虽可重试，但不读 `Retry-After`，固定 700ms/1s/4s/15s 退避。

**建议**：把上游错误细分——5xx/408/连接重置 → `E_UPSTREAM_RETRY`（移出 `isPermanent` 与 `reachableButNotPdf`）；403/404/410 → 永久；429 读 `Retry-After` 作为退避下限。`reachableButNotPdf` 只保留 `E_NOT_PDF`。

**effort**：M

### F3（high）取消任务会删掉整个 `.tmp` 的 `.part`，包括另一路正在写的那份

**现象**：`cancelJob` 注释写着"同盘 .tmp 下所有该进程的残片都是可丢弃的"，实现是把目录里**所有** `*.part` 一并 `rm`，没有按 jobId 过滤。

**证据**：`03-code/server/services/downloader.js:641-648`
```js
  // 清理 .part 残片（同盘 .tmp 下所有该进程的残片都是可丢弃的）
  try {
    const dir = tmpDir();
    const files = await fsp.readdir(dir);
    await Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true })));
```

**影响**：`concurrency=2` 时取消 A 会 unlink B 正在写的 `.part`；B 的写句柄继续写入已删除的 inode，最终 `commitAtomic` 的 `rename` 得 `ENOENT`（`storage.js:227-235` 对 ENOENT 是 `break` 后抛 `E_DISK`），B 判失败并重下一遍——若 B 已是最后一次 attempt（`attemptsUsed=3`）则永久 `failed`。表现为"取消一个下载，另一个无辜失败/重下"。

**建议**：`part` 文件名带 jobId（`fetchPdf` 现在拼的是 `pid-ts-rand`），取消时只删 `*-job<id>-*.part`；全局残片清理改成启动时按 mtime 老化（例如 >1h）而不是无条件删。

**effort**：S

### F4（medium）同一编号两份文件时按编号乱认领，且下载路径不删旧文件

**现象**：`resync` 用 `byNo` 把文件按编号建 Map（同编号只留最后一个，顺序取决于 `readdir`）；孤儿认领循环对"该 work 已有 asset 行"的文件无条件 `atomicUpdate` 改指过去。而下载路径（`processJob → fetchPdf → commitAtomic`）在标题变化导致新文件名时**不会**删除旧文件——上传路径有这段逻辑（`routes/assets.js:242-249` 注释"换了文件名（标题改过）→ 删旧文件，避免两份物理文件"），下载路径没有。

**证据**：`03-code/server/services/storage.js:294`、`343-345`
```js
  const byNo = new Map(files.map((f) => [parseNoFromFilename(f), f]));
```
```js
        const existing = get('SELECT id FROM assets WHERE work_id=? AND kind=?', [work.id, 'pdf']);
        if (existing) {
          atomicUpdate(existing.id, f, now);
```

**影响**：改标题后重下 → 目录里留下 `<no>__旧slug.pdf` 与 `<no>__新slug.pdf` 两份；下次启动/重扫时按 `readdir` 顺序认领，asset 行可能被指回旧文件，而 `atomicUpdate` 不改 `file_sha256/page_count/extract_version`，于是"行指向旧文件、元数据来自新文件"。用户手工改名也一样：保留 `<no>__` 前缀会被静默认领（不判 missing），去掉前缀才判 missing。

**建议**：下载成功前读旧 `storage_rel_path`，路径变化则删旧文件（与上传路径共用同一段逻辑）；`resync` 以 `storage_rel_path` 为准，不做跨文件名认领；必须认领时先校验页数/sha 再写，且不一致置 `extract_status='pending'`。

**effort**：M

### F5（medium）`PUT /settings/downloadDir` 不是迁移：全部 assets 立刻判 missing，在途下载炸在最后一步

**现象**：`migrate` 模式被如实拒绝（这点是对的），但 `switch` 模式只是改运行时目录 + 持久化 + 立刻 `resyncStorage`，文件仍留在旧目录。

**证据**：`03-code/server/routes/settings.js:120-130`
```js
      if (mode === 'migrate') {
        // M1 不做目录迁移（要逐个 rename 数百个文件 + 后台 job），如实拒绝而不是假装成功
        throw new AppError('E_BAD_REQUEST', 'M1 未实现目录迁移（migrate）；请用 switch 模式并手动移动文件', { mode });
      }
```
```js
      const previous = config.download.downloadDir;
      const resolved = setRuntimeDownloadDir(target);
      persistSetting('download.downloadDir', resolved);
      const report = await resyncStorage({});
```

**影响**：切换瞬间 14 条（将来 400 条）全部 `file_state='missing'`，`GET /assets/:id/file` 一律 410，抽取/翻译入口全部报缺失；设置已持久化，重启后依旧。在途下载的 `finalAbs` 是切换前按旧 `downloadDir` 算的，`commitAtomic` 里的 `assertInDownloadDir(finalAbs)`（`storage.js:222`）会抛 `E_PATH_OUT_OF_SCOPE`（`isPermanent` → 本次 attempt 白下 5MB），`.part` 留在旧 `.tmp`，而启动清理只清当前 `.tmp`。

**建议**：`switch` 前要求目录为空或确认清单；切换时把在途 job 全部 cancel 并等待 `activeCount=0`；`commitAtomic` 抛 E_PATH_OUT_OF_SCOPE 时清掉自己的 `part`；文档/UI 明确"switch = 换目录，不搬文件"。

**effort**：M

### F6（medium）arXiv 3 秒礼貌间隔在并发 2 下失效

**现象**：`throttleHost` 是 check-then-act：先读 `lastRequestAt`，算出要等多久，`await sleep(wait)` **之后**才写回时间戳。两个 arXiv 任务在同一 tick 进入时都读到 `last=0`，于是同时发请求。

**证据**：`03-code/server/services/downloader.js:424-427`
```js
  const last = lastRequestAt.get(key) || 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(key, Date.now());
```

**影响**：`requestIntervalMs=3000` 的承诺只在并发 1 时成立；`config.download.concurrency=2` 时对 arXiv 的实际间隔可能为 0，批量补齐数百条 arXiv 条目时更容易触发 429/403 甚至 IP 级限制——而 403 在当前语义下直接 `needs_manual`（F2），一次限流就会污染一批条目。

**建议**：把 state 改成 `nextAllowedAt` 并**在 await 之前**写入 `nextAllowedAt = max(now, nextAllowedAt) + gap`，或用一个 promise 链（`lastRequestAt` 存 promise）串行化同一 host 的请求。

**effort**：S

### F7（medium）磁盘满报 `E_INTERNAL` 而不是 `E_DISK`，还会白试 3 轮

**现象**：`drainPdf` 的 `fh.write` 抛的是 Node 原生 `ENOSPC`，`toAppError` 用"code 是否在 `ERROR_CODES` 表里"判断，`ENOSPC` 不在表里 → 归一成 `E_INTERNAL`。`E_DISK` 虽然定义了，只有 `commitAtomic` 的兜底分支会抛。

**证据**：`03-code/server/errors.js:56-64`
```js
export function toAppError(e) {
  if (isAppError(e)) return e;
  const err = new AppError(
    e && e.code && ERROR_CODES[e.code] ? e.code : 'E_INTERNAL',
    (e && e.message) || '未知异常',
    null,
  );
```

**影响**：磁盘满时用户看到"未分类的服务端异常"（`E_INTERNAL`）而不是"本地写盘失败"；且 `E_INTERNAL` 不在 `isPermanent` 里 → `sleep(700)` 重试一次 → 再走 `scheduleRetry` 最多 3 轮 × 2 候选，每次都要先建 `.part` 写到一半才失败，日志里只剩一串 `download.attempt_failed E_INTERNAL`。

**建议**：在 `toAppError` 里加一张原生错误码映射表（`ENOSPC/EDQUOT → E_DISK`、`EACCES/EPERM → E_PERM`、`EMFILE → E_INTERNAL`），并把 `E_DISK` 加入 `isPermanent`（磁盘满重试没有意义）。

**effort**：S

### F8（medium）取消/退避/原子写/自愈四条核心路径零测试

**现象**：`server/test/downloader.test.js` 只有 6 个用例，全部打在同步入口（`createDownload / retryJob / listJobs / getJob`），异步的 `processJob` 状态机一行没测；`storage-name / upload-safety / path-scope` 三个测试只覆盖命名与路径白名单；`04-test/` 的独立验证套件覆盖渲染栈与门控自愈，与存储无关。

**证据**：`03-code/server/test/downloader.test.js:57`、`68`
```js
test('三无条目（无 arxiv/doi/link）→ needs_manual，不假装成功', () => {
```
```js
test('已下载且文件在位 → 200 alreadyDownloaded（不重复入队）', () => {
```

**影响**：本轮 10 条 finding 里，F2/F3/F4/F5/F7 都是"改一行就会回归、但没有一行测试会报警"的类型；尤其 `cancelJob` 的目录级删除和 `isPermanent` 的名单，属于任何重构都可能静默改变行为的地方。项目又没有 git/CI，回归只能靠人眼。

**建议**：补 4 个用例——(a) 用本地 http server 回 503 断言发生 attempt 重试而不是 needs_manual；(b) 起两个 job、cancel 其一、断言另一个仍完成（或至少 `.part` 不被误删）；(c) 在 `.tmp` 造残片 + 目标目录放一个同名不同内容的 PDF，断言 resync 之后 `file_state` 与 sha 自洽；(d) 用 `fs.rename` 抛 `ENOSPC` 的桩断言错误码是 `E_DISK`。

**effort**：M

### F9（low）`verifying` 状态从不被写入，校验期状态停在 downloading

**现象**：`verifying` 出现在 `ACTIVE_STATUSES`、重启重置 SQL、`web/assets/work.js` 的中文文案（`verifying: '校验中（魔数 / 页数 / 体积）'`）里，但 `downloader.js` 全文没有任何一处 `markStatus(..., 'verifying')`：`downloading` 之后直接 `done`，中间的 `assertPdfFile` 校验发生在 `drainPdf` 内、状态不变。

**证据**：`03-code/server/services/downloader.js:230`、`243`
```js
      markStatus(jobId, 'downloading', { source: cand.source, url: cand.url });
```
```js
        markStatus(jobId, 'done', {
```

**影响**：状态机与设计文档/不变量 ④ 不一致；前端那条"校验中"分支是死代码，体量稍大的 PDF 在魔数/页数校验那几十毫秒里仍显示"下载中"，校验失败直接跳 `needs_manual`，中间态在可观测性上不存在。属文档/实现漂移，不影响正确性。

**建议**：二选一——要么在 `drainPdf` 校验前后补 `verifying`（并纳入 `bootDownloader` 的重置集合，已有），要么把 `verifying` 从 ACTIVE 集合/UI/文档里删掉，别留第三态。

**effort**：S

### F10（low）link 通道不做任何"是不是 PDF 直链"的判定，37/40 条注定落空

**现象**：`resolveLink` 只校验 `^https?://`，不做 HEAD、不看 `Content-Type`、不按后缀分级，一律给 `expect:'unknown'`，把判定完全下推到 `drainPdf` 读前 5 字节魔数。

**证据**：`03-code/server/services/resolvers/link.js:12`、`20`
```js
  if (!link || !/^https?:\/\//i.test(link)) return [];
```
```js
      expect: 'unknown',
```

**影响**：实测 40 条带 link 的条目里只有 3 条以 `.pdf` 结尾，其余是规范/项目主页（`http://www.fipa.org/specs/fipa00061/`、`https://www.commonwl.org/v1.0/`、`https://www.omg.org/spec/BPMN/2.0/` 之类）。每次点"下载"都要建连、跟随重定向、读完响应头再靠 5 字节判 `E_NOT_PDF`，然后落 `needs_manual`——即"误判率"等价于落地页占比 92.5%，成本是一次完整 HTTP 往返 + 一个 45s 超时名额。`expect` 字段目前没有任何消费方（全仓只在注释与构造处出现）。

**建议**：要么让 `expect` 真正被用起来（`'unknown'` 的先 HEAD 一次，`content-type: text/html` 直接给"落地页，需人工"并跳过 body 下载），要么对非 `.pdf` 后缀的 link 直接生成 needs_manual 并附跳转链接，别每次都去试。

**effort**：S

## 覆盖与盲区

1. **未做真实网络并发实测**：禁止重启 7317，无法注入两个并发 job 去复现 F3 的 `.part` 竞争，也无法实测 F2 的 503 行为；这两条结论来自代码路径 + 线上 job 表（job 28 的 attempts=1 是真实证据），不是压测结果。
2. **无法制造 ENOSPC / 跨盘**：没有可牺牲的满盘分区。另外确认：`tmpDir()` 恒在 `downloadDir` 内，所以 `.part → rename` 正常路径**必定同盘**，`commitAtomic` 不处理 `EXDEV` 在当前实现下不可达（若将来允许 `.tmp` 独立配置才需补）。
3. **1.8 / 1.11 两个 PDF 被谁改写查不出来**：全仓业务写盘调用只有 `routes/assets.js`（215/223/229/245/315/320/327）、`downloader.js`（72/468/478/645）、`storage.js`（227/231）三处；`app-2026-11-03.log` 里这两个编号只有 `translate.start`，没有任何 upload/download 事件，所以是应用外工具改的。本节只证明"系统没有察觉"（F1 成立），不追查改写者。
4. **02-design 只按需 grep**：架构设计文档 194KB 未通读，`verifying` 是否属于正式设计、`link` 是否该做 HEAD 这两点没有与文档逐条核对，F9/F10 的建议以代码内注释（"§9.1.2 L2"、"§23.2"）为参照。
5. **multipart 上传的内存峰值未测**：`routes/assets.js:173` 的 `express.raw` limit 是 `maxBytes + 8MB ≈ 128MB`，整个包体进内存；单用户场景影响有限，未列为 finding，也未实测并发上传的 RSS。
6. **上传/下载"无锁但安全"的论证依赖同步 DB**：两条路径都是 `rename` 完成后同一宏任务内同步写 DB，因此"文件与行"最终一致；但若将来 `commitAsset` 变成异步（或引入事务异步化），这个隐式顺序保证会失效——没有锁、也没有注释记录这个前提。另外 `retryJob` 不检查同 work 是否已有活跃 job，同一条目可能有两个 job 同时下载同一路径（最终字节由最后 rename 者决定，DB 随之），属浪费而非不一致。

## 动态验证记录

### 1. 全仓 PDF 写入口盘点

```powershell
cd 'D:\A-knowledge\agent工作流优化\03-code'
Select-String -Path server\**\*.js,scripts\*.js -Pattern 'writeFile|createWriteStream|copyFile|rename\(|\.rm\(|unlink'
```
真实输出（去除 test/* 与 scripts/make-preview.js 后）：
```
server\routes\assets.js:215: await fs.writeFile(partAbs, data);
server\routes\assets.js:223: await fs.rm(partAbs, { force: true }).catch(() => {});
server\routes\assets.js:229: await fs.rm(partAbs, { force: true }).catch(() => {});
server\routes\assets.js:245: await fs.rm(assertInDownloadDir(path.resolve(config.download.downloadDir, existing.storage_rel_path)), { force: true });
server\routes\assets.js:315: await fs.copyFile(srcAbs, partAbs);
server\routes\assets.js:320: await fs.rm(partAbs, { force: true }).catch(() => {});
server\routes\assets.js:327: .rm(assertInDownloadDir(path.resolve(config.download.downloadDir, existing.storage_rel_path)), { force: true })
server\services\downloader.js:72: .then((files) => Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true }))))
server\services\downloader.js:468: await fsp.rm(partAbs, { force: true }).catch(() => {});
server\services\downloader.js:478: await fsp.rm(partAbs, { force: true }).catch(() => {});
server\services\downloader.js:645: await Promise.all(files.filter((f) => f.endsWith('.part')).map((f) => fsp.rm(path.join(dir, f), { force: true })));
server\services\storage.js:227: await fsp.rename(part, final);
server\services\storage.js:231: await fsp.rm(final, { force: true });
```

### 2. `storage/pdfs` 与 DB 一致性（不一致条数 = 2）

```powershell
$code = @'
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const db = new DatabaseSync("D:/A-knowledge/agent工作流优化/03-code/data/app.db", { readOnly: true });
const rows = db.prepare("SELECT id, storage_rel_path rel, file_size, file_sha256, page_count, file_state FROM assets ORDER BY id").all();
let bad = 0;
for (const r of rows) {
  const abs = path.resolve("storage/pdfs", r.rel);
  if (!fs.existsSync(abs)) { console.log("MISSING", r.id, r.rel); bad++; continue; }
  const b = fs.readFileSync(abs);
  const sha = crypto.createHash("sha256").update(b).digest("hex");
  const ok = sha === r.file_sha256 && b.length === r.file_size;
  if (!ok) { bad++; console.log("MISMATCH id=", r.id, "no=", r.rel.split("__")[0], "dbSize=", r.file_size, "diskSize=", b.length, "shaOK=", sha === r.file_sha256); }
}
console.log("bad:", bad, "/", rows.length);
'@
$code | node -
```
真实输出：
```
MISMATCH id= 4 no= 1.8 dbSize= 3579791 diskSize= 3576284 shaOK= false
MISMATCH id= 5 no= 1.11 dbSize= 1150259 diskSize= 1146328 shaOK= false
bad: 2 / 14
```
其余 12 条 size 与 sha 全对。目录侧：`storage/pdfs` 下 14 个 PDF、157386–5788348 字节；`storage/pdfs/.tmp`、`storage/inbox`、`storage/tmp` 三个目录**全空**（0 个 `.part` 残留，说明反复的重启/重试没有留下垃圾）。

### 3. ETag 与磁盘字节不符（正在跑的服务上只读取头）

```powershell
curl.exe -sS -D - -o NUL http://127.0.0.1:7317/api/assets/4/file
(Get-FileHash 'storage\pdfs\1.8__the-contract-net-protocol-high-level-communication-and-control-in-a-distributed.pdf' -Algorithm SHA256).Hash.ToLower()
```
真实输出：
```
HTTP/1.1 200 OK
Content-Type: application/pdf
Accept-Ranges: bytes
Cache-Control: no-store
ETag: "c7d4f18c8f5eb100"
Content-Length: 3576284
...
ba26c22249127da2d37176d106d4c67230916a26acfb3b9f98d6e57fe0fa4845
```
DB 行：`id=4, file_sha256=c7d4f18c8f5eb10095c4393e244f6cf88ded1ff9620b82647f48ccd54009aa82, file_size=3579791, page_count=10, file_state=present, extract_version=4`。磁盘文件头 5 字节仍是 `%PDF-`、`/Type/Page` 计数 10、`/Count 10`（所以三连校验会通过，但内容已换）。

### 4. 下载任务表：错误码分布与真实失败形态

```js
db.prepare("SELECT COALESCE(error_code,'(null)') c, status, count(*) n FROM download_jobs GROUP BY c, status").all()
db.prepare("SELECT status, attempts, count(*) n FROM download_jobs GROUP BY status, attempts").all()
db.prepare("SELECT * FROM download_jobs WHERE id=28").get()
db.prepare("SELECT count(*) n FROM works WHERE arxiv_id IS NOT NULL AND arxiv_id != ''").get()
db.prepare("SELECT count(*) n FROM works WHERE link IS NOT NULL AND link != ''").get()
db.prepare("SELECT count(*) n FROM works WHERE link LIKE '%.pdf'").get()
```
真实输出：
```
jobs by error_code: [{"c":"E_NO_SOURCE","status":"needs_manual","n":23},{"c":"(null)","status":"done","n":4},{"c":"E_UPSTREAM","status":"needs_manual","n":1}]
attempts 分布: [{"status":"done","attempts":1,"n":4},{"status":"needs_manual","attempts":0,"n":23},{"status":"needs_manual","attempts":1,"n":1}]
job28: {"id":28,"work_id":32,"status":"needs_manual","source":"link","url":"http://www.fipa.org/specs/fipa00061/",
        "http_status":null,"bytes_done":0,"attempts":1,"error_code":"E_UPSTREAM",
        "error_message":"自动源都没有返回可用 PDF。link: E_UPSTREAM 上游返回 HTTP 403","next_retry_at":null}
works 有 arxiv_id: 321
works 有 link: 40
works 都有: 0
link 以 .pdf 结尾: 3
```
（`http_status` 在失败分支没被写回，403 只留在 `error_message` 文本里——顺带说明 F1/F2 之外的可观测性小缺口。）

### 5. resync 全盘扫描成本（复刻 `resyncStorage` 每行的 syscall 序列）

```js
// 每行：path.resolve → realpathSync.native（含最近祖先回退）→ existsSync，与 storage.js:298-306 同构
bench(400,true) / bench(400,false) / bench(4000,true)
```
真实输出：
```
warm files: 14
400 行全部存在(复刻 resync 每行 realpath+existsSync): 35.72 ms
400 行全部缺失: 50.85 ms
4000 行(线性外推校验): 345.79 ms
```
结论：400 篇约 **36–51 ms**，线性、不构成启动瓶颈——`index.js:34` 把 `resyncStorage` 放在 `app.listen` 之前是安全的；真正的代价是**它不校验内容**（F1），而不是慢。（若按 F1 建议加 sha256，14 条 5MB 级文件约需 +1s，400 篇需改成抽样或后台异步，否则启动会从 50ms 变成数秒。）

### 6. `verifying` 是否存在写入点

```powershell
Select-String -Path server\**\*.js,web\**\*.* -Pattern "verifying"
```
真实输出（11 处，全部是读侧：状态集合、SQL 过滤、UI 文案、重启重置，**无一处写入**）：
```
server\routes\jobs.js:8: const JOB_STATUSES = ['queued','resolving','downloading','verifying','done','failed','needs_manual','canceled'];
server\services\artworks.js:33: ORDER BY (CASE WHEN j.status IN ('queued','resolving','downloading','verifying') THEN 0 ELSE 1 END), j.id DESC
server\services\artworks.js:89: case 'verifying':
server\services\artworks.js:215 / :407 同上（ORDER BY / count）
server\services\downloader.js:27: const ACTIVE_STATUSES = ['queued', 'resolving', 'downloading', 'verifying'];
server\services\downloader.js:65: `UPDATE download_jobs SET status='queued', next_retry_at=NULL WHERE status IN ('resolving','downloading','verifying')`
server\services\downloader.js:112 / :656 同上
web\assets\list.js:23 / :255、web\assets\work.js:27 / :128
```

### 7. 文件名可复算（`<no>__<slug>.pdf` 与 `parseNoFromFilename`）

```js
// 用 server/services/storage.js 的同款 slugify(…,{maxLen:SLUG_MAX=80}) 复算 14 条
for (const r of rows) { const want = r.no + "__" + slugify(r.title, {maxLen:80}) + ".pdf"; if (want !== r.rel) mism++; }
```
真实输出：`mismatch: 0 / 14`（注意：用默认 `maxLen=60` 复算时 1.8 那条会"不符"，因为 `buildRelPath` 传的是 `SLUG_MAX=80`，1.8 的 slug 长 79 字符——不是 bug，是我一开始把默认参数当成了实际参数）。`works.no` 中带两个及以上小数点的 0 条，`parseNoFromFilename` 在现有数据上无歧义。

### 8. 测试覆盖盘点

```powershell
Get-ChildItem test\*.test.js   # server/test 下 18 个
Select-String -Path downloader.test.js,storage-name.test.js,upload-safety.test.js,path-scope.test.js -Pattern "^\s*(test|it|describe)\("
```
真实输出：`downloader.test.js` 6 个用例（三无条目 / alreadyDownloaded / reused / retry 冲突 / listJobs / E_NOT_FOUND）；`storage-name` 6 个（slugify ×3、buildRelPath、parseNoFromFilename、互逆）；`upload-safety` 7 个；`path-scope` 6 个。异步下载状态机、取消、退避分类、原子写、resync 认领均无用例。
