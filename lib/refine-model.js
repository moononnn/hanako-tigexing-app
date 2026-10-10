// 提个醒 · 文案润色模型配置
// 设置页与通知运行时共用同一份模型配置，避免开关亮着、运行链路却没接上。
import fs from "node:fs";
import path from "node:path";
import { ModelConfig } from "./model-config/index.js";

export function createRefineModelConfig({ ctx, dataDir } = {}) {
  if (!ctx || !dataDir) throw new Error("创建润色模型需要 App context 和 dataDir");

  const refineCfgFile = path.join(dataDir, "refine-model.json");
  const store = {
    getConfig() {
      try {
        return fs.existsSync(refineCfgFile) ? JSON.parse(fs.readFileSync(refineCfgFile, "utf-8")) : {};
      } catch {
        return {};
      }
    },
    saveConfig(mutator) {
      const config = store.getConfig();
      mutator(config);
      try { fs.writeFileSync(refineCfgFile, JSON.stringify(config, null, 2)); } catch { /* 配置保存失败不阻断通知 */ }
    }
  };

  const modelConfig = new ModelConfig({ ctx, store });
  modelConfig.setHanaModelsProvider(async () => {
    const result = await ctx.bus.request("model:list", {});
    const models = Array.isArray(result?.models) ? result.models : [];
    const providers = new Map();
    for (const model of models) {
      const providerId = String(model?.provider || "").trim();
      const modelId = String(model?.id || "").trim();
      if (!providerId || !modelId) continue;
      const input = Array.isArray(model.input) ? model.input : [];
      if (!input.includes("text") && !input.includes("chat")) continue;
      if (!providers.has(providerId)) providers.set(providerId, []);
      providers.get(providerId).push({ id: modelId, name: model.name || modelId });
    }
    return Array.from(providers, ([providerId, providerModels]) => ({
      providerId,
      providerName: providerId,
      models: providerModels
    }));
  });
  return modelConfig;
}
