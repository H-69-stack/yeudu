/**
 * 翻译提示词模板与指纹（§16.1 搬 base.js 的 DEFAULT_PROMPT_ZH / llm.js 的编号协议）。
 *
 * `prompt_fp` 用**模板文本**计算，不用渲染后的 prompt —— 否则 `${langFrom}` 一变全部缓存失效（§21 R3 ②）。
 */
import crypto from 'node:crypto';

/**
 * 默认中文提示词。
 * 在「原插件 DEFAULT_PROMPT_ZH」基础上强化翻译质量与排版还原：
 *  - 流畅自然：意译优先、符合中文学术表达，而非逐词死译；
 *  - 术语一致：借助 [Paper] 上下文统一专有名词；
 *  - 结构保留：原文若是标题/列表/引用/公式说明，用对应 Markdown 形态输出（# / - / 1. / >），
 *    普通正文保持自然段落，绝不把碎片拼成一行或擅自合并/跳号。
 * 仍保留 🔤 占位符与编号批量协议（解析率依赖它，不可删）。
 */
export const DEFAULT_PROMPT_ZH =
  '你是一位精通各学科领域、中文写作功底扎实的学术翻译专家。请把下面 🔤 之间的学术文本' +
  '从 ${langFrom} 翻译为 ${langTo}。\n\n' +
  '【翻译要求】\n' +
  '1. 准确且专业：忠实原意，术语准确、与文献上下文保持一致；专有名词（人名/机构/方法名）' +
  '首次出现可保留英文原词并用括号标注中文（如「BDI（Belief-Desire-Intention，信念-愿望-意图）」），' +
  '之后可用中文。\n' +
  '2. 流畅自然：以地道的中文学术表达意译，避免逐词直译与生硬句式；在准确前提下让文气连贯、' +
  '符合目标语言阅读习惯，不要机械保留源语言的语序与标点。\n' +
  '3. 完整保真：不增删原意，不擅自概括或评论；原文若有强调（如加粗、大写标题）在译文中以相应层级体现。\n' +
  '4. 逐条对应（重要）：输入若以编号列出多段，必须**逐条一一对应**输出，条数与编号原样保留。' +
  'PDF 抽取的某些条目是被排版切断的半句（以连字符结尾、或以小写字母开头、或句子未收尾），' +
  '这时只翻译该片段本身，**不要**替它补全上下文、不要臆测前半句、更不要把相邻条目的内容并进来——' +
  '补全会造成相邻译文互相吞并、内容重复。\n\n' +
  '【结构还原】原文若本身具有版式结构，请用 Markdown 还原，不要破坏：\n' +
  '- 章节/小节标题 → 用 # 或 ## 标题；\n' +
  '- 有序/无序列表 → 用 1. / - 列表；\n' +
  '- 引文、blockquote、长段引用 → 用 > 引用块；\n' +
  '- 普通正文 → 正常段落，保持原有换行与句子边界，不要多段合并成一段，也不要把一段拆散。\n' +
  '若某条只是正文的片段（被切分出来的半段），则直接给出这段的自然译文即可，不要强行加标题或列表符号。\n\n' +
  '待翻译内容：🔤 ${sourceText} 🔤。\n' +
  '请只输出译文本身，不要任何额外解释、不要复述要求，并去掉 🔤 符号。';

/**
 * 默认英文提示词（英文界面用）：同样强调流畅自然与结构还原。
 */
export const DEFAULT_PROMPT =
  'You are an expert academic translator with strong command of ${langTo}. ' +
  'Translate the academic text between 🔤 from ${langFrom} into ${langTo}.\n\n' +
  'Requirements:\n' +
  '1. Accurate and precise: faithful to the original meaning, with correct, consistent terminology.\n' +
  '2. Fluent and natural: prefer meaning-based translation in idiomatic ${langTo}; avoid literal word-for-word phrasing.\n' +
  '3. Preserve structure: keep the original typographic structure using Markdown — headings (#/##), ' +
  'lists (1./-), blockquotes (>), and normal paragraphs. Do not merge or reorder items; ' +
  'if an item is only a fragment of a paragraph, just give its natural translation.\n' +
  'Output only the translation, no explanation, and remove the 🔤 symbols. Text: 🔤 ${sourceText} 🔤';

/** 多段合批时必须追加的编号协议（与原插件逐字一致） */
export const NUMBERING_INSTRUCTION =
  '\n\nImportant: the input above is a numbered list of separate paragraphs. ' +
  'Translate every item and return the result in the SAME numbered format — one item per line, ' +
  'keep the original numbering (1. 2. 3. …), do not merge items, do not skip any item, ' +
  'and output nothing but the numbered translations.';

/** 语言码 → 人读语言名（提示词里用；进提示词就要保证同一码永远同名） */
export const LANGUAGES = {
  auto: 'the source language',
  en: 'English',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  ru: 'Russian',
};

export function langName(code) {
  return LANGUAGES[code] || code || 'the source language';
}

/**
 * 提示词指纹（模板级）：sha256(模板)[0:8]。
 * 只随模板文本变化；改一个字就全 miss —— 这正是「改提示词必须失效」的实现方式。
 * @param {string} template
 * @returns {string}
 */
export function promptFingerprint(template) {
  return crypto.createHash('sha256').update(String(template || ''), 'utf8').digest('hex').slice(0, 8);
}

/**
 * 渲染提示词（替换 ${langFrom}/${langTo}/${sourceText}）。
 * 缺 `${sourceText}` 占位符时把原文追加到末尾，避免用户模板写漏导致空请求。
 * @param {{template:string, sourceText:string, srcLang:string, tgtLang:string, work?:Object}} p
 * @returns {string}
 */
export function renderPrompt({ template, sourceText, srcLang, tgtLang, work }) {
  let tpl = String(template || DEFAULT_PROMPT_ZH);
  if (tpl.indexOf('${sourceText}') < 0 && tpl.indexOf('${text}') < 0) tpl += '\n\n${sourceText}';
  const out = tpl
    .replace(/\$\{langFrom\}/g, langName(srcLang))
    .replace(/\$\{langTo\}/g, langName(tgtLang))
    .replace(/\$\{text\}/g, sourceText)
    .replace(/\$\{sourceText\}/g, sourceText);
  // 文献上下文（标题 + 贡献定位）用于对齐术语；不含时间/id，保证同文献内字节稳定（§9.3.3）。
  // 必须放在 🔤 分隔符**之外**并显式声明"不要翻译"：
  // 之前把它拼进 ${sourceText}，上下文就被当成正文一起译出来，混进了译文段首
  // （实测会出现「【论文】《…》【聚焦】…」这样的前缀泄漏）。
  if (work && work.title) {
    const ctx = `[Background — for terminology consistency only. Do NOT translate, quote or repeat this part in your output.]\nPaper: ${work.title}${work.note ? `\nFocus: ${work.note}` : ''}`;
    return `${ctx}\n\n${out}`;
  }
  return out;
}

/** 当前生效的模板（配置可覆盖，空则用默认） */
export function resolveTemplate(cfg) {
  const t = cfg && cfg.translate && cfg.translate.prompt;
  return t && String(t).trim() ? String(t) : DEFAULT_PROMPT_ZH;
}
