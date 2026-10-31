// 设置页「聊天窗口 / Code 窗口 / 闲聊窗口」三屏切换。
//
// 这里守的是界面结构，不是像素：每一屏必须各有自己的表头、各自的控件 kind，
// Code 和闲聊两屏不许再长出「提醒时机」那一列。第一条用例就是防止有人（包括以后的自己）
// 图省事又把几套配置并回一张宽表——七个下拉挤一行，字全被截掉，等于没配。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");

test("切换器存在，三个按钮各自带 mode", () => {
  assert.match(html, /id="snd-mode-switch"/);
  assert.match(html, /<button type="button" data-mode="chat" aria-selected="true">聊天窗口<\/button>/);
  assert.match(html, /<button type="button" data-mode="code" aria-selected="false">Code 窗口<\/button>/);
  assert.match(html, /<button type="button" data-mode="casual" aria-selected="false">闲聊窗口<\/button>/);
});

test("各屏各自渲染：Code / 闲聊屏只有文案风格和音效，没有提醒时机列", () => {
  // 聊天屏表头：风格 + 音效 + 提醒时机
  assert.match(html, /<span class="col-style">文案风格<\/span><span class="col-sound">音效<\/span><span class="col-trigger">提醒时机<\/span>/);
  // Code / 闲聊屏表头：到音效就结束
  assert.match(html, /<span class="col-style">文案风格<\/span><span class="col-sound">音效<\/span><span class="col-action"/);
  // 不许再出现并排的多列方案（那是被否掉的）
  assert.doesNotMatch(html, /col-code/);
});

test("Code 屏与闲聊屏的控件各写各自的 kind，跟着当前屏走", () => {
  assert.match(html, /data-kind="codeStyle"/);
  assert.match(html, /data-kind="codeSound"/);
  assert.match(html, /data-kind="casualStyle"/);
  assert.match(html, /data-kind="casualSound"/);
  assert.match(html, /var sndMode = "chat"/);
  assert.match(html, /list\.setAttribute\("data-mode", sndMode\)/);
});

test("闲聊屏只渲染主助手那一行：主助手从主进程读到的 primaryAgent 来", () => {
  // 后端把主助手随 /api/sounds 一起发给页面
  assert.match(html, /primaryAgent: r\.primaryAgent \|\| ""/);
  // 闲聊屏按 primaryAgent 过滤，其他伙伴不进这一屏
  assert.match(html, /rows = primary\s*\n?\s*\? sndData\.agents\.filter\(function \(x\) \{ return x\.id === primary; \}\)/);
  // 找不到主助手时要给人话，不能给个空屏
  assert.match(html, /casual-solo-hint/);
});

test("闲聊屏的试听与保存都带 mode=casual", () => {
  assert.match(html, /data-mode="casual">试听/);
  assert.match(html, /isCasualSel \? "casual" : "normal"/);
  assert.match(html, /mode: wantMode \}/);
});

test("设置页主区只是分屏，导航交给宿主的功能面板（nav.html）", () => {
  // 页面里不该再自己造一个侧边栏：导航在 manifest 的 functionPanel 里，挂在 Hana 左栏
  assert.doesNotMatch(html, /<aside class="sidenav">/);
  assert.match(html, /<main class="content">/);
  for (const pane of ["notify", "sound", "copy", "quiet", "about"]) {
    assert.match(html, new RegExp(`<section class="pane" data-pane="${pane}"`), `缺了 ${pane} 那一屏`);
  }
  // 切页只看 hidden，不重建 DOM（控件和已绑事件都得留着）
  assert.match(html, /\.pane\[hidden\] \{ display: none; \}/);
  assert.match(html, /pane\.hidden = !on/);
  // 与左栏面板的握手：BroadcastChannel + postMessage 双路
  assert.match(html, /BroadcastChannel/);
  assert.match(html, /tigexing-panel-view/);
  assert.match(html, /tigexing-pane-state/);
});

test("左栏导航面板存在，且五个视图都有按钮", () => {
  const nav = fs.readFileSync(new URL("../ui/nav.html", import.meta.url), "utf8");
  for (const pane of ["notify", "sound", "copy", "quiet", "about"]) {
    assert.match(nav, new RegExp(`data-pane="${pane}"`), `左栏缺了 ${pane}`);
  }
  assert.match(nav, /BroadcastChannel/);
  assert.match(nav, /tigexing-pane'/);
  // 宿主靠 hana.ready() 判定面板加载成功；不调就是「应用加载失败」
  assert.match(nav, /import \{ hana \} from '\.\/assets\/app-sdk\.js'/);
  assert.match(nav, /hana\.ready\(\)/);
});

test("manifest 把导航面板声明给了宿主", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const card = manifest.contributes.cards.find((item) => item.id === "settings");
  assert.ok(card, "没找到 settings 卡");
  assert.equal(card.fpFullPanel, true);
  assert.equal(card.functionPanel.route, "/nav.html");
  assert.ok(fs.existsSync(new URL("../ui/nav.html", import.meta.url)), "nav.html 不存在");
});

test("head 后面不再重复出现 body 标签", () => {
  assert.doesNotMatch(html, /<\/head>\s*<body>\s*<body>/);
  assert.equal((html.match(/<body>/g) || []).length, 1);
});

test("跟随状态的虚边框真的挂得上去（.dd 是 beautify-select 包出来的容器）", () => {
  assert.match(html, /sel\.closest\("\.dd"\)/);
  assert.match(html, /classList\.toggle\("dd-follow", sel\.value === ""\)/);
  assert.match(html, /\.dd\.dd-follow \.dd-trigger/);
});
