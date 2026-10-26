// 提个醒 · 码点安全截断测试
// 覆盖：2026-10-26 实机 bug —— 润色正文「…一句话就能改哦！」+ 🌿 在 24 字处被切成半个 emoji，
// PowerShell 编码后变成替换字符，弹窗尾巴挂了个「�」方块。

import { test } from "node:test";
import assert from "node:assert/strict";

import { clipCodePoints } from "../lib/text-clip.js";
import { makeSnippet } from "../lib/policy.js";
import { getStyle } from "../lib/style.js";

// 孤立代理（半个 emoji）检测
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("clipCodePoints：短文本原样返回", () => {
  assert.equal(clipCodePoints("方案发你了", 24), "方案发你了");
});

test("clipCodePoints：纯中文按原长度截断（与旧行为一致）", () => {
  assert.equal(clipCodePoints("一二三四五", 3), "一二三…");
});

test("clipCodePoints：不切开 emoji 代理对", () => {
  const text = "六处都改好啦！按新口径报版本，一句话就能改哦！🌿";
  const out = clipCodePoints(text, 24);
  assert.equal(LONE_SURROGATE.test(out), false, "不能留下孤立代理");
  // 24 码点正好装下整句（23 字 + emoji），不该被切
  assert.ok(out.endsWith("🌿"), "整颗 emoji 保留");
});

test("clipCodePoints：emoji 在边界外时整体丢弃并补省略号", () => {
  const out = clipCodePoints("一二三四🌿五六", 4);
  assert.equal(LONE_SURROGATE.test(out), false);
  assert.equal(out, "一二三四…");
});

test("makeSnippet：snippet 截断不切 emoji", () => {
  const out = makeSnippet("改好啦" + "啊".repeat(50) + "🌿", 48);
  assert.equal(LONE_SURROGATE.test(out), false);
});

test("风格正文兜底截断不切 emoji（无标点长句走码点截断）", () => {
  // 无任何标点的长串 + 边界上的 emoji
  const s = getStyle("plain");
  const out = s.body("first", "啊".repeat(17) + "🌿" + "啊".repeat(10), 1);
  assert.equal(LONE_SURROGATE.test(out), false);
});
