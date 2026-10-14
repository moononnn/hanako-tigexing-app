// 提个醒 · 拾光记专注通知
// 复用伙伴在提个醒里选的正文风格与通知设置；标题始终准确说明专注事件，不冒充聊天回复。
import { getStyle } from "./style.js";
import { planExternalNotify } from "./external-notify.js";
import { isInQuietHours } from "./policy.js";

export const FOCUS_NOTIFY_SERVICE = "focus/notify";

const text = (value, max = 120) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
  : "";
const boundedInt = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
};

export function validateFocusNotification(input = {}) {
  const kind = input.kind === "start" || input.kind === "end" ? input.kind : "";
  const focusId = text(input.focusId, 128);
  if (!kind || !focusId) return { ok: false, error: "kind and focusId are required" };
  return {
    ok: true,
    value: {
      kind,
      focusId,
      taskTitle: text(input.taskTitle, 80),
      durationMinutes: boundedInt(input.durationMinutes, kind === "start" ? 1 : 0, kind === "start" ? 1 : 0, 1440),
      roundIndex: boundedInt(input.roundIndex, 1, 1, 20),
      totalRounds: boundedInt(input.totalRounds, 1, 1, 20),
      companionId: text(input.companionId, 200),
      companionName: text(input.companionName, 60),
    },
  };
}

/**
 * 陪读伙伴能在 Hana 名单里找到时用 ta 的通知设置；否则只把通知外观回退到主伙伴。
 * 无陪读者时返回空 ID，保持通用通知，不借用任何伙伴身份。
 */
export function resolveFocusNotificationAgent(companionId, agents = []) {
  const requestedId = text(companionId, 200);
  if (!requestedId) return { agentId: "", fallback: false, reason: "solo" };
  const rows = Array.isArray(agents) ? agents.filter((row) => row && typeof row.id === "string" && row.id.trim()) : [];
  if (rows.some((row) => row.id === requestedId)) {
    return { agentId: requestedId, fallback: false, reason: "companion" };
  }
  const primary = rows.find((row) => row.isPrimary === true)
    || rows.find((row) => row.id === "hanako");
  return {
    agentId: text(primary?.id, 200),
    fallback: Boolean(primary?.id),
    reason: primary?.id ? "primary-fallback" : "no-primary",
  };
}

export function buildFocusNotificationCopy(input, style) {
  const kind = input.kind === "start" ? "start" : "end";
  const phaseText = kind === "start" ? "开始" : "结束";
  const companion = input.companionName ? `${input.companionName}陪读` : "独立专注";
  const title = `拾光记 · ${companion} · 第 ${input.roundIndex}/${input.totalRounds} 轮${phaseText} · ${input.durationMinutes} 分钟`;
  const goal = input.taskTitle || (kind === "start" ? "自由专注" : "这段专注");
  const rawBody = kind === "start"
    ? `计划专注 ${input.durationMinutes} 分钟 · 目标「${goal}」`
    : `专注 ${input.durationMinutes} 分钟 · 完成「${goal}」`;
  let body = rawBody;
  try {
    if (typeof style?.body === "function") body = String(style.body("first", rawBody, 1) || rawBody);
  } catch {
    body = rawBody;
  }
  return { title, message: body };
}

export function planFocusNotification(input, cfg, agentId, helpers, now) {
  const styleId = agentId ? String((cfg.agentStyles || {})[agentId] || "default") : "default";
  const copy = buildFocusNotificationCopy(input, getStyle(styleId));
  const plan = planExternalNotify({ ...copy, agentId }, cfg, helpers, now);
  return {
    ...plan,
    meta: { ...(plan.meta || {}), agentId: agentId || "", styleId },
  };
}

export async function handleFocusNotification(input, caller, deps = {}) {
  if (caller?.callerAppId !== "shiguangji-app") throw new Error("专注通知只接受拾光记调用");
  if (caller?.signal?.aborted) throw new Error("专注通知调用已取消");
  const validated = validateFocusNotification(input);
  if (!validated.ok) return { ok: false, sent: false, error: validated.error };
  const cfg = deps.getConfig?.() || {};
  if (!cfg.enabled) return { ok: true, sent: false, suppressed: true, reason: "disabled", agentId: "" };
  if (isInQuietHours(cfg, deps.now?.())) return { ok: true, sent: false, suppressed: true, reason: "quiet", agentId: "" };

  let agents = [];
  try {
    agents = await deps.getAgents?.() || [];
  } catch (error) {
    deps.log?.warn?.("[提个醒] 读取专注通知伙伴名单失败", { code: String(error?.code || "unknown").slice(0, 64) });
    agents = await deps.getCachedAgents?.() || [];
  }
  const selected = resolveFocusNotificationAgent(validated.value.companionId, agents);
  const helpers = await deps.getPlanHelpers?.({ agentId: selected.agentId, cfg }) || {
    resolveSoundFile: () => null,
    resolveAgentAvatar: () => null,
  };
  const plan = planFocusNotification(validated.value, cfg, selected.agentId, helpers, deps.now?.());
  if (plan.action === "suppressed") {
    return { ok: true, sent: false, suppressed: true, reason: plan.reason, agentId: selected.agentId };
  }

  if (plan.toast.style !== "plain" && selected.agentId && typeof deps.resolveAvatar === "function") {
    try { plan.toast.icon = await deps.resolveAvatar(selected.agentId) || undefined; }
    catch { plan.toast.icon = undefined; }
  }
  const result = await deps.deliver?.(plan.toast) || { sent: false, via: "failed" };
  return {
    ok: result.sent === true,
    sent: result.sent === true,
    via: result.via || "failed",
    suppressed: false,
    agentId: selected.agentId,
    styleId: plan.meta.styleId,
    usedPrimaryFallback: selected.fallback,
  };
}

export function createFocusNotificationHandler(deps = {}) {
  const inFlight = new Map();
  const completed = new Map();
  return async (input, caller) => {
    if (caller?.callerAppId !== "shiguangji-app") return handleFocusNotification(input, caller, deps);
    const validated = validateFocusNotification(input);
    if (!validated.ok) return handleFocusNotification(input, caller, deps);
    const key = `${validated.value.kind}:${validated.value.focusId}`;
    if (completed.has(key)) return completed.get(key);
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = handleFocusNotification(input, caller, deps);
    inFlight.set(key, pending);
    try {
      const result = await pending;
      if (result.sent === true || result.suppressed === true) {
        completed.set(key, result);
        while (completed.size > 256) completed.delete(completed.keys().next().value);
      }
      return result;
    } finally {
      inFlight.delete(key);
    }
  };
}
