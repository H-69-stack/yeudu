#!/usr/bin/env node
/**
 * `npm run fts:rebuild` —— 重建 FTS 索引（原文 + 译文）。
 * 用途：v2 升级后把 M2 期间已存在的译文补进 translations_fts；或怀疑索引坏掉时重来一遍。
 * 用法：node server/cli/fts-rebuild.js [assetId]
 */
import { loadConfig, applyDbSettings, ensureDirs, paths } from '../config.js';
import { openDb, closeDb, all } from '../db.js';
import { migrate } from '../migrate.js';
import { initLogger } from '../logger.js';
import { indexSegments, deleteIndexForAsset, backfillTranslationIndex } from '../services/fts.js';

const cfg = loadConfig();
ensureDirs();
initLogger({ logDir: paths.logDir, logLevel: cfg.server.logLevel });
openDb(cfg.server.dbPath);
// 迁移/回填要用「运行时生效配置」（引擎、目标语言来自 settings 表），必须先合并 settings
applyDbSettings(all);
const mig = migrate();
console.log(`DB 版本：v${mig.from} → v${mig.to}${mig.steps.length ? ` (${mig.steps.join('; ')})` : ''}`);
if (mig.report) {
  const r = mig.report;
  console.log(
    `迁移回填：backfilled=${r.backfilled} skippedStale=${r.skippedStale} skippedUnmapped=${r.skippedUnmapped}`,
  );
  console.log(
    `译文索引：indexed=${r.indexed} distinct=${r.distinct}（engine=${r.engine} / tgt=${r.tgtLang}）断言=${JSON.stringify(r.assertion)}`,
  );
}

const assetId = process.argv[2] ? Number(process.argv[2]) : null;
const assets = assetId
  ? all('SELECT id FROM assets WHERE id = ?', [assetId])
  : all("SELECT id FROM assets WHERE extract_status = 'ready'");

let total = 0;
for (const a of assets) {
  const segs = all(
    'SELECT id, text, is_math, is_label FROM segments WHERE asset_id = ? AND is_math = 0 AND is_label = 0 ORDER BY page_no, ord',
    [a.id],
  );
  deleteIndexForAsset(a.id);
  indexSegments(a.id, segs.map((s) => ({ id: s.id, text: s.text })));
  total += segs.length;
  console.log(`asset ${a.id}: 原文索引 ${segs.length} 段`);
}
const bf = backfillTranslationIndex(assetId);
console.log(`译文索引backfill：应索引 ${bf.expected}、写入 ${bf.indexed}、跳过 ${bf.skipped}`);
console.log(`原文索引合计 ${total} 段`);
closeDb();
