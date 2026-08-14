/** 側邊欄 UI */

const $ = (id) => document.getElementById(id);
const port = chrome.runtime.connect({ name: 'ma-panel' });

let state = { segments: [], partials: [], summary: null, answers: [], status: {}, meeting: null };
let unseenInsights = 0;
let unseenQa = 0;
let activeTab = 'transcript';
let summaryRunning = false;    // 顯示在狀態列，也讓「✦ 產生重點」在進行中停用
// 側邊欄需要知道 sttAuto（自動聽分頁聲音）與 captureScreen（提問預設附畫面）。
// 在 loadSettings() 填入。
let settings = null;

// ── 說話者顏色：同一個名字永遠同一個色 ──────────────────────────
const SPEAKER_HUES = [252, 200, 145, 25, 330, 45, 275, 175];
const hueCache = new Map();
function speakerColor(name) {
  if (!hueCache.has(name)) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 9973;
    hueCache.set(name, SPEAKER_HUES[h % SPEAKER_HUES.length]);
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return `hsl(${hueCache.get(name)} 65% ${dark ? 72 : 34}%)`;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-TW', { hour12: false });

// ── 分頁切換 ────────────────────────────────────────────────────
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${activeTab}`));
    if (activeTab === 'insights') { unseenInsights = 0; renderBadges(); }
    if (activeTab === 'qa') { unseenQa = 0; renderBadges(); }
  });
});

function renderBadges() {
  const bi = $('badgeInsights'); const bq = $('badgeQa');
  bi.textContent = unseenInsights; bi.classList.toggle('hidden', unseenInsights === 0);
  bq.textContent = unseenQa; bq.classList.toggle('hidden', unseenQa === 0);
}

// ── 訊息 ────────────────────────────────────────────────────────
port.onMessage.addListener(({ type, payload }) => {
  switch (type) {
    case 'state':
      state = payload;
      renderAll();
      break;
    case 'status':
      state.status = payload;
      renderStatus();
      break;
    case 'segment': {
      const i = state.segments.findIndex((s) => s.id === payload.id);
      if (i >= 0) state.segments[i] = payload; else state.segments.push(payload);
      state.partials = state.partials.filter((p) => p.id !== payload.id);
      renderTranscript();
      break;
    }
    case 'partial': {
      const i = state.partials.findIndex((p) => p.id === payload.id);
      if (i >= 0) state.partials[i] = payload; else state.partials.push(payload);
      renderPartial();
      break;
    }
    case 'summary':
      state.summary = payload;
      if (activeTab !== 'insights') { unseenInsights++; renderBadges(); }
      renderInsights();
      break;
    case 'summaryStatus':
      // 進行中的狀態同時顯示在狀態列與「✦ 產生重點」按鈕上。
      // 背景**保證**每一次 running:true 都會配一次 running:false（含提早返回的
      // 情況，見 service-worker 的 runSummary），否則按鈕會永遠停在「產生中…」。
      summaryRunning = !!payload.running;
      renderStatus();
      break;
    case 'answer':
      state.answers.push(payload);
      if (activeTab !== 'qa') { unseenQa++; renderBadges(); }
      renderAnswers();
      break;
    case 'answerDelta': {
      const a = state.answers.find((x) => x.id === payload.id);
      if (a) { a.answer += payload.chunk; patchAnswer(a); }
      break;
    }
    case 'answerNote': {       // 進行中的說明，例如「正在讀取會議畫面…」
      const a = state.answers.find((x) => x.id === payload.id);
      if (a) { a.note = payload.note; renderAnswers(); }
      break;
    }
    case 'answerDone': {
      const a = state.answers.find((x) => x.id === payload.id);
      if (a) {
        a.streaming = false; a.error = payload.error;
        a.answer = payload.answer || a.answer;
        a.note = '';           // 答案到了就不必再顯示進度
        renderAnswers();
      }
      break;
    }
    case 'localRun':          // 背景要求在這裡跑一次免費模型
      handleLocalRun(payload);
      break;
    case 'audioNote':         // 聽會議聲音的進度說明（不是錯誤）
      showBanner(payload.message, 20000);
      break;
    case 'error':
      showBanner(payload.message);
      break;
  }
});

function showBanner(message, ms = 12000) {
  const el = $('banner');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => el.classList.add('hidden'), ms);
}

// ── 渲染 ────────────────────────────────────────────────────────
function renderAll() { renderStatus(); renderTranscript(); renderPartial(); renderInsights(); renderAnswers(); }

/**
 * 狀態列的說法以「有沒有在聽聲音」為主，不再以字幕為主。
 * 音訊才是逐字稿的來源，字幕只是拿來補說話者姓名 —— 所以「找不到字幕」
 * 不再是錯誤，只是少了姓名而已，不該讓使用者以為壞掉了。
 */
function renderStatus() {
  const st = state.status || {};
  const dot = $('statusDot');
  // 綠燈的條件是「正在聽聲音」，不是「有字幕」
  dot.className = 'dot' + (st.audioFallback ? ' live' : st.platform ? ' waiting' : '');
  $('meetingTitle').textContent = state.meeting?.title || '尚未偵測到會議';

  const platformName = {
    'google-meet': 'Google Meet',
    'ms-teams': 'Microsoft Teams',
    'jitsi': 'Jitsi Meet',
    'audio-fallback': '音訊備援',
  }[st.platform] || null;

  let msg;
  if (!platformName) {
    msg = '請開啟 Google Meet / Teams / Jitsi 會議分頁';
  } else if (st.audioFallback) {
    msg = `${platformName} · 聆聽中 · ${state.segments.length} 段`;
    // 有字幕的話姓名才抓得到，這點值得講，但不是必要條件
    msg += st.captionsFound ? ' · 字幕提供姓名' : '';
  } else {
    msg = `${platformName} · 點工具列的會議助手圖示開始記錄`;
  }
  if (summaryRunning) msg += ' · 產生摘要中';
  $('statusText').textContent = msg;

  // 已經在聽就把按鈕收起來（它只在「還沒開始」時有意義）。
  // 換一場會議時 audioFallback 會變回 false，按鈕自動回來。
  const listening = !!st.audioFallback;
  $('btnListen').classList.toggle('hidden', listening);
  if (!listening) resetListening();

  // 「我的發言」跟著聆聽一起開關，不是一顆要自己記得按的按鈕。
  // 兩個函式都是冪等的（已經在跑就直接返回），所以每次 renderStatus
  // 都呼叫是安全的。
  if (listening) startMic(); else stopMic({ quiet: true });

  // 產生重點只有在有逐字稿的時候才有意義
  $('btnSummary').disabled = summaryRunning || !state.segments?.length;
  $('btnSummary').textContent = summaryRunning ? '產生中…' : '✦ 產生重點';
}

function highlight(text, q) {
  if (!q) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase(); const needle = q.toLowerCase();
  let i = 0;
  while (true) {
    const at = lower.indexOf(needle, i);
    if (at === -1) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
    frag.appendChild(document.createTextNode(text.slice(i, at)));
    const mk = document.createElement('mark');
    mk.textContent = text.slice(at, at + needle.length);
    frag.appendChild(mk);
    i = at + needle.length;
  }
  return frag;
}

/**
 * 「為什麼每個人都叫『其他人』」的說明。
 *
 * 這是使用者第一次看到逐字稿時最可能問的問題，而**答案完全不在畫面上** ——
 * 語音辨識拿不到姓名（whisper 只有聲音，不做說話者分離），真實姓名只有
 * 平台自己的字幕有。所以要開字幕，而那是在會議裡、不是在這個擴充功能裡。
 *
 * 只在真的用得上的時候出現：正在聽、已經有逐字稿、而且**一個真名都沒有**。
 * 抓到任何一個真名就表示字幕已經在餵姓名了，這時再提醒只是雜訊。
 */
const PLACEHOLDER_SPEAKER = /^其他人/;

const CAPTION_STEPS = {
  'google-meet': '會議畫面右下角「更多選項」→「開啟字幕」（或直接按 c）',
  'ms-teams': '會議工具列「更多」→「語言和語音」→「開啟即時字幕」',
  'jitsi': '會議工具列「更多」→「字幕」',
};

function nameHint() {
  const st = state.status || {};
  if (!st.audioFallback) return null;
  if (st.captionsFound) return null;
  // 有任何一段拿到真名就不用提醒了
  if (state.segments.some((s) => s.source === 'audio' && !PLACEHOLDER_SPEAKER.test(s.speaker))) return null;

  const p = document.createElement('p');
  p.className = 'empty';
  const steps = CAPTION_STEPS[st.platform];
  p.textContent = '說話者顯示「其他人」是因為語音辨識聽不出是誰 —— 真實姓名只有會議自己的字幕有。'
    + (steps ? `在會議裡開啟字幕就會自動換成真名：${steps}。` : '在會議裡開啟即時字幕就會自動換成真名。')
    + '（你自己的發言一律標成「我」，不需要字幕。）';
  return p;
}

function renderTranscript() {
  const box = $('transcript');
  const q = $('search').value.trim();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

  box.textContent = '';
  const rows = q ? state.segments.filter((s) => s.text.includes(q) || s.speaker.includes(q)) : state.segments;

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    // 不要再叫使用者去開字幕 —— 逐字稿來自語音辨識，字幕只是拿來補姓名。
    p.textContent = q
      ? '沒有符合的段落。'
      : '等待發言…開始說話後幾秒會出現逐字稿。想讓說話者顯示真名的話，要在會議裡開啟字幕。';
    box.appendChild(p);
  } else {
    const hint = nameHint();
    if (hint) box.appendChild(hint);
  }

  let lastSpeaker = null;
  for (const s of rows) {
    const div = document.createElement('div');
    div.className = 'seg' + (s.source === 'me' ? ' me' : '');
    if (s.speaker !== lastSpeaker) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = s.speaker;
      who.style.color = speakerColor(s.speaker);
      const t = document.createElement('span');
      t.className = 'time';
      t.textContent = fmtTime(s.ts);
      div.append(who, t, document.createElement('br'));
      lastSpeaker = s.speaker;
    }
    const what = document.createElement('span');
    what.className = 'what';
    what.appendChild(highlight(s.text, q));
    div.appendChild(what);
    box.appendChild(div);
  }

  if ($('autoscroll').checked && (atBottom || !q)) box.scrollTop = box.scrollHeight;
  renderStatus();
}

function renderPartial() {
  const el = $('partial');
  const items = state.partials || [];
  if (!items.length) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = '';
  for (const p of items) {
    const line = document.createElement('div');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${p.speaker}：`;
    who.style.color = speakerColor(p.speaker);
    line.append(who, document.createTextNode(p.text));
    el.appendChild(line);
  }
}

function listCard(title, items, render) {
  if (!items?.length) return null;
  const card = document.createElement('div');
  card.className = 'card';
  const h = document.createElement('h3');
  h.textContent = title;
  card.appendChild(h);
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    render ? render(li, it) : (li.textContent = it);
    ul.appendChild(li);
  }
  card.appendChild(ul);
  return card;
}

function renderInsights() {
  const box = $('insights');
  box.textContent = '';
  const s = state.summary;
  if (!s) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '會議開始後，這裡會每隔一段時間自動更新重點、決議與待辦。也可以按上方「↻ 摘要」立即產生。';
    box.appendChild(p);
    return;
  }

  const upd = document.createElement('p');
  upd.className = 'updated';
  upd.textContent = `更新於 ${fmtTime(s.updatedAt)}`;
  box.appendChild(upd);

  if (s.topics?.length) {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h3'); h.textContent = '正在討論';
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const t of s.topics) {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = t; chips.appendChild(c);
    }
    card.append(h, chips);
    box.appendChild(card);
  }

  for (const card of [
    listCard('重點摘要', s.summary),
    listCard('決議', s.decisions),
    listCard('待辦事項', s.actions, (li, a) => {
      li.className = 'action';
      const owner = document.createElement('span');
      owner.className = 'owner';
      owner.textContent = a.owner || '未指定';
      li.append(owner, document.createTextNode(a.task));
    }),
    listCard('未解問題', s.open_questions),
  ]) if (card) box.appendChild(card);
}

function answerBody(text) {
  const frag = document.createDocumentFragment();
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const span = document.createElement('span');
    if (i === 0) span.className = 'lead';
    span.textContent = line;
    frag.append(span, document.createTextNode('\n'));
  });
  return frag;
}

function renderAnswers() {
  const box = $('answers');
  box.textContent = '';
  if (!state.answers.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '當有人點名問你、或你手動提問時，這裡會出現可直接照唸的回答建議。';
    box.appendChild(p);
    return;
  }
  for (const a of [...state.answers].reverse()) {
    const card = document.createElement('div');
    card.className = 'card qa';
    card.dataset.id = a.id;

    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = `${a.manual ? '我問' : `${a.asker} 問`} · ${fmtTime(a.ts)}　${a.question}`;

    const body = document.createElement('div');
    body.className = 'a';
    body.appendChild(answerBody(a.answer || ''));
    if (a.streaming) { const s = document.createElement('span'); s.className = 'spinner'; body.appendChild(s); }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const err = document.createElement('span');
    err.className = 'err';
    // 進行中的說明（例如「正在讀取會議畫面…」）與錯誤共用一個位置，
    // 錯誤優先 —— 出錯時使用者要看的是原因，不是進度。
    err.textContent = a.error || a.note || '';
    const copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = '複製';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(a.answer || '');
      copy.textContent = '已複製';
      setTimeout(() => (copy.textContent = '複製'), 1500);
    });
    meta.append(err, copy);

    card.append(q, body, meta);
    box.appendChild(card);
  }
}

/** 串流時只換內文，避免整份重繪造成閃動與捲動跳動 */
function patchAnswer(a) {
  const card = document.querySelector(`.qa[data-id="${a.id}"] .a`);
  if (!card) { renderAnswers(); return; }
  card.textContent = '';
  card.appendChild(answerBody(a.answer));
  const s = document.createElement('span'); s.className = 'spinner'; card.appendChild(s);
}

// ── 動作 ────────────────────────────────────────────────────────
$('search').addEventListener('input', renderTranscript);

/**
 * 「開始聽聲音」之後要告訴使用者什麼。
 *
 * 三個引擎的延遲差很多，含糊帶過只會讓人以為壞了 —— 尤其是延遲：
 * 本機辨識要等一整段講完才出字，不說清楚會被當成沒在動。
 *
 * **每一個引擎都必須有自己的分支。** 這裡踩過一次：預設引擎換成 groq 之後
 * 忘了加分支，於是走雲端的人（也就是所有正常設定好的人）看到的是最後那句
 * 「瀏覽器內建備援引擎…執行 install-whisper.ps1 可換成原生引擎」——
 * 描述的是一條他根本沒在走的路，而且叫他去裝一個他不需要的東西。
 *
 * 雲端那句還多負擔一件事：**音訊會離開這台電腦**。這是雲端相對本機唯一的
 * 取捨，使用者有權在音訊送出去之前就知道，不能只寫在 README 裡。
 */
function sttStartedMessage(res) {
  const note = res.note ? `${res.note} ` : '';
  if (res.engine === 'groq') {
    return `${note}已開始聽分頁聲音（Groq 雲端辨識，免費方案）。約 3–5 秒產出一段，`
      + `說話者標成「其他人（雲端辨識）」。⚠️ 會議音訊會送到 Groq 的伺服器辨識 ——`
      + `不希望的話，把設定頁的 Groq 金鑰清空就會改用完全離線的本機引擎。`;
  }
  if (res.engine === 'whisper-native') {
    return `${note}已開始聽分頁聲音（本機原生辨識，免費且完全離線）。每 12 秒產出一段，其他人的發言會延遲約 18 秒，說話者標成「其他人（本機辨識）」。`;
  }
  return `${note}已開始聽分頁聲音（瀏覽器內建備援引擎，免費）。首次載入約 30 秒，發言會延遲約 30 秒，中文準確度較差 —— 執行 tools\\install-whisper.ps1 可換成原生引擎。`;
}

$('btnClear').addEventListener('click', () => {
  if (confirm('確定要清除本場逐字稿、摘要與問答紀錄嗎？')) chrome.runtime.sendMessage({ type: 'ma:clear' });
});

$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('btnExport').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'ma:export' });
  if (!res?.markdown) return;
  await navigator.clipboard.writeText(res.markdown);
  // 另存一份 .md：用 <a download> 而非 downloads API，省一個權限
  //
  // charset=utf-8 與 BOM 兩個都要。少了 charset，編輯器會用系統 ANSI（正體中文
  // 機器是 Big5）解讀 UTF-8 位元組，整份中文變成亂碼；BOM 則是讓 Windows 的
  // 記事本／Excel 這類不看 MIME 的程式也能認出是 UTF-8。實測沒加時匯出的
  // 逐字稿全部是「æåä¸éµ」這種亂碼。
  const blob = new Blob(['﻿', res.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `會議逐字稿-${stamp}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showBanner('Markdown 已複製到剪貼簿，並下載一份備份。');
});

function ask() {
  const q = $('askInput').value.trim();
  if (!q) return;
  $('askInput').value = '';
  chrome.runtime.sendMessage({ type: 'ma:ask', question: q, withScreen: $('askScreen').checked });
  if (activeTab !== 'qa') document.querySelector('.tabs button[data-tab="qa"]').click();
}
$('btnAsk').addEventListener('click', ask);
$('askInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
});

// ── Chrome 內建模型（Gemini Nano）：免費、離線、不需要金鑰 ────────
// 跑在側邊欄而不是背景，因為首次使用要下載模型，而下載必須由使用者手勢觸發。
let localSession = null;
let localReady = false;

/**
 * 問這台機器跑不跑得動內建模型。
 *
 * **一定要帶 outputLanguage。** 只要呼叫 LanguageModel 的 API 而沒有指定
 * 輸出語言，Chrome 就會在擴充功能的錯誤頁留下一筆
 * 「No output language was specified in a LanguageModel API request」，
 * 而且每次呼叫累積一筆 —— 使用者會看到錯誤頁上一直長出東西，
 * 卻完全看不出跟什麼有關。
 *
 * 帶 'en' 而不是 'zh'：Chrome 的支援清單只有 [de, en, es, fr, ja]，
 * 指定 zh 直接失敗。這顆模型本來就沒有中文輸出能力，這也是它預設不被
 * 使用的原因（見 settings.js 的 resolveProvider）。
 */
async function localAvailability() {
  if (typeof self.LanguageModel === 'undefined') return 'unsupported';
  try { return await self.LanguageModel.availability({ outputLanguage: 'en' }); }
  catch { return 'unsupported'; }
}

/** 建立（必要時下載）本機模型。必須從使用者點擊裡呼叫。 */
async function ensureLocalModel(onProgress) {
  if (localSession) return localSession;
  const avail = await localAvailability();
  if (avail === 'unsupported' || avail === 'unavailable') {
    // 不要在這裡建議「改用 Claude API」—— 那條路已經整個移除，而且是按量計費的。
    // 這台機器跑不動內建模型時，正確的下一步是把雲端金鑰填好（免費且快得多）。
    throw new Error('這個瀏覽器／裝置不支援 Chrome 內建模型。到設定頁貼上 Groq 的 API 金鑰就能用雲端免費方案，比內建模型更快也支援中文。');
  }
  // **必須指定 outputLanguage，而且中文不在支援清單裡。**
  // Chrome 目前只接受 [en, es, ja]（實測錯誤訊息列出 de/en/es/fr/ja），
  // 沒指定會在擴充功能的錯誤頁留下警告，指定 'zh' 則直接失敗。
  // 這台模型本來就沒有中文輸出能力 —— 見 handleLocalRun 的說明。
  localSession = await self.LanguageModel.create({
    outputLanguage: 'en',
    monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)),
  });
  localReady = true;
  return localSession;
}

/** 背景要求跑一次本機推論 */
async function handleLocalRun({ id, system, user }) {
  try {
    if (!localSession) {
      // 沒有使用者手勢時不能觸發下載，只有已就緒才跑
      const avail = await localAvailability();
      if (avail !== 'available') {
        throw new Error('免費模型尚未啟用。請先按上方「啟用免費模型」完成一次性下載。');
      }
      localSession = await self.LanguageModel.create({ outputLanguage: 'en' });
      localReady = true;
    }
    // 每次用獨立分支，避免對話歷史累積把小小的 context 吃光。
    // 系統提示直接併進輸入，不用 initialPrompts —— 省一次 session 建立。
    const session = await localSession.clone();
    const prompt = system ? `${system}\n\n---\n\n${user}` : user;
    let full = '';
    for await (const chunk of session.promptStreaming(prompt)) {
      // Chrome 的串流會給「累積字串」或「增量」，兩種都要處理
      const delta = chunk.startsWith(full) ? chunk.slice(full.length) : chunk;
      full += delta;
      chrome.runtime.sendMessage({ type: 'ma:local:delta', id, chunk: delta });
    }
    session.destroy?.();
    chrome.runtime.sendMessage({ type: 'ma:local:done', id, text: full });
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'ma:local:error', id, error: String(err.message || err) });
  }
}

$('btnLocal').addEventListener('click', async () => {
  const btn = $('btnLocal');
  const avail = await localAvailability();
  if (avail === 'unsupported' || avail === 'unavailable') {
    await chrome.runtime.sendMessage({ type: 'ma:settings:set', patch: { localModelUnsupported: true } });
    showBanner('這台機器跑不動 Chrome 內建模型（Gemini Nano 需要 4GB 以上顯示記憶體、22GB 以上可用磁碟）。已改用 Claude Code 走你的 Pro 訂閱額度，同樣免費。', 30000);
    await refreshProviderBadge();
    return;
  }
  if (localReady) { showBanner('免費模型已就緒。'); return; }
  btn.disabled = true;
  btn.textContent = '下載中…';
  try {
    await ensureLocalModel((loaded) => { btn.textContent = `下載中 ${Math.round(loaded * 100)}%`; });
    btn.textContent = '✓ 免費模型已就緒';
    btn.classList.add('on');
    showBanner('免費模型已就緒。摘要與問答現在完全在本機執行，不需要金鑰也不會產生費用。');
  } catch (err) {
    btn.textContent = '⚡ 啟用免費模型';
    showBanner(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── 顯示目前用哪個後端 ──────────────────────────────────────────
// 本機模型能不能跑，只有側邊欄問得到（背景環境沒有 LanguageModel），
// 所以偵測完要寫回設定，後端解析時才知道該不該改走 Claude Code。
async function refreshProviderBadge() {
  let info = await chrome.runtime.sendMessage({ type: 'ma:provider' });
  if (!info) return;

  // **只有真的可能用到內建模型時才去問它。**
  //
  // 每一次 LanguageModel 呼叫都會在擴充功能的錯誤頁留下一筆警告，而預設
  // 情況下這顆模型根本不會被使用（不支援中文輸出，見 resolveProvider）——
  // 為了一個用不到的後端，每開一次側邊欄就在錯誤頁上多一筆，
  // 使用者只會看到錯誤一直長出來，卻看不出跟什麼有關。
  //
  // needsPanel 已經表示「摘要或回答其中之一解析成 chrome-ai」，
  // 那是唯一會用到它的情況；不成立時 localUnsupported 也影響不了任何判斷。
  let unsupported = !!info.localUnsupported;
  if (info.needsPanel) {
    const avail = await localAvailability();
    localReady = avail === 'available';
    unsupported = avail === 'unsupported' || avail === 'unavailable';
    if (unsupported !== !!info.localUnsupported) {
      await chrome.runtime.sendMessage({ type: 'ma:settings:set', patch: { localModelUnsupported: unsupported } });
      info = await chrome.runtime.sendMessage({ type: 'ma:provider' });
    }
  }

  // 走雲端時標示出來。使用者最常問的兩件事是「現在是誰在回答」與
  // 「為什麼今天特別慢」，徽章與它的 tooltip 就是為了直接答出這兩題。
  $('providerBadge').textContent = info.provider === 'cloud' ? '雲端 · 免費' : (info.free ? '免費模式' : 'Claude');
  const bits = [`摘要：${info.label}`, `即時回答：${info.answerLabel}`];
  if (info.cloudLastUsed?.model) {
    bits.push(`上次用：${info.cloudLastUsed.model}（${info.cloudLastUsed.ms} 毫秒）`);
  }
  if (info.cloudCooldown?.length) {
    // 冷卻中代表某個模型撞到免費額度。不講的話使用者只會覺得變慢了。
    bits.push(`冷卻中：${info.cloudCooldown.map((c) => `${c.model} 還有 ${c.secondsLeft} 秒`).join('、')}`);
  }
  $('providerBadge').title = bits.join('｜');
  $('providerBadge').classList.toggle('freeMode', info.free);

  // 跑不動就別留一顆按了只會噴錯的按鈕
  $('btnLocal').classList.toggle('hidden', !info.needsPanel || unsupported);
  if (localReady) {
    $('btnLocal').textContent = '✓ 免費模型已就緒';
    $('btnLocal').classList.add('on');
  }

  // 完全沒有雲端金鑰時要主動說 —— 這時候每一項功能都在走慢很多的退路，
  // 而畫面上唯一的差別只是「比較慢」，使用者不會聯想到是沒設定金鑰。
  if (!info.cloudConfigured) {
    showBanner('還沒設定雲端金鑰，目前走的是較慢的本機／橋接路線。'
      + '到設定頁貼上 Groq 的 API 金鑰可以讓逐字稿快 8 倍、回答從 10–30 秒變成 1 秒以內（免費，不需信用卡）。', 20000);
  }

  if (info.needsBridge) {
    const res = await chrome.runtime.sendMessage({ type: 'ma:bridge:check' });
    if (!res?.ok) {
      showBanner(unsupported
        ? `這台機器跑不動 Chrome 內建模型（Gemini Nano 需要 4GB 以上顯示記憶體、22GB 以上可用磁碟），已自動改用 Claude Code —— 吃你的 Pro 訂閱額度，不另外計費。還差最後一步：用 PowerShell 執行 bridge\\install.ps1 -ExtensionId ${chrome.runtime.id}`
        // 不要在這裡叫使用者去按「存檔給 Claude Code」—— 那顆按鈕已經移除了，
        // 指向一顆不存在的按鈕比不給建議更糟。改成指向真正有效的下一步。
        : `Claude Code 橋接還沒註冊。請用 PowerShell 執行 bridge\\install.ps1 -ExtensionId ${chrome.runtime.id}。或者到設定頁貼上 Groq 的 API 金鑰，走免費的雲端方案（快很多，也不需要橋接）。`,
        60000);
    }
  }
}
refreshProviderBadge();

// ── 設定：影響側邊欄自己要顯示什麼 ─────────────────────────────
async function loadSettings() {
  settings = await chrome.runtime.sendMessage({ type: 'ma:settings:get' });
  if (!settings) return;
  $('askScreen').checked = !!settings.captureScreen;
}
loadSettings();

/**
 * 「開始聆聽」按鈕 —— 這顆按鈕存在的唯一理由是 **Chrome 要求使用者手勢**。
 *
 * `chrome.tabCapture.getMediaStreamId()` 不只要求「擴充功能被該分頁叫用過」，
 * 它要求呼叫發生在使用者手勢的脈絡裡。計時器（setInterval）觸發的呼叫沒有手勢，
 * **一定**會被拒絕，錯誤訊息是 "Extension has not been invoked for the current page"
 * —— 訊息會讓人以為是權限沒給，於是往「點圖示、重新載入」的方向繞，但那些都沒用。
 *
 * 曾經試過在被拒時用 executeScript 自己補授權，那也沒用：executeScript
 * 不會產生使用者手勢。唯一的解法就是讓使用者按一下。
 */
$('btnListen').addEventListener('click', () => startListening({ manual: true }));

/**
 * 開始聽分頁聲音。**這件事無法自動化，必須由使用者按一下。**
 *
 * `chrome.tabCapture.getMediaStreamId()` 要求呼叫發生在**使用者手勢**的脈絡裡。
 * 計時器觸發的呼叫沒有手勢，一定被拒，而且 Chrome 給的錯誤是
 * "Extension has not been invoked for the current page" —— 這句話會把人帶往
 * 「權限沒給」的方向（點圖示、重新載入擴充功能、重新整理分頁），但那些全都沒用。
 * 也試過在被拒時用 executeScript 自己補授權，同樣沒用：那不會產生手勢。
 *
 * 所以側邊欄有一顆「▶ 開始聆聽」。按下去之後：
 *   - 音訊是逐字稿的唯一來源（字幕只拿來補說話者姓名）
 *   - 不會因為字幕出現就停掉
 *   - 換一場會議時會自動重來（見 renderStatus 裡的 audioFallback 判斷）
 *
 * 兩邊同時收不會產生重複：字幕走 source='captions'、音訊走 source='audio'，
 * 背景只把音訊那條寫進逐字稿。
 */
let sttStarting = false;

async function startListening({ manual = false } = {}) {
  const st = state.status || {};
  if (st.audioFallback || sttStarting) return;

  const inMeeting = !!st.platform && st.platform !== 'audio-fallback';
  if (!inMeeting) {
    if (manual) showBanner('還沒偵測到會議。請先開啟 Google Meet / Teams / Jitsi 的會議分頁。', 8000);
    return;
  }

  sttStarting = true;
  let started = false;
  try {
    // **getMediaStreamId 必須在這裡呼叫，不能交給背景。**
    //
    // 使用者手勢**不會跨 sendMessage 傳到 service worker**。之前是按鈕送訊息、
    // 背景去呼叫，結果背景那邊沒有手勢，Chrome 照樣拒絕 —— 症狀是「按了沒反應」，
    // 而錯誤訊息還是那句會誤導人的 "Extension has not been invoked"。
    // 側邊欄是點擊實際發生的地方，只有在這裡呼叫才帶得到手勢。
    //
    // 先問背景哪個分頁是會議分頁（content script 回報的 sender.tab.id 才可靠，
    // 側邊欄自己用 tabs.query({active:true}) 會拿到錯的）。
    const info = await chrome.runtime.sendMessage({ type: 'ma:meetingTab' });
    if (!info?.tabId) {
      showBanner('找不到會議分頁。請確認 Meet / Teams / Jitsi 分頁還開著，並重新整理一次。', 12000);
      return;
    }

    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: info.tabId });
    } catch (err) {
      // 側邊欄的 click 實測不一定被 Chrome 當成有效手勢（錯誤訊息裡會出現
      // "Chrome pages cannot be captured"，但目標明明是 Meet 分頁）。
      // 官方文件認可的來源是 chrome.action.onClicked —— 也就是點工具列圖示，
      // 背景已經在那個脈絡裡自動啟動聆聽。所以這裡把使用者導向那條路。
      const raw = String(err?.message || err);
      showBanner(/invoked|gesture|activeTab|cannot be captured/i.test(raw)
        ? '請改成：切到會議分頁，然後點一下瀏覽器工具列上的會議助手圖示 —— 那個動作會直接開始聆聽。（Chrome 只接受從工具列圖示發起的擷取）'
        : `無法擷取分頁音訊：${raw}`, 20000);
      return;
    }

    const res = await chrome.runtime.sendMessage({ type: 'ma:audio:start', streamId });
    if (res?.ok) {
      started = true;
      showBanner(`已開始聆聽，逐字稿約 15 秒後開始出現。${sttStartedMessage(res)}`, 15000);
      return;
    }
    showBanner(res?.error || '無法聽取分頁聲音。', 15000);
  } finally {
    // 成功時保持擋住：狀態要等下一次 status 廣播才會變成 audioFallback=true，
    // 在那之前重複呼叫會開出第二個擷取。
    if (!started) sttStarting = false;
  }
}

/** 換會議時要能重新開始聆聽 */
function resetListening() { sttStarting = false; }

/**
 * 手動產生重點。
 *
 * 自動摘要有兩個門檻（累積夠多段 **且** 距上次夠久），所以「我現在就想要
 * 一份」沒有別的辦法 —— 例如剛講完一個段落、或要在會議中途對齊進度。
 *
 * 背景的 `ma:summarizeNow` 走的是 `runSummary(true)`，**繞過那兩個門檻**；
 * 成功之後 `store.markSummarized` 會把累積段數歸零、時間基準重設，
 * 所以自動摘要的節奏是從這一刻重新開始算，不會出現「才剛手動產生完，
 * 一分鐘後又自動跑一次」。沒按的話一切照舊。
 */
$('btnSummary').addEventListener('click', async () => {
  if (!state.segments?.length) { showBanner('還沒有逐字稿可以整理。', 6000); return; }
  // 立刻反映在畫面上，不要等背景廣播回來 —— 那中間的空窗會讓人以為沒按到
  summaryRunning = true;
  renderStatus();
  const res = await chrome.runtime.sendMessage({ type: 'ma:summarizeNow' });
  if (!res) {
    summaryRunning = false;
    renderStatus();
    showBanner('背景沒有回應，重點沒有產生。請關掉側邊欄重開再試一次。', 12000);
    return;
  }
  showBanner('正在產生重點，完成後會出現在「重點」分頁。自動摘要的計時與段數已經重新開始算。', 10000);
  if (activeTab !== 'insights') document.querySelector('.tabs button[data-tab="insights"]')?.click();
});

// ── 我自己的發言（跟著聆聽自動開關）─────────────────────────────
/**
 * 分頁擷取抓的是「分頁**播放出來**」的聲音 —— 也就是其他人的發言。
 * **你自己講的話不會經過那裡**（Meet 不會把你的麥克風回放給你，否則會有回音），
 * 所以逐字稿裡永遠不會有你自己。要記錄自己就得另外開麥克風。
 *
 * 用瀏覽器內建的 SpeechRecognition：免金鑰、免安裝，而且它本來就是為
 * 「一支麥克風、一個人講話」設計的，在這個用途上比 whisper 更合適也更即時。
 *
 * **這件事不再是一顆按鈕。** 它跟著「開始聆聽」一起開、一起關（見 renderStatus）——
 * 少了這條，逐字稿裡就永遠沒有你自己說過的話，而那正是回答建議最需要的
 * 上下文之一（「我剛剛才答應過什麼」）。要使用者自己記得按，等於讓一個
 * 預設就該成立的東西變成偶爾才成立。
 */
let recog = null;
// 權限被拒之後不要每次 renderStatus 都再試一次 —— 那會變成錯誤訊息洗版，
// 而且每次失敗都可能再彈一次權限詢問。
let micBlocked = false;

function stopMic({ quiet = false } = {}) {
  if (!recog) return;
  const r = recog;
  recog = null;              // 先清掉，onend 才不會自動續接
  try { r.stop(); } catch {}
  if (!quiet) showBanner('已停止記錄你自己的發言。', 6000);
}

function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showBanner('這個瀏覽器不支援內建語音辨識，無法記錄你自己的發言。', 10000); return; }
  if (recog || micBlocked) return;

  recog = new SR();
  recog.lang = 'zh-TW';
  recog.continuous = true;
  recog.interimResults = true;
  const micSession = `mic-${Date.now().toString(36)}`;

  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript.trim();
      if (!text) continue;
      chrome.runtime.sendMessage({
        type: 'ma:segment',
        payload: {
          id: `${micSession}-${i}`, speaker: '我', text,
          final: r.isFinal, ts: Date.now(), startedAt: Date.now(),
          // source 'audio' 才會進逐字稿（'captions' 只用來補姓名）
          source: 'audio',
          platform: state.status?.platform || 'mic',
          sessionId: state.meeting?.sessionId || micSession,
          title: state.meeting?.title || '會議',
        },
      });
    }
  };

  recog.onerror = (e) => {
    // 權限被拒是**永久性**的，不像 no-speech 那種暫時狀況。
    // 不記下來的話，onend 會自動續接、renderStatus 也會再叫一次，
    // 於是變成無限重試 —— 錯誤橫幅洗版，而且可能一直重彈權限詢問。
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      micBlocked = true;
      stopMic({ quiet: true });
      showBanner('沒有麥克風權限，所以「你自己說的話」不會進逐字稿（其他人的照常記錄）。'
        + '要開啟的話：點網址列左側的圖示 → 允許麥克風，然後重開側邊欄。', 20000);
    } else if (e.error !== 'no-speech') {
      showBanner(`麥克風辨識錯誤：${e.error}`, 10000);
    }
  };
  // 長時間會自動斷線，自動續接（但被拒之後不要再接）
  recog.onend = () => { if (recog && !micBlocked) { try { recog.start(); } catch {} } };

  try {
    recog.start();
  } catch (err) {
    recog = null;
    micBlocked = true;
    showBanner(`無法啟動麥克風，「你自己說的話」不會進逐字稿：${String(err?.message || err)}`, 15000);
    return;
  }
  showBanner('也會記錄你自己說的話（其他人的發言由分頁擷取負責）。', 8000);
}
