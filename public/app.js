// askUserQuestion Web 前端：SSE 接收題目、作答後送回 server、回報頁面可見狀態
const asksBox = document.querySelector('[data-asks]');
const emptyBox = document.querySelector('[data-empty]');
const connBadge = document.querySelector('[data-conn]');
const notifyBtn = document.querySelector('[data-enable-notify]');
const langBtn = document.querySelector('[data-lang-switch]');
const tplAsk = document.querySelector('[data-tpl-ask]');
const tplQuestion = document.querySelector('[data-tpl-question]');
const tplOption = document.querySelector('[data-tpl-option]');
const tplDone = document.querySelector('[data-tpl-done]');
const otherValue = '__other__';
// 預覽不載入任何 CSS 框架，Claude 以 inline style 或 <style> 撰寫；這裡只給基本字型與間距
const previewHead = [
  '<meta charset="utf-8">',
  '<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;background:transparent}',
  'body{padding:12px;font-family:system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;font-size:14px;line-height:1.5;color:#1f2937}</style>'
].join('');
// 回報內容高度給主頁面，iframe 才能依內容調整高度
const previewFoot = '<script>new ResizeObserver(() => parent.postMessage({ auqPreviewHeight: document.documentElement.scrollHeight }, "*")).observe(document.documentElement);</script>';
const previewMaxHeight = 480;
const cid = getClientId();
const pendingForms = new Map();
let audioCtx = null;
let source = null;

applyI18n();
refreshNotifyBtn();
connect();

langBtn.addEventListener('click', () => {
  setLang(getLang() === 'zh-TW' ? 'en' : 'zh-TW');
  updateState();
});
notifyBtn.addEventListener('click', enableNotify);
// 瀏覽器要求使用者互動後才能播放聲音，第一次點擊頁面就解鎖
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('visibilitychange', sendPresence);
window.addEventListener('message', resizePreview);

// ---------- functions ----------

function connect() {
  source = new EventSource(`/events?cid=${cid}&visible=${isVisible() ? 1 : 0}`);
  source.addEventListener('open', () => {
    setConn('connected', 'badge-ok');
    // 重連時網址上的 visible 可能已過時，連上後再回報一次
    sendPresence();
  });
  source.addEventListener('error', () => setConn('disconnected', 'badge-error'));
  source.addEventListener('snapshot', (e) => {
    const asks = JSON.parse(e.data);
    const ids = new Set(asks.map((a) => a.id));
    for (const id of [...pendingForms.keys()]) {
      if (!ids.has(id)) removeAsk(id);
    }
    for (const ask of asks) {
      if (!pendingForms.has(ask.id)) renderAsk(ask);
    }
    updateState();
  });
  source.addEventListener('ask', (e) => {
    const ask = JSON.parse(e.data);
    if (pendingForms.has(ask.id)) return;
    renderAsk(ask);
    updateState();
    alertNewAsk(ask);
  });
  // 其他分頁作答、略過，或 server 改回傳統 AskUserQuestion 時同步移除
  source.addEventListener('done', (e) => {
    const { id, status } = JSON.parse(e.data);
    const form = pendingForms.get(id);
    // 自己送出的由 fetch 回應處理，避免 SSE 先到而顯示成其他分頁作答
    if (!form || form.dataset.sending) return;
    const titles = { answered: 'doneAnswered', cancelled: 'doneCancelled', fallback: 'doneFallback' };
    showDone(form, '↪️', titles[status] || 'doneOther', []);
  });
  // 閒置太久：先斷線讓 server 知道頁面已離開，再嘗試關閉分頁
  source.addEventListener('idle-close', closeForIdle);
}

function closeForIdle() {
  source.close();
  window.close();
  // 瀏覽器不允許關閉時 (分頁不是由腳本開啟)，改顯示提示
  setTimeout(() => {
    setConn('idleClosed', 'badge-ghost');
    asksBox.replaceChildren();
    pendingForms.clear();
    emptyBox.replaceChildren();
    const icon = document.createElement('div');
    icon.className = 'auq-empty-icon';
    icon.textContent = '💤';
    const text = document.createElement('p');
    text.className = 'muted';
    setText(text, 'idleText');
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-outline';
    btn.type = 'button';
    setText(btn, 'reconnect');
    btn.addEventListener('click', () => location.reload());
    emptyBox.append(icon, text, btn);
    updateState();
  }, 300);
}

function renderAsk(ask) {
  const form = tplAsk.content.firstElementChild.cloneNode(true);
  form.dataset.id = ask.id;
  form.querySelector('[data-ask-id]').textContent = ask.id;
  const time = form.querySelector('[data-ask-time]');
  time.dateTime = ask.ts;
  time.textContent = new Date(ask.ts).toLocaleTimeString('zh-TW', { hour12: false });

  const list = form.querySelector('[data-questions]');
  ask.questions.forEach((q, qi) => list.append(renderQuestion(ask.id, q, qi)));

  form.addEventListener('change', () => updateSubmit(form));
  form.addEventListener('input', () => updateSubmit(form));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAnswer(form, ask);
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.querySelector('[data-cancel]').addEventListener('click', () => cancelAsk(form, ask));

  applyI18n(form);
  asksBox.append(form);
  pendingForms.set(ask.id, form);
  const first = form.querySelector('[data-input]');
  if (pendingForms.size === 1 && first) first.focus({ preventScroll: true });
}

function renderQuestion(askId, q, qi) {
  const fieldset = tplQuestion.content.firstElementChild.cloneNode(true);
  const name = `${askId}-q${qi}`;
  const type = q.multiSelect ? 'checkbox' : 'radio';
  fieldset.querySelector('[data-q-header]').textContent = q.header;
  setText(fieldset.querySelector('[data-q-mode]'), q.multiSelect ? 'multi' : 'single');
  fieldset.querySelector('[data-q-text]').textContent = q.question;

  const optionsBox = fieldset.querySelector('[data-options]');
  for (const opt of q.options) {
    optionsBox.append(renderOption({ type, name, value: opt.label, label: opt.label, desc: opt.description }));
  }
  const otherOpt = renderOption({ type, name, value: otherValue, label: t('otherLabel'), desc: t('otherDesc') });
  otherOpt.querySelector('[data-opt-label]').dataset.i18n = 'otherLabel';
  otherOpt.querySelector('[data-opt-desc]').dataset.i18n = 'otherDesc';
  const otherText = document.createElement('textarea');
  otherText.className = 'field hidden';
  otherText.rows = 2;
  otherText.maxLength = 2000;
  otherText.dataset.i18nPlaceholder = 'otherPlaceholder';
  otherText.placeholder = t('otherPlaceholder');
  otherText.dataset.other = '';
  optionsBox.append(otherOpt, otherText);
  fieldset.addEventListener('change', () => {
    const checked = otherOpt.querySelector('input').checked;
    otherText.classList.toggle('hidden', !checked);
    if (checked && document.activeElement !== otherText) otherText.focus();
  });

  if (q.options.some(hasPreview)) setupPreview(fieldset, q);
  return fieldset;
}

function renderOption({ type, name, value, label, desc }) {
  const el = tplOption.content.firstElementChild.cloneNode(true);
  const input = el.querySelector('[data-input]');
  input.type = type;
  input.name = name;
  input.value = value;
  input.className = 'choice';
  el.dataset.label = label;
  el.querySelector('[data-opt-label]').textContent = label;
  const descEl = el.querySelector('[data-opt-desc]');
  if (desc) descEl.textContent = desc;
  else descEl.remove();
  return el;
}

function hasPreview(opt) {
  return Boolean(opt.previewHtml || opt.preview);
}

// 有 preview 時左右分欄：滑過或聚焦的選項優先，其次是已勾選的，最後是第一個有 preview 的
// previewHtml 優先於純文字 preview；每個選項一個 iframe，切換時不用重新渲染
function setupPreview(fieldset, q) {
  const body = fieldset.querySelector('.auq-body');
  const pane = fieldset.querySelector('[data-preview]');
  const box = fieldset.querySelector('[data-preview-box]');
  const labelEl = fieldset.querySelector('[data-preview-label]');
  const options = [...fieldset.querySelectorAll('.auq-option')];
  body.classList.add('has-preview');
  pane.classList.remove('hidden');
  const frames = q.options.map((opt) => (opt.previewHtml ? createPreviewFrame(opt.previewHtml) : null));
  for (const frame of frames) {
    if (frame) pane.append(frame);
  }

  const show = (index) => {
    const target = index >= 0 && q.options[index] && hasPreview(q.options[index]) ? index : -1;
    const checked = options.findIndex((o, i) => o.querySelector('input').checked && q.options[i] && hasPreview(q.options[i]));
    const current = target >= 0 ? target : checked >= 0 ? checked : q.options.findIndex(hasPreview);
    const opt = q.options[current];
    setText(labelEl, 'previewLabel', { label: opt.label });
    frames.forEach((frame, i) => frame && frame.classList.toggle('hidden', i !== current));
    box.classList.toggle('hidden', Boolean(opt.previewHtml));
    box.textContent = opt.previewHtml ? '' : opt.preview;
  };
  options.forEach((opt, i) => {
    opt.addEventListener('pointerenter', () => show(i));
    opt.addEventListener('focusin', () => show(i));
  });
  fieldset.querySelector('[data-options]').addEventListener('pointerleave', () => show(-1));
  fieldset.addEventListener('change', () => show(-1));
  show(-1);
}

// sandbox 只給 allow-scripts (回報高度用)、不給 allow-same-origin：預覽無法存取主頁面、cookie 與 API
function createPreviewFrame(html) {
  const frame = document.createElement('iframe');
  frame.className = 'auq-preview-frame hidden';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = t('previewTitle');
  frame.srcdoc = `<!doctype html><html><head>${previewHead}</head><body>${html}${previewFoot}</body></html>`;
  return frame;
}

function resizePreview(e) {
  const height = e.data && Number(e.data.auqPreviewHeight);
  if (!height) return;
  const frame = [...document.querySelectorAll('.auq-preview-frame')].find((f) => f.contentWindow === e.source);
  if (frame) frame.style.height = `${Math.min(Math.ceil(height), previewMaxHeight)}px`;
}

function collectAnswers(form) {
  return [...form.querySelectorAll('.auq-question')].map((fieldset) => {
    const checked = [...fieldset.querySelectorAll('[data-input]:checked')].map((i) => i.value);
    const otherOn = checked.includes(otherValue);
    return {
      selected: checked.filter((v) => v !== otherValue),
      other: otherOn ? fieldset.querySelector('[data-other]').value.trim() : '',
      otherOn,
      notes: fieldset.querySelector('[data-notes]').value.trim()
    };
  });
}

// 每題都要有選項，勾了 Other 就要填文字
function updateSubmit(form) {
  const ready = collectAnswers(form).every((a) => (a.selected.length || a.otherOn) && (!a.otherOn || a.other));
  form.querySelector('[data-submit]').disabled = !ready;
  return ready;
}

async function submitAnswer(form, ask) {
  if (!updateSubmit(form)) return;
  const answers = collectAnswers(form).map(({ selected, other, notes }) => ({ selected, other, notes }));
  const result = await postJson('/api/answer', { id: ask.id, answers }, form);
  if (!result) return;
  const summary = ask.questions.map((q, i) => {
    const parts = [...answers[i].selected];
    if (answers[i].other) parts.push(t('summaryOther', { text: answers[i].other }));
    const notes = answers[i].notes ? t('summaryNotes', { text: answers[i].notes }) : '';
    return `${q.header}${t('summaryColon')}${parts.join(t('summarySep'))}${notes}`;
  });
  showDone(form, '✅', 'sent', summary);
}

async function cancelAsk(form, ask) {
  const result = await postJson('/api/cancel', { id: ask.id }, form);
  if (result) showDone(form, '⏭️', 'skipped', []);
}

async function postJson(url, data, form) {
  const errorEl = form ? form.querySelector('[data-error]') : null;
  if (form) {
    form.dataset.sending = '1';
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.code ? t(`err.${json.code}`, { n: json.n }) : json.error || `HTTP ${res.status}`);
    return json;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = t('submitFailed', { msg: err.message });
      errorEl.classList.remove('hidden');
    }
    if (form) {
      delete form.dataset.sending;
      form.querySelector('[data-cancel]').disabled = false;
      updateSubmit(form);
    }
    return null;
  }
}

// 作答後把卡片換成結果摘要 (不保留歷史，重新整理後就消失)
function showDone(form, icon, titleKey, lines) {
  const done = tplDone.content.firstElementChild.cloneNode(true);
  done.querySelector('[data-done-icon]').textContent = icon;
  setText(done.querySelector('[data-done-title]'), titleKey);
  const list = done.querySelector('[data-done-list]');
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  }
  pendingForms.delete(form.dataset.id);
  form.replaceWith(done);
  updateState();
}

function removeAsk(id) {
  const form = pendingForms.get(id);
  if (form) form.remove();
  pendingForms.delete(id);
}

function updateState() {
  emptyBox.classList.toggle('hidden', asksBox.children.length > 0);
  document.title = pendingForms.size ? `(${pendingForms.size}) askUserQuestion Web` : 'askUserQuestion Web';
}

function setConn(key, cls) {
  setText(connBadge, key);
  connBadge.className = `badge ${cls}`;
}

function isVisible() {
  return document.visibilityState === 'visible';
}

function sendPresence() {
  fetch('/api/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cid, visible: isVisible() }),
    keepalive: true
  }).catch(() => {});
}

function getClientId() {
  let id = '';
  try {
    id = sessionStorage.getItem('auq-cid') || '';
  } catch {
    // 無法使用 sessionStorage 時每次產生新的 id
  }
  if (!id) {
    id = Math.random().toString(36).slice(2, 12);
    try {
      sessionStorage.setItem('auq-cid', id);
    } catch {
      // 忽略
    }
  }
  return id;
}

async function enableNotify() {
  unlockAudio();
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  refreshNotifyBtn();
  beep();
}

// 通知權限跟著網址記住，回應過一次 (允許或拒絕) 就不再顯示按鈕；頁面每次重開都要點過才有提示音，不靠這顆按鈕
function refreshNotifyBtn() {
  const answered = !('Notification' in window) || Notification.permission !== 'default';
  notifyBtn.classList.toggle('hidden', answered);
}

function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  refreshNotifyBtn();
}

// 用 Web Audio 產生兩聲提示音，不需要音檔
function beep() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  [[880, 0], [1320, 0.16]].forEach(([freq, offset]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.15);
  });
}

function alertNewAsk(ask) {
  beep();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (isVisible() && document.hasFocus()) return;
  const first = ask.questions[0];
  const n = new Notification(t('notifyTitle', { header: first.header }), { body: first.question, tag: ask.id });
  n.addEventListener('click', () => {
    window.focus();
    n.close();
  });
}
