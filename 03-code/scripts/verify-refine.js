/**
 * 临时验证脚本：跑一页 AI 精排 dry-run（不写库），确认精排通道（refineEngine=deepseek）可用。
 * 用法：node scripts/verify-refine.js [assetId]
 */
import { loadConfig, applyDbSettings } from '../server/config.js';
import { openDb, closeDb, all } from '../server/db.js';
import { refineWork } from '../server/services/layout/refine.js';

const cfg = loadConfig();
openDb(cfg.server.dbPath);
applyDbSettings(all);

const assetId = Number(process.argv[2] || 1);
const model = process.argv[3] || undefined;
const out = await refineWork(assetId, {
  maxPages: 1,
  dryRun: true,
  model,
  onProgress: (s) => console.log('[progress]', s),
});
console.log(
  JSON.stringify(
    {
      assetId: out.assetId,
      requested: out.requested,
      applied: out.applied,
      pages: out.pages,
      errors: out.errors,
      changedSample: out.changed.slice(0, 8),
      roleCounts: out.changed.reduce((m, c) => ((m[c.role] = (m[c.role] || 0) + 1), m), {}),
    },
    null,
    1,
  ),
);
closeDb();
