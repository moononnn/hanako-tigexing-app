// 提个醒 · 路由
// 文件预算豁免：设置页 SSR 模板与对应 API 路由共享配置/助手/音效上下文；拆分需改造注册边界，当前合并便于保持表单与接口契约一致。
// 这是提个醒 App 自己的接口层，只管数据，不吐页面。
// 设置页在 ui/settings.html，页面自己用宿主 SDK 取数渲染。
// 提供：
//   1. GET  /api/config / POST /api/config — 读配置 / 存配置（局部更新）
//   2. GET  /api/sounds 等 — 音效、按伙伴的风格/音效/提醒时机、试听、测试通知
//   3. GET  /api/agents/all — 伙伴名单（含被隐藏的，管理界面用）
//   4. GET  /api/check-update / POST /api/feedback/chat(+close) — 检查更新与反馈
//   5. POST /api/external/notify — 供其他应用调用的弹窗接口
//
// v0.2.0：页面整体重做（修复 api() 无凭证按钮全废）；删合并间隔设置；删通知历史
// v0.3.0：删重要关键词；新增按助手通知风格（default/plain/cheerful/gentle），设置页自由组合 风格+音效
// v0.3.1：删通知样式选择器（固定带头像）；删试一试卡片与 /api/test；页面翻新为纸感手帐风
// v0.4.3：计划任务接管总开关 + 已有宿主通知自动去重

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createConfigManager } from "../lib/config.js";
import { deliverToast } from "../lib/toast.js";
import { listSounds, resolveSound, soundsDir } from "../lib/sounds.js";
import { resolveAgentAvatar } from "../lib/agent-avatar.js";
import { getStyle, getStyleIds, getStyleGroups } from "../lib/style.js";
import { buildNotificationCopy } from "../lib/notification-copy.js";
import { validateExternalNotify, planExternalNotify } from "../lib/external-notify.js";
import { biaoqingbaoInstalled, resolveHanaHome } from "../lib/dialect-links.js";
import { createRefineModelConfig } from "../lib/refine-model.js";
import { UpdateChecker } from "../lib/update-checker/index.js";
import { Feedback } from "../lib/feedback/index.js";
// 副作用导入：让服务端能生成积木 UI 的 HTML；浏览器端会在页面脚本里再执行一份。
import "../lib/update-checker/ui/update-checker.js";
import "../lib/feedback/ui/feedback.js";

// 安装目录：<HANA_HOME>/apps/tigexing-app，本文件在它下面的 routes/。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// HANA_HOME：App 里拿不到环境变量，从安装目录回推（环境变量优先，将来宿主补给就用）。
const HANA_HOME = process.env.HANA_HOME || path.resolve(APP_ROOT, "..", "..");
// 分享版默认仓库：发布后固定指向公开仓库；环境变量可覆盖（测试/自用换仓库用）
const GITHUB_REPO = process.env.TIGEXING_GITHUB_REPO || "moononnn/Hanako-tigexing";

// 试看示例：每个风格一条接近真实回复长度的句子（故意超过截断线，能看到截断/省略号效果）
const PREVIEW_SAMPLES = {
  default: "好呀，我把刚才说的方案整理成文档发给你啦，你先看看合不合适，有什么想调整的地方随时跟我说就行～",
  plain: "会议纪要已生成，共 3 页，重点在第 2 页的预算部分，记得核对数据哦，有疑问随时喊我",
  cheerful: "哈哈哈哈笑死我了！！你怎么这么会啊，这个操作我直接看呆，下次我也要试试！！",
  gentle: "记得喝水呀，工作再忙也要照顾好自己，我一直在呢，别太累了，有什么事随时叫我就好～",
  sister: "我跟你说，刚看到个超有意思的东西，你肯定也喜欢，快去看看，错过就没了",
  epistle: "今日诸事已定，文稿亦已寄达，若有不明之处，随时问我即好，勿要客气",
  morse: "好呀，方案我整理好了，你先看看合不合适，有问题随时说～",
  glitch: "这个接口报错了，我先查一下日志，可能是参数格式的问题，稍等哈",
  mojibake: "文件我收到了，内容有点问题，我重新处理一下再发给你哈",
  biz: "周末的安排我做了三版方案，第一版性价比最高，你看下要不要按这个来",
  ac_shizue: "今日的安排我已记下，文件发你了，你先看看合不合适，有问题随时找我～",
  ac_jack: "方案整理好了，发你了。",
  ac_jun: "文档我改好了。哼，才不是特意帮你改的呢。",
  ac_chacha: "今天的任务我都搞定啦！你也加油哇耶！",
  ac_monica: "今天阳光超好～我把方案发你啦，看完记得喝口水呀！",
  ac_judy: "哦呀，文件给你放桌上了，慢慢看，不急的～",
  ac_ankha: "尼罗河畔的三千年……啊不是，方案整理好了，发你邮箱了，看看？",
  ac_zucker: "嗯……没错，文件我收到了，慢慢看就好，不急的",
  ac_nook: "你要的方案已到货，铃钱已结清，快来看看吧！",
  ac_timmy: "豆狸：方案发你啦！粒狸：快去看！",
  dh_dongbei: "我寻思这个方案整体没毛病，就是流程有点绕，再捋捋就利索了，你看咋整",
  dh_henan: "中，就这么办，恁看还有啥要改嘞，俺再去弄",
  dh_shanghai: "我看了下，整体邪气好，就是第三段流程有点绕，数据校验提到前头要好点，侬讲伐",
  dh_cantonese: "我睇过晒啦，整体冇得顶，就系第三段个流程有啲绕，数据校验摆前边会好啲，你话呢",
  dh_taiwan: "我觉得整体超赞的欸，就是第三段流程有点绕，数据校验放前面会更好，你觉得呢",
  dh_sichuan: "我看了哈，整体没得啥子大问题，就是第三段的流程有点绕，数据校验提到前面要好点，你看要得不",
  dh_shaanxi: "我看了下，整体嫽咋咧，就是第三段流程有点绕，数据校验搁前头美得很，你觉得咋样么",
  dh_beijing: "我寻思着整体倍儿地道，就是第三段流程有点儿绕，数据校验挪前边儿正合适，您说呢",
  dh_xinjiang: "我看了个撒，整体歹得很，就是第三段流程有点绕，数据校验放前面歹，你看咋样撒",
  userstyle: "这个方案我觉得可以，就按这个来吧，有问题随时跟我说"
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function (app, ctx) {
  // App 的 ctx 跟插件不一样：没有 pluginId / pluginDir / log，
  // 安装目录就是入口所在那一层，日志走 logger。
  const { dataDir } = ctx;
  const log = ctx.logger || ctx.log;
  const pluginId = ctx.pluginId || path.basename(APP_ROOT);
  const pluginDir = ctx.pluginDir || APP_ROOT;
  const manifestPath = path.join(pluginDir, "manifest.json");
  let currentVersion = "0.0.0";
  try {
    currentVersion = String(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).version || currentVersion);
  } catch { /* 页面仍可渲染，更新积木会给出友好降级 */ }
  const configManager = createConfigManager({ dataDir, pluginId, log });

  async function listPartnersFromHost() {
    const result = await ctx.bus.request("agent:list", { scope: "all" });
    return (Array.isArray(result?.agents) ? result.agents : [])
      .filter((partner) => partner?.id)
      .map((partner) => ({ id: partner.id, name: partner.name || partner.id }));
  }

  async function getPartnerAvatar(agentId) {
    try {
      return await resolveAgentAvatar(path.join(HANA_HOME, "agents"), agentId, {
        resources: ctx.resources
      });
    } catch (error) {
      log?.warn?.("[提个醒] 伙伴头像读取失败", { agentId, error: error?.message || String(error) });
      return null;
    }
  }

  const soundExtensions = new Set([".wav", ".mp3", ".m4a", ".aac"]);
  async function listSoundFiles(customDir) {
    if (!customDir) return listSounds(dataDir, "");
    const result = await ctx.resources.list({ kind: "local-file", path: customDir });
    const entries = Array.isArray(result)
      ? result
      : result?.entries || result?.items || result?.children || result?.files || [];
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => typeof entry === "string" ? entry : entry?.name || entry?.path || entry?.fileName || "")
      .map((name) => path.basename(String(name)))
      .filter((name) => soundExtensions.has(path.extname(name).toLowerCase()))
      .sort();
  }

  async function inspectSoundDirectory(dir) {
    try {
      const stat = await ctx.resources.stat({ kind: "local-file", path: dir });
      if (!stat?.exists) return { ok: false, error: "文件夹不存在，先建好再选。" };
      if (!stat.isDirectory) return { ok: false, error: "选中的是文件，请选择文件夹。" };
      return { ok: true, files: await listSoundFiles(dir) };
    } catch (error) {
      const code = String(error?.code || "");
      const message = code.includes("CAPABILITY") || code.includes("ACCESS_DENIED")
        ? "Hana 还没有允许提个醒读取所选音效文件夹；请在应用权限确认中允许读取所选文件。"
        : "读取音效文件夹失败：" + (error?.message || error);
      return { ok: false, error: message };
    }
  }

  // ── 文案润色模型配置（设置页与通知运行时共用同一工厂） ──
  const refineMc = createRefineModelConfig({ ctx, dataDir });
  // ── 分享版通用入口：检查更新 + 反馈 ──
  const updateChecker = new UpdateChecker({ ctx, manifestPath });
  const feedback = new Feedback({
    ctx,
    config: {
      pluginName: "提个醒",
      manifestPath,
      repo: GITHUB_REPO,
      hanaVersion: ctx.hanaVersion || "",
    },
  });
  // 反馈沿用提个醒已经配置好的文案模型；没有自定义配置时，默认跟随当前助手。
  feedback.setModelProvider((messages) => refineMc.sample(messages, {
    temperature: 0.7,
    maxTokens: 800,
    timeoutMs: 30000,
    operation: "tigexing-feedback",
  }));

  // 积木 UI 服务端渲染资源：沿用现有手帐色板，只在这里做局部覆盖。
  const ddDir = fileURLToPath(new URL("../lib/beautify-select/", import.meta.url));
  const beautifySelectCss = fs.readFileSync(path.join(ddDir, "beautify-select.css"), "utf-8");
  const beautifySelectJs = fs.readFileSync(path.join(ddDir, "beautify-select.js"), "utf-8");
  const updateUiDir = fileURLToPath(new URL("../lib/update-checker/ui/", import.meta.url));
  const feedbackUiDir = fileURLToPath(new URL("../lib/feedback/ui/", import.meta.url));
  const updateUiCss = fs.readFileSync(path.join(updateUiDir, "update-checker.css"), "utf-8");
  const updateUiJs = fs.readFileSync(path.join(updateUiDir, "update-checker.js"), "utf-8");
  const feedbackUiCss = fs.readFileSync(path.join(feedbackUiDir, "feedback.css"), "utf-8");
  const feedbackUiJs = fs.readFileSync(path.join(feedbackUiDir, "feedback.js"), "utf-8");

  // ============================================================
  // 页面（服务端渲染完整 HTML）
  // ============================================================
  // ============================================================
  // API
  // ============================================================
  // 页面「关于」卡片用：当前版本号（从安装目录的 manifest 读）
  app.get("/api/version", (c) => c.json({ ok: true, version: currentVersion }));

  app.get("/api/config", (c) => {
    return c.json({ ok: true, config: configManager.get() });
  });

  app.post("/api/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // 部分更新（patch）：只改传入字段，不重置未传字段
    configManager.patch(body);
    log?.info?.("[提个醒] 配置已保存", { keys: Object.keys(body) });
    return c.json({ ok: true, config: configManager.get() });
  });

  // ============================================================
  // 分享版入口：检查更新 + 反馈
  // ============================================================
  app.get("/api/check-update", async (c) => {
    if (!GITHUB_REPO) {
      const current = updateChecker.readCurrentVersion(manifestPath);
      return c.json({
        ok: true,
        hasUpdate: false,
        current,
        latest: current,
        latestTitle: "",
        releaseUrl: "",
        message: "公开仓库还没配置，等发布后这里就能自动检查更新啦",
      });
    }
    return c.json(await updateChecker.check({ repo: GITHUB_REPO, manifestPath }));
  });

  function syncFeedbackModelInfo() {
    try { feedback.setModelConfigInfo(refineMc.sanitize()); } catch { /* 脱敏信息只是辅助，不阻断反馈 */ }
  }
  app.post("/api/feedback/chat", async (c) => {
    syncFeedbackModelInfo();
    return c.json(await feedback.handleChat(await c.req.json().catch(() => ({}))));
  });
  app.post("/api/feedback/chat/close", async (c) => {
    return c.json(await feedback.handleClose(await c.req.json().catch(() => ({}))));
  });

  // ============================================================
  // 文案润色（可选高级档）：开关 + 三档模型配置 + 测试
  // ============================================================
  app.get("/api/refine", (c) => {
    return c.json({ ok: true, enabled: configManager.get().refineEnabled, config: refineMc.sanitize() });
  });

  app.post("/api/refine", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled === "boolean") {
      await configManager.patch({ refineEnabled: body.enabled });
      log?.info?.("[提个醒] 文案润色开关", { enabled: body.enabled });
    }
    return c.json({ ok: true, enabled: configManager.get().refineEnabled });
  });

  app.post("/api/refine/model", async (c) => c.json(await refineMc.handleSave(await c.req.json().catch(() => ({})))));
  app.post("/api/refine/test", async (c) => c.json(await refineMc.handleTest(await c.req.json().catch(() => ({})))));
  app.get("/api/refine/hana-models", async (c) => c.json(await refineMc.handleHanaModels()));

  // ============================================================
  // 音效
  // ============================================================
  app.get("/api/sounds", async (c) => {
    const cfg = configManager.get();
    let files = [];
    let soundError = "";
    let partners = [];
    let partnersError = "";
    try {
      files = await listSoundFiles(cfg.soundDir);
    } catch (error) {
      soundError = /CAPABILITY|ACCESS_DENIED/.test(String(error?.code || ""))
        ? "Hana 尚未允许提个醒读取所选音效文件夹。"
        : "读取音效文件夹失败：" + (error?.message || error);
    }
    try {
      partners = await listPartnersFromHost();
    } catch (error) {
      partnersError = /CAPABILITY|ACCESS_DENIED/.test(String(error?.code || ""))
        ? "Hana 尚未允许提个醒读取伙伴名单。"
        : "读取伙伴名单失败：" + (error?.message || error);
    }
    return c.json({
      ok: true,
      dir: cfg.soundDir || soundsDir(dataDir, ""),
      customDir: cfg.soundDir || "",
      files,
      soundError,
      agents: partners.filter((partner) => !(cfg.hiddenAgents || []).includes(partner.id)),
      agentsError: partnersError,
      hiddenAgents: cfg.hiddenAgents || [],
      styles: getStyleIds().map((id) => {
        const s = getStyle(id);
        const grp = getStyleGroups().find((g) => g.id === (s.group || "normal"));
        return { id, label: s.label, desc: s.desc, group: s.group || "normal", groupLabel: grp ? grp.label : "其他" };
      }),
      assignments: cfg.agentSounds || {},
      styleAssignments: cfg.agentStyles || {},
      // Code 页窗口单独分配：空对象 / 没这个助手 = 跟随普通窗口
      codeAssignments: cfg.agentCodeSounds || {},
      codeStyleAssignments: cfg.agentCodeStyles || {},
      triggerAssignments: cfg.agentTriggers || {}
    });
  });

  // 自定义音效目录走 App ResourceIO；盘外读取必须由用户授予 app/resources.read。
  app.post("/api/sounds/dir", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = String(body.dir ?? "").trim();
    if (raw.length > 1024) return c.json({ ok: false, error: "路径太长了" });
    if (raw !== "" && !path.isAbsolute(raw)) return c.json({ ok: false, error: "要填绝对路径，比如 D:\\音效" });
    let files = [];
    if (raw) {
      const checked = await inspectSoundDirectory(raw);
      if (!checked.ok) return c.json({ ok: false, error: checked.error });
      files = checked.files;
    } else {
      files = await listSoundFiles("");
    }
    await configManager.patch({ soundDir: raw });
    return c.json({ ok: true, dir: raw || soundsDir(dataDir, ""), customDir: raw, files });
  });

  // 弹 Windows 原生文件夹选择框（PowerShell FolderBrowserDialog），选中后通过 ResourceIO 验证并保存。
  app.post("/api/sounds/pick-folder", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const initial = String(body.initial || "").trim();
    const ps1 = path.join(pluginDir, "lib", "pick-folder.ps1");
    if (!fs.existsSync(ps1)) return c.json({ ok: false, error: "缺少 pick-folder.ps1" });
    const picked = await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      try {
        const child = spawn(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps1, "-InitialDir", initial],
          { windowsHide: true }
        );
        let out = "";
        child.stdout.on("data", (d) => { out += String(d); });
        child.on("error", (error) => finish({ error }));
        child.on("close", () => finish({ path: out.trim() }));
        timer = setTimeout(() => {
          try { child.kill(); } catch { /* 已退出 */ }
          finish({ error: new Error("等待文件夹选择超时。") });
        }, 300000);
        timer.unref?.();
      } catch (error) {
        finish({ error });
      }
    });
    if (picked.error) {
      const code = String(picked.error?.code || "");
      const message = code.includes("ACCESS_DENIED")
        ? "Hana 尚未允许提个醒打开文件夹选择器；请检查应用的“运行外部程序”权限。"
        : picked.error.message || "无法打开文件夹选择器。";
      return c.json({ ok: false, error: message });
    }
    if (!picked.path) return c.json({ ok: false, error: "没有选择文件夹" });
    const checked = await inspectSoundDirectory(picked.path);
    if (!checked.ok) return c.json({ ok: false, error: checked.error });
    await configManager.patch({ soundDir: picked.path });
    return c.json({
      ok: true,
      dir: picked.path,
      customDir: picked.path,
      files: checked.files
    });
  });

  app.post("/api/agents/style", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId || "").trim();
    const value = String(body.value || "default").trim();
    // mode=code 写 Code 页窗口那一栏；空串 = 删掉该助手的单独设置，回到跟随普通窗口
    const field = String(body.mode || "normal").trim() === "code" ? "agentCodeStyles" : "agentStyles";
    if (!agentId) return c.json({ ok: false, error: "missing agentId" });
    const cfg = configManager.get();
    const next = { ...(cfg[field] || {}) };
    if (value === "" && field === "agentCodeStyles") {
      delete next[agentId];
      await configManager.patch({ [field]: next });
      return c.json({ ok: true, assignments: configManager.get()[field] || {} });
    }
    if (!getStyleIds().includes(value)) return c.json({ ok: false, error: "unknown style" });
    next[agentId] = value;
    await configManager.patch({ [field]: next });
    return c.json({ ok: true, assignments: configManager.get()[field] || {} });
  });

  // 按助手提醒时机（v0.5.0）：聊天回复完成的档位按助手覆盖；「跟随全局」= 不存该助手
  const VALID_CHAT_TRIGGERS = ["never", "whenUnfocused", "whenSessionUnfocused", "always"];
  app.post("/api/agents/trigger", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId || "").trim();
    const value = String(body.value || "").trim();
    if (!agentId) return c.json({ ok: false, error: "missing agentId" });
    const cfg = configManager.get();
    const next = { ...(cfg.agentTriggers || {}) };
    if (value === "default" || value === "") {
      delete next[agentId]; // 恢复跟随全局
    } else {
      if (!VALID_CHAT_TRIGGERS.includes(value)) return c.json({ ok: false, error: "unknown trigger" });
      next[agentId] = value;
    }
    await configManager.patch({ agentTriggers: next });
    return c.json({ ok: true, assignments: configManager.get().agentTriggers || {} });
  });

  // 隐藏助手（列表不显示，数据保留）：写入 hiddenAgents 名单
  // 与闲不住的「隐藏伙伴」同思路：只影响提个醒设置页列表，不删任何文件、不动其他插件
  const AGENT_ID_RE = /^[a-zA-Z0-9._-]{1,100}$/;
  function agentIdValid(id) {
    return typeof id === "string" && AGENT_ID_RE.test(id);
  }
  function setHiddenAgents(agentId, hidden) {
    const cfg = configManager.get();
    let list = Array.isArray(cfg.hiddenAgents) ? [...cfg.hiddenAgents] : [];
    if (hidden) {
      if (!list.includes(agentId)) list.push(agentId);
    } else {
      list = list.filter((id) => id !== agentId);
    }
    return configManager.patch({ hiddenAgents: list });
  }

  app.post("/api/agents/hide", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId || "").trim();
    if (!agentIdValid(agentId)) return c.json({ ok: false, error: "invalid agentId" });
    await setHiddenAgents(agentId, true);
    const cfg = configManager.get();
    return c.json({ ok: true, hiddenAgents: cfg.hiddenAgents || [] });
  });

  app.post("/api/agents/unhide", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId || "").trim();
    if (!agentIdValid(agentId)) return c.json({ ok: false, error: "invalid agentId" });
    await setHiddenAgents(agentId, false);
    const cfg = configManager.get();
    return c.json({ ok: true, hiddenAgents: cfg.hiddenAgents || [] });
  });

  // 全量助手（含隐藏）：供「管理隐藏助手」显示名字用，不参与任何列表过滤
  app.get("/api/agents/all", async (c) => {
    try {
      return c.json({ ok: true, agents: await listPartnersFromHost() });
    } catch (error) {
      const code = String(error?.code || "");
      const message = code.includes("CAPABILITY") || code.includes("ACCESS_DENIED")
        ? "Hana 尚未允许提个醒读取伙伴名单。"
        : "读取伙伴名单失败：" + (error?.message || error);
      return c.json({ ok: false, error: message });
    }
  });

  app.post("/api/sounds/assign", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId || "").trim();
    const value = String(body.value ?? "default").trim();
    // mode=code 写 Code 页窗口那一栏；空串 = 删掉该助手的单独设置，回到跟随普通窗口
    const field = String(body.mode || "normal").trim() === "code" ? "agentCodeSounds" : "agentSounds";
    if (!agentId) return c.json({ ok: false, error: "missing agentId" });
    const cfg = configManager.get();
    const next = { ...(cfg[field] || {}) };
    if (value === "" && field === "agentCodeSounds") {
      delete next[agentId];
      await configManager.patch({ [field]: next });
      return c.json({ ok: true, assignments: configManager.get()[field] || {} });
    }
    // 值白名单：default / silent / 存在的音效文件名（按当前生效目录）
    const effective = value === "" ? "default" : value;
    if (effective !== "default" && effective !== "silent") {
      let files = [];
      try { files = await listSoundFiles(cfg.soundDir); }
      catch (error) { return c.json({ ok: false, error: "读取音效文件夹失败：" + (error?.message || error) }); }
      if (!files.includes(effective)) return c.json({ ok: false, error: "unknown sound file" });
    }
    next[agentId] = effective;
    await configManager.patch({ [field]: next });
    return c.json({ ok: true, assignments: configManager.get()[field] || {} });
  });

  app.post("/api/sound/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // 同步读不到 body 时用 query 兼容
    const file = (body && body.file) || c.req.query("file") || "";
    const agentId = String((body && body.agentId) || "").trim();
    const reqStyle = String((body && body.style) || "").trim();
    const wantCode = String((body && body.mode) || "").trim() === "code";
    const cfg = configManager.get();
    // 风格优先用请求里当前选中的值（所见即所得，不等保存时序）；没传才回退已保存配置
    const fallbackStyle = wantCode
      ? ((cfg.agentCodeStyles || {})[agentId] || (cfg.agentStyles || {})[agentId] || "default")
      : ((cfg.agentStyles || {})[agentId] || "default");
    const styleId = reqStyle && getStyleIds().includes(reqStyle) ? reqStyle : fallbackStyle;
    const style = getStyle(styleId);
    const partners = await listPartnersFromHost();
    const partner = partners.find((item) => item.id === agentId);
    const name = partner ? partner.name : "助手";
    let sound;
    if (file === "silent") sound = "silent";
    else if (file && file !== "default") {
      const files = await listSoundFiles(cfg.soundDir).catch(() => []);
      if (files.includes(String(file))) sound = resolveSound(dataDir, String(file), cfg.soundDir, { allowExternal: !!cfg.soundDir }) || undefined;
    }
    // 试看示例按风格给不同句子，让风格差异一点就看出来
    const sample = PREVIEW_SAMPLES[styleId] || PREVIEW_SAMPLES.default;
    const { sent, via } = await deliverToast({
      pluginDir,
      title: (wantCode ? "〔Code〕" : "") + style.title("first", name, 1),
      message: style.body("first", sample, 1),
      style: cfg.toastStyle,
      // 头像名经 ResourceIO 授权列出，Toast 子进程读取具体路径。
      icon: await getPartnerAvatar(agentId) || undefined,
      sound,
      duration: cfg.toastDuration,
      log
    }, (input) => ctx.notifications.show(input));
    return c.json({ ok: sent, sent, via, ...(sent ? {} : { error: "通知提交失败，请查看 Hana 日志" }) });
  });

  // 发一条测试通知：跟随当前头像 / 风格 / 音效 / 停留时间与润色设置。
  // 设置页没有当前会话路径，因此测试通知不带窗口名前缀；不给 agentId 就用第一个可见伙伴。
  app.post("/api/test-notify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = configManager.get();
    const visiblePartners = (await listPartnersFromHost())
      .filter((partner) => !(cfg.hiddenAgents || []).includes(partner.id));
    const agentId = String(body.agentId || (visiblePartners[0] && visiblePartners[0].id) || "").trim();
    const partner = visiblePartners.find((item) => item.id === agentId);
    const name = partner ? partner.name : agentId || "助手";
    // mode=code 时用 Code 页窗口那一栏的设置试弹，方便在设置页当场听出区别
    const wantCode = String(body.mode || "normal").trim() === "code";
    const styleId = wantCode
      ? ((cfg.agentCodeStyles || {})[agentId] || (cfg.agentStyles || {})[agentId] || "default")
      : ((cfg.agentStyles || {})[agentId] || "default");
    const style = getStyle(styleId);
    const soundCfg = wantCode
      ? ((cfg.agentCodeSounds || {})[agentId] || (cfg.agentSounds || {})[agentId] || "default")
      : ((cfg.agentSounds || {})[agentId] || "default");
    let sound;
    if (soundCfg === "silent") sound = "silent";
    else if (soundCfg !== "default") {
      const files = await listSoundFiles(cfg.soundDir).catch(() => []);
      if (files.includes(soundCfg)) sound = resolveSound(dataDir, soundCfg, cfg.soundDir, { allowExternal: !!cfg.soundDir }) || undefined;
    }
    const copy = await buildNotificationCopy({
      enabled: cfg.refineEnabled,
      modelConfig: refineMc,
      style,
      kind: "first",
      agentName: name,
      snippet: "这是一条测试通知，看到它就说明弹窗链路是通的。",
      count: 1
    });
    if (copy.refineError) {
      log?.warn?.("[提个醒] 测试通知润色失败，回退规则文案", { error: copy.refineError?.message || String(copy.refineError) });
    }
    const { sent, via } = await deliverToast({
      pluginDir,
      title: (wantCode ? "〔Code〕" : "") + copy.title,
      message: copy.body,
      style: cfg.toastStyle,
      icon: await getPartnerAvatar(agentId) || undefined,
      sound,
      duration: cfg.toastDuration,
      log,
    }, (input) => ctx.notifications.show(input));
    return c.json({ ok: sent, sent, via, agentId, name, ...(sent ? {} : { error: "通知提交失败，请查看 Hana 日志" }) });
  });

  // ============================================================
  // 对外弹窗接口（供其他插件调用，如模型自动降级提醒）
  // POST /api/plugins/tigexing/api/external/notify
  // 复用提个醒现有配置：总开关、静默时段、按助手音效/头像、通知时长、视觉样式；
  // 不弹时返回 suppressed + reason，让调用方知道被静默了。
  // 决策逻辑在 lib/external-notify.js（纯函数，可单测），这里只做薄封装。
  // 鉴权：所有插件 API 都经 Hana 主 API 的 loopback token 代理，未授权进不来。
  // ============================================================
  app.post("/api/external/notify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const v = validateExternalNotify(body);
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);

    const cfg = configManager.get();
    const partnerId = String(body.agentId || "").trim();
    const requestedSound = String(body.sound ?? "").trim() || (cfg.agentSounds || {})[partnerId] || "default";
    let approvedCustomSound = null;
    if (cfg.soundDir && requestedSound !== "default" && requestedSound !== "silent") {
      try {
        const files = await listSoundFiles(cfg.soundDir);
        if (files.includes(requestedSound)) {
          const candidate = resolveSound(dataDir, requestedSound, cfg.soundDir, { allowExternal: true });
          const stat = candidate ? await ctx.resources.stat({ kind: "local-file", path: candidate }) : null;
          if (stat?.exists && !stat.isDirectory) approvedCustomSound = candidate;
        }
      } catch (error) {
        log?.warn?.("[提个醒] 外部提醒音效未能读取", { error: error?.message || String(error) });
      }
    }
    const plan = planExternalNotify(
      {
        title: v.title,
        message: v.message,
        agentId: body.agentId,
        style: body.style,
        sound: body.sound,
        duration: body.duration
      },
      cfg,
      {
        resolveSoundFile: (f) => cfg.soundDir
          ? (f === requestedSound ? approvedCustomSound : null)
          : resolveSound(dataDir, f, ""),
        resolveAgentAvatar: () => null
      }
    );

    if (plan.action === "suppressed") {
      return c.json({ ok: true, sent: false, suppressed: true, reason: plan.reason });
    }
    if (plan.toast.style !== "plain" && partnerId) {
      plan.toast.icon = await getPartnerAvatar(partnerId) || undefined;
    }

    const { sent, via } = await deliverToast({ pluginDir, ...plan.toast, log }, (input) => ctx.notifications.show(input));
    return c.json({
      ok: sent,
      sent,
      via,
      ...(sent ? {} : { error: "通知提交失败，请查看 Hana 日志" }),
      suppressed: false,
      style: plan.meta.style,
      quietHours: cfg.quietHours
    });
  });
}
