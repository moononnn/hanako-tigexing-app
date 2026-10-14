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

import { Notifier, isInQuietHours, resolveChatTrigger } from './lib/policy.js';
import { createConfigManager } from './lib/config.js';
import { deliverToast } from './lib/toast.js';
import {
  parseTurnEnd,
  parseTurnFailure,
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
import { createRefineModelConfig } from './lib/refine-model.js';
import { buildNotificationCopy } from './lib/notification-copy.js';
import { createFocusNotificationHandler, FOCUS_NOTIFY_SERVICE } from './lib/focus-notify.js';
import { appendDebugLog, isDebugNoisyEvent } from './lib/debug-log.js';
import { SessionParticipation } from './lib/session-participation.js';

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

  // ── 运行时状态 ──
  const timers = new Map();
  const participation = new SessionParticipation({
    dataDir,
    onError: (error) => dbg('参与记录保存/恢复失败：' + (error?.message || error))
  });
  dbg(`真实用户参与记录恢复 count=${participation.sessions.size}`);
  const backgroundTasks = toastDependencies.backgroundTasks || new BackgroundTaskTracker();
  const deferredTurns = new DeferredTurns();
  // 「叫醒还欠着」单独记账与暂存：它和后台任务的收齐时机完全不同，混用会互相误取。
  const waitDebt = toastDependencies.waitDebt || new WaitDebtTracker();
  // 待补发的回合：会话 id -> { timer, info }。静默期内开工则取消并丢弃。
  const pendingFlushes = new Map();
  const flushGraceMs = Number(toastDependencies.deferredFlushGraceMs) > 0
    ? Number(toastDependencies.deferredFlushGraceMs)
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
  const refineModelConfig = createRefineModelConfig({ ctx, dataDir });
  const notifier = new Notifier(config.get());

  // ── 弹窗：两条腿 ──
  async function deliverNotification({ title, body, icon, sound, duration, style }) {
    return deliverToast({
      pluginDir: INSTALL_DIR, title, message: body, style, icon, sound, duration, log
    }, (input) => ctx.notifications.show(input), toastDependencies.dependencies);
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
    const styleId = (cfg.agentStyles || {})[decision.agentId] || 'default';
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
    let sessionTitle = sessionTitlesByPath.get(sessionKey) || await resolveSessionTitleWithRetry({
      bus: ctx.bus,
      sessionPath: decision.sessionPath,
      sessionId: sessionIdsByPath.get(sessionKey),
      agentId: decision.agentId,
      onResolved: rememberSession,
      onError: (error) => dbg('会话标题查询失败：' + (error?.message || error))
    });
    // 查询期间可能收到自动起名/手动改名事件，不丢掉刚到的真实标题。
    sessionTitle = sessionTitlesByPath.get(sessionKey) || sessionTitle;
    const title = sessionPrefix(sessionTitle) + copy.title;
    const body = copy.body;
    if (copy.refineError) {
      dbg('文案润色失败，回退规则版：' + (copy.refineError?.message || copy.refineError));
    }
    // 记录实际交付正文与来源，不能只凭 JSON 可解析就宣布效果成功。
    const refineConfig = refineModelConfig.getConfig();
    dbg('通知文案 ' + JSON.stringify({
      style: styleId, refined: copy.refined, sessionTitle: sessionTitle || null,
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

    const soundCfg = (cfg.agentSounds || {})[decision.agentId] || 'default';
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

    const via = await notify({
      title,
      body,
      icon: avatar || undefined,
      sound,
      duration: cfg.toastDuration,
      style: toastStyle === 'plain' ? 'plain' : 'icon'
    });
    dbg(`通知提交结果 session=${decision.sessionId} kind=${decision.kind} via=${via} title=${title}`);
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

    const reason = [alert.errorMessage, alert.finalError, alert.reason]
      .map((value) => String(value || '').trim())
      .find((value) => value && !/^(?:unknown error|\[object object\])$/i.test(value)) || '';
    const name = agentName(alert.agentId);
    const copy = buildAbnormalCopy({
      agentName: name,
      partialText: alert.text,
      errorMessage: reason
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

    const decision = notifier.decide(
      {
        sessionId,
        agentId,
        agentName: agentName(agentId),
        text,
        sessionPath: info.sessionPath,
        // 兵底放行的回合不一定是最终结果（后台任务可能还在跑，也可能没收到它的完成通知），
        // 正文前加一句短提示。刻意写短：横幅只有两行，后面还得留位置给伙伴原话。
        notice: releasedByTimeout ? '（这版可能还会变）' : ''
      },
      now
    );

    if (decision.action === 'skip') return;                 // 静默时段
    if (decision.action === 'merge') {
      scheduleFlush(sessionId, cfg.mergeWindowMs ?? 30000);
      return;
    }

    await doToast(decision, cfg.toastStyle);
    // 用 ?? 而不是 ||：0 是合法配置（不合并），|| 会把它当成假值兜回 30 秒。
    if (decision.kind === 'first') scheduleFlush(sessionId, cfg.mergeWindowMs ?? 30000);
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
          activityNotifications.mark(sessionPath || event?.sessionFile || event?.sessionPath);
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
            if (backgroundTasks.forget(closedSid)) {
              dbg(`会话关闭，清空后台任务计数 session=${closedSid}`);
            }
            deferredTurns.forget(closedSid);
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

  // 装载完成后再做需要宿主授权的动作：apply 里不能发受保护请求。
  const prewarm = setTimeout(() => {
    void refreshAgents();
    void refreshSessionTitleIndex();
  }, 4000);
  prewarm.unref?.();
}
