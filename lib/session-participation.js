// 提个醒 · 真实用户参与标记
// 和焦点/已读/送达状态分开；参与事实跨重载保存，不因监听进程重启丢失。
import fs from 'node:fs';
import path from 'node:path';

export class SessionParticipation {
  constructor({ dataDir, onError } = {}) {
    this.file = path.join(dataDir, 'tigexing', 'session-participation.json');
    this.onError = onError;
    this.sessions = new Set();
    this.canPersist = true;
    try {
      if (fs.existsSync(this.file)) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!Array.isArray(saved?.sessionIds)) throw new Error('参与记录格式无效');
        for (const id of saved.sessionIds) if (typeof id === 'string' && id.trim()) this.sessions.add(id.trim());
      }
    } catch (error) { this.canPersist = false; this.report(error); }
  }
  report(error) { try { this.onError?.(error); } catch { /* 日志不能阻断提醒 */ } }
  has(sessionId) { return this.sessions.has(String(sessionId || '').trim()); }
  mark(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id || id === 'unknown' || this.sessions.has(id)) return;
    this.sessions.add(id);
    if (!this.canPersist) return; // 格式损坏时保留原档，不覆盖未知旧记录。
    const temporary = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessionIds: [...this.sessions] }, null, 2), 'utf8');
      fs.renameSync(temporary, this.file);
    } catch (error) { this.report(error); }
  }
}
