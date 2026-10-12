// 提个醒 · 完成提醒端到端链路测试（后台任务挡下 → 收齐 → 补发）
//
// 锁的是 2026-10-12 真实故障的接线：旧实现里 handleTurnEnd 看到后台任务在跑就直接
// return，全项目没有「收齐后补发」这个动作，被压下的完成提醒永久丢失
// （当日 04:12:34 起一条后台任务 55 分钟没收到结束事件，会话全程静音）。
//
// 这里只验接线层：暂存与超时的纯逻辑在 background-tasks.test.js / deferred-turns.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { apply, toastDependencies } from "../index.js";

// 假 spawn：立即报启动失败，sendToast 返回 false 后退回宿主通道，
// 既走完真实链路，又不会真的拉 PowerShell 弹系统通知。
function blockedSpawn() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {};
  child.unref = () => {};
  setImmediate(() => {
    child.emit("error", new Error("测试环境不启动 PowerShell"));
    stdout.destroy();
    stderr.destroy();
  });
  return child;
}

const SESSION_PATH = "C:/fake/.hanako/agents/hanako/sessions/e2e-1.jsonl";
const SESSION_ID = "e2e-1";

function makeCtx(dataDir) {
  const seen = { subscribed: null, notified: [] };
  const ctx = {
    dataDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bus: {
      subscribe(callback, filter) {
        seen.subscribed = { callback, filter };
        return () => {};
      },
      async request(verb) {
        if (verb === "agent:list") return { agents: [{ id: "hanako", name: "小花" }] };
        if (verb === "session:list") {
          return { sessions: [{ path: SESSION_PATH, sessionId: SESSION_ID, title: "端到端测试" }] };
        }
        return {};
      }
    },
    notifications: {
      async show(input) {
        seen.notified.push(input);
        return { shown: true };
      }
    },
    routes: { register() {} }
  };
  return { ctx, seen };
}

/** 总线回调是 void async，这里轮询等它把活干完，不用拍脑袋的固定等待。 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

const userMessage = () => ({ type: "session_user_message", sessionId: SESSION_ID });
const backgroundTask = (action, taskId) => ({
  type: "session_background_task",
  action,
  taskId,
  sessionId: SESSION_ID,
  task: { status: "running" }
});
const turnEnd = (text) => ({
  type: "turn_end",
  agentId: "hanako",
  message: { stopReason: "stop", content: [{ type: "text", text }] }
});

async function withHarness(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-e2e-"));
  // 合并窗口：默认 30 秒防轰炸；配成 0 = 完全不合并，每条最终回复各弹一张。
  // （入口处必须用 `?? 30000`，用 `||` 会把 0 当假值兜回 30 秒。）
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ mergeWindowMs: 1 }),
    "utf8"
  );
  const { ctx, seen } = makeCtx(dir);
  toastDependencies.dependencies = { spawnProcess: blockedSpawn, timeoutMs: 200 };
  try {
    await apply(ctx);
    assert.ok(seen.subscribed, "应该订阅了总线");
    const send = (event) => seen.subscribed.callback(event, SESSION_PATH);
    send(userMessage());
    await waitFor(() => true, 50);
    await fn({ send, notified: seen.notified });
  } finally {
    toastDependencies.dependencies = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("对照：没有后台任务时，完成回合照常提醒", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("先把活干完了"));
    const ok = await waitFor(() => notified.length > 0);
    assert.equal(ok, true, "没有后台任务时应该弹通知");
    const shown = notified[0];
    const text = `${shown.title || ""} ${shown.body || ""}`;
    assert.match(text, /端到端测试/, "标题应带会话名");
  });
});

test("后台任务在跑时不弹；收齐后补发被压下的那一条", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("子伙伴还在跑，先出一版"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notified.length, 0, "后台任务没收齐不该弹");

    send(backgroundTask("remove", "child-a"));
    const ok = await waitFor(() => notified.length > 0);
    assert.equal(ok, true, "后台任务收齐后应补发");
    assert.equal(notified.length, 1, "只补一条，不刷屏");
  });
});

test("窗口内连续多条被压下的回合，只补发最后一条", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("中间结果甲"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    send(turnEnd("中间结果乙"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(notified.length, 0);

    send(backgroundTask("remove", "child-a"));
    const ok = await waitFor(() => notified.length > 0);
    assert.equal(ok, true);
    assert.equal(notified.length, 1, "多条压下也只补一条");
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(text, /中间结果乙/, "补的应该是最后那条");
    assert.doesNotMatch(text, /中间结果甲/);
  });
});

test("没有暂存时不凭空补发", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(backgroundTask("remove", "child-a"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(notified.length, 0, "没压下过回合就不该有通知");
  });
});

// 回归：合并窗口配 0 必须真的关掉合并。曾经入口写的是 `|| 30000`，0 被当假值兜回 30 秒，
// 导致「0 = 不合并」这个配置根本不生效。
test("合并窗口配 0 时不合并，两条回复各弹一张", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-merge0-"));
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ mergeWindowMs: 0 }),
    "utf8"
  );
  const { ctx, seen } = makeCtx(dir);
  toastDependencies.dependencies = { spawnProcess: blockedSpawn, timeoutMs: 200 };
  try {
    await apply(ctx);
    const send = (event) => seen.subscribed.callback(event, SESSION_PATH);
    send(userMessage());
    await new Promise((resolve) => setTimeout(resolve, 50));

    send(turnEnd("第一条"));
    assert.equal(await waitFor(() => seen.notified.length > 0), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    send(turnEnd("第二条"));
    assert.equal(await waitFor(() => seen.notified.length > 1), true, "0 窗口下第二条不该被合并");
    assert.equal(seen.notified.length, 2, "两条应各弹一张，不合并");
  } finally {
    toastDependencies.dependencies = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});