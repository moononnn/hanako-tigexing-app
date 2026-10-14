// 会话 id 必须和 turn_end 那一套完全一致（同一个项目里两处各写一份规则必然出 bug），
// 所以直接复用 event-parse 的实现，不在这里重写一份。
import { sessionIdFromPath } from './event-parse.js';

// 提个醒 · 「叫醒还欠着」记账
//
// 背景（2026-10-13 实机探针取证）：
//   伙伴调 wait_for_tasks 等后台结果时，宿主先发 wait_finished，但叫醒不会立刻投进对话框——
//   会话还在生成（isStreaming=true）就被扣住，等它闲下来才投。这时候事件长这样：
//     registration.notification.state === "pending"
//   意思是「叫醒还欠着这个会话」。真等到 turn_end（伙伴甩了句进度话就停下）时，
//   后台任务计数早就归零了，门卫读 0 会误判成「说完了」，于是提前弹通知。
// 所以 pending 就是「后面还堵着输入」的权威信号：它亮着，这一回合就一定不是收尾。
//
// 清账：pending 翻成已投递宿主不上总线，App 看得见亮、看不见灭，只能借间接信号清：
//   - turn_start：叫醒真投进来了，这一回合确实在接着干 → 账清，之前那句确认是过程、不补发
//   - session_user_message：用户插话，叫醒作废 → 同样清
//   - session_closed：会话没了 → 清
// 兜底：pending 长时间不灭有可能是投递失败，等太久不能把窗口压成永久静音，
//   超过 WAIT_DEBT_TTL_MS 就放行并按「这版可能还会变」提示（与后台任务超时兜底同策略）。

// 超过这个时间仍没有 turn_start，说明叫醒多半送不进来了，放行别压死。
// 实测 pending 持有多久取决于会话闲不闲：会话已经空闲时约 50 毫秒就被消化；
// 会话还在生成时，实测持到 15.5 秒，2026-10-13 当晚那次持到 23 秒。
// 90 秒是在最差观察值上留的余量（不到 4 倍），不是“宽裕”数字——实机要盯。
export const WAIT_DEBT_TTL_MS = 90 * 1000;

/**
 * 从 wait_finished 事件里认「叫醒还欠着这个会话」。
 * 只认 state === 'pending'：已投递或已撤销都不该压住提醒。
 */
export function parseWaitDebt(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "wait_finished") return null;
  const reg = event.registration && typeof event.registration === "object" ? event.registration : null;
  if (!reg) return null;
  const state = String(reg?.notification?.state || "");
  if (state !== "pending") return null;

  const waitId = String(reg.waitId || "").trim();
  const regPath = typeof reg.sessionPath === "string" ? reg.sessionPath : "";
  const resolvedPath = typeof sessionPath === "string" && sessionPath ? sessionPath : regPath;
  // turn_end 走会话文件名做键，这里保持同一套键。
  const sessionId = String(sessionIdFromPath(resolvedPath) || reg.sessionId || "").trim();
  if (!sessionId) return null;
  return { sessionId, sessionPath: resolvedPath || null, waitId };
}

/**
 * 每个会话当前有几笔「叫醒欠着」。
 * 必须能自愈：宿主漏发 turn_start / 会话异常收场时，靠 TTL 放行，
 * 否则这个对话框从此不再响（和后台任务计数同一条教训）。
 */
export class WaitDebtTracker {
  constructor(options = {}) {
    this._waits = new Map(); // sessionId -> Map(waitId -> 记账时间)
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : WAIT_DEBT_TTL_MS;
  }

  mark(sessionId, waitId, now = Date.now()) {
    const sid = String(sessionId || "").trim();
    const wid = String(waitId || "").trim();
    if (!sid || !wid) return false;
    let waits = this._waits.get(sid);
    if (!waits) {
      waits = new Map();
      this._waits.set(sid, waits);
    }
    waits.set(wid, now);
    return true;
  }

  has(sessionId) {
    return this.count(sessionId) > 0;
  }

  count(sessionId) {
    return this._waits.get(String(sessionId || "").trim())?.size || 0;
  }

  /**
   * 释放超时未清掉的欠账（叫醒没投进来的兜底）。
   * @returns {string[]} 被清掉的 waitId，便于日志点名
   */
  prune(sessionId, now = Date.now(), ttlMs = this.ttlMs) {
    const sid = String(sessionId || "").trim();
    const waits = this._waits.get(sid);
    if (!waits) return [];
    const dead = [];
    for (const [waitId, at] of waits) {
      if (now - at > ttlMs) {
        waits.delete(waitId);
        dead.push(waitId);
      }
    }
    if (dead.length && !waits.size) this._waits.delete(sid);
    return dead;
  }

  /** 叫醒真投进来了 / 用户插话：账清，之前压住的那句是过程。 */
  clear(sessionId) {
    return this._waits.delete(String(sessionId || "").trim());
  }

  forget(sessionId) {
    return this.clear(sessionId);
  }

  clearAll() {
    this._waits.clear();
  }
}