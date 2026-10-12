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
  notice,
  timeoutMs = 30000,
} = {}) {
  const baseTitle = style.title(kind, agentName, count, "");
  const prefix = sessionPrefix(sessionTitle);
  // notice 是给用户的实情说明（如“（这版可能还会变）”），排在正文最前，不参与润色。
  const withNotice = (text) => (notice ? `${notice} ${text}` : text);
  const fallback = {
    title: prefix + baseTitle,
    body: withNotice(style.body(kind, snippet, count)),
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
    // refineTitleAndBody 自己拼会话前缀，这里不能再加，只补 notice。
    return { ...refined, body: withNotice(refined.body), refined: true };
  } catch (refineError) {
    return { ...fallback, refineError };
  }
}
