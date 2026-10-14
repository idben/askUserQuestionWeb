// 出題前判斷該用網頁還是傳統 AskUserQuestion，輸出一行：web :: <原因> 或 classic :: <原因>
// 用法：node detect.mjs [--idle-sec 60]（在專案根目錄執行，需在 Claude Code 的 Bash 中執行才有 session id）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const idleLimit = Number(args.idleSec || 60);
const presenceFile = path.resolve('.auq', 'presence.json');

const presence = readPresence();
if (!presence) finish('classic', '作答頁面沒開或 server 未執行');

const idle = getIdleSeconds();
if (idle !== null && idle < idleLimit) finish('web', `系統閒置 ${idle} 秒，使用者在電腦前`);

const source = getLastMessageSource();
if (source === 'mobile') finish('classic', `最後一則訊息來自手機 app${idle !== null ? `，系統閒置 ${idle} 秒` : ''}`);

finish('web', source === 'desktop' ? '最後一則訊息來自電腦' : '無法判斷訊息來源，頁面開著所以用網頁');

// ---------- functions ----------

function parseArgs(list) {
  const result = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--idle-sec') result.idleSec = list[++i];
  }
  return result;
}

function finish(mode, reason) {
  console.log(`${mode} :: ${reason}`);
  process.exit(0);
}

// server 執行中且至少一個頁面連線才算可用；用 pid 確認 server 沒有異常結束 (presence.json 可能過期)
function readPresence() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(presenceFile, 'utf8'));
  } catch {
    return null;
  }
  if (!data.running || !(data.connected >= 1)) return null;
  if (data.pid) {
    try {
      process.kill(data.pid, 0);
    } catch {
      return null;
    }
  }
  return data;
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
// 工作中插話與 AskUserQuestion 的回答沒有來源欄位，略過不算
function getLastMessageSource() {
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
    return record.queueSkipSlashCommands === true ? 'mobile' : 'desktop';
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
