/**
 * 进行中的轮次（取消用）。两个引擎共用一张表：`cancelTurn` 只需拿到 chatId，
 * 不关心当前跑的是 legacy 还是 tools 引擎。
 */
const inflight = new Map(); // chatId → { messageId, ctl, engine }

export function registerTurn(chatId, entry) {
  inflight.set(Number(chatId), entry);
}

export function clearTurn(chatId) {
  inflight.delete(Number(chatId));
}

export function getTurn(chatId) {
  return inflight.get(Number(chatId));
}

export function inflightSize() {
  return inflight.size;
}
