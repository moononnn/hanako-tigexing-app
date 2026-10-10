// 提个醒 · 分享版入口接入回归
// 保护检查更新 / 反馈积木的路由、页面挂载点和凭证适配不被后续翻新删掉。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 设置页是 App 自己的静态页：页面断言读 PAGE，接口断言读 ROUTE
const PAGE = fs.readFileSync(path.join(ROOT, "ui", "settings.html"), "utf8");
const ROUTE = fs.readFileSync(path.join(ROOT, "routes", "api.js"), "utf8");
const FEEDBACK_UI = fs.readFileSync(path.join(ROOT, "lib", "feedback", "ui", "feedback.js"), "utf8");
const FEEDBACK_CSS = fs.readFileSync(path.join(ROOT, "lib", "feedback", "ui", "feedback.css"), "utf8");

test("分享入口：页面保留检查更新和反馈的自然落点", () => {
  assert.match(PAGE, /class="card support-card"/);
  assert.match(PAGE, /关于提个醒/);
  assert.match(PAGE, /id="feedback-entry"/);
  assert.match(PAGE, /aria-haspopup="dialog"/);
  assert.match(PAGE, /openerId: "feedback-entry"/);
  // 积木的 HTML 已内联在页面里，不再靠服务端取
  assert.match(PAGE, /uc-|update-checker|检查更新/);
  assert.match(PAGE, /fb-open-btn|tg-feedback/);
});

test("分享入口：后端注册更新检查和反馈聊天路由", () => {
  assert.match(ROUTE, /app\.get\("\/api\/check-update"/);
  assert.match(ROUTE, /app\.post\("\/api\/feedback\/chat"/);
  assert.match(ROUTE, /app\.post\("\/api\/feedback\/chat\/close"/);
});

test("计划任务接管：页面保留总开关、关闭态说明和禁用态容器", () => {
  assert.match(PAGE, /id="sw-scheduled-takeover"/);
  assert.match(PAGE, /id="scheduled-off-note"/);
  assert.match(PAGE, /id="scheduled-options"/);
  assert.match(PAGE, /scheduledTakeover/);
  assert.match(PAGE, /role="switch" aria-checked=/);
});

test("分享入口：反馈弹窗脱离会 hover 的卡片，保持 fixed 定位稳定", () => {
  assert.match(PAGE, /反馈弹窗放在卡片外/);
  assert.match(PAGE, /#fb-open-btn \{ display:none; \}/);
  assert.match(FEEDBACK_UI, /class="tg-feedback-modal"/);
  assert.match(FEEDBACK_UI, /class="tg-feedback-dialog"/);
  assert.match(FEEDBACK_UI, /role="dialog" aria-modal="true"/);
  assert.match(FEEDBACK_UI, /Escape/);
});

test("分享入口：反馈弹窗使用新外壳，纯色柔和圆角且无灰影", () => {
  assert.match(FEEDBACK_UI, /tg-feedback-backdrop/);
  assert.doesNotMatch(FEEDBACK_UI, /class="fb-modal/);
  assert.doesNotMatch(PAGE, /\.fb-modal-panel/);
  assert.match(FEEDBACK_CSS, /\.tg-feedback-dialog \{[\s\S]*background-color: var\(--card/);
  assert.match(FEEDBACK_CSS, /border: 0;[\s\S]*border-radius: 18px;[\s\S]*box-shadow: none;[\s\S]*filter: none;/);
});

test("分享入口：积木请求拿到原始 Response，避免二次 json 解析", () => {
  assert.match(PAGE, /function rawApi\(path, init\)/);
  assert.match(PAGE, /apiFetch: rawApi/);
  assert.match(PAGE, /function api\(path, init\)\s*\{\s*return rawApi\(path, init\)/s);
});

test("分享入口：页面取数只走宿主 SDK，不带插件前缀与 token", () => {
  assert.match(PAGE, /window\.hana\.api\.fetch/);
  assert.doesNotMatch(PAGE, /\/api\/plugins\//);
  assert.doesNotMatch(PAGE, /legacyToken|surfaceSession/);
  assert.doesNotMatch(PAGE, /window\.__CFG__ = \{/);
});

test("分享入口：默认公开仓库已配置，未配置时明确降级，不伪造仓库地址", () => {
  // 发布后默认指向公开仓库；环境变量可覆盖（测试/自用换仓库用）
  assert.match(ROUTE, /const GITHUB_REPO = process\.env\.TIGEXING_GITHUB_REPO \|\| "moononnn\/Hanako-tigexing"/);
  // 降级分支仍保留（环境变量被清空时兜底）
  assert.match(ROUTE, /公开仓库还没配置/);
});
