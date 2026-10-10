// 提个醒 · HANA_HOME 推算测试
// App 进程不直接探测 agents 目录；用宿主给的 dataDir 确定本机 Hana 根路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHanaHome } from "../index.js";

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-home-"));
  const appDir = path.join(home, "apps", "tigexing-app");
  const dataDir = path.join(home, "app-data", "tigexing-app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { home, appDir, dataDir };
}

test("优先从宿主提供的 dataDir 回推 HANA_HOME", () => {
  const { home, appDir, dataDir } = makeHome();
  const saved = process.env.HANA_HOME;
  try {
    delete process.env.HANA_HOME;
    assert.equal(resolveHanaHome(dataDir, appDir), home);
  } finally {
    if (saved !== undefined) process.env.HANA_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("环境变量给的 HANA_HOME 优先", () => {
  const envHome = makeHome();
  const { home, appDir, dataDir } = makeHome();
  const saved = process.env.HANA_HOME;
  try {
    process.env.HANA_HOME = envHome.home;
    assert.equal(resolveHanaHome(dataDir, appDir), envHome.home);
  } finally {
    if (saved !== undefined) process.env.HANA_HOME = saved;
    else delete process.env.HANA_HOME;
    fs.rmSync(envHome.home, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("没有 dataDir 时才从安装目录回推", () => {
  const { home, appDir } = makeHome();
  const saved = process.env.HANA_HOME;
  try {
    delete process.env.HANA_HOME;
    assert.equal(resolveHanaHome("", appDir), home);
  } finally {
    if (saved !== undefined) process.env.HANA_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
