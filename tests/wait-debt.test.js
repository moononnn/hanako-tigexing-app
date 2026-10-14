// 提个醒 · 「叫醒还欠着」纯逻辑测试
//
// 锁的是 2026-10-13 实机探针取证到的真实事件形状：wait_finished 之后
// registration.notification.state === 'pending'，而 turn_end 可能在这之后 15～23 秒才到。
// 那一刻后台任务计数已经归零，旧门卫读 0 误判成「说完了」，提前弹了通知。

import { test } from "node:test";
import assert from "node:assert/strict";

import { WaitDebtTracker, parseWaitDebt, WAIT_DEBT_TTL_MS } from "../lib/wait-debt.js";

// 会话路径与标识都换成同形状的合成值：取证拿到的是真实字段形状，
// 但真实路径与真实会话编号不进仓库。
const SESSION_PATH = "C:/agentdata/hanako/agents/hanako/sessions/2026-01-01T00-00-00Z_00000000-0000-4000-8000-000000000000.jsonl";
const SESSION_ID = "2026-01-01T00-00-00Z_00000000-0000-4000-8000-000000000000";

/** 按实机抓到的字段形状伪造 wait_finished。 */
function waitFinished(state) {
  return {
    type: "wait_finished",
    registration: {
      waitId: "wait:00000000-0000-4000-8000-000000000001",
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      agentId: "hanako",
      taskIds: ["terminal:term_0000000000000000000000"],
      taskStates: { "terminal:term_0000000000000000000000": "settled" },
      status: "settled",
      settledAt: 1791935900811,
      resultSummary: { taskStatuses: { "terminal:term_0000000000000000000000": "resolved" }, hasFailure: false },
      notification: state == null ? undefined : {
        state,
        deliveryId: "wait-result:wait:00000000:00000000-0000-4000-8000-000000000002",
        attentionTaskIds: ["terminal:term_0000000000000000000000"],
        memberIdentities: {}
      }
    }
  };
}

test("pending 的 wait_finished 认得出叫醒欠着，会话键和 turn_end 那一套一致", () => {
  const debt = parseWaitDebt(waitFinished("pending"), SESSION_PATH);
  assert.ok(debt, "pending 应该被认成欠账");
  assert.equal(debt.sessionId, SESSION_ID, "会话键必须等于 turn_end 用的那个（文件名去 .jsonl）");
  assert.equal(debt.waitId, "wait:00000000-0000-4000-8000-000000000001");
});

test("已投递或已撤销的 wait_finished 不算欠账", () => {
  for (const state of ["delivered", "done", "revoked", "consumed"]) {
    assert.equal(parseWaitDebt(waitFinished(state), SESSION_PATH), null, `${state} 不该压住提醒`);
  }
});

test("没有 notification 层或事件形状不对时不误判", () => {
  assert.equal(parseWaitDebt(waitFinished(null), SESSION_PATH), null, "没有 notification 层不算欠账");
  assert.equal(parseWaitDebt({ type: "wait_started", registration: {} }, SESSION_PATH), null);
  assert.equal(parseWaitDebt(null, SESSION_PATH), null);
  assert.equal(parseWaitDebt("不是对象", SESSION_PATH), null);
});

test("拿不到会话键时宁可不算，也不乱压", () => {
  const event = waitFinished("pending");
  delete event.registration.sessionId;
  event.registration.sessionPath = "";
  assert.equal(parseWaitDebt(event, ""), null);
});

test("记一笔后 has/count 生效，turn_start 清账后归零", () => {
  const t = new WaitDebtTracker();
  assert.equal(t.has(SESSION_ID), false);
  assert.equal(t.mark(SESSION_ID, "wait:a", 1000), true);
  assert.equal(t.has(SESSION_ID), true);
  assert.equal(t.count(SESSION_ID), 1);
  assert.equal(t.clear(SESSION_ID), true);
  assert.equal(t.has(SESSION_ID), false);
  assert.equal(t.count(SESSION_ID), 0);
});

test("同一会话多笔欠账会累加，清账一次全清", () => {
  const t = new WaitDebtTracker();
  t.mark("s1", "wait:a", 1000);
  t.mark("s1", "wait:b", 1000);
  t.mark("s2", "wait:c", 1000);
  assert.equal(t.count("s1"), 2);
  assert.equal(t.count("s2"), 1);
  t.clear("s1");
  assert.equal(t.count("s1"), 0);
  assert.equal(t.count("s2"), 1, "清一个会话不能影响别的");
});

// 语义锁定：销账是「按会话全清」，不是按 waitId 精确销。
// 现在只有一次 turn_start 能证明一个叫醒落地，同一会话的其他欠账会跟着一起解除。
// 将来谁把 clear 改成按 waitId 精确清除，这就是行为变更，要连测试一起改。
test("语义锁定：销账按会话全清，不按 waitId 精确销", () => {
  const t = new WaitDebtTracker();
  t.mark("s1", "wait:a", 1000);
  t.mark("s1", "wait:b", 1000);
  t.clear("s1");
  assert.equal(t.count("s1"), 0, "两笔欠账应同时销掉");
});

test("缺 waitId 或 sessionId 的脏数据不记，避免占着不放", () => {
  const t = new WaitDebtTracker();
  assert.equal(t.mark("", "wait:a", 1000), false);
  assert.equal(t.mark("s1", "", 1000), false);
  assert.equal(t.count("s1"), 0);
  assert.equal(t.has(""), false);
});

test("超时兜底：超过 TTL 才释放，且报得出是哪几笔", () => {
  const t = new WaitDebtTracker({ ttlMs: 1000 });
  t.mark("s1", "wait:stale", 1000);
  t.mark("s1", "wait:fresh", 2001);
  const dead = t.prune("s1", 2500);
  assert.deepEqual(dead, ["wait:stale"], "只释放真正超时的");
  assert.equal(t.has("s1"), true, "还欠着的要留着");
  const rest = t.prune("s1", 3200);
  assert.deepEqual(rest, ["wait:fresh"]);
  assert.equal(t.has("s1"), false, "全清后不留空壳");
});

test("TTL 默认 90 秒：余量是在最差观察值（23 秒）上留的，不是宽裕数字", () => {
  assert.equal(WAIT_DEBT_TTL_MS, 90 * 1000);
  // 实测：会话空闲时约 50 毫秒；会话忙时 15.5 秒；2026-10-13 当晚 23 秒。
  // 余量不到 4 倍，改这个数必须重新跑实机，不能拿“反正很宽松”说服人。
  assert.ok(WAIT_DEBT_TTL_MS > 23 * 1000, "至少得盖过实测最长的那次 pending");
});

test("会话关闭要能清账，别留给下一个同名会话", () => {
  const t = new WaitDebtTracker();
  t.mark("s1", "wait:a", 1000);
  assert.equal(t.forget("s1"), true);
  assert.equal(t.has("s1"), false);
});

test("clearAll 清空全部", () => {
  const t = new WaitDebtTracker();
  t.mark("s1", "wait:a", 1000);
  t.mark("s2", "wait:b", 1000);
  t.clearAll();
  assert.equal(t.count("s1"), 0);
  assert.equal(t.count("s2"), 0);
});