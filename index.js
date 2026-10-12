// 提个醒 · App 版入口（核心链路）
//
// 从 legacy 插件迁过来。这一版包含核心链路：
//   订阅总线 → 判断该不该提醒 → 组装文案 → 弹通知
//
// 弹窗走两条腿：先自己拉 PowerShell（保住伙伴头像、专属音效、自定义来源名），
// 脚本未确认提交时退回宿主通知；提交成功仍不保证 Windows 显示横幅。
//
// 还没搬的：异常回合提醒、子伙伴提醒门的细粒度。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Notifier, isInQuietHours, resolveChatTrigger } from './lib/policy.js';
import { createConfigManager } from './lib/config.js';
import { deliverToast } from './lib/toast.js';
import {
  parseTurnEnd,
  parseActivityUpdate,
  parseSessionBackgroundTask,
  sessionIdFromPath,
  shouldNotifyCompletedTurn,
  isUserInitiatedAbortReason
} from './lib/event-parse.js';
import {
  ActivityNotificationTracker,
  buildActivityNotification,
  resolveActivitySessionPath
} from './lib/activity-notify.js';
import { isHanaFocused } from './lib/window-focus.js';
import { getStyle, sessionPrefix } from './lib/style.js';
import { BackgroundTaskTracker } from './lib/background-tasks.js';
import { DeferredTurns } from './lib/deferred-turns.js';
import { resolveAgentAvatar } from './lib/agent-avatar.js';
import { resolveSound } from './lib/sounds.js';
import { normalizeSessionPath, parseSessionIdentity, resolveSessionTitleWithRetry } from './lib/session-title.js';
import { createRefineModelConfig } from './lib/refine-model.js';
import { buildNotificationCopy } from './lib/notification-copy.js';
import { appendDebugLog, isDebugNoisyEvent } from './lib/debug-log.js';
import { SessionParticipation } from './lib/session-participation.js';

export const name = 'tigexing-app';

const APP_ID = 'tigexing-app';
const ACTIVITY_NOTIFICATION_GRACE_MS = 1500;
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
  async function refreshAgents() {
    try {
      const res = await ctx.bus.request('agent:list', { scope: 'all' });
      const map = {};
      for (const a of res?.agents || []) if (a?.id) map[a.id] = a.name || a.id;
      if (Object.keys(map).length) agentNames = map;
    } catch (error) {
      dbg('伙伴名单拉取失败：' + (error?.message || error));
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
  async function notify({ title, body, icon, sound, duration, style }) {
    const result = await deliverToast({
      pluginDir: INSTALL_DIR, title, message: body, style, icon, sound, duration, log
    }, (input) => ctx.notifications.show(input), toastDependencies.dependencies);
    return result.via;
  }

  // ── 组装并弹一条 ──
  async function doToast(decision, toastStyle) {
    const cfg = config.get();
    const styleId = (cfg.agentStyles || {})[decision.agentId] || 'default';
    const style = getStyle(styleId);

    // 跟旧版一致：先生成通知正文，再读取会话标题，给宿主异步起名留时间。
    const copy = await buildNotificationCopy({
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
      source: refineConfig.modelSource || 'agent',
      provider: refineConfig.hanaModel?.providerId,
      model: refineConfig.hanaModel?.modelId
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

    await notifyTurnEnd(info, sessionId, now, releasedByTimeout);
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
        // 兵底放行的回合不一定是最终结果（后台任务可能还在跑），正文前加一句实情。
        notice: releasedByTimeout ? '（后台任务还在跑，这版可能还会变）' : ''
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
          // 收齐了就补发被压下的那条完成提醒；补发再走一遍完整前置检查，不绕过任何规则。
          if (done && !backgroundTasks.has(bg.sessionId) && deferredTurns.has(bg.sessionId)) {
            const pending = deferredTurns.take(bg.sessionId);
            if (pending) {
              dbg(`后台任务收齐，补发被压下的完成提醒 session=${bg.sessionId}`);
              await handleTurnEnd(pending, { deferred: true });
            } else {
              dbg(`后台任务收齐，但暂存的完成提醒已过期，丢弃 session=${bg.sessionId}`);
            }
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
            if (backgroundTasks.forget(closedSid)) {
              dbg(`会话关闭，清空后台任务计数 session=${closedSid}`);
            }
            deferredTurns.forget(closedSid);
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
          if (sid) participation.mark(sid);
          return;
        }

        const info = parseTurnEnd(event, sessionPath);
        if (!info) return;
        if (info.aborted && isUserInitiatedAbortReason(info.reason)) return;
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
