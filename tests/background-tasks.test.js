// 提个醒 · 对话框后台任务门测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundTaskTracker, BACKGROUND_TASK_TTL_MS } from "../lib/background-tasks.js";

const task = (action, taskId, sessionId = "sess_main") => ({ action, taskId, sessionId });

test("后台任务门：任一子 agent 运行时保持阻塞", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a"));
  tracker.update(task("upsert", "child-b"));
  assert.equal(tracker.has("sess_main"), true);
  assert.equal(tracker.count("sess_main"), 2);
  tracker.update(task("remove", "child-a"));
  assert.equal(tracker.has("sess_main"), true);
  assert.equal(tracker.count("sess_main"), 1);
});

test("后台任务门：全部子 agent 收齐后解除阻塞", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a"));
  tracker.update({ ...task("upsert", "child-a"), status: "completed" });
  assert.equal(tracker.has("sess_main"), false);
  assert.equal(tracker.count("sess_main"), 0);
});

test("后台任务门：终态 upsert 也解除阻塞", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a"));
  tracker.update({ ...task("upsert", "child-a"), status: "failed" });
  assert.equal(tracker.has("sess_main"), false);
});

test("后台任务门：不同对话框互不影响，非法事件不改变状态", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a", "sess-a"));
  assert.equal(tracker.has("sess-a"), true);
  assert.equal(tracker.has("sess-b"), false);
  assert.equal(tracker.update({ action: "unknown", taskId: "x", sessionId: "sess-a" }), false);
  assert.equal(tracker.update({ action: "remove", taskId: "missing", sessionId: "sess-a" }), true);
  assert.equal(tracker.has("sess-a"), true);
});

// ── 漏掉 remove 的兜底（2026-10-12 真实故障：一条后台任务 55 分钟没收到结束事件，会话永久静音） ──

test("兜底：remove 丢失时，超时任务被释放，会话恢复可提醒", () => {
  const t0 = 1_000_000;
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "leaked"), t0);
  assert.equal(tracker.has("sess_main"), true);

  // TTL 内不动
  assert.deepEqual(tracker.prune("sess_main", t0 + BACKGROUND_TASK_TTL_MS), []);
  assert.equal(tracker.has("sess_main"), true);

  // 超时后释放，并点名被清掉的 taskId 供日志定位
  const dead = tracker.prune("sess_main", t0 + BACKGROUND_TASK_TTL_MS + 1);
  assert.deepEqual(dead, ["leaked"]);
  assert.equal(tracker.has("sess_main"), false);
  assert.equal(tracker.count("sess_main"), 0);
});

test("兜底：只清超时的那个，仍在跑的继续挡着", () => {
  const t0 = 1_000_000;
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "old"), t0);
  tracker.update(task("upsert", "fresh"), t0 + BACKGROUND_TASK_TTL_MS);
  const dead = tracker.prune("sess_main", t0 + BACKGROUND_TASK_TTL_MS * 2);
  assert.deepEqual(dead, ["old"]);
  assert.equal(tracker.count("sess_main"), 1);
});

test("兜底：新事件刷新时间戳，长任务不会被误清", () => {
  const t0 = 1_000_000;
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "long-runner"), t0);
  // 同一个 taskId 反复上报，等于它在持续心跳
  for (let i = 1; i <= 3; i += 1) {
    tracker.update(task("upsert", "long-runner"), t0 + i * BACKGROUND_TASK_TTL_MS);
    assert.deepEqual(tracker.prune("sess_main", t0 + i * BACKGROUND_TASK_TTL_MS), []);
    assert.equal(tracker.has("sess_main"), true);
  }
});

test("兜底：会话关闭时清账，不留给下一个同名会话", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a"));
  assert.equal(tracker.forget("sess_main"), true);
  assert.equal(tracker.has("sess_main"), false);
  assert.equal(tracker.forget("sess_main"), false);
});
