// 提个醒 · 对话框后台任务追踪
// 只记录某个对话框当前仍在运行的后台任务（如子 agent），不发送通知。
//
// 计数必须能自愈：宿主偶尔只发 upsert 不发 remove（子 agent 异常收场、事件丢失、
// 会话被强行关闭），一条漏掉的 remove 会让该对话框从此永久静音。因此每个任务带
// 一个 upsert 时间戳，超过 TTL 未更新就按「不再运行」兜底释放。

// 会话内超过这个时间没有新事件，就认为后台任务已经收不到结果了，兜底放行。
export const BACKGROUND_TASK_TTL_MS = 10 * 60 * 1000;

const TERMINAL_STATUS = new Set(["completed", "failed", "canceled", "aborted"]);

export class BackgroundTaskTracker {
  constructor(options = {}) {
    this._tasks = new Map(); // sessionId -> Map(taskId -> upsert 时间戳)
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : BACKGROUND_TASK_TTL_MS;
  }

  update(task, now = Date.now()) {
    const sessionId = String(task?.sessionId || "").trim();
    const taskId = String(task?.taskId || "").trim();
    if (!sessionId || !taskId) return false;

    let tasks = this._tasks.get(sessionId);
    if (task.action === "upsert") {
      if (TERMINAL_STATUS.has(String(task.status || "").toLowerCase())) {
        return this._remove(sessionId, taskId);
      }
      if (!tasks) {
        tasks = new Map();
        this._tasks.set(sessionId, tasks);
      }
      tasks.set(taskId, now);
      return true;
    }
    if (task.action === "remove") {
      return this._remove(sessionId, taskId);
    }
    return false;
  }

  _remove(sessionId, taskId) {
    const tasks = this._tasks.get(sessionId);
    if (!tasks) return true;
    tasks.delete(taskId);
    if (!tasks.size) this._tasks.delete(sessionId);
    return true;
  }

  /**
   * 释放超时未更新的任务（漏掉的 remove 兜底）。
   * @returns {string[]} 被清掉的 taskId，便于日志点名
   */
  prune(sessionId, now = Date.now(), ttlMs = this.ttlMs) {
    const tasks = this._tasks.get(String(sessionId || "").trim());
    if (!tasks) return [];
    const dead = [];
    for (const [taskId, at] of tasks) {
      if (now - at > ttlMs) {
        tasks.delete(taskId);
        dead.push(taskId);
      }
    }
    if (dead.length && !tasks.size) this._tasks.delete(String(sessionId).trim());
    return dead;
  }

  has(sessionId) {
    return this.count(sessionId) > 0;
  }

  count(sessionId) {
    return this._tasks.get(String(sessionId || "").trim())?.size || 0;
  }

  /** 会话关闭时清账，别把泄漏带到下一个同名会话上。 */
  forget(sessionId) {
    return this._tasks.delete(String(sessionId || "").trim());
  }

  clear() {
    this._tasks.clear();
  }
}