/**
 * SQLite 薄封装（§7 驱动约定）：业务代码只能经本文件访问 DB。
 * 换驱动（如 better-sqlite3）只改本文件。
 *
 * 之所以用 node:sqlite：Node 22 内置、同步 API、零原生模块依赖（避开 Windows 上
 * better-sqlite3 需要 VS Build Tools 的坑，§20 D19）。它当前仍标记 experimental。
 */
import fs from 'node:fs';
import path from 'node:path';

// 一次性过滤 node:sqlite 的 ExperimentalWarning（白名单式，不影响其它告警）
process.removeAllListeners('warning');
process.on('warning', (w) => {
  const msg = `${w.name}: ${w.message}`;
  if (w.name === 'ExperimentalWarning' && /SQLite|node:sqlite/i.test(w.message)) return;
  process.stderr.write(`${msg}\n`);
});

const { DatabaseSync } = await import('node:sqlite');

/** @type {import('node:sqlite').DatabaseSync|null} */
let db = null;
let dbPath = null;
/** 预编译语句缓存（同一 SQL 反复执行时避免重复编译） */
const stmtCache = new Map();
let txDepth = 0;

/**
 * 打开数据库并设置运行时 pragma。
 * @param {string} file 绝对路径
 */
export function openDb(file) {
  if (db) return db;
  dbPath = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

export function closeDb() {
  if (!db) return;
  stmtCache.clear();
  db.close();
  db = null;
}

export function getDbPath() {
  return dbPath;
}

function requireDb() {
  if (!db) throw new Error('数据库尚未打开（先调用 openDb）');
  return db;
}

function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = requireDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/**
 * 执行任意 SQL（可多语句；DDL 用）。
 * @param {string} sql
 */
export function exec(sql) {
  return requireDb().exec(sql);
}

/**
 * 查询多行。
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {any[]} 普通对象数组（node:sqlite 返回 null 原型对象，这里浅拷贝成普通对象）
 */
export function all(sql, params = []) {
  return stmt(sql)
    .all(...params)
    .map((r) => ({ ...r }));
}

/**
 * 查询单行。
 * @returns {any|undefined}
 */
export function get(sql, params = []) {
  const row = stmt(sql).get(...params);
  return row === undefined ? undefined : { ...row };
}

/**
 * 写操作（INSERT/UPDATE/DELETE）。
 * @returns {{changes:number, lastInsertRowid:number}}
 */
export function run(sql, params = []) {
  const r = stmt(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/**
 * 同步事务。嵌套调用自动扁平化（只最外层真正 BEGIN/COMMIT）。
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
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
    return out;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始异常 */
    }
    throw e;
  } finally {
    txDepth = 0;
  }
}

/** 当前 user_version */
export function userVersion() {
  return Number(get('PRAGMA user_version').user_version || 0);
}

/**
 * 在线备份（VACUUM INTO），schema 变更前调用（§19 第 15 条）。
 * @param {string} targetFile
 */
export function backupTo(targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  // VACUUM INTO 不允许目标已存在：同日多次迁移时加时间后缀，保留最近几份即可
  let target = targetFile;
  if (fs.existsSync(target)) {
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    target = targetFile.replace(/(\.db)$/i, `-${stamp}.db`);
  }
  requireDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}
