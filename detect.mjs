// 出題前判斷出題方式，輸出一行 <mode> :: <原因>
// web：直接寫 outbox；open：先開作答頁面；start：先啟動 server 再開頁面；classic：用傳統 AskUserQuestion
// 用法：node detect.mjs（在專案根目錄執行，需在 Claude Code 的 Bash 中執行才有 session id）
//       node detect.mjs --wait-connected [秒]：等作答頁面連線 (預設 15 秒)，輸出 connected :: N 或 timeout :: 原因；
//       在 Node 內輪詢，不需要 shell 的 sleep (Claude Code 的 Bash 工具不允許前景 sleep)
import fs from 'node:fs';
import path from 'node:path';
import { whereIsUser } from './presence.mjs';

const presenceFile = path.resolve('.auq', 'presence.json');
const waitIndex = process.argv.indexOf('--wait-connected');
if (waitIndex !== -1) {
  waitConnected(Number(process.argv[waitIndex + 1]) || 15);
} else {
  detectMode();
}

// ---------- functions ----------

function detectMode() {
  const user = whereIsUser();
  if (user.where === 'mobile') finish('classic', user.reason);
  const presence = readPresence();
  if (!presence.running) finish('start', `${user.reason}；server 未執行`);
  if (!(presence.connected >= 1)) finish('open', `${user.reason}；作答頁面沒開 (port ${presence.port})`);
  finish('web', user.reason);
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
  if (!data || typeof data !== 'object') return { running: false };
  if (!data.running || !Number.isInteger(data.pid) || data.pid <= 0) return { running: false };
  try {
    process.kill(data.pid, 0);
  } catch (err) {
    // EPERM 代表行程存在但不能送訊號 (例：Claude Code 沙箱模式下每個指令各自隔離)，仍視為執行中
    if (err.code !== 'EPERM') return { running: false };
  }
  return data;
}
