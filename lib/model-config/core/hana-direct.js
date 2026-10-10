// model-config · Hana App 指定模型调用
// 模型目录、凭据和供应商协议都由 Hana 宿主管理；App 只提交已选择的 provider/model 与消息，
// 通过 models.stream 接收独立的正文、思考和错误事件，不直接读宿主文件或自行发 HTTP 请求。

function hostMessageText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : (part?.type === "text" ? part.text || "" : "")).join("");
}

function normalizeHostMessages(messages) {
  const system = [];
  const output = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = hostMessageText(message?.content);
    if (message?.role === "system") {
      if (content) system.push(content);
      continue;
    }
    output.push({ role: message?.role === "assistant" ? "assistant" : "user", content });
  }
  return { messages: output, systemPrompt: system.join("\n\n") };
}

function parseHostModelStream(raw) {
  let text = "";
  let reasoning = "";
  let finishReason = "";
  let usage = null;
  let error = null;
  let events = 0;

  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    events += 1;

    if (event?.type === "text-delta" && typeof event.delta === "string") {
      text += event.delta;
    } else if (event?.type === "reasoning-delta" && typeof event.delta === "string") {
      reasoning += event.delta;
    } else if (event?.type === "done") {
      const completed = event.assistant || {};
      finishReason = event.stopReason || event.finishReason || completed.stopReason
        || completed.finish_reason || completed.stop_reason || finishReason;
      usage = event.usage || completed.usage || usage;
      if (!text && Array.isArray(completed.content)) {
        text = completed.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
      } else if (!text && typeof completed.content === "string") {
        text = completed.content;
      }
    } else if (event?.type === "error") {
      error = {
        message: event.message || event.code || "模型调用失败",
        code: event.code || "APP_MODEL_PROVIDER_ERROR",
      };
    }
  }

  return { text, reasoning, finishReason, usage, error, events };
}

export async function callHanaConfiguredModel(ctx, config, messages, options = {}) {
  if (typeof ctx?.models?.stream !== "function") {
    throw new Error("Hana 宿主模型通道不可用。");
  }
  const provider = String(config?.providerId ?? "");
  const model = String(config?.modelId ?? "");
  if (!provider.trim() || !model.trim()) throw new Error("未选择供应商和模型。");

  const normalized = normalizeHostMessages(messages);
  const requestId = `tigexing_model_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = { requestId, provider, model, messages: normalized.messages };
  if (normalized.systemPrompt) payload.systemPrompt = normalized.systemPrompt;
  if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) payload.maxTokens = Math.floor(options.maxTokens);
  if (Number.isFinite(options.temperature)) payload.temperature = options.temperature;
  const reasoningEffort = options.reasoningLevel === false
    ? "off"
    : String(options.reasoningLevel ?? "off").trim().toLowerCase();
  // 跟哈娜呐保持一致：默认不发送思考档位；部分模型拒绝显式的 "off"。
  // 只有调用方明确要求一个非 off 档位时才传，无法关闭时仍由原模型预算与重试处理。
  if (reasoningEffort && reasoningEffort !== "off") payload.reasoningEffort = reasoningEffort;

  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error("模型调用超时");
      error.code = "APP_MODEL_TIMEOUT";
      reject(error);
    }, Math.max(1000, Number(options.timeoutMs) || 30000));
    timer.unref?.();
  });

  try {
    return await Promise.race([
      (async () => {
        const response = await ctx.models.stream(payload);
        const raw = typeof response?.text === "function" ? await response.text() : String(response ?? "");
        const parsed = parseHostModelStream(raw);
        if (parsed.error) {
          const error = new Error(parsed.error.message);
          error.code = parsed.error.code;
          throw error;
        }
        if (response?.ok === false) {
          throw new Error(`模型接口返回错误（HTTP ${response.status || "未知"}）`);
        }
        // 空正文连同思考与结束原因返回给 ModelConfig；由它做一次同模型有限重试，不能静默换模型。
        return {
          text: parsed.text,
          reasoning_content: parsed.reasoning,
          finish_reason: parsed.finishReason,
          usage: parsed.usage,
        };
      })(),
      timeout,
    ]);
  } catch (error) {
    if (timedOut) {
      try { await ctx.models.cancel?.(requestId); } catch { /* 撤权或超时后由宿主清理 */ }
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
