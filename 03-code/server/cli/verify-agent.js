/**
 * 装配探针（对齐 dsh 的 `dev/inspect.ts` 思路：**断言能力真的就位，而不是「配置看起来对」**）。
 *
 * 只读：不开迁移、不建会话、不调模型。
 *   node --no-warnings server/cli/verify-agent.js
 *   node --no-warnings server/cli/verify-agent.js --json
 *
 * 断言 6 项：
 *   ① 配置里的工具名全部能装配（没有拼写错误）
 *   ② 工具 schema 可序列化且名字唯一（上游 tools 参数不会因重复名被拒）
 *   ③ lit_search 真的能跨库检索（返回 > 0 篇）
 *   ④ lit_read 真的能读到已抽取的正文（返回 > 0 段，且锚点可被引用校验命中）
 *   ⑤ lit_translation 的「无译文」是正常返回而不是异常
 *   ⑥ 额度闸生效：超过 maxCalls 后返回 E_TOOL_QUOTA
 */
import { loadConfig } from '../config.js';
import { closeDb, get, openDb } from '../db.js';
import { createRegistry } from '../services/chat/registry.js';
import { buildTools } from '../services/chat/tools/index.js';

const cfg = loadConfig();
openDb(cfg.server.dbPath);

const checks = [];
const record = (name, ok, detail, error) => checks.push({ name, ok, detail: detail || null, error: error || null });

// ① 装配
const { tools, unknown } = buildTools(cfg.chat.tools);
record('工具装配', tools.length > 0 && unknown.length === 0, { wired: tools.map((t) => t.name), unknown });

// ② schema
const registry = createRegistry(tools, { maxCalls: cfg.chat.maxToolCallsPerTurn ?? 8 });
let schemaOk = true;
let schemaErr = null;
try {
  const payload = JSON.stringify(registry.openaiTools());
  const parsed = JSON.parse(payload);
  const names = parsed.map((t) => t.function.name);
  schemaOk = names.length === new Set(names).size && parsed.every((t) => t.function.parameters.type === 'object');
} catch (e) {
  schemaOk = false;
  schemaErr = e.message;
}
record('工具 schema', schemaOk, { count: tools.length }, schemaErr);

// ③ 跨库检索
const searchRun = await registry.run('lit_search', { q: 'agent workflow', limit: 5 }, {});
record(
  'lit_search 跨库',
  Boolean(searchRun.ok) && searchRun.value && searchRun.value.total > 0,
  searchRun.ok ? { total: searchRun.value.total, first: searchRun.value.items[0] && searchRun.value.items[0].no } : null,
  searchRun.ok ? null : searchRun.error,
);

// ④ 读正文（挑一篇已抽取的）
const ready = get(
  `SELECT w.no AS no, COUNT(s.id) AS n
     FROM works w
     JOIN assets a ON a.work_id = w.id AND a.kind = 'pdf' AND a.extract_status = 'ready'
     JOIN segments s ON s.asset_id = a.id
    GROUP BY w.id ORDER BY n DESC LIMIT 1`,
);
let readDetail = null;
let readOk = false;
let readErr = null;
if (!ready) {
  readErr = '库里没有已抽取正文的文献，跳过';
} else {
  const readRun = await registry.run('lit_read', { no: ready.no, maxChars: 2000 }, {});
  if (!readRun.ok) {
    readErr = readRun.error;
  } else {
    const segs = readRun.value.segments || [];
    readOk = segs.length > 0;
    readDetail = { no: ready.no, segments: segs.length, chars: readRun.value.totalChars };
    // 锚点必须能在库里查到（引用校验链路）
    if (readOk) {
      const first = segs[0];
      const hit = get('SELECT id FROM segments WHERE page_no = ? AND ord = ? AND asset_id = (SELECT a.id FROM assets a JOIN works w ON w.id = a.work_id WHERE w.no = ?)', [
        first.pageNo,
        first.ord,
        ready.no,
      ]);
      if (!hit) {
        readOk = false;
        readErr = `lit_read 返回的锚点 p${first.pageNo}#${first.ord} 在库里查不到`;
      }
    }
  }
}
record('lit_read 锚点可校验', readOk, readDetail, readErr);

// ⑤ 无译文不是异常
const trRun = await registry.run('lit_translation', { no: ready ? ready.no : '1.1', maxChars: 800 }, {});
record(
  'lit_translation',
  Boolean(trRun.ok),
  trRun.ok ? { available: trRun.value.available, segments: (trRun.value.segments || []).length } : null,
  trRun.ok ? null : trRun.error,
);

// ⑥ 额度闸
const tiny = createRegistry(tools, { maxCalls: 1 });
await tiny.run('lit_search', { q: 'a' }, {});
const beyond = await tiny.run('lit_search', { q: 'b' }, {});
record('工具额度闸', beyond.ok === false && /E_TOOL_QUOTA/.test(String(beyond.error)), { error: beyond.error });

// 汇总
const failed = checks.filter((c) => !c.ok);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ engine: cfg.chat.engine, checks, ok: failed.length === 0 }, null, 1));
} else {
  for (const c of checks) {
    const tail = c.error ? ` — ${c.error}` : c.detail ? ` — ${JSON.stringify(c.detail)}` : '';
    console.log(`${c.ok ? '[PASS]' : '[FAIL]'} ${c.name}${tail}`);
  }
  const ver = Number(get('PRAGMA user_version').user_version || 0);
  if (ver < 3) console.log(`[WARN] 库 user_version=${ver}（< 3）：先启动一次服务让迁移补 tool_calls/attachments 两列`);
  console.log(`\nverify-agent: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${checks.length - failed.length}/${checks.length}）`);
}
closeDb();
process.exit(failed.length === 0 ? 0 : 1);
