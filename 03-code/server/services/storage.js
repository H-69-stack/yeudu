/**
 * 存储服务（§12.2）：文件名生成、路径白名单、原子写、自愈扫描、系统定位。
 * 边界（§5）：不决定「下哪个文件」、不判业务状态。任何文件操作前必须过 assertInScope。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AppError } from '../errors.js';
import { config, paths, ensureDirs } from '../config.js';
import { all, get, run, tx } from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('storage');

const WIN = process.platform === 'win32';

/** 文件名 slug 的长度上限（主理人定的硬约束） */
const SLUG_MAX = 80;

/** 允许读写的三个根（§9.5 路径白名单） */
export function allowedRoots() {
  return [config.download.downloadDir, paths.dataDir, paths.storageDir].map((p) => realpathNearest(p));
}

/** 取「最近的存在祖先」的真实路径（realpath 要求路径存在） */
function realpathNearest(target) {
  let cur = path.resolve(target);
  const tail = [];
  for (let i = 0; i < 40; i += 1) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // 权限等问题：退回字面路径，交由后续白名单比较
        return tail.length ? path.join(cur, ...tail.reverse()) : cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(target);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(target);
}

function normalizeForCompare(p) {
  const n = path.resolve(p);
  return WIN ? n.toLowerCase() : n;
}

/**
 * 路径白名单校验（唯一入口，任何文件操作前必调）。
 * @param {string} candidatePath 绝对或相对路径（相对路径按项目根解析）
 * @returns {string} 归一化后的绝对路径
 * @throws {AppError} E_PATH_OUT_OF_SCOPE
 */
export function assertInScope(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    throw new AppError('E_PATH_OUT_OF_SCOPE', '路径为空', { path: candidatePath ?? null });
  }
  if (candidatePath.includes('\0')) {
    throw new AppError('E_PATH_OUT_OF_SCOPE', '路径包含非法字符', { path: candidatePath });
  }
  // 显式拒绝 '..' 段（resolve 会消掉它，但用户传入的 ../ 意图本身就是越界信号）
  const rawSegs = candidatePath.split(/[\\/]+/);
  if (rawSegs.includes('..')) {
    throw new AppError('E_PATH_OUT_OF_SCOPE', '路径包含 ".." 越界段', { path: candidatePath });
  }
  const abs = path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(paths.root, candidatePath);
  const real = realpathNearest(abs);
  const realN = normalizeForCompare(real);
  for (const root of allowedRoots()) {
    const rootN = normalizeForCompare(root);
    if (realN === rootN || realN.startsWith(rootN.endsWith(path.sep) ? rootN : rootN + path.sep)) return real;
  }
  throw new AppError('E_PATH_OUT_OF_SCOPE', '目标路径越出允许范围（downloadDir / data / storage）', {
    path: candidatePath,
    roots: allowedRoots(),
  });
}

/**
 * 只允许落在 downloadDir 内部（比 assertInScope 更严：storage/ 其它子目录也不行）。
 * 为什么需要它：`storage/` 整棵树都在白名单里（inbox/tmp 要用），所以
 * `storage/tmp-escape.pdf` 能通过 assertInScope —— 但它不该被当成 asset 落盘。
 * @param {string} candidatePath
 * @returns {string} 归一化后的绝对路径
 * @throws {AppError} E_PATH_OUT_OF_SCOPE
 */
export function assertInDownloadDir(candidatePath) {
  const abs = assertInScope(candidatePath); // 先过全局白名单（含 '..' 与 NUL 拦截）
  const root = normalizeForCompare(realpathNearest(config.download.downloadDir));
  const real = normalizeForCompare(abs);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (real !== root && !real.startsWith(prefix)) {
    throw new AppError('E_PATH_OUT_OF_SCOPE', '目标文件必须位于 downloadDir 内部', {
      path: candidatePath,
      downloadDir: config.download.downloadDir,
    });
  }
  return abs;
}

/**
 * 判断客户端给的文件名是否「明显恶意」。
 * 注意：正常文件名也只用于日志 —— 目标名一律由服务端生成（不信任客户端）。
 * @param {string} name
 * @returns {string|null} 命中的原因；null 表示没发现问题
 */
export function detectUnsafeFilename(name) {
  const raw = String(name || '');
  if (!raw) return null;
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  for (const v of [raw, decoded]) {
    // 顺序有讲究：越具体的判定越靠前，日志里才能看出「到底像哪种攻击」
    if (v.includes('\0')) return 'NUL';
    if (/%2e|%2f|%5c/i.test(v)) return 'percent-encoded-traversal';
    if (/^\\\\/.test(v)) return 'unc';
    if (/^[a-zA-Z]:/.test(v)) return 'drive-letter';
    if (v.startsWith('/')) return 'absolute';
    if (v.includes('..')) return 'dot-dot';
    if (/[\\/]/.test(v)) return 'path-separator';
  }
  return null;
}

/**
 * 上传/入库的唯一目标路径解析入口：
 *  ① 不信任客户端文件名（恶意名直接 403，正常名只记日志）
 *  ② 目标名由服务端 `<no>__<slug>.pdf` 生成
 *  ③ 落盘前再过 assertInDownloadDir
 * @param {{work:{no:string,title:string}, clientFilename?:string}} p
 * @returns {{relPath:string, absPath:string, clientFilename:string, ignoredClientName:boolean}}
 */
export function resolveAssetTarget({ work, clientFilename }) {
  const unsafe = detectUnsafeFilename(clientFilename);
  if (unsafe) {
    throw new AppError('E_PATH_OUT_OF_SCOPE', `上传文件名不安全（${unsafe}），已拒绝`, {
      clientFilename: String(clientFilename).slice(0, 120),
    });
  }
  const relPath = buildRelPath(work);
  // 兜底：relPath 必须严格是 `<no>__<slug>.pdf`，且 slug 只含 [a-z0-9-] 或 zh+hash
  if (!/^\d+\.\d+__[a-z0-9-]{1,80}\.pdf$/.test(relPath) && !/^\d+\.\d+__zh[0-9a-f]{8}\.pdf$/.test(relPath)) {
    throw new AppError('E_INTERNAL', `服务端生成的文件名不合法：${relPath}`, { relPath });
  }
  const absPath = assertInDownloadDir(path.resolve(config.download.downloadDir, relPath));
  return { relPath, absPath, clientFilename: String(clientFilename || ''), ignoredClientName: Boolean(clientFilename) };
}

/** 标题 → 文件名 slug（§12.2 规则）；非拉丁标题用 zh+sha1 前 8 位 */
export function slugify(title, { maxLen = 60 } = {}) {
  const text = String(title || '').normalize('NFKC');
  const latin = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (latin.replace(/-/g, '').length >= 3) return latin.slice(0, maxLen).replace(/-+$/g, '');
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
  return `zh${hash}`;
}

/**
 * 文件名生成（幂等键：`<no>__` 前缀可反解）。
 * @param {{no:string, title:string}} work
 * @returns {string} 形如 "4.13__survey-on-large-language-model-based.pdf"
 */
export function buildRelPath(work) {
  const dirLen = path.resolve(config.download.downloadDir).length;
  let slug = slugify(work.title, { maxLen: SLUG_MAX });
  let name = `${work.no}__${slug}.pdf`;
  if (dirLen + name.length > 235) {
    slug = slug.slice(0, 30);
    name = `${work.no}__${slug}.pdf`;
  }
  return name;
}

/** 从文件名反解编号：`4.13__xxx.pdf` → "4.13" */
export function parseNoFromFilename(file) {
  const base = path.basename(String(file));
  const m = /^(\d+\.\d+)__.+\.pdf$/i.exec(base);
  return m ? m[1] : null;
}

export function isPdfFilename(file) {
  return /\.pdf$/i.test(String(file));
}

/** downloadDir 内相对路径 → 绝对路径（经白名单校验） */
export function absFromRel(relPath) {
  if (!relPath) throw new AppError('E_NOT_FOUND', '该条目没有本地文件');
  const abs = path.resolve(config.download.downloadDir, relPath);
  return assertInScope(abs);
}

/** 同盘临时目录（原子写：.part → rename） */
export function tmpDir() {
  const dir = path.join(config.download.downloadDir, '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 原子落盘：把已写好的同盘 .part 改名为目标名。
 * @param {string} partAbs
 * @param {string} finalAbs
 */
export async function commitAtomic(partAbs, finalAbs) {
  const part = assertInScope(partAbs);
  // 唯一落盘 choke point：下载 / 手动上传 / inbox 入库三条路径都经这里，
  // 因此把「必须落在 downloadDir 内部」钉死在这里最省心（storage/ 其它子目录也不行）。
  const final = assertInDownloadDir(finalAbs);
  await fsp.mkdir(path.dirname(final), { recursive: true });
  // Windows 上 rename 覆盖可能瞬时 EPERM（杀软/索引占用）→ 短重试
  for (let i = 0; i < 5; i += 1) {
    try {
      await fsp.rename(part, final);
      return final;
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'EPERM') {
        await fsp.rm(final, { force: true });
        continue;
      }
      if (e.code === 'ENOENT') break;
      throw new AppError('E_DISK', `落盘失败：${e.message}`, { part, final });
    }
  }
  throw new AppError('E_DISK', '落盘失败：多次重命名仍未成功', { part, final });
}

/** 计算文件 sha256（流式，避免大文件占内存） */
export async function sha256File(absPath) {
  const p = assertInScope(absPath);
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('error', (e) => reject(new AppError('E_DISK', `读取文件失败：${e.message}`, { path: p })));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 读文件头 n 字节 */
export async function readHead(absPath, n = 5) {
  const p = assertInScope(absPath);
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * 目录重扫与自愈（只扫 downloadDir 顶层，flat 布局 §20 D5）。
 * @param {{deep?:boolean}} [opts]
 * @returns {Promise<{scanned:number,present:number,missing:number,orphan:Array<{file:string,guessNo:string|null}>,adopted:number}>}
 */
export async function resyncStorage(opts = {}) {
  ensureDirs();
  const dir = config.download.downloadDir;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw new AppError('E_CONFLICT', `下载目录不可读：${dir}`, { reason: e.code || e.message });
  }
  const files = entries.filter((d) => d.isFile() && isPdfFilename(d.name)).map((d) => d.name);
  const scanned = files.length;

  let present = 0;
  let missing = 0;
  let adopted = 0;
  const orphan = [];
  const seen = new Set();

  const assets = all(
    `SELECT a.id, a.work_id, a.storage_rel_path, a.file_state, w.no
       FROM assets a JOIN works w ON w.id = a.work_id`,
  );

  const byNo = new Map(files.map((f) => [parseNoFromFilename(f), f]));

  tx(() => {
    for (const a of assets) {
      let abs = null;
      if (a.storage_rel_path) {
        try {
          abs = absFromRel(a.storage_rel_path);
        } catch {
          abs = null;
        }
      }
      const exists = abs && fs.existsSync(abs);
      const now = Date.now();
      if (exists) {
        present += 1;
        seen.add(path.basename(abs));
        if (a.file_state !== 'present') {
          run(`UPDATE assets SET file_state='present', missing_since=NULL, last_verified_at=?, updated_at=? WHERE id=?`, [now, now, a.id]);
        } else if (opts.deep) {
          run(`UPDATE assets SET last_verified_at=?, updated_at=? WHERE id=?`, [now, now, a.id]);
        }
      } else {
        // 文件不在原位：看看同编号文件是否还在目录里（可能被改名/重新下载）
        const candidate = byNo.get(a.no);
        if (candidate) {
          const candAbs = path.resolve(dir, candidate);
          assertInScope(candAbs);
          atomicUpdate(a.id, candidate, now);
          present += 1;
          adopted += 1;
          seen.add(candidate);
        } else {
          missing += 1;
          if (a.file_state !== 'missing') {
            run(`UPDATE assets SET file_state='missing', missing_since=?, updated_at=? WHERE id=?`, [now, now, a.id]);
          }
        }
      }
    }

    // 目录里存在但没有任何 assets 行指向的文件
    for (const f of files) {
      if (seen.has(f)) continue;
      const guessNo = parseNoFromFilename(f);
      const work = guessNo ? get('SELECT id FROM works WHERE no = ?', [guessNo]) : null;
      if (work) {
        // 有对应条目但没有 asset 行 → 直接认领（自愈，不产生孤儿）
        const now = Date.now();
        const existing = get('SELECT id FROM assets WHERE work_id=? AND kind=?', [work.id, 'pdf']);
        if (existing) {
          atomicUpdate(existing.id, f, now);
        } else {
          const size = safeSize(path.resolve(dir, f));
          run(
            `INSERT INTO assets(work_id, kind, storage_rel_path, file_size, file_state, extract_status, extract_version,
                                source, created_at, updated_at, last_verified_at)
             VALUES(?,?,?,?, 'present','pending',0, 'inbox', ?,?,?)`,
            [work.id, 'pdf', f, size, now, now, now],
          );
        }
        adopted += 1;
      } else {
        orphan.push({ file: f, guessNo });
      }
    }
  });

  log.info('resync.done', { scanned, present, missing, adopted, orphan: orphan.length });
  return { scanned, present, missing, orphan, adopted };
}

function atomicUpdate(assetId, relPath, now) {
  const size = safeSize(path.resolve(config.download.downloadDir, relPath));
  run(
    `UPDATE assets SET storage_rel_path=?, file_size=?, file_state='present', missing_since=NULL, last_verified_at=?, updated_at=? WHERE id=?`,
    [relPath, size, now, now, assetId],
  );
}

function safeSize(abs) {
  try {
    return fs.statSync(abs).size;
  } catch {
    return null;
  }
}

/**
 * 在系统文件管理器中定位文件（§20 D18 / §12.2 revealInOs）。
 * 参数经 spawn 数组传递，绝不经 shell 拼接。
 * @param {string} absPath
 */
export function revealInOs(absPath) {
  const p = assertInScope(absPath);
  return new Promise((resolve, reject) => {
    let cmd;
    let args;
    if (WIN) {
      cmd = 'explorer.exe';
      args = [`/select,${p}`];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = ['-R', p];
    } else {
      cmd = 'xdg-open';
      args = [path.dirname(p)];
    }
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: false });
      child.on('error', (e) => reject(new AppError('E_INTERNAL', `无法调起文件管理器：${e.message}`, { cmd })));
      child.unref();
      // explorer.exe 常以非 0 退出码返回，这里不判退出码，只确认能启动
      setTimeout(() => resolve({ ok: true, dir: path.dirname(p) }), 120);
    } catch (e) {
      reject(new AppError('E_INTERNAL', `无法调起文件管理器：${e.message}`, { cmd }));
    }
  });
}

/** 扫描 storage/inbox/ 下的 PDF（按文件名里的编号匹配条目） */
export async function scanInbox() {
  ensureDirs();
  let entries = [];
  try {
    entries = await fsp.readdir(paths.inboxDir, { withFileTypes: true });
  } catch (e) {
    throw new AppError('E_PATH_OUT_OF_SCOPE', `收件箱不可读：${paths.inboxDir}`, { reason: e.code });
  }
  const matched = [];
  const unmatched = [];
  for (const d of entries) {
    if (!d.isFile()) continue;
    if (!isPdfFilename(d.name)) continue;
    const no = parseNoFromFilename(d.name) || guessNoByTitle(d.name);
    if (no && get('SELECT id FROM works WHERE no = ?', [no])) matched.push({ no, file: d.name });
    else unmatched.push(d.name);
  }
  return { matched, unmatched };
}

/**
 * 文件名里没有 `no__` 前缀时的兜底：用标题相似度匹配条目。
 * 这是确定性字符串匹配（不做语义判断），命中不了就归到 unmatched 让人确认。
 */
function guessNoByTitle(file) {
  const base = path.basename(file, path.extname(file)).toLowerCase();
  const probe = slugify(base, { maxLen: 40 });
  if (!probe || probe.startsWith('zh')) return null;
  const rows = all("SELECT no, title FROM works WHERE retired = 0");
  for (const r of rows) {
    if (slugify(r.title, { maxLen: 40 }) === probe) return r.no;
  }
  return null;
}
