// 提个醒 · 闲聊（casual chat）提醒测试
//
// 闲聊这条链路跟普通会话完全不同：伙伴是用 chat_say 工具在闲聊窗口里说话，
// 主会话的 turn_end 拿不到它，宿主自己也不发「聊天回复完成」通知。
// 提个醒接的是 casual_entry，所以这一组测试守的是：
//   1. 认得出哪些气泡是伙伴说的话（用户自己发的、审批、重置都不算）；
//   2. 分得出「回你话」与「对方主动开口」；
//   3. 档位决定要不要提醒；
//   4. 宿主本体若已提醒过同一句，不弹第二遍。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCasualEntry,
  isAgentCasualMessage,
  casualEntryText,
  CasualTurnTracker,
  decideCasualNotify,
  HostNoticeMemory,
  CASUAL_MARKER,
  CASUAL_TURN_GAP_MS,
  CASUAL_REPLY_WINDOW_MS,
  NOTICE_MATCH_MIN_LEN,
} from "../lib/casual-notify.js";
import { buildCasualCopy, casualRuleTitle } from "../lib/notification-copy.js";
import { getStyle } from "../lib/style.js";
import { normalizeConfig, DEFAULT_CONFIG } from "../lib/config.js";

const agentEntry = (overrides = {}) => ({
  type: "casual_entry",
  studioId: "studio-1",
  agentId: "hanako",
  entry: {
    id: "entry-1",
    sourceEntryId: "entry-1",
    actor: "agent",
    occurredAt: "2026-10-30T07:00:00.000Z",
    item: { kind: "text", text: "今天有空吗", ...overrides },
  },
});

const userEntry = () => ({
  type: "casual_entry",
  studioId: "studio-1",
  agentId: "hanako",
  entry: {
    id: "entry-0",
    actor: "user",
    occurredAt: "2026-10-30T06:59:00.000Z",
    item: { kind: "text", text: "在吗" },
  },
});

// ── 事件解析 ──

test("casual_entry 解析出伙伴、气泡类型与正文", () => {
  const parsed = parseCasualEntry(agentEntry());
  assert.equal(parsed.agentId, "hanako");
  assert.equal(parsed.studioId, "studio-1");
  assert.equal(parsed.actor, "agent");
  assert.equal(parsed.itemKind, "text");
  assert.equal(casualEntryText(parsed.item), "今天有空吗");
});

test("不是 casual_entry 的事件返回 null", () => {
  assert.equal(parseCasualEntry({ type: "turn_end" }), null);
  assert.equal(parseCasualEntry(null), null);
  assert.equal(parseCasualEntry({ type: "casual_entry" }), null);
  assert.equal(parseCasualEntry({ type: "casual_entry", entry: { actor: "agent" } }), null);
});

test("语音条取转写文字，表情取备注，卡片取标题，图片文件给个说明", () => {
  assert.equal(casualEntryText({ kind: "voice", text: "今天有空吗" }), "今天有空吗");
  assert.equal(casualEntryText({ kind: "sticker", note: "开心" }), "开心");
  assert.equal(casualEntryText({ kind: "card", title: "一张卡片" }), "一张卡片");
  assert.equal(casualEntryText({ kind: "image" }), "〔图片〕");
  assert.equal(casualEntryText({ kind: "file", name: "a.pdf" }), "〔文件〕a.pdf");
  assert.equal(casualEntryText(null), "");
});

test("只把伙伴说的话当提醒对象：用户自己发的、审批、重置都不算", () => {
  assert.equal(isAgentCasualMessage(parseCasualEntry(agentEntry())), true);
  assert.equal(isAgentCasualMessage(parseCasualEntry(userEntry())), false);
  assert.equal(isAgentCasualMessage(parseCasualEntry(agentEntry({ kind: "approval", title: "要授权吗" }))), false);
  assert.equal(isAgentCasualMessage(parseCasualEntry(agentEntry({ kind: "reset" }))), false);
  assert.equal(isAgentCasualMessage(parseCasualEntry(agentEntry({ text: "   " }))), false);
});

// ── 回话还是主动开口 ──

test("她先说话，伙伴接着回：这是回话", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  const turn = tracker.noteAgentMessage("studio-1:hanako", 2000);
  assert.equal(turn.mode, "reply");
  assert.equal(turn.first, true);
});

test("没人说话时伙伴开口：这是对方主动开口", () => {
  const tracker = new CasualTurnTracker();
  const turn = tracker.noteAgentMessage("studio-1:hanako", 1000);
  assert.equal(turn.mode, "proactive");
  assert.equal(turn.first, true);
});

test("同一轮里的后续气泡不算新一轮，也不重发一条", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  const first = tracker.noteAgentMessage("studio-1:hanako", 2000);
  const second = tracker.noteAgentMessage("studio-1:hanako", 3000);
  assert.equal(first.mode, "reply");
  assert.equal(second.mode, "reply");
  assert.equal(second.first, false);
  assert.equal(second.turnId, first.turnId, "同一轮的轮次编号要一样");
});

test("隔得久一点就是新一轮：两条挨着但隔了两分钟也不能当成同一轮", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  const first = tracker.noteAgentMessage("studio-1:hanako", 2000);
  const later = tracker.noteAgentMessage("studio-1:hanako", 2000 + CASUAL_TURN_GAP_MS + 1000);
  assert.equal(later.first, true, "隔过一轮就该算新一轮");
  assert.notEqual(later.turnId, first.turnId, "新一轮要有新的轮次编号");
});

test("记下这一轮已提醒过：后面的气泡不再弹第二条", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  const turn = tracker.noteAgentMessage("studio-1:hanako", 2000);
  assert.equal(tracker.isNotified("studio-1:hanako", turn.turnId), false);
  tracker.markNotified("studio-1:hanako", turn.turnId);
  assert.equal(tracker.isNotified("studio-1:hanako", turn.turnId), true);
  // 下一轮就是新的，不受上一轮的标记影响
  const next = tracker.noteAgentMessage("studio-1:hanako", 2000 + CASUAL_TURN_GAP_MS + 1000);
  assert.equal(tracker.isNotified("studio-1:hanako", next.turnId), false);
});

test("回话过了很久才来，算对方主动开口", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  const late = tracker.noteAgentMessage("studio-1:hanako", 1000 + CASUAL_REPLY_WINDOW_MS + 1000);
  assert.equal(late.mode, "proactive");
});

test("她发完话、对方一直没回，之后对方主动开口：算主动开口", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  // 超过回话窗口（两分钟）还没接上，说明她那一句没得到回应；
  // 这时候对方自己开口，算主动开口。
  const later = tracker.noteAgentMessage("studio-1:hanako", 1000 + CASUAL_REPLY_WINDOW_MS + 1000);
  assert.equal(later.mode, "proactive");
});

test("她刚说完、对方马上接上：算回她的话", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  const quick = tracker.noteAgentMessage("studio-1:hanako", 1000 + CASUAL_TURN_GAP_MS + 1000);
  assert.equal(quick.mode, "reply", "她才说完三十秒，对方接上就是在回她");
});

test("她开口就是新一轮：上一轮隔再久也断开了", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  const first = tracker.noteAgentMessage("studio-1:hanako", 2000);
  assert.equal(first.mode, "reply");
  // 她又开口了：不管上一轮隔多久，都算新一轮
  tracker.noteUserMessage("studio-1:hanako", 1000 + CASUAL_TURN_GAP_MS + 1000);
  const next = tracker.noteAgentMessage("studio-1:hanako", 1000 + CASUAL_TURN_GAP_MS + 2000);
  assert.equal(next.first, true);
  assert.notEqual(next.turnId, first.turnId);
});

test("回复之后又主动开口：这一轮是主动开口", () => {
  const tracker = new CasualTurnTracker();
  tracker.noteUserMessage("studio-1:hanako", 1000);
  assert.equal(tracker.noteAgentMessage("studio-1:hanako", 2000).mode, "reply");
  assert.equal(tracker.noteAgentMessage("studio-1:hanako", 2000 + CASUAL_TURN_GAP_MS + 1000).mode, "proactive");
});

// ── 提醒档位 ──

test("档位：从不提醒 / 只提醒主动开口 / 每次都提醒", () => {
  assert.deepEqual(decideCasualNotify({ trigger: "never", mode: "proactive" }), { notify: false, reason: "never" });
  assert.equal(decideCasualNotify({ trigger: "proactive", mode: "reply" }).notify, false);
  assert.equal(decideCasualNotify({ trigger: "proactive", mode: "proactive" }).notify, true);
  assert.equal(decideCasualNotify({ trigger: "always", mode: "reply" }).notify, true);
  assert.equal(decideCasualNotify({ trigger: "always", mode: "proactive" }).notify, true);
});

test("档位写错或没写时按默认的「只提醒主动开口」处理", () => {
  assert.equal(decideCasualNotify({ trigger: "乱七八糟", mode: "proactive" }).notify, true);
  assert.equal(decideCasualNotify({ mode: "reply" }).notify, false);
});

test("配置里的闲聊档位只认三档，别的值回落到默认", () => {
  assert.equal(normalizeConfig({}).casualTrigger, DEFAULT_CONFIG.casualTrigger);
  assert.equal(normalizeConfig({ casualTrigger: "always" }).casualTrigger, "always");
  assert.equal(normalizeConfig({ casualTrigger: "never" }).casualTrigger, "never");
  assert.equal(normalizeConfig({ casualTrigger: "乱写的" }).casualTrigger, DEFAULT_CONFIG.casualTrigger);
});

// ── 与宿主本体通知去重 ──

test("宿主已提醒同一句：提个醒不再弹第二遍", () => {
  const memory = new HostNoticeMemory();
  memory.note({
    type: "notification",
    agentId: "hanako",
    body: "今天有空吗？要不要一起看看新到的资料",
    desktopFocusPolicy: "when_unfocused",
  }, 1000);
  assert.equal(memory.covers("hanako", "今天有空吗？要不要一起看看新到的资料", { hostShown: true, now: 2000 }), true);
  assert.equal(memory.covers("hanako", "今天有空吗？要不要一起看看新到的资料", { hostShown: false, now: 2000 }), false);
  assert.equal(memory.covers("agent_b", "今天有空吗？要不要一起看看新到的资料", { hostShown: true, now: 2000 }), false);
});

test("宿主那句比我们长：认得出是同一句", () => {
  const memory = new HostNoticeMemory();
  memory.note({
    type: "notification",
    agentId: "hanako",
    body: "诶 花浇了没嘛",
    desktopFocusPolicy: "when_unfocused",
  }, 1000);
  assert.equal(memory.covers("hanako", "诶 花浇了没嘛", { hostShown: true, now: 2000 }), true);
});

test("我们那句比宿主长但开头一样：不算同一句，不能把提醒吞掉", () => {
  const memory = new HostNoticeMemory();
  memory.note({
    type: "notification",
    agentId: "hanako",
    body: "好",
    desktopFocusPolicy: "when_unfocused",
  }, 1000);
  assert.equal(memory.covers("hanako", "好呀，等下说", { hostShown: true, now: 2000 }), false);
});

test("宿主那条不是在屏幕上弹的（前台被压掉）：提个醒照常提醒", () => {
  const memory = new HostNoticeMemory();
  memory.note({
    type: "notification",
    agentId: "hanako",
    body: "今天有空吗",
    desktopFocusPolicy: "when_unfocused",
  }, 1000);
  assert.equal(memory.covers("hanako", "今天有空吗", { hostShown: false, now: 2000 }), false);
});

test("会话完成通知、计划任务通知、Agent 主动通知都不拿来当去重依据", () => {
  const memory = new HostNoticeMemory();
  const chatDone = {
    type: "notification",
    agentId: "hanako",
    body: "今天有空吗",
    desktopFocusPolicy: "when_session_unfocused",
    sessionPath: "C:/x/sessions/a.jsonl",
  };
  const activity = {
    type: "notification",
    agentId: "hanako",
    body: "今天有空吗",
    desktopFocusPolicy: "when_unfocused",
    activityId: "cron-1",
  };
  const agentNotice = {
    type: "notification",
    agentId: "hanako",
    body: "今天有空吗",
  };
  for (const event of [chatDone, activity, agentNotice]) {
    assert.equal(memory.note(event, 1000), false);
    assert.equal(memory.covers("hanako", "今天有空吗", { hostShown: true, now: 2000 }), false);
  }
});

test("宿主报的第一气泡很短时也认得出是同一句", () => {
  const memory = new HostNoticeMemory();
  memory.note({
    type: "notification",
    agentId: "hanako",
    body: "诶",
    desktopFocusPolicy: "when_unfocused",
  }, 1000);
  assert.equal(memory.covers("hanako", "诶", { hostShown: true, now: 2000 }), true);
});
test("宿主通知过期后不再算已提醒", () => {
  const memory = new HostNoticeMemory({ ttlMs: 1000 });
  memory.note({
    type: "notification",
    agentId: "hanako",
    body: "今天有空吗，要不要一起看看",
    desktopFocusPolicy: "when_unfocused",
  }, 1000);
  assert.equal(memory.covers("hanako", "今天有空吗，要不要一起看看", { hostShown: true, now: 1500 }), true);
  assert.equal(memory.covers("hanako", "今天有空吗，要不要一起看看", { hostShown: true, now: 3000 }), false);
});

// ── 文案 ──

test("规则版标题：回话沿用伙伴风格的说法，主动开口另起一句说清事实", () => {
  const style = getStyle("cheerful");
  assert.match(casualRuleTitle(style, "小花", "reply"), /回你啦/);
  assert.equal(casualRuleTitle(style, "小花", "proactive"), "小花 主动找你了");
});

test("闲聊正文按伙伴风格加工，不是原样裸文本", () => {
  const gentle = getStyle("gentle");
  const body = gentle.body("first", "今天有空吗", 1);
  assert.match(body, /今天有空吗/);
  assert.notEqual(body, "今天有空吗");
});

test("闲聊文案不挂会话标题前缀", async () => {
  const copy = await buildCasualCopy({
    enabled: false,
    style: getStyle("default"),
    agentName: "小花",
    snippet: "今天有空吗",
    refineText: "今天有空吗",
    mode: "proactive",
  });
  assert.equal(copy.title, "小花 主动找你了");
  assert.equal(copy.refined, false);
  assert.equal(copy.body.includes("今天有空吗"), true);
});

test("闲聊标记在标题最前，一眼认出是闲聊来的", () => {
  assert.equal(CASUAL_MARKER, "〔闲聊〕");
});
