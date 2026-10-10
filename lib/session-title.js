// 提个醒 · 会话标题读取
// 优先用 session_created 提供的稳定 sessionId 查询；没有映射时再按路径查活跃会话列表。
import path from "node:path";

export function normalizeSessionPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.win32.normalize(raw.replace(/\//g, "\\")).replace(/^\\\\\?\\/, "").toLowerCase();
}

/** 兼容宿主直接投影与旧式嵌套的 session_created / session_closed。 */
export function parseSessionIdentity(event, sessionPath) {
  if (!event || typeof event !== "object") return null;
  const session = event.session && typeof event.session === "object" ? event.session : event;
  const resolvedPath = String(sessionPath || session.sessionPath || "").trim();
  const sessionId = String(session.sessionId || "").trim();
  if (!resolvedPath || !sessionId) return null;
  return { sessionPath: resolvedPath, sessionId };
}

function notifyResolved(session, fallbackPath, onResolved) {
  if (typeof onResolved !== "function") return;
  try {
    onResolved({
      sessionPath: session?.path || session?.sessionPath || fallbackPath,
      sessionId: String(session?.sessionId || "").trim(),
      title: typeof session?.title === "string" ? session.title.trim() : ""
    });
  } catch { /* cache callbacks must not affect notifications */ }
}

function reportError(onError, error) {
  try { onError?.(error); } catch { /* logging must not affect notifications */ }
}

/**
 * 先按稳定 sessionId 查询标题；旧窗口没有 id 映射时，回退到 session:list 按路径匹配。
 * @param {{bus:object,sessionPath:string,sessionId?:string,agentId?:string,onError?:(error:Error)=>void,onResolved?:(session:object)=>void}} opts
 * @returns {Promise<string|null>}
 */
export async function resolveSessionTitle({ bus, sessionPath, sessionId, agentId, onError, onResolved } = {}) {
  if (typeof bus?.request !== "function" || !sessionPath) return null;

  if (sessionId) {
    try {
      const result = await bus.request("session:get", { sessionId, scope: "all" }, { timeout: 5000 });
      const session = result?.session;
      if (session) {
        notifyResolved(session, sessionPath, onResolved);
        const title = session.title;
        if (typeof title === "string" && title.trim()) return title.trim();
      }
    } catch (error) {
      reportError(onError, error);
    }
  }

  try {
    const result = await bus.request(
      "session:list",
      { scope: "all", lifecycle: "active", ...(agentId ? { agentId } : {}) },
      { timeout: 5000 }
    );
    const wantedPath = normalizeSessionPath(sessionPath);
    const session = (Array.isArray(result?.sessions) ? result.sessions : []).find((entry) =>
      sessionId && entry?.sessionId
        ? entry.sessionId === sessionId
        : normalizeSessionPath(entry?.path || entry?.sessionPath) === wantedPath
    );
    if (!session) {
      reportError(onError, new Error("session:list 中没有匹配当前会话路径的记录"));
      return null;
    }
    notifyResolved(session, sessionPath, onResolved);
    const title = session.title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch (error) {
    reportError(onError, error);
    return null;
  }
}

/** 新会话标题可能在回复完成后异步生成；查不到时短等一次再查。 */
export async function resolveSessionTitleWithRetry(opts = {}) {
  let title = await resolveSessionTitle(opts);
  if (!title) {
    await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? 1500));
    title = await resolveSessionTitle(opts);
  }
  return title;
}
