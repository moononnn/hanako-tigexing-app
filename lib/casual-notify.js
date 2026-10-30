// 提个醒 · 闲聊（casual chat）消息提醒
//
// 哈娜 1.5.7 起有「闲聊」：在桌面侧边栏里跟伙伴闲聊，不必另开工作会话。
// 这条链路跟普通会话不一样，所以「说完了」不能听 turn_end：
//   - 伙伴在闲聊里是用 chat_say 工具发言，主会话那边只留下 toolUse 的回合，
//     按回合收「回复完成」收不到闲聊的气泡；
//   - 闲聊会话的 namespace 是 casual，宿主自己就把它的完成通知跳过了。
// 但闲聊的每条气泡都会以 casual_entry 投到业务总线（App 也收得到，payload 完整），
// 这里就以它为准：伙伴说了话 → 提个醒按自己的风格与音效提醒。
//
// 两类消息要分开：
//   - 对方主动开口（问候、主动提醒）：你要的就是这个，提醒。
//   - 你刚问、对方回你：人就在面板上看着，不该再弹一条。
// 靠「有没有在等你回话」区分：用户消息先到 → 伙伴这条是回话；否则是主动开口。
//
// 宿主那边若还开着本体闲聊通知，同一句话会有两条；这里留一段对照窗口，
// 认得出宿主已经报过就别再弹（见 HostNoticeMemory）。

export const CASUAL_TRIGGERS = ["never", "proactive", "always"];
export const DEFAULT_CASUAL_TRIGGER = "proactive";

// 通知标题前的记号：一眼认出这条是闲聊来的（跟 〔Code〕 一个用法）。
export const CASUAL_MARKER = "〔闲聊〕";

// 同一轮里的多条气泡（宿主一轮可发 1~8 条）算一条消息，只提醒一次。
//
// 这个窗口同时管两件事，所以它们必须是同一个数：
//   1. 相邻气泡间隔不超过它，就算同一轮（实机看到同一条回复里相邻气泡间隔 3~7 秒）；
//   2. 超过它没有新气泡，就算这一轮说完了，把攒的内容发出去。
// 分成两个窗口会出事：结算窗口比同轮间隔短时，一句话就被拆成好几条弹窗。
export const CASUAL_TURN_GAP_MS = 12000;

// 她刚说完话、伙伴这么快就接上，算「回你话」。
//
// 窗口故意短（两分钟）：回话本来就快，超过两分钟还冒出来的，
// 宁可当成「对方主动开口」也别漏提醒——漏一条主动问候的代价，
// 比多弹一条回话大。
export const CASUAL_REPLY_WINDOW_MS = 120000;

// 一轮里的气泡陆续到齐要等这么久才发通知。
//
// 跟同轮窗口取同一个值：结算窗口比同轮间隔短的话，一句话会被拆成好几条弹窗。
// 这个窗口还担着另一件事：等宿主自己的通知先到，好判断是不是同一句、
// 免得两边都弹（宿主对闲聊的通知事件比我们的气泡晚一点点到）。
export const CASUAL_SETTLE_MS = CASUAL_TURN_GAP_MS;

// 宿主原版通知与我们的提醒可能撞车，留一小段对照窗口。
export const HOST_NOTICE_TTL_MS = 5000;

// 兜底认新发言时，「多新才算新」。
//
// App 刚装上时面板里可能积着一堆旧消息；那些不该一股脑弹一遍。
export const CASUAL_UNREAD_FRESH_MS = 60000;

/**
 * 解析一条 casual_entry 事件。
 * @param {object} event 业务总线事件
 * @returns {{agentId:string, studioId:string, entryId:string, actor:string, itemKind:string, item:object, occurredAt:string}|null}
 */
export function parseCasualEntry(event) {
  if (!event || typeof event !== "object" || event.type !== "casual_entry") return null;
  const entry = event.entry;
  if (!entry || typeof entry !== "object") return null;
  const agentId = String(event.agentId || "").trim();
  if (!agentId) return null;
  const item = entry.item && typeof entry.item === "object" ? entry.item : {};
  return {
    agentId,
    studioId: String(event.studioId || "").trim(),
    entryId: String(entry.id || entry.sourceEntryId || "").trim(),
    actor: String(entry.actor || "").trim(),
    itemKind: String(item.kind || "").trim(),
    item,
    occurredAt: entry.occurredAt ? String(entry.occurredAt) : ""
  };
}

/**
 * 气泡里能给人看的文字。文件与图片没有正文，给个说明，别让通知正文空着。
 */
export function casualEntryText(item) {
  if (!item || typeof item !== "object") return "";
  switch (item.kind) {
    case "text": return String(item.text || "");
    case "voice": return String(item.text || "");
    case "sticker": return String(item.note || "");
    case "card": return String(item.title || "");
    case "file": return item.name ? `〔文件〕${item.name}` : "〔文件〕";
    case "image": return "〔图片〕";
    default: return "";
  }
}

/**
 * 这条是不是伙伴说的话（用户自己发的、审批请求、重置都不算）。
 */
export function isAgentCasualMessage(parsed) {
  if (!parsed) return false;
  if (parsed.actor !== "agent") return false;
  if (parsed.itemKind === "approval" || parsed.itemKind === "reset") return false;
  return casualEntryText(parsed.item).trim() !== "";
}

/**
 * 记住「谁在等谁回话」，并判断伙伴这条是回话还是主动开口。
 *
 * 轮次：一条回话里常有好几个气泡（对方一条条说）。同一轮只提醒一次。
 * 轮首定下这一轮的说法（回话 / 主动开口），轮内后续气泡沿用。
 */
export class CasualTurnTracker {
  constructor({ turnGapMs = CASUAL_TURN_GAP_MS, replyWindowMs = CASUAL_REPLY_WINDOW_MS } = {}) {
    this.turnGapMs = Math.max(1000, Number(turnGapMs) || CASUAL_TURN_GAP_MS);
    this.replyWindowMs = Math.max(1000, Number(replyWindowMs) || CASUAL_REPLY_WINDOW_MS);
    this.agents = new Map();
    this.turnSeq = 0;
  }

  /**
   * 改同轮窗口。调用方把它跟「攒多久才发」设成同一个数：
   * 两个窗口分开就会把一句话拆成好几条弹窗。
   */
  setWindow(turnGapMs) {
    const value = Number(turnGapMs);
    if (value > 0) this.turnGapMs = Math.max(1000, value);
  }

  _state(key) {
    let state = this.agents.get(key);
    if (!state) {
      state = {
        awaitingReply: false,
        lastUserAt: 0,
        lastAgentAt: 0,
        turnMode: "proactive",
        turnId: 0,
        turnActive: false,
        notifiedTurnId: 0,
      };
      this.agents.set(key, state);
    }
    return state;
  }

  /** 用户在闲聊里说了话：记下「有人在等回话」，并把上一轮断开。 */
  noteUserMessage(key, now = Date.now()) {
    const state = this._state(key);
    state.awaitingReply = true;
    state.lastUserAt = now;
    // 她开口就是新一轮的开始：上一轮不管隔多久都算过去了。
    state.turnActive = false;
  }

  /**
   * 伙伴说了话。
   * @returns {{mode:"reply"|"proactive", first:boolean, turnId:number}}
   *   mode 是回话还是主动开口；first 表示这是本轮第一条；
   *   turnId 是轮次编号，同轮多条气泡靠它认出来。
   */
  noteAgentMessage(key, now = Date.now()) {
    const state = this._state(key);
    const sameTurn = state.turnActive && now - state.lastAgentAt <= this.turnGapMs;
    if (sameTurn) {
      // 同一轮的后续气泡：沿用这一轮的说法，别把一句问候的后半句当成新消息。
      state.lastAgentAt = now;
      return { mode: state.turnMode, first: false, turnId: state.turnId };
    }
    // 新的一轮：她刚说完、伙伴马上接上 → 这是回她的话；
    // 其余情况（她没说话、或隔了太久）→ 对方主动开口。
    const waiting = state.awaitingReply && now - state.lastUserAt <= this.replyWindowMs;
    const mode = waiting ? "reply" : "proactive";
    state.turnMode = mode;
    state.turnId = ++this.turnSeq;
    state.turnActive = true;
    state.awaitingReply = false;
    state.lastAgentAt = now;
    return { mode, first: true, turnId: state.turnId };
  }

  /** 这一轮是不是已经提醒过了。同一轮只出一条，不给后面的气泡再弹一遍。 */
  isNotified(key, turnId) {
    const state = this._state(key);
    return Boolean(turnId) && state.notifiedTurnId === turnId;
  }

  /** 记下这一轮已经提醒过。 */
  markNotified(key, turnId) {
    const state = this._state(key);
    if (turnId) state.notifiedTurnId = turnId;
  }

  /** 清掉某个伙伴的状态（会话结束等）。 */
  forget(key) {
    this.agents.delete(key);
  }
}

/**
 * 这一条要不要提醒。
 * @param {{trigger?:string, mode:"reply"|"proactive"}} input
 * @returns {{notify:boolean, reason:string}}
 */
export function decideCasualNotify({ trigger = DEFAULT_CASUAL_TRIGGER, mode } = {}) {
  const level = CASUAL_TRIGGERS.includes(trigger) ? trigger : DEFAULT_CASUAL_TRIGGER;
  if (level === "never") return { notify: false, reason: "never" };
  if (level === "proactive" && mode === "reply") return { notify: false, reason: "reply" };
  return { notify: true, reason: level };
}

function normalizeNoticeText(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}
// 两条正文要多长才拿来比对。
export const NOTICE_MATCH_MIN_LEN = 1;

/**
 * 认出「没走 casual_entry、只走了 casual_unread」的那条发言。
 *
 * 实机（2026-10-30）：伙伴用语音回话时，宿主只发 casual_unread，
 * 不发 casual_entry——文字回复两个都发，语音只发后者。
 * 于是提个醒完全收不到语音的发言。
 *
 * casual_unread 的 payload 里有两样能认人的东西：
 *   - preview：最新一条发言的文本（语音给的是转写文本）；
 *   - unread：伙伴还没被读走的条数（只算 partner 自己的发言）。
 * 认出的依据是时间，不是未读数：
 *   - 预览的时刻比「她最后一次说话」更新 → 这条预览是伙伴发的
 *     （面板里最新的那条，要么是她说的，要么是伙伴说的）；
 *   - 比「我们已经处理过的」更新 → 还没弹过。
 *
 * 为什么不用未读数：未读数是面板里累积的，App 刚装上时她自己的发言
 * 也会带着「未读数 > 0」，照着数就会把她自己的话当伙伴的话弹出去
 * （2026-10-30 实机踩过）。
 */
export class CasualUnreadTracker {
  constructor({ freshMs = CASUAL_UNREAD_FRESH_MS } = {}) {
    this.freshMs = Math.max(5000, Number(freshMs) || CASUAL_UNREAD_FRESH_MS);
    this.agents = new Map();
  }

  _state(key) {
    let state = this.agents.get(key);
    if (!state) {
      state = {
        lastUserAt: 0,     // 她最后一次说话的时刻
        lastHandledAt: 0,  // 已处理的发言里最新的时刻
        fallbackAt: 0,     // 兜底认下的那条的时刻
        fallbackText: "",  // 兼正文，用来认出重复的那条
      };
      this.agents.set(key, state);
    }
    return state;
  }

  /** 记下她说话的时刻：之后的预览比它更新的，才是伙伴说的。 */
  noteUserEntry(key, at) {
    const state = this._state(key);
    const value = Number(at) || 0;
    if (value > state.lastUserAt) state.lastUserAt = value;
  }

  /** 已处理的时刻往前推。 */
  noteHandledAt(key, at) {
    const state = this._state(key);
    const value = Number(at) || 0;
    if (value > state.lastHandledAt) state.lastHandledAt = value;
  }

  /**
   * 登记一条走 casual_entry 到的发言。
   * @returns {{covered:boolean}} covered=true 表示这条兜底已经认过了，别再弹。
   */
  noteAgentEntry(key, at, text) {
    const state = this._state(key);
    const value = Number(at) || 0;
    if (
      value &&
      value === state.fallbackAt &&
      normalizeNoticeText(text) === normalizeNoticeText(state.fallbackText)
    ) {
      return { covered: true };
    }
    this.noteHandledAt(key, value);
    return { covered: false };
  }

  /**
   * 看一眼 casual_unread，认出漏掉的那条发言。
   *
   * @returns {{text:string, occurredAt:string, at:number}|null}
   */
  observeUnread(key, event, now = Date.now()) {
    const state = this._state(key);
    const preview = event?.preview && typeof event.preview === "object" ? event.preview : {};
    const text = String(preview.text || "").trim();
    const at = Date.parse(preview.occurredAt || "") || 0;

    if (!text) return null;
    if (!at) return null;
    // 预览不比她最后一次说话更新 → 这条是她自己的
    // （面板里最新的那条，就是她刚发的那句）。
    if (at <= state.lastUserAt) return null;
    // 预览不比已处理的更新 → 这条已经走 casual_entry 认过了。
    if (at <= state.lastHandledAt) return null;
    // 预览不够新 = 那是面板里积压的旧消息，不该现在弹一遍。
    // 这一道兼管住「App 刚装上就遇到一堆积压」。
    if (now - at > this.freshMs) return null;

    state.fallbackAt = at;
    state.fallbackText = text;
    this.noteHandledAt(key, at);
    return { text, occurredAt: new Date(at).toISOString(), at };
  }

  /** 清掉某个伙伴的状态。 */
  forget(key) {
    this.agents.delete(key);
  }
}

/**
 * 记住宿主发过的本体通知，用来避免同一个提醒弹两遍。
 *
 * 只认宿主桌面通知服务发的那些：带 desktopFocusPolicy、没有会话路径。
 * 别的通知（会话完成通知带 sessionPath、Agent 主动通知没有 desktopFocusPolicy）
 * 都不算，不能拿来当去重依据。
 */
export class HostNoticeMemory {
  constructor({ ttlMs = HOST_NOTICE_TTL_MS, max = 64 } = {}) {
    this.ttlMs = Math.max(500, Number(ttlMs) || HOST_NOTICE_TTL_MS);
    this.max = Math.max(8, Number(max) || 64);
    this.entries = [];
  }

  /** 记一条宿主通知。 */
  note(event, now = Date.now()) {
    if (!event || event.type !== "notification") return false;
    const agentId = String(event.agentId || "").trim();
    if (!agentId) return false;
    if (event.sessionPath) return false;   // 会话完成通知：那是另一条链路
    if (event.activityId) return false;    // 计划任务 / 巡检完成通知：跟闲聊无关
    if (!event.desktopFocusPolicy) return false; // 非桌面通知（Agent 主动通知等）：不拿来当去重依据
    const body = String(event.body || "");
    if (!body.trim()) return false;
    this.entries.push({ agentId, body: normalizeNoticeText(body), at: now });
    this.prune(now);
    return true;
  }

  /**
   * 宿主是不是刚报过同一句话。
   *
   * 宿主对闲聊只报第一气泡的原话，所以我们这边那串 texts 里也有同一句；
   * 认得出的判据是「两者相同」或「宿主那句更长、我们那句是它的开头」。
   * 反方向不算：宿主说「好」、我们说「好呀，等下说」是两句不同的话，
   * 认成同一句就会把该弹的提醒吞掉。
   *
   * @param {boolean} hostShown 宿主那条是否真的弹出来了（前台时宿主会压掉，不算）
   * @param {string|string[]} text 这次要发的正文
   */
  covers(agentId, text, { hostShown = true, now = Date.now() } = {}) {
    if (!hostShown) return false;
    const texts = (Array.isArray(text) ? text : [text])
      .map(normalizeNoticeText)
      .filter((t) => t.length >= NOTICE_MATCH_MIN_LEN);
    if (!texts.length) return false;
    this.prune(now);
    return this.entries.some((entry) => {
      if (entry.agentId !== agentId) return false;
      if (now - entry.at > this.ttlMs) return false;
      if (entry.body.length < NOTICE_MATCH_MIN_LEN) return false;
      return texts.some((body) => body === entry.body || entry.body.startsWith(body));
    });
  }

  prune(now = Date.now()) {
    this.entries = this.entries.filter((entry) => now - entry.at <= this.ttlMs);
    if (this.entries.length > this.max) this.entries = this.entries.slice(-this.max);
  }
}
