// 提个醒 · 被后台任务挡下的完成回合暂存
//
// 后台任务还在跑时，主对话框的完成回合先压在这里；等后台任务收齐再取出来补发一条。
// 每个会话只留最后一条：补发只要一个信号，多弹既吵也没有信息量。
// 暂存太久就把结果丢掉，避免隔很久突然冒出一条过期提醒。

// 暂存超过这个时间就不再补发。
export const DEFERRED_TURN_TTL_MS = 5 * 60 * 1000;

export class DeferredTurns {
  constructor(options = {}) {
    this._items = new Map(); // sessionId -> { info, at }
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFERRED_TURN_TTL_MS;
  }

  stash(sessionId, info, now = Date.now()) {
    const sid = String(sessionId || "").trim();
    if (!sid || !info) return false;
    this._items.set(sid, { info, at: now });
    return true;
  }

  /** 取出并清除；过期或不存在返回 null。 */
  take(sessionId, now = Date.now(), ttlMs = this.ttlMs) {
    const sid = String(sessionId || "").trim();
    const item = this._items.get(sid);
    if (!item) return null;
    this._items.delete(sid);
    return now - item.at > ttlMs ? null : item.info;
  }

  has(sessionId) {
    return this._items.has(String(sessionId || "").trim());
  }

  count(sessionId) {
    return this.has(sessionId) ? 1 : 0;
  }

  forget(sessionId) {
    return this._items.delete(String(sessionId || "").trim());
  }

  clear() {
    this._items.clear();
  }
}