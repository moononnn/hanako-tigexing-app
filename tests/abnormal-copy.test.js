// 提个醒 · 异常回合文案测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAbnormalCopy, failureReasonLabel, isRetryCancelled } from "../lib/abnormal-copy.js";

test("异常文案：连接错误归纳成大白话", () => {
  assert.equal(failureReasonLabel("WebSocket error"), "模型连接中断或超时");
  assert.equal(failureReasonLabel("fetch failed"), "模型连接中断或超时");
  assert.equal(failureReasonLabel("401 Unauthorized"), "模型凭据或权限校验失败");
  assert.equal(failureReasonLabel("429 rate limit"), "模型请求触发限流");
  assert.equal(failureReasonLabel("unknown failure"), "模型返回：unknown failure");
});

test("异常文案：识别五小时用量额度，并对未知错误保留脱敏细节", () => {
  assert.equal(
    failureReasonLabel("The model reached its 5-hour usage limit"),
    "模型 5 小时使用额度已用完"
  );
  const tokenPlanError = '402: {"type":"insufficient_balance_error","message":"当前已达到 Token Plan 用量上限，请升级套餐或购买积分。(2067)","http_code":"402"}';
  assert.equal(failureReasonLabel(tokenPlanError), "模型 Token Plan 用量已达上限（402/2067）");
  const notice = buildAbnormalCopy({ errorMessage: tokenPlanError }).body;
  assert.match(notice, /额度恢复后/);
  assert.match(notice, /402\/2067/);
  const detail = failureReasonLabel('secret=sk-12345678901234567890; unexpected response');
  assert.match(detail, /模型返回/);
  assert.doesNotMatch(detail, /sk-12345678901234567890/);
  assert.match(detail, /secret=\[已隐藏\]/);
  const linked = failureReasonLabel("Unexpected endpoint: https://example.test/path");
  assert.doesNotMatch(linked, /https:\/\/example\.test/);
  const pathDetail = failureReasonLabel("Unexpected file: C:\\Users\\private\\case.txt");
  assert.doesNotMatch(pathDetail, /C:\\Users\\private/);
  const sessionIdDetail = failureReasonLabel("Unexpected response sessionId=abc12345678901234567890");
  assert.doesNotMatch(sessionIdDetail, /abc12345678901234567890/);
  assert.doesNotMatch(sessionIdDetail, /abc1/);
  const snakeSessionIdDetail = failureReasonLabel('Unexpected response {"session_id":"abc12345678901234567890"}');
  assert.doesNotMatch(snakeSessionIdDetail, /abc12345678901234567890/);
  assert.doesNotMatch(snakeSessionIdDetail, /abc1/);
  const spacedSnakeSessionIdDetail = failureReasonLabel('Unexpected response {"session_id": "abc12345678901234567890"}');
  assert.doesNotMatch(spacedSnakeSessionIdDetail, /abc1/);
  const jsonSecretDetail = failureReasonLabel('Unexpected response {"secret":"s3cr3t-value-here"}');
  assert.doesNotMatch(jsonSecretDetail, /s3cr3t/);
  const jsonCookieDetail = failureReasonLabel('Unexpected response {"cookie":"sid=abcdef123456; Path=/"}');
  assert.doesNotMatch(jsonCookieDetail, /abcdef123456/);
  const refreshTokenDetail = failureReasonLabel("Unexpected response refresh_token=abcdefgh12345678");
  assert.doesNotMatch(refreshTokenDetail, /abcdefgh12345678/);
  const clientSecretDetail = failureReasonLabel("Unexpected response client_secret=zzzz111122223333");
  assert.doesNotMatch(clientSecretDetail, /zzzz111122223333/);
  const uncPathDetail = failureReasonLabel(String.raw`Unexpected file: \\private-server\share\secret\report.docx`);
  assert.doesNotMatch(uncPathDetail, /private-server|report\.docx/);
  const spacedPathDetail = failureReasonLabel(String.raw`Unexpected file: C:\Users\person\OneDrive - Team\secret\report.docx, retry`);
  assert.doesNotMatch(spacedPathDetail, /OneDrive - Team|report\.docx/);
  assert.match(spacedPathDetail, /retry/);
  const spacedUncPathDetail = failureReasonLabel(String.raw`Unexpected file: \\private-server\share name\secret report.docx, retry`);
  assert.doesNotMatch(spacedUncPathDetail, /private-server|secret report\.docx/);
  assert.match(spacedUncPathDetail, /retry/);
  const forwardSlashPathDetail = failureReasonLabel(String.raw`Unexpected file: C:/Program Files/Team/secret file.txt, retry`);
  assert.doesNotMatch(forwardSlashPathDetail, /Program Files|secret file\.txt/);
  assert.match(forwardSlashPathDetail, /retry/);
  const forwardSlashUncPathDetail = failureReasonLabel(String.raw`Unexpected file: //private-server/share name/secret/report.docx, retry`);
  assert.doesNotMatch(forwardSlashUncPathDetail, /private-server|report\.docx/);
  assert.match(forwardSlashUncPathDetail, /retry/);
  const fileUriDetail = failureReasonLabel(String.raw`Unexpected file: file:///C:/Users/person/OneDrive%20-%20Team/secret/report.docx, retry`);
  assert.doesNotMatch(fileUriDetail, /file:\/\/\/C:|OneDrive|report\.docx/);
  assert.match(fileUriDetail, /retry/);
});

test("异常文案：带会话标题和已收到的部分内容", () => {
  const r = buildAbnormalCopy({
    kind: "failure",
    agentName: "小花",
    sessionTitle: "设置面板优化建议",
    partialText: "已经收到一半内容",
    errorMessage: "WebSocket error"
  });
  assert.equal(r.title, "设置面板优化建议 · 小花 · 这轮没接上");
  assert.match(r.body, /模型连接中断或超时/);
  assert.match(r.body, /收到/);
  assert.match(r.body, /继续/);
});

test("异常文案：没有部分内容时给出继续动作", () => {
  const r = buildAbnormalCopy({ kind: "failure", agentName: "小花", errorMessage: "fetch failed" });
  assert.equal(r.title, "小花 · 这轮没接上");
  assert.equal(r.body, "模型连接中断或超时，说“继续”再试");
});

test("异常文案：会话不健康给出新开对话建议", () => {
  const r = buildAbnormalCopy({ kind: "unhealthy", agentName: "小花", recentErrors: 4, totalChecked: 4 });
  assert.equal(r.title, "小花 · 对话状态不稳");
  assert.match(r.body, /4\/4/);
  assert.match(r.body, /新开对话/);
});

test("异常文案：只识别明确的取消，不把普通 aborted 错误吞掉", () => {
  assert.equal(isRetryCancelled("Retry cancelled"), true);
  assert.equal(isRetryCancelled("retry_cancelled"), true);
  assert.equal(isRetryCancelled("Request cancelled by user"), true);
  assert.equal(isRetryCancelled("aborted by user"), true);
  assert.equal(isRetryCancelled("user_cancelled"), true);
  assert.equal(isRetryCancelled("The operation was aborted"), false);
  assert.equal(isRetryCancelled("signal aborted due to timeout"), false);
  assert.equal(isRetryCancelled("WebSocket error"), false);
});
