// 提个醒 · 通知标题正文组装
// 保持规则版兜底；润色只在用户开启且风格支持时调用已选模型。
import { refineTitleAndBody } from "./refine.js";
import { sessionPrefix } from "./style.js";

// 与 refine.js 的 BODY_MAX 对齐：通知横幅两行放得下的正文上限。
const BODY_MAX = 24;
// 带兜底提示时正文至少留这么多字，保证备注本身一定露得出来。
const MIN_BODY_WITH_NOTICE = 10;

/**
 * 闲聊窗口（哈娜 1.5.7 的侧边栏闲聊）的通知文案。
 *
 * 与普通会话分开走：闲聊没有会话标题，标题只带「〔闲聊〕」记号与伙伴名；
 * 正文仍按伙伴的风格加工（豆狸粒狸、温柔、摩斯那套照旧生效）。
 *
 * 标题要说的是事实：对方主动开口跟回你的话不是一回事，
 * 规则版分别写「主动找你了」和「回你啦」，不拿「回你啦」去套主动问候。
 * 开启文案润色时，标题与正文交给模型按风格改写，kind 决定它是
 * 「对方主动开口」还是「回你的话」，模型才知道该用哪种口吻。
 */
export async function buildCasualCopy({
  enabled,
  modelConfig,
  style,
  agentName,
  snippet,
  refineText,
  mode,
  timeoutMs = 30000,
} = {}) {
  const kind = mode === "reply" ? "casual-reply" : "casual-proactive";
  const fallback = {
    title: casualRuleTitle(style, agentName, mode),
    body: style.body("first", snippet, 1),
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
      count: 1,
      // 闲聊没有会话标题，别让模型自己加前缀；〔闲聊〕记号由调用方拼在最前。
      sessionTitle: undefined,
      sessionPrefix: undefined,
      timeoutMs,
    });
    return {
      title: refined.title,
      body: refined.body,
      refined: true,
    };
  } catch (refineError) {
    return { ...fallback, refineError };
  }
}

/**
 * 规则版闲聊标题。
 * 回话沿用伙伴风格的现成说法（「回你啦」之类）；
 * 主动开口没有现成说法，另起一句说清事实，不硬套「回你啦」。
 */
export function casualRuleTitle(style, agentName, mode) {
  const name = agentName || "助手";
  if (mode === "reply") {
    const styled = style?.title?.("first", name, 1, "");
    return styled || `${name} 回你啦`;
  }
  return `${name} 主动找你了`;
}

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
