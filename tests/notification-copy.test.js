// 提个醒 · 通知润色实际接入测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNotificationCopy } from "../lib/notification-copy.js";
import { STYLES } from "../lib/style.js";

const base = {
  style: STYLES.ac_timmy,
  kind: "first",
  agentName: "小花",
  snippet: "接口修好了，设置页现在能正常保存。",
  count: 1,
  sessionTitle: "提个醒调试"
};

test("开启润色时调用已选模型，替换标题和正文并保留会话前缀", async () => {
  const calls = [];
  const result = await buildNotificationCopy({
    ...base,
    enabled: true,
    modelConfig: { async sample(messages, options) { calls.push({ messages, options }); return '{"title":"小花把提醒修好啦","body":"设置现在能正常保存啦"}'; } }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.retryOnEmpty, false, "外层仅做一次有明确改写提示的重试");
  assert.equal(result.refined, true);
  assert.equal(result.title, "提个醒调试 · 小花把提醒修好啦");
  assert.equal(result.body, "设置现在能正常保存啦");
});

test("润色关闭时不调用模型，使用规则模板", async () => {
  let calls = 0;
  const result = await buildNotificationCopy({
    ...base,
    enabled: false,
    modelConfig: { async sample() { calls += 1; return "{}"; } }
  });
  assert.equal(calls, 0);
  assert.equal(result.refined, false);
  assert.equal(result.title, "提个醒调试 · 豆狸：小花 回你啦！粒狸：快去看！");
  assert.equal(result.body, base.snippet);
});

test("模型失败时回退规则文案并保留错误供运行日志记录", async () => {
  const error = new Error("模型超时");
  const result = await buildNotificationCopy({
    ...base,
    enabled: true,
    modelConfig: { async sample() { throw error; } }
  });
  assert.equal(result.refined, false);
  assert.equal(result.refineError, error);
  assert.equal(result.title, "提个醒调试 · 豆狸：小花 回你啦！粒狸：快去看！");
  assert.equal(result.body, base.snippet);
});

test("格式型风格不参与润色", async () => {
  let calls = 0;
  const result = await buildNotificationCopy({
    ...base,
    style: STYLES.morse,
    enabled: true,
    modelConfig: { async sample() { calls += 1; return "{}"; } }
  });
  assert.equal(calls, 0);
  assert.equal(result.refined, false);
});
