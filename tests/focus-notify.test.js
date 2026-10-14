import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../lib/config.js";
import {
  buildFocusNotificationCopy,
  createFocusNotificationHandler,
  planFocusNotification,
  resolveFocusNotificationAgent,
  validateFocusNotification,
} from "../lib/focus-notify.js";
import { getStyle } from "../lib/style.js";

const input = (overrides = {}) => ({
  kind: "start",
  focusId: "focus-round-1",
  taskTitle: "整理资料",
  durationMinutes: 25,
  roundIndex: 1,
  totalRounds: 4,
  companionId: "partner-a",
  companionName: "角色甲",
  ...overrides,
});
const config = (overrides = {}) => ({
  ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
  ...overrides,
});
const caller = { callerAppId: "shiguangji-app", signal: new AbortController().signal };
const helpers = {
  resolveSoundFile: () => null,
  resolveAgentAvatar: () => null,
};


test("专注通知请求校验 kind 与 focusId，并限制文本长度和轮次范围", () => {
  assert.equal(validateFocusNotification({ kind: "chat", focusId: "x" }).ok, false);
  assert.equal(validateFocusNotification({ kind: "start" }).ok, false);
  const parsed = validateFocusNotification(input({ roundIndex: 99, totalRounds: 0, taskTitle: "x".repeat(200) }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.roundIndex, 20);
  assert.equal(parsed.value.totalRounds, 1);
  assert.equal(parsed.value.taskTitle.length, 80);
  assert.equal(validateFocusNotification(input({ taskTitle: "line one\nline two" })).value.taskTitle, "line one line two");
  assert.equal(validateFocusNotification(input({ kind: "end", durationMinutes: 0 })).value.durationMinutes, 0);
});

test("陪读者在 Hana 名单时用 ta；不存在时只把通知设置回退主伙伴", () => {
  const agents = [
    { id: "hanako", name: "主伙伴", isPrimary: true },
    { id: "partner-a", name: "角色甲" },
  ];
  assert.deepEqual(resolveFocusNotificationAgent("partner-a", agents), {
    agentId: "partner-a", fallback: false, reason: "companion",
  });
  assert.deepEqual(resolveFocusNotificationAgent("tavern-only", agents), {
    agentId: "hanako", fallback: true, reason: "primary-fallback",
  });
  assert.deepEqual(resolveFocusNotificationAgent("", agents), {
    agentId: "", fallback: false, reason: "solo",
  });
});

test("专注通知沿用已选伙伴正文风格，但标题保留真实事件，不冒充聊天回复", () => {
  const copy = buildFocusNotificationCopy(input(), getStyle("gentle"));
  assert.match(copy.title, /角色甲陪读/);
  assert.match(copy.title, /第 1\/4 轮开始/);
  assert.doesNotMatch(copy.title, /回复|回你/);
  assert.match(copy.message, /「/);
  assert.match(copy.message, /～/);
});

test("计划按伙伴配置套用正文风格、头像与音效设置", () => {
  const cfg = config({
    agentStyles: { "partner-a": "sister" },
    agentSounds: { "partner-a": "silent" },
  });
  const plan = planFocusNotification(input(), cfg, "partner-a", helpers);
  assert.equal(plan.action, "send");
  assert.equal(plan.meta.styleId, "sister");
  assert.equal(plan.toast.sound, "silent");
  assert.match(plan.toast.message, /！！/);
  assert.match(plan.toast.title, /角色甲陪读/);
});

test("独立专注使用通用通知，不借用主伙伴头像、音效或风格", () => {
  const cfg = config({
    agentStyles: { hanako: "sister" },
    agentSounds: { hanako: "silent" },
  });
  const plan = planFocusNotification(input({ companionId: "", companionName: "" }), cfg, "", helpers);
  assert.equal(plan.action, "send");
  assert.equal(plan.meta.styleId, "default");
  assert.equal(plan.toast.icon, undefined);
  assert.equal(plan.toast.sound, undefined);
  assert.match(plan.toast.title, /独立专注/);
});

test("未知陪读角色的通知只套主伙伴风格，标题仍保留实际陪读者", async () => {
  const sent = [];
  const handler = createFocusNotificationHandler({
    getConfig: () => config({ agentStyles: { hanako: "gentle" }, agentSounds: { hanako: "silent" } }),
    getAgents: async () => [{ id: "hanako", name: "主伙伴", isPrimary: true }],
    getPlanHelpers: async () => helpers,
    resolveAvatar: async (agentId) => `avatar:${agentId}`,
    deliver: async (toast) => { sent.push(toast); return { sent: true, via: "powershell" }; },
  });
  const result = await handler(input({ companionId: "tavern-only", companionName: "酒馆角色" }), caller);
  assert.equal(result.sent, true);
  assert.equal(result.agentId, "hanako");
  assert.equal(result.usedPrimaryFallback, true);
  assert.equal(result.styleId, "gentle");
  assert.match(sent[0].title, /酒馆角色陪读/);
  assert.equal(sent[0].icon, "avatar:hanako");
  assert.equal(sent[0].sound, "silent");
});

test("总开关关闭时明确返回 suppressed，不读取伙伴名单、音效或投递", async () => {
  let agentsRead = 0;
  let planned = 0;
  let delivered = 0;
  const handler = createFocusNotificationHandler({
    getConfig: () => config({ enabled: false }),
    getAgents: async () => { agentsRead += 1; return []; },
    getPlanHelpers: async () => { planned += 1; return helpers; },
    deliver: async () => { delivered += 1; return { sent: true, via: "host" }; },
  });
  const result = await handler(input({ companionId: "", companionName: "" }), caller);
  assert.deepEqual({ sent: result.sent, suppressed: result.suppressed, reason: result.reason }, {
    sent: false, suppressed: true, reason: "disabled",
  });
  assert.equal(agentsRead, 0);
  assert.equal(planned, 0);
  assert.equal(delivered, 0);
});

test("专注通知服务仅允许拾光记调用", async () => {
  const handler = createFocusNotificationHandler({ deliver: async () => ({ sent: true }) });
  await assert.rejects(() => handler(input(), { callerAppId: "other-app" }), /只接受拾光记/);
});

test("同一专注事件并发重复请求只投递一次", async () => {
  let delivered = 0;
  const handler = createFocusNotificationHandler({
    getConfig: () => config(),
    getAgents: async () => [{ id: "partner-a", isPrimary: false }],
    getPlanHelpers: async () => helpers,
    deliver: async () => {
      delivered += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { sent: true, via: "host" };
    },
  });
  const [a, b] = await Promise.all([handler(input(), caller), handler(input(), caller)]);
  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(delivered, 1);
});
