/**
 * 设置页：下载目录切换 / 重扫自愈 / 密钥（掩码）/ 导入 / 统计。
 * 约束：前端永不持有明文密钥——回显只来自 GET /api/settings 的掩码字段。
 */
import { api } from './api.js';
import { el, toast } from './ui.js';

const $ = (id) => document.getElementById(id);

/** 最近一次 GET /api/settings 的快照（用于切换 provider 时刷新面板） */
let SNAP = null;

/** qwen/deepseek 等预设的默认 baseUrl（仅作填写提示，留空则用服务端内置默认） */
const PRESET_BASEURL = {
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
};

/** 按 provider 输入框刷新 baseUrl / keyState / model（支持同时管理多个供应商的密钥） */
function refreshProviderPanel() {
  if (!SNAP) return;
  const pid = $('provider').value.trim() || 'deepseek';
  const providers = (SNAP.llm && SNAP.llm.providers) || {};
  const p = providers[pid] || {};
  $('baseUrl').value = p.baseUrl || '';
  $('keyState').textContent = p.hasKey ? `已配置：${p.apiKeyMasked}` : '未配置密钥';
  const flat = SNAP.config || {};
  $('model').value = flat[`translate.engines.${pid}.model`] || '';
  $('model').placeholder = pid === 'qwen' ? 'qwen-plus' : pid === 'deepseek' ? 'deepseek-chat' : 'model';
}

async function loadHealth() {
  const h = await api.get('/api/health');
  $('healthLine').textContent = `已连接 · 库内 ${h.works} 条 · 下载目录${h.downloadDirWritable ? '可写' : '不可写！'}`;
  const kv = $('serverKv');
  kv.textContent = '';
  const add = (k, v) => kv.append(el('dt', { text: k }), el('dd', { class: 'mono', text: v }));
  add('版本', h.version);
  add('监听', `http://127.0.0.1:${new URL(location.href).port || 7317}/`);
  add('数据库', `${h.dbPath}（驱动 ${h.dbDriver}）`);
  add('项目根', h.rootDir);
  add('活跃下载', String(h.activeJobs));
  add('缺失文件', String(h.missingAssets));
}

async function loadSettings() {
  SNAP = await api.get('/api/settings');
  $('downloadDir').value = SNAP.paths.downloadDir;
  const flat = SNAP.config || {};
  // 引擎分工
  $('translateEngine').value = flat['translate.engine'] || 'deepseek';
  $('refineEngine').value = flat['translate.refineEngine'] ?? '';
  refreshProviderPanel();
}

async function loadStats() {
  const st = await api.get('/api/stats');
  const kv = $('statsKv');
  kv.textContent = '';
  const add = (k, v) => kv.append(el('dt', { text: k }), el('dd', { text: String(v) }));
  add('文献条数', st.works);
  add('已下载 PDF', st.withPdf);
  add('需人工', st.needsManual);
  add('下载任务数', st.downloadJobs);
  add('段落数（M2）', st.segments);
  add('译文缓存命中率（M2）', `${Math.round(st.cacheHitRate * 100)}%`);
  add('对话 token 累计（M3）', st.tokens.chat);
}

function showReport(id, text) {
  const box = $(id);
  box.hidden = false;
  box.textContent = text;
}

async function saveDownloadDir() {
  const path = $('downloadDir').value.trim();
  if (!path) return toast('请填写目录', 'warn');
  try {
    const out = await api.put('/api/settings/downloadDir', { path, mode: 'switch' });
    toast('下载目录已切换', 'ok');
    showReport('resyncReport', `切换：${out.previous} → ${out.downloadDir}\nresync：present=${out.resync.present} missing=${out.resync.missing} orphan=${out.resync.orphan.length}`);
    await Promise.all([loadHealth(), loadSettings(), loadStats()]);
  } catch (e) {
    toast(`切换失败：${e.message}（${e.code}）`, 'err', 4800);
  }
}

async function resync() {
  try {
    const r = await api.post('/api/storage/resync', { deep: true });
    showReport('resyncReport', `scanned=${r.scanned} present=${r.present} missing=${r.missing} adopted=${r.adopted}\norphan=${JSON.stringify(r.orphan, null, 1)}`);
    toast('重扫完成', 'ok');
    await Promise.all([loadHealth(), loadStats()]);
  } catch (e) {
    toast(`重扫失败：${e.message}`, 'err');
  }
}

async function saveSecret() {
  const provider = $('provider').value.trim() || 'deepseek';
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value.trim();
  const body = { provider, providers: { [provider]: { baseUrl } } };
  if (apiKey) body.providers[provider].apiKey = apiKey;
  try {
    await api.put('/api/settings/secret', { providers: body.providers });
    $('apiKey').value = '';
    toast('已保存（M1 不会发起任何 LLM 请求）', 'ok');
    await loadSettings();
  } catch (e) {
    toast(`保存失败：${e.message}`, 'err');
  }
}

function renderImportReport(r) {
  const lines = [
    `模式：${r.mode}`,
    `CSV：${r.csvPath}`,
    `记录 ${r.totalRecords}（含 arXiv ${r.withArxiv}，专题 ${r.sections}）`,
    `新增 ${r.added} / 更新 ${r.updated} / 未变 ${r.unchanged} / 退休 ${r.retired} / 复活 ${r.revived}`,
    `锁定跳过 ${r.skippedLocked.length}${r.skippedLocked.length ? '：' + r.skippedLocked.map((x) => `${x.no}.${x.field}`).join(', ') : ''}`,
    `告警 ${r.warnings.length}${r.warnings.length ? '：' + r.warnings.slice(0, 5).map((w) => `${w.no}:${w.field}`).join(', ') : ''}`,
  ];
  showReport('importReport', lines.join('\n'));
}

async function runImport(mode) {
  try {
    const r = await api.post('/api/import', { mode });
    renderImportReport(r);
    toast(mode === 'merge' ? '导入完成' : 'dry-run 完成（未写盘）', 'ok');
    await Promise.all([loadHealth(), loadStats()]);
  } catch (e) {
    toast(`导入失败：${e.message}`, 'err', 4800);
  }
}

async function saveModel() {
  const provider = $('provider').value.trim() || 'deepseek';
  const model = $('model').value.trim();
  if (!model) return toast('model 不能为空', 'warn');
  try {
    await api.put('/api/settings', { translate: { engines: { [provider]: { model } } } });
    toast(`已保存 ${provider} 的模型：${model}`, 'ok');
    await loadSettings();
  } catch (e) {
    toast(`保存模型失败：${e.message}`, 'err');
  }
}

async function testConnection() {
  const engine = $('provider').value.trim() || 'deepseek';
  $('btnTest').disabled = true;
  $('testResult').hidden = false;
  $('testResult').textContent = '请求中…';
  try {
    const out = await api.post('/api/translate/test', { engine });
    $('testResult').textContent = `引擎 ${out.engine} / 模型 ${out.model} 连通 ✓\n延迟 ${out.latencyMs}ms\n样例译文：${out.sample}`;
    toast('连通性测试通过', 'ok');
  } catch (e) {
    $('testResult').textContent = `失败：${e.code} ${e.message}`;
    toast(`测试失败：${e.message}（${e.code}）`, 'err', 5000);
  } finally {
    $('btnTest').disabled = false;
  }
}

async function saveEngines() {
  const engine = $('translateEngine').value;
  const refine = $('refineEngine').value;
  try {
    await api.put('/api/settings', { translate: { engine, refineEngine: refine } });
    toast(`已保存：翻译 = ${engine}，精排 = ${refine || engine + '（跟随）'}`, 'ok');
    await loadSettings();
  } catch (e) {
    toast(`保存失败：${e.message}`, 'err');
  }
}

function bind() {
  $('btnSaveModel').addEventListener('click', saveModel);
  $('btnTest').addEventListener('click', testConnection);
  $('btnSaveDir').addEventListener('click', saveDownloadDir);
  $('btnResync').addEventListener('click', resync);
  $('btnSaveSecret').addEventListener('click', saveSecret);
  $('btnSaveEngines').addEventListener('click', saveEngines);
  $('providerPreset').addEventListener('change', (e) => {
    const pid = e.target.value;
    if (!pid) return;
    $('provider').value = pid;
    if (!$('baseUrl').value.trim() && PRESET_BASEURL[pid]) $('baseUrl').value = PRESET_BASEURL[pid];
    refreshProviderPanel();
  });
  $('provider').addEventListener('change', refreshProviderPanel);
  $('btnDryRun').addEventListener('click', () => runImport('dry-run'));
  $('btnMerge').addEventListener('click', () => runImport('merge'));
}

bind();
Promise.all([loadHealth(), loadSettings(), loadStats()]).catch((e) => toast(`加载失败：${e.message}`, 'err', 6000));
