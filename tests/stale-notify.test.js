// 提个醒 · 判定过时就不再发的接线测试
//
// 锁的是 2026-10-26 实机故障：会话跑完一轮（stop），提个醒判定「说完了」，
// 但从判定到真正发出去中间走了分区查询 + 文案润色，整整 61 秒；
// 这期间窗口已经进了下一轮，通知才慢吞吞弹出来，看着就是「明明还在干活却报了回你啦」。
//
// 现在的规则：判定之后只要这个会话又开工（turn_start）、又起后台任务、又开始等叫醒，
// 这条提醒就作废，不弹。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { apply, toastDependencies } from "../index.js";

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

const SESSION_PATH = "C:/fake/.hanako/agents/hanako/sessions/stale-1.jsonl";
const SESSION_ID = "stale-1";
// 会话查询要拖一点：真实环境里就是这段时间让「判定」和「发送」分了家。
const SLOW_QUERY_MS = 60;

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
          await new Promise((resolve) => setTimeout(resolve, SLOW_QUERY_MS));
          return { sessions: [{ path: SESSION_PATH, sessionId: SESSION_ID, title: "过时提醒测试" }] };
        }
        if (verb === "session:get") {
          await new Promise((resolve) => setTimeout(resolve, SLOW_QUERY_MS));
          return { session: { path: SESSION_PATH, sessionId: SESSION_ID, title: "过时提醒测试" } };
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

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

const userMessage = () => ({ type: "session_user_message", sessionId: SESSION_ID });
const turnStart = () => ({ type: "turn_start", sessionId: SESSION_ID });
const turnEnd = (text) => ({
  type: "turn_end",
  agentId: "hanako",
  message: { stopReason: "stop", content: [{ type: "text", text }] }
});
const backgroundTask = (action, taskId) => ({
  type: "session_background_task",
  action,
  taskId,
  sessionId: SESSION_ID,
  task: { status: "running" }
});

async function withHarness(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-stale-"));
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
    toastDependencies.backgroundTasks = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("判定之后窗口又开工：这条「回你啦」作废", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("第二轮的中间汇报"));
    // 发送链路还在查会话、拼文案，这时候窗口已经进了下一轮
    send(turnStart());
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(notified.length, 0, "已经开工了还弹「回你啦」就是误导，应当作废");
  });
});

test("判定之后又起了后台任务：作废", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("先把话说完"));
    send(backgroundTask("upsert", "child-b"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(notified.length, 0, "后台任务又跑起来了，后面还有话要说，这条不该弹");
  });
});

test("对照：判定之后没有新动静，照常提醒", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("这回真说完了"));
    const ok = await waitFor(() => notified.length > 0);
    assert.equal(ok, true, "会话确实闲着，通知该弹");
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(text, /过时提醒测试/, "标题带会话名");
  });
});

test("开工之后那一轮自己说完，仍然会正常提醒", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("中间汇报"));
    send(turnStart());
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(notified.length, 0, "第一条作废");
    send(turnEnd("这才是结论"));
    const ok = await waitFor(() => notified.length > 0);
    assert.equal(ok, true, "新回合说完要照常提醒，不能一压到底");
    assert.match(`${notified[0].body || ""}`, /这才是结论/);
  });
});
