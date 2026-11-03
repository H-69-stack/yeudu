import { config, loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';

const log = (...a) => console.error('[step]', ...a);
process.on('unhandledRejection', e => { console.error('UNHANDLED', e); process.exit(1); });

openDb('data/app.db');
log('db opened');
loadConfig();
log('config loaded');

config.chat.pageImage.enabled = true;
config.chat.pageImage.playwrightModule = 'D:/A-knowledge/agent工作流优化/deepseek-harness-master/node_modules/playwright/index.js';
config.chat.tools = ['lit_search', 'lit_read', 'lit_translation', 'lit_page_image'];

const { buildTools, PAGE_IMAGE_STATUS } = await import('../server/services/chat/tools/index.js');
log('tools imported', JSON.stringify(PAGE_IMAGE_STATUS));

const { createRegistry } = await import('../server/services/chat/registry.js');
const { runToolLoop } = await import('../server/services/chat/loop.js');
const { buildToolMessages } = await import('../server/services/chat/pipeline.js');
log('loop+pipeline imported');

const { tools } = buildTools(config.chat.tools);
const registry = createRegistry(tools, { maxCalls: 6 });

const work = { no: '4.4', title: 'A Survey on Large Language Model based Autonomous Agents' };
const { messages } = buildToolMessages({
  work, history: [],
  content: '请先用 lit_page_image 渲染文献 4.4 的第 1 页，然后告诉我这一页上你实际看到了哪些版面元素（标题、作者、摘要、图表、章节等）。只根据图片作答，不要编造。',
});
log('messages built, system len=', messages[0].content.length);

const started = Date.now();
log('calling runToolLoop...');
const out = await runToolLoop({ provider: 'deepseek', model: 'deepseek-chat', messages, registry, maxRounds: 4 });
const secs = ((Date.now() - started) / 1000).toFixed(1);
log('done in', secs + 's');

console.log('\n=== 模型最终回答（图注入后）===');
console.log(out.text);
console.log('\n=== 工具调用轨迹 ===');
for (const t of out.toolCalls) console.log(`- ${t.name} args=${JSON.stringify(t.args)} ok=${t.ok}`);
const imgTool = out.toolCalls.find(t => t.name === 'lit_page_image');
console.log('\n渲染工具被调用 =', Boolean(imgTool), '| 总轮数 =', out.rounds, '| 耗时 =', secs + 's');
process.exit(0);
