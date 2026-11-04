-- ============================================================================
-- Agent 工作流文献管理系统 · 全量 DDL（唯一事实源，对应架构设计 §7）
-- 约定：时间一律 INTEGER（Unix ms）；布尔一律 INTEGER 0/1；JSON 一律 TEXT。
-- 7 张业务表一次建全（含 M2/M3 才使用的 segments/translations/translate_jobs/chats/messages），
-- 目的是避免分期迁移；M1 只写入 works / assets / download_jobs / settings。
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

-- ─────────────────────────────────────────────────────────────
-- works：文献元数据（运行时事实源）
-- 字段 ↔ CSV 13 列一一对应；origin/fields_locked 用于导入冲突裁决（§20 D2）
-- 注意：no 是字符串业务主键（"7.2"/"12.10"），排序必须按「段号.序号」两段数值排
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS works (
  id             INTEGER PRIMARY KEY,
  no             TEXT    NOT NULL UNIQUE,      -- ①编号 "4.13"（业务主键，文件名锚点）
  section_no     INTEGER NOT NULL,             -- ②专题序号（由专题列首部数字解析）
  section        TEXT    NOT NULL,             -- ②专题全称 "4 LLM Agent 工作流：..."（含序号原文）
  authors        TEXT    NOT NULL DEFAULT '',  -- ③作者
  title          TEXT    NOT NULL,             -- ④标题
  year           INTEGER,                      -- ⑤年份（可为 NULL：个别条目缺）
  venue          TEXT    NOT NULL DEFAULT '',  -- ⑥出处
  type           TEXT    NOT NULL DEFAULT '',  -- ⑦类型：期刊/会议/专著/预印本/非同行评审
  note           TEXT    NOT NULL DEFAULT '',  -- ⑧贡献定位
  arxiv_id       TEXT,                         -- ⑨arXiv 编号（不含 "arXiv:" 前缀，去版本号）
  doi            TEXT,                         -- ⑩DOI（小写归一）
  isbn           TEXT,                         -- ⑪ISBN
  link           TEXT,                         -- ⑫官方链接
  source_note    TEXT    NOT NULL DEFAULT '',  -- ⑬数据来源
  origin         TEXT    NOT NULL DEFAULT 'import',  -- import | local
  fields_locked  TEXT    NOT NULL DEFAULT '[]',      -- JSON 数组：被用户改过的字段名
  retired        INTEGER NOT NULL DEFAULT 0,         -- 1=新版 CSV 里已消失，不删行
  last_read_at   INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (origin IN ('import','local')),
  CHECK (retired IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_works_section ON works(section_no, no);
CREATE INDEX IF NOT EXISTS idx_works_year    ON works(year);
CREATE INDEX IF NOT EXISTS idx_works_type    ON works(type);
CREATE INDEX IF NOT EXISTS idx_works_arxiv   ON works(arxiv_id) WHERE arxiv_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_works_doi     ON works(doi)      WHERE doi IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- assets：一个 work 的本地文件（当前只有 pdf，留 kind 以便将来加 "supp" 附件）
-- storage_rel_path 只存相对 downloadDir 的路径 → 移动整个目录后可自愈
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assets (
  id               INTEGER PRIMARY KEY,
  work_id          INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind             TEXT    NOT NULL DEFAULT 'pdf',
  storage_rel_path TEXT,
  file_size        INTEGER,
  file_sha256      TEXT,
  page_count       INTEGER,
  file_state       TEXT    NOT NULL DEFAULT 'absent',  -- absent|present|missing
  missing_since    INTEGER,
  last_verified_at INTEGER,
  extract_status   TEXT    NOT NULL DEFAULT 'pending', -- pending|extracting|ready|failed|needs_ocr
  extract_version  INTEGER NOT NULL DEFAULT 0,
  extract_error    TEXT,
  source           TEXT,            -- 来源快照：arxiv|doi|link|manual|inbox
  source_url       TEXT,            -- 实际下载的 URL（可追溯）
  downloaded_at    INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(work_id, kind),
  CHECK (file_state   IN ('absent','present','missing')),
  CHECK (extract_status IN ('pending','extracting','ready','failed','needs_ocr'))
);
CREATE INDEX IF NOT EXISTS idx_assets_state ON assets(file_state, extract_status);

-- ─────────────────────────────────────────────────────────────
-- download_jobs：下载状态机（DB 为唯一真相，内存队列只是它的投影）
-- 部分唯一索引保证「一个 work 同时只有一个活跃 job」＝幂等的硬保证
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS download_jobs (
  id            INTEGER PRIMARY KEY,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL,   -- queued|resolving|downloading|verifying|done|failed|needs_manual|canceled
  source        TEXT,
  url           TEXT,
  http_status   INTEGER,
  bytes_done    INTEGER NOT NULL DEFAULT 0,
  bytes_total   INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT,
  error_message TEXT,
  next_retry_at INTEGER,
  force         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  CHECK (status IN ('queued','resolving','downloading','verifying','done','failed','needs_manual','canceled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_download_active ON download_jobs(work_id)
  WHERE status IN ('queued','resolving','downloading','verifying');
CREATE INDEX IF NOT EXISTS idx_download_status ON download_jobs(status, created_at);

-- ─────────────────────────────────────────────────────────────
-- segments：抽取出的段落（原文层，M2 写入）
-- (asset_id,page_no,ord) 唯一 → 重抽时整段替换，天然无重复
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS segments (
  id              INTEGER PRIMARY KEY,
  asset_id        INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  page_no         INTEGER NOT NULL,        -- 1-based
  ord             INTEGER NOT NULL,        -- 页内段序（0-based）
  text            TEXT    NOT NULL,
  char_len        INTEGER NOT NULL,
  is_math         INTEGER NOT NULL DEFAULT 0,
  is_label        INTEGER NOT NULL DEFAULT 0,
  is_heading      INTEGER NOT NULL DEFAULT 0,
  bbox            TEXT,
  role            TEXT,                    -- 版面角色：title/author/abstract/section/body/caption/figure-label/equation/footnote/reference/header/footer/page-number/quote/list-item/unknown
  tier            TEXT,                    -- 排版层级：h1/h2/body/small（驱动字号与对齐）
  align           TEXT,                    -- left/center
  ratio           REAL,                    -- 字号相对正文的倍数（heuristic 或精排产出）
  gap_pct         REAL,                    -- 块上方空白占页高百分比（精排输入之一）
  extract_version INTEGER NOT NULL,
  UNIQUE(asset_id, page_no, ord)
);
CREATE INDEX IF NOT EXISTS idx_segments_asset ON segments(asset_id, page_no, ord);

-- FTS5 索引：text_index = CJK 2-gram 展开后的文本（§10.3）
-- rowid 与 segments.id 一一对应
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  text_index,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ─────────────────────────────────────────────────────────────
-- page_figures（v5）：每页图形区域（供前端把图保留在译文页上）
-- boxes 是 JSON `[[x0,y0,x1,y1], ...]`，**PDF 点、y 向上、原点在左下角**，
-- 与 segments.bbox 完全同一口径（前端用同一个 convertToViewportPoint 换算）。
-- width/height 是该页 getViewport({scale:1}) 的可视尺寸（已含 rotate）——
-- 前端按真实页面比例排版，不再依赖写死的 1/1.294。
-- 与 migrate.js 里的 PAGE_FIGURES_DDL 必须逐字一致（新库走这里，老库走 v5 迁移）。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS page_figures (
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  page_no    INTEGER NOT NULL,                     -- 1-based
  boxes      TEXT    NOT NULL DEFAULT '[]',        -- JSON [[x0,y0,x1,y1],...]；PDF 点、y 向上
  width      REAL,                                 -- 该页可视宽（pt，已含 rotate）
  height     REAL,                                 -- 该页可视高（pt）
  version    INTEGER NOT NULL DEFAULT 1,           -- 图区算法版本（figures.FIGURE_VERSION）
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, page_no)
);
CREATE INDEX IF NOT EXISTS idx_page_figures_asset ON page_figures(asset_id);

-- ─────────────────────────────────────────────────────────────
-- translations：按段译文缓存（内容寻址主键，M2 写入）
-- cache_key = sha256(engine \0 model \0 tgt_lang \0 prompt_fp \0 extract_version \0 text)
-- （srcLang 不参与，理由见 §21 R3）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS translations (
  cache_key       TEXT    PRIMARY KEY,
  asset_id        INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  segment_id      INTEGER,          -- v2：译文所属段落（重抽后靠 extract_version 失效，不再 join 猜）

  page_no         INTEGER,
  ord             INTEGER,
  src_text        TEXT    NOT NULL,
  dst_text        TEXT    NOT NULL,
  engine          TEXT    NOT NULL,
  model           TEXT    NOT NULL DEFAULT '',
  src_lang        TEXT    NOT NULL DEFAULT 'auto',
  tgt_lang        TEXT    NOT NULL,
  prompt_fp       TEXT    NOT NULL,
  extract_version INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  last_hit_at     INTEGER,
  hits            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tr_asset ON translations(asset_id, page_no, ord);

-- ─────────────────────────────────────────────────────────────
-- translations_fts（v2）：译文侧 FTS 索引 —— 支撑「中文问英文文献」的跨语言检索（D22）
-- **rowid = segments.id**（与 segments_fts 同构）：一个段落只有一行，
-- 写入时先按 rowid 删再插，换引擎/重译都是「重建该段行」，不会出现同段多行或旧译文仍可搜到。
-- text 列写的是 toFtsText(译文)，与 segments_fts 用同一个预处理函数。
-- engine / tgt_lang 只作审计（UNINDEXED），检索时不按它们过滤（写入端已保证只放当前生效译文）。
-- ─────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS translations_fts USING fts5(
  engine   UNINDEXED,
  tgt_lang UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ─────────────────────────────────────────────────────────────
-- translate_jobs：翻译任务（M2 写入；断点续译由 translations 命中数反推）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS translate_jobs (
  id               INTEGER PRIMARY KEY,
  asset_id         INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  status           TEXT    NOT NULL,
  engine           TEXT    NOT NULL,
  model            TEXT    NOT NULL DEFAULT '',
  src_lang         TEXT    NOT NULL DEFAULT 'auto',
  tgt_lang         TEXT    NOT NULL DEFAULT 'zh-CN',
  prompt_fp        TEXT    NOT NULL,
  scope            TEXT    NOT NULL DEFAULT 'all',
  scope_pages      TEXT,
  total_segments   INTEGER NOT NULL DEFAULT 0,
  done_segments    INTEGER NOT NULL DEFAULT 0,
  failed_segments  INTEGER NOT NULL DEFAULT 0,
  anchor_page      INTEGER,
  error_code       TEXT,
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  CHECK (status IN ('queued','running','paused','done','failed','canceled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_translate_active ON translate_jobs(asset_id, engine, tgt_lang)
  WHERE status IN ('queued','running','paused');

-- ─────────────────────────────────────────────────────────────
-- chats / messages：对话（M3 写入；citations 存快照而非纯 id）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  asset_id   INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  title      TEXT    NOT NULL DEFAULT '',
  provider   TEXT    NOT NULL DEFAULT '',
  model      TEXT    NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  summary    TEXT    NOT NULL DEFAULT '',  -- v2：更早对话的滚动摘要（只压一次，之后增量追加）
  summary_upto INTEGER NOT NULL DEFAULT 0, -- v2：摘要已覆盖到的 messages.id 水位
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_work ON chats(work_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY,
  chat_id       INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role          TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  citations     TEXT    NOT NULL DEFAULT '[]',
  context_meta  TEXT    NOT NULL DEFAULT '{}',
  provider      TEXT,
  model         TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms    INTEGER,
  error_code    TEXT,
  truncated     INTEGER NOT NULL DEFAULT 0,  -- v2：SSE 中断时保留已产出部分
  retrieval_miss INTEGER NOT NULL DEFAULT 0, -- v2：两侧索引全空（含改写后）→ 1，UI 必须灰字标注
  tool_calls    TEXT    NOT NULL DEFAULT '[]', -- v3：tools 引擎本轮的工具调用日志（name/args/ok/ms/chars）
  attachments   TEXT    NOT NULL DEFAULT '[]', -- v3：消息附带的图片/文件引用（R3 视觉通道用）
  feedback      INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (role IN ('system','user','assistant'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

-- ─────────────────────────────────────────────────────────────
-- settings：运行时可改配置（KV，值存字符串或 JSON 文本）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 新库直接落在最新版本上（schema.sql 已含 v2~v5 的全部对象与列）；
-- 老库由 migrate.js 的 MIGRATIONS 逐级补齐，两边版本号必须一致。
PRAGMA user_version = 5;
