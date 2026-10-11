// 提个醒 · 活动通知去重
// 记录同一活动已经发过的宿主通知，避免提个醒在 activity_update 后重复补弹。

import path from "node:path";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function buildActivityNotification(activity = {}) {
  const kindLabel = activity.kind === "scheduled" ? "计划任务" : "巡检";
  const statusLabel = activity.status === "error" ? "失败" : "完成";
  const title = `${activity.agentName || "助手"} · ${kindLabel}${statusLabel}`;
  const body = activity.label
    ? (activity.status === "error" ? `${activity.label} 执行失败` : `${activity.label} 已完成`)
    : (activity.summary || `${kindLabel}${statusLabel}`);
  return { title, body };
}

function keysFor(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];

  return [`path:${path.normalize(raw).toLowerCase()}`];
}

/**
 * 宿主的 activity.sessionFile 是 basename；通知事件带的是完整 sessionPath。
 * 活动目录固定在 agents/<agentId>/activity 下，因此这里先还原完整路径，
 * 不用全局 basename 做键，避免不同助手/目录同名时误判。
 */
export function resolveActivitySessionPath(agentsHome, agentId, sessionFile) {
  const raw = String(sessionFile || "").trim();
  if (!raw) return "";
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (!agentsHome || !agentId) return raw;
  return path.join(agentsHome, String(agentId), "activity", raw);
}

/**
 * 记录近期已发过宿主通知的活动文件。
 * activity_update 与 notification 可能前后到达，调用方会留短暂窗口再查一次；
 * TTL 只为兜底清理异常事件，避免长期占用内存。
 */
export class ActivityNotificationTracker {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.entries = new Map();
  }

  mark(value, now = Date.now()) {
    const keys = keysFor(value);
    this.prune(now);
    for (const key of keys) this.entries.set(key, now);
    return keys.length > 0;
  }

  has(value, now = Date.now()) {
    this.prune(now);
    return keysFor(value).some((key) => this.entries.has(key));
  }

  prune(now = Date.now()) {
    for (const [key, markedAt] of this.entries) {
      if (now - markedAt >= this.ttlMs) this.entries.delete(key);
    }
  }
}

export function activityNotificationKeys(value) {
  return keysFor(value);
}
