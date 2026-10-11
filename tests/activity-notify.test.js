// 提个醒 · 计划任务通知去重测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ActivityNotificationTracker,
  activityNotificationKeys,
  buildActivityNotification,
  resolveActivitySessionPath
} from "../lib/activity-notify.js";
import { parseActivityUpdate } from "../lib/event-parse.js";

const ENTRY = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const SETTINGS = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");

test("计划任务成功提醒：标题和正文使用任务名", () => {
  assert.deepEqual(buildActivityNotification({
    kind: "scheduled", status: "done", agentName: "小花", label: "每日备份"
  }), {
    title: "小花 · 计划任务完成",
    body: "每日备份 已完成"
  });
});

test("巡检失败提醒：显示失败状态与摘要", () => {
  assert.deepEqual(buildActivityNotification({
    kind: "patrol", status: "error", agentName: "小花", summary: "日常巡检执行失败"
  }), {
    title: "小花 · 巡检失败",
    body: "日常巡检执行失败"
  });
});

test("活动提醒接入两类事件、各自档位、静默时段与原版通知去重", () => {
  assert.match(ENTRY, /const activity = parseActivityUpdate\(event\)/);
  assert.match(ENTRY, /await handleActivityUpdate\(activity\)/);
  assert.match(ENTRY, /activity\.kind === 'scheduled' \? 'scheduledTrigger' : 'patrolTrigger'/);
  assert.match(ENTRY, /activityNotifications\.has\(activitySessionPath\)/);
  assert.match(ENTRY, /isInQuietHours\(cfg\)/);
});

test("设置页不再把计划任务和巡检提醒标成未接入", () => {
  assert.doesNotMatch(SETTINGS, /还没接上计划任务的接管/);
  assert.doesNotMatch(SETTINGS, /还没接上巡检完成的接管/);
  assert.match(SETTINGS, /scheduledTrigger/);
  assert.match(SETTINGS, /patrolTrigger/);
  assert.match(SETTINGS, /同一巡检的原版通知，提个醒会跳过补弹/);
});

test("巡检通知：heartbeat sessionFile 可以还原到伙伴活动目录", () => {
  const activity = parseActivityUpdate({
    type: "activity_update",
    activity: { type: "heartbeat", agentId: "hanako", sessionFile: "heartbeat_123.jsonl" }
  });
  assert.equal(
    resolveActivitySessionPath("C:/Users/x/.hanako/agents", activity.agentId, activity.sessionFile),
    "C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\heartbeat_123.jsonl"
  );
});

test("活动通知去重：notification 全路径能和 activity_update 文件名还原后的路径对上", () => {
  const tracker = new ActivityNotificationTracker();
  const fullPath = "C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\cron_123.jsonl";
  tracker.mark(fullPath, 1000);
  const activity = parseActivityUpdate({
    type: "activity_update",
    activity: { type: "cron", agentId: "hanako", sessionFile: "cron_123.jsonl" }
  });
  const activityPath = resolveActivitySessionPath("C:/Users/x/.hanako/agents", activity.agentId, activity.sessionFile);

  assert.equal(tracker.has(activityPath, 2000), true);
});

test("活动通知去重：activity_update 先到时，后到 notification 仍可命中", () => {
  const tracker = new ActivityNotificationTracker();
  const activityPath = resolveActivitySessionPath("C:/Users/x/.hanako/agents", "hanako", "cron_456.jsonl");
  assert.equal(tracker.has(activityPath, 1000), false);
  tracker.mark("C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\cron_456.jsonl", 1200);
  assert.equal(tracker.has(activityPath, 1300), true);
});

test("活动通知去重：不同完整路径的同名活动不会互相误判", () => {
  const tracker = new ActivityNotificationTracker();
  tracker.mark("C:/Users/x/.hanako/agents/hanako/activity/cron_same.jsonl", 1000);
  assert.equal(
    tracker.has("C:/Users/x/.hanako/agents/bob/activity/cron_same.jsonl", 1001),
    false
  );
});

test("活动通知去重：同一 sessionFile 兼容斜杠差异", () => {
  const tracker = new ActivityNotificationTracker();
  tracker.mark("C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\cron_123.jsonl", 1000);

  assert.equal(
    tracker.has("C:/Users/x/.hanako/agents/hanako/activity/cron_123.jsonl", 2000),
    true
  );
});

test("活动通知去重：空路径不误判", () => {
  const tracker = new ActivityNotificationTracker();
  assert.equal(tracker.mark("", 1000), false);
  assert.equal(tracker.has("", 1000), false);
});

test("活动通知去重：过期标记会清理", () => {
  const tracker = new ActivityNotificationTracker(1000);
  tracker.mark("C:/activity/cron.jsonl", 1000);
  assert.equal(tracker.has("C:/activity/cron.jsonl", 1999), true);
  assert.equal(tracker.has("C:/activity/cron.jsonl", 2000), false);
});

test("活动通知去重：只使用规范化完整路径键", () => {
  assert.deepEqual(
    activityNotificationKeys("C:/activity/cron.jsonl"),
    ["path:c:\\activity\\cron.jsonl"]
  );
});
