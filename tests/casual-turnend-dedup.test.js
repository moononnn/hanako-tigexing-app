// 提个醒 · 闲聊双弹回归
//
// 2026-10-31 实机（20:47）：同一条闲聊消息弹了两条通知 ——
//   一条〔闲聊〕走闲聊风格（姐妹），一条普通款走聊天风格（豆狸粒狸）。
// 原因：宿主会给闲聊会话发带正文的 turn_end，而 handleTurnEnd 从没拦过它
// （原先以为宿主会跳过闲聊的完成通知）。于是 casual_entry 一条、
// turn_end 一条，两条链路各发一次。
//
// 这组测试守两件事：
//   1. 认得出来是闲聊会话（chat_say 工具）时，turn_end 让路，只留〔闲聊〕那条；
//   2. 普通会话的 turn_end 照常提醒，别因为这道闸把正常提醒吞了。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { apply, toastDependencies } from "../index.js";

const SESSION_PATH = path.join(
  "C:", "Users", "tester", ".hanako", "agents", "hanako", "sessions",
  "2026-10-31T12-35-53-920Z_01a191f5-97c0-7bfd-a5a5-7f8231921afe.jsonl"
);

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

function casualEntry(text) {
  return {
    type: "casual_entry",
    studioId: "studio-1",
    agentId: "hanako",
    entry: {
      id: `entry-${text}`,
      sourceEntryId: `entry-${text}`,
      actor: "agent",
      occurredAt: new Date().toISOString(),
      item: { kind: "text", text },
    },
  };
}

const turnEnd = (text) => ({
  type: "turn_end",
  agentId: "hanako",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  },
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(20);
  }
  return predicate();
}

async function withHarness(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-casual-turnend-"));
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
  toastDependencies.casualSettleMs = 300;
  try {
    await apply(ctx);
    const send = (event, sessionPath = SESSION_PATH) => seen.subscribed.callback(event, sessionPath);
    await fn({ send, notified: seen.notified });
  } finally {
    toastDependencies.dependencies = undefined;
    toastDependencies.casualSettleMs = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("闲聊会话的 turn_end 不再补一条普通提醒：只留〔闲聊〕那条", async () => {
  await withHarness(async ({ send, notified }) => {
    // 她说了话 → 伙伴用 chat_say 在闲聊里回 → 这一轮收尾
    send({ type: "session_user_message", message: { role: "user", content: [{ type: "text", text: "健身环回来啦" }] } });
    await wait(30);
    send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "chat_say", args: {} });
    await wait(30);
    send(turnEnd("没催她休息，只接了健身环这茬。"));
    send(casualEntry("哦豁 健身环 那不得出一身汗"));

    const arrived = await waitFor(() => notified.some((n) => String(n.title || "").includes("闲聊")));
    // 普通提醒比闲聊提醒慢（要先查分区、标题再发），留够它出现的时间再断言。
    // 留短了会“空过”：它只是还没到，不是没弹。
    await wait(4000);

    assert.equal(arrived, true, "闲聊提醒应该送到");
    const plain = notified.filter((n) => !String(n.title || "").includes("闲聊"));
    assert.equal(plain.length, 0, `闲聊会话不该再发普通提醒，实际发了：${plain.map((n) => n.title).join(" / ")}`);
    assert.equal(notified.length, 1, "同一条消息只该有一条提醒");
  });
});

test("普通会话的 turn_end 照常提醒，别被这道闸吞掉", async () => {
  await withHarness(async ({ send, notified }) => {
    send({ type: "session_user_message", message: { role: "user", content: [{ type: "text", text: "看看这个" }] } });
    await wait(30);
    // 没有 chat_say：这是普通聊天会话
    send(turnEnd("这个我看过了，问题在缓存。"));
    send(casualEntry("闲聊这边也有一句"));

    const arrived = await waitFor(() => notified.some((n) => !String(n.title || "").includes("闲聊")));
    await wait(600);

    assert.equal(arrived, true, "普通会话的完成提醒不能丢");
    const plain = notified.filter((n) => !String(n.title || "").includes("闲聊"));
    assert.equal(plain.length, 1, "普通提醒只该有一条");
  });
});
