/** 側邊欄 UI */

const $ = (id) => document.getElementById(id);
const port = chrome.runtime.connect({ name: 'ma-panel' });

let state = { segments: [], partials: [], summary: null, answers: [], status: {}, meeting: null };
let unseenInsights = 0;
let unseenQa = 0;
let activeTab = 'transcript';
// 側邊欄需要知道 micAuto（自動開麥克風）、captureScreen（提問預設附畫面）、
// 以及有沒有 Deepgram 金鑰（沒有就把音訊備援藏起來）。在 loadSettings() 填入。
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
      $('btnSummary').classList.toggle('on', payload.running);
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

function renderStatus() {
  const st = state.status || {};
  const dot = $('statusDot');
  dot.className = 'dot' + (st.captionsFound ? ' live' : st.platform ? ' waiting' : '');
  $('meetingTitle').textContent = state.meeting?.title || '尚未偵測到會議';

  const platformName = {
    'google-meet': 'Google Meet',
    'ms-teams': 'Microsoft Teams',
    'jitsi': 'Jitsi Meet',
    'audio-fallback': '音訊備援',
  }[st.platform] || null;
  let msg;
  if (!platformName) msg = '請開啟 Google Meet 或 Teams 會議分頁';
  else if (st.captionsFound) msg = `${platformName} · 字幕已連線 · ${state.segments.length} 段`;
  else msg = `${platformName} · 找不到字幕，請在會議中開啟字幕（CC）`;
  if (!st.captionsFound && !st.audioFallback && settings?.sttAuto) {
    msg += '；若這個會議沒有字幕，稍後會自動改用本機辨識';
  }
  if (st.audioFallback) msg += ' · 聽分頁聲音中';
  $('statusText').textContent = msg;
  $('btnAudio').classList.toggle('on', !!st.audioFallback);
  syncAutoMic();
  syncAutoStt();
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

function renderTranscript() {
  const box = $('transcript');
  const q = $('search').value.trim();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

  box.textContent = '';
  const rows = q ? state.segments.filter((s) => s.text.includes(q) || s.speaker.includes(q)) : state.segments;

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = q ? '沒有符合的段落。' : '等待字幕…請確認會議中已開啟字幕（Meet：CC 按鈕；Teams：更多 → 語言和語音 → 開啟即時字幕）。';
    box.appendChild(p);
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

$('btnSummary').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ma:summarizeNow' }));

$('btnAudio').addEventListener('click', async () => {
  if (state.status?.audioFallback) {
    await chrome.runtime.sendMessage({ type: 'ma:audio:stop' });
    return;
  }
  // tabCapture 需要指定要擷取的分頁，側邊欄本身不是那個分頁
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showBanner('找不到作用中的分頁。'); return; }
  sttAutoBlocked = false;   // 手動按過就重新允許自動啟動
  const res = await chrome.runtime.sendMessage({ type: 'ma:audio:start', tabId: tab.id });
  if (res?.ok) showBanner(sttStartedMessage(res), 25000);
});

/**
 * 「開始聽聲音」之後要告訴使用者什麼。
 *
 * 三個引擎的延遲、費用、說話者標籤都不一樣，含糊帶過只會讓人以為壞了 ——
 * 尤其是延遲：本機辨識要等一整段講完才出字，不說清楚會被當成沒在動。
 */
function sttStartedMessage(res) {
  const note = res.note ? `${res.note} ` : '';
  if (res.engine === 'deepgram') {
    return `${note}已開始聽分頁聲音（雲端 Deepgram，按量計費）。說話者只能標成「講者 1／2」。`;
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
  const url = URL.createObjectURL(new Blob([res.markdown], { type: 'text/markdown' }));
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

async function localAvailability() {
  if (typeof self.LanguageModel === 'undefined') return 'unsupported';
  try { return await self.LanguageModel.availability(); } catch { return 'unsupported'; }
}

/** 建立（必要時下載）本機模型。必須從使用者點擊裡呼叫。 */
async function ensureLocalModel(onProgress) {
  if (localSession) return localSession;
  const avail = await localAvailability();
  if (avail === 'unsupported' || avail === 'unavailable') {
    throw new Error('這個瀏覽器／裝置不支援 Chrome 內建模型。請改用 Claude API 或會後交給 Claude Code 摘要。');
  }
  localSession = await self.LanguageModel.create({
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
      localSession = await self.LanguageModel.create();
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

// ── 存檔給 Claude Code（畫面 + 逐字稿，用 Pro 訂閱的免費路線） ────
$('btnSnapshot').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'ma:snapshot' });
  if (!res?.ok) { showBanner(`存檔失敗：${res?.error || '未知錯誤'}`); return; }
  showBanner(res.warning
    ? res.warning
    : `已存到下載資料夾的「${res.dir}」：${res.saved.join('、')}。到 Claude Code 說「看一下最新的會議畫面和逐字稿」就能用 Pro 額度分析。`);
});

// ── 顯示目前用哪個後端 ──────────────────────────────────────────
// 本機模型能不能跑，只有側邊欄問得到（背景環境沒有 LanguageModel），
// 所以偵測完要寫回設定，後端解析時才知道該不該改走 Claude Code。
async function refreshProviderBadge() {
  let info = await chrome.runtime.sendMessage({ type: 'ma:provider' });
  if (!info) return;

  const avail = await localAvailability();
  localReady = avail === 'available';
  const unsupported = avail === 'unsupported' || avail === 'unavailable';
  if (unsupported !== !!info.localUnsupported) {
    await chrome.runtime.sendMessage({ type: 'ma:settings:set', patch: { localModelUnsupported: unsupported } });
    info = await chrome.runtime.sendMessage({ type: 'ma:provider' });
  }

  $('providerBadge').textContent = info.free ? '免費模式' : 'Claude';
  $('providerBadge').title = `摘要：${info.label}｜即時回答：${info.answerLabel}`;
  $('providerBadge').classList.toggle('freeMode', info.free);

  // 跑不動就別留一顆按了只會噴錯的按鈕
  $('btnLocal').classList.toggle('hidden', !info.needsPanel || unsupported);
  if (localReady) {
    $('btnLocal').textContent = '✓ 免費模型已就緒';
    $('btnLocal').classList.add('on');
  }

  if (info.needsBridge) {
    const res = await chrome.runtime.sendMessage({ type: 'ma:bridge:check' });
    if (!res?.ok) {
      showBanner(unsupported
        ? `這台機器跑不動 Chrome 內建模型（Gemini Nano 需要 4GB 以上顯示記憶體、22GB 以上可用磁碟），已自動改用 Claude Code —— 吃你的 Pro 訂閱額度，不另外計費。還差最後一步：用 PowerShell 執行 bridge\\install.ps1 -ExtensionId ${chrome.runtime.id}`
        : `Claude Code 橋接還沒註冊。請用 PowerShell 執行 bridge\\install.ps1 -ExtensionId ${chrome.runtime.id}。在那之前可以按「📸 存檔給 Claude Code」手動走 Pro 額度。`,
        60000);
    }
  }
}
refreshProviderBadge();

// ── 設定：影響側邊欄自己要顯示什麼、要不要自動開麥克風 ──────────
async function loadSettings() {
  settings = await chrome.runtime.sendMessage({ type: 'ma:settings:get' });
  if (!settings) return;
  $('askScreen').checked = !!settings.captureScreen;
  // 本機引擎不需要任何金鑰，所以這顆按鈕一律可用；只有標題會反映用哪個引擎
  $('btnAudio').title = {
    deepgram: '聽分頁聲音轉逐字稿（雲端 Deepgram，按量計費）',
    whisper: '聽分頁聲音轉逐字稿（瀏覽器內建備援，免費但較慢、中文較差）',
  }[settings.sttEngine] || '聽分頁聲音轉逐字稿（本機原生辨識，免費且完全離線，延遲約 18 秒）';
  syncAutoMic();
  syncAutoStt();
}
loadSettings();

// 狀態訊息只在內容有變化時才會送過來（內容腳本會去重），所以等待期結束
// 這件事不能只靠狀態更新觸發 —— 自己定期複查。
setInterval(() => { syncAutoMic(); syncAutoStt(); }, 5000);

// ── 麥克風：用瀏覽器內建語音辨識抓「我自己」說的話 ──────────────
// 免金鑰，但只聽得到麥克風，抓不到其他參與者（他們的聲音走字幕）。
let recog = null;
let micAutoBlocked = false;    // 自動啟動被權限擋過就不再重試，否則每次狀態更新都跳橫幅

function stopMic() {
  if (!recog) return;
  const r = recog;
  recog = null;                // 先清掉，onend 才不會自動續接
  r.stop();
  $('btnMic').classList.remove('on');
}

function startMic({ auto = false } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { if (!auto) showBanner('這個瀏覽器不支援內建語音辨識。'); return; }
  if (recog) return;

  recog = new SR();
  recog.lang = 'zh-TW';
  recog.continuous = true;
  recog.interimResults = true;
  const sessionId = `mic-${Date.now().toString(36)}`;

  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript.trim();
      if (!text) continue;
      chrome.runtime.sendMessage({
        type: 'ma:segment',
        payload: {
          id: `${sessionId}-${i}`, speaker: '我（麥克風）', text,
          final: r.isFinal, ts: Date.now(), startedAt: Date.now(),
          source: 'me', platform: state.status?.platform || 'mic',
          sessionId: state.meeting?.sessionId || sessionId, title: state.meeting?.title || '麥克風',
        },
      });
    }
  };
  recog.onerror = (e) => {
    if (e.error === 'not-allowed') {
      // 首次授權需要使用者手勢，自動啟動拿不到 —— 明確告訴他按一次就好，別再自動重試。
      micAutoBlocked = true;
      stopMic();
      showBanner(auto
        ? '要自動記錄你的發言，請先按一次「🎤 我的麥克風」授權麥克風，之後就會自動開啟。'
        : '麥克風權限被拒。請在瀏覽器允許此擴充功能使用麥克風。', 20000);
    } else if (e.error !== 'no-speech') {
      showBanner(`語音辨識錯誤：${e.error}`);
    }
  };
  recog.onend = () => { if (recog) recog.start(); };  // 長時間會自動斷線，自動續接
  recog.start();
  $('btnMic').classList.add('on');
  if (auto) showBanner('抓不到字幕，已自動開啟麥克風記錄你自己的發言。其他人的發言仍需要字幕。');
}

$('btnMic').addEventListener('click', () => {
  if (recog) { stopMic(); micAutoBlocked = true; return; }   // 手動關掉就別再自動開
  micAutoBlocked = false;
  startMic();
});

/**
 * 抓不到字幕時自動開麥克風；字幕一恢復就關掉。
 *
 * 不無條件開啟是刻意的：平台字幕本來就包含你自己的發言，而且帶真實姓名，
 * 兩邊都收會讓同一句話在逐字稿裡出現兩次，摘要也會看到重複內容。
 */
/**
 * 「這個會議真的沒有字幕」的等待期。
 *
 * 不能一偵測到「沒字幕」就啟動備援：你剛進 Meet、還沒按下 CC 的那幾秒也符合
 * 這個條件。那樣會白燒 CPU 跑 Whisper，還會在逐字稿裡留下一批沒有姓名的段落。
 * 等 45 秒 —— 夠你把字幕打開，又不會讓真的沒字幕的會議等太久。
 */
const NO_CAPTION_GRACE_MS = 45000;
let noCaptionsSince = 0;

/** 距離「確定沒有字幕」還要等多久；0 表示等待期已過 */
function noCaptionWaitLeft() {
  const st = state.status || {};
  const inMeeting = !!st.platform && st.platform !== 'audio-fallback';
  if (!inMeeting || st.captionsFound) { noCaptionsSince = 0; return Infinity; }
  if (!noCaptionsSince) noCaptionsSince = Date.now();
  return Math.max(0, NO_CAPTION_GRACE_MS - (Date.now() - noCaptionsSince));
}

function syncAutoMic() {
  if (!settings?.micAuto) return;
  const st = state.status || {};
  if (st.captionsFound && recog) {
    stopMic();
    showBanner('字幕已連線，已關閉麥克風辨識，避免同一句話重複記錄。');
    return;
  }
  if (noCaptionWaitLeft() > 0 || recog || micAutoBlocked) return;
  startMic({ auto: true });
}

/**
 * 平台沒有字幕時自動開始聽分頁聲音（麥克風只聽得到你自己，其他人要靠這個）。
 *
 * 只在**本機引擎**下自動啟動 —— 走雲端會按量計費，自動花錢是不能接受的。
 * 字幕一恢復就停掉，避免同一句話被記錄兩次。
 */
let sttAutoBlocked = false;

async function syncAutoStt() {
  if (!settings?.sttAuto || settings.sttEngine === 'deepgram') return;
  const st = state.status || {};

  if (st.captionsFound && st.audioFallback) {
    await chrome.runtime.sendMessage({ type: 'ma:audio:stop' });
    sttAutoBlocked = false;   // 字幕又消失時要能再自動接手
    showBanner('字幕已連線，已停止聽分頁聲音，避免重複記錄。');
    return;
  }
  if (st.audioFallback || sttAutoBlocked) return;
  if (noCaptionWaitLeft() > 0) return;   // 還在等你按字幕按鈕

  sttAutoBlocked = true;   // 先擋住，避免狀態更新期間重複啟動
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // 不指定 engine，讓背景照設定挑（原生優先、失敗自動退到 WASM）。
  // 上面已經先擋掉 deepgram，所以這裡不會意外啟動要計費的那條。
  const res = await chrome.runtime.sendMessage({ type: 'ma:audio:start', tabId: tab.id });
  if (res?.ok) {
    // **不要**在這裡解除封鎖。狀態要等下一次 status 廣播才會變成 audioFallback=true，
    // 在那之前每 5 秒的複查會再進來一次，於是開出第二個擷取。
    // 解除封鎖只發生在「使用者手動按了按鈕」或「字幕出現後又消失」。
    showBanner(`這個會議沒有字幕，已自動開始聽分頁聲音。${sttStartedMessage(res)}`, 25000);
  } else {
    // 失敗通常是 tabCapture 需要先在會議分頁點過擴充功能圖示。
    // 不解除封鎖，否則每次狀態更新都會再試一次、每次都跳同一個錯誤。
    showBanner(res?.error || '無法聽取分頁聲音。', 25000);
  }
}
