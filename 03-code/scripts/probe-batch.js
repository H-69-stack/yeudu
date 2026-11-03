/**
 * 诊断脚本：把某一批原文按管线同样的 prompt 发一次，打印模型原始返回，
 * 用于判断「编号错位」是模型合并条目导致的，还是解析器的问题。
 * 用法：node scripts/probe-batch.js <assetId> <pageNo> <fromOrd> <count>
 */
import { loadConfig, applyDbSettings } from '../server/config.js';
import { openDb, closeDb, all, get } from '../server/db.js';
import { openaiChat } from '../server/services/llm/client.js';
import { buildNumberedPrompt } from '../server/services/segment.js';
import { NUMBERING_INSTRUCTION, renderPrompt, resolveTemplate } from '../server/services/translate/prompts.js';
import { resolveModel } from '../server/services/translate/engines/registry.js';

const cfg = loadConfig();
openDb(cfg.server.dbPath);
applyDbSettings(all);

const assetId = Number(process.argv[2] || 4);
const pageNo = Number(process.argv[3] || 1);
const fromOrd = Number(process.argv[4] || 8);
const count = Number(process.argv[5] || 6);

const work = get('SELECT w.title, w.note FROM works w JOIN assets a ON a.work_id = w.id WHERE a.id = ?', [assetId]);
const rows = all(
  'SELECT ord, text FROM segments WHERE asset_id = ? AND page_no = ? AND is_math = 0 AND is_label = 0 ORDER BY ord',
  [assetId, pageNo],
).slice(fromOrd, fromOrd + count);
const items = rows.map((r) => r.text);

const template = resolveTemplate(cfg);
const numbered = buildNumberedPrompt(items);
const prompt = renderPrompt({ template, sourceText: numbered, srcLang: 'auto', tgtLang: 'zh-CN', work }) + NUMBERING_INSTRUCTION;

console.log('=== ITEMS (' + items.length + ') ===');
items.forEach((t, i) => console.log(`[${i + 1}] ${t.replace(/\s+/g, ' ').slice(0, 160)}`));
console.log('\n=== PROMPT HEAD ===\n' + prompt.slice(0, 400));
const out = await openaiChat({ provider: cfg.translate.engine, model: resolveModel(cfg.translate.engine), messages: [{ role: 'user', content: prompt }], temperature: 0.3, maxTokens: 4000 });
console.log('\n=== RAW REPLY ===\n' + out.text);
closeDb();
