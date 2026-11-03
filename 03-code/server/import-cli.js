#!/usr/bin/env node
/**
 * `npm run import` 的入口（M1 唯一数据入口）。
 * 用法：
 *   npm run import            # merge（写盘）
 *   npm run import:dry        # dry-run（只报告 diff）
 *   node server/import-cli.js --dry-run --csv "D:/path/to.csv"
 */
import { loadConfig, applyDbSettings, ensureDirs, defaultCsvPath, paths } from './config.js';
import { openDb, closeDb, all } from './db.js';
import { migrate } from './migrate.js';
import { initLogger } from './logger.js';
import { importWorks, formatReport } from './services/importer.js';

function parseArgs(argv) {
  const out = { mode: 'merge', csvPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.mode = 'dry-run';
    else if (a === '--merge') out.mode = 'merge';
    else if (a === '--csv') {
      out.csvPath = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
ensureDirs();
initLogger({ logDir: paths.logDir, logLevel: cfg.server.logLevel });
openDb(cfg.server.dbPath);
migrate();
applyDbSettings(all);

const report = importWorks({ mode: args.mode, csvPath: args.csvPath || defaultCsvPath() });
process.stdout.write(`${formatReport(report)}\n`);

const counts = `库内合计：works=${all('SELECT count(*) AS n FROM works')[0].n}` +
  `　arxiv_id 非空=${all('SELECT count(*) AS n FROM works WHERE arxiv_id IS NOT NULL')[0].n}` +
  `　专题=${all('SELECT count(DISTINCT section_no) AS n FROM works')[0].n}\n`;
process.stdout.write(counts);

closeDb();
process.exit(0);
