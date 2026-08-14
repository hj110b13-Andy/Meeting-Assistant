/**
 * 設定頁。
 *
 * 刻意只留必要欄位：金鑰、名字、背景筆記、自架 Jitsi 網域。後端、模型、
 * 辨識引擎全部寫死在 settings.js —— 每多一個開關就多一種設錯的方式，
 * 而設錯的症狀（變慢、品質變差、安靜地不動）使用者根本看不出是設定造成的。
 */
const $ = (id) => document.getElementById(id);
const FIELDS = ['myNames', 'notes', 'jitsiDomains'];
const KEY_FIELDS = ['groq', 'nvidia', 'nvidia2', 'tavily'];

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'ma:settings:get' });
  for (const f of FIELDS) if (s[f] !== undefined) $(f).value = s[f];
  $('summaryEverySegments').value = s.summaryEverySegments;
  // 內部存毫秒，介面用秒 —— 使用者不必數 0
  $('summaryEverySeconds').value = Math.round(s.summaryEveryMs / 1000);
  await loadKeys();
}

/**
 * 金鑰的現況。
 *
 * **不把金鑰本身填回輸入框**，只顯示遮罩過的摘要 —— 這個頁面會出現在
 * 截圖與螢幕分享裡。輸入框留空代表「不修改」，填了才會覆蓋，
 * 所以使用者可以只改其中一把而不必重貼全部。
 */
async function loadKeys() {
  const r = await chrome.runtime.sendMessage({ type: 'ma:keys:get' });
  if (!r) return;
  const names = { groq: 'Groq', nvidia: 'NVIDIA 1', nvidia2: 'NVIDIA 2', tavily: 'Tavily' };
  const parts = KEY_FIELDS.map((f) => `${names[f]}：${r.masked?.[f] || '（未設定）'}`);
  $('keysCurrent').innerHTML = `目前已存：${parts.join('　')}<br>`
    + '輸入框留空表示「不修改」，要換掉某一把才需要重新貼上。';

  // 貼錯欄位是最常見又最難查的錯：症狀是 401，而 401 看起來像「金鑰過期」，
  // 於是使用者會跑去重新簽發一把新的，然後再貼錯一次。
  if (r.mismatched?.length) {
    const msg = r.mismatched.map((m) => `「${m.label}」應該以 ${m.prefix} 開頭`).join('；');
    $('keysCurrent').innerHTML += `<br><strong style="color:#dc2626">看起來貼錯欄位了：${msg}</strong>`;
  }
}

$('saveKeys').addEventListener('click', async () => {
  const patch = {};
  for (const f of KEY_FIELDS) {
    const v = $(f).value.trim();
    if (v) patch[f] = v;          // 留空 = 不動既有的那把
  }
  if (!Object.keys(patch).length) {
    $('keysSaved').textContent = '沒有填任何金鑰（留空表示不修改）';
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'ma:keys:set', patch });
  for (const f of KEY_FIELDS) $(f).value = '';   // 存完就清掉，不留在畫面上
  $('keysSaved').textContent = r?.ok ? '已儲存 ✓' : '儲存失敗';
  setTimeout(() => ($('keysSaved').textContent = ''), 2500);
  await loadKeys();
});

/**
 * 測試按鈕。測的是**已經存起來的**金鑰，不是輸入框裡的字 ——
 * 使用者實際會用到的是存起來那份，測輸入框那份可能測過了卻忘記按儲存。
 */
function wireTest(buttonId, stateId, vendor) {
  $(buttonId).addEventListener('click', async () => {
    const el = $(stateId);
    el.className = 'keystate';
    el.textContent = '測試中…';
    const r = await chrome.runtime.sendMessage({ type: 'ma:keys:test', vendor });
    if (r?.ok) {
      el.className = 'keystate ok';
      el.textContent = `可以用 ✓（${r.ms} 毫秒${r.model ? `，${r.model}` : ''}）`;
    } else {
      el.className = 'keystate bad';
      el.textContent = `不能用：${r?.error || '未知錯誤'}`;
    }
  });
}

wireTest('testGroq', 'groqState', 'groq');
wireTest('testNim', 'nimState', 'nim');
wireTest('testNim2', 'nim2State', 'nim2');
wireTest('testTavily', 'tavilyState', 'tavily');

$('save').addEventListener('click', async () => {
  const patch = {};
  for (const f of FIELDS) patch[f] = $(f).value.trim();
  // 夾在合理範圍內：段數太小會為兩句話跑一次，秒數太小會很快吃掉 Pro 額度。
  // 空白或亂填時回到預設值，而不是存進一個會讓摘要再也不觸發的數字。
  patch.summaryEverySegments = Math.min(50, Math.max(2, Number($('summaryEverySegments').value) || 8));
  patch.summaryEveryMs = Math.min(1800, Math.max(15, Number($('summaryEverySeconds').value) || 300)) * 1000;
  await chrome.runtime.sendMessage({ type: 'ma:settings:set', patch });
  $('saved').textContent = '已儲存 ✓';
  setTimeout(() => ($('saved').textContent = ''), 2500);
});

/**
 * 自架 Jitsi：向使用者要網域授權，再請背景註冊內容腳本。
 * chrome.permissions.request 必須從使用者手勢裡呼叫，所以只能放在這個頁面。
 */
function toPatterns(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))
    .map((host) => `https://${host}/*`);
}

$('jitsiGrant').addEventListener('click', async () => {
  const raw = $('jitsiDomains').value.trim();
  const origins = toPatterns(raw);
  if (!origins.length) { $('jitsiState').textContent = '請先填入至少一個網域'; return; }

  $('jitsiState').textContent = '等待授權…';
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch (err) {
    $('jitsiState').textContent = `授權失敗：${err.message}`;
    return;
  }
  if (!granted) { $('jitsiState').textContent = '授權被取消，這些網域不會生效'; return; }

  // 先存網域再叫背景註冊，否則背景讀到的還是舊值
  await chrome.runtime.sendMessage({ type: 'ma:settings:set', patch: { jitsiDomains: raw } });
  const res = await chrome.runtime.sendMessage({ type: 'ma:jitsi:sync' });
  $('jitsiState').textContent = res?.ok
    ? `已啟用 ${res.granted.length} 個網域 ✓　重新載入會議分頁即可生效`
    : `註冊失敗：${res?.error || '未知錯誤'}`;
});

/**
 * 本機原生辨識的狀態。
 *
 * 「有沒有裝」使用者自己看不出來 —— 檔案在 %LOCALAPPDATA% 而不是擴充功能資料夾，
 * 而且失敗時擴充功能會退到 WASM 備援。所以給一顆按鈕問清楚。
 */
$('sttCheck').addEventListener('click', async () => {
  $('sttState').textContent = '檢查中…';
  const r = await chrome.runtime.sendMessage({ type: 'ma:stt:status' });
  if (!r?.ok) {
    $('sttState').textContent = `問不到（橋接未就緒？）：${r?.error || '未知錯誤'}`;
    return;
  }
  if (!r.installed) {
    $('sttState').textContent = '尚未安裝 — 請執行 tools\\install-whisper.ps1';
    return;
  }
  const models = (r.models || []).map((m) => (m.includes('small') ? 'small' : m.includes('base') ? 'base' : m));
  $('sttState').textContent =
    `已安裝 ✓　模型：${models.join('、') || '（無）'}　伺服器：${r.running ? '執行中' : '未執行（要用時才啟動）'}`;
});

$('sttStop').addEventListener('click', async () => {
  $('sttState').textContent = '停止中…';
  await chrome.runtime.sendMessage({ type: 'ma:stt:stop' });
  $('sttState').textContent = '已要求停止辨識伺服器（記憶體會還回來，下次用時自動重啟）';
});

load();
