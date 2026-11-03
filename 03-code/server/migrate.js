/**
 * user_version 递增迁移（§19 第 16 条：只前滚、schema.sql 为唯一事实源）。
 *
 * v1 = 全量 DDL（7 张表 + segments_fts），M1/M2 使用。
 * v2 = M3（D22）：
 *      ｜ translations_fts（**rowid = segments.id**）
 *      ｜ translations.segment_id（增量写入直接带上；回填按三元组，且只回填版本一致的行）
 *      ｜ chats.summary / chats.summary_upto（D13 滚动摘要）
 *      ｜ messages.truncated（SSE 中断保留）/ messages.retrieval_miss（0 命中落库，UI 必须显示）
 *      ｜ 一次全量回填 + **断言**（索引行数 == 当前引擎/语言下已译段数、抽样含汉字），不满足即整事务回滚
 *
 * 新库（user_version=0）：直接跑 schema.sql（已含 v2 全部对象，版本写成 2）。
 * 老库：按 MIGRATIONS 逐级补齐；每级在一个事务里跑，失败回滚并抛错（进程非 0 退出）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, all, get, userVersion, backupTo, tx } from './db.js';
import { createLogger } from './logger.js';
import { config, paths } from './config.js';
import {
  backfillTranslationIndex,
  expectedTranslationIndexCount,
  translationIndexCount,
  sampleTranslationIndexHasHanzi,
  activeTranslationTarget,
} from './services/fts.js';

const log = createLogger('migrate');
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const TARGET_VERSION = 4;

function addColumnIfMissing(table, column, ddl) {
  const cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (cols.includes(column)) return false;
  exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  log.info('migrate.add_column', { table, column });
  return true;
}

/** 按 (asset_id, page_no, ord) 回填 translations.segment_id，只回填与 asset 当前 extract_version 一致的行 */
function backfillSegmentIds() {
  exec(`
    UPDATE translations
       SET segment_id = (
         SELECT s.id
           FROM segments s
           JOIN assets a ON a.id = s.asset_id
          WHERE s.asset_id = translations.asset_id
            AND s.page_no = translations.page_no
            AND s.ord = translations.ord
            AND a.extract_version = translations.extract_version
          LIMIT 1
       )
     WHERE segment_id IS NULL
  `);
  const backfilled = get('SELECT count(*) AS n FROM translations WHERE segment_id IS NOT NULL').n;
  const skippedStale = get(
    `SELECT count(*) AS n FROM translations t JOIN assets a ON a.id = t.asset_id
      WHERE t.segment_id IS NULL AND t.extract_version <> a.extract_version`,
  ).n;
  const skippedUnmapped = get(
    `SELECT count(*) AS n FROM translations t JOIN assets a ON a.id = t.asset_id
      WHERE t.segment_id IS NULL AND t.extract_version = a.extract_version`,
  ).n;
  return { backfilled, skippedStale, skippedUnmapped };
}

/**
 * 按当前生效引擎/语言重建译文索引（rowid = segments.id）。
 * 走 backfillTranslationIndex：它会按「同资产同文本」把共用一条译文的所有段都补上索引
 * （内容寻址下 translations 行数 < 段数，只按行索引会漏段）。
 */
function rebuildTranslationIndex() {
  const active = activeTranslationTarget();
  exec('DELETE FROM translations_fts');
  const bf = backfillTranslationIndex({ engine: active.engine, tgtLang: active.tgtLang });
  const rows = get(
    'SELECT count(*) AS n FROM translations WHERE segment_id IS NOT NULL AND engine = ? AND tgt_lang = ?',
    [active.engine, active.tgtLang],
  ).n;
  return {
    engine: active.engine,
    tgtLang: active.tgtLang,
    indexed: bf.indexed,
    distinct: bf.expected,
    rows,
  };
}

/**
 * 迁移断言（不满足 → 调用方整事务回滚）：
 *  ① 索引行数 == 当前引擎/语言下「已译段数」（distinct segment_id）
 *  ② 抽样 3 条索引内容含汉字（防止「索引里是英文却声称索引了译文」）
 */
function assertMigration(stats, indexStats) {
  if (indexStats.distinct === 0) {
    // 没有任何可索引译文时不做汉字抽样（新库/未翻译库都合法）
    return { checked: false, reason: 'no-active-translations' };
  }
  // 断言口径：索引行数 == 「当前引擎/语言下有译文的段数」（不是 translations 行数：内容寻址会合并同文本段）
  const expected = expectedTranslationIndexCount(indexStats.engine, indexStats.tgtLang);
  const actual = translationIndexCount();
  if (actual !== expected) {
    throw new Error(
      `迁移断言失败：translations_fts=${actual}，应为 ${expected}（当前 ${indexStats.engine}/${indexStats.tgtLang}）；` +
        `回填统计 ${JSON.stringify(stats)}`,
    );
  }
  const sample = sampleTranslationIndexHasHanzi(20, 3);
  if (!sample.ok) {
    throw new Error(`迁移断言失败：抽样 ${sample.sampled} 条索引，仅 ${sample.withHanzi} 条含汉字 —— 索引内容不是译文`);
  }
  return { checked: true, sample };
}

const MIGRATIONS = [
  {
    version: 2,
    describe:
      'translations_fts(rowid=segments.id) + translations.segment_id + chats.summary(+列) + messages.truncated/retrieval_miss + 回填',
    run() {
      // 旧开发库可能已有「错误结构」的 translations_fts（列里带 segment_id）：先删再建，避免列集漂移
      exec('DROP TABLE IF EXISTS translations_fts');
      exec(`CREATE VIRTUAL TABLE IF NOT EXISTS translations_fts USING fts5(
              engine UNINDEXED, tgt_lang UNINDEXED, text,
              tokenize = 'unicode61 remove_diacritics 2')`);
      addColumnIfMissing('translations', 'segment_id', 'INTEGER');
      addColumnIfMissing('chats', 'summary', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing('chats', 'summary_upto', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('messages', 'truncated', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('messages', 'retrieval_miss', 'INTEGER NOT NULL DEFAULT 0');

      const stats = backfillSegmentIds();
      const indexStats = rebuildTranslationIndex();
      const assertion = assertMigration(stats, indexStats);
      log.info('migrate.v2.backfill', { ...stats, ...indexStats, assertion });
      return { ...stats, ...indexStats, assertion };
    },
  },
  {
    version: 3,
    describe: 'messages.tool_calls/attachments（tools 引擎的工具调用日志与图片引用）',
    run() {
      // 只加列，不动既有数据：老消息的 tool_calls 默认 '[]'，读到就是「这一轮没调工具」
      const added = {
        tool_calls: addColumnIfMissing('messages', 'tool_calls', "TEXT NOT NULL DEFAULT '[]'"),
        attachments: addColumnIfMissing('messages', 'attachments', "TEXT NOT NULL DEFAULT '[]'"),
      };
      log.info('migrate.v3.columns', added);
      return added;
    },
  },
  {
    version: 4,
    describe: 'segments.role/tier/align/ratio（版面角色与排版层级，AI 精排与启发式判定共用）',
    run() {
      // 只加列，不回填：已有段落 role/tier 为空，前端按 is_heading 兜底；下次重抽或点「精排」即填充
      const added = {
        role: addColumnIfMissing('segments', 'role', 'TEXT'),
        tier: addColumnIfMissing('segments', 'tier', 'TEXT'),
        align: addColumnIfMissing('segments', 'align', 'TEXT'),
        ratio: addColumnIfMissing('segments', 'ratio', 'REAL'),
        gapPct: addColumnIfMissing('segments', 'gap_pct', 'REAL'),
      };
      log.info('migrate.v4.columns', added);
      return added;
    },
  },
];

/** v3 的形状自检（版本号已是 3 但列缺失时补跑） */
export function schemaNeedsV3() {
  const cols = all('PRAGMA table_info(messages)').map((c) => c.name);
  if (!cols.length) return false; // 空库：交给 schema.sql
  return !cols.includes('tool_calls') || !cols.includes('attachments');
}

/** v4 的形状自检（segments 缺少 role/tier/align/ratio 时补跑） */
export function schemaNeedsV4() {
  const cols = all('PRAGMA table_info(segments)').map((c) => c.name);
  if (!cols.length) return false; // 空库：交给 schema.sql
  return !cols.includes('role') || !cols.includes('tier') || !cols.includes('align') || !cols.includes('ratio') || !cols.includes('gap_pct');
}

/** v2 的形状自检（开发期 v2 被修订过：老库可能版本号已是 2 但列不对） */
export function schemaNeedsV2() {
  const cols = (t) => {
    try {
      return all(`PRAGMA table_info(${t})`).map((c) => c.name);
    } catch {
      return [];
    }
  };
  if (!cols('translations').includes('segment_id')) return true;
  if (cols('messages').length && !cols('messages').includes('retrieval_miss')) return true;
  if (cols('chats').length && !cols('chats').includes('summary_upto')) return true;
  // 老结构里 translations_fts 有 segment_id 列；新结构只有 engine/tgt_lang/text
  const ftsCols = cols('translations_fts');
  if (ftsCols.length && ftsCols.includes('segment_id')) return true;
  return false;
}

/**
 * @returns {{from:number, to:number, applied:boolean, backupFile:string|null, steps:string[], report:Object|null}}
 */
export function migrate() {
  const from = userVersion();
  // 形状自检分版本：v2 的形状问题要从 v1 重跑，v3 的只补 v3（不白跑一遍回填）
  const repairV2 = from >= 2 && schemaNeedsV2();
  const repairV3 = from >= 3 && schemaNeedsV3();
  const repairV4 = from >= 4 && schemaNeedsV4();
  const repair = from >= TARGET_VERSION && (repairV2 || repairV3 || repairV4);
  if (from >= TARGET_VERSION && !repair) {
    log.info('migrate.skip', { from, target: TARGET_VERSION });
    return { from, to: from, applied: false, backupFile: null, steps: [], report: null };
  }
  if (repair) {
    log.warn('migrate.repair_shape', {
      from,
      reason: repairV2 ? 'v2 结构不符，补跑 v2 及以上' : 'v3 结构不符，补跑 v3',
    });
  }
  let backupFile = null;
  if (from > 0) {
    // 升级已有库：先在线备份（保留审计与回滚可能）
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    backupFile = backupTo(path.join(paths.dataDir, 'backup', `app-${stamp}-v${from}.db`));
    log.info('migrate.backup', { backupFile });
  }

  const steps = [];
  // 结构不符时回退起点：v2 坏了从 v1 起跳，只有 v3 坏了从 v2 起跳
  let current = repair ? (repairV2 ? 1 : 2) : from;
  let report = null;

  if (current === 0) {
    // 新库：schema.sql 已含所有版本的对象，并自带 user_version = TARGET_VERSION
    exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
    current = userVersion();
    steps.push(`schema.sql → v${current}`);
  }

  for (const m of MIGRATIONS) {
    if (current >= m.version) continue;
    // 整级迁移放在一个事务里：断言失败 → 回滚 → 抛错（进程非 0 退出），绝不留下半迁移状态
    const result = tx(() => {
      const r = m.run();
      exec(`PRAGMA user_version = ${m.version}`);
      return r;
    });
    report = result;
    current = m.version;
    steps.push(`v${m.version}: ${m.describe}`);
  }
  log.info('migrate.apply', { from, to: current, steps, ...(report ? { report } : {}) });
  return { from, to: current, applied: true, backupFile, steps, report };
}

/** 当前库版本 */
export function currentVersion() {
  return get('PRAGMA user_version').user_version;
}

/** 供 CLU/自测读：当前生效引擎/语言（迁移断言口径） */
export function migrationTarget() {
  return { engine: config.translate.engine, tgtLang: config.translate.tgtLang };
}
