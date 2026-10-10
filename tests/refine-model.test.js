// 提个醒 · 润色模型工厂测试（不触发真实模型调用）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRefineModelConfig } from "../lib/refine-model.js";

test("设置页与通知运行时共用的模型工厂只从宿主模型列表筛选文本模型", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-refine-model-"));
  const requests = [];
  const ctx = {
    bus: {
      async request(verb, payload) {
        requests.push({ verb, payload });
        return { models: [
          { provider: "p1", id: "text-model", name: "Text", input: ["text"] },
          { provider: "p1", id: "image-model", name: "Image", input: ["image"] },
          { provider: "p2", id: "chat-model", name: "Chat", input: ["chat"] }
        ] };
      }
    }
  };

  try {
    const modelConfig = createRefineModelConfig({ ctx, dataDir });
    assert.deepEqual(requests, [], "构造实例不在 apply 阶段调用受保护接口");
    const result = await modelConfig.handleHanaModels();
    assert.deepEqual(result.models, [
      { providerId: "p1", providerName: "p1", models: [{ id: "text-model", name: "Text" }] },
      { providerId: "p2", providerName: "p2", models: [{ id: "chat-model", name: "Chat" }] }
    ]);
    assert.deepEqual(requests, [{ verb: "model:list", payload: {} }]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
