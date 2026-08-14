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
 *
 * 代價是「存完之後框是空的」，看起來很像沒存成功。所以狀態要放在
 * **每個欄位自己身上**（placeholder 與旁邊那行字），而不是只寫在
 * 頁面下方的總結 —— 使用者盯著欄位看的時候，根本看不到下面那行。
 */
const PLACEHOLDERS = { groq: 'gsk_…', nvidia: 'nvapi-…', nvidia2: 'nvapi-…', tavily: 'tvly-…' };

async function loadKeys() {
  const r = await chrome.runtime.sendMessage({ type: 'ma:keys:get' });
  if (!r) return;
  const names = { groq: 'Groq', nvidia: 'NVIDIA 1', nvidia2: 'NVIDIA 2', tavily: 'Tavily' };

  const stateIds = { groq: 'groqState', nvidia: 'nimState', nvidia2: 'nim2State', tavily: 'tavilyState' };
  for (const f of KEY_FIELDS) {
    const input = $(f);
    const el = $(stateIds[f]);
    if (r.present?.[f]) {
      input.placeholder = `已儲存 ${r.masked[f]}　—　留空不動它，要換才重貼`;
      // 「測試中…」之類的暫時訊息不要被蓋掉
      if (el && !el.textContent.includes('測試中')) {
        el.className = 'keystate ok';
        el.textContent = `已儲存 ${r.masked[f]}`;
      }
    } else {
      input.placeholder = PLACEHOLDERS[f];
      if (el && !el.textContent) el.textContent = '（未設定）';
    }
  }

  const parts = KEY_FIELDS.map((f) => `${names[f]}：${r.masked?.[f] || '（未設定）'}`);
  $('keysCurrent').innerHTML = `目前已存：${parts.join('　')}<br>`
    + '<strong>存好之後輸入框會清空，這是正常的</strong> —— 金鑰不留在畫面上，'
    + '因為這一頁很可能出現在螢幕分享或截圖裡。上面每個欄位會顯示它存了哪一把，'
    + '留空就是「不動它」。';

  // 貼錯欄位是最常見又最難查的錯：症狀是 401，而 401 看起來像「金鑰過期」，
  // 於是使用者會跑去重新簽發一把新的，然後再貼錯一次。
  if (r.mismatched?.length) {
    const msg = r.mismatched.map((m) => `「${m.label}」應該以 ${m.prefix} 開頭`).join('；');
    $('keysCurrent').innerHTML += `<br><strong style="color:#dc2626">看起來貼錯欄位了：${msg}</strong>`;
  }
}

/**
 * 有沒有還沒存的變更。
 *
 * 這一頁比一個螢幕長，很容易填完就直接關掉。沒有這個提示的話，
 * 「我明明填了」與「它沒存」之間完全沒有線索。
 */
function markDirty() {
  $('dirty').textContent = '● 有變更還沒儲存';
}

for (const f of [...FIELDS, ...KEY_FIELDS, 'summaryEverySegments', 'summaryEverySeconds']) {
  $(f)?.addEventListener('input', markDirty);
}

/**
 * 測試按鈕。
 *
 * **測的是輸入框裡當下那把**，框裡空的時候才回頭測已經存起來的。
 *
 * 這裡原本反過來（只測已存的），理由是「使用者真正會用到的是存起來那份」。
 * 那個理由本身沒錯，但它忽略了實際的操作順序是**貼上 → 測試 → 才儲存** ——
 * 於是剛貼完金鑰按測試會得到「沒有填金鑰」，而使用者明明看得到金鑰就在框裡。
 * 那種訊息比沒有訊息更糟：它會讓人以為貼上失敗，跑去重貼或重新簽發一把新的。
 */
function wireTest(buttonId, stateId, vendor, inputId) {
  $(buttonId).addEventListener('click', async () => {
    const el = $(stateId);
    const typed = $(inputId).value.trim();
    el.className = 'keystate';
    el.textContent = typed ? '測試中…（測的是上面框裡這把）' : '測試中…（測已儲存的那把）';

    const r = await chrome.runtime.sendMessage({ type: 'ma:keys:test', vendor, key: typed || undefined });
    if (r?.ok) {
      el.className = 'keystate ok';
      el.textContent = `可以用 ✓（${r.ms} 毫秒${r.model ? `，${r.model}` : ''}）`
        + (typed ? '　還沒存 —— 記得按頁面最下面的「儲存設定」' : '');
      return;
    }

    el.className = 'keystate bad';
    // 兩邊都沒有金鑰時，講清楚該做什麼，而不是只說「沒有填金鑰」
    el.textContent = r?.noKey
      ? '還沒有金鑰：請在上面的欄位貼上'
      : `不能用：${r?.error || '未知錯誤'}`;
  });
}

wireTest('testGroq', 'groqState', 'groq', 'groq');
wireTest('testNim', 'nimState', 'nim', 'nvidia');
wireTest('testNim2', 'nim2State', 'nim2', 'nvidia2');
wireTest('testTavily', 'tavilyState', 'tavily', 'tavily');

/**
 * 儲存**這一頁的全部內容**：金鑰、名字、背景筆記、摘要頻率。
 *
 * 原本金鑰與其他設定各有一顆儲存按鈕。金鑰那塊在頁面最上方，所以「儲存金鑰」
 * 是使用者最先遇到的按鈕 —— 填完名字與摘要間隔之後按到它，那兩項就不會被存，
 * 而畫面上還是會出現一個綠色的「已儲存 ✓」。使用者只會看到「我明明填了、
 * 它也說存好了，但下次打開是空的」，沒有任何線索指向真正的原因。
 *
 * 一頁兩顆儲存鍵本身就是那個錯誤的來源，所以合併成一顆，
 * 而且確認訊息會**逐項列出到底存了什麼**。
 */
$('save').addEventListener('click', async () => {
  const saved = [];

  // ── 一般設定 ──────────────────────────────────────────────
  const patch = {};
  for (const f of FIELDS) patch[f] = $(f).value.trim();
  // 夾在合理範圍內：段數太小會為兩句話跑一次，秒數太小會很快吃掉當天的額度。
  // 空白或亂填時回到預設值，而不是存進一個會讓摘要再也不觸發的數字。
  patch.summaryEverySegments = Math.min(50, Math.max(2, Number($('summaryEverySegments').value) || 8));
  patch.summaryEveryMs = Math.min(1800, Math.max(15, Number($('summaryEverySeconds').value) || 300)) * 1000;

  const next = await chrome.runtime.sendMessage({ type: 'ma:settings:set', patch });
  if (!next) {
    // sendMessage 沒人接時回 undefined。當成成功就會變成一種安靜的失敗 ——
    // 畫面說存好了，實際上什麼都沒發生。最常見的原因是擴充功能剛被重新載入，
    // 而這一頁還是舊的那份。
    $('saved').textContent = '儲存失敗：背景沒有回應。請關掉這一頁重新打開再試一次。';
    return;
  }
  saved.push(`名字「${patch.myNames || '（空白）'}」`);
  saved.push(`摘要 ${patch.summaryEverySegments} 段 / ${patch.summaryEveryMs / 1000} 秒`);

  // ── 金鑰（留空 = 不動既有的那把）──────────────────────────
  const keyPatch = {};
  for (const f of KEY_FIELDS) {
    const v = $(f).value.trim();
    if (v) keyPatch[f] = v;
  }
  if (Object.keys(keyPatch).length) {
    const r = await chrome.runtime.sendMessage({ type: 'ma:keys:set', patch: keyPatch });
    if (r?.ok) {
      // 存完就清掉，不留在畫面上（這一頁很可能出現在螢幕分享裡）。
      // 清空看起來很像「沒存成功」，所以 loadKeys() 會把
      // 「已儲存 gsk_abcd…6789」寫進每個欄位的 placeholder。
      for (const f of KEY_FIELDS) $(f).value = '';
      saved.push(`${Object.keys(keyPatch).length} 把金鑰`);
    } else {
      $('saved').textContent = '設定已儲存，但金鑰儲存失敗';
      return;
    }
  }

  $('dirty').textContent = '';
  $('saved').textContent = `已儲存 ✓　${saved.join('、')}`;
  setTimeout(() => ($('saved').textContent = ''), 8000);
  await loadKeys();
});

/**
 * 「目前實際存了什麼」。
 *
 * 存在的理由是一個很難查的失敗：畫面說「已儲存 ✓」但其實沒存進去。
 * 使用者唯一能做的判斷是「下次打開有沒有回來」，而那時已經隔了很久，
 * 也分不出是「沒存進去」還是「沒讀回來」。這顆按鈕直接把儲存層的內容
 * 攤開來，讓那個判斷變成當場一秒的事。
 *
 * **金鑰一律用遮罩過的版本**（背景回傳的就是遮罩後的），
 * 使用者才能安心把這一段截圖給別人看。
 */
$('dumpState').addEventListener('click', async () => {
  const el = $('dumpOut');
  el.textContent = '讀取中…';
  const [s, k] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'ma:settings:get' }),
    chrome.runtime.sendMessage({ type: 'ma:keys:get' }),
  ]);
  if (!s || !k) {
    el.textContent = '背景沒有回應。最常見的原因是擴充功能剛重新載入，'
      + '而這一頁還是舊的那份 —— 關掉這一頁重新打開即可。';
    return;
  }

  const yesNo = (v) => (v ? '有' : '（空白）');
  const lines = [
    '── 設定 ──',
    `我的名字／稱呼：${s.myNames || '（空白 —— 自動回答幾乎不會觸發）'}`,
    `背景筆記：${yesNo(s.notes)}${s.notes ? `（${s.notes.length} 字）` : ''}`,
    `摘要頻率：至少 ${s.summaryEverySegments} 段，且距上次至少 ${Math.round(s.summaryEveryMs / 1000)} 秒`,
    `自架 Jitsi 網域：${s.jitsiDomains || '（未設定）'}`,
    '',
    '── 金鑰（遮罩後，可安心截圖）──',
    `GroqCloud：${k.masked?.groq || '（未設定）'}`,
    `NVIDIA NIM 1：${k.masked?.nvidia || '（未設定）'}`,
    `NVIDIA NIM 2：${k.masked?.nvidia2 || '（未設定）'}`,
    `Tavily：${k.masked?.tavily || '（未設定）'}`,
    '',
    '── 目前會走哪條路 ──',
    `逐字稿：${k.present?.groq ? 'Groq 雲端辨識（快 8 倍）' : '本機 whisper.cpp（沒有 Groq 金鑰）'}`,
    `摘要與回答：${k.present?.groq || k.present?.nvidia || k.present?.nvidia2
      ? '雲端免費方案（約 1 秒）' : 'Claude Code 橋接（10–30 秒）'}`,
    `網路查證：${k.present?.tavily ? '開啟（只在需要外部資料時）' : '關閉（沒有 Tavily 金鑰）'}`,
  ];
  if (k.mismatched?.length) {
    lines.push('', '⚠ 看起來貼錯欄位：'
      + k.mismatched.map((m) => `「${m.label}」應該以 ${m.prefix} 開頭`).join('；'));
  }
  el.textContent = lines.join('\n');
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
