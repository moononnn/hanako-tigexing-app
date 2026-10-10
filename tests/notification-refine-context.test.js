// 实际通知美化：摘要与上下文分离、合并补弹、同模型有界预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../lib/policy.js';
import { buildNotificationCopy } from '../lib/notification-copy.js';
import { STYLES } from '../lib/style.js';

const config = { enabled: true, mergeWindowMs: 30000 };
const text = '这段开场需要保留但不能当作整条回复。'.repeat(8) + '关键结论：设置已经保存，不需要重启。';
const event = (reply) => ({ sessionId: 'test-session', agentId: 'partner', agentName: '伙伴', text: reply });

test('首次通知保留较长美化素材，兜底摘要仍为48字', async () => {
  const decision = new Notifier(config).decide(event(text), 100000);
  assert.equal(decision.snippet.length, 49);
  assert.equal(decision.refineText, text);
  let input;
  const copy = await buildNotificationCopy({
    ...decision, enabled: true, style: STYLES.ac_timmy,
    modelConfig: { async sample(messages) {
      input = messages[1].content;
      return '{"title":"伙伴带消息来啦","body":"设置存好啦，无需重启～"}';
    } }
  });
  assert.match(input, /关键结论：设置已经保存，不需要重启/);
  assert.equal(copy.refined, true);
  const fallback = await buildNotificationCopy({ ...decision, enabled: false, style: STYLES.ac_timmy });
  assert.equal(fallback.body, STYLES.ac_timmy.body('first', decision.snippet, 1));
});

test('合并补弹使用最新回复素材，flush后清空', () => {
  const notifier = new Notifier(config);
  notifier.decide(event('第一条'), 100000);
  notifier.decide(event(text), 101000);
  const decision = notifier.flush('test-session', 140000);
  assert.equal(decision.refineText, text);
  assert.equal(decision.count, 2);
  assert.equal(notifier.sessions.get('test-session').refineText, '');
});

test('素材有上限，不把无限长回复塞进通知状态', () => {
  const decision = new Notifier(config).decide(event('长'.repeat(5000)), 100000);
  assert.equal(decision.refineText.length, 1201);
});

test('美化空正文时只重试一次，追加思考预算与等待时间', async () => {
  const calls = [];
  const modelConfig = { async sample(messages, options) {
    calls.push(options);
    return calls.length === 1 ? '' : '{"title":"伙伴带消息来啦","body":"设置存好啦，无需重启～"}';
  } };
  const copy = await buildNotificationCopy({
    ...new Notifier(config).decide(event(text), 100000),
    enabled: true, style: STYLES.ac_timmy, modelConfig
  });
  assert.equal(copy.refined, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].maxTokens, 1500);
  assert.equal(calls[1].maxTokens, 6000);
  assert.equal(calls[0].timeoutMs, 20000);
  assert.equal(calls[1].timeoutMs, 30000);
  assert.ok(calls.every((call) => call.retryOnEmpty === false));
});
