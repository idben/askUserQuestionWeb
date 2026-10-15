// askUserQuestion Web 自動化測試：只用 Node 內建 node:test，執行 npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(rootDir, 'server.js');
const detectPath = path.join(rootDir, 'detect.mjs');
const servers = [];
const sampleAsk = { questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] };

after(() => {
  for (const s of servers) s.proc.kill('SIGTERM');
});

test('啟動後提供作答頁面', async () => {
  const s = await startServer();
  const res = await request(s, { path: '/' });
  assert.equal(res.status, 200);
  assert.match(res.body, /askUserQuestion/);
});

test('Host 不是本機時回 421（防 DNS rebinding）', async () => {
  const s = await startServer();
  for (const p of ['/', '/events', '/api/presence']) {
    const isPost = p === '/api/presence';
    const res = await request(s, { path: p, host: 'evil.example', method: isPost ? 'POST' : 'GET', body: isPost ? '{}' : undefined });
    assert.equal(res.status, 421, p);
  }
});

test('沒有同源 Origin 的作答請求回 403', async () => {
  const s = await startServer();
  const res = await request(s, { path: '/api/answer', method: 'POST', body: '{}', origin: null });
  assert.equal(res.status, 403);
});

test('出題、驗證作答、送出答案', async () => {
  const s = await startServer();
  const events = openEvents(s);
  await events.waitFor('snapshot');
  writeAsk(s, 'q1', sampleAsk);
  const ask = await events.waitFor('ask');
  assert.equal(ask.id, 'q1');

  const bad = await request(s, { path: '/api/answer', method: 'POST', body: JSON.stringify({ id: 'q1', answers: [{ selected: ['A', 'B'] }] }) });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).code, 'single_only');

  const ok = await request(s, { path: '/api/answer', method: 'POST', body: JSON.stringify({ id: 'q1', answers: [{ selected: ['B'], notes: 'note\nline' }] }) });
  assert.equal(ok.status, 200);
  await s.waitForLog(/\[AUQ\]\s+Q1 \[Pick\] Which one\? => B \| 備註: note line/);
  const records = fs.readFileSync(path.join(s.dir, '.auq', 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(records.at(-1).status, 'answered');
  events.close();
});

test('略過題目', async () => {
  const s = await startServer();
  writeAsk(s, 'skip1', sampleAsk);
  await s.waitForLog(/\[AUQ:asked\] skip1/);
  const res = await request(s, { path: '/api/cancel', method: 'POST', body: JSON.stringify({ id: 'skip1' }) });
  assert.equal(res.status, 200);
  await s.waitForLog(/\[AUQ\] cancel skip1/);
});

test('內容過大回 413，不直接切斷連線', async () => {
  const s = await startServer();
  const res = await request(s, { path: '/api/answer', method: 'POST', body: 'x'.repeat(200 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(JSON.parse(res.body).code, 'too_large');
});

test('格式錯誤：先移走檔案再印錯誤', async () => {
  const s = await startServer();
  fs.writeFileSync(path.join(s.dir, '.auq', 'outbox', 'bad.json'), '{"questions": []}');
  await s.waitForLog(/\[AUQ:error\] bad\.json/);
  assert.equal(fs.existsSync(path.join(s.dir, '.auq', 'outbox', 'bad.json')), false);
  assert.equal(fs.existsSync(path.join(s.dir, '.auq', 'processed', 'bad.invalid.json')), true);
});

test('fs.watch 無法使用時改為輪詢，題目照常處理', async () => {
  const breakWatch = 'data:text/javascript,' + encodeURIComponent(
    "import fs from 'node:fs'; fs.watch = () => { const e = new Error('EMFILE'); e.code = 'EMFILE'; throw e; };"
  );
  const s = await startServer({ nodeArgs: ['--import', breakWatch] });
  await s.waitForLog(/\[AUQ:watch\]/);
  writeAsk(s, 'poll1', sampleAsk);
  await s.waitForLog(/\[AUQ:asked\] poll1/);
});

test('detect.mjs --wait-connected 逾時回傳 exit code 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auq-detect-'));
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [detectPath, '--wait-connected', '1'], { cwd: dir }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^timeout :: /);
});

// ---------- helpers ----------

// 在暫存資料夾啟動 server (port 0 不可用，從隨機高位 port 開始，被占用時 server 會自動往後找)
function startServer({ nodeArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auq-test-'));
  const startPort = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [...nodeArgs, serverPath, '--port', String(startPort)], { cwd: dir });
  let log = '';
  const waiters = [];
  const onData = (chunk) => {
    log += chunk;
    for (const w of [...waiters]) {
      if (w.re.test(log)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const s = {
    dir,
    proc,
    port: 0,
    waitForLog(re, ms = 5000) {
      if (re.test(log)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等不到 log ${re}\n${log}`)), ms);
        waiters.push({ re, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    }
  };
  servers.push(s);
  return s.waitForLog(/\[AUQ:ready\] http:\/\/127\.0\.0\.1:(\d+)\//).then(() => {
    s.port = Number(log.match(/\[AUQ:ready\] http:\/\/127\.0\.0\.1:(\d+)\//)[1]);
    return s;
  });
}

function writeAsk(s, id, data) {
  fs.writeFileSync(path.join(s.dir, '.auq', 'outbox', `${id}.json`), JSON.stringify(data));
}

// 用 http 模組送請求，才能自訂 Host 標頭；origin 預設帶同源
function request(s, { path: p, method = 'GET', body, host, origin }) {
  const headers = { host: host || `127.0.0.1:${s.port}` };
  if (origin !== null) headers.origin = origin || `http://127.0.0.1:${s.port}`;
  if (body) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: s.port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// 連上 SSE，等待指定事件
function openEvents(s) {
  const queue = [];
  const waiters = [];
  let buffer = '';
  const req = http.get({ hostname: '127.0.0.1', port: s.port, path: '/events?cid=test&visible=1', headers: { host: `127.0.0.1:${s.port}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = block.match(/^event: (.+)$/m);
        const data = block.match(/^data: (.+)$/m);
        if (!event) continue;
        const item = { event: event[1], data: data ? JSON.parse(data[1]) : null };
        const w = waiters.find((x) => x.event === item.event);
        if (w) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(item.data);
        } else {
          queue.push(item);
        }
      }
    });
  });
  return {
    waitFor(event, ms = 5000) {
      const i = queue.findIndex((x) => x.event === event);
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0].data);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等不到 SSE 事件 ${event}`)), ms);
        waiters.push({ event, resolve: (d) => { clearTimeout(timer); resolve(d); } });
      });
    },
    close() {
      req.destroy();
    }
  };
}
