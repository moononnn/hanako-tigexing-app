// 提个醒 · 助手头像 ResourceIO 路径测试
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAgentAvatar } from "../lib/agent-avatar.js";

function makeResources(items) {
  const calls = [];
  return {
    calls,
    async list(resource) {
      calls.push({ method: "list", resource });
      return { items };
    }
  };
}

test("用 ResourceIO 列出头像，再返回给 Toast 子进程读取的路径", async () => {
  const resources = makeResources([
    { name: "agent.png", isDirectory: false },
    { name: "notes.txt", isDirectory: false },
    { name: "old.jpg", isDirectory: false }
  ]);
  const result = await resolveAgentAvatar("C:\\agents", "hanako", { resources });

  assert.equal(result, path.join("C:\\agents", "hanako", "avatars", "agent.png"));
  assert.deepEqual(resources.calls, [{
    method: "list",
    resource: { kind: "local-file", path: path.join("C:\\agents", "hanako", "avatars") }
  }]);
});

test("头像格式优先级为 png > jpg > jpeg > webp", async () => {
  const resources = makeResources([
    { name: "a.webp", isDirectory: false },
    { name: "b.jpg", isDirectory: false },
    { name: "c.png", isDirectory: false }
  ]);
  assert.ok((await resolveAgentAvatar("C:\\agents", "hanako", { resources })).endsWith("c.png"));
});

test("没有头像、资源接口或有效伙伴 id 时返回 null", async () => {
  const emptyResources = makeResources([]);
  assert.equal(await resolveAgentAvatar("C:\\agents", "nobody", { resources: emptyResources }), null);
  assert.equal(await resolveAgentAvatar("C:\\agents", "hanako", {}), null);
  assert.equal(await resolveAgentAvatar("C:\\agents", "..\\outside", { resources: emptyResources }), null);
  assert.equal(await resolveAgentAvatar(null, "x", { resources: emptyResources }), null);
  assert.equal(await resolveAgentAvatar("C:\\agents", null, { resources: emptyResources }), null);
  assert.equal(emptyResources.calls.length, 1);
});

test("ResourceIO 授权失败向调用方抛出，便于记录并回退", async () => {
  const resources = {
    async list() { throw Object.assign(new Error("permission denied"), { code: "APP_CAPABILITY_DENIED" }); }
  };
  await assert.rejects(resolveAgentAvatar("C:\\agents", "hanako", { resources }), /permission denied/);
});
