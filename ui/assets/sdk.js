// 提个醒 App 设置页所需的 Hana 同源 API 通道。
// 依照 Hana App SDK 的 hana.api.fetch 契约：从宿主签发的 appSurfaceSession
// 取授权票据，并只访问当前 App 自己的 routes。
(function (targetWindow) {
  "use strict";
  if (targetWindow.hana?.api?.fetch) return;

  var SESSION_HEADER = "X-Hana-App-Surface-Session";
  var SESSION_QUERY = "appSurfaceSession";

  function appIdFromUiRoute() {
    var match = /^\/api\/apps\/([^/]+)\/ui(?:\/|$)/.exec(targetWindow.location.pathname || "");
    if (!match) throw new Error("Hana App API 只能从应用页面调用。");
    try { return decodeURIComponent(match[1]); }
    catch { throw new Error("无法识别当前应用编号。"); }
  }

  function normalizePath(input) {
    if (typeof input !== "string" || input.length === 0) throw new Error("API 路径无效。");
    var trimmed = input.trim();
    if (!trimmed || trimmed.includes("\\") || trimmed.includes("\0") || trimmed.includes("#") || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      throw new Error("API 路径无效。");
    }
    var stripped = trimmed.replace(/^\/+/, "");
    if (!stripped || stripped.startsWith("./") || stripped === "api/apps" || stripped.startsWith("api/apps/")) {
      throw new Error("请使用当前应用内的相对 API 路径。");
    }
    var queryIndex = stripped.indexOf("?");
    var rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
    if (!rawPath) throw new Error("API 路径无效。");
    var segments = rawPath.split("/");
    for (var i = 0; i < segments.length; i++) {
      if (!segments[i]) throw new Error("API 路径无效。");
      var decoded;
      try { decoded = decodeURIComponent(segments[i]); }
      catch { throw new Error("API 路径无效。"); }
      if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
        throw new Error("API 路径无效。");
      }
    }
    var parsed = new URL("http://hana.local/" + stripped);
    var safePath = segments.map(function (segment) {
      return encodeURIComponent(decodeURIComponent(segment));
    }).join("/");
    return safePath + parsed.search;
  }

  function fetchAppRoute(input, init) {
    var session = new URLSearchParams(targetWindow.location.search).get(SESSION_QUERY);
    if (!session) throw new Error("Hana 没有为此页面提供应用授权，请重新打开设置页。");
    var headers = new Headers((init || {}).headers);
    headers.set(SESSION_HEADER, session);
    var url = targetWindow.location.origin + "/api/apps/" + encodeURIComponent(appIdFromUiRoute()) + "/routes/" + normalizePath(input);
    return targetWindow.fetch(url, Object.assign({}, init || {}, { headers: headers }));
  }

  targetWindow.hana = targetWindow.hana || {};
  targetWindow.hana.api = Object.assign({}, targetWindow.hana.api || {}, { fetch: fetchAppRoute });
})(window);
