// askUserQuestion Web bridge server：Claude 把題目寫進 .auq/outbox/，瀏覽器作答後由 stdout 回報給 Claude Code
// 用法：node server.js [--port 5700] [--idle-close-sec 60]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(appDir, 'public');
const args = parseArgs(process.argv.slice(2));
const startPort = Number(args.port || 5700);
const maxPortTries = 20;
let port = startPort;
const host = '127.0.0.1';
const dataDir = path.resolve('.auq');
const outboxDir = path.join(dataDir, 'outbox');
const processedDir = path.join(dataDir, 'processed');
const inboxFile = path.join(dataDir, 'inbox.jsonl');
const presenceFile = path.join(dataDir, 'presence.json');
const maxBody = 64 * 1024;
const maxAskFile = 256 * 1024;
const parseRetries = 5;
// 頁面全部關閉多久後改回傳統 AskUserQuestion (頁面在背景不算，靠提示音與通知提醒)
const noClientFallbackMs = 10 * 1000;
// 最後一題結束後多久沒有新題目就通知頁面關閉 (server 繼續待命)
const idleCloseMs = Number(args.idleCloseSec || 60) * 1000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const sseClients = new Set();
const pendingAsks = new Map();
const watchTimers = new Map();
const clients = new Map();
let fallbackTimer = null;
let idleCloseTimer = null;
let lastVisibleAt = null;

fs.mkdirSync(outboxDir, { recursive: true });
fs.mkdirSync(processedDir, { recursive: true });
loadPending();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);

  if (url.pathname === '/api/answer' && req.method === 'POST') return handleAnswer(req, res);
  if (url.pathname === '/api/cancel' && req.method === 'POST') return handleCancel(req, res);
  if (url.pathname === '/api/presence' && req.method === 'POST') return handlePresence(req, res);
  if (url.pathname === '/events') return handleEvents(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');

  const filePath = resolveInPublic(url.pathname);
  if (!filePath) return sendText(res, 404, 'Not Found');
  sendFile(res, filePath);
});

// port 被占用時自動往後找，實際使用的 port 印在 [AUQ:ready] 行
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < startPort + maxPortTries - 1) {
    port++;
    server.listen(port, host);
    return;
  }
  const reason = err.code === 'EADDRINUSE' ? `port ${startPort}～${port} 都已被使用，請用 --port 指定` : err.message;
  console.error(`[AUQ:error] ${reason}`);
  process.exit(1);
});
server.on('listening', () => {
  writePresence();
  console.log(`[AUQ:ready] http://${host}:${port}/  outbox=${outboxDir}  inbox=${inboxFile}`);
  // 啟動前就放進 outbox 的題目一併處理
  for (const name of fs.readdirSync(outboxDir)) scheduleAsk(name);
  updateFallback();
  fs.watch(outboxDir, (event, name) => {
    if (name) scheduleAsk(name);
  });
});
server.listen(port, host);

// 結束時把在場狀態歸零，Claude 讀 presence.json 才不會誤判頁面還開著
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clients.clear();
    writePresence(false);
    process.exit(0);
  });
}

// ---------- functions ----------

function parseArgs(list) {
  const result = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--port') result.port = list[++i];
    else if (list[i] === '--idle-close-sec') result.idleCloseSec = list[++i];
  }
  return result;
}

// 從 inbox 還原尚未作答的題目，server 重啟後頁面仍能補回
function loadPending() {
  for (const record of readInbox()) {
    if (record.status === 'pending') pendingAsks.set(record.id, record);
    else pendingAsks.delete(record.id);
  }
}

function readInbox() {
  if (!fs.existsSync(inboxFile)) return [];
  const records = [];
  for (const line of fs.readFileSync(inboxFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 壞掉的行略過，不影響其他紀錄
    }
  }
  return records;
}

// fs.watch 同一個檔案會觸發多次，debounce 後再讀
function scheduleAsk(name) {
  if (!name.endsWith('.json')) return;
  clearTimeout(watchTimers.get(name));
  watchTimers.set(name, setTimeout(() => {
    watchTimers.delete(name);
    processAsk(name, 0);
  }, 120));
}

// 讀取 outbox 題目檔，驗證後登記為 pending 並推給頁面；檔案可能還在寫入，解析失敗時重試幾次
function processAsk(name, attempt) {
  const filePath = path.join(outboxDir, name);
  if (!fs.existsSync(filePath)) return;
  let data;
  try {
    if (fs.statSync(filePath).size > maxAskFile) throw new Error(`檔案超過 ${maxAskFile / 1024}KB`);
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError && attempt < parseRetries) {
      setTimeout(() => processAsk(name, attempt + 1), 200);
      return;
    }
    return rejectAsk(name, err.message);
  }

  const result = toAsk(data);
  if (result.error) return rejectAsk(name, result.error);

  const baseId = path.basename(name, '.json').replace(/[^\w-]/g, '').slice(0, 60) || 'ask';
  const id = pendingAsks.has(baseId) ? `${baseId}-${crypto.randomBytes(2).toString('hex')}` : baseId;
  const record = { id, questions: result.questions, ts: new Date().toISOString(), status: 'pending' };
  try {
    fs.appendFileSync(inboxFile, JSON.stringify(record) + '\n');
    fs.renameSync(filePath, path.join(processedDir, `${id}.json`));
  } catch (err) {
    return console.error(`[AUQ:error] ${name} :: 寫入失敗 ${err.message}`);
  }
  pendingAsks.set(id, record);
  clearTimeout(idleCloseTimer);
  idleCloseTimer = null;
  broadcast('ask', publicAsk(record));
  console.log(`[AUQ:asked] ${id} ${record.questions.length} questions  visible=${visibleCount()} connected=${clients.size}`);
  updateFallback();
}

function rejectAsk(name, reason) {
  console.error(`[AUQ:error] ${name} :: ${reason}`);
  try {
    fs.renameSync(path.join(outboxDir, name), path.join(processedDir, name.replace(/\.json$/, '.invalid.json')));
  } catch {
    // 檔案已被移走就不處理
  }
}

// 驗證題目格式 (比照 AskUserQuestion)：1～4 題，每題 2～4 個選項
function toAsk(data) {
  const list = Array.isArray(data) ? data : data && data.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > 4) return { error: 'questions 需為 1～4 題的陣列' };
  const questions = [];
  for (const [i, q] of list.entries()) {
    const no = `第 ${i + 1} 題`;
    if (!q || typeof q !== 'object') return { error: `${no}格式錯誤` };
    const question = pickText(q.question, 1000);
    if (!question) return { error: `${no}缺少 question` };
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length < 2 || options.length > 4) return { error: `${no}的 options 需為 2～4 個` };
    const cleanOptions = [];
    for (const opt of options) {
      const label = pickText(opt && opt.label, 100);
      if (!label) return { error: `${no}有選項缺少 label` };
      if (cleanOptions.some((o) => o.label === label)) return { error: `${no}的選項 label 重複：${label}` };
      cleanOptions.push({
        label,
        description: pickText(opt.description, 500) || '',
        preview: pickText(opt.preview, 4000, false) || '',
        previewHtml: pickText(opt.previewHtml, 20000, false) || ''
      });
    }
    questions.push({ header: pickText(q.header, 30) || `Q${i + 1}`, question, multiSelect: q.multiSelect === true, options: cleanOptions });
  }
  return { questions };
}

function pickText(value, max, trim = true) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return (trim ? value.trim() : value.replace(/^\n+|\s+$/g, '')).slice(0, max);
}

function publicAsk(record) {
  return { id: record.id, questions: record.questions, ts: record.ts };
}

function handleAnswer(req, res) {
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' });
  readJsonBody(req, res, (data) => {
    const ask = pendingAsks.get(data.id);
    if (!ask) return sendJson(res, 404, { ok: false, error: '題目不存在或已作答' });
    const answers = Array.isArray(data.answers) ? data.answers : [];
    if (answers.length !== ask.questions.length) return sendJson(res, 400, { ok: false, error: '答案數量與題目不符' });

    const clean = [];
    for (const [i, q] of ask.questions.entries()) {
      const a = answers[i] || {};
      const labels = q.options.map((o) => o.label);
      const selected = Array.isArray(a.selected) ? [...new Set(a.selected.filter((s) => labels.includes(s)))] : [];
      const other = pickText(a.other, 2000) || '';
      const notes = pickText(a.notes, 2000) || '';
      if (!selected.length && !other) return sendJson(res, 400, { ok: false, error: `第 ${i + 1} 題尚未作答` });
      if (!q.multiSelect && selected.length + (other ? 1 : 0) > 1) return sendJson(res, 400, { ok: false, error: `第 ${i + 1} 題為單選` });
      clean.push({ selected, other, notes });
    }

    if (!finishAsk(ask, 'answered', { answers: clean })) return sendJson(res, 500, { ok: false, error: 'write failed' });
    const output = [`[AUQ] answer ${ask.id} ${ask.questions.length} questions`];
    for (const [i, q] of ask.questions.entries()) {
      const a = clean[i];
      const parts = [...a.selected];
      if (a.other) parts.push(`Other: ${oneLine(a.other)}`);
      let line = `[AUQ]   Q${i + 1} [${q.header}] ${oneLine(q.question)} => ${parts.join(', ')}`;
      if (a.notes) line += ` | 備註: ${oneLine(a.notes)}`;
      output.push(line);
    }
    console.log(output.join('\n'));
    sendJson(res, 200, { ok: true });
  });
}

// 使用者略過不回答，等同 AskUserQuestion 被拒絕
function handleCancel(req, res) {
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' });
  readJsonBody(req, res, (data) => {
    const ask = pendingAsks.get(data.id);
    if (!ask) return sendJson(res, 404, { ok: false, error: '題目不存在或已作答' });
    const reason = pickText(data.reason, 1000) || '';
    if (!finishAsk(ask, 'cancelled', { reason })) return sendJson(res, 500, { ok: false, error: 'write failed' });
    console.log(`[AUQ] cancel ${ask.id}${reason ? ` :: ${oneLine(reason)}` : ''}`);
    sendJson(res, 200, { ok: true });
  });
}

// 以追加一行新狀態的方式記錄結果 (inbox 只追加不改寫)，並通知所有分頁移除該題
function finishAsk(ask, status, extra) {
  const record = { ...ask, ...extra, status, updatedAt: new Date().toISOString() };
  try {
    fs.appendFileSync(inboxFile, JSON.stringify(record) + '\n');
  } catch {
    return false;
  }
  pendingAsks.delete(ask.id);
  broadcast('done', { id: ask.id, status });
  if (!pendingAsks.size) scheduleIdleClose();
  return true;
}

// 題目都結束後開始倒數，期間有新題目由 processAsk 取消
function scheduleIdleClose() {
  clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    if (pendingAsks.size) return;
    broadcast('idle-close', {});
    console.log(`[AUQ:idle-close] ${idleCloseMs / 1000} 秒沒有新題目，通知頁面關閉 (connected=${clients.size})`);
  }, idleCloseMs);
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ');
}

// 頁面回報可見狀態 (Page Visibility API)
function handlePresence(req, res) {
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' });
  readJsonBody(req, res, (data) => {
    const client = clients.get(data.cid);
    if (!client) return sendJson(res, 404, { ok: false, error: 'unknown client' });
    client.visible = data.visible === true;
    presenceChanged();
    sendJson(res, 200, { ok: true });
  });
}

function visibleCount() {
  return [...clients.values()].filter((c) => c.visible).length;
}

function presenceChanged() {
  if (visibleCount()) lastVisibleAt = new Date().toISOString();
  writePresence();
  updateFallback();
}

// presence.json 讓 detect.mjs 出題前確認 server 執行中且有頁面連線
function writePresence(running = true) {
  const data = { running, pid: process.pid, port, visible: visibleCount(), connected: clients.size, lastVisibleAt, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(presenceFile, JSON.stringify(data, null, 2) + '\n');
  } catch {
    // 寫不進去不影響主要功能
  }
}

// 有未作答題目卻沒有任何頁面連線時倒數，時間到就取消題目，請 Claude 改用傳統 AskUserQuestion
function updateFallback() {
  if (!pendingAsks.size || clients.size) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
    return;
  }
  if (fallbackTimer) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (clients.size) return;
    const reason = '沒有開著的頁面';
    for (const ask of [...pendingAsks.values()]) {
      if (finishAsk(ask, 'fallback', { reason })) console.log(`[AUQ] fallback ${ask.id} :: ${reason}，請改用傳統 AskUserQuestion`);
    }
  }, noClientFallbackMs);
}

function handleEvents(req, res, url) {
  const cid = String(url.searchParams.get('cid') || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomBytes(6).toString('hex');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  // 連線時先送目前所有未作答題目，頁面重開或重連都能補回
  res.write(`event: snapshot\ndata: ${JSON.stringify([...pendingAsks.values()].map(publicAsk))}\n\n`);
  sseClients.add(res);
  // 剛連上時以網址參數帶入的可見狀態為準，之後由 /api/presence 更新
  clients.set(cid, { visible: url.searchParams.get('visible') === '1', res });
  presenceChanged();
  req.on('close', () => {
    sseClients.delete(res);
    // 同一分頁重連時舊連線較晚關閉，不能刪掉新連線的狀態
    if (clients.get(cid)?.res !== res) return;
    clients.delete(cid);
    presenceChanged();
  });
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

// 將 URL 路徑轉為 public 內的實體檔案，防止路徑穿越
function resolveInPublic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  let target = path.resolve(publicDir, '.' + decoded);
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) return null;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 只接受本機同源請求，避免其他網站跨站送出假答案
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

// 讀取 JSON body，超過上限或格式錯誤時直接回應錯誤，成功才呼叫 callback function
function readJsonBody(req, res, callback) {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBody) {
      sendJson(res, 413, { ok: false, error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid json' });
    }
    callback(data && typeof data === 'object' ? data : {});
  });
}
