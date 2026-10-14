// askUserQuestion Web 前端：SSE 接收題目、作答後送回 server、回報頁面可見狀態
const asksBox = document.querySelector('[data-asks]');
const emptyBox = document.querySelector('[data-empty]');
const connBadge = document.querySelector('[data-conn]');
const notifyBtn = document.querySelector('[data-enable-notify]');
const tplAsk = document.querySelector('[data-tpl-ask]');
const tplQuestion = document.querySelector('[data-tpl-question]');
const tplOption = document.querySelector('[data-tpl-option]');
const tplDone = document.querySelector('[data-tpl-done]');
const otherValue = '__other__';
const cid = getClientId();
const pendingForms = new Map();
let audioCtx = null;

refreshNotifyBtn();
connect();

notifyBtn.addEventListener('click', enableNotify);
// 瀏覽器要求使用者互動後才能播放聲音，第一次點擊頁面就解鎖
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('visibilitychange', sendPresence);

// ---------- functions ----------

function connect() {
  const source = new EventSource(`/events?cid=${cid}&visible=${isVisible() ? 1 : 0}`);
  source.addEventListener('open', () => {
    setConn('已連線', 'badge-success');
    // 重連時網址上的 visible 可能已過時，連上後再回報一次
    sendPresence();
  });
  source.addEventListener('error', () => setConn('連線中斷，重試中…', 'badge-error'));
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
    const titles = { answered: '已在其他分頁作答', cancelled: '已略過', fallback: '已改回終端機的 AskUserQuestion' };
    showDone(form, '↪️', titles[status] || '已結束', []);
  });
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
  fieldset.querySelector('[data-q-mode]').textContent = q.multiSelect ? '可複選' : '單選';
  fieldset.querySelector('[data-q-text]').textContent = q.question;

  const optionsBox = fieldset.querySelector('[data-options]');
  for (const opt of q.options) {
    optionsBox.append(renderOption({ type, name, value: opt.label, label: opt.label, desc: opt.description, preview: opt.preview }));
  }
  const otherOpt = renderOption({ type, name, value: otherValue, label: 'Other', desc: '以上都不是，自行輸入', preview: '' });
  const otherText = document.createElement('textarea');
  otherText.className = 'textarea textarea-bordered w-full hidden';
  otherText.rows = 2;
  otherText.maxLength = 2000;
  otherText.placeholder = '輸入你的答案';
  otherText.dataset.other = '';
  optionsBox.append(otherOpt, otherText);
  fieldset.addEventListener('change', () => {
    const checked = otherOpt.querySelector('input').checked;
    otherText.classList.toggle('hidden', !checked);
    if (checked && document.activeElement !== otherText) otherText.focus();
  });

  if (q.options.some((o) => o.preview)) setupPreview(fieldset, q);
  return fieldset;
}

function renderOption({ type, name, value, label, desc, preview }) {
  const el = tplOption.content.firstElementChild.cloneNode(true);
  const input = el.querySelector('[data-input]');
  input.type = type;
  input.name = name;
  input.value = value;
  input.className = `${type === 'radio' ? 'radio' : 'checkbox'} radio-primary checkbox-primary mt-1 shrink-0`;
  el.dataset.previewText = preview || '';
  el.dataset.label = label;
  el.querySelector('[data-opt-label]').textContent = label;
  const descEl = el.querySelector('[data-opt-desc]');
  if (desc) descEl.textContent = desc;
  else descEl.remove();
  return el;
}

// 有 preview 時左右分欄：滑過或聚焦的選項優先，其次是已勾選的，最後是第一個有 preview 的
function setupPreview(fieldset, q) {
  const body = fieldset.querySelector('.auq-body');
  const pane = fieldset.querySelector('[data-preview]');
  const box = fieldset.querySelector('[data-preview-box]');
  const labelEl = fieldset.querySelector('[data-preview-label]');
  const options = [...fieldset.querySelectorAll('.auq-option')];
  body.classList.add('has-preview');
  pane.classList.remove('hidden');

  const show = (opt) => {
    const target = opt && opt.dataset.previewText ? opt : null;
    const fallback = options.find((o) => o.querySelector('input').checked && o.dataset.previewText)
      || options.find((o) => o.dataset.label === q.options.find((x) => x.preview).label);
    const current = target || fallback;
    labelEl.textContent = `預覽：${current.dataset.label}`;
    box.textContent = current.dataset.previewText;
  };
  for (const opt of options) {
    opt.addEventListener('pointerenter', () => show(opt));
    opt.addEventListener('focusin', () => show(opt));
  }
  fieldset.querySelector('[data-options]').addEventListener('pointerleave', () => show(null));
  fieldset.addEventListener('change', () => show(null));
  show(null);
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
    if (answers[i].other) parts.push(`Other：${answers[i].other}`);
    return `${q.header}：${parts.join('、')}${answers[i].notes ? `（備註：${answers[i].notes}）` : ''}`;
  });
  showDone(form, '✅', '已送出，Claude 會繼續處理', summary);
}

async function cancelAsk(form, ask) {
  const result = await postJson('/api/cancel', { id: ask.id }, form);
  if (result) showDone(form, '⏭️', '已略過這組問題', []);
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
    if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = `送出失敗：${err.message}`;
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
function showDone(form, icon, title, lines) {
  const done = tplDone.content.firstElementChild.cloneNode(true);
  done.querySelector('[data-done-icon]').textContent = icon;
  done.querySelector('[data-done-title]').textContent = title;
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

function setConn(text, cls) {
  connBadge.textContent = text;
  connBadge.className = `badge badge-sm ${cls}`;
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

function refreshNotifyBtn() {
  const granted = !('Notification' in window) || Notification.permission !== 'default';
  notifyBtn.classList.toggle('hidden', granted && audioCtx !== null);
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
  const n = new Notification(`Claude 提問：${first.header}`, { body: first.question, tag: ask.id });
  n.addEventListener('click', () => {
    window.focus();
    n.close();
  });
}
