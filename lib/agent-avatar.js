// 提个醒 · 助手头像解析
// App 沙箱不能用裸 fs 探测 Hana 伙伴目录：用 ResourceIO 列出获准目录中的头像名，
// 再把对应的完整路径交给负责 Windows Toast 的 PowerShell 子进程读取。
import path from "node:path";

const EXT_ORDER = ["png", "jpg", "jpeg", "webp"];

function listedNames(result) {
  const entries = Array.isArray(result)
    ? result
    : result?.items || result?.entries || result?.children || result?.files || [];
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => typeof entry === "string" || entry?.isDirectory !== true)
    .map((entry) => typeof entry === "string" ? entry : entry?.name || entry?.path || entry?.fileName || "")
    .map((name) => path.basename(String(name)))
    .filter(Boolean);
}

/**
 * 解析助手头像路径。只用 ResourceIO 列目录，不在 App 进程读取头像字节。
 * @param {string} agentsHome Hana agents 目录
 * @param {string} agentId 助手 id
 * @param {{resources:object}} options App ResourceIO
 * @returns {Promise<string|null>} 头像绝对路径；找不到或 ResourceIO 不可用时返回 null
 */
export async function resolveAgentAvatar(agentsHome, agentId, { resources } = {}) {
  if (!agentsHome || !agentId || typeof resources?.list !== "function") return null;

  const rawAgentId = String(agentId);
  const agentKey = path.basename(rawAgentId);
  if (!agentKey || agentKey !== rawAgentId || agentKey === "." || agentKey === "..") return null;
  const avatarsDir = path.join(agentsHome, agentKey, "avatars");
  const names = listedNames(await resources.list({ kind: "local-file", path: avatarsDir }));

  for (const ext of EXT_ORDER) {
    const hit = names.find((name) => path.extname(name).toLowerCase() === `.${ext}`);
    if (hit) return path.join(avatarsDir, hit);
  }
  return null;
}
