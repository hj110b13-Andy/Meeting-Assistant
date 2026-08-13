/**
 * 設定頁。
 *
 * 刻意只留三個欄位：名字、背景筆記、自架 Jitsi 網域。後端、模型、辨識引擎、
 * 摘要頻率全部寫死在 settings.js —— 每多一個開關就多一種設錯的方式，
 * 而設錯的症狀（變慢、品質變差、安靜地不動）使用者根本看不出是設定造成的。
 */
const $ = (id) => document.getElementById(id);
const FIELDS = ['myNames', 'notes', 'jitsiDomains'];

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'ma:settings:get' });
  for (const f of FIELDS) if (s[f] !== undefined) $(f).value = s[f];
}

$('save').addEventListener('click', async () => {
  const patch = {};
  for (const f of FIELDS) patch[f] = $(f).value.trim();
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
