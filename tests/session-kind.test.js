// 会话分区（普通窗口 / Code 页窗口）与 Code 专用文案音效。
//
// 这组用例守两件事：
//   1) 只有 session:get 返回的 namespace 能区分 Code 窗口，判不出来时必须退回普通窗口；
//   2) Code 窗口没单独配置时，必须跟普通窗口完全一样（默认状态不能变味）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeMarker,
  createSessionMetaResolver,
  isCodeSession,
  pickSoundId,
  pickStyleId
} from "../lib/session-kind.js";
import { normalizeConfig } from "../lib/config.js";

function fakeBus(reply) {
  const calls = [];
  return {
    calls,
    async request(name, payload) {
      calls.push({ name, payload });
      if (typeof reply === "function") return reply(name, payload);
      return reply;
    }
  };
}

test("session:get 的 namespace=code 认作 Code 窗口", async () => {
  const bus = fakeBus({ session: { namespace: "code", title: "改个提醒" } });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: "sess_code" });
  assert.equal(meta.namespace, "code");
  assert.equal(meta.title, "改个提醒");
  assert.equal(isCodeSession(meta.namespace), true);
  assert.equal(codeMarker(meta.namespace), "〔Code〕");
  assert.equal(bus.calls[0].name, "session:get");
  assert.equal(bus.calls[0].payload.sessionId, "sess_code");
});

test("没有 sessionId 时退回按会话路径查", async () => {
  const bus = fakeBus({ session: { namespace: "code" } });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionPath: "D:\\hana\\agents\\hanako\\sessions\\x.jsonl" });
  assert.equal(meta.namespace, "code");
  assert.equal(bus.calls[0].payload.legacySessionPath, "D:\\hana\\agents\\hanako\\sessions\\x.jsonl");
});

test("事件里的 sessionId 是会话文件名，直接问拿不到时改按路径再问一次", async () => {
  const legacyId = "2026-10-25T01-36-23-921Z_01a170b3-a571-7407-be32-a2239789a733";
  const sessionPath = "D:\\hana\\agents\\hanako\\sessions\\" + legacyId + ".jsonl";
  const bus = fakeBus((name, payload) => {
    if (payload.sessionId) throw new Error("session_manifest_ref_required");
    return { session: { namespace: "code", title: "改代码" } };
  });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: legacyId, sessionPath });
  assert.equal(meta.namespace, "code");
  assert.equal(meta.title, "改代码");
  assert.equal(bus.calls.length, 2);
  assert.equal(bus.calls[1].payload.legacySessionPath, sessionPath);
});

test("普通窗口不加记号", async () => {
  const bus = fakeBus({ session: { namespace: "home", title: "闲聊" } });
  const resolve = createSessionMetaResolver({ bus });
  const meta = await resolve({ sessionId: "sess_home" });
  assert.equal(meta.namespace, "home");
  assert.equal(isCodeSession(meta.namespace), false);
  assert.equal(codeMarker(meta.namespace), "");
  assert.equal(codeMarker(""), "");
  assert.equal(codeMarker(undefined), "");
  assert.equal(isCodeSession("app"), false);
});

test("查询失败不抛错，按普通窗口处理，失败只短暂缓存", async () => {
  let attempt = 0;
  const bus = fakeBus(() => {
    attempt += 1;
    if (attempt <= 2) throw new Error("bus timeout");
    return { session: { namespace: "code" } };
  });
  const resolve = createSessionMetaResolver({ bus });
  const sessionPath = "D:\\hana\\agents\\hanako\\sessions\\y.jsonl";
  const first = await resolve({ sessionId: "sess_retry", sessionPath });
  assert.equal(first.namespace, "", "两条路都失败就当作普通窗口");
  assert.equal(first.title, "");
  // 负结果保鲜期内不再白问：同一会话两次调用只打一轮请求（sessionId + 路径各一次）。
  const second = await resolve({ sessionId: "sess_retry", sessionPath });
  assert.equal(second.namespace, "", "保鲜期内仍按普通窗口处理");
  assert.equal(bus.calls.length, 2, "失败结果要缓存，别每回合重问");
});

test("负缓存过期后会重新查，能自己恢复", async () => {
  let attempt = 0;
  const bus = fakeBus(() => {
    attempt += 1;
    if (attempt <= 2) throw new Error("bus timeout");
    return { session: { namespace: "code" } };
  });
  const resolve = createSessionMetaResolver({ bus, negativeTtlMs: 1 });
  const sessionPath = "D:\\hana\\agents\\hanako\\sessions\\z.jsonl";
  assert.equal((await resolve({ sessionId: "sess_expire", sessionPath })).namespace, "");
  await new Promise((done) => setTimeout(done, 10));
  assert.equal((await resolve({ sessionId: "sess_expire", sessionPath })).namespace, "code", "过期后要能查到");
});

test("negativeTtlMs=0 时完全不缓存失败", async () => {
  let attempt = 0;
  const bus = fakeBus(() => {
    attempt += 1;
    if (attempt <= 2) throw new Error("bus timeout");
    return { session: { namespace: "code" } };
  });
  const resolve = createSessionMetaResolver({ bus, negativeTtlMs: 0 });
  const sessionPath = "D:\\hana\\agents\\hanako\\sessions\\w.jsonl";
  assert.equal((await resolve({ sessionId: "sess_nocache", sessionPath })).namespace, "");
  assert.equal((await resolve({ sessionId: "sess_nocache", sessionPath })).namespace, "code");
});

test("同一会话只查一次", async () => {
  const bus = fakeBus({ session: { namespace: "code", title: "同名" } });
  const resolve = createSessionMetaResolver({ bus });
  await resolve({ sessionId: "sess_cache" });
  await resolve({ sessionId: "sess_cache" });
  assert.equal(bus.calls.length, 1);
});

test("没有 bus 时不炸，直接返回空", async () => {
  const resolve = createSessionMetaResolver({});
  const meta = await resolve({ sessionId: "sess_nobus" });
  assert.deepEqual(meta, { namespace: "", title: "" });
});

test("Code 窗口的风格音效：配了用自己的，没配跟随普通", () => {
  const styles = { hanako: "gentle" };
  const codeStyles = { hanako: "plain" };
  const sounds = { hanako: "a.wav" };
  const codeSounds = { hanako: "b.wav" };

  // 配了 → 用自己的
  assert.equal(pickStyleId({ inCode: true, agentId: "hanako", codeStyles, styles }), "plain");
  assert.equal(pickSoundId({ inCode: true, agentId: "hanako", codeSounds, sounds }), "b.wav");

  // 没配 → 跟普通一样
  assert.equal(pickStyleId({ inCode: true, agentId: "agent_b", codeStyles, styles }), "default");
  assert.equal(pickSoundId({ inCode: true, agentId: "agent_b", codeSounds, sounds }), "default");

  // 普通窗口永远不看 Code 那栏
  assert.equal(pickStyleId({ inCode: false, agentId: "hanako", codeStyles, styles }), "gentle");
  assert.equal(pickSoundId({ inCode: false, agentId: "hanako", codeSounds, sounds }), "a.wav");
});

test("闲聊窗口的风格音效：配了用自己的，没配跟随聊天窗口", () => {
  const styles = { hanako: "gentle" };
  const casualStyles = { hanako: "cheerful" };
  const sounds = { hanako: "a.wav" };
  const casualSounds = { hanako: "c.wav" };

  assert.equal(pickStyleId({ inCasual: true, agentId: "hanako", casualStyles, styles }), "cheerful");
  assert.equal(pickSoundId({ inCasual: true, agentId: "hanako", casualSounds, sounds }), "c.wav");

  // 没配 → 跟聊天窗口一样
  assert.equal(pickStyleId({ inCasual: true, agentId: "agent_b", casualStyles, styles }), "default");
  assert.equal(pickSoundId({ inCasual: true, agentId: "agent_b", casualSounds, sounds }), "default");

  // 聊天窗口永远不看闲聊那栏
  assert.equal(pickStyleId({ agentId: "hanako", casualStyles, styles }), "gentle");
  assert.equal(pickSoundId({ agentId: "hanako", casualSounds, sounds }), "a.wav");
});

test("闲聊那两栏同样走白名单，且老配置补成空对象", () => {
  const cfg = normalizeConfig({
    agentCasualStyles: { hanako: "default", agent_b: "not_a_style" },
    agentCasualSounds: { hanako: "my.wav", agent_b: "silent", agent_c: "default" }
  });
  assert.deepEqual(cfg.agentCasualStyles, { hanako: "default" });
  assert.deepEqual(cfg.agentCasualSounds, { hanako: "my.wav", agent_b: "silent", agent_c: "default" });

  const legacy = normalizeConfig({ agentStyles: { hanako: "default" } });
  assert.deepEqual(legacy.agentCasualStyles, {});
  assert.deepEqual(legacy.agentCasualSounds, {});

  for (const bad of [[], "casual", 42, null]) {
    const c = normalizeConfig({ agentCasualStyles: bad, agentCasualSounds: bad });
    assert.deepEqual(c.agentCasualStyles, {});
    assert.deepEqual(c.agentCasualSounds, {});
  }
});

test("Code 那两栏的配置走白名单，脏值不落盘", () => {
  const cfg = normalizeConfig({
    agentCodeStyles: { hanako: "default", agent_b: "not_a_style", "" : "default" },
    agentCodeSounds: { hanako: "my.wav", agent_b: "silent", agent_c: "default" }
  });
  assert.deepEqual(cfg.agentCodeStyles, { hanako: "default" });
  assert.deepEqual(cfg.agentCodeSounds, { hanako: "my.wav", agent_b: "silent", agent_c: "default" });
});

test("老配置没有 Code 字段时补成空对象（全部跟随普通）", () => {
  const cfg = normalizeConfig({ agentStyles: { hanako: "default" }, agentSounds: { hanako: "default" } });
  assert.deepEqual(cfg.agentCodeStyles, {});
  assert.deepEqual(cfg.agentCodeSounds, {});
});

test("Code 字段传成数组或字符串时忽略，不破坏配置", () => {
  for (const bad of [[], "code", 42, null]) {
    const cfg = normalizeConfig({ agentCodeStyles: bad, agentCodeSounds: bad });
    assert.deepEqual(cfg.agentCodeStyles, {});
    assert.deepEqual(cfg.agentCodeSounds, {});
  }
});
