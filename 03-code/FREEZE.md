# 冻结清单（FREEZE）· v2

> 冻结时间：2026-10-31T05:52:09.211Z
> 冻结范围：`03-code/server/**`、`03-code/web/**`、`03-code/userscript/**`、`data/app.db`。
> **v2 变更**：新增「浏览器直传」——`GET /api/works/lookup`（works.js / artworks.js）与 `userscript/lit-uploader.user.js` + `userscript/README.md`。测试工程师因限流中断期间由主理人直接实施，**未经独立验证**，已纳入下一轮验收。
>
> **v5 变更（2026-11-03，多模态输入/输出 + persona 语气/Markdown）**：以下 13 个文件的哈希**取代 §2 及 v3/v4 节中同名行的旧值**（本节优先）。
> 改动内容：① 用户上传图片/文件 → 内容寻址落盘 + `.meta.json` 侧车（`attachments.js` 泛化 `file_`/`img_` 前缀、`sniffMediaType`、`readImageSize`、`readAttachmentMeta`）；
> `POST /api/chats/:id/attachments` 上传（multipart/裸体）与 `GET .../:attId?dl=1` 下载（`routes/chat.js`）；`config.chat.attachments` 上限组（`config.js`）；
> security 的 Content-Type 白名单与 `express.raw(type)` 对齐（裸体 image/pdf/text 在 `/attachments` 放行，`middleware/security.js`）；
> 新增错误码 `E_UNSUPPORTED`（415，`errors.js`）；用户图以 data URI `image_url` 注入 user 消息尾部（`pipeline.js`）；`insertUserMessage` 写 `attachments` 列（`session.js`）；
> persona 加「不要自报流程」+「表达与排版」Markdown 纪律（`persona/lit-research.js`）；前端 📎 + 待发 chips + 图片放大/下载 + 文件卡片（`reader.html`/`chat.js`/`reader.css`）。
> **修复（致命）**：`routes/chat.js` 的 `loadChat` 误从 `agent.js` 导入（该模块仅引入未 re-export）——整条 chat 路由加载即失败、`createApp()` 崩溃、服务无法启动；改从 `session.js` 导入。
> **修复（功能）**：前端 `chat.js` 纯图发送被 `if(!content)return` 阻断；`appendUserAttachments` 在气泡未挂载时访问 `parentElement`（null）抛错；用户/助手附件渲染重复。
> 验证：单测 **136/136**；真实 E2E `04-test/e2e-multimodal-upload.mjs` A1/A2/B1/B2 全过；**HTTP 路由冒烟 `04-test/smoke-attachments-http.mjs` 11/11 PASS**（multipart/裸体上传、inline、?dl=1、415/413、纯图发送落库、404）。
>
> | sha256[:16] | bytes | file |
> |---|---|---|
> | 072f195b8283e0db | 9839 | server\services\chat\attachments.js |
> | a383640904d54525 | 13873 | server\config.js |
> | a1810688471aa99f | 3336 | server\app.js |
> | f093e8601401e245 | 7096 | server\routes\chat.js |
> | cea015809aa15697 | 14656 | server\services\chat\pipeline.js |
> | facfc2e5db100341 | 9794 | server\services\chat\session.js |
> | 3009d74d15048493 | 4159 | server\services\chat\persona\lit-research.js |
> | 6e16da034021c644 | 2628 | server\errors.js |
> | 32453afd8d87426d | 5868 | server\middleware\security.js |
> | 839836f81f1ffd7a | 6632 | server\test\attachments-multimodal.test.js（新增） |
> | 98eca6731087480f | 7213 | web\reader.html |
> | 2d10aaf8a15ec4db | 27925 | web\assets\chat.js |
> | 0ea42cc8a1470871 | 21102 | web\assets\reader.css |
>
> **v4 变更（2026-11-02，对话 agent 参照 dsh 重构为工具引擎）**：以下 21 个文件的哈希**取代 §2 与 v3 节中同名行的旧值**（本节优先）。
> 改动内容：`agent.js` 拆为 session/citations/runtime/registry/loop/pipeline（参照 dsh 的 seam 范式）；
> 新增 tools 引擎（`config.chat.engine='tools'`，`config.local.json` 已启用）与 3 个工具（lit_search 跨库 / lit_read / lit_translation，
> 契约与 dsh-impl litagent 的 lit-*.ts 对齐）；`llm/client.js` 流式补 tools/tool_calls 解析；`fts.js` 新增 `searchWorksAcross` 全库检索；
> schema **v3**：messages 加 `tool_calls`/`attachments` 两列（迁移已执行，备份 `data/backup/app-20261102-v2.db`）；
> `prompts.js` 新增 TOOLS_SYSTEM_TEMPLATE；前端 `chat.js`/`reader.css` 增加工具卡片（`tool`/`tool_result` 事件渲染）；
> 新增装配探针 `server/cli/verify-agent.js`。**legacy 引擎原样保留**（`engine:'legacy'` 一键回退）。
> 验证：单测 107/107 PASS；verify-agent 6/6 PASS；API 端到端（tools 引擎：3 次工具调用、4 条合法引用、5.7s）；
> 真实 Chromium UI 端到端（工具卡片、Markdown、引用 chip、按钮复位、零控制台错误）。
>
> | sha256[:16] | bytes | file |
> |---|---|---|
> | be6c77fa91f88056 | 14351 | server\services\chat\agent.js |
> | d55191f35d26ec67 | 7946 | server\services\chat\pipeline.js（新增） |
> | de9f87e9a755a772 | 4706 | server\services\chat\loop.js（新增） |
> | 9a53b4626d4e6e54 | 4981 | server\services\chat\registry.js（新增） |
> | 1c3c3bd993fdc3e9 | 8855 | server\services\chat\session.js（新增） |
> | afc97c97f5f40237 | 1107 | server\services\chat\citations.js（新增） |
> | 262650f852d07dc7 | 538 | server\services\chat\runtime.js（新增） |
> | b23a007d228267da | 5997 | server\services\chat\prompts.js |
> | cd1b1f09ad1395f1 | 1050 | server\services\chat\tools\index.js（新增） |
> | 2a96f06954b4afd5 | 3137 | server\services\chat\tools\lit-search.js（新增） |
> | 97049cb2f963cf23 | 3857 | server\services\chat\tools\lit-read.js（新增） |
> | d31316b54dee94f6 | 3813 | server\services\chat\tools\lit-translation.js（新增） |
> | a7906b08ac50e1f4 | 1190 | server\services\chat\tools\_resolve.js（新增） |
> | f1a5217ec681ea84 | 19330 | server\services\llm\client.js |
> | 163c9fb23a11c978 | 18146 | server\services\fts.js |
> | 50ac4e145b21a4dc | 10695 | server\migrate.js |
> | 967a80f771423d35 | 15122 | server\schema.sql |
> | fd09da0e5d6b485f | 11542 | server\config.js |
> | 0243495032a00e3c | 5082 | server\cli\verify-agent.js（新增） |
> | 47b92ba2dee45ccb | 19710 | web\assets\chat.js |
> | 297f5c72ec5f1052 | 18813 | web\assets\reader.css |
>
> **v3 变更（2026-11-02，对话抽屉 Markdown 化）**：以下 7 个文件的哈希**取代 §2 中同名行的旧值**（本节优先）。
> 改动内容：助手消息按 Markdown 渲染（marked + DOMPurify 消毒 + highlight.js 高亮），
> 流式渲染节流 ~10fps，代码块带复制按钮；`reader.html` 增加 3 个 vendor script 与 1 个 hljs 主题 CSS；
> `reader.css` 追加 `.bubble.md` 系列样式（约 45 行）。**后端零改动，schema 未动（user_version 仍为 2）**。
> 验证：真实 Chromium 端到端（伪造 SSE 流走 `chat.js` 真实 `send()` 路径）——标题/加粗/列表/代码高亮
> （hljs span 6 处）/表格 3 行/引用块/复制按钮/引用 chip 全部出现，`<script>` 注入未执行，无页面错误。
>
> | sha256[:16] | bytes | file |
> |---|---|---|
> | 12861d40e67e8d5a | 16513 | web\assets\chat.js |
> | 0714c8fe4e5a6b89 | 6850 | web\reader.html |
> | 2c59115a9e1d8fd3 | 17610 | web\assets\reader.css |
> | 15fabce5b65898b3 | 35479 | web\assets\vendor\md\marked.min.js（新增） |
> | c0845096a7c4a674 | 21496 | web\assets\vendor\md\purify.min.js（新增） |
> | 837a6fa5b0c736b5 | 121727 | web\assets\vendor\md\highlight.min.js（新增） |
> | 3a9a5def8b9c311e | 1309 | web\assets\vendor\md\github.min.css（新增） |

## 1. 数据库状态（供核对）

| 项 | 值 |
|---|---|
| user_version | 2 |
| works | 424 |
| assets | 2 |
| segments | 1752 |
| translations | 482 |
| translations_fts | 492 |
| download_jobs | 5 |
| chats | 8 |
| messages | 30 |

## 2. 源码哈希（sha256 前 16 位 + 字节数，共 86 个文件，含 userscript/）

| sha256[:16] | bytes | file |
|---|---|---|
| d61f46365ab5c636 | 2445 | server\app.js |
| 32163f9e0c59314c | 2226 | server\cli\fts-rebuild.js |
| 1445ac58873b5bd0 | 11019 | server\config.js |
| 6730db0ee51103d6 | 4253 | server\db.js |
| 3b5d627bac830e05 | 2559 | server\errors.js |
| 7ba36d3ea499251b | 1604 | server\import-cli.js |
| 301580ec5b759441 | 2925 | server\index.js |
| c70364f93ee31f8d | 2337 | server\logger.js |
| 605c36083cd1ce82 | 1822 | server\middleware\error.js |
| a1d0b5a5f054aa02 | 801 | server\middleware\ratelimit.js |
| 26f5101454a32412 | 5458 | server\middleware\security.js |
| 29174e2e9ee447f6 | 3453 | server\middleware\validate.js |
| 0a817a6c0e61ebe7 | 9464 | server\migrate.js |
| 20de12d027a87b80 | 14873 | server\routes\assets.js |
| bf9d5f5093f9f760 | 1876 | server\routes\chat.js |
| bac6ffaa6e040fe5 | 1208 | server\routes\download.js |
| 24e015261b3082f4 | 931 | server\routes\health.js |
| 931c0a7e3f3a233f | 856 | server\routes\import.js |
| d4fffb73aacdfb58 | 1283 | server\routes\jobs.js |
| a3389192e5d7cb06 | 4588 | server\routes\segments.js |
| b2ae92aae997e0d0 | 5831 | server\routes\settings.js |
| 577f25c630675f37 | 3346 | server\routes\translate.js |
| 0e8db816321afe00 | 3456 | server\routes\works.js |
| 09630487830933c3 | 14884 | server\schema.sql |
| 282d3425f30e9f86 | 17937 | server\services\artworks.js |
| 270f54d08e8eddf9 | 19796 | server\services\chat\agent.js |
| 7c718fcb22377902 | 7038 | server\services\chat\context.js |
| b5609fec764139ae | 4021 | server\services\chat\prompts.js |
| 79fa9339b6ab4771 | 6486 | server\services\chat\retrieval.js |
| 2f388f265ff57423 | 24765 | server\services\downloader.js |
| 4b77222482cbafa4 | 13620 | server\services\extractor.js |
| a5e14f7b96204af6 | 14030 | server\services\fts.js |
| f2baebd907863dc1 | 11931 | server\services\importer.js |
| b4130b58a83e6615 | 18011 | server\services\llm\client.js |
| 9ae41b87d8b1e060 | 20511 | server\services\pdf\buildPages.js |
| 7316b2a97ac2326f | 4418 | server\services\pdf\meta.js |
| 1eb3a44e0920e536 | 812 | server\services\resolvers\arxiv.js |
| 074651a315f61587 | 1261 | server\services\resolvers\doi.js |
| 1a5efcb4737fc307 | 1191 | server\services\resolvers\index.js |
| d91477fe1c4bfa78 | 821 | server\services\resolvers\link.js |
| 8b2117ea924b96de | 922 | server\services\resolvers\manual.js |
| b423bb3f30a7505b | 7332 | server\services\segment.js |
| bcc4064bb782fc4c | 17344 | server\services\storage.js |
| 9f064062b579d26d | 1592 | server\services\translate\cacheKey.js |
| 7f297240f916e39f | 1413 | server\services\translate\engines\claude.js |
| 7520411d8fe35d4a | 1519 | server\services\translate\engines\gemini.js |
| 8882bdb4066c13f6 | 2887 | server\services\translate\engines\mock.js |
| 80d2555cd4728254 | 1838 | server\services\translate\engines\openaiCompatible.js |
| b3798d8e54bfc4cc | 5310 | server\services\translate\engines\registry.js |
| e4f5c5783be6828e | 2354 | server\services\translate\engines\shared.js |
| 05c17b00c033e7a0 | 1201 | server\services\translate\engines\types.js |
| 82263ed664947ee1 | 29225 | server\services\translate\pipeline.js |
| 37b1a6894f3e5fe7 | 3293 | server\services\translate\prompts.js |
| e9046b0c5c4fbdcf | 3063 | server\test\batches.test.js |
| dfe4f31e5b81ef7b | 4638 | server\test\buildPages.test.js |
| 64d5c3a3317c2f81 | 2360 | server\test\cacheKey.test.js |
| 05ff43e253de4efe | 4188 | server\test\chat-summary.test.js |
| 8296ecccb4d0cb21 | 3983 | server\test\citation.test.js |
| 14304a7ce926f154 | 4785 | server\test\context.test.js |
| 8db667904c0c2caf | 2704 | server\test\csv.test.js |
| 1cf75fa0612ce75f | 4806 | server\test\downloader.test.js |
| 5867db38d13332d8 | 6663 | server\test\dual-index.test.js |
| b79093e1d13a8ba3 | 4732 | server\test\fts.test.js |
| c3fd571680a9c2ca | 2270 | server\test\path-scope.test.js |
| 04fa2806936b1771 | 2972 | server\test\pdf-verify.test.js |
| 226df6ff1f410370 | 1816 | server\test\storage-name.test.js |
| 1a81ca0a77e46d32 | 3843 | server\test\upload-safety.test.js |
| 979531067532fa82 | 3527 | userscript\README.md |
| f73f1198f782c308 | 12329 | userscript\lit-uploader.user.js |
| 7e53915540fa37c7 | 2597 | web\assets\api.js |
| 3ff13afcf66ec6f5 | 5823 | web\assets\app.css |
| afcaa079ecbbe469 | 11306 | web\assets\chat.js |
| 6c7ca8e1faa7d632 | 9182 | web\assets\list.js |
| 7409e3b4f278113f | 4217 | web\assets\reader.css |
| aa5857ab7155dd4d | 10480 | web\assets\reader.js |
| 597694dbc3ce3865 | 6589 | web\assets\settings.js |
| f00f5276c7705e19 | 4087 | web\assets\translate.js |
| 8ac2a9edf8a5a69f | 2971 | web\assets\ui.js |
| bccc24ea711db8e4 | 523774 | web\assets\vendor\pdfjs\pdf.min.mjs |
| 145d2dd3ab0c8615 | 1321307 | web\assets\vendor\pdfjs\pdf.worker.min.mjs |
| f799dca1c729df37 | 5773 | web\assets\viewer.js |
| 30cf218fa98e2f84 | 11589 | web\assets\work.js |
| d36e2ae5247c63ae | 2821 | web\index.html |
| 09f777eca965fcf2 | 3280 | web\reader.html |
| 6309b5757b6c2905 | 4086 | web\settings.html |
| 0c6219bf3e8381ea | 3542 | web\work.html |

## 3. 已知的半成品 / 未完成项 已知的半成品 / 未完成项

- 真实 LLM 引擎（DeepSeek/Gemini/Claude）**零真实调用**：无 key，流式解析与 usage 记账只有代码，没有执行证据。
-  只有 5 条（id 1–5）：本项目至今只发起过 5 次下载（2 次成功、2 次 needs_manual、1 次 force 重下），不是被清库。
- mock 译文是「固定词表替换」的伪中文，仅用于验证跨语言检索链路，**不代表翻译质量**。
