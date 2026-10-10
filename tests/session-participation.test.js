import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionParticipation } from '../lib/session-participation.js';

function withDir(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tigexing-participation-'));
  try { run(dataDir); } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('真实参与标记跨重载恢复；未参与的后台会话仍不能通过', () => withDir((dataDir) => {
  const before = new SessionParticipation({ dataDir });
  assert.equal(before.has('human-session'), false);
  before.mark('human-session');
  const after = new SessionParticipation({ dataDir });
  assert.equal(after.has('human-session'), true);
  assert.equal(after.has('background-session'), false);
}));

test('首次安装空记录不把所有活跃会话当用户参与', () => withDir((dataDir) => {
  const tracker = new SessionParticipation({ dataDir });
  assert.equal(tracker.has('existing-session'), false);
  assert.equal(fs.existsSync(tracker.file), false);
}));

test('重复消息不重复保存参与状态', () => withDir((dataDir) => {
  const tracker = new SessionParticipation({ dataDir });
  tracker.mark('human-session');
  const original = fs.readFileSync(tracker.file, 'utf8');
  tracker.mark('human-session');
  assert.equal(fs.readFileSync(tracker.file, 'utf8'), original);
  assert.equal(tracker.sessions.size, 1);
}));

test('空身份和unknown不进入持久标记', () => withDir((dataDir) => {
  const tracker = new SessionParticipation({ dataDir });
  tracker.mark(''); tracker.mark('unknown');
  assert.equal(tracker.sessions.size, 0);
}));

test('损坏的旧参与记录不被新消息覆盖', () => withDir((dataDir) => {
  fs.mkdirSync(path.join(dataDir, 'tigexing'));
  const file = path.join(dataDir, 'tigexing', 'session-participation.json');
  fs.writeFileSync(file, '{broken');
  const errors = [];
  const tracker = new SessionParticipation({ dataDir, onError: (error) => errors.push(error) });
  tracker.mark('human-session');
  assert.equal(tracker.has('human-session'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(errors.length, 1);
}));

test('用户事件落参与标记，入口过滤使用持久状态', () => {
  const entry = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /new SessionParticipation/);
  assert.match(entry, /participation\.mark\(sid\)/);
  assert.match(entry, /participation\.has\(sessionId\)/);
  assert.doesNotMatch(entry, /lastUserMsgAt/);
});

test('写入失败报告错误，但本次进程保留真实参与事实', () => withDir((dataDir) => {
  fs.writeFileSync(path.join(dataDir, 'tigexing'), '阻挡目录创建');
  const errors = [];
  const tracker = new SessionParticipation({ dataDir, onError: (error) => errors.push(error) });
  tracker.mark('human-session');
  assert.equal(tracker.has('human-session'), true);
  assert.equal(errors.length, 1);
}));
