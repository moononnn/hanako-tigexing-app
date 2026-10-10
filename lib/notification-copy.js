// 提个醒 · 通知标题正文组装
// 保持规则版兜底；润色只在用户开启且风格支持时调用已选模型。
import { refineTitleAndBody } from "./refine.js";
import { sessionPrefix } from "./style.js";

export async function buildNotificationCopy({
  enabled,
  modelConfig,
  style,
  kind,
  agentName,
  snippet,
  refineText,
  count,
  sessionTitle,
  timeoutMs = 30000,
} = {}) {
  const baseTitle = style.title(kind, agentName, count, "");
  const prefix = sessionPrefix(sessionTitle);
  const fallback = {
    title: prefix + baseTitle,
    body: style.body(kind, snippet, count),
    refined: false,
  };
  if (!enabled || style.refinable !== true) return fallback;

  try {
    const refined = await refineTitleAndBody({
      mc: modelConfig,
      agentName,
      style,
      kind,
      snippet: refineText || snippet,
      count,
      sessionTitle,
      sessionPrefix,
      timeoutMs,
    });
    return { ...refined, refined: true };
  } catch (refineError) {
    return { ...fallback, refineError };
  }
}
