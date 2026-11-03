/**
 * 结构化 JSON 行日志 + 脱敏（§9.2 / §19 第 1 条）。
 * 脱敏范围：sk-* 密钥、Bearer token、api_key 字段。日志永不出现明文密钥。
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 日志脱敏规则（顺序执行，均为确定性替换） */
const REDACT_RULES = [
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***REDACTED***'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***REDACTED***'],
  [/"?(api[_-]?key|authorization|apikey)"?\s*[:=]\s*"?[^",\s}]+"?/gi, '$1:"***REDACTED***"'],
];

export function redact(value) {
  let s = typeof value === 'string' ? value : safeStringify(value);
  for (const [re, rep] of REDACT_RULES) s = s.replace(re, rep);
  return s;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

let stream = null;
let level = LEVELS.info;
let logDir = null;

export function initLogger({ logDir: dir, logLevel = 'info' } = {}) {
  level = LEVELS[logLevel] || LEVELS.info;
  if (!dir) return;
  logDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${new Date().toISOString().slice(0, 10)}.log`);
  stream = fs.createWriteStream(file, { flags: 'a' });
}

export function closeLogger() {
  if (stream) {
    stream.end();
    stream = null;
  }
}

/** 内部：写一行 JSON（脱敏后写文件，控制台按同样内容输出） */
function write(lvl, module, event, fields) {
  if (LEVELS[lvl] < level) return;
  const row = {
    ts: new Date().toISOString(),
    level: lvl,
    module,
    event,
    fields: fields && typeof fields === 'object' ? JSON.parse(redact(fields)) : fields ?? undefined,
  };
  const line = redact(row);
  if (stream) stream.write(line + '\n');
  if (lvl === 'error' || lvl === 'warn' || process.env.AGENTLIT_LOG_CONSOLE === '1') {
    // eslint-disable-next-line no-console
    console[lvl === 'debug' ? 'log' : lvl](line);
  }
}

export function createLogger(module) {
  return {
    debug: (event, fields) => write('debug', module, event, fields),
    info: (event, fields) => write('info', module, event, fields),
    warn: (event, fields) => write('warn', module, event, fields),
    error: (event, fields) => write('error', module, event, fields),
  };
}

export { logDir };
