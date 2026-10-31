// 通知外壳状态：只测纯函数与文件读写，不碰系统注册表、不发通知。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STATUS_MAX_AGE_MS,
  toastStatusFilePath,
  writeToastStatus,
  readToastStatus,
  explainToastStatus
} from '../lib/toast-status.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');

test('状态文件落在应用的 tigexing 目录下', () => {
  const file = toastStatusFilePath('D:\\data\\tigexing-app');
  assert.equal(file, path.join('D:\\data\\tigexing-app', 'tigexing', 'toast-status.json'));
});

test('写入后能读回来，detail 与 stderr 合并、超长截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txs-status-'));
  try {
    const file = toastStatusFilePath(dir);
    assert.equal(writeToastStatus(file, {
      via: 'host',
      kind: 'no-marker',
      detail: '通知进程退出但未确认提交',
      stderr: 'x'.repeat(1000),
      at: '2026-10-31T09:59:00.000Z'
    }), true);
    const read = readToastStatus(file);
    assert.equal(read.via, 'host');
    assert.equal(read.kind, 'no-marker');
    assert.match(read.detail, /^通知进程退出但未确认提交 \| x+/);
    assert.ok(read.detail.length <= 301, 'detail 要截断，别把整个 stderr 塞进去');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不存在或内容坏掉都返回 null，不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txs-status-'));
  try {
    const file = toastStatusFilePath(dir);
    assert.equal(readToastStatus(file), null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ 不是 json', 'utf8');
    assert.equal(readToastStatus(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('走自己的通道 = 正常，不出横幅', () => {
  assert.equal(explainToastStatus({ at: '2026-10-31T09:59:00.000Z', via: 'powershell', kind: 'ok' }, { now: NOW }), null);
});

test('没有记录时不出横幅', () => {
  assert.equal(explainToastStatus(null, { now: NOW }), null);
  assert.equal(explainToastStatus(undefined, { now: NOW }), null);
});

test('时间戳坏掉或超过一天就不提了', () => {
  const base = { via: 'host', kind: 'no-marker' };
  assert.equal(explainToastStatus({ ...base, at: '不是时间' }, { now: NOW }), null);
  assert.equal(explainToastStatus({ ...base, at: '2026-10-30T09:00:00.000Z' }, { now: NOW }), null);
  const justInside = new Date(NOW - STATUS_MAX_AGE_MS + 60000).toISOString();
  assert.ok(explainToastStatus({ ...base, at: justInside }, { now: NOW }), '一天之内要还提示');
});

test('起不了进程 → 指向「运行外部程序」权限', () => {
  const notice = explainToastStatus({
    at: '2026-10-31T09:59:00.000Z', via: 'host', kind: 'spawn-error',
    detail: 'spawn powershell EACCES: permission denied'
  }, { now: NOW });
  assert.equal(notice.action, 'permissions');
  assert.match(notice.hint, /运行外部程序/);
  assert.equal(notice.level, 'warn');
});

test('系统把通知关了 → 指向 Windows 通知设置', () => {
  const notice = explainToastStatus({
    at: '2026-10-31T09:59:00.000Z', via: 'host', kind: 'no-marker',
    detail: 'Windows notification setting: DisabledForApplication'
  }, { now: NOW });
  assert.equal(notice.action, 'windows');
  assert.match(notice.hint, /Windows/);
});

test('脚本缺失 / 超时 / 认不出来，各给各的修法', () => {
  const at = '2026-10-31T09:59:00.000Z';
  assert.equal(explainToastStatus({ at, via: 'failed', kind: 'missing-script' }, { now: NOW }).action, 'reinstall');
  assert.equal(explainToastStatus({ at, via: 'host', kind: 'timeout', detail: '45s 未确认' }, { now: NOW }).action, 'retry');
  assert.equal(explainToastStatus({ at, via: 'host', kind: 'no-marker', detail: '说不清的原因' }, { now: NOW }).action, 'log');
});

test('两条腿都失败也算要提示，不会当成正常', () => {
  const notice = explainToastStatus({ at: '2026-10-31T09:59:00.000Z', via: 'failed', kind: 'spawn-error' }, { now: NOW });
  assert.ok(notice, 'failed 同样要出横幅');
  assert.equal(notice.level, 'warn');
});
