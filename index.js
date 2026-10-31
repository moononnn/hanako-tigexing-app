// 提个醒 · App 版入口（核心链路）
//
// 从 legacy 插件迁过来。这一版包含核心链路：
//   订阅总线 → 判断该不该提醒 → 组装文案 → 弹通知
//
// 弹窗走两条腿：先自己拉 PowerShell（保住伙伴头像、专属音效、自定义来源名），
// 脚本未确认提交时退回宿主通知；提交成功仍不保证 Windows 显示横幅。
//
// 还没搬的：子伙伴提醒门的细粒度。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Notifier, isInQuietHours, resolveChatTrigger, makeSnippet } from './lib/policy.js';
import { createConfigManager } from './lib/config.js';
import { deliverToast, ensureRegistration } from './lib/toast.js';
import { toastStatusFilePath } from './lib/toast-status.js';
import {
  parseTurnEnd,
  parseTurnFailure,
  parseSilentTurn,
  parseProviderError,
  parseSessionAbort,
  parseAutoRetryStart,
  parseAutoRetryEnd,
  parseActivityUpdate,
  parseSessionBackgroundTask,
  sessionIdFromPath,
  shouldNotifyCompletedTurn,
  isUserInitiatedAbortReason
} from './lib/event-parse.js';
import { AbnormalTurnTracker } from './lib/abnormal-state.js';
import { buildAbnormalCopy, isRetryCancelled } from './lib/abnormal-copy.js';
import {
  ActivityNotificationTracker,
  AgentNoticeWindow,
  buildActivityNotification,
  resolveActivitySessionPath
} from './lib/activity-notify.js';
import { isHanaFocused } from './lib/window-focus.js';
import { getStyle, sessionPrefix } from './lib/style.js';
import { BackgroundTaskTracker } from './lib/background-tasks.js';
import { DeferredTurns } from './lib/deferred-turns.js';
import { WaitDebtTracker, parseWaitDebt } from './lib/wait-debt.js';
import { resolveAgentAvatar } from './lib/agent-avatar.js';
import { listSounds, resolveSound } from './lib/sounds.js';
import { normalizeSessionPath, parseSessionIdentity, resolveSessionTitleWithRetry } from './lib/session-title.js';
import { codeMarker, createSessionMetaResolver, isCodeSession, pickSoundId, pickStyleId } from './lib/session-kind.js';
import { createRefineModelConfig } from './lib/refine-model.js';
import { buildNotificationCopy, buildCasualCopy } from './lib/notification-copy.js';
import { clipCodePoints } from './lib/text-clip.js';
import { createFocusNotificationHandler, FOCUS_NOTIFY_SERVICE } from './lib/focus-notify.js';
import { appendDebugLog, isDebugNoisyEvent } from './lib/debug-log.js';
import { SessionParticipation } from './lib/session-participation.js';
import {
  parseCasualEntry,
  isAgentCasualMessage,
  casualEntryText,
  CasualTurnTracker,
  decideCasualNotify,
  HostNoticeMemory,
  CasualUnreadTracker,
  CASUAL_MARKER,
  CASUAL_SETTLE_MS
} from './lib/casual-notify.js';

export const name = 'tigexing-app';

const APP_ID = 'tigexing-app';
const ACTIVITY_NOTIFICATION_GRACE_MS = 1500;
// 后台任务收齐后不立即补发，先静置这么久：收齐几乎总是「要接着干」的前一秒
// （实测：收齐到新回合开工只隔 95 毫秒），立刻弹就是提前报完成。
// 这段时间里窗口又开工，就说明那不是收尾，补发作废——伙伴接下来自己会产出真结论。
const DEFERRED_FLUSH_GRACE_MS = 5000;
// 安装目录从模块自身位置推：入口就在应用根，lib/notify.ps1 在它下面。
const INSTALL_DIR = path.dirname(fileURLToPath(import.meta.url));
// 找不到伙伴头像时的兜底脸（notify.ps1 里也有一份同样的兜底）
const APP_ICON = path.join(INSTALL_DIR, 'assets', 'icon.png');

// 通知落地的依赖注入点。生产环境留空 = 直接 spawn PowerShell；
// 端到端测试注入假 spawn，避免单测真的弹系统通知。
export const toastDependencies = {
  dependencies: undefined,
  // 注入一个自定义 tracker（自定义 TTL）用于测兜底路径；为空即默认 10 分钟。
  backgroundTasks: null,
  // 同上：注入自定义「叫醒欠账」tracker（自定义 TTL）用于测它的兵底路径。
  waitDebt: null,
  // 补发静默期（毫秒）。null/未设=默认；测试可注入短值。
  deferredFlushGraceMs: null,
  // 闲聊一轮气泡的结算窗口（毫秒）。null/未设=默认；测试可注入短值。
  casualSettleMs: null,
  // 暂缓通知的回看间隔（毫秒）。null/未设=默认 15 秒；测试可注入短值。
  heldRetryMs: null,
  // 暂缓通知最多等几次；等超了带实情照样发，绝不丢。
  heldMaxTries: null,
};

/**
 * HANA_HOME 在 App 里取不到环境变量。优先用宿主提供的 dataDir 回推，
 * 安装目录作为没有 dataDir 时的兜底；这里只拼资源路径，盘外读取必须走 ResourceIO。
 */
export function resolveHanaHome(dataDir, installDir = INSTALL_DIR) {
  if (process.env.HANA_HOME) return path.resolve(process.env.HANA_HOME);
  if (dataDir) return path.resolve(dataDir, '..', '..');
  return path.resolve(installDir, '..', '..');
}

export async function apply(ctx) {
  if (!ctx?.dataDir) throw new Error('提个醒需要宿主提供应用数据目录');

  // 把注入的依赖快照进本次实例的局部变量。
  // 原来直接读模块级 toastDependencies：测试并行跑时，一个文件把依赖置空，
  // 另一个文件正在跑就跟着失灵（表现为通知莫名不弹）。
  const deps = { ...toastDependencies };

  const dataDir = ctx.dataDir;
  const log = ctx.logger;
  const dbg = (line) => appendDebugLog(dataDir, line);

  // 伙伴头像的资源路径从 HANA_HOME 推算，盘外读取走 ResourceIO。
  const hanaHome = resolveHanaHome(dataDir);
  const agentsHome = path.join(hanaHome, 'agents');

  dbg('应用版启动，dataDir=' + dataDir);
  dbg('HANA_HOME 推算为 ' + hanaHome);

  // ── 伙伴显示名 ──
  // 应用读不到 Hana 的目录，走总线请求；漏 scope 会静默返空，必须带。
  let agentNames = {};
  let agentRoster = [];
  async function readAgentRoster() {
    const res = await ctx.bus.request('agent:list', { scope: 'all' }, { timeout: 5000 });
    const rows = Array.isArray(res?.agents) ? res.agents.filter((row) => row && typeof row.id === 'string' && row.id.trim()) : [];
    agentRoster = rows;
    const map = {};
    for (const row of rows) map[row.id] = row.name || row.id;
    if (Object.keys(map).length) agentNames = map;
    return rows;
  }
  async function refreshAgents() {
    try {
      return await readAgentRoster();
    } catch (error) {
      dbg('伙伴名单拉取失败：' + (error?.message || error));
      return null;
    }
  }
  const agentName = (id) => agentNames[id] || id;

  /**
   * 取伙伴显示名，拿不到名单时先把名单补上再取。
   *
   * 闲聊消息可能在名单拉回来之前就到（应用装载后才预热名单）：
   * 那时直接取名字只会拿到原始 id（标题里出现「hanako」而不是「小花」）。
   * 这里等一次名单，读完还是拿不到才退回 id。
   */
  async function agentNameFor(id) {
    const known = agentNames[id];
    if (known) return known;
    await refreshAgents();
    return agentNames[id] || id;
  }

  // ── 运行时状态 ──
  const timers = new Map();
  const participation = new SessionParticipation({
    dataDir,
    onError: (error) => dbg('参与记录保存/恢复失败：' + (error?.message || error))
  });
  dbg(`真实用户参与记录恢复 count=${participation.sessions.size}`);
  const backgroundTasks = deps.backgroundTasks || new BackgroundTaskTracker();
  const deferredTurns = new DeferredTurns();
  // 「叫醒还欠着」单独记账与暂存：它和后台任务的收齐时机完全不同，混用会互相误取。
  const waitDebt = deps.waitDebt || new WaitDebtTracker();
  // 待补发的回合：会话 id -> { timer, info }。静默期内开工则取消并丢弃。
  const pendingFlushes = new Map();

  // 每个会话最近一次开工 / 收工的时间戳。开工晚于收工 = 现在正忙着。
  // 判定「说完了」到真正发出去之间隔着分区查询、文案润色、头像与音效读取，
  // 慢的时候能拖一分钟；这期间窗口又开工了，那条「回你啦」就不该现在弹
  // （2026-10-26 实机：判定后 61 秒才发出，窗口早进了下一轮）。
  // 不用「判定之后有没有开过工」：那样一旦开过工就永远判忙，缓下的通知再也发不出去。
  const turnStarts = new Map();
  const turnEnds = new Map();
  // 每个会话最新一次「完成回合」的序号。
  // 用来判暂缓的那条是不是已经被更新的回响顶掉了：
  // 补发要走会话查询和文案润色，慢的时候这中间会来新回响，
  // 光看「暂存表里还有没有」不够——新回响要等它自己走到发送那一步才会来清表。
  const turnSeqBySession = new Map();
  let turnSeq = 0;

  /** 记下这个会话完成了一轮，返回这轮的序号 */
  function noteTurnEnd(sessionId) {
    const seq = ++turnSeq;
    if (sessionId) turnSeqBySession.set(sessionId, seq);
    return seq;
  }
  /** 这个会话现在是不是还忙着；返回原因，空串表示闲着 */
  function sessionBusyReason(sessionId) {
    const start = turnStarts.get(sessionId) || 0;
    const end = turnEnds.get(sessionId) || 0;
    dbg(`忙闲判定 session=${sessionId} start=${start} end=${end}`);
    if (start > end) return '窗口又开工';
    if (backgroundTasks.has(sessionId)) return '后台任务又开始';
    if (waitDebt.has(sessionId)) return '又在等后台结果';
    return '';
  }

  // 暂缓发出的通知。判定过时不能丢——每个回合都得有回响；
  // 成品（标题/正文/头像/音效）先缓在这里，等会话真正安静了再发。
  // 真等太久还是忙，就带上「等太久了」的实情照样发，绝不一声不响。
  const heldToasts = new Map();
  const HELD_RETRY_MS = 15000;
  const HELD_MAX_TRIES = 20; // 15 秒 × 20 约 5 分钟
  const HELD_OVERDUE_NOTICE = '等太久了，先叫你一声';
  // 测试可以注入更短的回看间隔与更少的尝试次数，不必真等五分钟。
  const heldRetryMs = Number(deps.heldRetryMs) > 0
    ? Number(deps.heldRetryMs)
    : HELD_RETRY_MS;
  const heldMaxTries = Number(deps.heldMaxTries) > 0
    ? Number(deps.heldMaxTries)
    : HELD_MAX_TRIES;

  function holdStaleToast({ sessionId, payload, reason, kind, turnSeq }) {
    const previous = heldToasts.get(sessionId);
    if (previous?.timer) clearTimeout(previous.timer);
    if (previous) dbg(`暂缓的通知被后一条接替 session=${sessionId}`);
    const hold = { sessionId, payload, reason, kind, tries: 0, timer: null, turnSeq: turnSeq ?? 0 };
    heldToasts.set(sessionId, hold);
    dbg(`通知暂缓（${reason}），等窗口静下来再补 session=${sessionId} kind=${kind}`);
    scheduleHeldRetry(sessionId);
    return hold;
  }

  function scheduleHeldRetry(sessionId) {
    const hold = heldToasts.get(sessionId);
    if (!hold || hold.timer) return;
    hold.timer = setTimeout(() => {
      hold.timer = null;
      void releaseHeldToast(sessionId);
    }, heldRetryMs);
    hold.timer.unref?.();
  }

  function dropHeldToast(sessionId, reason) {
    const hold = heldToasts.get(sessionId);
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    heldToasts.delete(sessionId);
    dbg(`丢弃暂缓通知（${reason}）session=${sessionId}`);
  }

  /** 到点回看：还忙着就继续等；静了、或等超了，就把手里这条发出去 */
  async function releaseHeldToast(sessionId) {
    const hold = heldToasts.get(sessionId);
    if (!hold) return;
    hold.tries += 1;
    const stale = sessionBusyReason(sessionId);
    if (stale && hold.tries < heldMaxTries) {
      scheduleHeldRetry(sessionId);
      return;
    }
    // 等超了还没静：照样发，但把实情摆在正文末尾，不冒充「刚刚说完」。
    const overdue = Boolean(stale);
    const payload = overdue
      ? { ...hold.payload, body: withOverdueNotice(hold.payload.body) }
      : hold.payload;
    try {
      // 发送前再确认一次：这轮是不是已经被更新的回响顶掉了。
      // 之前只查「暂存表里还有没有」，但新回响要等它自己走到发送那一步才会来清表，
      // 那之前旧条目就补发出去了 —— 结果两条都弹，
      // 而且先弹的是上一轮的话（「中间汇报」），把「这才是结论」挤掉。
      // 现在用完成回合的序号来判：序号比暂缓时新，说明有新回响，旧的让位。
      const current = heldToasts.get(sessionId);
      const latestSeq = turnSeqBySession.get(sessionId) || 0;
      if (!current || current !== hold || (hold.turnSeq && latestSeq > hold.turnSeq)) {
        dbg(`暂缓通知已被新回响接替，不再补发 session=${sessionId} tries=${hold.tries}`);
        if (current === hold) heldToasts.delete(sessionId);
        return;
      }
      heldToasts.delete(sessionId);
      const via = await notify(payload);
      dbg(`暂缓通知补发 session=${sessionId} tries=${hold.tries} overdue=${overdue} via=${via} title=${payload.title}`);
    } catch (error) {
      heldToasts.delete(sessionId);
      dbg('暂缓通知补发失败：' + (error?.message || error));
    }
  }

  /** 正文只剩 24 字的款，备注插在末尾，正文相应让字数 */
  function withOverdueNotice(body) {
    const room = Math.max(10, 24 - HELD_OVERDUE_NOTICE.length);
    return `${clipCodePoints(body, room)} ${HELD_OVERDUE_NOTICE}`;
  }
  const flushGraceMs = Number(deps.deferredFlushGraceMs) > 0
    ? Number(deps.deferredFlushGraceMs)
    : DEFERRED_FLUSH_GRACE_MS;

  // 只管定时器，不碰暂存：暂存的归属在 turn_start / 会话关闭那里统一处理。
  function cancelPendingFlush(sessionId, reason) {
    const sid = String(sessionId || '').trim();
    const pending = pendingFlushes.get(sid);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingFlushes.delete(sid);
    dbg(`补发取消（${reason}）session=${sid}`);
    return true;
  }

  function scheduleDeferredFlush(info, sessionId) {
    const sid = String(sessionId || '').trim();
    cancelPendingFlush(sid, '重新排期');
    const timer = setTimeout(() => {
      // 异常不能变成游离的未处理 Promise：旧代码这行在总线回调的 try/catch 里，
      // 搬进 setTimeout 后没人接，通知失败会静默无痕。
      void handleTurnEnd(info, { deferred: true }).catch((error) => {
        dbg('补发异常：' + (error?.stack || error?.message || error));
        log?.error?.('[提个醒] 补发异常', { error: error?.message || error });
      }).finally(() => {
        pendingFlushes.delete(sid);
      });
    }, flushGraceMs);
    timer.unref?.();
    pendingFlushes.set(sid, { timer, info });
    dbg(`后台任务收齐，${flushGraceMs}ms 静默期后再补发 session=${sid}`);
  }
  const activityNotifications = new ActivityNotificationTracker();
  // 任务自己刚弹过的提醒：同一伙伴在这个窗口内已经发过一条，完成通知就不补了。
  const agentNoticeWindow = new AgentNoticeWindow();
  const sessionIdsByPath = new Map();
  const sessionTitlesByPath = new Map();

  function rememberSession(session) {
    const key = normalizeSessionPath(session?.path || session?.sessionPath);
    if (!key) return;
    const sessionId = String(session?.sessionId || '').trim();
    const title = typeof session?.title === 'string' ? session.title.trim() : '';
    if (sessionId) sessionIdsByPath.set(key, sessionId);
    if (title) sessionTitlesByPath.set(key, title);
  }

  async function refreshSessionTitleIndex() {
    try {
      const result = await ctx.bus.request(
        'session:list',
        { scope: 'all', lifecycle: 'active' },
        { timeout: 10000 }
      );
      for (const session of result?.sessions || []) rememberSession(session);
      dbg(`活跃会话标题索引预热完成 count=${sessionTitlesByPath.size}`);
    } catch (error) {
      dbg('活跃会话标题索引预热失败：' + (error?.message || error));
    }
  }

  // ── 配置 ──
  const config = createConfigManager({ dataDir, pluginId: APP_ID, log });
  // 分区判断：Code 页窗口的会话不在 session:list 里，只能按 id / 路径单查。
  const resolveSessionMeta = createSessionMetaResolver({ bus: ctx.bus, debug: dbg });
  const refineModelConfig = createRefineModelConfig({ ctx, dataDir });
  const notifier = new Notifier(config.get());
  // 最近一次投递结果落在这里，设置页据此提示「现在是本体代发的」并给出修法。
  const toastStatusFile = toastStatusFilePath(dataDir);

  // ── 弹窗：两条腿 ──
  async function deliverNotification({ title, body, icon, sound, duration, style }) {
    return deliverToast({
      pluginDir: INSTALL_DIR, title, message: body, style, icon, sound, duration, log,
      statusFile: toastStatusFile
    }, (input) => ctx.notifications.show(input), { ...deps.dependencies, debug: dbg });
  }
  async function notify(options) {
    return (await deliverNotification(options)).via;
  }

  async function listFocusSoundFiles(customDir) {
    if (!customDir) return listSounds(dataDir, '');
    const result = await ctx.resources.list({ kind: 'local-file', path: customDir });
    const entries = Array.isArray(result)
      ? result
      : result?.entries || result?.items || result?.children || result?.files || [];
    if (!Array.isArray(entries)) return [];
    const allowed = new Set(['.wav', '.mp3', '.m4a', '.aac']);
    return entries
      .map((entry) => typeof entry === 'string' ? entry : entry?.name || entry?.path || entry?.fileName || '')
      .map((name) => path.basename(String(name)))
      .filter((name) => allowed.has(path.extname(name).toLowerCase()))
      .sort();
  }

  async function focusNotificationPlanHelpers({ agentId, cfg }) {
    const requestedSound = agentId ? (cfg.agentSounds || {})[agentId] || 'default' : 'default';
    let approvedCustomSound = null;
    if (cfg.soundDir && requestedSound !== 'default' && requestedSound !== 'silent') {
      try {
        const files = await listFocusSoundFiles(cfg.soundDir);
        if (files.includes(requestedSound)) {
          const candidate = resolveSound(dataDir, requestedSound, cfg.soundDir, { allowExternal: true });
          const stat = candidate ? await ctx.resources.stat({ kind: 'local-file', path: candidate }) : null;
          if (stat?.exists && !stat.isDirectory) approvedCustomSound = candidate;
        }
      } catch (error) {
        dbg('专注提醒音效未能读取：' + (error?.message || error));
      }
    }
    return {
      resolveSoundFile: (file) => cfg.soundDir
        ? (file === requestedSound ? approvedCustomSound : null)
        : resolveSound(dataDir, file, ''),
      resolveAgentAvatar: () => null,
    };
  }

  function registerFocusNotificationService() {
    if (typeof ctx.bus?.handle !== 'function') {
      dbg('专注通知服务未注册：宿主没有 bus.handle');
      return;
    }
    try {
      const handler = createFocusNotificationHandler({
        getConfig: () => config.get(),
        getAgents: readAgentRoster,
        getCachedAgents: () => agentRoster,
        getPlanHelpers: focusNotificationPlanHelpers,
        resolveAvatar: (agentId) => resolveAgentAvatar(agentsHome, agentId, { resources: ctx.resources }),
        deliver: (toast) => deliverNotification({
          title: toast.title, body: toast.message, icon: toast.icon,
          sound: toast.sound, duration: toast.duration, style: toast.style,
        }),
        log,
      });
      ctx.bus.handle(FOCUS_NOTIFY_SERVICE, async (payload, caller) => {
        const result = await handler(payload, caller);
        if (result.suppressed) dbg(`拾光记专注通知按设置拦下 reason=${result.reason}`);
        else dbg(`拾光记专注通知提交 sent=${result.sent} via=${result.via || 'none'} style=${result.styleId || 'default'}`);
        return result;
      }, { allowCrossApp: true });
      dbg('拾光记专注通知服务已注册');
    } catch (error) {
      log?.warn?.('[提个醒] 拾光记专注通知服务未注册', { code: String(error?.code || 'unknown').slice(0, 64) });
    }
  }
  registerFocusNotificationService();


  // ── 组装并弹一条 ──
  async function doToast(decision, toastStyle, copyOverride) {
    const cfg = config.get();
    // 先弄清这条提醒是普通窗口还是 Code 页窗口：它同时决定标题记号、文案风格和音效。
    // 查不到就按普通窗口走，绝不让一次查询失败拖住或丢掉提醒。
    const sessionMeta = await resolveSessionMeta({
      sessionId: decision.sessionId,
      sessionPath: decision.sessionPath
    });
    const sessionNamespace = sessionMeta.namespace;
    const inCode = isCodeSession(sessionNamespace);
    const styleId = pickStyleId({
      inCode,
      agentId: decision.agentId,
      codeStyles: cfg.agentCodeStyles,
      styles: cfg.agentStyles
    });
    const style = getStyle(styleId);

    // 跟旧版一致：先生成通知正文，再读取会话标题，给宿主异步起名留时间。
    const copy = copyOverride || await buildNotificationCopy({
      enabled: cfg.refineEnabled,
      modelConfig: refineModelConfig,
      style,
      kind: decision.kind,
      agentName: decision.agentName,
      snippet: decision.snippet,
      refineText: decision.refineText,
      notice: decision.notice,
      count: decision.count
    });
    const sessionKey = normalizeSessionPath(decision.sessionPath);
    let sessionTitle = sessionTitlesByPath.get(sessionKey) || sessionMeta.title || await resolveSessionTitleWithRetry({
      bus: ctx.bus,
      sessionPath: decision.sessionPath,
      sessionId: sessionIdsByPath.get(sessionKey),
      agentId: decision.agentId,
      onResolved: rememberSession,
      onError: (error) => dbg('会话标题查询失败：' + (error?.message || error))
    });
    // 查询期间可能收到自动起名/手动改名事件，不丢掉刚到的真实标题。
    sessionTitle = sessionTitlesByPath.get(sessionKey) || sessionTitle;
    // Code 窗口的记号紧贴标题最前面，比会话标题更能一眼认出「这是代码窗口那边收工了」。
    const title = codeMarker(sessionNamespace) + sessionPrefix(sessionTitle) + copy.title;
    const body = copy.body;
    if (copy.refineError) {
      dbg('文案润色失败，回退规则版：' + (copy.refineError?.message || copy.refineError));
    }
    // 记录实际交付正文与来源，不能只凭 JSON 可解析就宣布效果成功。
    const refineConfig = refineModelConfig.getConfig();
    dbg('通知文案 ' + JSON.stringify({
      style: styleId, refined: copy.refined, sessionTitle: sessionTitle || null,
      namespace: sessionNamespace || null, inCode,
      inputChars: (decision.refineText || decision.snippet || '').length,
      snippet: decision.snippet, body,
      source: copy.refined ? (refineConfig.modelSource || 'agent') : 'rule',
      provider: copy.refined ? refineConfig.hanaModel?.providerId : undefined,
      model: copy.refined ? refineConfig.hanaModel?.modelId : undefined
    }));

    // ResourceIO 只列出获准的头像文件名；Toast 子进程读取返回路径，失败时退应用图标。
    let avatar = APP_ICON;
    try {
      avatar = await resolveAgentAvatar(agentsHome, decision.agentId, {
        resources: ctx.resources
      }) || APP_ICON;
    } catch (error) {
      dbg('伙伴头像读取失败：' + (error?.message || error));
    }

    const soundCfg = pickSoundId({
      inCode,
      agentId: decision.agentId,
      codeSounds: cfg.agentCodeSounds,
      sounds: cfg.agentSounds
    });
    let sound;
    if (soundCfg === 'silent') sound = 'silent';
    else if (soundCfg && soundCfg !== 'default') {
      sound = resolveSound(dataDir, soundCfg, cfg.soundDir, { allowExternal: !!cfg.soundDir }) || undefined;
      if (sound && cfg.soundDir) {
        try {
          const stat = await ctx.resources.stat({ kind: 'local-file', path: sound });
          if (!stat?.exists || stat.isDirectory) sound = undefined;
        } catch (error) {
          dbg('自定义音效读取未获授权或文件不可用：' + (error?.message || error));
          sound = undefined;
        }
      }
    }

    // 从判定到这里，中间走完了分区查询、润色、标题、头像、音效。
    // 这段时间里会话要是又开工，这条提醒就不能现在发——但也不能丢：
    // 每个回合都得有回响，先扣在手里，等窗口真正静下来再补。
    const stale = sessionBusyReason(decision.sessionId);
    const payload = {
      title,
      body,
      icon: avatar || undefined,
      sound,
      duration: cfg.toastDuration,
      style: toastStyle === 'plain' ? 'plain' : 'icon'
    };
    if (stale) {
      holdStaleToast({
        sessionId: decision.sessionId,
        payload,
        reason: stale,
        kind: decision.kind,
        turnSeq: decision.turnSeq
      });
      return;
    }

    // 这一条成了新的回响，手里扣的旧消息就不再单独特发，免得两条撞在一起。
    dropHeldToast(decision.sessionId, '有更新的回响了');
    const via = await notify(payload);
    // 两条腿都失败时 via 是 failed：这时要说清没弹出来，
    // 不能只记一行「提交结果」让人以为提醒到了。
    if (via === 'failed') {
      dbg(`通知提交失败（两条腿都没成）session=${decision.sessionId} kind=${decision.kind} title=${title}`);
      log?.error?.('[提个醒] 通知未送达', { sessionId: decision.sessionId, kind: decision.kind, title });
    } else {
      dbg(`通知提交结果 session=${decision.sessionId} kind=${decision.kind} via=${via} title=${title}`);
    }
  }

  async function handleAbnormalAlert(alert) {
    const sessionId = String(alert?.sessionId || '').trim();
    if (!sessionId || !participation.has(sessionId)) {
      dbg(`异常提醒跳过：未确认真实用户参与 session=${sessionId || 'unknown'}`);
      return;
    }

    const cfg = config.get();
    if (!cfg.enabled || !cfg.abnormalEnabled) {
      dbg(`异常提醒跳过 enabled=${cfg.enabled} abnormalEnabled=${cfg.abnormalEnabled}`);
      return;
    }
    if (isInQuietHours(cfg)) {
      dbg(`异常提醒跳过：静默时段 session=${sessionId}`);
      return;
    }
    // 空返回的判定会先等一段宽限期；要是这期间后台任务或叫醒又欠上了，
    // 说明后面还有真回合要说，这条提醒就过时了，不能弹。
    if (alert?.silent === true && (backgroundTasks.has(sessionId) || waitDebt.has(sessionId))) {
      dbg(`空返回提醒已过时（后台任务/叫醒未结） session=${sessionId}`);
      return;
    }

    const reason = [alert.errorMessage, alert.finalError, alert.reason]
      .map((value) => String(value || '').trim())
      .find((value) => value && !/^(?:unknown error|\[object object\])$/i.test(value)) || '';
    const name = agentName(alert.agentId);
    const copy = buildAbnormalCopy({
      agentName: name,
      partialText: alert.text,
      errorMessage: reason,
      // 空返回不是错误，不能套「模型返回：xxx」那套文案。
      // 但有真错误原文时以错误为准，别用一个笼统的「没出声」盖掉具体原因。
      silent: alert.silent === true && !reason
    });
    dbg(`异常提醒候选 session=${sessionId} source=${alert.source || 'unknown'} reason=${copy.body}`);
    await doToast({
      sessionId,
      agentId: alert.agentId || 'unknown',
      agentName: name,
      sessionPath: alert.sessionPath || '',
      snippet: alert.text || '',
      refineText: alert.text || '',
      kind: 'failure'
    }, cfg.toastStyle, copy);
  }

  const abnormalTurns = new AbnormalTurnTracker({
    onAlert: (alert) => {
      void handleAbnormalAlert(alert).catch((error) => {
        dbg(`异常提醒处理失败：${error?.stack || error?.message || error}`);
        log?.error?.('[提个醒] 异常提醒处理失败', { error: error?.message || error });
      });
    }
  });

  async function handleActivityUpdate(activity) {
    try {
      let cfg = config.get();
      const triggerKey = activity.kind === 'scheduled' ? 'scheduledTrigger' : 'patrolTrigger';
      let trigger = cfg[triggerKey] || 'whenUnfocused';
      if (!cfg.enabled || trigger === 'never') {
        dbg(`活动提醒拦截 ${triggerKey}=${trigger} enabled=${cfg.enabled}`);
        return;
      }
      if (activity.kind === 'scheduled' && !cfg.scheduledTakeover) {
        dbg('活动提醒拦截 计划任务接管已关闭');
        return;
      }

      const activitySessionPath = resolveActivitySessionPath(
        agentsHome,
        activity.agentId,
        activity.sessionFile
      );
      // 原版完成通知可能紧跟 activity_update 到达；留出短暂窗口，让去重记录先落下。
      if (activitySessionPath) {
        await new Promise((resolve) => setTimeout(resolve, ACTIVITY_NOTIFICATION_GRACE_MS));
        cfg = config.get();
        trigger = cfg[triggerKey] || 'whenUnfocused';
        if (!cfg.enabled || trigger === 'never' || (activity.kind === 'scheduled' && !cfg.scheduledTakeover)) {
          dbg(`活动提醒等待后拦截 ${triggerKey}=${trigger} enabled=${cfg.enabled}`);
          return;
        }
        if (activityNotifications.has(activitySessionPath)) {
          dbg(`活动提醒去重 原版通知已到达 kind=${activity.kind} sessionFile=${activity.sessionFile || '无'}`);
          return;
        }
      }

      // 任务本轮已经自己弹过提醒了，就不要再补一条「完成」。
      // 用户看到的重复就是这种情况：内容提醒 + 完成提醒，两句话在说同一件事。
      if (agentNoticeWindow.active(activity.agentId)) {
        dbg(`活动提醒跳过：任务本轮已发过通知 kind=${activity.kind} agent=${activity.agentId}`);
        return;
      }

      if (trigger === 'whenUnfocused' && await isHanaFocused()) {
        dbg(`活动提醒拦截 Hana 在前台 kind=${activity.kind}`);
        return;
      }
      if (isInQuietHours(cfg)) {
        dbg(`活动提醒拦截 静默时段 kind=${activity.kind}`);
        return;
      }

      const displayName = activity.agentName === activity.agentId
        ? agentName(activity.agentId)
        : activity.agentName;
      const { title, body } = buildActivityNotification({ ...activity, agentName: displayName });

      let avatar = APP_ICON;
      try {
        avatar = await resolveAgentAvatar(agentsHome, activity.agentId, {
          resources: ctx.resources
        }) || APP_ICON;
      } catch (error) {
        dbg('活动提醒伙伴头像读取失败：' + (error?.message || error));
      }

      const soundCfg = (cfg.agentSounds || {})[activity.agentId] || 'default';
      let sound;
      if (soundCfg === 'silent') sound = 'silent';
      else if (soundCfg && soundCfg !== 'default') {
        sound = resolveSound(dataDir, soundCfg, cfg.soundDir, { allowExternal: !!cfg.soundDir }) || undefined;
        if (sound && cfg.soundDir) {
          try {
            const stat = await ctx.resources.stat({ kind: 'local-file', path: sound });
            if (!stat?.exists || stat.isDirectory) sound = undefined;
          } catch (error) {
            dbg('活动提醒音效读取未获授权或文件不可用：' + (error?.message || error));
            sound = undefined;
          }
        }
      }

      const via = await notify({
        title,
        body,
        icon: avatar || undefined,
        sound,
        duration: cfg.toastDuration,
        style: 'icon'
      });
      dbg(`活动提醒提交结果 kind=${activity.kind} status=${activity.status} agent=${activity.agentId} via=${via} title=${title}`);
    } catch (error) {
      dbg(`活动提醒异常：${error?.stack || error?.message || error}`);
      log?.error?.('[提个醒] 活动提醒异常', { error: error?.message || error });
    }
  }

  function clearSessionTimer(sessionId) {
    const t = timers.get(sessionId);
    if (t) {
      clearTimeout(t);
      timers.delete(sessionId);
    }
  }

  // 合并窗口结束：把期间攒下的条数补弹一条
  function scheduleFlush(sessionId, windowMs) {
    clearSessionTimer(sessionId);
    const t = setTimeout(async () => {
      timers.delete(sessionId);
      const result = notifier.flush(sessionId);
      if (result) {
        try {
          await doToast(result, config.get().toastStyle);
        } catch { /* 兜底：合并补弹失败不影响主流程 */ }
      }
    }, windowMs);
    timers.set(sessionId, t);
  }

  // ── 回合完成 ──
  async function handleTurnEnd(info, options = {}) {
    // 用户打断后重发（常见于改错字）不算完成回复
    if (info.aborted) {
      dbg('中断回合跳过普通提醒，reason=' + (info.reason || '未知'));
      return;
    }
    // 只认最终回合：工具循环里的中间回合不提醒
    if (!shouldNotifyCompletedTurn(info)) {
      dbg(`非最终回合跳过 stopReason=${info.stopReason}`);
      return;
    }
    // 宿主偶尔会发出 stop 但没有任何可见正文的 turn_end；makeSnippet 会把空串补成「空回复」，
    // 这会把内部空回合误报成伙伴已经正常回复。没有用户可见正文就静默，不影响异常提醒状态清理。
    if (typeof info.text !== 'string' || !info.text.trim()) {
      dbg(`空内容的结束回合不发普通提醒 session=${info.sessionId}`);
      return;
    }

    const now = Date.now();
    const { sessionId } = info;

    // 只提醒用户真实参与的会话：后台调度（漂流瓶、小生活日常）也会产生 turn_end，
    // 那些会话从没有过用户消息，弹了是打扰。
    if (!participation.has(sessionId)) {
      dbg(`未确认真实用户参与，跳过提醒 session=${sessionId}`);
      return;
    }
    // 对话框还有后台任务在跑：先压住，等它们收齐再补发，避免中间过程弹窗。
    // 兜底挂在 turn_end 上是足够的：唯一需要放行的时刻就是完成回合到来时，没有回合就没有提醒需求。
    const expired = backgroundTasks.prune(sessionId, now);
    let releasedByTimeout = false;
    let debtTimedOut = false;
    if (expired.length) {
      releasedByTimeout = true;
      dbg(`后台任务超时兜底释放 session=${sessionId} task=${expired.join(',')}`);
      // 本回合自己就要弹，补发被压住的那条会变成重复；清掉就行，别让它堆在内存里。
      if (deferredTurns.has(sessionId)) {
        deferredTurns.take(sessionId, now);
        dbg(`超时释放后不再补发同会话旧回合（当前回合已弹）session=${sessionId}`);
      }
    }
    if (backgroundTasks.has(sessionId)) {
      if (!options.deferred) deferredTurns.stash(sessionId, info, now);
      dbg(`对话框仍有后台任务，暂不提醒 session=${sessionId} remaining=${backgroundTasks.count(sessionId)}`);
      return;
    }

    // 叫醒还欠着这个会话：后台任务已经收工，但宿主扣着的结果还没投进来。
    // 这种「回合结束」只是过程句，绝不能当成说完（2026-10-13 实机取证）。
    // 压住就行、不补发：真叫醒落地后一定会起新回合，那时 partner 已经说过真正的话了。
    const expiredDebt = waitDebt.prune(sessionId, now);
    if (expiredDebt.length) {
      debtTimedOut = true;
      dbg(`叫醒超时兜底释放 session=${sessionId} wait=${expiredDebt.join(',')}`);
    }
    if (waitDebt.has(sessionId)) {
      dbg(`等待结果还没投递，本回合不是收尾，暂不提醒 session=${sessionId} remaining=${waitDebt.count(sessionId)}`);
      return;
    }

    await notifyTurnEnd(info, sessionId, now, releasedByTimeout || debtTimedOut);
  }

  // ── 完成提醒本体（前置检查之外的全部逻辑） ──
  async function notifyTurnEnd(info, sessionId, now, releasedByTimeout = false) {
    const { agentId, text } = info;
    const cfg = config.get();
    // 刷新配置但保留 Notifier 里的合并窗口状态，否则每轮都会把窗口清空
    notifier.config = cfg;
    // 这一轮完成的序号：暂缓的通知靠它判断自己是不是被更新的回响顶掉了。
    const turnSeqOfThisRound = noteTurnEnd(sessionId);

    const chatTrigger = resolveChatTrigger(cfg, agentId);
    if (!cfg.enabled || chatTrigger === 'never') {
      dbg(`档位拦截 enabled=${cfg.enabled} chatTrigger=${chatTrigger}`);
      return;
    }
    if (chatTrigger === 'whenUnfocused') {
      if (await isHanaFocused()) {
        dbg('Hana 在前台，不打扰');
        return;
      }
    } else if (chatTrigger === 'whenSessionUnfocused') {
      // 页面 sessions.getActive() 是选中状态，不是后台可用的实时可见焦点。
      // 无可靠证据就不要压掉提醒；不能用用户消息时间猜正在看。
      dbg(`无法确认当前聊天是否正在看，保守提醒 session=${sessionId}`);
    }

    // 判定基准已经从「时刻对比」改成「现在忙不忙」（见 sessionBusyReason）：
    // 用时刻比的话，开工过一次就永远判忙，缓下的通知再也发不出去。
    const decision = notifier.decide(
      {
        sessionId,
        agentId,
        agentName: agentName(agentId),
        text,
        sessionPath: info.sessionPath,
        // 兵底放行的回合不一定是最终结果（后台任务可能还在跑，也可能没收到它的完成通知）。
        // 只说自己的处境，不猜事实：提个醒能确定的只有「本来在等、等超时了」，
        // 那活儿是真在跑还是早干完了它无从得知，一个字都不替它断言。
        // 也不加括号，免得被当成伙伴自己的口头禅。排在正文末尾，正文让字数（见 notification-copy）。
        notice: releasedByTimeout ? '等太久了，先叫你一声' : ''
      },
      now
    );

    if (decision.action === 'skip') return;                 // 静默时段
    if (decision.action === 'merge') {
      scheduleFlush(sessionId, cfg.mergeWindowMs ?? 30000);
      return;
    }

    // 把这一轮的序号带上：暂缓的通知靠它判断自己是不是被更新的回响顶掉了。
    decision.turnSeq = turnSeqOfThisRound;
    await doToast(decision, cfg.toastStyle);
    // 用 ?? 而不是 ||：0 是合法配置（不合并），|| 会把它当成假值兜回 30 秒。
    if (decision.kind === 'first') scheduleFlush(sessionId, cfg.mergeWindowMs ?? 30000);
  }

  // ── 闲聊（casual chat）提醒 ──
  // 闲聊不走主会话的 turn_end：它的会话 namespace 是 casual，宿主自己就跳过了
  // 「聊天回复完成」通知，伙伴在闲聊里是用 chat_say 工具发言的。
  // 真正带着内容的是 casual_entry 事件，这里接它。
  const casualTurns = new CasualTurnTracker();
  const hostNotices = new HostNoticeMemory();
  // 语音回复在宿主那边不投 casual_entry，只发 casual_unread。
  // 这里把它认出来，否则语音的发言就完全收不到。
  const casualUnread = new CasualUnreadTracker();
  // 一个伙伴一轮里的多条气泡先攒着，攒齐了再发一条提醒。
  const casualPending = new Map();
  // 闲聊这一轮的窗口：同时管「相邻气泡算不算同一轮」和「攒多久才发」。
  // 两个是同一个数——分成两个会出事：结算窗口比同轮间隔短，一句话就被拆成好几条弹窗。
  const casualWindowMs = Number(deps.casualSettleMs) > 0
    ? Number(deps.casualSettleMs)
    : CASUAL_SETTLE_MS;
  casualTurns.setWindow(casualWindowMs);

  function casualKey(parsed) {
    return `${parsed.studioId || 'studio'}:${parsed.agentId}`;
  }

  function flushCasualPending(key) {
    const pending = casualPending.get(key);
    if (!pending) return;
    casualPending.delete(key);
    // 记下这轮已经提醒过：这一轮后面再来的气泡不再弹第二条。
    casualTurns.markNotified(key, pending.turnId);
    // 异常要落日志：这条链是异步的，抛出去就只剩「没弹窗」这个现象，
    // 查起来只能靠日志。宁可多一行报错，也不能让提醒不明不白地没出来。
    sendCasualNotification(key, pending).catch((error) => {
      dbg('闲聊提醒发送失败：' + (error?.stack || error?.message || error));
      log?.error?.('[提个醒] 闲聊提醒发送失败', { error: error?.message || error });
    });
  }

  async function sendCasualNotification(key, pending) {
    const cfg = config.get();
    if (!cfg.enabled) {
      dbg('闲聊提醒跳过：总开关关闭');
      return;
    }
    const { mode, agentId, texts } = pending;
    const decision = decideCasualNotify({ trigger: cfg.casualTrigger, mode });
    if (!decision.notify) {
      dbg(`闲聊提醒跳过：档位 ${decision.reason} mode=${mode} agent=${agentId}`);
      return;
    }
    if (isInQuietHours(cfg)) {
      dbg('闲聊提醒跳过：静默时段');
      return;
    }
    // 本体若也在提醒同一句，别弹两遍。宿主本体那条只在「不聚焦」时弹，
    // 它弹了才轮到我们退让。
    //
    // 先问「宿主报过同一句吗」，问不出就不查窗口焦点：
    // 查焦点要拉起 PowerShell 查前台窗口，放在关键路径上会让每一条提醒
    // 都先等一次进程启动（实机：CI 上并发跑测试时，PowerShell 启动慢到
    // 整条提醒都发不出去）。绝大多数情况宿主压根没报过，没必要查。
    if (hostNotices.covers(agentId, texts, { hostShown: true }) && !(await isHanaFocused())) {
      dbg('闲聊提醒跳过：宿主已提醒同一句');
      return;
    }

    // 名字用 displayName：写成 const agentName = agentName(...) 会自引用报错，
    // 而这里的异常是异步链上的，丢了就只剩「没弹窗」这个现象。
    const displayName = await agentNameFor(agentId);
    const fullText = texts.join(' ');
    const snippet = makeSnippet(fullText);
    const style = getStyle(pickStyleId({
      inCasual: true,
      agentId,
      casualStyles: cfg.agentCasualStyles,
      codeStyles: cfg.agentCodeStyles,
      styles: cfg.agentStyles
    }));
    const copy = await buildCasualCopy({
      enabled: cfg.refineEnabled,
      modelConfig: refineModelConfig,
      style,
      agentName: displayName,
      snippet,
      refineText: fullText,
      mode
    });
    if (copy.refineError) {
      dbg('闲聊文案润色失败，回退规则版：' + (copy.refineError?.message || copy.refineError));
    }
    const title = CASUAL_MARKER + copy.title;
    const body = copy.body;
    dbg('闲聊通知文案 ' + JSON.stringify({
      style: style.id, refined: copy.refined, mode, agentId,
      inputChars: fullText.length, snippet, body
    }));

    let avatar = APP_ICON;
    try {
      avatar = await resolveAgentAvatar(agentsHome, agentId, { resources: ctx.resources }) || APP_ICON;
    } catch (error) {
      dbg('闲聊提醒头像读取失败：' + (error?.message || error));
    }

    const soundCfg = pickSoundId({
      inCasual: true,
      agentId,
      casualSounds: cfg.agentCasualSounds,
      codeSounds: cfg.agentCodeSounds,
      sounds: cfg.agentSounds
    });
    let sound;
    if (soundCfg === 'silent') sound = 'silent';
    else if (soundCfg && soundCfg !== 'default') {
      sound = resolveSound(dataDir, soundCfg, cfg.soundDir, { allowExternal: !!cfg.soundDir }) || undefined;
      if (sound && cfg.soundDir) {
        try {
          const stat = await ctx.resources.stat({ kind: 'local-file', path: sound });
          if (!stat?.exists || stat.isDirectory) sound = undefined;
        } catch (error) {
          dbg('闲聊提醒音效读取未获授权或文件不可用：' + (error?.message || error));
          sound = undefined;
        }
      }
    }

    const via = await notify({
      title,
      body,
      icon: avatar || undefined,
      sound,
      duration: cfg.toastDuration,
      style: 'icon'
    });
    if (via === 'failed') {
      dbg(`闲聊通知提交失败（两条腿都没成）agent=${agentId} mode=${mode} title=${title}`);
      log?.error?.('[提个醒] 闲聊提醒未送达', { agentId, mode, title });
    } else {
      dbg(`闲聊通知提交结果 agent=${agentId} mode=${mode} via=${via} title=${title}`);
    }
  }

  /**
   * 处理一条解析好的闲聊发言。
   *
   * @param {object} parsed parseCasualEntry 的结果
   * @param {{fromFallback?:boolean}} options fromFallback=true 表示这条是
   *   兜底（casual_unread）认出来的，不是宿主发的 casual_entry。
   */
  function handleCasualEntry(parsed, { fromFallback = false } = {}) {
    if (!parsed) return;
    const key = casualKey(parsed);
    if (parsed.actor === 'user') {
      // 她在闲聊里说了话：记一笔，下一条伙伴消息就是回她的话。
      casualTurns.noteUserMessage(key);
      // 兜底靠这个时刻分辨「面板里最新那条是她说的还是伙伴说的」。
      casualUnread.noteUserEntry(key, Date.parse(parsed.occurredAt || '') || 0);
      return;
    }
    if (!isAgentCasualMessage(parsed)) return;
    const text = casualEntryText(parsed.item).trim();
    if (!text) return;
    const occurredAt = Date.parse(parsed.occurredAt || '') || 0;
    if (fromFallback) {
      // 兜底认下的这条，登记已处理时刻就行。
      casualUnread.noteHandledAt(key, occurredAt);
    } else {
      const covered = casualUnread.noteAgentEntry(key, occurredAt, text);
      if (covered.covered) {
        // 兜底已经弹过这条了，别再弹一遍。
        dbg(`闲聊气泡已由未读兜底提醒过，跳过 agent=${parsed.agentId}`);
        return;
      }
    }
    const turn = casualTurns.noteAgentMessage(key);
    if (casualTurns.isNotified(key, turn.turnId)) {
      // 这一轮已经提醒过了，后面再来的气泡不再弹第二条。
      dbg(`闲聊气泡已提醒过，跳过 agent=${parsed.agentId} turn=${turn.turnId}`);
      return;
    }

    let pending = casualPending.get(key);
    if (pending && pending.turnId !== turn.turnId) {
      // 上一轮还没发出去，新一轮就开始了：上一轮先发，不能被覆盖丢掉。
      flushCasualPending(key);
      pending = null;
    }
    if (!pending) {
      pending = { agentId: parsed.agentId, mode: turn.mode, turnId: turn.turnId, texts: [] };
      casualPending.set(key, pending);
    }
    pending.texts.push(text);
    // 同一轮的后续气泡并进同一条；新的一轮重新起一条。
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => flushCasualPending(key), casualWindowMs);
    pending.timer.unref?.();
    dbg(`闲聊气泡 agent=${parsed.agentId} mode=${turn.mode} first=${turn.first} text=${text.slice(0, 40)}`);
  }

  /**
   * 兜底：认那些没走 casual_entry 的发言（实机：语音回话只发 casual_unread）。
   *
   * 认的依据是「伙伴未读条数涨了」+「预览比已处理的更新」，
   * 两条一起才认，避免把她自己的发言、或者已经弹过的那条再认一遍。
   */
  function handleCasualUnread(event) {
    const agentId = String(event?.agentId || '').trim();
    if (!agentId) return;
    const key = `${event?.studioId || 'studio'}:${agentId}`;
    const found = casualUnread.observeUnread(key, event);
    if (!found) return;
    dbg(`闲聊兜底：未收到 casual_entry 的发言 agent=${agentId} text=${found.text.slice(0, 40)}`);
    handleCasualEntry({
      agentId,
      studioId: String(event?.studioId || ''),
      entryId: `unread:${found.at}`,
      actor: 'agent',
      itemKind: 'voice',
      item: { kind: 'voice', text: found.text },
      occurredAt: found.occurredAt,
    }, { fromFallback: true });
  }

  // ── 订阅总线 ──
  // 第二个参数必须显式给：省略时经 RPC 会变成 null，宿主 subscribe 里的
  // Array.isArray(r.types) 会在 null 上读属性抛错，整个应用装载失败、安装记录回滚。
  ctx.bus.subscribe((event, sessionPath) => {
    void (async () => {
      try {
        const et = event?.type || '?';
        if (!isDebugNoisyEvent(et)) dbg(`事件 ${et}`);

        // 宿主活动通知（计划任务 / 巡检完成这类）先记账，稍后按活动会话去重
        if (et === 'notification') {
          const marked = sessionPath || event?.sessionFile || event?.sessionPath;
          const ok = activityNotifications.mark(marked);
          // 不带 activityId 的是任务自己发的提醒（不是宿主的完成通知）：记一笔，
          // 任务跑完后就别再补一条「计划任务完成」，否则同一天同一件事弹两遍。
          if (!event?.activityId) {
            agentNoticeWindow.mark(event?.agentId);
          }
          dbg(`宿主通知记账 key=${marked || '无'} ok=${ok} activityId=${event?.activityId || '无'} agent=${event?.agentId || '无'}`);
          // 闲聊本体提醒也走这个事件：记一笔，好判断是不是同一句、别弹两遍。
          hostNotices.note(event);
          return;
        }

        // 闲聊窗口的消息：伙伴在闲聊里是用 chat_say 工具发言的，
        // 主会话的 turn_end 拿不到，这里接 casual_entry。
        if (et === 'casual_entry') {
          handleCasualEntry(parseCasualEntry(event));
          return;
        }

        // 语音回话在宿主那边不投 casual_entry，只发 casual_unread。
        // 这里接住，不然语音的发言就收不到。
        if (et === 'casual_unread') {
          handleCasualUnread(event);
          return;
        }

        const activity = parseActivityUpdate(event);
        if (activity) {
          await handleActivityUpdate(activity);
          return;
        }

        // 后台任务只算中间过程：没全部收齐不发完成提醒
        const bg = parseSessionBackgroundTask(event, sessionPath);
        if (bg) {
          backgroundTasks.update(bg);
          const done = bg.action === 'remove'
            || ['completed', 'failed', 'canceled', 'aborted'].includes(String(bg.status || '').toLowerCase());
          dbg(`后台任务${done ? '结束' : '开始'} session=${bg.sessionId} task=${bg.taskId} remaining=${backgroundTasks.count(bg.sessionId)}`);
          // 收齐了就排一次补发；但先静默一段，窗口又开工就作废（收齐 ≠ 说完了）。
          if (done && !backgroundTasks.has(bg.sessionId) && deferredTurns.has(bg.sessionId)) {
            const pending = deferredTurns.take(bg.sessionId);
            if (pending) {
              scheduleDeferredFlush(pending, bg.sessionId);
            } else {
              dbg(`后台任务收齐，但暂存的完成提醒已过期，丢弃 session=${bg.sessionId}`);
            }
          }
          return;
        }

        // wait_finished：结果已结算，但叫醒可能还被宿主扣着。
        // state=pending 时这个会话后面一定还有输入，这一回合的「完成」只是过程句。
        // 非 pending 也要留一行日志：否则实机验证时「没看到记账日志」分不清是
        // 宿主没发这个事件，还是发了但 state 不是 pending。
        if (et === 'wait_finished') {
          const debt = parseWaitDebt(event, sessionPath);
          if (debt && waitDebt.mark(debt.sessionId, debt.waitId, Date.now())) {
            dbg(`叫醒还欠着，记一笔 session=${debt.sessionId} wait=${debt.waitId}`);
          } else if (debt) {
            dbg(`叫醒欠账记不进去（缺会话键）session=${debt.sessionId || '未知'}`);
          } else {
            const state = String(event?.registration?.notification?.state || '(无 notification 层)');
            dbg(`wait_finished，但不是未投递状态 state=${state}`);
          }
          return;
        }

        // 生命周期事件提供宿主稳定会话 id；避免每条通知都依赖全量 session:list。
        if (et === 'session_created') {
          const identity = parseSessionIdentity(event, sessionPath);
          if (identity) rememberSession(identity);
          return;
        }
        if (et === 'session_closed') {
          const identity = parseSessionIdentity(event, sessionPath);
          const key = normalizeSessionPath(identity?.sessionPath);
          if (key) {
            sessionIdsByPath.delete(key);
            sessionTitlesByPath.delete(key);
          }
          // 会话没了，后台任务计数和暂存一起清掉，别留给下一个同名会话。
          const closedSid = sessionIdFromPath(identity?.sessionPath || sessionPath);
          if (closedSid) {
            abnormalTurns.forget(closedSid);
            turnStarts.delete(closedSid);
            // 收工时刻和完成序号也要清：留着会让同名会话重建时的忙闲判定串到上一轮。
            turnEnds.delete(closedSid);
            turnSeqBySession.delete(closedSid);
            // 合并窗口的定时器不停掉，会话关了 30 秒后还会补弹一条「又回了 N 条」。
            clearSessionTimer(closedSid);
            notifier.sessions.delete(closedSid);
            if (backgroundTasks.forget(closedSid)) {
              dbg(`会话关闭，清空后台任务计数 session=${closedSid}`);
            }
            deferredTurns.forget(closedSid);
            dropHeldToast(closedSid, '会话关闭');
            cancelPendingFlush(closedSid, '会话关闭');
            waitDebt.forget(closedSid);
          }
          return;
        }
        if (et === 'session_metadata_updated' && typeof event?.metadata?.title === 'string') {
          const key = normalizeSessionPath(sessionPath);
          const title = event.metadata.title.trim();
          if (key && title) sessionTitlesByPath.set(key, title);
          else if (key) sessionTitlesByPath.delete(key);
          return;
        }
        if (et === 'session_info_changed') {
          const key = normalizeSessionPath(sessionPath);
          if (key) sessionTitlesByPath.delete(key);
          return;
        }

        // 用户消息：记下会话活跃时间，用于「当前窗口」判定
        if (et === 'session_user_message') {
          const sid = sessionIdFromPath(sessionPath);
          if (sid) {
            participation.mark(sid);
            abnormalTurns.beginUserTurn(sid);
            // 用户插话意味着那个叫醒作废了；不销账会把后续回合一直压死。
            if (waitDebt.has(sid)) {
              waitDebt.clear(sid);
              dbg(`用户插话，销掉未投递的叫醒欠账 session=${sid}`);
            }
          }
          return;
        }

        // 回合重新开始：被压住的那句已经确认是过程，直接丢弃不补发。
        if (et === 'turn_start') {
          const sid = sessionIdFromPath(sessionPath) || String(event?.sessionId || '');
          if (sid) {
            // 记下开工时刻：完成提醒在发出去之前要拿它比对，避免把上一轮的「回你啦」
            // 拖到这一轮才弹出来。
            const startAt = Date.now();
            turnStarts.set(sid, startAt);
            // 新一轮开工了，上一轮的收工记录就该作废。
            //
            // 不作废会出这样的事（实机 2026-10-30）：先收工、紧接着又开工，
            // 两个事件落在同一毫秒，start 和 end 相等，
            // 而「忙」是按 start > end 判的——相等就不忙，
            // 于是把上一轮的「中间汇报」当成收尾直接弹出去，
            // 真正那句「这才是结论」也跟着弹，两条撞在一起。
            //
            // 靠时间戳分不出同一毫秒里的先后，靠「开工之后还没有新的收工」才分得清。
            if ((turnEnds.get(sid) || 0) <= startAt) turnEnds.delete(sid);
            // 收齐后的静默期内又开工 = 那不是收尾，补发作废。
            cancelPendingFlush(sid, '窗口又开工');
            // 被压住的那句已经确认是过程，不补发也不堆在内存里。
            // 无条件做：否则「还没排期就来 turn_start」时暂存会漏掉。
            deferredTurns.forget(sid);
            if (waitDebt.has(sid)) {
              waitDebt.clear(sid);
              dbg(`叫醒已投递，清账 session=${sid}`);
            }
          }
          return;
        }

        const retryStart = parseAutoRetryStart(event, sessionPath);
        if (retryStart) {
          abnormalTurns.onRetryStart(retryStart.sessionId);
          return;
        }
        const retryEnd = parseAutoRetryEnd(event, sessionPath);
        if (retryEnd) {
          abnormalTurns.onRetryEnd(retryEnd);
          return;
        }
        const providerFailure = parseProviderError(event, sessionPath);
        if (providerFailure) {
          if (isRetryCancelled(providerFailure.errorMessage)) {
            abnormalTurns.onTurnSuccess(providerFailure.sessionId);
          } else {
            abnormalTurns.onTurnFailure(providerFailure);
          }
          return;
        }
        const sessionAbort = parseSessionAbort(event, sessionPath);
        if (sessionAbort) {
          if (isRetryCancelled(sessionAbort.errorMessage)) {
            abnormalTurns.onTurnSuccess(sessionAbort.sessionId);
          } else {
            abnormalTurns.onTurnFailure(sessionAbort);
          }
          return;
        }

        const info = parseTurnEnd(event, sessionPath);
        if (!info) return;
        // 记下收工时刻：通知发送前要用「开工晚于收工」判断这个窗口现在还忙不忙。
        if (info.sessionId) turnEnds.set(info.sessionId, Date.now());
        if (info.aborted && isUserInitiatedAbortReason(info.reason)) {
          abnormalTurns.onTurnSuccess(info.sessionId);
          return;
        }
        const failure = parseTurnFailure(event, sessionPath);
        if (failure) {
          if (isRetryCancelled(failure.errorMessage)) {
            abnormalTurns.onTurnSuccess(failure.sessionId);
          } else {
            abnormalTurns.onTurnFailure(failure);
          }
          return;
        }
        // 正常收尾但一个字没说：不归「完成提醒」也不归「失败」，单独算一次异常候选。
        // （2026-10-17 实机：MiniMax 思考吃完额度后返回 content=[] + stopReason=stop，
        //   完成提醒当它是空内容静默跳过，失败判据又够不着，两边一起哑掉。）
        const silent = parseSilentTurn(event, sessionPath);
        if (silent) {
          // 后台任务还压着、或叫醒还没投递：后面一定还会起真回合，别抢着弹。
          if (backgroundTasks.has(silent.sessionId) || waitDebt.has(silent.sessionId)) {
            dbg(`空返回但后台任务或叫醒未结，先不提醒 session=${silent.sessionId}`);
            return;
          }
          abnormalTurns.onTurnFailure(silent);
          return;
        }
        if (shouldNotifyCompletedTurn(info)) abnormalTurns.onTurnSuccess(info.sessionId);
        await handleTurnEnd(info);
      } catch (error) {
        dbg('事件处理异常：' + (error?.stack || error?.message || error));
        log?.error?.('[提个醒] 事件处理异常', { error: error?.message || error });
      }
    })();
  }, {});

  dbg('总线订阅成功');
  log?.info?.('[提个醒] 小喇叭已戴上（应用版）');

  // 首次注册（快捷方式 + AUMID）是这条链路里最容易失败的一步，又恰好发生在
  // 第一条通知那一刻，出了问题用户只看到一个换了壳的通知，什么也看不出来。
  // 挂到启动预热里跑：失败只记日志，不挡启动；真失败时第一条通知会降级，
  // 设置页那条横幅会拿这次记录告诉人该怎么修。
  async function warmUpToastRegistration() {
    // 测试都注入假 spawnProcess，没注入才是真实运行，才该去碰系统注册表。
    if (deps.dependencies?.spawnProcess) return;
    try {
      const result = await ensureRegistration({
        pluginDir: INSTALL_DIR,
        ...(deps.dependencies || {}),
        debug: dbg
      });
      if (result.ok) dbg('通知外壳注册预热完成');
      else dbg(`通知外壳注册预热未完成 kind=${result.kind} detail=${result.detail || result.stderr || ''}`);
    } catch (error) {
      dbg('通知外壳注册预热异常：' + (error?.message || error));
    }
  }

  // 装载完成后再做需要宿主授权的动作：apply 里不能发受保护请求。
  const prewarm = setTimeout(() => {
    void refreshAgents();
    void refreshSessionTitleIndex();
    void warmUpToastRegistration();
  }, 4000);
  prewarm.unref?.();
}
