// 真实通知装配顺序回归：跟旧版一样在润色后读取标题，前缀由程序附加。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sessionPrefix, STYLES } from '../lib/style.js';
import { buildNotificationCopy } from '../lib/notification-copy.js';

const entry = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('实际入口先完成正文生成，再读取真实会话标题', () => {
  const copyAt = entry.indexOf('const copy = await buildNotificationCopy(');
  const lookupAt = entry.indexOf('await resolveSessionTitleWithRetry(', copyAt);
  assert.ok(copyAt >= 0 && lookupAt > copyAt);
  assert.doesNotMatch(entry.slice(copyAt, lookupAt), /count: decision\.count,\s*sessionTitle/);
  assert.match(entry, /sessionTitle = sessionTitlesByPath\.get\(sessionKey\) \|\| sessionTitle/);
  assert.match(entry, /const title = sessionPrefix\(sessionTitle\) \+ copy\.title/);
});

test('模型与规则版都只加一次对话框前缀，正文不受影响', async () => {
  for (const enabled of [true, false]) {
    const copy = await buildNotificationCopy({
      enabled, style: STYLES.ac_timmy, kind: 'first', agentName: '伙伴', count: 1,
      snippet: '保存好了',
      modelConfig: { async sample() { return '{"title":"伙伴回信啦","body":"已经存好啦～"}'; } }
    });
    const originalBody = copy.body;
    const title = sessionPrefix('这个对话框') + copy.title;
    assert.equal((title.match(/这个对话框/g) || []).length, 1);
    assert.equal(copy.body, originalBody);
    assert.ok(title.startsWith('这个对话框 · '));
  }
});
