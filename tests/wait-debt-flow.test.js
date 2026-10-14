// 提个醒 · 「叫醒还欠着」端到端接线测试
//
// 复现 2026-10-13 23:13:13 那次提前弹的真实时序（探针取证）：
//   15:12:50  wait_finished → notification.state = pending（叫醒被宿主扣住）
//   15:13:13  turn_end，正文是一句进度汇报（后台任务早已收工，门卫读 0）→ 旧实现弹了
//   15:13:24  turn_start（叫醒真投进来了）
//   15:14:55  turn_end，真结论 → 这才该弹
//
// 这里只验接线层，纯逻辑在 wait-debt.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { apply, toastDependencies } from "../index.js";
import { WaitDebtTracker } from "../lib/wait-debt.js";

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

const SESSION_PATH = "C:/fake/.hanako/agents/hanako/sessions/waitdebt-1.jsonl";
const SESSION_ID = "waitdebt-1";

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
          return { sessions: [{ path: SESSION_PATH, sessionId: SESSION_ID, title: "欠账测试" }] };
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

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

const userMessage = () => ({ type: "session_user_message", sessionId: SESSION_ID });
const turnStart = () => ({ type: "turn_start", agentId: "hanako" });
const turnEnd = (text) => ({
  type: "turn_end",
  agentId: "hanako",
  message: { stopReason: "stop", content: [{ type: "text", text }] }
});
const waitFinished = (state, waitId = "wait:test-1") => ({
  type: "wait_finished",
  registration: {
    waitId,
    sessionId: SESSION_ID,
    sessionPath: SESSION_PATH,
    status: "settled",
    notification: state ? { state } : undefined
  }
});

async function withHarness(fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-debt-"));
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ mergeWindowMs: 1, ...(options.preferences || {}) }),
    "utf8"
  );
  const { ctx, seen } = makeCtx(dir);
  toastDependencies.dependencies = { spawnProcess: blockedSpawn, timeoutMs: 200 };
  toastDependencies.deferredFlushGraceMs = 40;
  if (options.waitDebtTtlMs) toastDependencies.waitDebt = new WaitDebtTracker({ ttlMs: options.waitDebtTtlMs });
  try {
    await apply(ctx);
    const send = (event) => seen.subscribed.callback(event, SESSION_PATH);
    send(userMessage());
    await waitFor(() => true, 50);
    await fn({ send, notified: seen.notified });
  } finally {
    toastDependencies.dependencies = undefined;
    toastDependencies.waitDebt = null;
    toastDependencies.deferredFlushGraceMs = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("对照：没有欠账时，完成回合照常提醒", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd("先把活干完了"));
    assert.equal(await waitFor(() => notified.length > 0), true);
    assert.match(String(notified[0].body || ""), /先把活干完了/);
  });
});

test("回归 2026-10-13：叫醒还欠着时，进度句不弹；turn_start 之后真结论才弹", async () => {
  await withHarness(async ({ send, notified }) => {
    // 慢活结算，叫醒被宿主扣住
    send(waitFinished("pending"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 伙伴甩了句进度话就停下——后台任务早已收工，旧实现就是在这里误弹的
    send(turnEnd("已经找到，正在导出"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(notified.length, 0, "叫醒还欠着，这一句是过程句，不该弹");

    // 叫醒真投进来了 → 清账，那句过程句直接丢弃不补发
    send(turnStart());
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(notified.length, 0, "确认是过程句后不应补发");

    // 真结论
    send(turnEnd("这是真正的结论"));
    assert.equal(await waitFor(() => notified.length > 0), true, "真收尾时必须提醒");
    assert.equal(notified.length, 1, "只弹一条");
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(text, /这是真正的结论/);
    assert.doesNotMatch(text, /已经找到，正在导出/, "过程句不该混进来");
  });
});

// 最该锁的一条：叫醒迟迟不来（不补 turn_start）时，窗口不能被压死。
// prune 只在完成回合到来时触发——没有回合就没有提醒需求，这是现有架构的前提。
test("叫醒投递失败：不补 turn_start，欠账不能把窗口永久压死", async () => {
  await withHarness(
    async ({ send, notified }) => {
      send(waitFinished("pending"));
      send(turnEnd("过程句"));
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(notified.length, 0, "欠账期间第一句是过程句，压住");

      // 欠账一直不销，但下一个完成回合到了 → 兵底放行
      send(turnEnd("后来的消息"));
      assert.equal(await waitFor(() => notified.length > 0), true, "兵底后必须能提醒");
      assert.equal(notified.length, 1);
      const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
      assert.match(text, /后来的消息/);
      assert.doesNotMatch(text, /过程句/, "兵底放行不补发旧回合，只弹当前这条");
      assert.match(text, /这版可能还会变/);
    },
    { waitDebtTtlMs: 30 }
  );
});

test("已投递的 wait_finished 不影响正常提醒", async () => {
  await withHarness(async ({ send, notified }) => {
    send(waitFinished("delivered"));
    send(turnEnd("说完了"));
    assert.equal(await waitFor(() => notified.length > 0), true, "已投递不该压住");
  });
});

test("用户插话会让叫醒作废，销账后不再压住", async () => {
  await withHarness(async ({ send, notified }) => {
    send(waitFinished("pending"));
    send(turnEnd("先说一句"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notified.length, 0);

    send(userMessage());
    await new Promise((resolve) => setTimeout(resolve, 50));
    send(turnEnd("插话之后的回复"));
    assert.equal(await waitFor(() => notified.length > 0), true, "用户插话后不该一直被压着");
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(text, /插话之后的回复/);
    assert.doesNotMatch(text, /先说一句/);
  });
});

test("兜底：叫醒迟迟不投递也不能把窗口压死，超时后带实情提示", async () => {
  await withHarness(
    async ({ send, notified }) => {
      send(waitFinished("pending"));
      send(turnEnd("过程句"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(notified.length, 0);

      // 超 TTL 后的下一个回合：放行
      send(turnEnd("后来的消息"));
      assert.equal(await waitFor(() => notified.length > 0), true, "超时兜底后应能提醒");
      assert.equal(notified.length, 1, "不能既弹当前回合又补发旧回合");
      const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
      assert.match(text, /后来的消息/);
      assert.doesNotMatch(text, /过程句/);
      assert.match(text, /这版可能还会变/, "兜底放行要说清实情");
      assert.doesNotMatch(notified[0].title || "", /这版可能还会变/, "提示只进正文，不进标题");
    },
    { waitDebtTtlMs: 30 }
  );
});

test("同一会话两笔欠账：一次 turn_start 全部销账（语义锁定）", async () => {
  await withHarness(async ({ send, notified }) => {
    send(waitFinished("pending", "wait:a"));
    send(waitFinished("pending", "wait:b"));
    send(turnEnd("过程句甲"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notified.length, 0);

    send(turnStart());
    await new Promise((resolve) => setTimeout(resolve, 50));
    send(turnEnd("真结论"));
    assert.equal(await waitFor(() => notified.length > 0), true, "两笔账一起销干净才能正常提醒");
    assert.equal(notified.length, 1);
  });
});

test("欠账与后台任务各压各的，互不误取", async () => {
  await withHarness(async ({ send, notified }) => {
    send(waitFinished("pending"));
    send(turnEnd("等叫醒的过程句"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(notified.length, 0);

    // 叫醒投递，新回合开工 → 欠账销掉
    send(turnStart());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 同时子伙伴在跑
    send({ type: "session_background_task", action: "upsert", taskId: "child-a", sessionId: SESSION_ID, task: { status: "running" } });
    send(turnEnd("子伙伴还在跑"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notified.length, 0, "后台任务压住时不该弹");

    send({ type: "session_background_task", action: "remove", taskId: "child-a", sessionId: SESSION_ID, task: { status: "completed" } });
    assert.equal(await waitFor(() => notified.length > 0), true, "后台任务收齐后应补发");
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(text, /子伙伴还在跑/, "补的是后台任务压住的那条");
    assert.doesNotMatch(text, /等叫醒的过程句/, "欠账压住的那条本来就不补发");
  });
});

test("会话关闭时欠账一并清掉，别留给下一个同名会话", async () => {
  await withHarness(async ({ send, notified }) => {
    send(waitFinished("pending"));
    send(turnEnd("过程句"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    send({ type: "session_closed", sessionId: SESSION_ID, sessionPath: SESSION_PATH });
    await new Promise((resolve) => setTimeout(resolve, 50));
    send(turnEnd("关掉之后的正常回复"));
    assert.equal(await waitFor(() => notified.length > 0), true, "会话关闭后不该继续压着");
  });
});