// 不发真实通知，不改系统注册表；用假子进程覆盖提交确认与备用通道。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendToast, deliverToast } from '../lib/toast.js';

const pluginDir = fileURLToPath(new URL('../', import.meta.url));
const options = { pluginDir, title: '窗口标题 · 伙伴回信', message: '正文', duration: 'long' };
function fakeProcess(run) {
  let spawned;
  let killed = false;
  const spawnProcess = (command, args, opts) => {
    spawned = { command, args, opts };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed = true; child.emit('close', null, 'SIGTERM'); };
    queueMicrotask(() => run(child));
    return child;
  };
  return { dependencies: { spawnProcess, timeoutMs: 100 }, get spawned() { return spawned; }, get killed() { return killed; } };
}

test('收到脚本提交标记才返回成功，标记可跨输出分块', async () => {
  const fake = fakeProcess((child) => {
    child.stdout.write('TXS_TOAST_SUB');
    child.stdout.write('MITTED\r\n');
    child.emit('close', 0);
  });
  assert.equal(await sendToast(options, fake.dependencies), true);
  assert.deepEqual(fake.spawned.opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(fake.spawned.opts.env.TXS_DURATION, 'long');
});

test('进程退出0但没有提交确认，不能当发送成功', async () => {
  const fake = fakeProcess((child) => child.emit('close', 0));
  assert.equal(await sendToast(options, fake.dependencies), false);
});

test('失败时保留脚本错误与退出原因', async () => {
  const logs = [];
  const fake = fakeProcess((child) => { child.stderr.write('DisabledForApplication'); child.emit('close', 1); });
  assert.equal(await sendToast({ ...options, log: { error: (...args) => logs.push(args) } }, fake.dependencies), false);
  assert.match(logs[0][1].stderr, /DisabledForApplication/);
  assert.match(logs[0][1].error, /code=1/);
});

test('异步启动失败返回失败', async () => {
  const fake = fakeProcess((child) => child.emit('error', new Error('spawn denied')));
  assert.equal(await sendToast(options, fake.dependencies), false);
});

test('同步启动失败返回失败', async () => {
  assert.equal(await sendToast(options, { spawnProcess() { throw new Error('denied'); } }), false);
});

test('超时终止未确认的进程', async () => {
  const fake = fakeProcess(() => {});
  assert.equal(await sendToast(options, { ...fake.dependencies, timeoutMs: 10 }), false);
  assert.equal(fake.killed, true);
});

test('脚本失败走宿主备用通道，保留相同标题正文', async () => {
  const fake = fakeProcess((child) => child.emit('close', 1));
  const received = [];
  const result = await deliverToast(options, async (input) => { received.push(input); }, fake.dependencies);
  assert.deepEqual(result, { sent: true, via: 'host' });
  assert.deepEqual(received, [{ title: options.title, body: options.message }]);
});

test('脚本已提交后不重复发送备用通知', async () => {
  const fake = fakeProcess((child) => { child.stdout.write('TXS_TOAST_SUBMITTED\n'); child.emit('close', 0); });
  const result = await deliverToast(options, () => { throw new Error('不得调用'); }, fake.dependencies);
  assert.deepEqual(result, { sent: true, via: 'powershell' });
});

test('超时重试一次，第二次拿到提交标记就算成功', async () => {
  let attempts = 0;
  const notes = [];
  const spawnProcess = () => {
    attempts += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', null, 'SIGTERM');
    // 第一轮不吐标记也不退出，等超时上限把它砍掉；第二轮才正常提交。
    if (attempts === 2) queueMicrotask(() => { child.stdout.write('TXS_TOAST_SUBMITTED\n'); child.emit('close', 0); });
    return child;
  };
  assert.equal(await sendToast(options, { spawnProcess, timeoutMs: 5, debug: (line) => notes.push(line) }), true);
  assert.equal(attempts, 2);
  assert.match(notes.join('\n'), /超时/);
});

test('脚本明确报错时不重试，直接交给备用通道', async () => {
  let attempts = 0;
  const fake = fakeProcess((child) => { child.stderr.write('DisabledForApplication'); child.emit('close', 1); });
  const spawnProcess = (...args) => { attempts += 1; return fake.dependencies.spawnProcess(...args); };
  const result = await deliverToast(options, async () => ({ shown: true }), { ...fake.dependencies, spawnProcess, timeoutMs: 50 });
  assert.equal(attempts, 1);
  assert.deepEqual(result, { sent: true, via: 'host' });
});

test('两个通道均失败时准确返回失败', async () => {
  const fake = fakeProcess((child) => child.emit('close', 1));
  const result = await deliverToast(options, async () => { throw new Error('permission denied'); }, fake.dependencies);
  assert.deepEqual(result, { sent: false, via: 'failed' });
});

function readStatus(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('降级时把原因落盘，设置页据此提示怎么修', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txs-deliver-'));
  try {
    const statusFile = path.join(dir, 'toast-status.json');
    const fake = fakeProcess((child) => { child.stderr.write('DisabledForApplication'); child.emit('close', 1); });
    const result = await deliverToast({ ...options, statusFile }, async () => ({ shown: true }), fake.dependencies);
    assert.deepEqual(result, { sent: true, via: 'host' });
    const saved = readStatus(statusFile);
    assert.equal(saved.via, 'host');
    assert.equal(saved.kind, 'no-marker');
    assert.match(saved.detail, /DisabledForApplication/);
    assert.ok(Date.parse(saved.at) > 0, '要带时间戳，否则横幅无从判断新旧');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('两条腿都失败时记 failed，不冒充成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txs-deliver-'));
  try {
    const statusFile = path.join(dir, 'toast-status.json');
    const fake = fakeProcess((child) => child.emit('error', new Error('spawn powershell EACCES')));
    const result = await deliverToast({ ...options, statusFile }, async () => { throw new Error('宿主通道也挂了'); }, fake.dependencies);
    assert.deepEqual(result, { sent: false, via: 'failed' });
    const saved = readStatus(statusFile);
    assert.equal(saved.via, 'failed');
    assert.match(saved.detail, /EACCES/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('走自己的通道时落一笔 ok，之前那条降级提示就被盖掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txs-deliver-'));
  try {
    const statusFile = path.join(dir, 'toast-status.json');
    fs.writeFileSync(statusFile, JSON.stringify({ at: '2026-10-31T09:00:00.000Z', via: 'host', kind: 'no-marker' }), 'utf8');
    const fake = fakeProcess((child) => { child.stdout.write('TXS_TOAST_SUBMITTED\n'); child.emit('close', 0); });
    const result = await deliverToast({ ...options, statusFile }, () => { throw new Error('不得走备用通道'); }, fake.dependencies);
    assert.deepEqual(result, { sent: true, via: 'powershell' });
    assert.equal(readStatus(statusFile).via, 'powershell');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
