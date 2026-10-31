// 提个醒 · 通知外壳状态
//
// 通知有两条腿：自己起 PowerShell 发（提个醒的外壳、伙伴头像、专属音效），
// 起不来才退到宿主通道（Hana 本体的外壳，只有标题正文）。
// 降级完全是静默的：通知照弹，只是换了壳，用户看不出发生过什么。
// 这里把最近一次投递结果落盘，设置页据此给一条会说话、能修的横幅。
//
// 只记「最近一次」，不记历史：成功一次就把降级记录盖掉，横幅自动消失。
import fs from "node:fs";
import path from "node:path";

// 超过一天没再出问题就不再提，避免修好之后横幅还挂着。
export const STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DETAIL_MAX = 300;

/** 状态文件位置（在应用自己的 dataDir 下，和其他运行数据放一起）。 */
export function toastStatusFilePath(dataDir) {
  return path.join(dataDir, "tigexing", "toast-status.json");
}

function clip(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > DETAIL_MAX ? value.slice(0, DETAIL_MAX) + "…" : value;
}

/**
 * 写入最近一次投递结果。写盘失败不影响通知本身。
 * @param {string} file 状态文件绝对路径
 * @param {{via:string,kind?:string,detail?:string,stderr?:string,at?:string}} record
 */
export function writeToastStatus(file, record) {
  if (!file) return false;
  const payload = {
    at: record?.at || new Date().toISOString(),
    via: String(record?.via || "unknown"),
    kind: clip(record?.kind),
    detail: clip([record?.detail, record?.stderr].filter(Boolean).join(" | "))
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/** 读最近一次投递结果；文件不存在或格式坏了都返回 null。 */
export function readToastStatus(file) {
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.via !== "string") return null;
    return {
      at: typeof raw.at === "string" ? raw.at : "",
      via: raw.via,
      kind: typeof raw.kind === "string" ? raw.kind : "",
      detail: typeof raw.detail === "string" ? raw.detail : ""
    };
  } catch {
    return null;
  }
}

const COPY = {
  permissions: {
    level: "warn",
    title: "通知现在是 Hana 本体代发的",
    hint: "提个醒没能启动自己的通知程序，最常见的原因是这个应用没拿到「运行外部程序」权限。到 Hana 的 设置 → 应用 → 提个醒 → 权限，把「运行外部程序」打开；再回提个醒点一次「发一条测试通知」确认。修好之前通知照样会弹，只是没有伙伴头像和专属音效。",
    action: "permissions"
  },
  windows: {
    level: "warn",
    title: "Windows 把「提个醒」的通知关掉了",
    hint: "系统拦下了提个醒这个通知身份，所以你看到的是 Hana 本体那条。打开 Windows 设置 → 系统 → 通知，找到「提个醒」并允许；列表里没有它的话，先回提个醒点一次「发一条测试通知」，它会注册出来再回去允许。",
    action: "windows"
  },
  missing: {
    level: "error",
    title: "通知程序不在安装目录里",
    hint: "lib\\notify.ps1 找不到，包可能没装完整。重新安装一次提个醒就能恢复。",
    action: "reinstall"
  },
  timeout: {
    level: "warn",
    title: "通知程序启动超时了",
    hint: "PowerShell 没在时限内回报提交，可能是杀软拦了或机器太忙。先点一次「发一条测试通知」重试；还不行就看 Hana 日志里「通知脚本未确认提交」那一行的 stderr。",
    action: "retry"
  },
  unknown: {
    level: "warn",
    title: "通知换成了 Hana 本体代发",
    hint: "原因没认出来。去提个醒的 debug.log 搜「通知脚本未确认提交」，那一行带着 PowerShell 的原始错误；把它发给维护者更快。",
    action: "log"
  }
};

/**
 * 判断要不要在设置页顶一条横幅，并把技术原因翻成人话。
 * @param {{at?:string,via?:string,kind?:string,detail?:string}|null} status
 * @param {{now?:number,maxAgeMs?:number}} [opts]
 * @returns {{level:string,title:string,hint:string,action:string,at:string,raw:object}|null}
 */
export function explainToastStatus(status, { now = Date.now(), maxAgeMs = STATUS_MAX_AGE_MS } = {}) {
  if (!status || typeof status !== "object") return null;
  // 走自己的通道 = 一切正常，不出横幅。
  if (status.via === "powershell") return null;
  if (status.via !== "host" && status.via !== "failed") return null;

  const at = Date.parse(status.at || "");
  if (!Number.isFinite(at)) return null;
  if (now - at > maxAgeMs) return null;

  const text = `${status.kind || ""} ${status.detail || ""}`;
  let key = "unknown";
  if (status.kind === "missing-script") key = "missing";
  else if (status.kind === "timeout") key = "timeout";
  else if (/denied|EACCES|EPERM|cannot find the file|spawn/i.test(text)) key = "permissions";
  else if (/Windows notification setting|DisabledForApplication|notification setting/i.test(text)) key = "windows";

  return { ...COPY[key], at: new Date(at).toISOString(), raw: { ...status } };
}
