/**
 * 导入器（§5 / §7.1 / §20 D2 / §20.2）。
 * 输入：Agent工作流文献清单.csv（utf-8-sig，13 列 × 424 行）—— 唯一导入快照。
 * 输出：works 表 upsert + diff 报告。
 *
 * 边界：不删行（消失的标 retired=1）、不改 CSV、不写 build/ 目录。
 * 冲突策略：字段级锁（fields_locked）——被用户改过的字段重导入时跳过，并计入 skippedLocked。
 */
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx } from '../db.js';
import { createLogger } from '../logger.js';
import { config, defaultCsvPath } from '../config.js';

const log = createLogger('importer');

export const WORK_TYPES = ['期刊', '会议', '专著', '预印本', '非同行评审'];

/** CSV 表头 → 内部字段（顺序即 13 列顺序，用于表头缺失时的兜底） */
const COLUMNS = [
  { csv: '编号', field: 'no' },
  { csv: '专题', field: 'sectionRaw' },
  { csv: '作者', field: 'authors' },
  { csv: '标题', field: 'title' },
  { csv: '年份', field: 'year' },
  { csv: '出处', field: 'venue' },
  { csv: '类型', field: 'type' },
  { csv: '贡献定位', field: 'note' },
  { csv: 'arXiv编号', field: 'arxivId' },
  { csv: 'DOI', field: 'doi' },
  { csv: 'ISBN', field: 'isbn' },
  { csv: '链接', field: 'link' },
  { csv: '数据来源', field: 'sourceNote' },
];

/** 用户可编辑、可加锁的字段 ↔ DB 列（PATCH 与导入共用一张表，避免两处语义漂移） */
export const EDITABLE_FIELDS = {
  authors: 'authors',
  title: 'title',
  year: 'year',
  venue: 'venue',
  type: 'type',
  note: 'note',
  arxivId: 'arxiv_id',
  doi: 'doi',
  isbn: 'isbn',
  link: 'link',
  sourceNote: 'source_note',
};

/** RFC4180 解析（支持引号内逗号/换行/双引号转义；BOM 已在外层剥除） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/** 归一化 arXiv 编号：去 `arXiv:` 前缀与 vN 后缀，转小写（§7.1） */
export function normalizeArxiv(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let out = s.replace(/^arxiv\s*:\s*/i, '').trim();
  out = out.replace(/v\d+$/i, '');
  out = out.toLowerCase();
  return out || null;
}

/** 归一化 DOI：去 https://doi.org/ 前缀，转小写（§7.1） */
export function normalizeDoi(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi\s*:\s*/i, '').trim().toLowerCase() || null;
}

/** 归一化链接：必须 http(s):// 才入库（§7.1） */
export function normalizeLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/** 年份：parseInt 失败置 NULL（不阻断） */
export function normalizeYear(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /(\d{4})/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1000 && n <= 2999 ? n : null;
}

/** 专题列 `4 LLM Agent 工作流：...` → {sectionNo:4, section:'4 LLM ...'} */
export function normalizeSection(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d+)\s+(.*)$/.exec(s);
  if (!m) return { sectionNo: 0, section: s, warning: '专题列缺少序号前缀' };
  return { sectionNo: Number(m[1]), section: s };
}

/**
 * 读 CSV → 归一化记录数组 + 告警。
 * @param {string} [csvPath]
 * @returns {{records:any[], warnings:Array<{no:string,field:string,reason:string}>, csvPath:string}}
 */
export function readCsvRecords(csvPath = defaultCsvPath()) {
  const buf = fs.readFileSync(csvPath);
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`CSV 为空：${csvPath}`);
  const header = rows[0].map((h) => String(h).trim());
  const indexOf = (name) => {
    const i = header.indexOf(name);
    return i >= 0 ? i : COLUMNS.findIndex((c) => c.csv === name);
  };
  const idx = Object.fromEntries(COLUMNS.map((c) => [c.field, indexOf(c.csv)]));

  const warnings = [];
  const records = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const getCell = (field) => {
      const i = idx[field];
      return i >= 0 && i < cells.length ? String(cells[i] ?? '').trim() : '';
    };
    const no = getCell('no');
    if (!W_NO.test(no)) {
      warnings.push({ no: no || `第 ${r + 1} 行`, field: 'no', reason: `编号格式不是 "段号.序号"：${no || '(空)'}` });
      continue;
    }
    const section = normalizeSection(getCell('sectionRaw'));
    if (section.warning) warnings.push({ no, field: 'section', reason: section.warning });

    const rawType = getCell('type');
    if (rawType && !WORK_TYPES.includes(rawType)) {
      warnings.push({ no, field: 'type', reason: `类型不在 5 值枚举内：${rawType}（按原文入库）` });
    }
    const rawYear = getCell('year');
    const year = normalizeYear(rawYear);
    if (rawYear && year === null) warnings.push({ no, field: 'year', reason: `年份无法解析：${rawYear}` });

    const rawLink = getCell('link');
    const link = normalizeLink(rawLink);
    if (rawLink && !link) warnings.push({ no, field: 'link', reason: `链接不是 http(s) 绝对地址：${rawLink}` });

    records.push({
      no,
      sectionNo: section.sectionNo,
      section: section.section,
      authors: getCell('authors'),
      title: getCell('title'),
      year,
      venue: getCell('venue'),
      type: rawType,
      note: getCell('note'),
      arxivId: normalizeArxiv(getCell('arxivId')),
      doi: normalizeDoi(getCell('doi')),
      isbn: getCell('isbn') || null,
      link,
      sourceNote: getCell('sourceNote'),
    });
  }
  return { records, warnings, csvPath };
}

const W_NO = /^\d+\.\d+$/;

const SELECT_EXISTING = `SELECT * FROM works WHERE no = ?`;

/**
 * 导入主入口。
 * @param {{mode?:'dry-run'|'merge', csvPath?:string}} [opts]
 * @returns {{mode:string, csvPath:string, added:number, updated:number, unchanged:number,
 *            retired:number, revived:number, skippedLocked:Array<{no:string,field:string}>,
 *            warnings:Array<{no:string,field:string,reason:string}>, totalRecords:number,
 *            withArxiv:number, sections:number}}
 */
export function importWorks(opts = {}) {
  const mode = opts.mode === 'merge' ? 'merge' : 'dry-run';
  const { records, warnings, csvPath } = readCsvRecords(opts.csvPath || defaultCsvPath());
  const now = Date.now();

  const report = {
    mode,
    csvPath,
    added: 0,
    updated: 0,
    unchanged: 0,
    retired: 0,
    revived: 0,
    skippedLocked: [],
    warnings,
    totalRecords: records.length,
    withArxiv: records.filter((r) => r.arxivId).length,
    sections: new Set(records.map((r) => r.sectionNo)).size,
  };

  const apply = () => {
    const seenNo = new Set();
    for (const rec of records) {
      seenNo.add(rec.no);
      const existing = get(SELECT_EXISTING, [rec.no]);
      if (!existing) {
        report.added += 1;
        if (mode !== 'merge') continue;
        run(
          `INSERT INTO works(no, section_no, section, authors, title, year, venue, type, note,
                             arxiv_id, doi, isbn, link, source_note, origin, fields_locked, retired,
                             created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'import', '[]', 0, ?, ?)`,
          [
            rec.no, rec.sectionNo, rec.section, rec.authors, rec.title, rec.year, rec.venue, rec.type, rec.note,
            rec.arxivId, rec.doi, rec.isbn, rec.link, rec.sourceNote, now, now,
          ],
        );
        continue;
      }

      const locked = parseLocked(existing.fields_locked);
      const patch = {};
      for (const [apiField, column] of Object.entries(EDITABLE_FIELDS)) {
        if (!(apiField in rec)) continue;
        const next = rec[apiField] === undefined ? null : rec[apiField];
        const prev = existing[column] === undefined ? null : existing[column];
        if (normEq(prev, next)) continue;
        if (locked.includes(apiField)) {
          report.skippedLocked.push({ no: rec.no, field: apiField });
          continue;
        }
        patch[column] = next;
      }
      // 专题序号/全称不参与字段级锁：它们由 CSV 结构决定，且改了会让列表分组错乱
      if (existing.section_no !== rec.sectionNo) patch.section_no = rec.sectionNo;
      if (existing.section !== rec.section) patch.section = rec.section;

      const needsRevive = existing.retired === 1;
      if (needsRevive) {
        patch.retired = 0;
        report.revived += 1;
      }
      if (Object.keys(patch).length === 0) {
        report.unchanged += 1;
        continue;
      }
      report.updated += 1;
      if (mode !== 'merge') continue;
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      run(`UPDATE works SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), now, existing.id]);
    }

    // 消失的行：标 retired（不删）
    const gone = all("SELECT id, no FROM works WHERE retired = 0 AND origin = 'import'").filter((w) => !seenNo.has(w.no));
    report.retired = gone.length;
    if (mode === 'merge') {
      for (const w of gone) run('UPDATE works SET retired = 1, updated_at = ? WHERE id = ?', [now, w.id]);
    }
  };

  if (mode === 'merge') tx(apply);
  else apply();

  log.info('import.done', {
    mode,
    added: report.added,
    updated: report.updated,
    unchanged: report.unchanged,
    retired: report.retired,
    skippedLocked: report.skippedLocked.length,
    warnings: report.warnings.length,
    total: report.totalRecords,
  });
  return report;
}

function parseLocked(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function normEq(a, b) {
  const na = a === undefined || a === null || a === '' ? null : String(a);
  const nb = b === undefined || b === null || b === '' ? null : String(b);
  return na === nb;
}

/** CLI 用：把 diff 报告渲染成人读文本 */
export function formatReport(report) {
  const lines = [];
  lines.push(`导入模式：${report.mode === 'merge' ? 'merge（写盘）' : 'dry-run（只报告，不写盘）'}`);
  lines.push(`CSV：${report.csvPath}`);
  lines.push(`记录数：${report.totalRecords}（含 arXiv：${report.withArxiv}，专题数：${report.sections}）`);
  lines.push(`新增：${report.added}　更新：${report.updated}　未变：${report.unchanged}　退休：${report.retired}　复活：${report.revived}`);
  lines.push(`锁定跳过：${report.skippedLocked.length}`);
  for (const s of report.skippedLocked.slice(0, 20)) lines.push(`  - ${s.no} :: ${s.field}`);
  lines.push(`告警：${report.warnings.length}`);
  for (const w of report.warnings.slice(0, 20)) lines.push(`  - ${w.no} :: ${w.field} :: ${w.reason}`);
  return lines.join('\n');
}

export { config };
