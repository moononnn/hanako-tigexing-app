// 提个醒 · 文本截断（码点安全）
//
// 为什么需要它：String#slice 按 UTF-16 code unit 切，emoji 占两个 unit，
// 正好切在中间时会留下孤立代理（lone surrogate，如 \uD83C）。
// 孤立代理经 PowerShell 子进程传参编码后会变成替换字符 U+FFFD，
// 弹窗里就是一个「�」方块——2026-10-26 实机：润色正文「…一句话就能改哦！」+ 🌿
// 在 24 字处被切成半个 emoji，用户看到尾巴挂了个怪符号。
//
// 用法：所有面向通知文案的截断都走这里，别再用原生 slice 切可见文字。

/**
 * 按码点截断，超长补省略号。中文长度与原生 slice 一致，emoji 算一个字符。
 * @param {string} text 原文本
 * @param {number} len 码点上限
 * @param {string} [ellipsis="…"] 省略号
 */
export function clipCodePoints(text, len, ellipsis = "…") {
  const t = String(text ?? "");
  if (!(len > 0) || t.length <= len) return t;
  const chars = Array.from(t);
  if (chars.length <= len) return t;
  return chars.slice(0, len).join("") + ellipsis;
}
