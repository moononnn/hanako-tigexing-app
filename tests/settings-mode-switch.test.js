// 设置页「聊天窗口 / Code 窗口」两屏切换。
//
// 这里守的是界面结构，不是像素：两屏必须各有自己的表头、各自的控件 kind，
// Code 屏不许再长出「提醒时机」那一列。第一条用例就是防止有人（包括以后的自己）
// 图省事又把两套配置并回一张宽表——七个下拉挤一行，字全被截掉，等于没配。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../ui/settings.html", import.meta.url), "utf8");

test("切换器存在，两个按钮各自带 mode", () => {
  assert.match(html, /id="snd-mode-switch"/);
  assert.match(html, /<button type="button" data-mode="chat" aria-selected="true">聊天窗口<\/button>/);
  assert.match(html, /<button type="button" data-mode="code" aria-selected="false">Code 窗口<\/button>/);
});

test("两屏各自渲染：Code 屏只有文案风格和音效，没有提醒时机列", () => {
  // 聊天屏表头：风格 + 音效 + 提醒时机
  assert.match(html, /<span class="col-style">文案风格<\/span><span class="col-sound">音效<\/span><span class="col-trigger">提醒时机<\/span>/);
  // Code 屏表头：到音效就结束
  assert.match(html, /<span class="col-style">文案风格<\/span><span class="col-sound">音效<\/span><span class="col-action"/);
  // 不许再出现并排的 Code 列（那是被否掉的方案）
  assert.doesNotMatch(html, /col-code/);
});

test("Code 屏的控件只写 Code 那两个 kind，跟着当前屏走", () => {
  assert.match(html, /data-kind="codeStyle"/);
  assert.match(html, /data-kind="codeSound"/);
  assert.match(html, /var sndMode = "chat"/);
  assert.match(html, /list\.setAttribute\("data-mode", sndMode\)/);
});

test("跟随状态的虚边框真的挂得上去（.dd 是 beautify-select 包出来的容器）", () => {
  assert.match(html, /sel\.closest\("\.dd"\)/);
  assert.match(html, /classList\.toggle\("dd-follow", sel\.value === ""\)/);
  assert.match(html, /\.dd\.dd-follow \.dd-trigger/);
});
