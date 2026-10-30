// 提个醒 · 通知「现在忙不忙」的复检与暂缓补发
//
// 锁的是 2026-10-26 实机故障：会话跑完一轮（stop），提个醒判定「说完了」，
// 但从判定到真正发出去中间走了分区查询 + 文案润色，整整 61 秒；
// 这期间窗口已经进了下一轮，通知才慢吞吞弹出来，看着就是「明明还在干活却报了回你啦」。
//
// 规则：发送前发现窗口还忙着，这条不丢——先扣在手里，等它闲下来补发；
// 真等太久还是忙，就带上「等太久了」照样发。每个回合都得有回响。

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
const SLOW_QUERY_MS = 40;
// 测试里把回看间隔压短，不用真等 15 秒 × 20 次。
const RETRY_MS = 50;
const MAX_TRIES = 3; // 50ms × 3 = 150ms 后带实情补发

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
          return { sessions: [{ path: SESSION_PATH, sessionId: SESSION_ID, title: "暂缓提醒测试" }] };
        }
        if (verb === "session:get") {
          await new Promise((resolve) => setTimeout(resolve, SLOW_QUERY_MS));
          return { session: { path: SESSION_PATH, sessionId: SESSION_ID, title: "暂缓提醒测试" } };
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
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
  toastDependencies.heldRetryMs = RETRY_MS;
  toastDependencies.heldMaxTries = MAX_TRIES;
  try {
    await apply(ctx);
    assert.ok(seen.subscribed, "应该订阅了总线");
    const send = (event) => seen.subscribed.callback(event, SESSION_PATH);
    send(userMessage());
    await sleep(50);
    await fn({ send, notified: seen.notified });
  } finally {
    toastDependencies.dependencies = undefined;
    toastDependencies.backgroundTasks = null;
    toastDependencies.heldRetryMs = null;
    toastDependencies.heldMaxTries = null;
    // 设 TIGEXING_KEEP_LOGS=1 可以留下临时目录，查日志用。
    if (!process.env.TIGEXING_KEEP_LOGS) fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("判定之后窗口又开工：当下不弹，等不动了再补，绝不静默", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("第二轮的中间汇报"));
    // 发送链路还在查会话、拼文案，这时候窗口已经进了下一轮
    send(turnStart());
    await sleep(60);
    assert.equal(notified.length, 0, "还忙着的时候不该弹「回你啦」");

    // 一直没等到收工，到次数上限后带着实情补上
    const arrived = await waitFor(() => notified.length > 0, 2000);
    assert.equal(arrived, true, "等超了也必须补一条，不能一声不响");
    const body = String(notified[0].body || "");
    assert.match(body, /等太久了/, "补发时要说清这是久等来的");
    assert.match(body, /中间汇报/, "原来的内容还在");
  });
});

test("判定之后又起后台任务：同样先扣住，不静默丢弃", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("先把话说完"));
    send(backgroundTask("upsert", "child-b"));
    await sleep(60);
    assert.equal(notified.length, 0, "后台任务又跑起来了，现在弹就是打断人");
    const arrived = await waitFor(() => notified.length > 0, 2000);
    assert.equal(arrived, true, "最后仍要有回响");
  });
});

test("对照：判定之后没有新动静，立刻提醒且不带久等说明", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("这回真说完了"));
    const ok = await waitFor(() => notified.length > 0, 1000);
    assert.equal(ok, true, "会话确实闲着，通知该马上弹");
    const body = String(notified[0].body || "");
    assert.doesNotMatch(body, /等太久了/);
    assert.match(`${notified[0].title || ""}`, /暂缓提醒测试/, "标题带会话名");
  });
});

test("开工后那一轮自己说完：弹新的那条，旧的不重复弹", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("中间汇报"));
    send(turnStart());
    await sleep(40);
    assert.equal(notified.length, 0, "第一条先扣着");
    send(turnEnd("这才是结论"));
    const ok = await waitFor(() => notified.length > 0, 1500);
    assert.equal(ok, true, "真结论要弹出来");
    // 断言弹出来的是「真结论」那条，而不是扣着的「中间汇报」——
    // 不按数组下标断言：机器忙时，扣着的那条可能在等待里就补发了，
    // 那时 notified[0] 装的是它，按下标断言就成了测机器快慢。
    const bodies = notified.map((n) => String(n.body || ""));
    assert.equal(bodies.length, 1, "只该弹一条");
    assert.match(bodies[0], /这才是结论/);
    const waited = await sleep(300).then(() => notified.length);
    assert.equal(waited, 1, "扣着的那条已被新回响接替，不该再冒一条");
  });
});
