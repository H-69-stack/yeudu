/**
 * 三层配置合并（§2 / §14）。
 * 优先级：env > data/secret.json > settings 表 > config.local.json > 内置默认。
 *
 * 设计约束：
 *  - 本文件是唯一读配置文件的地方；业务模块只 import { config }。
 *  - settings 表在 DB 打开后才可读，故分两阶段：loadConfig()（文件+env）→ applyDbSettings()。
 *  - 路径统一在这里 resolve，并且在这里创建目录（其余模块不创建目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BUILTIN_DEFAULTS = {
  server: { port: 7317, host: '127.0.0.1', dbPath: 'data/app.db', logLevel: 'info', traceSampleRate: 1 },
  download: {
    downloadDir: 'storage/pdfs',
    layout: 'flat',
    maxBytes: 125829120,
    timeoutMs: 45000,
    concurrency: 2,
    maxRedirects: 5,
    unpaywallEmail: '',
    minPdfBytes: 8192,
    requestIntervalMs: 3000,
    maxAttempts: 3,
  },
  translate: {
    engine: 'deepseek',
    // AI 精排（版面复核）单独用的引擎；留空 = 跟随 translate.engine。
    // 典型分工：翻译用千问（便宜），精排用 DeepSeek（结构判断更稳）。
    refineEngine: 'deepseek',
    fallbackEngines: ['openai'],
    tgtLang: 'zh-CN',
    srcLang: 'auto',
    concurrency: 2,
    batchChars: 3000,
    batchItems: 6,
    temperature: 0.3,
    maxTokens: 4000,
  },
  chat: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    // 引擎：'legacy' = 旧的「拼 prompt 单次检索」（回退通道）；'tools' = 参照 dsh 的工具循环
    engine: 'legacy',
    // tools 引擎的工具清单（名字与 dsh litagent 的 lit-*.ts 一致；没列出的工具模型看不到）
    tools: ['lit_search', 'lit_read', 'lit_translation'],
    maxToolCallsPerTurn: 8,  // 每轮工具调用总次数上限（成本闸；用尽后强制收尾一次）
    maxToolRounds: 5,        // 工具循环最大轮数（防止模型反复绕圈）
    // 每会话每工具的配额（跨轮；数据源是落库的工具调用日志）。例：{ lit_page_image: 20 }
    maxCallsPerSession: {},
    // 视觉通道（lit_page_image）：**默认关闭**（写/重工具默认关，与 dsh 一致）。
    // 打开需要同时满足：enabled=true、渲染器可解析（playwright + Chromium + pdf.js 资产面）、
    // 且名字出现在上面的 chat.tools 里。配额默认值见 pageImage.maxCallsPerSession。
    pageImage: {
      enabled: false,
      renderer: 'browser',
      pdfjsDir: '',           // 留空 = 自动解析本项目 node_modules 里的 pdfjs-dist 包根
      playwrightModule: '',   // 本项目不装 playwright；留空则先试 require('playwright')，失败即报 E_RENDERER_UNAVAILABLE
      renderTimeoutMs: 8000,  // 单页渲染超时；超时=失败（不当成空页）
      idleTimeoutMs: 300000,  // 空闲 5 分钟回收浏览器；0=不回收
      maxEdge: 1500,
      maxPixels: 1650000,
      jpegQuality: 0.85,
      maxCallsPerSession: 20, // 0 或负数 = 根本不注册该工具
      // 图片注入：渲染出的图必须以**用户消息**注入，模型才看得到
      // （生产适配器是 text-only 输出，只有用户消息能带图；见 docs/01-源码梳理.md:262）
      injectImages: true,
      maxInjectBytes: 5242880, // 单张上限 5MB，超了跳过并在上下文里说明
      maxInjectPerTurn: 4,     // 每轮最多注入 4 张
    },
    // 多模态输入/输出（用户上传图片/文件给模型看；工具产出图可下载）——见 02-design/多模态输入输出设计.md
    attachments: {
      maxPerMessage: 4, // 每用户消息最多携带的附件数
      maxBytes: 10485760, // 单文件存储上限 10 MiB
      maxEdgePx: 4096, // 图片长边像素上限（超出拒绝，不降采样）
      maxInjectBytes: 5242880, // 入模单图字节上限（与 pageImage.maxInjectBytes 对齐）
      maxInjectPerTurn: 4, // 入模每轮用户图数
      supported: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/markdown'],
    },
    // 写工具总闸：**默认只读**（对齐 dsh 的 sandbox 默认 read-only）。开了也还要把工具列进 chat.tools
    allowWrite: false,
    maxTokens: 1600,
    temperature: 0.3,
    timeoutMs: 90000,
    historyTurns: 4,
    retrieveTopK: 24,
    retrieveChars: 3600,
    selectionChars: 1600,
    minKeywordHitRatio: 0.3,
    rewriteFallback: true,   // 0 命中且含中文时，允许用廉价档改写成英文关键词再检索一次
    mockChunkDelayMs: 260,   // 仅 mock 引擎：每块之间的延迟，用于演示流式与取消
  },
  budget: { dailyTokens: 800000, jobTokens: 300000 },
  extract: {
    paragraphChars: 600,
    useLayout: true,
    // S4 段落合并：行距 ≤ 同栏主导行距 × 该倍率 且 无首行缩进 → 并入同一段（§16.2）
    // 注意这是「相对主导行距」而不是「相对字身高」：实测文献的行距/字身高常在 1.5~1.7，
    // 用字身高倍数会把每行都断成独立段落（译文因此破碎）。
    paragraphGapRatio: 1.25,
    // S2 栏判定参数（minGapPct 用 1.0：双栏论文栏缝常只有 1.2~1.4% 页宽）
    columnRules: { minGapPct: 1.0, balance: [0.3, 0.7], minLinesPerSide: 3, minSideShare: 0.35 },
    // S7 角色判定阈值（宁宽勿窄：多判公式只是少翻一段，错判会输出乱码）
    roleRules: {
      mathNonAlnumRatio: 0.45,
      mathMinSymbols: 2,
      mathDigitRatio: 0.1,
      labelMaxChars: 40,
      headingMaxChars: 90,
    },
  },
};

/** applyDbSettings 时不能覆盖的键（端口/库路径改后必须重启，运行时改了会造成状态不一致） */
const NON_APPLICABLE = new Set(['server.port', 'server.dbPath']);
/** 通用 PUT /api/settings 不能改的键（downloadDir 有专用接口：SET /settings/downloadDir） */
const NON_SETTABLE = new Set(['server.port', 'server.dbPath', 'download.downloadDir']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function readJsonIfExists(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`配置文件解析失败：${file} → ${e.message}`);
  }
}

/** 生效配置对象（原地修改，import 它的模块始终看到最新值） */
export const config = deepMerge(BUILTIN_DEFAULTS, {});

/** 派生路径（不进 config 的公开字段，避免被 settings 覆盖） */
export const paths = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  logDir: path.join(ROOT, 'data', 'logs'),
  secretPath: path.join(ROOT, 'data', 'secret.json'),
  storageDir: path.join(ROOT, 'storage'),
  inboxDir: path.join(ROOT, 'storage', 'inbox'),
  storageTmpDir: path.join(ROOT, 'storage', 'tmp'),
  configFile: path.join(ROOT, 'config.local.json'),
};

/** 密钥（仅内存，不出服务端进程）；结构见 §14 data/secret.json */
export const secrets = { providers: {}, engines: {}, download: {} };

function envOverrides(cfg) {
  const env = process.env;
  if (env.AGENTLIT_PORT) cfg.server.port = Number(env.AGENTLIT_PORT);
  if (env.AGENTLIT_DB) cfg.server.dbPath = env.AGENTLIT_DB;
  if (env.AGENTLIT_DOWNLOAD_DIR) cfg.download.downloadDir = env.AGENTLIT_DOWNLOAD_DIR;
  if (env.AGENTLIT_LOG_LEVEL) cfg.server.logLevel = env.AGENTLIT_LOG_LEVEL;
  if (env.AGENTLIT_LLM_API_KEY) {
    const provider = cfg.chat.provider;
    secrets.providers[provider] = { ...(secrets.providers[provider] || {}), apiKey: env.AGENTLIT_LLM_API_KEY };
  }
  if (env.AGENTLIT_LLM_BASE_URL) {
    const provider = cfg.chat.provider;
    secrets.providers[provider] = { ...(secrets.providers[provider] || {}), baseUrl: env.AGENTLIT_LLM_BASE_URL };
  }
  return cfg;
}

/** 绝对化路径：相对路径一律相对项目根解析（§14） */
function resolvePaths(cfg) {
  cfg.server.dbPath = path.isAbsolute(cfg.server.dbPath) ? cfg.server.dbPath : path.join(ROOT, cfg.server.dbPath);
  cfg.download.downloadDir = path.isAbsolute(cfg.download.downloadDir)
    ? cfg.download.downloadDir
    : path.join(ROOT, cfg.download.downloadDir);
  return cfg;
}

/** 阶段一：内置默认 + config.local.json + env */
export function loadConfig() {
  const file = readJsonIfExists(paths.configFile);
  const merged = deepMerge(BUILTIN_DEFAULTS, file || {});
  Object.keys(config).forEach((k) => delete config[k]);
  Object.assign(config, merged);
  const secret = readJsonIfExists(paths.secretPath);
  Object.assign(secrets, { providers: {}, engines: {}, download: {} }, secret || {});
  envOverrides(config);
  resolvePaths(config);
  return config;
}

/**
 * 阶段二：settings 表覆盖（DB 就绪后调用）。
 * 值统一存字符串；能 JSON.parse 就按 JSON 解释（数字/布尔/数组/对象）。
 * @param {(sql:string, params?:any[])=>any[]} all
 */
export function applyDbSettings(all) {
  let rows = [];
  try {
    rows = all('SELECT key, value FROM settings');
  } catch {
    return config;
  }
  for (const row of rows) {
    if (NON_APPLICABLE.has(row.key)) continue;
    setByPath(config, row.key, parseLoose(row.value));
  }
  resolvePaths(config);
  return config;
}

function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function setByPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (isPlainObject(cur[last]) && isPlainObject(value)) cur[last] = deepMerge(cur[last], value);
  else cur[last] = value;
}

function getByPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 把配置摊成扁平的 dotted 键（用于 GET /api/settings 与白名单校验） */
export function flattenConfig(obj = config, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flattenConfig(v, key, out);
    else out[key] = v;
  }
  return out;
}

/** 允许新增子键的命名空间（引擎级参数按需长出来，不必预先写在默认配置里） */
const SETTABLE_PREFIXES = ['translate.engines.', 'chat.', 'translate.', 'download.', 'budget.', 'extract.', 'server.logLevel'];

export function isSettableKey(key) {
  if (NON_SETTABLE.has(key)) return false;
  if (getByPath(config, key) !== undefined) return true;
  return SETTABLE_PREFIXES.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p));
}

/** 创建运行期需要的目录（幂等） */
export function ensureDirs(cfg = config) {
  const dirs = [
    paths.dataDir,
    paths.logDir,
    paths.storageDir,
    paths.inboxDir,
    paths.storageTmpDir,
    path.join(cfg.download.downloadDir),
    path.join(cfg.download.downloadDir, '.tmp'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** 默认 CSV 导入源：优先项目根，其次上一级（M1 交付目录为 03-code/，CSV 在仓库根） */
export function defaultCsvPath() {
  const candidates = [path.join(ROOT, 'Agent工作流文献清单.csv'), path.join(ROOT, '..', 'Agent工作流文献清单.csv')];
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  return candidates[0];
}

/** 写入密钥文件（0600）；只写调用方给的字段，保留其余 */
export function writeSecrets(patch) {
  const next = deepMerge(deepMerge({ providers: {}, engines: {}, download: {} }, readJsonIfExists(paths.secretPath) || {}), patch || {});
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.secretPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  Object.keys(secrets).forEach((k) => delete secrets[k]);
  Object.assign(secrets, next);
  return next;
}

/** 运行期切换下载目录（settings 表持久化由调用方负责；这里只改内存 + 建目录） */
export function setRuntimeDownloadDir(dir) {
  config.download.downloadDir = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  ensureDirs(config);
  return config.download.downloadDir;
}

/** 目录是否可写（/api/health 与切换目录共用） */
export function isDirWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 掩码：sk-abcdefgh1234 → sk-…1234（永不返回明文） */
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** GET /api/settings 的脱敏视图 */
export function settingsView() {
  const providers = {};
  for (const [id, p] of Object.entries(secrets.providers || {})) {
    providers[id] = { baseUrl: p.baseUrl || '', hasKey: Boolean(p.apiKey), apiKeyMasked: maskKey(p.apiKey) };
  }
  const engines = {};
  for (const [id, e] of Object.entries(secrets.engines || {})) {
    engines[id] = { hasKey: Boolean(e && e.apiKey), apiKeyMasked: maskKey(e && e.apiKey) };
  }
  return {
    config: flattenConfig(),
    paths: { root: paths.root, dbPath: config.server.dbPath, downloadDir: config.download.downloadDir, dataDir: paths.dataDir },
    llm: {
      provider: config.chat.provider,
      providers,
      hasKey: Boolean((secrets.providers || {})[config.chat.provider]?.apiKey),
      engines,
      unpaywallEmail: (secrets.download || {}).unpaywallEmail || config.download.unpaywallEmail || '',
    },
  };
}
