// 提个醒 · 闲聊提醒的实机回归
//
// 锁的是 2026-10-30 实机真机验证抓到的两个问题：
//
// 1. 同一条回复里伙伴连发好几个气泡（实机间隔 3~7 秒），
//    提个醒要么把一条拆成好几条弹窗，要么把后来的气泡当成新一轮。
//    这里保证：一轮只出一条，后来的气泡不重发、也不被并进下一轮。
//
// 2. 写代码时踩了个 `const agentName = agentName(...)` 的自引用坑，
//    异常在异步链上被吞掉，现象只是「没弹窗」——查起来毫无线索。
//    这里保证：闲聊这条链上任何异常都会落到日志里。
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

const STUDIO = "studio-1";

function casualEntry(actor, text, overrides = {}) {
  return {
    type: "casual_entry",
    studioId: STUDIO,
    agentId: "hanako",
    entry: {
      id: overrides.id || `entry-${text}`,
      sourceEntryId: overrides.id || `entry-${text}`,
      actor,
      occurredAt: overrides.occurredAt || new Date().toISOString(),
      item: { kind: "text", text },
      ...overrides,
    },
  };
}

function casualUnread(overrides = {}) {
  return {
    type: "casual_unread",
    studioId: STUDIO,
    agentId: "hanako",
    unread: overrides.unread ?? 1,
    preview: {
      text: overrides.text ?? "语音转写的一句",
      occurredAt: overrides.occurredAt ?? new Date().toISOString(),
      previewKind: "text",
    },
    ...overrides,
  };
}

async function withHarness(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-casual-"));
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ casualTrigger: "always" }),
    "utf8"
  );
  const seen = { subscribed: null, notified: [] };
  const ctx = {
    dataDir: dir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bus: {
      subscribe(callback) {
        seen.subscribed = { callback };
        return () => {};
      },
      async request(verb) {
        if (verb === "agent:list") return { agents: [{ id: "hanako", name: "小花" }] };
        return {};
      },
    },
    notifications: {
      async show(input) {
        seen.notified.push(input);
        return { shown: true };
      },
    },
    resources: { list: async () => [], stat: async () => ({ exists: false }) },
    models: { list: async () => ({ models: [] }) },
  };
  toastDependencies.dependencies = { spawnProcess: blockedSpawn, timeoutMs: 200 };
  // 结算窗口压短：真实值是 12 秒，测试等不起，也不用等。
  // 但它必须大于测试里相邻气泡的间隔，否则那几个气泡本来就该算几轮。
  toastDependencies.casualSettleMs = 300;
  try {
    await apply(ctx);
    const send = (event) => seen.subscribed.callback(event, null);
    await fn({ send, notified: seen.notified });
  } finally {
    toastDependencies.dependencies = undefined;
    toastDependencies.casualSettleMs = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等到条件成立。
 *
 * 不写死等待时长：全量跑时机器忙，固定时长会不够，
 * 表现为「明明弹了却断言说没弹」——那是测试自己的抖动，不是产品的。
 */
async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(20);
  }
  return predicate();
}

test("一轮里伙伴连发多个气泡：只提醒一次，内容合并成一条", async () => {
  await withHarness(async ({ send, notified }) => {
    send(casualEntry("user", "在吗"));
    await wait(30);
    // 实机观察到同一条回复里相邻气泡间隔 3~7 秒。
    // 间隔必须小于同轮窗口，否则这几个气泡本来就该算几轮。
    send(casualEntry("agent", "第一条", { id: "a1" }));
    await wait(60);
    send(casualEntry("agent", "第二条", { id: "a2" }));
    await wait(60);
    send(casualEntry("agent", "第三条", { id: "a3" }));
    // 等这条提醒真的送到（不写死时长：机器忙时会不够）
    const arrived = await waitFor(() => notified.some((n) => String(n.title || "").includes("闲聊")));
    await wait(200);

    const casualToasts = notified.filter((n) => String(n.title || "").includes("闲聊"));
    assert.equal(arrived, true, "提醒应该送到");
    assert.equal(casualToasts.length, 1, "一轮只该弹一条，不能把一条回复拆成三条");
    const body = String(casualToasts[0].body || "");
    assert.match(body, /第一条/, "内容要在，别把气泡丢了");
    assert.match(body, /第三条/, "同一轮的气泡要合在一起");
    assert.match(casualToasts[0].title || "", /闲聊/, "标题要带闲聊记号");
  });
});

test("新一轮的回复不会被上一轮的待发内容吞掉", async () => {
  await withHarness(async ({ send, notified }) => {
    send(casualEntry("user", "在吗"));
    await wait(30);
    send(casualEntry("agent", "第一轮", { id: "b1" }));
    // 上一轮还没发出去，新一轮就来了
    send(casualEntry("user", "换话题"));
    await wait(30);
    send(casualEntry("agent", "第二轮", { id: "b2" }));
    const arrived = await waitFor(() => notified.filter((n) => String(n.title || "").includes("闲聊")).length >= 2);
    await wait(200);

    const casualToasts = notified.filter((n) => String(n.title || "").includes("闲聊"));
    assert.equal(arrived, true, "两轮都该送到");
    assert.equal(casualToasts.length, 2, "两轮就该两条，两轮的内容都不能丢");
    const bodies = casualToasts.map((n) => String(n.body || ""));
    assert.match(bodies[0], /第一轮/);
    assert.match(bodies[1], /第二轮/);
  });
});

test("闲聊这条链上出错要落日志，不能悄悄没弹窗", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-casual-err-"));
  fs.mkdirSync(path.join(dir, "tigexing-app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tigexing-app", "preferences.json"),
    JSON.stringify({ casualTrigger: "always" }),
    "utf8"
  );
  const errors = [];
  const seen = { subscribed: null, notified: [] };
  const ctx = {
    dataDir: dir,
    logger: { debug() {}, info() {}, warn() {}, error(msg, meta) { errors.push({ msg, meta }); } },
    bus: {
      subscribe(callback) {
        seen.subscribed = { callback };
        return () => {};
      },
      async request(verb) {
        if (verb === "agent:list") return { agents: [{ id: "hanako", name: "小花" }] };
        return {};
      },
    },
    notifications: {
      async show(input) {
        seen.notified.push(input);
        throw new Error("故意失败");
      },
    },
    resources: { list: async () => [], stat: async () => ({ exists: false }) },
    models: { list: async () => ({ models: [] }) },
  };
  // 两条腿都失败：PowerShell 腿报明确错误，备用腿也抛。
  // 这时 notify() 返回 failed —— 现象上就是「没弹窗」，
  // 必须在日志和 logger 里留下痕迹，不能一声不响。
  toastDependencies.dependencies = {
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.unref = () => {};
      queueMicrotask(() => {
        child.stderr.write("DisabledForApplication");
        child.emit("close", 1);
      });
      return child;
    },
    timeoutMs: 100,
  };
  toastDependencies.casualSettleMs = 50;
  try {
    await apply(ctx);
    seen.subscribed.callback(casualEntry("agent", "来一句", { id: "e1" }), null);
    const logged = await waitFor(() => errors.length > 0);
    assert.equal(seen.notified.length > 0, true, "备用通道该被试过");
    assert.equal(logged, true, "通知发失败要报错，不能一声不响");
    assert.match(
      errors.map((e) => e.msg).join(" | "),
      /未送达/,
      "要有一条明确说「没送达」的日志"
    );
  } finally {
    toastDependencies.dependencies = undefined;
    toastDependencies.casualSettleMs = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 语音回话的兜底（2026-10-30 实机抓到的缺口） ──
//
// 实机：伙伴用语音回话时，宿主只发 casual_unread，不发 casual_entry；
// 文字回复两个都发。提个醒只接 casual_entry，于是语音的发言完全收不到。
// 这里锁住：语音也能提醒、且不会和文字重复弹。

test("语音回话只走 casual_unread：也要提醒，别把这条漏掉", async () => {
  await withHarness(async ({ send, notified }) => {
    send(casualEntry("user", "在吗"));
    await wait(30);
    // 伙伴用语音回：宿主只发 casual_unread
    send(casualUnread({ unread: 1, text: "语音转写的回话" }));
    const arrived = await waitFor(() => notified.some((n) => String(n.title || "").includes("闲聊")));
    await wait(200);

    const casualToasts = notified.filter((n) => String(n.title || "").includes("闲聊"));
    assert.equal(arrived, true, "语音的发言也得提醒");
    assert.equal(casualToasts.length, 1, "只该弹一条");
    assert.match(String(casualToasts[0].body || ""), /语音转写的回话/, "内容要在");
  });
});

test("文字回话（casual_entry + casual_unread 都有）不能弹两条", async () => {
  await withHarness(async ({ send, notified }) => {
    send(casualEntry("user", "在吗"));
    await wait(30);
    // 文字回话：宿主先发 casual_entry，紧接着发 casual_unread
    const at = new Date().toISOString();
    send(casualEntry("agent", "文字回话", { id: "t1", occurredAt: at }));
    await wait(20);
    send(casualUnread({ unread: 1, text: "文字回话", occurredAt: at }));
    const arrived = await waitFor(() => notified.some((n) => String(n.title || "").includes("闲聊")));
    await wait(200);

    const casualToasts = notified.filter((n) => String(n.title || "").includes("闲聊"));
    assert.equal(arrived, true, "应该弹");
    assert.equal(casualToasts.length, 1, "同一条话只能弹一遍，entry 和 unread 不能各弹一次");
  });
});

test("她自己说的话不能被当成伙伴的发言弹出来", async () => {
  await withHarness(async ({ send, notified }) => {
    // 实机（2026-10-30）：App 刚重载时面板里有未读，她自己发一句话
    // 也会带着 casual_unread——那会儿要是照着未读数认，就会把她的话弹出去。
    const at = new Date().toISOString();
    send(casualEntry("user", "这是我自己的话", { occurredAt: at }));
    await wait(20);
    send(casualUnread({ unread: 3, text: "这是我自己的话", occurredAt: at }));
    await wait(600);

    const casualToasts = notified.filter((n) => String(n.title || "").includes("闲聊"));
    assert.equal(casualToasts.length, 0, "她自己的话不该被当成伙伴的发言弹出来");
  });
});

test("预览不比她最后一次说话更新：就不该当成伙伴的发言弹出来", async () => {
  await withHarness(async ({ send, notified }) => {
    // 实机（2026-10-30）：App 刚重载时面板里有未读，她自己发一句话
    // 也会带着一条 casual_unread——那会儿要是照着未读数认，就会把她的话弹出去。
    // 宿主里这条未读预览就是她刚发的那条，时刻同源同值，所以这里用同一个时刻。
    const at = new Date().toISOString();
    send(casualEntry("user", "这是我自己的话", { occurredAt: at }));
    await wait(20);
    send(casualUnread({ unread: 3, text: "这是我自己的话", occurredAt: at }));
    await wait(600);

    const casualToasts = notified.filter((n) => String(n.title || "").includes("闲聊"));
    assert.equal(casualToasts.length, 0, "她自己的话不该被当成伙伴的发言弹出来");
  });
});

test("预览比她最后一次说话更新：那是伙伴新说的，该弹", async () => {
  await withHarness(async ({ send, notified }) => {
    const at = new Date().toISOString();
    send(casualEntry("user", "在吗", { occurredAt: at }));
    await wait(20);
    // 伙伴随后说了话，预览时刻比她那次更新
    send(casualUnread({ unread: 1, text: "在呢", occurredAt: new Date(Date.now() + 50).toISOString() }));
    const arrived = await waitFor(() => notified.some((n) => String(n.title || "").includes("闲聊")));
    const casualToasts = notified.filter((n) => String(n.title || "").includes("闲聊"));
    assert.equal(arrived, true, "伙伴新说的话该弹");
    assert.equal(casualToasts.length, 1, "只该弹一条");
    assert.match(String(casualToasts[0].body || ""), /在呢/, "内容要在");
  });
});
