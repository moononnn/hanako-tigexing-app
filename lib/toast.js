// 提个醒 · 通知发送结果
// 脚本必须在 Windows 接受 Show() 后回传标记；启动进程不等于通知已提交。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const KILL_AFTER_MS = 20000;
const SUBMITTED_MARKER = "TXS_TOAST_SUBMITTED";

/** 返回脚本是否确认通知已提交；不代表 Windows 一定显示横幅。 */
export async function sendToast({ pluginDir, title, message, style, icon, sound, duration, log }, { spawnProcess = spawn, timeoutMs = KILL_AFTER_MS } = {}) {
  const ps1 = path.join(pluginDir, "lib", "notify.ps1");
  if (!fs.existsSync(ps1)) {
    log?.error?.("[提个醒] notify.ps1 不存在", { ps1 });
    return false;
  }
  const env = {
    ...process.env,
    TXS_TITLE: String(title),
    TXS_MSG: String(message),
    TXS_STYLE: style === "plain" ? "plain" : "icon",
    TXS_ICON: icon ? String(icon) : "",
    TXS_SOUND: sound ? String(sound) : "",
    TXS_DURATION: duration === "long" ? "long" : ""
  };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps1], {
        env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
      });
    } catch (error) {
      log?.error?.("[提个醒] 启动通知进程失败", { error: error.message });
      resolve(false);
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (sent, detail) => {
      if (settled) return;
      settled = true;
      if (sent) {
        // 通知已提交，脚本仍可能播放专属音效；保留超时清理，不阻塞通知结果。
        killer.unref?.();
      } else {
        clearTimeout(killer);
        log?.error?.("[提个醒] 通知脚本未确认提交", { error: detail, stderr: stderr.trim().slice(0, 1000) });
      }
      resolve(sent);
    };
    const killer = setTimeout(() => {
      finish(false, "通知进程超时，未收到提交确认");
      try { child.kill(); } catch { /* 进程可能已退出 */ }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-4096);
      if (stdout.split(/\r?\n/).some((line) => line.trim() === SUBMITTED_MARKER)) finish(true);
    });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      finish(false, `通知进程退出但未确认提交（code=${code}, signal=${signal || "无"}）`);
    });
  });
}

/** 所有通知入口共用：脚本失败才使用宿主通道，已提交后不重复弹。 */
export async function deliverToast(options, hostNotify, dependencies) {
  if (await sendToast(options, dependencies)) return { sent: true, via: "powershell" };
  try {
    if (typeof hostNotify !== "function") throw new Error("宿主备用通知通道不可用");
    const result = await hostNotify({ title: options.title, body: options.message });
    if (result === false || result?.shown === false) throw new Error("宿主未接受通知请求");
    return { sent: true, via: "host" };
  } catch (error) {
    options.log?.error?.("[提个醒] 宿主备用通知也失败", { error: error?.message || String(error) });
    return { sent: false, via: "failed" };
  }
}
