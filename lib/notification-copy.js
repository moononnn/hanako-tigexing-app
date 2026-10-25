// 提个醒 · 通知标题正文组装
// 保持规则版兜底；润色只在用户开启且风格支持时调用已选模型。
import { refineTitleAndBody } from "./refine.js";
import { sessionPrefix } from "./style.js";

// 与 refine.js 的 BODY_MAX 对齐：通知横幅两行放得下的正文上限。
const BODY_MAX = 24;
// 带兜底提示时正文至少留这么多字，保证备注本身一定露得出来。
const MIN_BODY_WITH_NOTICE = 10;

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
  // notice 是给用户的实情说明（如「这轮还不算定稿 · 后面可能还会改」），不参与润色。
  // 排在正文末尾而不是最前：伙伴的话是主角，备注垫后读起来更自然；
  // 代价是正文要相应让出字数，否则横幅两行放不下、末尾的备注会被系统截没。
  const withNotice = (text) => {
    if (!notice) return text;
    const room = Math.max(MIN_BODY_WITH_NOTICE, BODY_MAX - notice.length);
    const body = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    return `${body} ${notice}`;
  };
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
