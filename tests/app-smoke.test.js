// 提个醒 · 应用入口冒烟测试
//
// 目的：在丢给宿主装载之前，先把"apply 能不能跑完、订阅有没有挂上"验掉。
// 上一次栽在这里——省略 ctx.bus.subscribe 的第二个参数，宿主侧读 null.types 抛错，
// 整个应用装载失败、安装记录回滚，只能重启 Hana 重来。这条测试就是钉住那个坑。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply, name } from "../index.js";

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

function makeCtx(dataDir) {
  const seen = { subscribed: null, requests: [], notified: [], services: [] };
  const ctx = {
    dataDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bus: {
      subscribe(callback, filter) {
        seen.subscribed = { callback, filter };
        return () => {};
      },
      handle(service, handler, options) {
        seen.services.push({ service, handler, options });
        return () => {};
      },
      async request(verb, payload) {
        seen.requests.push({ verb, payload });
        return { agents: [{ id: "hanako", name: "小花" }] };
      }
    },
    notifications: {
      async show(input) {
        seen.notified.push(input);
        return { shown: true };
      }
    },
    routes: { register() {} }
  };
  return { ctx, seen };
}

test("apply 能在 mock 宿主下跑完，并且挂上了总线订阅", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-app-"));
  const { ctx, seen } = makeCtx(dir);
  try {
    await apply(ctx);
    assert.ok(seen.subscribed, "应该订阅了总线");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("提个醒注册仅给拾光记使用的专注通知服务", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-app-"));
  const { ctx, seen } = makeCtx(dir);
  try {
    await apply(ctx);
    assert.equal(seen.services.length, 1);
    assert.equal(seen.services[0].service, "focus/notify");
    assert.equal(seen.services[0].options.allowCrossApp, true);
    assert.ok(manifest.capabilities.includes("app/services.provide"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("订阅的第二个参数必须显式给对象（省略会经 RPC 变 null，炸掉装载）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-app-"));
  const { ctx, seen } = makeCtx(dir);
  try {
    await apply(ctx);
    assert.notEqual(seen.subscribed.filter, undefined, "第二个参数不能省");
    assert.notEqual(seen.subscribed.filter, null, "第二个参数不能是 null");
    assert.equal(typeof seen.subscribed.filter, "object");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("apply 期间不调用任何受保护接口（宿主会判定装载失败并回滚安装）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-app-"));
  const { ctx, seen } = makeCtx(dir);
  try {
    await apply(ctx);
    assert.equal(seen.requests.length, 0, "apply 里不能发 bus 请求");
    assert.equal(seen.notified.length, 0, "apply 里不能发系统通知");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("入口导出名与目录名一致", () => {
  assert.equal(name, "tigexing-app");
});
