// 提个醒 · 闲聊窗口那一栏的接口契约。
//
// 守三件事：
//   1. /api/sounds 把主助手 id 发给设置页，页面才知道闲聊屏该渲染哪一行；
//   2. mode=casual 写的是 agentCasualStyles / agentCasualSounds，不串到聊天或 Code 那两栏；
//   3. 闲聊只有主助手能调，别的伙伴直接 403（判不出主助手时不拦，宁可少拦也不能整块废掉）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HANA_HOME 必须在 import 之前定好：routes/api.js 在模块顶层就把它算成常量。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-home-"));
fs.mkdirSync(path.join(HOME, "user"), { recursive: true });
fs.mkdirSync(path.join(HOME, "agents", "hanako"), { recursive: true });
fs.writeFileSync(path.join(HOME, "agents", "hanako", "config.yaml"), "agent:\n  name: 小花\n");
fs.writeFileSync(path.join(HOME, "user", "preferences.json"), JSON.stringify({ primaryAgent: "hanako" }));
process.env.HANA_HOME = HOME;

const { default: registerRoutes } = await import("../routes/api.js");

function makeHarness(dataDir, resourcesOverride) {
  const routes = new Map();
  const app = {
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); }
  };
  const ctx = {
    dataDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bus: {
      async request() {
        return {
          agents: [
            { id: "hanako", name: "小花" },
            { id: "agent_b", name: "助手乙" }
          ]
        };
      }
    },
    resources: resourcesOverride || {
      async read({ path: target }) {
        return { content: fs.readFileSync(target) };
      },
      async stat({ path: target }) {
        try {
          const st = fs.statSync(target);
          return { exists: true, isDirectory: st.isDirectory() };
        } catch {
          return { exists: false, isDirectory: false };
        }
      },
      async list({ path: target }) {
        try {
          return fs.readdirSync(target, { withFileTypes: true })
            .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
        } catch {
          return [];
        }
      }
    },
    notifications: { async show() { return { shown: true }; } }
  };
  registerRoutes(app, ctx);
  const call = async (key, body) => {
    const handler = routes.get(key);
    assert.ok(handler, `路由没注册：${key}`);
    const c = {
      req: {
        async json() { return body || {}; },
        query() { return {}; }
      },
      json(payload, status) {
        return { ...payload, __status: status };
      }
    };
    return handler(c);
  };
  return { call, routes };
}

// 配置的保存是串行写队列（lib/config.js 的 writeChain），路由 return 时文件可能还没落盘。
// CI 上偶发 ENOENT（本地快一点看不出来）：这里等到文件真的出现再读，最多等 1 秒。
async function readPrefs(dataDir) {
  const file = path.join(dataDir, "tigexing-app", "preferences.json");
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 10));
    }
  }
}

test("设置页能拿到主助手 id，闲聊屏才知道渲染哪一行", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-"));
  try {
    const { call } = makeHarness(dir);
    const body = await call("GET /api/sounds");
    assert.equal(body.primaryAgent, "hanako");
    assert.deepEqual(body.casualStyleAssignments, {});
    assert.deepEqual(body.casualAssignments, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mode=casual 写进闲聊那两栏，不串到聊天和 Code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-"));
  try {
    const { call } = makeHarness(dir);
    const style = await call("POST /api/agents/style", { agentId: "hanako", value: "cheerful", mode: "casual" });
    assert.equal(style.ok, true);
    const sound = await call("POST /api/sounds/assign", { agentId: "hanako", value: "default", mode: "casual" });
    assert.equal(sound.ok, true);

    const prefs = await readPrefs(dir);
    assert.deepEqual(prefs.agentCasualStyles, { hanako: "cheerful" });
    assert.deepEqual(prefs.agentCasualSounds, { hanako: "default" });
    assert.deepEqual(prefs.agentStyles, {});
    assert.deepEqual(prefs.agentCodeStyles, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("非主助手写闲聊那栏会被拦，写别的那两栏照旧", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-"));
  try {
    const { call } = makeHarness(dir);
    const blockedStyle = await call("POST /api/agents/style", { agentId: "agent_b", value: "cheerful", mode: "casual" });
    assert.equal(blockedStyle.ok, false);
    assert.equal(blockedStyle.__status, 403);
    const blockedSound = await call("POST /api/sounds/assign", { agentId: "agent_b", value: "default", mode: "casual" });
    assert.equal(blockedSound.ok, false);
    assert.equal(blockedSound.__status, 403);

    const chat = await call("POST /api/agents/style", { agentId: "agent_b", value: "cheerful", mode: "normal" });
    assert.equal(chat.ok, true);
    const code = await call("POST /api/sounds/assign", { agentId: "agent_b", value: "default", mode: "code" });
    assert.equal(code.ok, true);

    const prefs = await readPrefs(dir);
    assert.deepEqual(prefs.agentCasualStyles, {});
    assert.deepEqual(prefs.agentCasualSounds, {});
    assert.equal(prefs.agentStyles.agent_b, "cheerful");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("闲聊那栏选「跟随聊天窗口」（空串）就把该助手自己的设置删掉", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-"));
  try {
    const { call } = makeHarness(dir);
    await call("POST /api/agents/style", { agentId: "hanako", value: "cheerful", mode: "casual" });
    await call("POST /api/sounds/assign", { agentId: "hanako", value: "default", mode: "casual" });
    const back = await call("POST /api/agents/style", { agentId: "hanako", value: "", mode: "casual" });
    assert.equal(back.ok, true);
    assert.deepEqual(back.assignments, {});
    const latest = await call("GET /api/sounds");
    assert.deepEqual(latest.casualStyleAssignments, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("设置页能读到刚存下的闲聊设置", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-"));
  try {
    const { call } = makeHarness(dir);
    await call("POST /api/agents/style", { agentId: "hanako", value: "gentle", mode: "casual" });
    await call("POST /api/sounds/assign", { agentId: "hanako", value: "silent", mode: "casual" });
    const body = await call("GET /api/sounds");
    assert.deepEqual(body.casualStyleAssignments, { hanako: "gentle" });
    assert.deepEqual(body.casualAssignments, { hanako: "silent" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("测试通知走 mode=casual 时不报错（样式和音效取闲聊那栏）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-"));
  try {
    const { call } = makeHarness(dir);
    await call("POST /api/agents/style", { agentId: "hanako", value: "cheerful", mode: "casual" });
    const r = await call("POST /api/test-notify", { mode: "casual" });
    // 弹没弹得出去取决于宿主的通知接口，这里只守「路由能跑通、参数认得出闲聊」
    assert.equal(r.agentId, "hanako");
    assert.equal(typeof r.ok, "boolean");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("资源读不到时（App 的 fs 被限）不炸，主助手判不出来就不拦写入", async () => {
  // 实机就是这种情形：App 进程里裸 readFileSync 抛 ERR_ACCESS_DENIED，
  // 所以主助手必须走 ResourceIO；ResourceIO 也不可用时只退化成「不拦」，不能把页面搞白。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-api-"));
  try {
    const denied = Object.assign(new Error("Access to this API has been restricted."), { code: "ERR_ACCESS_DENIED" });
    const { call } = makeHarness(dir, {
      async read() { throw denied; },
      async stat() { return { exists: false, isDirectory: false }; },
      async list() { return []; }
    });
    const body = await call("GET /api/sounds");
    assert.equal(body.primaryAgent, "");
    const write = await call("POST /api/agents/style", { agentId: "agent_b", value: "cheerful", mode: "casual" });
    assert.equal(write.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
