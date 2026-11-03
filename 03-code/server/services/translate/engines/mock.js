/**
 * 测试用假引擎（自测第 4 项 / 管线单测）。
 *
 * 存在条件：`AGENTLIT_MOCK_ENGINE=1` 或 `NODE_ENV=test`（见 registry）。
 * 行为：不发任何网络请求，给每段加 `[译] ` 前缀；内置计数器用于断言
 * 「批次数 / 实际请求数 / 第二次跑命中率」。
 */
const state = { requests: 0, batches: 0, items: 0, calls: [] };

/**
 * 固定词表替换（确定性）：
 * mock 必须产出**真中文**，否则「中文查译文索引」的自测全是空转（假阳性）。
 * 这不是翻译质量演示，只是让跨语言检索链路可以被真正验证。
 */
const GLOSSARY = [
  [/\bworkflows?\b/gi, '工作流'],
  [/\bagents?\b/gi, '智能体'],
  [/\bagentic\b/gi, '智能体式的'],
  [/\bAGI\b/g, '通用人工智能'],
  [/\bmodels?\b/gi, '模型'],
  [/\bevaluations?\b/gi, '评估'],
  [/\bframeworks?\b/gi, '框架'],
  [/\bbenchmarks?\b/gi, '基准测试'],
];

/** 把英文原文按固定词表替换成中文（其余保持不变），用于验证跨语言索引 */
export function toPseudoChinese(text) {
  let t = String(text || '');
  for (const [re, zh] of GLOSSARY) t = t.replace(re, zh);
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{maxChars?:number, maxItems?:number, concurrency?:number, latencyMs?:number, prefix?:string}} [opts]
 */
export function createMockEngine(opts = {}) {
  const cfg = {
    maxChars: opts.maxChars ?? 2000,
    maxItems: opts.maxItems ?? 6,
    concurrency: opts.concurrency ?? 3,
    latencyMs: opts.latencyMs ?? 5,
    prefix: opts.prefix ?? '[译] ',
  };
  return {
    id: 'mock',
    name: 'Mock（假引擎，仅测试）',
    needsKey: false,
    supportsAuto: true,
    limits: { maxChars: cfg.maxChars, maxItems: cfg.maxItems },
    concurrency: cfg.concurrency,
    configured: true,
    hasKey: true,
    hasModel: true,
    desc: '本地假引擎（mock-v2）：不发请求，按固定词表把高频英文词替换成中文并加前缀，用于验证管线与跨语言检索，不代表翻译质量。',
    async translate(items, ctx) {
      state.requests += 1;
      state.batches += 1;
      state.items += items.length;
      state.calls.push({ size: items.length, at: Date.now(), tgtLang: ctx && ctx.tgtLang });
      if (cfg.latencyMs) await sleep(cfg.latencyMs);
      return items.map((t) => `${cfg.prefix}${toPseudoChinese(String(t).slice(0, 4000))}`);
    },
    stats() {
      return { ...state, calls: [...state.calls] };
    },
  };
}

/** 全局计数（跨引擎实例共享，测试里方便断言） */
export function mockStats() {
  return { ...state, calls: [...state.calls] };
}

export function resetMockStats() {
  state.requests = 0;
  state.batches = 0;
  state.items = 0;
  state.calls = [];
}
