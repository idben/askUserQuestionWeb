// 判斷使用者在電腦前還是手機上：detect.mjs 出題前判斷、server.js 自動開頁前判斷共用
// 比較「桌機最後一次鍵盤滑鼠操作」(macOS 系統閒置時間) 與「最後一則手機訊息」(session 紀錄) 的時間，較新者勝
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 回傳 { where: 'desktop' | 'mobile', reason }
export function whereIsUser() {
  const idle = getIdleSeconds();
  const deskAt = idle === null ? null : Date.now() - idle * 1000;
  const message = getLastMessage();
  const mobileAt = message && message.source === 'mobile' ? message.at : null;
  if (mobileAt && (deskAt === null || mobileAt > deskAt)) {
    return { where: 'mobile', reason: `最後一則訊息來自手機 app (${ago(mobileAt)})${deskAt === null ? '' : `，比桌機最後操作 (${ago(deskAt)}) 新`}` };
  }
  if (deskAt !== null) return { where: 'desktop', reason: `桌機最後操作 ${ago(deskAt)}${mobileAt ? `，比手機訊息 (${ago(mobileAt)}) 新` : ''}` };
  return { where: 'desktop', reason: message && message.source === 'desktop' ? '最後一則訊息來自電腦' : '無法判斷訊息來源，視為在電腦前' };
}

function ago(time) {
  return `${Math.max(0, Math.round((Date.now() - time) / 1000))} 秒前`;
}

// macOS 鍵盤滑鼠閒置秒數；其他系統或讀取失敗回傳 null
function getIdleSeconds() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return match ? Math.floor(Number(match[1]) / 1e9) : null;
  } catch {
    return null;
  }
}

// 從 session 紀錄找最後一則使用者輸入的訊息：queueSkipSlashCommands 為 true 代表來自手機 app (Remote Control)
// 工作中插話與 AskUserQuestion 的回答沒有來源欄位，略過不算；回傳 { source, at }
function getLastMessage() {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return null;
  const file = findTranscript(sessionId);
  if (!file) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"origin"')) continue;
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (record.type !== 'user' || !record.origin || record.origin.kind !== 'human') continue;
    return { source: record.queueSkipSlashCommands === true ? 'mobile' : 'desktop', at: Date.parse(record.timestamp) || null };
  }
  return null;
}

function findTranscript(sessionId) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const direct = path.join(projectsDir, path.resolve('.').replace(/[^\w]/g, '-'), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // 找不到就無法判斷
  }
  return null;
}
