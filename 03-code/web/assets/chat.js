/**
 * 对话面板（阅读器右侧）：会话切换 + 流式渲染 + 引用 chip + 针对选中段落提问。
 *
 * 前端不做业务判断：引用是否有效由服务端校验（`done.citations` 计数），
 * 这里只负责「一条引用都没有时显式告知用户」——不假装有依据。
 *
 * 界面增强：流式「思考中」动画、助手消息复制、快捷提问 chips、
 * Markdown + 代码高亮渲染（marked + DOMPurify + highlight.js，见 vendor/md/）。
 */
import { api } from './api.js';
import { toast } from './ui.js';

/** Markdown 三件套是否就绪（reader.html 同步引入；缺失时自动退回纯文本，不让对话挂掉）。 */
const MD_OK = Boolean(window.marked && window.DOMPurify);

/**
 * 把助手消息渲染成 Markdown。
 * 安全边界：marked 的输出**必须**先过 DOMPurify 再 innerHTML（正文里可能出现模型生成的任意 HTML）；
 * 高亮在插入之后做——只改 DOM 结构、不再进 innerHTML，无需二次消毒。
 * @param {HTMLElement} bubble 目标气泡
 * @param {string} text 原始 Markdown 文本
 */
function renderMarkdown(bubble, text) {
  if (!MD_OK || !text) {
    bubble.textContent = text || '';
    return;
  }
  const raw = window.marked.parse(text, { gfm: true, breaks: true });
  bubble.innerHTML = window.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  bubble.classList.add('md');
  if (window.hljs) {
    bubble.querySelectorAll('pre code').forEach((block) => {
      try {
        window.hljs.highlightElement(block);
      } catch {
        /* 未知语言 / 已高亮块，保持原样 */
      }
    });
  }
  bubble.querySelectorAll('a').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
  });
}

/** 给每个代码块补一个「复制」按钮（流式结束后与历史消息渲染各调一次；重复调用幂等）。 */
function addCodeCopy(bubble) {
  bubble.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = '复制';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const t = code ? code.textContent : pre.textContent;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(t).then(() => {
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制'; }, 1600);
        }, () => { btn.textContent = '复制失败'; });
      } else {
        btn.textContent = '不支持复制';
      }
    });
    pre.append(btn);
  });
}

/**
 * 工具卡片（tools 引擎）：把 `tool` / `tool_result` 事件渲染成一行过程提示。
 * 只显示「做了什么 + 花了多久」，不展开工具返回内容（原文展示在回答里，避免重复）。
 */
const TOOL_LABELS = { lit_search: '检索文献', lit_read: '读原文', lit_translation: '读译文' };

function summarizeToolArgs(name, args = {}) {
  if (name === 'lit_search') return args.q ? `「${String(args.q).slice(0, 36)}」` : '';
  if (name === 'lit_read' || name === 'lit_translation') {
    const no = args.no ? `${args.no} ` : '';
    const from = args.from || 1;
    return `${no}p${from}${args.to ? `-${args.to}` : ' 起'}`;
  }
  const s = JSON.stringify(args || {});
  return s && s !== '{}' ? s.slice(0, 48) : '';
}

function makeToolCard({ name, args }) {
  const el = document.createElement('div');
  el.className = 'tool-card running';
  const dot = document.createElement('span');
  dot.className = 'tdot';
  const label = document.createElement('span');
  label.className = 'tname';
  label.textContent = TOOL_LABELS[name] || name;
  const arg = document.createElement('span');
  arg.className = 'targ';
  arg.textContent = summarizeToolArgs(name, args);
  const meta = document.createElement('span');
  meta.className = 'tmeta';
  meta.textContent = '运行中…';
  el.append(dot, label, arg, meta);
  return {
    el,
    finish(p = {}) {
      el.classList.remove('running');
      el.classList.add(p.ok ? 'ok' : 'fail');
      if (!p.ok) {
        meta.textContent = '失败';
        el.title = p.error || '工具执行失败';
        return;
      }
      const bits = [];
      if (p.ms) bits.push(`${p.ms} ms`);
      if (p.chars) bits.push(`${p.chars} 字`);
      meta.textContent = bits.join(' · ') || '完成';
    },
  };
}

/**
 * 把一张图片附件渲染进气泡下方（tools 引擎的 `image` 事件 / 历史消息的 attachments）。
 * 只按 attachmentId 回源，不内联 base64（与后端「引用而非内联」一致）。
 * 增强：点击放大到新标签、提供下载按钮（?dl=1）。
 */
function appendImage(bubble, a, chatId) {
  const fig = document.createElement('figure');
  fig.className = 'att-figure';
  const url = a.url || `/api/chats/${chatId || 0}/attachments/${encodeURIComponent(a.attachmentId)}`;
  const link = document.createElement('a');
  link.className = 'att-enlarge';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.title = '点击在新标签放大查看';
  const img = document.createElement('img');
  img.className = 'att-img';
  img.loading = 'lazy';
  img.src = url;
  img.alt = `页面图片 ${a.width ? `${a.width}×${a.height}` : ''}`.trim();
  link.append(img);
  const cap = document.createElement('figcaption');
  const bits = [];
  if (a.width && a.height) bits.push(`${a.width}×${a.height}`);
  if (a.bytes) bits.push(`${Math.round(a.bytes / 1024)} KB`);
  cap.textContent = bits.join(' · ') || '页面图片';
  const actions = document.createElement('span');
  actions.className = 'att-actions';
  const dl = document.createElement('a');
  dl.href = `${url}?dl=1`;
  dl.target = '_blank';
  dl.rel = 'noreferrer noopener';
  dl.textContent = '下载';
  actions.append(dl);
  fig.append(link, cap, actions);
  bubble.parentElement.append(fig);
}

export class ChatPanel {
  /**
   * @param {{no:string, onCitation:(c:{pageNo:number,segmentId:number})=>void, getSelection:()=>{pageNo:number,text:string}|null}} opts
   */
  constructor({ no, onCitation, getSelection }) {
    this.no = no;
    this.onCitation = onCitation;
    this.getSelection = getSelection;
    this.chatId = null;
    this.streaming = false;
    this.ctl = null;
    /** 待发送的用户附件（上传成功后累积，发送时随消息一起带走） */
    this.pendingAttachments = [];
    this.el = {
      msgs: document.getElementById('chatMsgs'),
      text: document.getElementById('chatText'),
      send: document.getElementById('btnSend'),
      stop: document.getElementById('btnStop'),
      select: document.getElementById('chatSelect'),
      newChat: document.getElementById('btnNewChat'),
      askSel: document.getElementById('btnAskSelection'),
      quick: document.getElementById('chatQuick'),
      attach: document.getElementById('chatFile'),
      btnAttach: document.getElementById('btnAttach'),
      pending: document.getElementById('chatPending'),
    };
    this.bind();
  }

  bind() {
    this.el.send.addEventListener('click', () => this.send());
    this.el.text.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.send();
    });
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.newChat.addEventListener('click', () => this.createChat());
    // 多模态：附件按钮 → 打开文件选择；选择后逐文件上传
    if (this.el.btnAttach && this.el.attach) {
      this.el.btnAttach.addEventListener('click', () => this.el.attach.click());
      this.el.attach.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files && files.length) this.onFilesPicked(files);
        e.target.value = ''; // 允许重复选同一文件
      });
    }
    this.el.select.addEventListener('change', () => {
      this.chatId = this.el.select.value ? Number(this.el.select.value) : null;
      if (this.chatId) this.loadMessages();
      else this.el.msgs.textContent = '';
    });
    this.el.askSel.addEventListener('click', () => {
      const sel = this.getSelection ? this.getSelection() : null;
      if (!sel || !sel.text) {
        toast('先在左边正文里选中一段文字', 'warn', 3600);
        return;
      }
      this.send('请解释我选中的这段话，并说明它在全文中的作用。', sel);
    });
    // 快捷提问：填入输入框并聚焦，便于用户微调后再发送
    if (this.el.quick) {
      this.el.quick.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => {
          this.el.text.value = b.dataset.q || '';
          this.el.text.focus();
        });
      });
    }
  }

  async init() {
    try {
      const chats = await api.get(`/api/chats?workNo=${encodeURIComponent(this.no)}`);
      this.renderChatList(chats);
      if (chats.length) {
        this.chatId = chats[0].chatId;
        this.el.select.value = String(this.chatId);
        await this.loadMessages();
      }
    } catch (e) {
      toast(`会话加载失败：${e.message}`, 'err');
    }
  }

  renderChatList(chats) {
    const sel = this.el.select;
    sel.textContent = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = chats.length ? '（选择会话）' : '（还没有会话）';
    sel.append(opt0);
    for (const c of chats) {
      const o = document.createElement('option');
      o.value = String(c.chatId);
      o.textContent = `${c.title || '未命名'} · ${c.messageCount} 条 · ${new Date(c.updatedAt).toLocaleString()}`;
      sel.append(o);
    }
  }

  async createChat() {
    try {
      const out = await api.post('/api/chats', { workNo: this.no });
      this.chatId = out.chatId;
      const chats = await api.get(`/api/chats?workNo=${encodeURIComponent(this.no)}`);
      this.renderChatList(chats);
      this.el.select.value = String(out.chatId);
      this.el.msgs.textContent = '';
      toast('已新建会话（provider/model 在此刻固定）', 'ok');
    } catch (e) {
      toast(`新建会话失败：${e.message}（${e.code}）`, 'err', 5000);
    }
  }

  async loadMessages() {
    const out = await api.get(`/api/chats/${this.chatId}/messages`);
    this.el.msgs.textContent = '';
    for (const m of out.messages) this.appendMessage(m);
    this.scrollToEnd();
  }

  appendMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${m.role}`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = m.role === 'user' ? '我' : `助手${m.model ? ` · ${m.model}` : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.role === 'assistant' && !m.content) {
      // 流式占位：先显示「思考中」动画，首个 delta 到达后由 send() 替换为正文
      const typing = document.createElement('span');
      typing.className = 'typing';
      typing.innerHTML = '<i></i><i></i><i></i>';
      bubble.append(typing);
    } else if (m.role === 'assistant') {
      // 历史助手消息：按 Markdown 渲染（用户消息保持纯文本，所见即所输）
      bubble._raw = m.content || '';
      renderMarkdown(bubble, m.content || '');
      addCodeCopy(bubble);
    } else {
      bubble.textContent = m.content || '';
    }
    // 附件渲染必须在挂载之后：appendImage/卡片依赖 bubble.parentElement（挂载前为 null）
    wrap.append(who, bubble);
    // 用户消息若携带附件（上传的图片/文件），在气泡下方回显
    if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
      if (!String(m.content || '').trim()) bubble.hidden = true; // 纯图/纯文件消息：不显示空气泡
      this.appendUserAttachments(bubble, m.attachments, this.chatId);
    }

    // tools 引擎的历史消息：把当时调用的工具回显成卡片（读历史也能看出「它看了什么」）
    if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const box = document.createElement('div');
      box.className = 'tool-cards';
      for (const t of m.toolCalls) {
        const card = makeToolCard({ name: t.name, args: t.args });
        card.finish({ ok: t.ok, ms: t.ms, chars: t.chars, error: t.error });
        box.append(card.el);
      }
      wrap.insertBefore(box, bubble);
    }

    // 助手消息的附件（工具产图）：按 id 回源渲染（不内联 base64），可放大/下载
    // 只处理 assistant —— 用户附件已在上方由 appendUserAttachments 渲染，避免重复
    if (m.role === 'assistant' && Array.isArray(m.attachments) && m.attachments.length) {
      for (const a of m.attachments) {
        if (a.kind === 'file') wrap.append(this.renderAttachmentCard(a, this.chatId));
        else appendImage(bubble, a, this.chatId);
      }
    }

    if (m.role === 'assistant') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制';
      copy.addEventListener('click', () => {
        // Markdown 渲染后 textContent 会丢结构，复制原始文本（_raw 由渲染方维护）
        const text = bubble._raw != null ? bubble._raw : bubble.textContent;
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(
            () => toast('已复制回答', 'ok', 1600),
            () => toast('复制失败', 'err'),
          );
        } else {
          toast('当前环境不支持自动复制', 'warn');
        }
      });
      actions.append(copy);
      wrap.append(actions);
    }

    if (m.citations && m.citations.length) {
      const cites = document.createElement('div');
      cites.className = 'cites';
      for (const c of m.citations) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = `p${c.pageNo}#${c.ord}`;
        chip.title = c.quote || '';
        chip.addEventListener('click', () => this.onCitation(c));
        cites.append(chip);
      }
      wrap.append(cites);
    } else if (m.role === 'assistant' && m.content) {
      // 历史已完成、且无引用的助手消息：明确告知未引用原文
      const warn = document.createElement('div');
      warn.className = 'no-cite';
      warn.textContent = m.retrievalMiss
        ? '未检索到原文依据（两侧索引均无命中，含改写重试）'
        : '本回答未引用原文段落（可能在文献中没有依据）';
      wrap.append(warn);
    }
    if (m.truncated) {
      const t = document.createElement('div');
      t.className = 'truncated';
      t.textContent = '（回答被中断，仅保留已产出部分）';
      wrap.append(t);
    }
    this.el.msgs.append(wrap);
    return { wrap, bubble };
  }

  scrollToEnd() {
    this.el.msgs.scrollTop = this.el.msgs.scrollHeight;
  }

  async ensureChat() {
    if (this.chatId) return this.chatId;
    const out = await api.post('/api/chats', { workNo: this.no });
    this.chatId = out.chatId;
    const chats = await api.get(`/api/chats?workNo=${encodeURIComponent(this.no)}`);
    this.renderChatList(chats);
    this.el.select.value = String(out.chatId);
    return this.chatId;
  }

  async send(presetText, presetSelection) {
    if (this.streaming) return;
    const content = String(presetText || this.el.text.value || '').trim();
    // 允许「纯图/纯文件」发送：无文字但有待发附件时也放行（后端 postMessageTools 契约同样允许）
    if (!content && !this.pendingAttachments.length) return;
    let selection = presetSelection || null;
    if (!selection && this.getSelection) {
      const sel = this.getSelection();
      // 只有用户真的有选区时才带 selection（避免把上一次的残留带上）
      if (sel && sel.text && window.getSelection && String(window.getSelection()).trim()) selection = sel;
    }
    try {
      await this.ensureChat();
    } catch (e) {
      toast(`会话创建失败：${e.message}（${e.code}）`, 'err', 5000);
      return;
    }

    this.el.text.value = '';
    // 捕获本次要带走的附件（随后清空待发区），让乐观渲染的用户气泡立即显示图片/文件
    const userAtts = this.pendingAttachments.slice();
    this.appendMessage({ role: 'user', content, citations: [], attachments: userAtts });
    this.pendingAttachments = [];
    this.renderPendingAttachments();
    const { bubble } = this.appendMessage({ role: 'assistant', content: '', citations: [] });
    // 流式占位提示：首个 delta 到达前显示「思考中」
    const noCite = document.createElement('div');
    noCite.className = 'no-cite';
    noCite.hidden = true;
    bubble.parentElement.append(noCite);
    // tools 引擎：工具调用卡片容器（气泡上方；legacy 引擎下永远为空，不占高度）
    const toolBox = document.createElement('div');
    toolBox.className = 'tool-cards';
    bubble.parentElement.insertBefore(toolBox, bubble);
    this.scrollToEnd();

    this.streaming = true;
    this.el.send.disabled = true;
    this.el.stop.disabled = false;
    this.ctl = new AbortController();
    let text = '';
    let citations = [];
    let finished = false;
    let retrievalMiss = false;
    /** tool id → card（tool_result 回来时更新同一张卡） */
    const toolCards = new Map();

    try {
      const res = await fetch(`/api/chats/${this.chatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          selection,
          attachmentIds: userAtts.map((a) => a.attachmentId),
        }),
        signal: this.ctl.signal,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error((payload && payload.error && payload.error.message) || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evLine = raw.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
          if (evLine && dataLine) {
            const ev = evLine.slice(6).trim();
            let payload = {};
            try {
              payload = JSON.parse(dataLine.slice(5).trim());
            } catch {
              payload = {};
            }
            if (ev === 'tool') {
              const card = makeToolCard({ name: payload.name, args: payload.args });
              toolCards.set(payload.id, card);
              toolBox.append(card.el);
              this.scrollToEnd();
            } else if (ev === 'tool_result') {
              const card = toolCards.get(payload.id);
              if (card) card.finish(payload);
              this.scrollToEnd();
            } else if (ev === 'image' && payload.attachmentId) {
              appendImage(bubble, payload, this.chatId);
              this.scrollToEnd();
            } else if (ev === 'delta' && payload.text) {
              text += payload.text;
              bubble._raw = text;
              // Markdown 重渲染有成本，节流到 ~10fps；最终态在 finally 里补一次全量渲染
              if (!this._renderTimer) {
                this._renderTimer = setTimeout(() => {
                  this._renderTimer = null;
                  renderMarkdown(bubble, text);
                  this.scrollToEnd();
                }, 90);
              }
              this.scrollToEnd();
            } else if (ev === 'citation' && payload.citations) {
              citations = payload.citations;
            } else if (ev === 'meta' && payload.retrievalMiss) {
              retrievalMiss = true;
            } else if (ev === 'done') {
              finished = true;
              if (payload.retrievalMiss) retrievalMiss = true;
              if (payload.noCitation) {
                noCite.textContent = '本回答未引用原文段落（可能在文献中没有依据）';
                noCite.hidden = false;
              }
            } else if (ev === 'error') {
              noCite.textContent = `出错了：${payload.code || ''} ${payload.message || ''}`;
              noCite.hidden = false;
              if (!text) bubble.textContent = '（没有返回内容，见下方错误信息）';
            }
          }
          idx = buf.indexOf('\n\n');
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        const t = document.createElement('div');
        t.className = 'truncated';
        t.textContent = '（已取消，保留已产出部分）';
        bubble.parentElement.append(t);
        if (!text) bubble.textContent = '（已取消，未返回内容）';
      } else {
        toast(`提问失败：${e.message}`, 'err', 5000);
      }
    } finally {
      // 收尾：清掉未触发的节流定时器，再全量渲染一次最终态（含代码高亮与复制按钮）。
      // 空文本时不渲染——保留 error/abort 分支写入的提示文案。
      if (this._renderTimer) {
        clearTimeout(this._renderTimer);
        this._renderTimer = null;
      }
      if (text) {
        renderMarkdown(bubble, text);
        addCodeCopy(bubble);
      }
      this.streaming = false;
      this.el.send.disabled = false;
      this.el.stop.disabled = true;
      this.ctl = null;
    }

    // 引用 chip（用 done 时服务端校验过的结果重建，客户端不自己解析锚点）
    const wrap = bubble.parentElement;
    if (citations.length) {
      const cites = document.createElement('div');
      cites.className = 'cites';
      for (const c of citations) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = `p${c.pageNo}#${c.ord}`;
        chip.title = c.quote || '';
        chip.addEventListener('click', () => this.onCitation(c));
        cites.append(chip);
      }
      wrap.append(cites);
    } else if (finished) {
      noCite.textContent = retrievalMiss
        ? '未检索到原文依据（两侧索引均无命中，含改写重试）'
        : '本回答未引用原文段落（可能在文献中没有依据）';
      noCite.hidden = false;
    }
    this.scrollToEnd();
  }

  // ── 多模态上传（两步式：先传后引） ──────────────────────────────────────────

  /** 用户选了若干文件：逐个上传，成功后累积到 pendingAttachments */
  async onFilesPicked(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (this.pendingAttachments.length + files.length > 4) {
      toast('每则消息最多附带 4 个附件，已忽略超出部分', 'warn', 3600);
    }
    this.el.send.disabled = true;
    try {
      for (const file of files.slice(0, 4 - this.pendingAttachments.length)) {
        // eslint-disable-next-line no-await-in-loop
        await this.uploadOne(file);
      }
    } finally {
      this.el.send.disabled = this.streaming;
    }
  }

  /** 上传单个文件：POST multipart 到 /api/chats/:id/attachments，成功后 push 引用 */
  async uploadOne(file) {
    if (!this.chatId) await this.ensureChat();
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const res = await fetch(`/api/chats/${this.chatId}/attachments`, { method: 'POST', body: fd });
      const text = await res.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (!res.ok) throw new Error((payload && payload.error && payload.error.message) || `HTTP ${res.status}`);
      this.pendingAttachments.push(payload);
      this.renderPendingAttachments();
    } catch (e) {
      toast(`「${file.name}」上传失败：${e.message}`, 'err', 5000);
    }
  }

  /** 在输入框上方渲染待发送附件缩略（图片缩略图 / 文件图标 + 名称），每张可移除 */
  renderPendingAttachments() {
    const box = this.el.pending;
    if (!box) return;
    box.textContent = '';
    if (!this.pendingAttachments.length) { box.hidden = true; return; }
    box.hidden = false;
    this.pendingAttachments.forEach((a, idx) => {
      const chip = document.createElement('div');
      chip.className = 'pending-att';
      const isImg = a.kind === 'image';
      if (isImg) {
        const img = document.createElement('img');
        img.src = a.url || `/api/chats/${this.chatId || 0}/attachments/${encodeURIComponent(a.attachmentId)}`;
        chip.append(img);
      } else {
        const ic = document.createElement('span');
        ic.className = 'pa-ic';
        ic.textContent = '📄';
        chip.append(ic);
      }
      const name = document.createElement('span');
      name.className = 'pa-name';
      name.textContent = `${a.mediaType.split('/')[1] || 'file'} · ${Math.round((a.bytes || 0) / 1024)}KB`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pa-x';
      x.textContent = '×';
      x.title = '移除';
      x.addEventListener('click', () => {
        this.pendingAttachments.splice(idx, 1);
        this.renderPendingAttachments();
      });
      chip.append(name, x);
      box.append(chip);
    });
  }

  /** 用户消息里的附件：图片可放大/下载（与助手产图一致），文件渲染成可下载卡片 */
  appendUserAttachments(bubble, attachments, chatId) {
    for (const a of attachments || []) {
      if (a.kind === 'image') appendImage(bubble, a, chatId);
      else bubble.parentElement.append(this.renderAttachmentCard(a, chatId));
    }
  }

  /** 统一渲染一个文件类附件为可下载卡片 */
  renderAttachmentCard(a, chatId) {
    const card = document.createElement('div');
    card.className = 'file-card';
    const name = document.createElement('span');
    name.className = 'fc-name';
    name.textContent = `${a.mediaType || 'file'} · ${Math.round((a.bytes || 0) / 1024)}KB`;
    const dl = document.createElement('a');
    dl.className = 'fc-dl';
    dl.textContent = '下载';
    dl.href = `${a.url || `/api/chats/${chatId || 0}/attachments/${encodeURIComponent(a.attachmentId)}`}?dl=1`;
    dl.target = '_blank';
    dl.rel = 'noreferrer noopener';
    card.append(name, dl);
    return card;
  }

  async stop() {
    if (!this.chatId) return;
    try {
      await api.post(`/api/chats/${this.chatId}/messages/0/cancel`, {});
      if (this.ctl) this.ctl.abort();
    } catch (e) {
      toast(`取消失败：${e.message}`, 'err');
    }
  }
}
