// 提个醒 · 会话标题读取测试：按订阅事件路径从授权会话列表取展示标题。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionPath, parseSessionIdentity, resolveSessionTitle, resolveSessionTitleWithRetry } from "../lib/session-title.js";

const currentPath = "D:\\HanaHome\\.hanako\\agents\\hanako\\sessions\\s.jsonl";

test("会话生命周期事件可提取稳定 sessionId 和路径（含旧式嵌套投影）", () => {
  assert.deepEqual(parseSessionIdentity({ type: "session_created", sessionId: "sess-real", sessionPath: currentPath }), {
    sessionPath: currentPath,
    sessionId: "sess-real"
  });
  assert.deepEqual(parseSessionIdentity({ type: "session_created", session: { sessionId: "sess-old", sessionPath: currentPath } }), {
    sessionPath: currentPath,
    sessionId: "sess-old"
  });
  assert.equal(normalizeSessionPath("D:/HanaHome/.hanako/agents/hanako/sessions/s.jsonl"), normalizeSessionPath(currentPath));
});

test("已知稳定 sessionId 时优先 session:get，不查全量会话列表", async () => {
  const calls = [];
  const bus = {
    async request(verb, payload, options) {
      calls.push({ verb, payload, options });
      return { session: { sessionId: "sess-real", path: currentPath, title: "另一个对话窗" } };
    }
  };
  let resolved;
  const title = await resolveSessionTitle({
    bus,
    sessionPath: currentPath,
    sessionId: "sess-real",
    onResolved: (session) => { resolved = session; }
  });
  assert.equal(title, "另一个对话窗");
  assert.deepEqual(calls, [{ verb: "session:get", payload: { sessionId: "sess-real", scope: "all" }, options: { timeout: 5000 } }]);
  assert.deepEqual(resolved, { sessionPath: currentPath, sessionId: "sess-real", title: "另一个对话窗" });
});

test("通过 session:list 按当前路径取标题，并显式请求 all scope", async () => {
  let request;
  const bus = {
    async request(verb, payload, options) {
      request = { verb, payload, options };
      return {
        sessions: [
          { path: "D:/other/s.jsonl", title: "别的窗口" },
          { path: currentPath, sessionId: "stable-session-id", title: "设置面板风格优化建议" }
        ]
      };
    }
  };

  assert.equal(await resolveSessionTitle({ bus, sessionPath: currentPath.toLowerCase(), agentId: "hanako" }), "设置面板风格优化建议");
  assert.deepEqual(request, {
    verb: "session:list",
    payload: { scope: "all", lifecycle: "active", agentId: "hanako" },
    options: { timeout: 5000 }
  });
});

test("session:get 没有标题时回退到 session:list 并按路径匹配", async () => {
  const calls = [];
  const bus = {
    async request(verb, payload, options) {
      calls.push({ verb, payload, options });
      if (verb === "session:get") return { session: null };
      return { sessions: [{ path: currentPath, sessionId: "sess-real", title: "列表里的窗口名" }] };
    }
  };
  const title = await resolveSessionTitle({ bus, sessionPath: currentPath, sessionId: "sess-real" });
  assert.equal(title, "列表里的窗口名");
  assert.deepEqual(calls.map((call) => call.verb), ["session:get", "session:list"]);
});

test("缺少路径或宿主查询失败时返回 null，不直读宿主文件", async () => {
  let calls = 0;
  const bus = { async request() { calls += 1; throw new Error("permission denied"); } };
  let reported = "";
  assert.equal(await resolveSessionTitle({ bus, sessionPath: "", onError: (error) => { reported = error.message; } }), null);
  assert.equal(calls, 0);
  assert.equal(await resolveSessionTitle({ bus, sessionPath: currentPath, onError: (error) => { reported = error.message; } }), null);
  assert.equal(calls, 1);
  assert.equal(reported, "permission denied");
});

test("session:list 暂时没有标题时短等一次并重查", async () => {
  let calls = 0;
  const bus = {
    async request() {
      calls += 1;
      return { sessions: [{ path: currentPath, title: calls === 1 ? "" : "新会话标题" }] };
    }
  };
  const title = await resolveSessionTitleWithRetry({ bus, sessionPath: currentPath, retryDelayMs: 5 });
  assert.equal(title, "新会话标题");
  assert.equal(calls, 2);
});

test("跨归属标题读取显式scope all，不再按App自有会话拒绝", async () => {
  const bus = { async request(verb, payload) {
    if (verb === 'session:get') {
      if (payload.scope !== 'all') throw new Error('does not belong to app');
      return { session: { sessionId: 'sess-real', path: currentPath, title: '普通聊天的真实标题' } };
    }
    throw new Error('不应查全量列表');
  } };
  assert.equal(await resolveSessionTitle({ bus, sessionPath: currentPath, sessionId: 'sess-real' }), '普通聊天的真实标题');
});

test("列表回退通过稳定id匹配，盘符定位器变化不串到同名文件", async () => {
  const bus = { async request(verb) {
    if (verb === 'session:get') return { session: null };
    return { sessions: [
      { sessionId: 'other-session', path: 'E:/other/s.jsonl', title: '不能拿这个' },
      { sessionId: 'sess-real', path: 'C:/linked/agents/hanako/sessions/s.jsonl', title: '正确窗口' }
    ] };
  } };
  assert.equal(await resolveSessionTitle({ bus, sessionPath: currentPath, sessionId: 'sess-real' }), '正确窗口');
});

test("两次列表都没有当前会话标题时返回 null", async () => {
  let calls = 0;
  const bus = { async request() { calls += 1; return { sessions: [{ path: currentPath, title: "" }] }; } };
  const title = await resolveSessionTitleWithRetry({ bus, sessionPath: currentPath, retryDelayMs: 5 });
  assert.equal(title, null);
  assert.equal(calls, 2);
});
