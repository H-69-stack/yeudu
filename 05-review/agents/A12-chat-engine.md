# A12 · 对话引擎 / 工具注册表 / 上下文装配 评审

评审对象：`03-code/server/services/chat/`（23 文件、157,413 字节、3,263 非空行）+ `routes/chat.js`（197 行）
评审方式：全文精读 14 个文件 + node 直接 import 真实模块做动态验证 + node:sqlite 只读探针 + 服务只读 curl。**未改任何被测文件，未重启 7317。**

## 结论

1. 模块切分是清楚的：`agent.js` 是**门面/barrel**（导出 session/citations/prompts 的实现 + `activeEngine()` 二选一分派），`pipeline.js` 是 tools 引擎的 SSE 编排，`loop.js` 只管"调模型→执行工具→回填"的回合机，`session.js` 独占落库；但两块真正的重复不是"切分"，而是**两套引擎各写一遍同样的东西**：SSE 头/心跳/abort/90s 计时器、用户消息落库时机、`parseCitations + assembleCitations`、以及 `done` 事件字段。
2. 三处额度**不会互相绕过，但会互相掩盖**：`maxRounds`(5) 是唯一硬闸（上游请求 ≤6）；`maxCalls`(8) 触发 `exhausted` 后 loop 会强制收尾；而每名工具的跨轮配额**只返回错误、不置 exhausted**，且被拒的尝试不计数 —— 模型因此可以在第 1~5 轮反复重试同一个已被封死的工具，直到轮数耗尽。给模型的措辞是"**工具执行失败**"，语义上鼓励重试。
3. 上下文预算只覆盖一半系统：`context.js` 的六档硬编码预算只服务 legacy；tools 引擎（`pipeline.buildToolMessages`）**完全没有预算**，且 `meta.contextChars` 把 base64 图片算成 0。实测"长选区"时用户选中的原文被裁到 165/2000 字，而 600 字邻段完整保留。
4. 引用**回查了 DB**（不是只解析正则），但只按 `(asset_id, page_no, ord)` 回查 —— 而工具层（`lit_search`/`lit_read`）允许跨文献阅读并返回锚点，锚点格式里又没有文献编号。后果：跨文献引用 100% 被静默丢弃（真实数据里 8 个锚点丢 2 个），正文仍显示 `[pN#M]`；若坐标在当前这篇里碰巧存在，会把无关段落当成该引用的原文。
5. 视觉通道（`page-image-source.js` 675 行 + 几何 125 行 + `lit-page-image.js` 152 行）是**后端建好、前端零入口**：`pageImage.enabled` 默认 false、playwright 未安装（`E_RENDERER_UNAVAILABLE`）、routes/web 里 grep 不到任何 `pageImage|lit_page_image|PAGE_IMAGE`。它今天是技术债，不是功能。

## 调用图与职责切分

```
routes/chat.js:134  postMessage(...)
└─ agent.js:59 postMessage            ← 门面：按 activeEngine() 二选一分派
   ├─ agent.js:78 postMessageLegacy(328 行文件里的 78-245)
   │  ├─ session.loadChat ──────────────── 读 chat/work/asset
   │  ├─ session.insertUserMessage(chat, content)          ← 落库①（无附件引用）
   │  ├─ retrieval.decideRetrieval(:153) → retrieval.retrieve(:160)  ← 检索决策+双索引
   │  ├─ context.buildBlocks(:170) → context.buildContext(:171)      ← 唯一的预算/裁剪
   │  ├─ runMockOrReal(:247) → llm/client                              ← 出字（SSE delta）
   │  ├─ prompts.parseCitations(:203) → citations.assembleCitations(:204)  ← 引用回查
   │  ├─ session.insertAssistantMessage(:131)              ← 落库②
   │  └─ agent.maybeCompressSummary(:228)                  ← 只有 legacy 维护 chats.summary
   └─ pipeline.postMessageTools(:169，380 行)
      ├─ resolveUserAttachments(:56) + insertUserMessage(:196)   ← 落库①（带附件引用）
      ├─ pipeline.buildToolMessages(:125)                        ← 另一套上下文装配（无预算）
      ├─ loop.runToolLoop(:268，159 行)
      │  ├─ call(true) → llm/client（带 tools schema）
      │  ├─ registry.run(:176) → tools/*.execute → db/fts/attachments/render
      │  │   └─ 失败→ messages.push({role:'tool', content:`工具执行失败（x）：…`})
      │  ├─ image-inject.buildImageInjection(:129) → 以 role:'user' 注入 base64 图
      │  └─ exhausted / 轮数用尽 → call(false) 强制收尾
      ├─ citations.assembleCitations(:319/:360)                  ← 与 legacy 同款，写了两遍
      └─ session.insertAssistantMessage(:322/:361)                ← 落库②
```

**职责**：`agent.js` = 门面/barrel（`:44` 直接 re-export `session/citations/prompts` 的实现，`routes/chat.js:17` 是它唯一消费者）+ legacy 实现；`pipeline.js` = tools 引擎的 SSE 编排（发 meta/tool/tool_result/delta/image/citation/done）；`loop.js` = 纯回合机（调模型→执行工具→回填 role:'tool'→注入图→收尾），不含任何 HTTP/落库；`session.js` = 唯一落库层 + 查询投影（含 `countToolCalls` 这种给 registry 用的跨轮配额数据源）。

**重叠处（同一件事写了两遍）**：

| 职责 | legacy 位置 | tools 位置 |
|---|---|---|
| 用户消息落库 | `agent.js:88` | `pipeline.js:196` |
| 助手消息落库（含出错分支） | `agent.js:131` / `:237` | `pipeline.js:322` / `:361` |
| 引用装配 | `agent.js:203-204` / `:236` | `pipeline.js:319` / `:360` |
| `done` 事件字段（citations/noCitation/retrievalMiss/truncated） | `agent.js:214-222` | `pipeline.js:337-348`（`retrievalMiss` 恒 false） |
| SSE 头 + heartbeat + AbortController + 90s 计时器 | `agent.js:90-113` | `pipeline.js:198-228` |
| 上下文装配/预算 | `context.js`（有六档预算） | `pipeline.buildToolMessages`（零预算） |
| 历史窗口 | `prompts.lastTurns`（压成一段文本） | `prompts.lastTurns`（真实 role，无字符上限） |
| `chats.summary` 维护 | `maybeCompressSummary` | **没有**（tools 引擎从不更新摘要） |

## findings

### F1 · 中文提问在默认（legacy）引擎里必然 0 命中，且无 key 时改写兜底直接放弃

**现象**：`toFtsText` 把整句中文切成**双字 bigram**，英文正文索引里当然不含"这篇/篇论/论文"这类 token；legacy 的检索走 `searchSegments(asset_id)`，于是中文提问恒 0 命中。唯一救星是"0 命中→改写英文关键词"兜底，但本机无 provider key 时该兜底**直接返回空**，不再检索。

**证据**
- `03-code/server/services/fts.js:40-...`（`toFtsText`）：
  ```js
    if (cjk.length === 1) out.push(cjk);
    else for (let i = 0; i < cjk.length - 1; i += 1) out.push(cjk.slice(i, i + 2));
  ```
- `03-code/server/services/chat/retrieval.js:101-104`：
  ```js
  const hasCjk = CJK_RE.test(String(query || ''));
  if (!allowRewrite || !hasCjk) {
    return { hits: [], rewritten: false, keywords: null, mocked: false, reason: 'no-hit-no-rewrite' };
  }
  ```
- `03-code/server/services/chat/retrieval.js:64-67`：
  ```js
  if (!prov.hasKey) {
    // 没有 key 时不做改写（不静默用一个假关键词去搜）
    return { keywords: '', engine: provider, mocked: false, skipped: 'no-key' };
  }
  ```
- 动态（真实 DB、真实分词规则）：`q="这篇论文的贡献是什么" tokens="这篇 篇论 论文 文的 的贡 贡献 献是 是什 什么" hits=0`；`q="workflow patterns" tokens="workflow patterns" hits=5`。
- `agent.js:185` `const retrievalMiss = assetId ? hits.length === 0 : false;` + `:219` `noCitation: citations.length === 0,` → 一次中文提问同时得到 `retrievalMiss=true`、`noCitation=true`，前端还弹"本回答未引用原文段落（可能在文献中没有依据）"。

**影响**：对中文用户（主场景）这是**假阴性被当成事实**：上下文里 0 段原文，模型只能凭常识作答，而 UI 把"没命中"呈现为"文献里没有依据"。本机无 key ⇒ 100% 复现；有 key ⇒ 每轮多花一次 ≤100 token/≤3s 的改写调用（因为 F4 让决策永远 need=true，见下）。

**建议**：① 中文查询先做**中文→英文关键词**再进 FTS（把兜底从"0 命中后"提到"检索前"，或对 CJK 问题直接用 works 表 + 标题/贡献字段模糊匹配）；② `no-hit-no-rewrite` 与"无 key"在 meta 里区分成 `tokenizer-miss` / `no-key`，不要都落到 `retrievalMiss`；③ 给 `retrievalMiss` 前端文案加上"可能是分词不匹配"的兜底说明。

**effort**：M

---

### F2 · 引用校验只认"当前 asset"，而工具允许跨文献阅读：跨文献引用被静默丢弃、坐标碰撞会绑定无关段落

**现象**：`assembleCitations(assetId, anchors)` 用 `(asset_id, page_no, ord)` 三列精确回查，拿不到就 `continue`。但 tools 引擎的 `lit_search` 明确"跨全库、不按 asset 过滤"，`lit_read` 能用任意 `no` 读任意一篇；模型按工具返回的锚点写 `[p页#段]`，落到别的文献就 100% 丢。锚点串里**没有文献编号**，同一坐标在不同 asset 都真实存在，于是"校验通过"并不等于"引用的是那一篇"。

**证据**
- `03-code/server/services/chat/citations.js:18-23`：
  ```js
  const seg = get('SELECT id, text FROM segments WHERE asset_id = ? AND page_no = ? AND ord = ?', [
    Number(assetId),
    a.pageNo,
    a.ord,
  ]);
  if (!seg) continue; // 伪造/过期锚点：丢弃，不报错
  ```
- `03-code/server/services/chat/pipeline.js:319`：`const citations = assembleCitations(asset ? asset.id : null, parseCitations(assistantText));`（legacy 同款在 `agent.js:203-204`）
- `03-code/server/services/chat/tools/lit-search.js:48`：`const list = searchWorksAcross(q, { worksLimit: limit, perWork: 2 });`（工具描述自述"不是只在当前这篇里找"）
- 真实数据（DB 只读探针）：chat12 的 `msg42` 正文有 8 个锚点，落库只有 5 个，丢失 `p2#237`、`p27#31`；`segments` 里 `asset_id=10` 不存在这两个坐标（`p1#15` 则存在）。
- 同坐标跨库普遍存在：`(p1#15)` 在 asset 1/2/3 都有，文本分别是 "Autonomous agents have long been recognized as a p…" / "Risks: Lastly, AGI is viewed by some as a concept…" / "different platforms, different data formats, the c…"。

**影响**：① 跨文献引用在 UI 上**不存在**（前端只渲染落库 citations，`web/assets/chat.js:509` 那条"未引用"提示会与满篇 `[pN#M]` 自相矛盾）；② 锚点坐标碰撞时，`quote` 字段会取到**另一段毫不相干的原文**，用户点 chip 跳到错段落 —— 这是"看起来有引用其实指向别处"的假引用通道；③ 模型无从知道自己写的锚点被丢了，下一轮继续编。

**建议**：锚点格式升级为 `[no:p页#段]` 或 `[p页#段@no]`（`_resolve.anchor` 与 `CITATION_PATTERN` 同步改）；`assembleCitations` 接受 `{assetIdByWork}`，按锚点里的 no 查对应 asset；无 no 时回退当前 asset。丢弃时返回 `dropped[]` 并在 `done` 里带 `citationsDropped`，前端明确提示"2 处引用无法校验已隐藏"。

**effort**：M

---

### F3 · 默认引擎 legacy 静默丢弃用户上传的图片（前端每次都发）

**现象**：上传路由与引擎无关，前端 `sendMessage` 无条件带 `attachmentIds`；但 `postMessageLegacy` 只读 `body.content` 与 `body.selection`，`insertUserMessage(chat, content)` 也不传附件引用。用户贴图提问 → 图不进上下文、不进 DB、回看历史也看不到，全程零报错。

**证据**
- `03-code/web/assets/chat.js:449`：`attachmentIds: userAtts.map((a) => a.attachmentId),`
- `03-code/server/services/chat/agent.js:80-88`：
  ```js
  const content = String((body && body.content) || '').trim();
  if (!content) throw new AppError('E_BAD_REQUEST', '缺少 content', { field: 'content' });
  if (content.length > 4000) throw new AppError('E_BAD_REQUEST', 'content 超过 4000 字符', { field: 'content' });

  const selection = normalizeSelection(body && body.selection, asset);
  const history = loadHistory(chat.id);

  // 先落用户消息（即使后续失败也能看到自己问了什么）
  const userMsgId = insertUserMessage(chat, content);
  ```
- 对比 `pipeline.js:196`：`const userMsgId = insertUserMessage(chat, content, userAttachmentRefs);`
- `config.js` 默认 `chat.engine: 'legacy'`，且 DB `settings` 未覆盖 `chat.engine`（只有 `chat.rewriteFallback`、`chat.mockChunkDelayMs`）。
- DB：27 条 `messages.attachments <> '[]'` 的全部来自 tools 路径（每 chat 1 条），legacy 会话 0 条。

**影响**：用户明确付出的动作（上传/贴图）被静默忽略，回答看起来"像没看图"，且没有任何提示；同时历史里附件引用丢失 → 回看时图也不见了。这是"假成功"类体验缺陷，且默认配置下就是主路径。

**建议**：`postMessageLegacy` 里显式 `if (attachmentIds.length) throw new AppError('E_NOT_SUPPORTED', '当前引擎不支持图片，请切换 chat.engine=tools')`，或把 legacy 也接上 `resolveUserAttachments` + 注入一条带 `text` 摘要的提示；至少要在 `meta` 里回一个 `attachmentsIgnored: n` 让前端提示。前端也可在 `engine!=='tools'` 时禁用上传按钮。

**effort**：S

---

### F4 · 检索决策读的 `blocks` 字段根本不存在（meta 里叫 `blockIds`）⇒ 三条规则全部失效、决策解释恒为假

**现象**：`decideRetrieval` 第一步就是"没有块 ⇒ 必须检索"，而它拿到的 `lastMeta.blocks` 永远是 `undefined`（`buildContext` 写的是 `meta.blockIds`）。于是指纹打转检测、关键词命中率、`hits` 复用三条分支**永远走不到**，`retrieval.reason` 恒为 `'no-blocks'` 并被落库。

**证据**
- `03-code/server/services/chat/context.js:68`：`const meta = { truncated: [], blockIds: [], chars: {} };`；`:151` `meta.blockIds = blockList.map((x) => x.segmentId);`
- `03-code/server/services/chat/agent.js:153-158`：
  ```js
  const decision = decideRetrieval({
    query: selection && selection.text ? `${content} ${selection.text}` : content,
    blocks: lastMeta.blocks || [],
    fingerprint,
    lastFingerprint: lastMeta.fingerprint || null,
  });
  ```
- `03-code/server/services/chat/retrieval.js:131-133`：
  ```js
  if (!blocks || !blocks.length) return { need: true, reason: 'no-blocks' };
  if (fingerprint && fingerprint === lastFingerprint) {
  ```
- DB 实测 `context_meta` 顶层键 = `truncated,blockIds,chars,retrieval,fingerprint,hits`（无 `blocks`）；落库的 `retrieval.decision` = `"no-blocks"`。

**影响**：每一轮都重新检索（本可复用上轮 hits）；`same-fingerprint` 打转检测形同不存在（同一问题连问也重查）；`context_meta.retrieval.decision` 是**假诊断**，排查时会把"命中率规则生效"当成已工作。因为 always-retrieve，F1 的"0 命中→改写"就从兜底变成主路径。

**建议**：`buildContext` 同时写 `meta.blocks = blockList.map(x => ({ segmentId, pageNo, ord, text }))`（或让 `decideRetrieval` 改读 `blockIds.length` + 现取的片段），统一字段名并加一条断言测试；`decision.reason` 落库前做一次枚举校验。

**effort**：S

---

### F5 · 额度耗尽的提示措辞是"工具执行失败"，且每名工具的配额耗尽不置 exhausted ⇒ 模型反复重试到轮数用尽

**现象**：总量闸 `maxCalls`(8) 会置 `exhausted`，loop 于是强制收尾；但**每名工具的跨轮配额**（`maxCallsPerSession`）只返回一个 error 对象，不置 exhausted，而且"被拒绝的尝试不计入 calls/byName"。模型收到的内容是 `工具执行失败（name）：E_TOOL_QUOTA：…（开新会话可重置；或改用 lit_read 读文字）` —— 前缀是错误，后半句才是不让重试。下一轮它还可以再调同一个工具，直到 `maxRounds`(5) 用完。

**证据**
- `03-code/server/services/chat/registry.js:190-207`：
  ```js
  const perName = maxCallsPerName[name];
  if (Number.isFinite(perName)) {
    const used = Number(sessionCounts[name] || 0) + (byName[name] || 0);
    if (used >= perName) {
      return {
        ok: false,
        error: `E_TOOL_QUOTA：${name} 在本会话已用 ${used} 次，达到上限 ${perName} 次（开新会话可重置；或改用 lit_read 读文字）`,
  ```
  紧接 `:206-207` `calls += 1; byName[name] = (byName[name] || 0) + 1;` —— **只有通过配额检查才计数**。
- `03-code/server/services/chat/loop.js:118-122`：
  ```js
  messages.push({
    role: 'tool',
    tool_call_id: c.id,
    content: r.ok ? r.text : `工具执行失败（${c.name}）：${r.error}`,
  });
  ```
- 动态：per-name 上限 1 的工具第 2 次调用返回 `{"ok":false,"error":"E_TOOL_QUOTA：demo 在本会话已用 1 次，达到上限 1 次…","errorCode":"TOOL_QUOTA","ms":0}`，而 `stats = {"calls":1,"byName":{"demo":1},"exhausted":false}`。
- `03-code/server/services/chat/loop.js:144-150` 只有 `if (registry.stats().exhausted)` 才提前收尾；`:153-158` 轮数用尽再强制收尾。

**影响**：① 无效重试把上游请求数顶到上限（≤6 次）却不产出新信息，token 白烧；② 若模型把"失败"当可恢复错误（多数模型会），最坏情况是 5 轮里 4 轮都在撞同一堵墙；③ `done` 事件**不含** `quotaHit/roundsExhausted`（`pipeline.js:337-348`），用户和前端都不知道这轮是被额度截断的。

**建议**：把配额耗尽文案改成肯定式指令（"本会话对该工具的调用额度已用完，禁止再调用；请用已有结果作答"），并让 per-name 耗尽也置 `exhausted`（或返回 `errorCode:'QUOTA_LOCKED'` 且 loop 对该 code 直接 `call(false)` 收尾）；`done` 增加 `quotaHit / roundsExhausted / callsUsed`。

**effort**：S

---

### F6 · tools 引擎完全没有上下文预算；`contextChars` 把 base64 图片算成 0

**现象**：`context.js` 的六档预算只被 legacy 用；tools 引擎的 `buildToolMessages` 直接拼 system + 最近 4 轮全文 + 1600 字选区 + 本轮问题，**一行裁剪都没有**。而 `meta.contextChars` 的累加器只读 `p.text`，`image_url` part 没有 `text` 字段 ⇒ 每张内联 base64 图对预算贡献 0。循环里每一轮都把整份 `messages` 重新发给上游，图片也跟着重发。

**证据**
- `03-code/server/services/chat/pipeline.js:125-142`：
  ```js
  export function buildToolMessages({ work, history, content, selection, assetId, userImageAttachments }) {
  ...
    const turns = config.chat.historyTurns ?? 4;
    for (const m of lastTurns(history, turns)) {
      const text = String(m.content || '');
      if (!text.trim()) continue;
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
  ```
  （该函数内不存在任何 `budget/clip/slice` 预算调用；`assetId` 参数也未使用）
- `03-code/server/services/chat/pipeline.js:260-263`：
  ```js
  contextChars: messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.reduce((s, p) => s + (p.text ? p.text.length : 0), 0)),
    0,
  ),
  ```
- `03-code/server/services/chat/image-inject.js:77-86`：每张图 `{ type:'image_url', image_url:{ url: `data:${mediaType};base64,…` } }`，单张上限 `DEFAULT_MAX_INJECT_BYTES = 5MB`，每轮 `DEFAULT_MAX_INJECT_PER_TURN = 4`。
- 动态：`tools system (template+persona+meta) chars = 1353 (无任何裁剪)`；`budget = {"system":1200,"meta":600,"retrieve":3600,"selection":1600,"history":2400,"summary":400}`（后者只有 legacy 走）。

**影响**：① 4 张 5MB 图 = 20MB 原始 → ≈26.7MB base64 进 `messages`，且每轮重发一次（最坏 6 轮）；② 历史 4 轮无字符上限，长回答会把输入顶到几十 K token；③ `meta.contextChars` 严重低估真实体积，监控/设置页拿到的数是假的。（本机无 key、`injectImages` 虽默认 true 但 `lit_page_image` 未注册，所以现实中还没爆；一旦开视觉通道即触发。）

**建议**：把 `context.js` 的 `budget()/clip()/buildBlocks()` 抽成两引擎共用，tools 侧对 system/history/selection 各设上限；`contextChars` 改为按 provider 口径估算（图片按 `width*height/750` 或固定 1600 token 计），并另出一个 `payloadBytes` 字段；`image-inject` 增加"每轮总字节上限"（如 6MB）而非只限张数。

**effort**：M

---

### F7 · 长选区时"用户选中的原文"被裁到 8%，邻段反而完整保留，且用户无感知

**现象**：选区 body 的拼接顺序是「邻段在前、`【用户选中的原文】`在后」，而裁剪是 `clip(body, 800)` 从头截断 —— 先被吃掉的是用户真正选中的内容。

**证据**
- `03-code/server/services/chat/context.js:107-117`：
  ```js
  const body = [
    ctx.length ? ctx.map((s) => wrapSegmentBlock({ pageNo: s.pageNo, ord: s.ord, text: s.text, dst: s.textDst || null })).join('\n\n') : '',
    `【用户选中的原文】\n${clip(selection.text || '', b.selection).text}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  selectionText = body;
  if (len(selectionText) > b.selection) {
    selectionText = clip(selectionText, Math.min(800, b.selection)).text;
    meta.truncated.push('selection-to-800');
  }
  ```
- 动态（真实 `buildContext`，输入 2000 字选中 + 900 字邻段）：`truncated=["selection-to-800"]`，`用户问题仍在? true | 选中原文仍在? true | 选中原文 S 片段只剩 165 字`。
- `meta.truncated` 只落 `context_meta`，前端 chat.js 不读它（grep 无 `truncated` 消费点）。

**影响**：用户"高亮这段提问"的产品承诺在长选区下失效：模型看到 8% 的选中内容 + 100% 的邻段，容易答成"你选的那段大意是…"式的臆测；而 UI 没有任何"你的选区被截断"的提示。这正是任务里问的"贴图 + 长问题会不会把当前问题挤掉"的一半答案：**问题不会被裁（超 4000 字直接拒），但选区会被裁且不告知**。

**建议**：拼接顺序改为「`【用户选中的原文】`在前、邻段在后」，让裁剪先牺牲邻段；或对选中部分单独保底（如 `min(selection, 800)` 优先满足，邻段用剩余额度）；`done` 事件透出 `truncated` 让前端显示"选区已截断为 800 字"。

**effort**：S

---

### F8 · 工具契约：声明期校验很严，执行期不校验入参；`lit_read` 的"单段不封顶"使 maxChars 可被一段撑破

**现象**：`defineTool` 会拦缺 render、非法参数类型（动态验证：`缺 render => E_INTERNAL`、`非法类型 => E_INTERNAL`），但 `run()` **完全不校验 args**：`{n:[1,2,3], extra:'x'}` 原样进入 execute，缺 required 也照跑。工具层靠各自的 `clampInt/String` 自保；`lit_read` 的截断条件还带 `&& segments.length`，第一段无论多长都整段塞进返回。

**证据**
- `03-code/server/services/chat/registry.js:210`：`const value = await withTimeout(tool.execute(args || {}, ctx), tool.timeoutMs);`（`run()` 内没有任何 `assertArgs/validateInput`）
- 动态：`execute 收到的 args = {"n":[1,2,3],"extra":"x"}` → `{"ok":true,…}`；`execute 收到的 args = {}`（缺 required 也放行）
- `03-code/server/services/chat/tools/lit-read.js:63-69`：
  ```js
  if (totalChars + text.length > maxChars && segments.length) {
    truncated = true;
    break;
  }
  segments.push({ pageNo: r.pageNo, ord: r.ord, text, isHeading: Boolean(r.isHeading) });
  totalChars += text.length;
  ```
- 同处 `:49-55` 的 SQL 无 `LIMIT`（`WHERE asset_id = ? AND page_no BETWEEN ? AND ?`），一次最多拉 853 段（asset 10）。

**影响**：① 工具入参契约只靠"每个工具自己记得 clamp"，新增工具（尤其 `lit_page_image` 的 `rect` 数组）很容易漏；② `lit_read` 在被要求 `maxChars=200` 时仍可能返回 918 字（DB `seg_max_len=918`），"truncated" 标记与实际体积不符，模型的上下文预算被单段击穿；③ 全页区间无 LIMIT，是"读整篇"变成一次大查询的入口（今天 5947 段总量还能扛）。

**建议**：`registry.run` 增加轻量入参校验（type 存在性/required/多余键 warn），把 `additionalProperties:false` 的承诺在服务端也落实；`lit_read` 改 `if (totalChars + text.length > maxChars && segments.length) break;` 为"单段超预算时按字符切片再入队"，SQL 加 `LIMIT Math.ceil(maxChars/50)+8`。

**effort**：S

---

### F9 · `lit_update_note` 写 `works.note` 不写 `fields_locked`，下次重导入会被 CSV 覆盖（违反不变量⑤）

**现象**：写入语句只改 `note` 与 `updated_at`，不动字段级锁；而 importer 的设计是"PATCH 改过的字段才跳过"。模型写进去的备注在下一次导入时会被源数据覆盖（若源有该字段）或直接丢失，且没有任何提示。

**证据**
- `03-code/server/services/chat/tools/lit-update-note.js:59`：`run('UPDATE works SET note = ?, updated_at = ? WHERE id = ?', [note, now, work.id]);`
- `03-code/server/services/artworks.js:321/374`（对比：人工 PATCH 会加锁）：`sets.push('fields_locked = ?')`
- `03-code/server/services/importer.js:268`：`const locked = parseLocked(existing.fields_locked);`
- grep 结论：`fields_locked` 在 `lit-update-note.js` 中**零出现**。

**影响**：模型归因的"贡献定位"是这轮对话最有价值的产出，却可能在下次批量导入时静默消失；违反 `_context.md` 不变量⑤（字段级锁）。今天 `allowWrite=false` 使此路径不可达，属于"一开写就会踩"的坑。

**建议**：写入时 `UPDATE works SET note = ?, fields_locked = ?, updated_at = ?`，把 `note` 并入既有锁集合（复用 artworks.js 的 `parseLocked`）；同时给 `lit_update_note` 的 render 回显"已锁定字段 note，重导入将跳过"。

**effort**：S

---

### F10 · P3 视觉通道"后端建好、用户看不到"：注册条件短路、依赖未安装、前后端零引用

**现象**：`pageImage.enabled` 默认 false ⇒ `registerPageImage()` 直接返回未注册；即便打开，本机也没装 playwright，`getSharedRenderer()` 返回 `E_RENDERER_UNAVAILABLE`（且该错误被记忆，不再重试）；routes 与 web 里 grep 不到任何 `pageImage|lit_page_image|PAGE_IMAGE` 引用。

**证据**
- `03-code/server/services/chat/tools/index.js:41`：`if (cfg.enabled !== true) return { registered: false, reason: 'chat.pageImage.enabled 不是 true（默认关闭）' };`
- `tools/index.js:67`：`export const PAGE_IMAGE_STATUS = registerPageImage();`（模块加载期一次性决定，之后模型永远看不到这个工具）
- 动态：`getSharedRenderer => NULL, code=E_RENDERER_UNAVAILABLE | lit_page_image 未找到 playwright：视觉通道依赖 playwright（本项目**不新增**这个依赖）…`；`require.resolve('playwright')` → `MODULE_NOT_FOUND`；`package.json` 依赖只有 `express` + `pdfjs-dist`。
- grep：`server/routes/*.js` 与 `web/assets/*.js` 对 `pageImage|page-image|lit_page_image|pageImageStatus|PAGE_IMAGE` **零命中**；`routes/layout.js` 是 AI 精排（`POST /api/works/:no/layout`），不 import `render/page-image-source`。

**影响**：`page-image-source.js`(675) + `render-geometry.js`(125) + `lit-page-image.js`(152) + `image-inject.js`(108) ≈ 1060 行是**当前不可达的代码**：用户侧唯一入口（chat 上传图）又被 F3 丢掉，视觉能力整体为 0。判定为技术债而非功能：它不能算"做完了"，也不能算"用户能用的功能"，只能是"设计+单测完成、产品未接线的半成品"。资源上限设计是合格的一半（`planRender` 双约束取小、`clampMaxEdge` 600–2048，实测 A4@1500 → 1059×1500/1.59MPx），但因为没有真实调用，超时/并发/内存行为全部未验证。

**建议**：二选一明确表态 ——（A）宣告 P3 冻结：把 `page-image-source.js` 移到 `server/vendor/` 或标 `@experimental`，README/STATUS 写明"未接线，勿用"；（B）补一条真实入口（`GET /api/works/:no/pages/:pageNo.png` 或 reader 侧"看版面"按钮）+ 在 `devDependencies` 里写清 playwright 可选依赖与安装开关。当前状态最糟：代码在主线、配置默认关、文档不说明。

**effort**：L（接线）/ S（冻结声明）

---

### F11 · 附件对象只有写没有删：`deleteChat` 不回收对象，全仓无任何 GC

**现象**：内容寻址落盘（`objects/<前2位>/<sha>` + `.meta.json` 侧车）是幂等写；但删除会话只 `DELETE FROM chats`，对象与侧车永久保留，`attachments.js` 里没有任何删除/GC 函数。

**证据**
- `03-code/server/services/chat/attachments.js:196`：`if (!fs.existsSync(file)) fs.writeFileSync(file, buf);`（`:230` 同款），文件末尾 `:259-261` 只有 `attachmentsDir()`
- `03-code/server/services/chat/session.js:112-114`：
  ```js
  export function deleteChat(chatId) {
    const { chat } = loadChat(chatId);
    run('DELETE FROM chats WHERE id = ?', [chat.id]);
  ```
- grep `unlink|rmSync|fs.rm|gc` 在 `attachments.js/session.js/pipeline.js` 零命中；全 `server/**` 也没有 `unlinkSync` 命中。
- 现状：`03-code/data/attachments` = 17 文件 / 5 侧车 / 12 对象 / 2,141,658 字节。

**影响**：上传上限 10MB/条、每消息 4 个 ⇒ 磁盘无界增长；用户删会话后文件仍留在磁盘（虽然回源路由依赖 chat 存在，拿不到 URL，但隐私数据未回收）。属于数据生命周期缺口，今天量小（2.1MB）。

**建议**：建 `attachments.gc.js`：按 `messages.attachments` 引用计数（JSON 列）扫孤儿，提供 `POST /api/admin/attachments/gc?dryRun=1`；`deleteChat` 后触发一次"仅当引用计数为 0 才删"的回收。

**effort**：M

## 关键问答（任务书 8 个问题的直接结论）

**1. 职责切分 / 谁管什么 / 谁是门面**
`agent.js`(328) = **门面 + legacy 实现**：`:44` 把 `session/citations/prompts` 的实现直接 re-export，`:47-50` `activeEngine()`，`:59-62` 二选一分派，`routes/chat.js:17` 是它唯一消费者。`pipeline.js`(380) = tools 引擎的 SSE 编排（meta→tool→tool_result→delta→image→citation→done + 附件解析）。`loop.js`(159) = 纯回合机，不碰 HTTP/DB。`session.js`(235) = **唯一落库层**（+`countToolCalls` 这种给 registry 的跨轮配额投影）。职责本身不重叠，重叠的是"实现"：落库时机、引用装配、done 字段、SSE 头/心跳/abort 各写两遍（见上表）；"消息落库"这个概念出现在 2 个文件（session 定义、agent+pipeline 调用），但**时序**在 3 处（agent:88、pipeline:196、pipeline:361 错误分支）。

**2. 循环边界 / 三处额度 / 上限时模型看到什么**
三处额度**不会互相绕过**（各自独立判断），但边界语义不一致：`maxRounds`=5（`:39`）是唯一硬闸，上游请求 ≤6；`maxCalls`=8（registry）一旦达到会置 `exhausted`，loop 在 `:144-150` 提前收尾；`maxCallsPerName`（跨会话配额）**只返回错误、不置 exhausted**，且 `calls/byName` 只在通过检查后才自增（`registry.js:206-207`）⇒ 被拒的尝试免费，模型可以在剩下的每一轮继续重试同一工具，直到轮数耗尽。达到上限时模型收到的是**"错误"而不是"可继续的提示"**：`工具执行失败（name）：E_TOOL_QUOTA：…请直接用已有信息作答`（`loop.js:121`），前缀是错误语义，天然诱发重试。`noCitation` 与 `retrievalMiss` **都不在 loop 里**：`noCitation` 是 SSE `done` 字段，`agent.js:219` / `pipeline.js:343` 由 `citations.length === 0` 算出（只反映"落库后剩几个"，不区分"没引用"和"引用了被丢弃"）；`retrievalMiss` 在 `agent.js:185` 由 `hits.length === 0` 算出，tools 引擎**恒为 false**（`pipeline.js:346`）。

**3. 工具契约（defineTool / 6 个工具 / SQL 注入 / 体积 / 几何上限）**
`defineTool` 声明期很严：缺 `name/description/execute/render` 抛 `E_INTERNAL`，参数类型不在 `string|number|boolean|object|array` 抛 `E_INTERNAL`，投影时 `additionalProperties:false`；`timeoutMs` 非有限数 ⇒ `null`（动态：`timeoutMs 默认 = null`，6 个工具里只有 `lit_page_image` 声明了 8000ms）。但 `run()` **不校验入参**（`{n:[1,2,3],extra:'x'}` 与缺 required 都放行到 execute），`validateOutput` 只查 type/required/min-max，不查长度与枚举。6 个工具入参到 DB 全走 `?` 参数化（`_resolve.js`、`lit-read.js:49-55`、`fts.js` 的 MATCH 表达式还把 token 全引号包裹并转义双引号）⇒ **无 SQL/FTS 注入面**；`_resolve.resolveWork` 找不到编号时抛友好提示。体积：`lit_search` 每篇 1-3 段×160 字、`lit_read`/`lit_translation` 有 maxChars（200–20000，默认 6000，但 F8 的单段击穿问题）、`lit_page_image` 输出是对象引用不是字节。几何：`planRender` 用 `Math.min(maxEdge/最长边, sqrt(maxPixels/面积))` 双约束取小，`clampMaxEdge` 夹 [600,2048]，实测 A4@1500→1059×1500/1.59MPx、超大画布→1500×1000/1.5MPx、极小画布→1284×1284/1.65MPx，非法 rect 在渲染前抛；渲染器本身单飞串行 + 缓存 8 + doc 登记 4 + 5min idle + `withDeadline` 超时 teardown ⇒ **资源上限在几何与并发两侧都有**，唯一缺口是 `maxPixels` 无独立夹取（被 maxEdge 间接封在 ~4.2MPx）。

**4. 上下文预算（会不会把图/当前问题挤掉）**
预算只服务 legacy（tools 引擎零预算，F6）。裁剪顺序：检索块尾 → 检索块 clip → 历史缩 2 轮 → 历史 clip → 选区 `clip(body, 800)` → 仍超（`tailLen > selection+retrieve`）才 `E_BAD_REQUEST`。**"system 与当前问题永不裁"成立**：system 是 `clip(TEMPLATE, 1200)`=289 字（模板实测 289，永不裁），问题是超 4000 字直接拒绝而非截断（`context.js:120-123`）。"用户贴了图 + 长问题"的实际答案是：legacy 根本收不到图（F3），所以挤不掉；tools 引擎图以 content parts 挂在 user 尾部、不参与任何预算（所以也挤不掉，但会顶爆上下文）。真正被挤掉的是**用户选中的原文**：长选区时 body 先填 600 字邻段，`clip(...,800)` 从头切 ⇒ 选中的 2000 字只剩 165 字（F7），且 `meta.truncated` 不推给前端。

**5. 检索决策（双索引 / 取优侧 / hitLang / 改写兜底 / 误报率）**
`retrieve()` 只调 `search(assetId)` → `searchSegments`，**不是 segments + works 双索引**（`retrieval.js:41` 注释说的"双索引"容易误读；真正的"双索引"在 `fts.js:223-231`，是**原文索引 + 译文索引**两路）。取优侧：`mergeHits` 按 segmentId 去重、`if (h.score <= cur.score)` 保留更小的 bm25（更相关），再 slice(topK)。`hitLang` 是 `'src'|'dst'` 的**命中侧标记**（原文命中/译文命中），不是"抖动"。改写兜底条件：`rewriteFallback !== false` + `hasCjk` + 首次 0 命中 ⇒ 一次 `maxTokens:100 / temperature:0 / timeoutMs:3000 / retry:false` 的调用，再检索一次，仍 0 就返回 0（"不许编"），无 per-chat 限流/熔断。"0 命中就改写"的误报风险在这里**不是风险而是常态**：中文 bigram 打不中英文正文（F1 实测 0 命中），加上决策器恒 `need=true`（F4），于是**每一次中文提问都会触发一次改写模型调用**——兜底变主路径，每轮多一次 3s/100token 开销；而 mock/无 key 时改写直接返回空，兜底彻底失效。真正的误报还有一种：改写出来的关键词可能完全跑偏（`'workflow orchestration multi-agent agent'` 这种泛词），命中虽然非 0 但与问题无关，`retrievalMiss=false` 会让用户以为"检索到了依据"。

**6. 引用真实性（回查 DB？）**
**回查了**，不是只解析正则：`citations.js:18-23` 用 `SELECT id, text FROM segments WHERE asset_id=? AND page_no=? AND ord=?` 逐条验真，查不到就 `continue`（不报错）。所以"编一个不存在的 `[p9#99]`"不会出现在 citations 里、也不会被前端渲染成 chip（`web/assets/chat.js:549` 明确"客户端不自己解析锚点"）。但有三处让真实性打折：① 只保证"该段存在且属于**当前这篇**"，不保证"该段出现在本轮给模型的上下文里"（模型可以引用它没读过的段）；② 跨文献引用一律被丢（F2），正文 `[pN#M]` 仍在；③ `stale` 字段恒 `false`（`citations.js:29`），没有任何"过期/已重抽"检测 —— 资产重抽后 segmentId 变了，旧引用不会失效。**结论：防的是"纯幻觉锚点"，防不住"错文献/错上下文锚点"。**

**7. 附件链路（命名 / 侧车 / 清理 / readImageSize / data URI 体积）**
内容寻址：`sha256` 全 hex，`objects/<前2位>/<sha>`，`img_<sha>` / `file_<sha>` 两种前缀；侧车 `<object>.meta.json`（mediaType/width/height/bytes），写失败静默（`writeMeta` 吞异常）；读侧车失败回退 magic 嗅探。`readImageSize` 手写 PNG(IHDR)/JPEG(扫 SOF)/WebP(VP8X/VP8/VP8L) 解析，**畸形输入一律返回 null 不抛**（实测：PNG 1×1→`{"width":1,"height":1}`；JPEG 垃圾 40B、JPEG 段长 0xffff、2 字节、截断 12B PNG → 全部 `null`）。清理：**只有写没有删**（F11）——`deleteChat` 不回收对象，全仓无 `unlink/gc`。data URI 注入：`data:<mediaType>;base64,<...>` 内联进 user message，单张 ≤5MB、每轮 ≤4 张 ⇒ 最坏 ≈26.7MB base64/轮，且每轮重发（F6），`contextChars` 计 0。

**8. 半成品判定（P3 视觉通道）**
**是"后端建好但用户看不到"**：`chat.pageImage.enabled` 默认 false ⇒ `registerPageImage()` 在模块加载期就返回 `{registered:false}`；即使打开，本机 `playwright` 未安装（`MODULE_NOT_FOUND`），`getSharedRenderer()` 返回 `E_RENDERER_UNAVAILABLE` 且被缓存不再重试；routes 与 web 对 `pageImage/lit_page_image/PAGE_IMAGE` **零命中**，`routes/layout.js` 是 AI 精排（`POST /api/works/:no/layout`）与页面图无关。⇒ 1060 行（675+125+152+108）在当前配置下不可达，算**技术债**（设计+单测完成、产品未接线），不算功能。判定依据不是"代码质量"，而是"用户路径上没有任何入口"。

## 覆盖与盲区

- **零真实 LLM 调用**：全仓无 provider key，`runMockOrReal`/改写兜底只能走 mock 分支（`rewriteToEnglishKeywords` 返回固定英文关键词）。所以"上游对 26MB base64、连续 user 消息（图注入在 tool 消息之后）、tool_call 交错的实际反应"全部未验证 —— 这直接限制 F6 与 F8 的严重度判断（我按"代码可达即缺陷"评，不按"已复现故障"评）。
- **27 条孤儿用户消息**：`chats 13–17, 19–40`（共 27 个 chat，缺 18）各只有 1 条"请看这张图"用户消息 + 0 条 assistant 回复，`asset_id` 全为 `null`、`work_id` 全为 1，内容全是同一个 `file_a4bcd7b80c65e14e3809783fc4c587ce66a995dcc142e25bf61c9337ef6f3443`（1×1 PNG，70B）。当前代码顺序是"先校验附件、再落用户消息"（`pipeline.js:188-196`），且 `asset_id=null` 的 chat 无法走 legacy 的检索分支 —— 复现不出这个状态，判断为修复前代码的历史残留 + 测试脚本产物；**未证实**，不计入 findings。
- **未读 02-design**：`architecture` 194KB 里关于 M4/dsh 重构的章节没读，无法核对"三处额度映射自 dsh 的哪个机制""引用校验只按 asset 是否既定设计"。相关判断只基于代码与注释自述。
- **前端只做了 grep 级核对**（`chat.js` 的 `attachmentIds`、citations chip、`noCitation` 文案、image 事件），未逐行审 SSE 状态机；前端完整评审属另一轮范围。
- **未审 `services/llm/client.js`**：loop 的超时/重试/流式解析依赖它；registry 的 `withTimeout` 不取消底层 Promise —— 若 client 自身没有 abort 传播，超时后渲染/请求可能继续跑（`page-image-source.js:551-557` 的 `withDeadline` 有 teardown，tool 层没有）。
- **未跑渲染 E2E**：playwright 未安装，`page-image-source.js` 的 675 行只做了静态审查 + 几何纯函数动态验证。
- **`chat.attachments.maxInjectBytes/maxInjectPerTurn` 这两个键在 config 里不存在**（默认值在 `chat.pageImage` 下），`pipeline.js:156-157` 读的是前者 ⇒ 用户上传图的注入上限实际落到 `buildUserContent` 的硬编码默认值，无法通过配置调。归到 coverage，不算独立 finding（与 F6 同源）。

## 动态验证记录

### 1) 服务存活（只读）
```
PS> curl.exe -s http://127.0.0.1:7317/api/health
{"ok":true,"version":"1.0.0-m1","dbDriver":"node:sqlite","dbPath":"D:\\A-knowledge\\agent工作流优化\\03-code\\data\\app.db","works":424,…}
```

### 2) 上下文预算 / 选裁剪 / 工具配额 / 几何 / 渲染器（import 真实模块，只读）
脚本：`%TEMP%\a12dyn.mjs`，在 `03-code/server` 下 `node a12dyn.mjs`：
```
[1] CHAT_SYSTEM_TEMPLATE chars = 289 / budget.system = 1200
[1b] tools system (template+persona+meta) chars = 1353 (无任何裁剪)
[1c] budget = {"system":1200,"meta":600,"retrieve":3600,"selection":1600,"history":2400,"summary":400}
[2] truncated = ["selection-to-800"] chars = {"system":289,"meta":55,"blocks":625,"summary":12,"history":9,"selection":800,"question":307,"totalInput":2116}
[2b] 用户问题仍在?  true | 选中原文仍在?  true | 选中原文 S 片段是否只剩少量: 165
[3] 3990 字问题 + 1600 字选区：未拒绝
[4] run#1 = {"ok":true,"value":{"ok":true},"text":"ok","ms":0}
[4b] run#2(超 per-name 配额) = {"ok":false,"error":"E_TOOL_QUOTA：demo 在本会话已用 1 次，达到上限 1 次（开新会话可重置；或改用 lit_read 读文字）","errorCode":"TOOL_QUOTA","ms":0}
[4c] stats = {"calls":1,"byName":{"demo":1},"exhausted":false}
[5] timeoutMs 默认 = null
[6] vp {"width":595,"height":842} => scale 1.781 out 1059x1500 px 1588500
[6] vp {"width":6000,"height":4000} => scale 0.250 out 1500x1000 px 1500000
[6] vp {"width":100,"height":100} => scale 12.845 out 1284x1284 px 1648656
[6b] 非法 rect: invalid region rect: degenerate: [0,0,0,1]（要求 [x0,y0,x1,y1]，
[7] getSharedRenderer => NULL, code=E_RENDERER_UNAVAILABLE | lit_page_image 未找到 playwright：视觉通道依赖 playwright（本项目**不新增**这个依赖）…
```
（`[2b]` 的 165 = 2000 字选中里活下来的字符数；`[4c]` 是 F5 的直接证据：per-name 封死但 `exhausted` 仍 false。）

### 3) registry 契约（import 真实 registry）
```
node --input-type=module -e "..."
缺 render => E_INTERNAL 工具 x 缺少 render
非法类型 => E_INTERNAL 工具 y 的参数 a 类型非法：date
execute 收到的 args = {"n":[1,2,3],"extra":"x"}
传非法入参 n=[1,2,3] => {"ok":true,"value":{"ok":true},"text":"ok","ms":0}
execute 收到的 args = {}
不传 required n => {"ok":true,"value":{"ok":true},"text":"ok","ms":0}
```

### 4) 中文查询 vs 英文正文的 FTS 命中（复刻 toFtsText + 真实 FTS 表，只读）
```
q="这篇论文的贡献是什么"  tokens="这篇 篇论 论文 文的 的贡 贡献 献是 是什 什么"  hits=0
q="workflow patterns"  tokens="workflow patterns"  hits=5
q="作者提出了什么方法"  tokens="作者 者提 提出 出了 了什 什么 么方 方法"  hits=0
q="control flow perspective"  tokens="control flow perspective"  hits=4
```
（F1 的直接证据；同样的查询词换成英文立刻命中。）

### 5) DB 只读探针：引用真实性 / 元数据体积
```
[1] context_meta 体积 {"n":69,"tot":60175,"mx":8027}
msg14 chat2 assistant citations=104B context_meta=8027B
最大 contextMeta 顶层键 = truncated,blockIds,chars,retrieval,fingerprint,hits
其中 hits 段数 = 12  hits 字数 = 2955
其中 retrieval.decision = {"hits":24,…,"decision":"no-blocks","fingerprint":"1755a7f365a2c3fd","hitLangs":["dst","src",…]}

[2] 引用真实性：assistant 正文锚点 vs 落库 citations
msg42 chat12 锚点=8 落库=5 丢=p2#237,p27#31
   正文: 我先检索文献库，并读取 2.4 的正文。…贡献定位为系统归纳 20 种控制流模式 [p1#15]。…
assistant 含锚点消息=17 / assistant 共 21；有锚点未落库=1

[3] 落库分布 citations 非空 = 17 / attachments 非空 = 27 / tool_calls 非空 = 2
```
```
[1] chat12 = {"id":12,"work_id":23,"asset_id":10}  work = {"no":"2.4","title":"Workflow Patterns"}
[2] 本文 asset 10 中 (p2#237) => 不存在（会被丢弃）
[2] 本文 asset 10 中 (p27#31) => 不存在（会被丢弃）
[2] 本文 asset 10 中 (p1#15) => 存在 seg82826: In this context, patterns address business requirements in a
        其他 asset 1 同坐标 => Autonomous agents have long been recognized as a p
        其他 asset 2 同坐标 => Risks: Lastly, AGI is viewed by some as a concept
```
```
works=424 assets=14 segments=5947 | seg_max_len=918 | seg_gt_6000=0
chats=39 messages=68 | msgs_with_tool_calls=2
settings 只有 chat.rewriteFallback=true, chat.mockChunkDelayMs=260（未覆盖 chat.engine）
context_meta.engine 分布 null:63 / tools:5
attachments<>'[]' = 27 条，全部 role=user、chat 13..40（缺 18）、asset_id=null、content 长度 5
```

### 6) 视觉通道依赖与接线（grep + resolve）
```
PS> node -e "require.resolve('playwright')"
playwright resolve FAILED: MODULE_NOT_FOUND

PS> Select-String -Path "server\routes\*.js","web\assets\*.js" -Pattern "pageImage|page-image|lit_page_image|pageImageStatus|PAGE_IMAGE"
(空=无命中)

PS> Select-String -Path "server\routes\*.js","index.js" -Pattern "services/chat/(agent|pipeline)"
chat.js:17: } from '../services/chat/agent.js';
```
（`agent.js` 是唯一入口；`pipeline.js` 只能经 `agent.js:59` 的 `activeEngine()` 到达。）

### 7) 附件删除路径（grep）
```
PS> Select-String -Path "services\chat\attachments.js","services\chat\session.js","services\chat\pipeline.js" -Pattern "unlink|rmSync|fs\.rm|deleteAttachment|gc"
(空=无命中)
PS> Select-String -Path "**\*.js" -Pattern "objects.*unlink|unlinkSync" -List
(空=无命中)
```

### 8) 规模/覆盖统计
```
chat/ 文件数: 23  chat/ 总行数: 3263（非空行）  chat/ 总字节: 157413
03-code/package.json dependencies = {"express":"^4.22.3","pdfjs-dist":"^6.4.299"}
测试对 chat 的 import：attachments-multimodal / context / page-image-inject / tool-registry / citation（只 import prompts.js）/ chat-summary（只 import agent.maybeCompressSummary）
⇒ citations.js(assembleCitations)、retrieval.js、pipeline.postMessageTools、tools/lit-*.js 无任何测试
```

### 9) `readImageSize` 容错（import 真实 attachments.js，喂畸形输入）
```
png-1x1 => {"width":1,"height":1}
jpeg-垃圾40B => null
jpeg-段长0xffff => null
2B => null
png-截断12B => null
sniff 空 buffer 长度 2: "application/octet-stream"
```
⇒ 手写解析对截断/垃圾输入是安全的（返回 null，不抛）；唯一小瑕疵是 `sniffMediaType` 要求 ≥4 字节，极短的伪图片会落到 `application/octet-stream`。
