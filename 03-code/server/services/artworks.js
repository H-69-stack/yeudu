/**
 * 文献元数据服务（§5 / §8.2）。
 * 只做 works 的读、字段级局部更新（写 fields_locked）、聚合视图、统计。
 * 不碰文件系统、不碰网络（文件状态由 assets 表投影，由 storage.resync 维护）。
 */
import { all, get, run, tx } from '../db.js';
import { AppError } from '../errors.js';
import { EDITABLE_FIELDS, WORK_TYPES, normalizeArxiv, normalizeDoi, normalizeLink } from './importer.js';
import { buildRelPath } from './storage.js';
import { buildCacheKey } from './translate/cacheKey.js';
import { config } from '../config.js';

/** 数值排序表达式：按「段号.序号」两段整数排（不能用字符串排，否则 12.10 < 12.2） */
export const NO_ORDER_SQL = `CAST(substr(no,1,instr(no,'.')-1) AS INTEGER), CAST(substr(no,instr(no,'.')+1) AS INTEGER)`;

const BASE_SELECT = `
SELECT w.id, w.no, w.section_no, w.section, w.authors, w.title, w.year, w.venue, w.type, w.note,
       w.arxiv_id, w.doi, w.isbn, w.link, w.source_note, w.origin, w.fields_locked, w.retired,
       w.last_read_at, w.created_at, w.updated_at,
       a.id AS asset_id, a.storage_rel_path, a.file_size, a.page_count, a.file_state,
       a.extract_status, a.extract_version, a.extract_error, a.source AS asset_source,
       a.source_url, a.downloaded_at, a.last_verified_at,
       dj.id AS job_id, dj.status AS job_status, dj.error_code AS job_error,
       dj.error_message AS job_error_message, dj.attempts AS job_attempts,
       dj.bytes_done AS job_bytes_done, dj.bytes_total AS job_bytes_total,
       dj.next_retry_at AS job_next_retry_at, dj.source AS job_source, dj.url AS job_url,
       (SELECT count(*) FROM segments s WHERE s.asset_id = a.id AND s.is_math = 0 AND s.is_label = 0) AS seg_total,
       (SELECT count(*) FROM translations t WHERE t.asset_id = a.id AND t.extract_version = a.extract_version) AS tr_done
  FROM works w
  LEFT JOIN assets a ON a.work_id = w.id AND a.kind = 'pdf'
  LEFT JOIN download_jobs dj ON dj.id = (
    SELECT j.id FROM download_jobs j WHERE j.work_id = w.id
     ORDER BY (CASE WHEN j.status IN ('queued','resolving','downloading','verifying') THEN 0 ELSE 1 END), j.id DESC
     LIMIT 1)
`;

function mapSummary(row) {
  const fieldsLocked = safeJson(row.fields_locked, []);
  return {
    id: row.id,
    no: row.no,
    sectionNo: row.section_no,
    section: row.section,
    authors: row.authors,
    title: row.title,
    year: row.year,
    venue: row.venue,
    type: row.type,
    note: row.note,
    arxivId: row.arxiv_id,
    doi: row.doi,
    isbn: row.isbn,
    link: row.link,
    sourceNote: row.source_note,
    origin: row.origin,
    fieldsLocked,
    assetId: row.asset_id || null,
    fileState: row.asset_id ? row.file_state : 'absent',
    downloadStatus: mapDownloadStatus(row),
    extractStatus: row.asset_id ? row.extract_status : 'pending',
    job: row.job_id
      ? {
          jobId: row.job_id,
          status: row.job_status,
          errorCode: row.job_error,
          errorMessage: row.job_error_message,
          bytesDone: row.job_bytes_done,
          bytesTotal: row.job_bytes_total,
        }
      : null,
    translate: {
      done: row.tr_done || 0,
      total: row.seg_total || 0,
      engine: null,
    },
    pageCount: row.page_count,
    fileSize: row.file_size,
    lastReadAt: row.last_read_at,
  };
}

function mapDownloadStatus(row) {
  if (row.asset_id && row.file_state === 'present' && (!row.job_status || row.job_status === 'done')) return 'done';
  switch (row.job_status) {
    case 'queued':
    case 'resolving':
      return 'queued';
    case 'downloading':
    case 'verifying':
      return 'downloading';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'needs_manual':
      return 'needs_manual';
    default:
      return row.asset_id && row.file_state === 'present' ? 'done' : 'none';
  }
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 列表查询（一次查清，避免 N+1；§8.2 WorkSummary）。
 * @param {{q?:string, sectionNo?:number, type?:string, yearFrom?:number, yearTo?:number,
 *          hasPdf?:boolean, translateState?:string, sort?:string, order?:string,
 *          page?:number, pageSize?:number, includeRetired?:boolean}} p
 */
export function listWorks(p = {}) {
  const page = p.page || 1;
  const pageSize = Math.min(p.pageSize || 50, 200);
  const offset = (page - 1) * pageSize;

  const where = [];
  const params = [];
  if (!p.includeRetired) where.push('w.retired = 0');
  if (p.q) {
    const like = `%${p.q}%`;
    where.push(`(w.no LIKE ? OR w.title LIKE ? OR w.authors LIKE ? OR w.venue LIKE ? OR w.note LIKE ?
                 OR IFNULL(w.arxiv_id,'') LIKE ? OR IFNULL(w.doi,'') LIKE ? OR w.section LIKE ?)`);
    params.push(like, like, like, like, like, like, like, like);
  }
  if (p.sectionNo !== undefined) {
    where.push('w.section_no = ?');
    params.push(p.sectionNo);
  }
  if (p.type) {
    where.push('w.type = ?');
    params.push(p.type);
  }
  if (p.yearFrom !== undefined) {
    where.push('IFNULL(w.year, 0) >= ?');
    params.push(p.yearFrom);
  }
  if (p.yearTo !== undefined) {
    where.push('IFNULL(w.year, 9999) <= ?');
    params.push(p.yearTo);
  }
  if (p.hasPdf === true) where.push("a.file_state = 'present'");
  if (p.hasPdf === false) where.push("IFNULL(a.file_state,'absent') <> 'present'");
  // 「无开放源可自动下载」= 没有 arXiv 号 → 浏览器直传队列用它筛可人工采集的条目
  if (p.hasArxiv === true) where.push("IFNULL(w.arxiv_id,'') <> ''");
  if (p.hasArxiv === false) where.push("IFNULL(w.arxiv_id,'') = ''");

  const baseSql = `${BASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  // 派生过滤（引用子查询列，必须包一层）
  const derived = [];
  const derivedParams = [];
  if (p.translateState === 'none') derived.push('seg_total = 0');
  else if (p.translateState === 'partial') derived.push('tr_done > 0 AND tr_done < seg_total');
  else if (p.translateState === 'full') derived.push('seg_total > 0 AND tr_done >= seg_total');

  const wrapped = `SELECT * FROM (${baseSql})${derived.length ? ` WHERE ${derived.join(' AND ')}` : ''}`;

  const total = get(`SELECT count(*) AS n FROM (${wrapped})`, [...params, ...derivedParams]).n;

  const sortMap = {
    no: NO_ORDER_SQL,
    year: 'year',
    title: 'title',
    updated: 'updated_at',
  };
  const sortCol = sortMap[p.sort] || NO_ORDER_SQL;
  const dir = p.order === 'desc' ? 'DESC' : 'ASC';
  const rows = all(`${wrapped} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`, [
    ...params,
    ...derivedParams,
    pageSize,
    offset,
  ]);

  return { total, page, pageSize, items: rows.map(mapSummary) };
}

/** 专题列表（count 为未 retired 条数） */
export function listSections() {
  return all(
    `SELECT section_no AS sectionNo, section, count(*) AS count
       FROM works WHERE retired = 0
      GROUP BY section_no, section
      ORDER BY section_no ASC`,
  );
}

/** 取 works 行（camelCase，供下载器/resolver 使用） */
export function getWorkRow(no) {
  const row = get('SELECT * FROM works WHERE no = ?', [no]);
  if (!row) return null;
  return {
    ...row,
    sectionNo: row.section_no,
    arxivId: row.arxiv_id,
    sourceNote: row.source_note,
    fieldsLocked: safeJson(row.fields_locked, []),
    lastReadAt: row.last_read_at,
  };
}

/** 取工作条目详情（§8.2 WorkDetail） */
export function getWorkDetail(no) {
  const work = getWorkRow(no);
  if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });

  const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
  const job = get(
    `SELECT * FROM download_jobs WHERE work_id = ?
      ORDER BY (CASE WHEN status IN ('queued','resolving','downloading','verifying') THEN 0 ELSE 1 END), id DESC LIMIT 1`,
    [work.id],
  );
  const segTotal = asset
    ? get('SELECT count(*) AS n FROM segments WHERE asset_id = ? AND is_math = 0 AND is_label = 0', [asset.id]).n
    : 0;
  // 「已译」必须与「总段数」同口径：同一 asset + 最近一次任务的 engine/tgtLang + 当前 extract_version。
  // 否则换语言或重抽后会出现 done > total 的荒谬数字（跨语言缓存是分开的）。
  const lastTrJob = asset
    ? get('SELECT * FROM translate_jobs WHERE asset_id = ? ORDER BY id DESC LIMIT 1', [asset.id])
    : null;
  // 已译段数必须按「段 → 缓存键是否存在」来算，不能直接数 translations 行：
  // 内容寻址会把「完全相同的两段」合并成一行，数行会得到 done < total 的假缺口。
  let trDone = 0;
  if (asset && lastTrJob) {
    const keys = new Set(
      all('SELECT cache_key FROM translations WHERE asset_id = ? AND engine = ? AND tgt_lang = ? AND extract_version = ?', [
        asset.id,
        lastTrJob.engine,
        lastTrJob.tgt_lang,
        asset.extract_version,
      ]).map((r) => r.cache_key),
    );
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
  }
  const runningJob = asset
    ? get("SELECT id FROM translate_jobs WHERE asset_id = ? AND status IN ('queued','running','paused') LIMIT 1", [asset.id])
    : null;
  const lastChat = get('SELECT id FROM chats WHERE work_id = ? ORDER BY updated_at DESC LIMIT 1', [work.id]);

  return {
    work,
    asset: asset
      ? {
          id: asset.id,
          storageRelPath: asset.storage_rel_path,
          fileState: asset.file_state,
          fileSize: asset.file_size,
          fileSha256: asset.file_sha256,
          pageCount: asset.page_count,
          extractStatus: asset.extract_status,
          extractVersion: asset.extract_version,
          extractError: asset.extract_error,
          source: asset.source,
          sourceUrl: asset.source_url,
          downloadedAt: asset.downloaded_at,
          lastVerifiedAt: asset.last_verified_at,
        }
      : null,
    downloadJob: job
      ? {
          jobId: job.id,
          status: job.status,
          source: job.source,
          url: job.url,
          httpStatus: job.http_status,
          bytesDone: job.bytes_done,
          bytesTotal: job.bytes_total,
          attempts: job.attempts,
          errorCode: job.error_code,
          errorMessage: job.error_message,
          nextRetryAt: job.next_retry_at,
          startedAt: job.started_at,
          finishedAt: job.finished_at,
          createdAt: job.created_at,
        }
      : null,
    translateStats: asset
      ? {
          engine: lastTrJob ? lastTrJob.engine : null,
          tgtLang: config.translate.tgtLang,
          total: segTotal,
          done: trDone,
          failed: 0,
          runningJobId: runningJob ? runningJob.id : null,
        }
      : null,
    lastChatId: lastChat ? lastChat.id : null,
    // M1 未实现翻译引擎注册表（M2 交付），这里如实返回空列表而不是假造引擎
    availableTranslateOptions: { engines: [] },
  };
}

/**
 * 字段级局部更新（§20.2 D2 定案语义）。
 * 改值 → 自动加锁 + origin='local'；lock 只锁不改；unlock 解禁；lockAll 一键锁全字段。
 * @param {string} no
 * @param {Object} body
 */
export function patchWork(no, body = {}) {
  const work = get('SELECT * FROM works WHERE no = ?', [no]);
  if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });

  const locked = new Set(safeJson(work.fields_locked, []));
  const patch = {};
  const lockRequests = Array.isArray(body.lock) ? body.lock : [];
  const unlockRequests = Array.isArray(body.unlock) ? body.unlock : [];

  for (const apiField of Object.keys(EDITABLE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, apiField)) continue;
    const column = EDITABLE_FIELDS[apiField];
    let value = body[apiField];
    if (apiField === 'year') {
      if (value === null || value === '') value = null;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1000 || n > 2999) {
          throw new AppError('E_BAD_REQUEST', '年份必须是 1000–2999 的整数', { field: 'year', value });
        }
        value = n;
      }
    } else if (apiField === 'type') {
      if (!WORK_TYPES.includes(value)) {
        throw new AppError('E_BAD_REQUEST', `类型必须是 ${WORK_TYPES.join('/')} 之一`, { field: 'type', value });
      }
    } else if (apiField === 'link') {
      const normalized = value ? normalizeLink(value) : null;
      if (value && !normalized) throw new AppError('E_BAD_REQUEST', '链接必须是 http(s) 绝对地址', { field: 'link' });
      value = normalized;
    } else if (apiField === 'arxivId') {
      value = value ? normalizeArxiv(value) : null;
    } else if (apiField === 'doi') {
      value = value ? normalizeDoi(value) : null;
    } else {
      value = value === null || value === undefined ? '' : String(value).trim();
    }
    patch[column] = value;
    locked.add(apiField);
  }

  for (const f of lockRequests) if (EDITABLE_FIELDS[f]) locked.add(f);
  for (const f of unlockRequests) locked.delete(f);
  if (body.lockAll === true) for (const f of Object.keys(EDITABLE_FIELDS)) locked.add(f);

  // 只要这次请求表达了「本地权威」（改值 / 主动加锁 / 整行锁定），origin 就置 local；
  // 单独 unlock 不改 origin（它只是让 CSV 重新有覆盖权，不代表放弃本地来源标记）
  const touchedLocally = Object.keys(patch).length > 0 || lockRequests.length > 0 || body.lockAll === true;

  const now = Date.now();
  tx(() => {
    const sets = [];
    const params = [];
    for (const [column, value] of Object.entries(patch)) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
    sets.push('fields_locked = ?');
    params.push(JSON.stringify([...locked].sort()));
    if (touchedLocally) sets.push("origin = 'local'");
    sets.push('updated_at = ?');
    params.push(now);
    run(`UPDATE works SET ${sets.join(', ')} WHERE id = ?`, [...params, work.id]);
  });

  return getWorkDetail(no);
}

/** 已下载文件的建议文件名（前端「另存为」/详情页展示用） */
export function suggestFileName(work) {
  return buildRelPath(work);
}

/** GET /api/stats（§8.6） */
export function getStats() {
  const works = get('SELECT count(*) AS n FROM works WHERE retired = 0').n;
  const withPdf = get("SELECT count(*) AS n FROM assets WHERE file_state = 'present'").n;
  const needsManual = get(
    `SELECT count(DISTINCT work_id) AS n FROM download_jobs WHERE status = 'needs_manual'`,
  ).n;
  const translatedWorks = get('SELECT count(DISTINCT asset_id) AS n FROM translations').n;
  const segments = get('SELECT count(*) AS n FROM segments').n;
  const cachedSegments = get('SELECT count(*) AS n FROM translations').n;
  const hits = get('SELECT IFNULL(sum(hits),0) AS n FROM translations').n;
  const cacheHitRate = cachedSegments + hits > 0 ? hits / (hits + cachedSegments) : 0;
  const chatTokens = get(
    'SELECT IFNULL(sum(IFNULL(prompt_tokens,0) + IFNULL(completion_tokens,0)),0) AS n FROM messages',
  ).n;
  const jobs = get('SELECT count(*) AS n FROM download_jobs').n;
  const activeJobs = get(
    "SELECT count(*) AS n FROM download_jobs WHERE status IN ('queued','resolving','downloading','verifying')",
  ).n;
  return {
    works,
    withPdf,
    needsManual,
    translatedWorks,
    segments,
    cachedSegments,
    cacheHitRate,
    tokens: { translate: 0, chat: chatTokens },
    downloadJobs: jobs,
    activeJobs,
  };
}

/** 标识符精确查找（浏览器直传脚本用；DOI / arXiv 任一命中即可，§浏览器桥） */
export function lookupWorkByIdentifiers({ doi, arxiv } = {}) {
  const nd = normalizeDoi(doi);
  const na = normalizeArxiv(arxiv);
  if (/^10\.\d{4,9}\//.test(String(nd || '')) === false) {
    // 允许非 DOI 形态归一为 null（如页面只给 URL），但不能拿半截字符串去 LIKE
    if (nd && !/^10\./.test(nd)) throw new AppError('E_BAD_REQUEST', `DOI 形态不合法：${nd}`, { field: 'doi', value: nd });
  }
  const clauses = [];
  const args = [];
  if (nd) { clauses.push('doi = ?'); args.push(nd); }
  if (na) { clauses.push('arxiv_id = ?'); args.push(na); }
  if (!clauses.length) {
    throw new AppError('E_BAD_REQUEST', '需要至少一个可归一的 doi 或 arxiv 标识符', { fields: ['doi', 'arxiv'] });
  }
  const w = get(
    `SELECT no, title, authors, year, venue, type, doi, arxiv_id
       FROM works WHERE retired = 0 AND (${clauses.join(' OR ')})
      LIMIT 1`,
    args,
  );
  if (!w) return { found: false, matched: { doi: nd, arxiv: na } };
  const asset = get(
    `SELECT id, file_state, page_count, file_size, extract_status, extract_version
       FROM assets WHERE work_id = ? AND kind = 'pdf'`,
    [get('SELECT id FROM works WHERE no = ?', [w.no]).id],
  );
  return {
    found: true,
    work: { no: w.no, title: w.title, authors: w.authors, year: w.year, venue: w.venue, type: w.type, doi: w.doi, arxivId: w.arxiv_id },
    asset: asset
      ? { id: asset.id, fileState: asset.file_state, pageCount: asset.page_count, fileSize: asset.file_size, extractStatus: asset.extract_status, extractVersion: asset.extract_version }
      : null,
    matched: { doi: nd, arxiv: na },
  };
}
