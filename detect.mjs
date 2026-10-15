// 出題前判斷出題方式，輸出一行 <mode> :: <原因>
// web：直接寫 outbox；open：先開作答頁面；start：先啟動 server 再開頁面；classic：用傳統 AskUserQuestion
// 用法：node detect.mjs（在專案根目錄執行，需在 Claude Code 的 Bash 中執行才有 session id）
//       node detect.mjs --wait-connected [秒]：等作答頁面連線 (預設 15 秒)，輸出 connected :: N 或 timeout :: 原因；
//       在 Node 內輪詢，不需要 shell 的 sleep (部分沙箱會擋前景 sleep)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const presenceFile = path.resolve('.auq', 'presence.json');
const waitIndex = process.argv.indexOf('--wait-connected');
if (waitIndex !== -1) {
  waitConnected(Number(process.argv[waitIndex + 1]) || 15);
} else {
  detectMode();
}

// ---------- functions ----------

function detectMode() {
  // 先判斷使用者在哪：比較「桌機最後一次鍵盤滑鼠操作」與「最後一則手機訊息」的時間，較新者勝
  const idle = getIdleSeconds();
  const deskAt = idle === null ? null : Date.now() - idle * 1000;
  const message = getLastMessage();
  const mobileAt = message && message.source === 'mobile' ? message.at : null;
  if (mobileAt && (deskAt === null || mobileAt > deskAt)) {
    finish('classic', `最後一則訊息來自手機 app (${ago(mobileAt)})${deskAt === null ? '' : `，比桌機最後操作 (${ago(deskAt)}) 新`}`);
  }
  let where = '';
  if (deskAt !== null) where = `桌機最後操作 ${ago(deskAt)}${mobileAt ? `，比手機訊息 (${ago(mobileAt)}) 新` : ''}`;
  else where = message && message.source === 'desktop' ? '最後一則訊息來自電腦' : '無法判斷訊息來源，視為在電腦前';

  const presence = readPresence();
  if (!presence.running) finish('start', `${where}；server 未執行`);
  if (!(presence.connected >= 1)) finish('open', `${where}；作答頁面沒開 (port ${presence.port})`);
  finish('web', where);
}

function ago(time) {
  return `${Math.max(0, Math.round((Date.now() - time) / 1000))} 秒前`;
}

// 等頁面連線：每 300ms 讀一次 presence.json，server 必須在執行中
function waitConnected(seconds) {
  const deadline = Date.now() + seconds * 1000;
  const check = () => {
    const presence = readPresence();
    if (presence.running && presence.connected >= 1) {
      console.log(`connected :: ${presence.connected}`);
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.log(`timeout :: ${seconds} 秒內頁面沒有連線${presence.running ? '' : '（server 未執行）'}`);
      process.exit(1);
    }
    setTimeout(check, 300);
  };
  check();
}

function finish(mode, reason) {
  console.log(`${mode} :: ${reason}`);
  process.exit(0);
}

// 讀 server 狀態；用 pid 確認 server 沒有異常結束 (presence.json 可能過期)
function readPresence() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(presenceFile, 'utf8'));
  } catch {
    return { running: false };
  }
  // pid 必須是正整數：0 與負數會讓 kill 對整個行程群組送訊號而回報成功
  if (!data.running || !Number.isInteger(data.pid) || data.pid <= 0) return { running: false };
  try {
    process.kill(data.pid, 0);
  } catch (err) {
    // EPERM 代表行程存在但不能送訊號 (例：Claude Code 沙箱模式下每個指令各自隔離)，仍視為執行中
    if (err.code !== 'EPERM') return { running: false };
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
