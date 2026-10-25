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
import { BackgroundTaskTracker } from "../lib/background-tasks.js";

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

async function withHarness(fn, preferences = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-e2e-"));
  // 合并窗口：默认 30 秒防轰炸；配成 0 = 完全不合并，每条最终回复各弹一张。
  // （入口处必须用 `?? 30000`，用 `||` 会把 0 当假值兜回 30 秒。）
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ mergeWindowMs: 1, ...preferences }),
    "utf8"
  );
  const { ctx, seen } = makeCtx(dir);
  toastDependencies.dependencies = { spawnProcess: blockedSpawn, timeoutMs: 200 };
  // 补发现在先过一段静默期（生产 5 秒），测试里注入短值。
  toastDependencies.deferredFlushGraceMs = 40;
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
    toastDependencies.deferredFlushGraceMs = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("后台任务还在跑时，空返回不抢着提醒", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd(""));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(notified.length, 0, "假回合：还有后台任务在跑，后面一定还会起真回合");

    // 任务收工后真回合说了话，正常提醒，不带异常文案
    send(backgroundTask("remove", "child-a"));
    send(turnEnd("这才是真结果"));
    assert.equal(await waitFor(() => notified.length > 0), true);
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(text, /这才是真结果/);
    assert.doesNotMatch(text, /没出声/);
  });
});

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

test("空内容的完成事件不冒充正常回复提醒，后续有正文时仍正常提醒", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd(""));
    // 空返回现在会走异常提醒（一条「这轮没出声」），不再是完全静音；
    // 它仍然不能冒充「伙伴回你啦」那种完成提醒。
    const alerted = await waitFor(() => notified.length > 0, 6000);
    assert.equal(alerted, true, "空返回应当有一条异常提醒，不能两边一起哑掉");
    assert.equal(notified.length, 1, "同一轮只提醒一次");
    const firstText = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(firstText, /没出声/, "文案要说清是没出声，不是报错");
    assert.doesNotMatch(firstText, /回你啦/, "不能冒充正常完成");

    notified.length = 0;
    send(turnEnd("这是实际回复"));
    assert.equal(await waitFor(() => notified.length > 0), true, "后续真实正文仍应正常提醒");
    assert.equal(notified.length, 1);
    assert.match(String(notified[0].body || ""), /这是实际回复/);
  });
});

test("空返回的异常提醒在断联开关关闭时不弹", async () => {
  await withHarness(async ({ send, notified }) => {
    send(turnEnd(""));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(notified.length, 0, "关掉断联提醒后，空返回也不该弹");
  }, { abnormalEnabled: false });
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

// 回归 2026-10-14 12:37：后台任务收齐的那一刻，伙伴几乎总要接着干（实测收齐到新回合
// 开工只隔 95 毫秒）。旧逻辑在收齐瞬间就弹，弹出来时窗口已经复活，工作还在跑。
test("回归 2026-10-14：收齐后不立刻弹，先过静默期", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("先出一版"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(notified.length, 0);

    send(backgroundTask("remove", "child-a"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(notified.length, 0, "收齐那一刻不该弹，等静默期过完");

    assert.equal(await waitFor(() => notified.length > 0), true, "静默期到了仍该补发");
    assert.equal(notified.length, 1);
  });
});

test("静默期内窗口又开工，补发作废（那是过程句，不是收尾）", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("过程句"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    send(backgroundTask("remove", "child-a"));
    send({ type: "turn_start", agentId: "hanako" });   // 叫醒回来了，继续干活
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notified.length, 0, "又开工了就不该补发那条");

    // 真正说完的那句自然会弹
    send(turnEnd("这才是真结论"));
    assert.equal(await waitFor(() => notified.length > 0), true);
    assert.equal(notified.length, 1);
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.match(text, /这才是真结论/);
    assert.doesNotMatch(text, /过程句/, "过程句不该混进来");
  });
});

test("静默期内会话关闭，不补发", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("过程句"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    send(backgroundTask("remove", "child-a"));
    send({ type: "session_closed", sessionId: SESSION_ID, sessionPath: SESSION_PATH });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(notified.length, 0, "会话没了就不该再补发");
  });
});

// 显式锁住一条已知漏报：补发被静默期取消后，如果紧接着的新回合又被用户打断或正文为空，
// 那条过程句就彻底没人提醒了（用户自己就在窗口里，这个体感可接受，但它确实是漏报）。
// 写在这里是给下一个人看：这层没有兜底。
test("已知残留：补发取消后新回合被打断，一条都不弹", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("过程句"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    send(backgroundTask("remove", "child-a"));
    send({ type: "turn_start", agentId: "hanako" });        // 又开工 → 补发作废
    await new Promise((resolve) => setTimeout(resolve, 20));
    send({
      type: "turn_end",
      agentId: "hanako",
      aborted: true,
      message: { stopReason: "stop", content: [{ type: "text", text: "被用户打断" }] }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notified.length, 0, "用户主动打断本来就不该弹（中断回合跳过规则）");
  });
});

// 开工晚于静默期：会先弹一条已被取代的过程句，再弹真结论。
// 这是当前设计的已知代价（宁可多弹也不漏弹），用测试写实，免得后人当成意外。
test("已知代价：开工晚于静默期时先弹过程句，真结论再弹", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("过程句"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    send(backgroundTask("remove", "child-a"));
    await new Promise((resolve) => setTimeout(resolve, 250));  // 静默期已过，补发发生
    assert.equal(notified.length, 1, "静默期过了就该补发");

    send(turnEnd("真结论"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(notified.length >= 1);
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

// 回归：合并窗口配 0 必须真的关掉合并。曾经入口写的是 `|| 30000`，0 被当假值兑回 30 秒，
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

test("补发：正常收齐后补发的通知不带兜底提示", async () => {
  await withHarness(async ({ send, notified }) => {
    send(backgroundTask("upsert", "child-a"));
    send(turnEnd("子伙伴还在跑"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    send(backgroundTask("remove", "child-a"));

    assert.equal(await waitFor(() => notified.length > 0), true, "收齐后应补发");
    const text = `${notified[0].title || ""} ${notified[0].body || ""}`;
    assert.doesNotMatch(text, /等太久了/, "正常收齐的补发不是兜底放行，不该带这句提示");
  });
});

// 兵底路径（2026-10-12 交叉审查提出的真实场景）：后台任务的结束通知永久丢失，
// 任务只在开始时上报过一次。超 TTL 后下一个回合必须能正常提醒，并在正文里说清实情。
test("兜底：结束通知丢失后，下一个回合照常提醒且正文带实情说明", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-ttl-"));
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ mergeWindowMs: 1 }),
    "utf8"
  );
  const { ctx, seen } = makeCtx(dir);
  const tracker = new BackgroundTaskTracker({ ttlMs: 30 });
  toastDependencies.dependencies = { spawnProcess: blockedSpawn, timeoutMs: 200 };
  toastDependencies.backgroundTasks = tracker;
  try {
    await apply(ctx);
    const send = (event) => seen.subscribed.callback(event, SESSION_PATH);
    send(userMessage());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 只上报开始，永远不来 remove
    send(backgroundTask("upsert", "leaky"));
    send(turnEnd("先出一版，任务还在跑"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(seen.notified.length, 0, "还有后台任务时不该弹");

    // 超 TTL 后的下一个回合：兵底释放，应该弹出来
    send(turnEnd("这是后来的消息"));
    assert.equal(await waitFor(() => seen.notified.length > 0), true, "兵底释放后应正常提醒");
    assert.equal(seen.notified.length, 1, "只弹这一条");
    assert.match(String(seen.notified[0].body || ""), /等太久了/, "正文应说明是等太久才放行");
    const text = `${seen.notified[0].title || ""} ${seen.notified[0].body || ""}`;
    assert.doesNotMatch(seen.notified[0].title || "", /这版可能还会变/, "提示只进正文，不进标题");
  } finally {
    toastDependencies.dependencies = undefined;
    toastDependencies.backgroundTasks = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 兵底释放时，当前回合自己就要弹，补发旧回合会变成重复；旧的那条必须被清掉而不是堆着。
test("兜底：释放时不补发旧回合，避免重复弹", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-ttl2-"));
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ mergeWindowMs: 1 }),
    "utf8"
  );
  const { ctx, seen } = makeCtx(dir);
  toastDependencies.dependencies = { spawnProcess: blockedSpawn, timeoutMs: 200 };
  toastDependencies.backgroundTasks = new BackgroundTaskTracker({ ttlMs: 30 });
  try {
    await apply(ctx);
    const send = (event) => seen.subscribed.callback(event, SESSION_PATH);
    send(userMessage());
    await new Promise((resolve) => setTimeout(resolve, 50));

    send(backgroundTask("upsert", "leaky"));
    send(turnEnd("被压住的第一条"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    send(turnEnd("后来的第二条"));
    assert.equal(await waitFor(() => seen.notified.length > 0), true);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(seen.notified.length, 1, "不能既弹当前回合又补发旧回合");
    const text = `${seen.notified[0].title || ""} ${seen.notified[0].body || ""}`;
    assert.match(text, /后来的第二条/);
    assert.doesNotMatch(text, /被压住的第一条/);
  } finally {
    toastDependencies.dependencies = undefined;
    toastDependencies.backgroundTasks = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("模型额度错误会触发异常提醒，并保留停止原因和已收到的内容", async () => {
  await withHarness(async ({ send, notified }) => {
    const errorMessage = '402: {"type":"insufficient_balance_error","message":"当前已达到 Token Plan 用量上限。为避免调用中断，请升级 Token Plan 套餐，或购买积分补充用量并开启积分自动消耗。 (2067)","http_code":"402"}';
    send({ type: "error", message: errorMessage, sessionPath: SESSION_PATH });
    send({
      type: "turn_end",
      agentId: "hanako",
      message: {
        stopReason: "error",
        errorMessage,
        content: [{ type: "text", text: "已经写到一半" }]
      }
    });

    const delivered = await waitFor(() => notified.length > 0, 6000);
    assert.equal(delivered, true, "模型异常中断应该有通知");
    assert.equal(notified.length, 1, "同一次失败只弹一条");
    assert.match(String(notified[0].title || ""), /端到端测试/);
    assert.match(String(notified[0].body || ""), /Token Plan/);
    assert.match(String(notified[0].body || ""), /402\/2067/);
    assert.match(String(notified[0].body || ""), /额度恢复后/);
    assert.match(String(notified[0].body || ""), /已经写到一半/);
  });
});

test("自动重试耗尽时，异常提醒会及时弹出", async () => {
  await withHarness(async ({ send, notified }) => {
    send({
      type: "turn_end",
      agentId: "hanako",
      message: {
        stopReason: "error",
        errorMessage: "429 rate limit",
        content: [{ type: "text", text: "有限内容" }]
      }
    });
    send({ type: "error", message: "429 rate limit", sessionPath: SESSION_PATH });
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, errorMessage: "429 rate limit" });
    send({ type: "auto_retry_end", success: false, attempt: 1, finalError: "429 rate limit" });

    assert.equal(await waitFor(() => notified.length > 0, 1000), true, "重试耗尽后不应再等宽限期");
    assert.equal(notified.length, 1);
    assert.match(String(notified[0].body || ""), /限流/);
    assert.match(String(notified[0].body || ""), /有限内容/);
  });
});

test("断联提醒开关关闭时不弹模型错误通知", async () => {
  await withHarness(async ({ send, notified }) => {
    send({ type: "error", message: "quota exceeded", sessionPath: SESSION_PATH });
    send({ type: "auto_retry_end", success: false, attempt: 1, finalError: "quota exceeded" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(notified.length, 0);
  }, { abnormalEnabled: false });
});