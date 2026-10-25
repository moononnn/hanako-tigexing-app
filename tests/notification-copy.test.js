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

const NOTICE = "等太久了，先叫你一声";

test("兜底提示排在正文末尾，不盖住伙伴的话", async () => {
  const result = await buildNotificationCopy({
    ...base,
    enabled: false,
    notice: NOTICE
  });
  assert.ok(result.body.endsWith(NOTICE), "提示必须在末尾");
  assert.equal(result.body.slice(-NOTICE.length - 1, -NOTICE.length), " ", "提示前留一个空格，不粘在原话上");
  assert.ok(!result.body.startsWith(NOTICE), "不能回到正文最前");
});

test("带提示时正文让出字数，总长仍装得下横幅两行", async () => {
  const result = await buildNotificationCopy({
    ...base,
    enabled: false,
    snippet: "开关显示不再犯迷糊，配置没动，21项测试全过啦",
    notice: NOTICE
  });
  assert.ok(result.body.length <= 30, `总长不该被撑爆：${result.body}`);
  assert.ok(result.body.endsWith(NOTICE), "让字数也不能把提示挤掉");
  assert.match(result.body, /…/, "正文过长要截断并留省略号");
});

test("提示同样追加到润色后的正文末尾", async () => {
  const result = await buildNotificationCopy({
    ...base,
    enabled: true,
    notice: NOTICE,
    modelConfig: {
      async sample() { return '{"title":"小花把提醒修好啦","body":"设置现在能正常保存啦，界面也不犯迷糊了"}'; }
    }
  });
  assert.equal(result.refined, true);
  assert.ok(result.body.endsWith(NOTICE), "润色路径也要追加到末尾");
});
