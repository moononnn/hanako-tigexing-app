// 提个醒 · Hana App 宿主模型流回归测试
import { test } from "node:test";
import assert from "node:assert/strict";

import { callHanaConfiguredModel } from "../lib/model-config/core/hana-direct.js";

function ndjson(events) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

test("App 模型测试通过宿主模型流读取指定模型与可见正文", async () => {
  const calls = [];
  const ctx = {
    models: {
      async stream(payload) {
        calls.push(payload);
        return {
          ok: true,
          text: async () => ndjson([
            { type: "reasoning-delta", delta: "内部思考" },
            { type: "text-delta", delta: "通了" },
            { type: "done", assistant: { content: [{ type: "text", text: "通了" }] }, stopReason: "stop", usage: { totalTokens: 12 } },
          ]),
        };
      },
    },
  };
  const result = await callHanaConfiguredModel(
    ctx,
    { providerId: "openai-codex", modelId: "gpt-6-luna" },
    [{ role: "system", content: "只检查连通" }, { role: "user", content: "回复两个字：通了" }],
    { maxTokens: 500, temperature: 0.2, reasoningLevel: "off", timeoutMs: 5000 },
  );
  assert.equal(calls[0].provider, "openai-codex");
  assert.equal(calls[0].model, "gpt-6-luna");
  assert.equal(calls[0].systemPrompt, "只检查连通");
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "回复两个字：通了" }]);
  assert.equal(calls[0].maxTokens, 500);
  assert.equal(Object.hasOwn(calls[0], "reasoningEffort"), false, "默认 off 不传给不支持该档位的模型");
  assert.equal(result.text, "通了");
  assert.equal(result.reasoning_content, "内部思考");
  assert.equal(result.finish_reason, "stop");
  assert.deepEqual(result.usage, { totalTokens: 12 });
});

test("MiniMax 连通测试保留选定模型与有界预算，不塞默认思考参数", async () => {
  let request;
  const ctx = {
    models: {
      async stream(payload) {
        request = payload;
        return { ok: true, text: async () => ndjson([{ type: "text-delta", delta: "通了" }]) };
      },
    },
  };
  await callHanaConfiguredModel(ctx, { providerId: "minimax", modelId: "MiniMax-M3.1-Flash-Preview" }, [], {
    maxTokens: 500,
    reasoningLevel: "off",
    timeoutMs: 5000,
  });
  assert.equal(request.provider, "minimax");
  assert.equal(request.model, "MiniMax-M3.1-Flash-Preview");
  assert.equal(request.maxTokens, 500);
  assert.equal(Object.hasOwn(request, "reasoningEffort"), false, "默认 off 不传给宿主模型接口");
});

test("明确指定非默认思考档时才发送 reasoningEffort", async () => {
  let request;
  const ctx = {
    models: {
      async stream(payload) {
        request = payload;
        return { ok: true, text: async () => ndjson([{ type: "text-delta", delta: "通了" }]) };
      },
    },
  };
  await callHanaConfiguredModel(ctx, { providerId: "openai-codex", modelId: "gpt-6-luna" }, [], {
    maxTokens: 500,
    reasoningLevel: "low",
    timeoutMs: 5000,
  });
  assert.equal(request.reasoningEffort, "low");
});

test("App 宿主模型流的 error 事件保留宿主错误码", async () => {
  const ctx = {
    models: {
      async stream() {
        return {
          ok: true,
          text: async () => ndjson([{ type: "error", code: "APP_MODEL_PROVIDER_ERROR", message: "模型服务暂时失败" }]),
        };
      },
    },
  };
  await assert.rejects(
    callHanaConfiguredModel(ctx, { providerId: "openai-codex", modelId: "gpt-6-luna" }, [], { timeoutMs: 5000 }),
    (error) => error.code === "APP_MODEL_PROVIDER_ERROR" && error.message === "模型服务暂时失败",
  );
});

test("宿主未提供模型流时明确失败，不回退到直接读盘", async () => {
  await assert.rejects(
    callHanaConfiguredModel({}, { providerId: "openai-codex", modelId: "gpt-6-luna" }, []),
    /Hana 宿主模型通道不可用/,
  );
});
