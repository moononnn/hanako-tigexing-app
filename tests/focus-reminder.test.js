// 聊天焦点未知时不能拿最近用户消息冒充已读/正在看。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const entry = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../ui/settings.html', import.meta.url), 'utf8');
const ps1 = fs.readFileSync(new URL('../lib/notify.ps1', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../routes/api.js', import.meta.url), 'utf8');

test('不再用120秒用户消息窗口压制提醒，参与会话过滤仍保留', () => {
  assert.doesNotMatch(entry, /ACTIVE_WINDOW_MS|now\s*-\s*lastUserAt/);
  assert.match(entry, /participation\.has\(sessionId\)/);
  assert.match(entry, /chatTrigger === 'whenSessionUnfocused'[\s\S]*?保守提醒/);
});

test('焦点未知兜底在设置页如实展示，保持原档位值', () => {
  assert.match(page, /data-trigger="whenSessionUnfocused"/);
  assert.match(page, /无法可靠确认聊天焦点，会保守提醒/);
});

test('所有通知调用方等待交付结果，而非将Promise当成功', () => {
  assert.match(entry, /await deliverToast/);
  assert.equal((routes.match(/await deliverToast\(/g) || []).length, 3);
  assert.doesNotMatch(routes, /\bsendToast\(/);
  assert.match(routes, /ok: sent/);
});

test('脚本只在Show成功之后确认提交，并检查系统是否启用通知', () => {
  assert.match(ps1, /\$notifier\.Setting\.ToString\(\)/);
  assert.ok(ps1.indexOf('$notifier.Show($toast)') < ps1.indexOf('[Console]::Out.WriteLine("TXS_TOAST_SUBMITTED")'));
  assert.match(entry, /通知提交结果/);
});

test('界面只声称提交给系统，不声称已经显示', () => {
  assert.match(page, /r && r\.ok && r\.sent/);
  assert.match(page, /已提交给系统，留意实际弹窗/);
  assert.doesNotMatch(page, /rr\.sent \? "弹了，听～"/);
});
