// 提个醒 · 异常回合文案
// 异常通知必须让人一眼知道发生了什么、下一步该说什么；不把底层错误原文直接塞进弹窗。

import { clip, sessionPrefix } from "./style.js";

/** 判断是否是用户主动取消重试；这种情况不需要再提醒一次。 */
export function isRetryCancelled(errorMessage) {
  const text = String(errorMessage || "").trim().toLowerCase();
  return /(?:\bretry[\s_-]+(?:cancelled|canceled)\b|\b(?:cancelled|canceled)[\s_-]+by[\s_-]+(?:the[\s_-]+)?user\b|\b(?:user|manual(?:ly)?)[\s_-]+(?:cancelled|canceled)\b|\baborted?[\s_-]+by[\s_-]+(?:the[\s_-]+)?user\b|\buser[\s_-]+aborted?\b)/.test(text);
}

/** 未知错误保留一小段供应商原文，先去掉常见凭据、会话标识、链接及本机/UNC 路径。 */
function safeErrorDetail(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s,"'}]+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[密钥已隐藏]")
    .replace(/(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|cookie|token|secret|session[_ -]?id)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|["']?[^,\s"'}`]+)/gi, "$1=[已隐藏]")
    .replace(/\bfile:\/\/[^,;"'<>|\r\n]+/gi, "[路径已隐藏]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[链接已省略]")
    .replace(/(?:\\{2}|\/{2})[^,;"'<>|\r\n]+/g, "[路径已隐藏]")
    .replace(/\b[A-Za-z]:[\\/][^,;"'<>|\r\n]+/g, "[路径已隐藏]")
    .replace(/\/(?:Users|home|root)\/[^,;"'<>|\r\n]+/gi, "[路径已隐藏]")
    .replace(/\b(?:sess(?:ion)?)[_-][A-Za-z0-9_-]{12,}\b/gi, "[会话编号]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把模型错误归纳成中文原因；拿不准时显示脱敏后的原始错误，而不是猜。 */
export function failureReasonLabel(errorMessage) {
  const raw = String(errorMessage || "").trim();
  const text = raw.toLowerCase();
  if (!text) return "模型请求没完成";

  const fiveHourWindow = /(?:\b5\s*[- ]?(?:hours?|h)\b|5\s*小时|五小时)/i.test(raw);
  const hasQuotaSignal = /quota|usage|credit|token\s*limit|\bcap\b|\blimit\b|额度|配额|用量|使用量|限额|上限/i.test(raw);
  if (fiveHourWindow && hasQuotaSignal) return "模型 5 小时使用额度已用完";
  if (/token\s*plan/i.test(raw) && /usage|quota|limit|cap|用量|额度|上限/i.test(raw)) {
    const codes = [
      /\b402\b/.test(raw) ? "402" : "",
      /\b2067\b/.test(raw) ? "2067" : ""
    ].filter(Boolean);
    return `模型 Token Plan 用量已达上限${codes.length ? `（${codes.join("/")}）` : ""}`;
  }
  if (/insufficient[_\s]+balance|insufficient_balance_error|balance.{0,20}(?:low|insufficient)|billing|payment required|credit balance|余额不足|欠费|付费额度不足/i.test(raw)) {
    return "模型账户余额或付费额度不足";
  }
  if (/insufficient_quota|quota.{0,50}(?:exceed|limit|reach|exhaust|满|耗尽|用完)|(?:exceed|exhaust|reach|used up).{0,50}(?:quota|usage|额度|用量|限额)|usage.{0,20}(?:limit|cap).{0,30}(?:reach|exceed|exhaust|满|耗尽|用完)|(?:额度|用量|配额|限额).{0,16}(?:已?满|耗尽|用完|上限)/i.test(raw)) {
    return "模型使用额度已用完";
  }
  if (/429|rate.?limit|too many requests|频率限制|请求过于频繁|限流/i.test(text)) {
    return "模型请求触发限流";
  }
  if (/401|403|api[ _-]?key|credential|unauthori|forbidden|auth(?:entication|orization)?|凭据|鉴权|权限校验/i.test(text)) {
    return "模型凭据或权限校验失败";
  }
  if (/websocket|fetch failed|network|socket|connect|timeout|timed out|econn|网络|连接|超时/i.test(text)) {
    return "模型连接中断或超时";
  }
  if (/overload|too busy|busy|server error|internal error|service unavailable|temporarily unavailable|过载|服务繁忙|服务器错误/i.test(text)) {
    return "模型服务暂时不可用";
  }

  const detail = safeErrorDetail(raw);
  return detail ? `模型返回：${clip(detail, 48)}` : "模型请求没完成";
}

/**
 * 构造异常通知的规则版标题和正文。
 * partialText 会保留一小段已经收到的助手内容，避免只弹一个冷冰冰的错误码。
 */
export function buildAbnormalCopy({
  kind = "failure",
  agentName = "助手",
  sessionTitle = "",
  partialText = "",
  errorMessage = "",
  recentErrors = 0,
  totalChecked = 0
} = {}) {
  const prefix = sessionPrefix(sessionTitle);
  const name = String(agentName || "助手").trim() || "助手";

  if (kind === "unhealthy") {
    const count = Number.isFinite(Number(recentErrors)) && Number.isFinite(Number(totalChecked))
      && Number(totalChecked) > 0
      ? `（近 ${Number(recentErrors)}/${Number(totalChecked)} 次失败）`
      : "";
    return {
      title: `${prefix}${name} · 对话状态不稳`,
      body: `这个对话连续失败${count}，建议新开对话`
    };
  }

  const reason = failureReasonLabel(errorMessage);
  const partial = clip(partialText, 12);
  const nextStep = /余额或付费额度不足/.test(reason)
    ? "补足额度后说“继续”再试"
    : /5 小时使用额度|Token Plan 用量|模型使用额度/.test(reason)
      ? "额度恢复后说“继续”再试"
      : "说“继续”再试";
  const body = partial
    ? `${reason}；已收到「${partial}」；${nextStep}`
    : `${reason}，${nextStep}`;
  return {
    title: `${prefix}${name} · 这轮没接上`,
    body,
    refined: false
  };
}
