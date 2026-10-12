// 提个醒 · 被后台任务挡下的完成回合暂存测试
// 场景来自 2026-10-12 真实故障：turn_end 到达时后台任务还在跑，
// 旧实现直接 return，提醒永久丢失，这里锁住「压下 → 收齐 → 补发」这条链。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeferredTurns, DEFERRED_TURN_TTL_MS } from "../lib/deferred-turns.js";

const info = (sessionId, text) => ({ sessionId, text });

test("暂存：有后台任务时压住，take 取出并清空", () => {
  const t0 = 1_000_000;
  const d = new DeferredTurns();
  assert.equal(d.take("s1"), null);

  d.stash("s1", info("s1", "做完了"), t0);
  assert.equal(d.has("s1"), true);
  assert.equal(d.count("s1"), 1);

  const got = d.take("s1", t0 + 1000);
  assert.equal(got.text, "做完了");
  assert.equal(d.has("s1"), false);
  assert.equal(d.take("s1", t0 + 1000), null);
});

test("暂存：同一会话连压多条只留最后一条，补发不刷屏", () => {
  const t0 = 1_000_000;
  const d = new DeferredTurns();
  d.stash("s1", info("s1", "中间结果"), t0);
  d.stash("s1", info("s1", "最终结果"), t0 + 100);
  assert.equal(d.count("s1"), 1);
  assert.equal(d.take("s1", t0 + 200).text, "最终结果");
});

test("暂存：不同会话互不干扰", () => {
  const d = new DeferredTurns();
  d.stash("s1", info("s1", "a"));
  d.stash("s2", info("s2", "b"));
  assert.equal(d.take("s2").text, "b");
  assert.equal(d.has("s2"), false);
  assert.equal(d.has("s1"), true);
});

test("暂存：压太久就丢弃，避免隔很久突然冒出过期提醒", () => {
  const t0 = 1_000_000;
  const d = new DeferredTurns();
  d.stash("s1", info("s1", "早就凉了"), t0);
  assert.equal(d.take("s1", t0 + DEFERRED_TURN_TTL_MS + 1), null);
  assert.equal(d.has("s1"), false);

  const d2 = new DeferredTurns();
  d2.stash("s1", info("s1", "还在保质期"), t0);
  assert.equal(d2.take("s1", t0 + DEFERRED_TURN_TTL_MS).text, "还在保质期");
});

test("暂存：会话关闭清账，空值不污染", () => {
  const d = new DeferredTurns();
  d.stash("s1", info("s1", "x"));
  assert.equal(d.forget("s1"), true);
  assert.equal(d.has("s1"), false);
  assert.equal(d.forget("s1"), false);
  assert.equal(d.stash("s2", null), false);
  assert.equal(d.stash("", info("", "x")), false);
  assert.equal(d.has("s2"), false);
});