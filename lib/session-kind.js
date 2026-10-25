// 提个醒 · 会话分区判断（普通窗口 / Code 页窗口）
//
// 为什么必须单查：Code 页的会话不在 session:list 的名单里（2026-10-25 实机确认），
// 只有 session:get 查得到，而且只有它返回的 namespace 带分区标记（home / code / app）。
// session:list 的字段（path / title / kind / visibility / ownerPluginId…）里没有任何
// 一项能区分 Code 窗口：普通会话的 kind 一律为空，cwd 两边都可能指向同一个工作台。
//
// 顺带解决一个老问题：Code 会话的标题以前查不到（它不在 session:list 名单里），
// 标题前缀是空的。同一个 session:get 就带着 title，一次请求两件事一起拿。
//
// 判不出来时一律当普通窗口：宁可少标一个记号，也不能把普通提醒误标成代码窗口。

const CACHE_MAX = 200;
// 会话落在哪个分区是创建时定死的，中途不会变，所以缓存可以一直用；
// 留一个保鲜期，宿主重启后 session 对象重造时能自然失效。
const CACHE_TTL_MS = 30 * 60 * 1000;

const EMPTY = Object.freeze({ namespace: "", title: "" });

/**
 * 创建会话信息解析器。
 * @param {{bus?:object,debug?:(line:string)=>void}} opts
 * @returns {(input:{sessionId?:string,sessionPath?:string,timeoutMs?:number}) => Promise<{namespace:string,title:string}>}
 *   namespace 为 'home' / 'code' / 'app'，判不出来是空字符串。
 */
export function createSessionMetaResolver({ bus, debug } = {}) {
  const cache = new Map();

  function remember(key, value) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, at: Date.now() });
  }

  return async function resolveSessionMeta({ sessionId, sessionPath, timeoutMs = 2500 } = {}) {
    const id = String(sessionId || "").trim();
    const file = String(sessionPath || "").trim();
    const key = id || file;
    if (!key) return EMPTY;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    if (typeof bus?.request !== "function") return EMPTY;

    // 宿主两种参数都认；有 sessionId 优先用它，没有就退回会话路径。
    // 注意：总线事件里的 sessionId 是会话文件名（时间戳_UUID），不是宿主的 sess_xxx；
    // 拿它直接问会失败，所以宁可多试一次，也不能让分区判断变成一场空。
    const attempts = [];
    if (id && id !== "unknown") attempts.push({ sessionId: id, scope: "all" });
    if (file) attempts.push({ legacySessionPath: file, scope: "all" });

    for (const payload of attempts) {
      try {
        const result = await bus.request("session:get", payload, { timeout: timeoutMs });
        const session = result?.session || result;
        const meta = {
          namespace: String(session?.namespace || "").trim(),
          title: typeof session?.title === "string" ? session.title.trim() : ""
        };
        if (meta.namespace || meta.title) {
          remember(key, meta);
          if (file && file !== key) remember(file, meta);
          return meta;
        }
      } catch (error) {
        debug?.("会话分区判断失败：" + (error?.message || error));
      }
    }
    // 查不到不等于出了错：提醒照旧弹，只是按普通窗口处理。
    return EMPTY;
  };
}

/** 是否是 Code 页窗口。 */
export function isCodeSession(namespace) {
  return String(namespace || "").trim() === "code";
}

/**
 * 选文案风格：Code 窗口优先用它自己的设置，没配就跟随普通窗口。
 * 两条路都没配 → 'default'。
 */
export function pickStyleId({ inCode, agentId, codeStyles, styles } = {}) {
  const id = String(agentId || "");
  if (inCode) {
    const own = (codeStyles || {})[id];
    if (own) return own;
  }
  return (styles || {})[id] || "default";
}

/** 选音效：口径同风格，Code 窗口没单独配就跟普通窗口一样。 */
export function pickSoundId({ inCode, agentId, codeSounds, sounds } = {}) {
  const id = String(agentId || "");
  if (inCode) {
    const own = (codeSounds || {})[id];
    if (own) return own;
  }
  return (sounds || {})[id] || "default";
}

/**
 * Code 窗口的标题标记。放在会话标题前面，让人一眼看出这条提醒来自代码窗口。
 * @param {string} namespace session:get 返回的分区
 */
export function codeMarker(namespace) {
  return isCodeSession(namespace) ? "〔Code〕" : "";
}
