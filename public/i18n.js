// 頁面中英介面：依瀏覽器語言自動選擇，頁首可切換，選擇記在 localStorage
const messages = {
  'zh-TW': {
    title: 'askUserQuestion Web',
    connecting: '連線中…',
    connected: '已連線',
    disconnected: '連線中斷，重試中…',
    idleClosed: '已閒置關閉',
    enableNotify: '🔔 啟用通知',
    langSwitch: 'EN',
    langSwitchLabel: 'Switch to English',
    waiting: '等待 Claude 提問…',
    waitingHint: '新題目到達時會自動顯示，啟用通知後也會提示音與桌面通知',
    submitHint: 'Ctrl / ⌘ + Enter 送出',
    skip: '略過',
    submit: '送出',
    addNote: '加上備註',
    notesPlaceholder: '補充說明（選填）',
    single: '單選',
    multi: '可複選',
    otherLabel: 'Other',
    otherDesc: '以上都不是，自行輸入',
    otherPlaceholder: '輸入你的答案',
    previewLabel: '預覽：{label}',
    previewTitle: '選項預覽',
    sent: '已送出，Claude 會繼續處理',
    skipped: '已略過這組問題',
    doneAnswered: '已在其他分頁作答',
    doneCancelled: '已略過',
    doneFallback: '已改回終端機的 AskUserQuestion',
    doneOther: '已結束',
    summaryOther: 'Other：{text}',
    summaryNotes: '（備註：{text}）',
    summarySep: '、',
    summaryColon: '：',
    submitFailed: '送出失敗：{msg}',
    idleText: '閒置一段時間沒有新問題，頁面已停止連線，可以關閉此分頁',
    reconnect: '重新連線',
    notifyTitle: 'Claude 提問：{header}',
    'err.forbidden': '來源不允許',
    'err.not_found': '題目不存在或已作答',
    'err.count_mismatch': '答案數量與題目不符',
    'err.unanswered': '第 {n} 題尚未作答',
    'err.single_only': '第 {n} 題為單選',
    'err.too_large': '內容太大',
    'err.invalid_json': '資料格式錯誤',
    'err.write_failed': '寫入失敗'
  },
  en: {
    title: 'askUserQuestion Web',
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnected: 'Disconnected, retrying…',
    idleClosed: 'Closed (idle)',
    enableNotify: '🔔 Enable alerts',
    langSwitch: '中文',
    langSwitchLabel: '切換成中文',
    waiting: 'Waiting for Claude to ask…',
    waitingHint: 'New questions appear here automatically. Enable alerts to get a sound and a desktop notification.',
    submitHint: 'Ctrl / ⌘ + Enter to submit',
    skip: 'Skip',
    submit: 'Submit',
    addNote: 'Add a note',
    notesPlaceholder: 'Extra details (optional)',
    single: 'Pick one',
    multi: 'Pick any',
    otherLabel: 'Other',
    otherDesc: 'None of the above, type your own',
    otherPlaceholder: 'Type your answer',
    previewLabel: 'Preview: {label}',
    previewTitle: 'Option preview',
    sent: 'Submitted. Claude will continue.',
    skipped: 'You skipped these questions',
    doneAnswered: 'Answered in another tab',
    doneCancelled: 'Skipped',
    doneFallback: 'Moved back to AskUserQuestion in the terminal',
    doneOther: 'Closed',
    summaryOther: 'Other: {text}',
    summaryNotes: ' (note: {text})',
    summarySep: ', ',
    summaryColon: ': ',
    submitFailed: 'Could not submit: {msg}',
    idleText: 'No new questions for a while, so this page has disconnected. You can close this tab.',
    reconnect: 'Reconnect',
    notifyTitle: 'Claude asks: {header}',
    'err.forbidden': 'Origin not allowed',
    'err.not_found': 'This question no longer exists or was already answered',
    'err.count_mismatch': 'The number of answers does not match the questions',
    'err.unanswered': 'Question {n} has no answer yet',
    'err.single_only': 'Question {n} allows only one choice',
    'err.too_large': 'Too much data',
    'err.invalid_json': 'Invalid data',
    'err.write_failed': 'Could not save the answer'
  }
};
const langKey = 'auq-lang';
let lang = loadLang();

// 取得目前語言的字串，{name} 以 params 取代；找不到時退回英文，再退回 key
function t(key, params = {}) {
  const text = messages[lang][key] ?? messages.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

function getLang() {
  return lang;
}

function setLang(next) {
  lang = messages[next] ? next : 'en';
  try {
    localStorage.setItem(langKey, lang);
  } catch {
    // 無法儲存時只在這次瀏覽有效
  }
  applyI18n();
}

// 設定文字並記下 key 與參數，切換語言時 applyI18n 會重新翻譯
function setText(el, key, params) {
  el.dataset.i18n = key;
  if (params) el.dataset.i18nArgs = JSON.stringify(params);
  else delete el.dataset.i18nArgs;
  el.textContent = t(key, params);
}

// 套用到所有 data-i18n (文字，參數放 data-i18n-args)、data-i18n-placeholder、data-i18n-label (aria-label) 標記的元素
// <template> 的內容不會被 querySelectorAll 找到，複製出來後要另外對該節點呼叫
function applyI18n(root = document) {
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant' : 'en';
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n, el.dataset.i18nArgs ? JSON.parse(el.dataset.i18nArgs) : {});
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nLabel)); });
}

function loadLang() {
  try {
    const saved = localStorage.getItem(langKey);
    if (saved && messages[saved]) return saved;
  } catch {
    // 讀不到就用瀏覽器語言
  }
  return /^zh/i.test(navigator.language || '') ? 'zh-TW' : 'en';
}
