// 提个醒 · 通知发送结果
// 脚本必须在 Windows 接受 Show() 后回传标记；启动进程不等于通知已提交。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// 空载实测脚本约 0.5 秒就会回标记；45 秒是留给机器正忙时的余量
// （2026-10-18 实机：批量扫会话时整条腿被 20 秒上限砍掉，通知退化成
// 宿主备用通道，伙伴头像和样式全丢。宿主契约只有 title/body，补不回来。）
const KILL_AFTER_MS = 45000;
// 超时多半是 PowerShell 冷启动/机器繁忙的抖动，补一次机会。
// 只重试超时：脚本明确报错（如通知被系统禁用）时重试只会白等一轮。
const TIMEOUT_RETRIES = 1;

const SUBMITTED_MARKER = "TXS_TOAST_SUBMITTED";

/** 跑一次脚本。返回是否确认提交，以及失败类别（供上层决定要不要重试）。 */
function runOnce({ pluginDir, title, message, style, icon, sound, duration }, { spawnProcess, timeoutMs }) {
  const ps1 = path.join(pluginDir, "lib", "notify.ps1");
  if (!fs.existsSync(ps1)) {
    return Promise.resolve({ sent: false, kind: "missing-script", detail: `notify.ps1 不存在：${ps1}` });
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
      resolve({ sent: false, kind: "spawn-error", detail: error.message });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (sent, kind, detail) => {
      if (settled) return;
      settled = true;
      if (sent) {
        // 通知已提交，脚本仍可能播放专属音效；保留超时清理，不阻塞通知结果。
        killer.unref?.();
      } else {
        clearTimeout(killer);
      }
      resolve({ sent, kind, detail, stderr: stderr.trim().slice(0, 1000) });
    };
    const killer = setTimeout(() => {
      finish(false, "timeout", `通知进程 ${timeoutMs}ms 未收到提交确认`);
      try { child.kill(); } catch { /* 进程可能已退出 */ }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-4096);
      if (stdout.split(/\r?\n/).some((line) => line.trim() === SUBMITTED_MARKER)) finish(true, "submitted", "");
    });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.on("error", (error) => finish(false, "process-error", error.message));
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      finish(false, "no-marker", `通知进程退出但未确认提交（code=${code}, signal=${signal || "无"}）`);
    });
  });
}

/** 返回脚本是否确认通知已提交；不代表 Windows 一定显示横幅。 */
export async function sendToast(options, { spawnProcess = spawn, timeoutMs = KILL_AFTER_MS, timeoutRetries = TIMEOUT_RETRIES, debug } = {}) {
  let attempt = 0;
  let last = null;
  for (;;) {
    last = await runOnce(options, { spawnProcess, timeoutMs });
    if (last.sent || last.kind !== "timeout" || attempt >= timeoutRetries) break;
    attempt += 1;
    debug?.(`通知脚本超时，第 ${attempt} 次重试（${timeoutMs}ms 上限）`);
  }
  if (!last.sent) {
    const detail = [last.detail, last.stderr].filter(Boolean).join(" | ");
    debug?.(`通知脚本未确认提交 kind=${last.kind} attempt=${attempt + 1} detail=${detail}`);
    options.log?.error?.("[提个醒] 通知脚本未确认提交", {
      error: detail, kind: last.kind, attempt: attempt + 1, stderr: last.stderr
    });
  }
  return last.sent;
}

/** 所有通知入口共用：脚本失败才使用宿主通道，已提交后不重复弹。 */
export async function deliverToast(options, hostNotify, dependencies) {
  if (await sendToast(options, dependencies)) return { sent: true, via: "powershell" };
  try {
    if (typeof hostNotify !== "function") throw new Error("宿主备用通知通道不可用");
    // 宿主契约 AppNotificationInput 只有 title/body，头像与样式在这条腿上补不回来，
    // 降级是已知代价；能做的只有别静默，让 debug.log 留下痕迹。
    dependencies?.debug?.("转入宿主备用通道：这条没有伙伴头像与专属音效");
    const result = await hostNotify({ title: options.title, body: options.message });
    if (result === false || result?.shown === false) throw new Error("宿主未接受通知请求");
    return { sent: true, via: "host" };
  } catch (error) {
    options.log?.error?.("[提个醒] 宿主备用通知也失败", { error: error?.message || String(error) });
    return { sent: false, via: "failed" };
  }
}
