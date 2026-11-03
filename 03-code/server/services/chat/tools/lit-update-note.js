/**
 * `lit_update_note` —— 写回文献的「备注/贡献定位」字段（移植自 dsh-impl 的 `tools/lit-update-note.ts`）。
 *
 * **默认关闭**：与 dsh 的分发形态一致（`dsh-bundle-litagent/cordis.patch.yml:33-36` 里该工具
 * `disabled: true`）：不在 `config.chat.tools` 里列出，模型连按钮都看不到。
 *
 * **双保险**（照 dsh 的两层）：
 *   ① 分发层：默认不在 tools 清单里；
 *   ② 服务层：即使被显式打开，`config.chat.allowWrite=false` 时仍然拒绝写（对齐 dsh
 *      `db.ts:135` 用 `readOnly` 句柄的做法——我们没有独立句柄，就在工具入口显式闸掉）。
 *
 * 写入只动 `works.note`，带乐观并发（`expectUpdatedAt`），不动标题/作者等其它字段。
 */
import { get, run } from '../../../db.js';
import { config } from '../../../config.js';
import { defineTool } from '../registry.js';
import { resolveWork } from './_resolve.js';

function render(_args, value) {
  return value.ok
    ? `已更新文献 ${value.no} 的备注（${value.chars} 字）。`
    : `未更新文献 ${value.no}：${value.reason}`;
}

export const tool = defineTool({
  name: 'lit_update_note',
  description:
    '写回某篇文献的「备注/贡献定位」字段（只改这一个字段）。需要服务端开启 allowWrite，且本工具被显式启用；并发冲突会用 expectUpdatedAt 拦下。',
  parameters: {
    no: { type: 'string', required: true, description: '文献编号，例如 "4.6"' },
    note: { type: 'string', required: true, description: '新的备注正文（≤2000 字）' },
    expectUpdatedAt: {
      type: 'number',
      description: '乐观并发：只有当 works.updated_at 与此值一致时才写入；省略则不校验',
    },
  },
  outputSchema: {
    type: 'object',
    required: ['no', 'ok'],
    properties: { no: { type: 'string' }, ok: { type: 'boolean' }, chars: { type: 'number' } },
  },
  execute(args) {
    const no = String(args.no || '').trim();
    const note = String(args.note == null ? '' : args.note).slice(0, 2000);
    const { work } = resolveWork(no);
    if (!config.chat.allowWrite) {
      // 服务层闸：配置没开就写不了（与 dsh 的 readOnly 句柄同意图）
      return { no: work.no, ok: false, reason: 'E_READ_ONLY：本会话只读（config.chat.allowWrite=false）', chars: 0 };
    }
    if (args.expectUpdatedAt != null && Number(args.expectUpdatedAt) !== Number(work.updated_at)) {
      return {
        no: work.no,
        ok: false,
        reason: `E_CONFLICT：该条目已被修改（期望 updated_at=${args.expectUpdatedAt}，实际 ${work.updated_at}），请先 re-read 再写`,
        chars: 0,
      };
    }
    const now = Date.now();
    run('UPDATE works SET note = ?, updated_at = ? WHERE id = ?', [note, now, work.id]);
    const after = get('SELECT updated_at FROM works WHERE id = ?', [work.id]);
    return { no: work.no, ok: true, chars: note.length, updatedAt: after ? after.updated_at : now };
  },
  render,
});
