/**
 * 背景協調者：接收字幕、維護逐字稿、排程摘要、偵測提問、產生回答建議。
 */

import * as store from './store.js';
import { getSettings, saveSettings, jitsiPatterns } from './settings.js';
import { complete, stream, budget, describe, bridgeHealthy, BUDGET, LocalModelUnavailable } from './provider.js';
import { bindPanelChannel, handlePanelMessage } from './localmodel.js';
import { sttEnsure, sttStatus, sttShutdown, STT_ENDPOINT } from './whisper-native.js';
import { getKeys, saveKeys, hasCloud, mismatchedKeys, maskKey } from './keys.js';
import { testKey, cooldownState } from './cloud.js';
// 刻意不用 `import { search as tavilySearch }`：測試執行器把模組攤平成全域時
// **會把別名丟掉**，那個名字在測試環境裡就是 undefined —— 而且只有真的走到
// 查證那條路才會炸，平常跑測試看不出來。名字直接取好，就沒有這個問題。
import { needsSearch, searchWeb, formatForPrompt, testTavily } from './tavily.js';

const ports = new Set();

// 會議分頁的 id，由 content script 的 ma:status 訊息填入（見下方）。
// tabCapture 要對著這個分頁要音訊，不能靠側邊欄猜。
let meetingTabId = null;

// 分頁關掉就忘掉它，否則下一場會議會對著已經不存在的分頁要音訊
chrome.tabs?.onRemoved?.addListener((tabId) => {
  if (tabId === meetingTabId) meetingTabId = null;
});

// **不要開 openPanelOnActionClick。**
//
// 那個設定會讓 Chrome 自己開側邊欄，而 `chrome.action.onClicked` **就不會觸發** ——
// 於是我們失去唯一一個 Chrome 官方認可的手勢來源。tabCapture 需要使用者手勢，
// 而側邊欄裡的 click 事件實測不被接受（錯誤訊息是
// "Extension has not been invoked for the current page ... Chrome pages cannot be captured"）。
// 改成自己在 onClicked 裡開側邊欄，順便在那個手勢脈絡裡把音訊擷取啟動起來。
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch { /* 開不了就算了，下面照樣試 */ }

  // 點工具列圖示是 Chrome 認可的「叫用擴充功能」動作，這裡的脈絡帶得到手勢。
  // 在會議分頁上點就直接開始聆聽 —— 使用者不必再找第二顆按鈕。
  if (!tab?.id || !/^https:\/\/(meet\.google\.com|teams\.(microsoft|live)\.com|meet\.jit\.si|.*\.8x8\.vc)/.test(tab.url || '')) return;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    meetingTabId = tab.id;
    await startAudioFallback(streamId);
  } catch (err) {
    // 側邊欄可能還沒開好，訊息廣播不一定收得到 —— 記在 store 裡，開好就看得到
    reportError(new Error(`無法擷取分頁音訊：${String(err?.message || err)}`));
  }
});

// ── 自架 Jitsi：動態註冊內容腳本 ─────────────────────────────────
// Jitsi 可自架，網域無法事先列舉，所以 manifest 只靜態註冊公開站，
// 自架站由使用者在設定頁授權後在這裡註冊。
const JITSI_SCRIPT_ID = 'ma-jitsi-custom';

async function syncJitsiScripts() {
  if (!chrome.scripting?.registerContentScripts) return { ok: false, error: '這個 Chrome 版本不支援動態註冊' };

  const { jitsiDomains } = await getSettings();
  const matches = jitsiPatterns(jitsiDomains);

  // 先移除舊的再註冊，否則改網域時會殘留上一次的比對規則
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [JITSI_SCRIPT_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [JITSI_SCRIPT_ID] });
  } catch { /* 沒註冊過 */ }

  if (!matches.length) return { ok: true, matches: [] };

  // 只註冊「已經拿到授權」的網域 —— 沒授權時 registerContentScripts 會整批失敗
  const granted = [];
  for (const m of matches) {
    if (await chrome.permissions.contains({ origins: [m] })) granted.push(m);
  }
  if (!granted.length) return { ok: false, error: '網域尚未授權', matches, granted };

  try {
    await chrome.scripting.registerContentScripts([{
      id: JITSI_SCRIPT_ID,
      matches: granted,
      js: ['src/content/core.js', 'src/content/jitsi.js'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    }]);
    return { ok: true, matches, granted };
  } catch (err) {
    return { ok: false, error: String(err.message || err), matches, granted };
  }
}

// Service worker 會被回收再喚醒，restore() 必須先完成才能處理訊息，
// 否則喚醒後第一段字幕會先寫進空 state，接著被 restore 覆蓋掉。
const ready = store.restore();

// ── 與側邊欄的連線 ───────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ma-panel') return;
  ports.add(port);
  ready.then(() => port.postMessage({ type: 'state', payload: store.getState() }));
  port.onDisconnect.addListener(() => ports.delete(port));
});

function broadcast(type, payload) {
  for (const p of ports) {
    try { p.postMessage({ type, payload }); } catch { ports.delete(p); }
  }
}

function pushState() { broadcast('state', store.getState()); }

// 免費模型（Chrome 內建）跑在側邊欄裡：首次使用要使用者手勢觸發下載，
// 而 service worker 沒有手勢。這裡把「把推論請求送去側邊欄」的通道接上。
const deliverLocal = (payload) => {
  if (!ports.size) return false;
  broadcast('localRun', payload);
  return true;
};
deliverLocal.hasPanel = () => ports.size > 0;
bindPanelChannel(deliverLocal);

// ── 訊息路由 ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    switch (msg?.type) {
      case 'ma:segment':
        await onSegment(msg.payload);
        return reply?.({ ok: true });

      // 「畫面上現在誰在講話」——不需要開字幕的姓名來源
      case 'ma:speaking':
        if (sender?.tab?.id) meetingTabId = sender.tab.id;
        rememberSpeakingNames(msg.payload);
        return reply?.({ ok: true });

      case 'ma:status': {
        // 記住會議分頁的 id。側邊欄自己查不到可靠的答案 ——
        // 它是獨立的情境，chrome.tabs.query({active:true}) 可能給到別的分頁，
        // 於是 tabCapture 對著錯的分頁要音訊，永遠失敗。
        // 這則訊息是從會議分頁的 content script 送來的，sender.tab.id 才是對的。
        if (sender?.tab?.id) meetingTabId = sender.tab.id;
        const changed = store.startMeetingIfNeeded(msg.payload);
        store.setStatus({
          captionsFound: msg.payload.captionsFound,
          platform: msg.payload.platform,
          participants: msg.payload.participants,
          // 發言指示器有沒有找到 —— 設定頁的診斷靠這個回答
          // 「為什麼說話者都是『其他人』」
          speakerStrategy: msg.payload.speakerStrategy || '',
        });
        if (changed) pushState(); else broadcast('status', store.getState().status);
        return reply?.({ ok: true });
      }

      // 側邊欄回傳的本機模型結果
      case 'ma:local:delta':
      case 'ma:local:done':
      case 'ma:local:error':
        handlePanelMessage(msg);
        return reply?.({ ok: true });

      case 'ma:provider':
        return reply?.(await describe());

      case 'ma:bridge:check':
        return reply?.({ ok: await bridgeHealthy() });

      case 'ma:snapshot':
        return reply?.(await snapshotForClaudeCode());

      case 'ma:audioError':
        reportError(new Error(msg.message));
        return reply?.({ ok: true });

      case 'ma:getState':
        return reply?.(store.getState());

      case 'ma:ask':
        answerQuestion({
          question: msg.question, asker: '我', manual: true, withScreen: !!msg.withScreen,
        }).catch(reportError);
        return reply?.({ ok: true });

      case 'ma:summarizeNow':
        runSummary(true).catch(reportError);
        return reply?.({ ok: true });

      case 'ma:clear':
        store.clearAll();
        pushState();
        return reply?.({ ok: true });

      case 'ma:export': {
        const md = store.toMarkdown();
        return reply?.({ ok: true, markdown: md });
      }

      case 'ma:settings:get':
        return reply?.(await getSettings());

      // ── 金鑰 ────────────────────────────────────────────────
      // **回到畫面上的一律是遮罩過的**。設定頁與側邊欄的內容會出現在
      // 截圖、螢幕分享與錄影裡，而這個擴充功能的使用情境正好就是在分享畫面。
      case 'ma:keys:get': {
        const keys = await getKeys();
        return reply?.({
          masked: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, maskKey(v)])),
          present: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, !!v])),
          cloudConfigured: hasCloud(keys),
          mismatched: mismatchedKeys(keys),
          cooldown: cooldownState(),
        });
      }

      case 'ma:keys:set': {
        const next = await saveKeys(msg.patch || {});
        return reply?.({
          ok: true,
          cloudConfigured: hasCloud(next),
          mismatched: mismatchedKeys(next),
        });
      }

      case 'ma:keys:test': {
        // msg.key 是設定頁輸入框裡當下那把（還沒儲存）。有就測它 ——
        // 實際的操作順序是「貼上 → 測試 → 才儲存」，只測已存的那份會讓
        // 剛貼完金鑰的人收到「沒有填金鑰」，而他明明看得到金鑰就在框裡。
        const keys = await getKeys();
        const stored = { tavily: keys.tavily, nim2: keys.nvidia2, nim: keys.nvidia, groq: keys.groq };
        const key = String(msg.key || stored[msg.vendor] || '').trim();
        // noKey 讓設定頁分得出「沒有金鑰可測」與「金鑰被拒」——
        // 兩者該給使用者的下一步完全不同。
        if (!key) return reply?.({ ok: false, noKey: true, error: '還沒有金鑰' });

        if (msg.vendor === 'tavily') return reply?.(await testTavily(key));
        if (msg.vendor === 'nim2' || msg.vendor === 'nim') return reply?.(await testKey('nim', key));
        return reply?.(await testKey('groq', key));
      }

      case 'ma:settings:set': {
        const next = await saveSettings(msg.patch);
        // 網域改了就要重新註冊，否則設定存了卻沒生效
        if (msg.patch?.jitsiDomains !== undefined) await syncJitsiScripts();
        return reply?.(next);
      }

      case 'ma:jitsi:sync':
        return reply?.(await syncJitsiScripts());

      // 側邊欄要知道對哪個分頁擷取音訊。它自己用 tabs.query({active:true})
      // 會拿到錯的（側邊欄是獨立情境），content script 回報的才可靠。
      case 'ma:meetingTab':
        return reply?.({ tabId: meetingTabId });

      case 'ma:audio:start':
        return reply?.(await startAudioFallback(msg.streamId, msg.engine));

      // 設定頁的診斷用：說話者姓名這條路現在斷在哪一環
      case 'ma:speakerState': {
        const status = store.getState().status || {};
        const now = Date.now();
        return reply?.({
          ok: true,
          platform: status.platform,
          captionsFound: !!status.captionsFound,
          speakerStrategy: status.speakerStrategy || '',
          participants: status.participants || [],
          recent: recentCaptionSpeakers.slice(-5).map((c) => ({
            speaker: c.speaker, seconds: Math.round((now - c.to) / 1000),
          })),
        });
      }

      case 'ma:stt:status':      // 設定頁用：本機原生辨識裝好了沒
        return reply?.(await sttStatus());

      case 'ma:stt:stop':        // 設定頁用：把常駐的辨識伺服器收掉
        return reply?.(await sttShutdown());

      case 'ma:audioNote':      // offscreen 的進度說明，不是錯誤
        broadcast('audioNote', { message: msg.message });
        return reply?.({ ok: true });

      case 'ma:audio:stop':
        return reply?.(await stopAudioFallback());

      default:
        return reply?.({ ok: false, error: 'unknown message' });
    }
  })().catch((err) => { reportError(err); reply?.({ ok: false, error: String(err.message || err) }); });
  return true; // 保持非同步 reply 通道
});

function reportError(err) {
  const message = String(err?.message || err);
  console.error('[會議助手]', err);
  store.setStatus({ lastError: message });
  broadcast('error', { message });
}

/**
 * 「誰在什麼時間區間講話」，用來替音訊段落補上真實姓名。
 *
 * whisper **完全不做說話者分離**（它只有聲音，回來的就是一整段文字），
 * 真實姓名只有平台字幕有。字幕本身斷斷續續、不適合當逐字稿，但「誰在講話」
 * 這個資訊仍然可靠，所以留下來做校正。
 *
 * ## 為什麼記的是「區間」而不是「時間點」
 *
 * 一則字幕會持續好幾秒（而且會被串流改寫、同一個 id 定稿多次）。只記一個
 * 時間點的話，比對就變成「離哪一點最近」—— 一句講了 8 秒的話，後半段
 * 可能離下一個人的起點更近，於是被安到還沒開口的人頭上。
 * 記成 [from, to] 就能直接問「這個時間點誰在講話」。
 *
 * 只保留最近的幾筆 —— 這是即時比對，不需要整場歷史。
 */
const recentCaptionSpeakers = [];
const SPEAKER_MEMORY = 24;
/**
 * 落在所有區間之外時，容許離最近的區間多遠還算同一個人。
 *
 * 兩邊的時間都是**說話時間**（音訊段落用 whisper 的相對秒數換算，字幕用
 * 偵測到的時間），所以誤差來源只有「平台產生字幕的延遲」，實測 1–3 秒。
 * 6 秒留了兩倍餘裕。
 *
 * **不要放寬成 20 秒**（原本是）。那個數字是照本機辨識的處理延遲設的，
 * 但延遲早就不影響比對了 —— 比的是說話時間。放這麼寬的後果是安靜地
 * 掛錯人：20 秒內通常已經換過人，而「張三說了李四的話」在畫面上
 * 看起來完全正常，只有當事人自己看得出不對。
 */
const SPEAKER_MATCH_MS = 6000;

function rememberSpeaker(speaker, from, to) {
  if (!speaker || speaker === '未標註') return;
  // 選擇器抓錯時「說話者」可能是介面文字，記進去會把它安到某段音訊頭上
  if (looksLikeChrome(speaker)) return;

  const last = recentCaptionSpeakers[recentCaptionSpeakers.length - 1];
  // 同一個人連續講：延長區間而不是多記一筆。字幕會被串流改寫、發言指示器
  // 每 1.5 秒回報一次心跳 —— 每次都記一筆的話 SPEAKER_MEMORY 會被一個人塞滿，
  // 前面其他人的區間全部被擠掉。
  if (last && last.speaker === speaker && from - last.to < 8000) {
    last.to = Math.max(last.to, to);
    return;
  }
  recentCaptionSpeakers.push({ speaker, from, to: Math.max(from, to) });
  if (recentCaptionSpeakers.length > SPEAKER_MEMORY) recentCaptionSpeakers.shift();
}

function rememberCaptionSpeaker(seg) {
  const from = seg.startedAt || seg.ts || Date.now();
  rememberSpeaker(seg.speaker, from, seg.ts || from);
}

/**
 * 「畫面上顯示誰在講話」。**這條不需要使用者開字幕。**
 *
 * 字幕是可靠的姓名來源，但它要使用者自己在會議裡開啟 —— 那一步很容易漏掉，
 * 也常常根本不想開，於是整份逐字稿每一段都是「其他人」。
 * Meet／Teams／Jitsi 都會在畫面上標出正在說話的人，那個資訊本來就在，
 * 讀它等於免費多一個姓名來源。
 *
 * content script 已經做過兩道過濾（名字要像名字、要對得上參與者名單、
 * 同時兩個人在講就整個丟掉），所以這裡收到的就是可以用的。
 *
 * 區間的結束時間往後補一個心跳的長度：回報是每 1.5 秒一次，只記到「這一刻」
 * 的話，兩次心跳之間的音訊會落在區間外面而對不上。
 */
const SPEAKING_HEARTBEAT_MS = 1500;

function rememberSpeakingNames(payload) {
  const names = Array.isArray(payload?.names) ? payload.names : [];
  if (names.length !== 1) return;    // 兩個人同時講話時無法歸屬，寧可不記
  const at = Number(payload.at) || Date.now();
  rememberSpeaker(String(names[0]), at, at + SPEAKING_HEARTBEAT_MS);
}

/**
 * 這段文字看起來是 Meet／Teams 的介面，不是有人講的話。
 *
 * 全部來自實測抓錯時真的進到逐字稿的內容：Material Icons 的連字名稱
 * （`arrow_downward`、`arrow_drop_down` —— 圖示字型會把名稱當文字算進 textContent）、
 * 鍵盤快速鍵提示、Gemini 橫幅、「會議記錄器」這類功能標籤。
 */
const CHROME_TEXT = [
  /^[a-z_]+(跳到|展開|收合)/,              // arrow_downward跳到底部
  /^(arrow_|keyboard_|more_|close$|expand_)/i,
  /數位鍵盤|鍵盤快速鍵|按 Esc/,
  /取用 Gemini|會議記錄器|字幕設定/,
];

function looksLikeChrome(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return CHROME_TEXT.some((re) => re.test(t));
}

/**
 * 這個時間點字幕記到的是誰在講話；不知道就回傳 null。
 *
 * 先找「時間點真的落在區間裡」的，那是確定的答案。都沒有才退而求其次
 * 找最近的區間，而且要在 SPEAKER_MATCH_MS 之內 —— 寧可顯示佔位標籤，
 * 也不要把話掛到錯的人身上。掛錯的話畫面上看起來完全正常，
 * 只有當事人自己看得出不對，而摘要與回答建議已經被帶歪了。
 */
function speakerAt(ts) {
  for (const c of recentCaptionSpeakers) {
    if (ts >= c.from && ts <= c.to) return c.speaker;
  }
  let best = null;
  for (const c of recentCaptionSpeakers) {
    const gap = ts < c.from ? c.from - ts : ts - c.to;
    if (gap > SPEAKER_MATCH_MS) continue;
    if (!best || gap < best.gap) best = { speaker: c.speaker, gap };
  }
  return best?.speaker || null;
}

// ── 逐字稿段落進來 ──────────────────────────────────────────────
async function onSegment(seg) {
  // 只有字幕來源可以「開新會議」。音訊與字幕會同時存在，
  // 若讓音訊也重設 session，逐字稿會被清空。
  if (seg.source !== 'audio') {
    store.startMeetingIfNeeded({
      sessionId: seg.sessionId, platform: seg.platform, title: seg.title, url: seg.url,
    });
  }

  // **音訊在跑的時候，字幕只提供姓名、不進逐字稿。**
  //
  // 實測真實會議的 Meet 字幕斷斷續續、常常整段抓不到，拿它當逐字稿的結果是
  // 內容殘缺又重複；本機 whisper 反而完整得多。所以音訊是主要的逐字稿來源，
  // 字幕退成「誰在講話」的資料源 —— 各取所長，也不會同一句話記兩次。
  //
  // 但**音訊還沒起來的那幾秒字幕仍然要收**，否則開頭會缺一段。
  // 音訊一旦在跑，字幕就只提供姓名。
  if (seg.source === 'captions') {
    if (seg.final) rememberCaptionSpeaker(seg);
    if (store.getState().status?.audioFallback) return;
    // 字幕當逐字稿用的時候要擋掉介面文字。選擇器失效時抓到的是 Meet 自己的
    // UI（實測有「arrow_downward跳到底部」、鍵盤快速鍵提示、Gemini 橫幅），
    // 那些混進逐字稿會一路汙染摘要與回答建議，而且使用者看不出是壞的。
    if (looksLikeChrome(seg.text)) return;
  }

  // 本機辨識標的是「其他人（本機辨識）」這類佔位字串，能對上字幕就換成真名
  if (seg.source === 'audio') {
    const real = speakerAt(seg.startedAt || seg.ts || Date.now());
    if (real) seg = { ...seg, speaker: real };
  }

  const { isNewFinal, segment } = store.upsertSegment(seg);
  broadcast(seg.final ? 'segment' : 'partial', segment);

  if (!isNewFinal) return;

  const settings = await getSettings();
  if (settings.autoAnswer) await maybeAnswer(segment, settings);
  if (store.summaryDue({
    everySegments: settings.summaryEverySegments,
    everyMs: settings.summaryEveryMs,
  })) {
    runSummary(false).catch(reportError);
  }
}

// ── 滾動式摘要 ──────────────────────────────────────────────────
const SUMMARY_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      topics: { type: 'array', items: { type: 'string' }, description: '目前正在討論的主題，最多 5 個短詞' },
      summary: { type: 'array', items: { type: 'string' }, description: '整場會議的重點，每點一句話' },
      decisions: { type: 'array', items: { type: 'string' }, description: '已明確做出的決議' },
      actions: {
        type: 'array',
        description: '待辦事項',
        items: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '負責人姓名，未指定就寫「未指定」' },
            task: { type: 'string' },
          },
          required: ['owner', 'task'],
          additionalProperties: false,
        },
      },
      open_questions: { type: 'array', items: { type: 'string' }, description: '尚未有結論、需要後續追蹤的問題' },
    },
    required: ['topics', 'summary', 'decisions', 'actions', 'open_questions'],
    additionalProperties: false,
  },
};

/**
 * 免費的 Chrome 內建模型不保證支援 JSON schema 輸出，
 * 所以改要求固定前綴的純文字，再在這裡解析。
 */
function parsePlainSummary(text) {
  const lines = String(text).split('\n');
  const pick = (label) => lines
    .filter((l) => l.trim().startsWith(label))
    .map((l) => l.slice(l.indexOf(label) + label.length).replace(/^[:：\s\-—]+/, '').trim())
    .filter(Boolean);

  return {
    topics: pick('主題').flatMap((s) => s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean)),
    summary: pick('重點'),
    decisions: pick('決議'),
    actions: pick('待辦').map((l) => {
      const parts = l.split(/[|｜]/);
      return parts.length > 1
        ? { owner: parts[0].trim() || '未指定', task: parts.slice(1).join('|').trim() }
        : { owner: '未指定', task: l };
    }),
    open_questions: pick('問題'),
  };
}

const PLAIN_SUMMARY_FORMAT = [
  '用以下格式輸出，每行一項，不要加其他文字：',
  '主題: 詞1, 詞2',
  '重點: 一句話',
  '決議: 一句話',
  '待辦: 負責人|要做的事',
  '問題: 尚未有結論的問題',
  '同一種標籤可以有多行。沒有內容的標籤就整行省略。',
].join('\n');

let summaryRunning = false;

async function runSummary(force) {
  // 手動按下「✦ 產生重點」時，側邊欄會**先**把按鈕切成「產生中…」再送訊息過來
  // （不那樣做的話中間的空窗會讓人以為沒按到）。所以只要這裡提早返回，就必須
  // 補一則 running:false，否則那顆按鈕會永遠停在「產生中…」而且是停用的 ——
  // 使用者唯一的救法是關掉側邊欄重開，而畫面上完全看不出發生了什麼事。
  const bail = () => { if (force) broadcast('summaryStatus', { running: false }); };

  if (summaryRunning) return bail();
  const s = store.getState();
  if (!s.segments.length) return bail();

  const limits = await budget('summary');

  // Chrome 內建模型跑在側邊欄，關著就先不跑（而不是每次都噴錯誤）
  if (limits.provider === 'chrome-ai' && !(await describe()).panelReachable) return bail();

  summaryRunning = true;
  broadcast('summaryStatus', { running: true });
  try {
    const settings = await getSettings();
    const previous = s.summary
      ? JSON.stringify({
          topics: s.summary.topics, summary: s.summary.summary,
          decisions: s.summary.decisions, actions: s.summary.actions,
          open_questions: s.summary.open_questions,
        }, null, 0)
      : '（尚無先前摘要）';
    const tail = force
      ? store.transcriptText({ limitChars: limits.transcriptChars })
      : store.unsummarizedTail().map((x) => `${x.speaker}：${x.text}`).join('\n');

    const rules = [
      '你是會議記錄員。根據既有摘要與新增的逐字稿，輸出「更新後的完整摘要」。',
      '規則：',
      '- 摘要是累積的：保留先前仍然成立的重點，加入新資訊，修正被推翻的內容。',
      '- 只寫逐字稿真正說過的事，不要推測或補充背景知識。',
      '- 涉及人名時保留原文姓名，方便對照發言者。',
      '- 全部使用繁體中文（台灣用語）。每點一句話，不要贅字。',
      limits.structuredJson ? '- 若某個欄位沒有內容，回傳空陣列，不要硬湊。' : PLAIN_SUMMARY_FORMAT,
    ].join('\n');

    const { text } = await complete({
      role: 'summary',
      maxTokens: 4096,
      effort: 'medium',        // 摘要可以慢，換品質
      thinking: { type: 'adaptive' },
      format: limits.structuredJson ? SUMMARY_SCHEMA : undefined,
      system: [{ type: 'text', text: rules }],
      messages: [{
        role: 'user',
        content: `【既有摘要】\n${previous}\n\n【新增逐字稿】\n${tail || '（無）'}`,
      }],
      onFallback: ({ reason }) => {
        broadcast('audioNote', { message: `摘要的雲端後端不可用（${reason}），這一次改用 Claude Code。` });
      },
    });

    const parsed = limits.structuredJson ? JSON.parse(text) : parsePlainSummary(text);
    store.markSummarized(parsed);
    broadcast('summary', store.getState().summary);
  } catch (err) {
    // 段數不歸零（逐字稿留著下次一起送），但時間基準往前推，
    // 否則下一段發言講完就會立刻重試 —— 逾時或額度用盡時最不該這樣。
    store.deferSummary();
    throw err;
  } finally {
    summaryRunning = false;
    broadcast('summaryStatus', { running: false });
  }
}

// ── 偵測「有人在問我」 ─────────────────────────────────────────
const QUESTION_MARKS = /[?？]/;
const ZH_QUESTION = /(嗎|呢|如何|怎麼|怎樣|為什麼|為何|是不是|有沒有|可不可以|能不能|要不要|哪一?個|什麼時候|多少|意見|看法|想法)/;
const EN_QUESTION = /\b(what|why|how|when|where|which|who|can you|could you|do you|would you|any thoughts|your take)\b/i;
const DIRECT_ADDRESS = /(請問|想請|你覺得|你認為|你這邊|麻煩你|交給你|由你)/;

function looksLikeQuestion(text) {
  if (text.length < 4) return false;
  return QUESTION_MARKS.test(text) || ZH_QUESTION.test(text) || EN_QUESTION.test(text);
}

function addressesMe(text, myNames) {
  if (!myNames.length) return false;
  return myNames.some((n) => n && text.includes(n));
}

async function maybeAnswer(segment, settings) {
  if (segment.source === 'me') return;   // 我自己說的話不用回答
  const myNames = (settings.myNames || '').split(/[,，、\s]+/).filter(Boolean);
  const isQuestion = looksLikeQuestion(segment.text);
  if (!isQuestion) return;
  // 有點名我、或直接對人講話 → 才自動產生建議，避免每個問句都燒 token
  const targeted = addressesMe(segment.text, myNames) || DIRECT_ADDRESS.test(segment.text);
  if (!targeted) return;
  await answerQuestion({ question: segment.text, asker: segment.speaker, manual: false });
}

// ── 產生回答建議（串流） ────────────────────────────────────────
async function answerQuestion({ question, asker, manual, withScreen }) {
  const settings = await getSettings();
  const id = `a-${Date.now().toString(36)}`;
  const record = store.addAnswer({
    id, question, asker, answer: '', ts: Date.now(), streaming: true, manual,
  });
  broadcast('answer', record);

  const s = store.getState();
  const summaryBlock = s.summary
    ? [
        `目前重點：${(s.summary.summary || []).join('；') || '（無）'}`,
        `已決議：${(s.summary.decisions || []).join('；') || '（無）'}`,
        `待辦：${(s.summary.actions || []).map((a) => `${a.owner}-${a.task}`).join('；') || '（無）'}`,
      ].join('\n')
    : '（尚無摘要）';

  const limits = await budget('answer');

  // 畫面截圖：Claude Code 讀不到 base64，但讀得到檔案，所以存成 PNG 只把路徑交給它。
  // 截圖失敗不該讓回答整個失效 —— 少了畫面，逐字稿本身通常還是答得出來。
  let provider = limits.provider;
  let transcriptChars = limits.transcriptChars;
  let imagePath = null;
  let imageDataUrl = null;
  let role = 'answer';

  if (withScreen) {
    // **雲端優先，橋接是退路。**
    //
    // 這裡原本一律把「附上會議畫面」升級到 Claude Code，因為雲端模型看不懂
    // 圖片。實測踩到的問題是橋接比想像中脆弱：`config.json` 存的是 claude.exe
    // 的絕對路徑，而 Claude Code 的 VS Code 擴充功能會自動更新到新的版號
    // 資料夾，舊路徑就失效 —— 使用者看到的是「勾了附上會議畫面就出錯，
    // 不勾就正常」，完全聯想不到是別的軟體更新造成的。
    //
    // Groq 的 llama-4 看得懂圖片而且一樣免費，所以現在雲端自己處理：
    // 1 秒內回來，也不依賴本機裝了什麼。
    if (provider === 'cloud') {
      try {
        // 走雲端要的是 base64 data URL（不是檔案路徑），而且用 JPEG ——
        // PNG 的整頁截圖動輒好幾 MB，會撞到請求大小上限。
        imageDataUrl = await captureScreenDataUrl();
        role = 'vision';
        broadcast('answerNote', { id, note: '正在讀取會議畫面…' });
      } catch (err) {
        broadcast('answerNote', { id, note: `畫面擷取失敗，只依逐字稿回答：${err.message}` });
      }
    } else if (provider === 'chrome-ai' && await bridgeHealthy()) {
      // 本機模型看不懂圖片，而且沒有雲端金鑰時也沒有 llama-4 可用 ——
      // 這時橋接仍然是唯一看得懂畫面的路。
      provider = 'claude-code';
      transcriptChars = BUDGET['claude-code'].transcript.answer;
      broadcast('answerNote', {
        id,
        note: '本機模型看不懂圖片，這一題改用 Claude Code（較慢，但看得懂畫面）。',
      });
    }

    if (provider === 'claude-code') {
      try {
        imagePath = await captureScreenFile();
        broadcast('answerNote', { id, note: '正在讀取會議畫面…（多一次工具往返，約 10–20 秒）' });
      } catch (err) {
        broadcast('answerNote', { id, note: `畫面擷取失敗，只依逐字稿回答：${err.message}` });
      }
    } else if (!imageDataUrl) {
      broadcast('answerNote', {
        id,
        note: '目前的後端看不懂圖片。到設定頁貼上 Groq 金鑰就能用免費的雲端視覺模型；'
          + '或執行 bridge\\install.ps1 啟用 Claude Code 橋接。這一題只依逐字稿回答。',
      });
    }
  }

  // ── 需要外部事實時先查一次網路 ─────────────────────────────────
  // 只在問題明顯指向會議之外時才查（見 tavily.js 的 needsSearch）。
  // 每次查證多花 1–2 秒，而多數會議問題的答案就在逐字稿裡 ——
  // 為了少數問題讓每一題都變慢，等於把這個功能的價值抵銷掉。
  let webBlock = '';
  if (settings.webSearch !== false && !manual && needsSearch(question)) {
    broadcast('answerNote', { id, note: '這題看起來需要外部資料，正在查網路…' });
    const found = await searchWeb(question);
    webBlock = formatForPrompt(found);
    if (!found.ok) {
      broadcast('answerNote', { id, note: `網路查證沒有成功（${found.error}），只依逐字稿回答。` });
    }
  }

  try {
    await stream({
      // role 決定候選鏈。附上畫面時要走 vision 那條（看得懂圖片的模型），
      // 否則圖片會被送給一個看不懂它的模型 —— 不會報錯，只是被忽略。
      role,
      provider,
      maxTokens: 1200,
      // imagePath 給橋接（Claude Code 讀檔案），imageDataUrl 給雲端（base64）。
      // 兩個同時是 null 就是純文字回答。
      imagePath,
      imageDataUrl,
      effort: 'low',
      // 即時回答重點是延遲：關閉思考，靠上下文與低 effort 換速度。
      thinking: { type: 'disabled' },
      system: [
        {
          type: 'text',
          text: [
            '你是使用者在會議中的即時助手。使用者剛被提問，需要能「照著唸」的回答。',
            '輸出格式（純文字，不要 Markdown 標題）：',
            '第一行：一句話的直接回答，30 字以內，可以直接講出口。',
            '接著 2–4 個「・」開頭的補充要點，每點一行、一句話。',
            '若逐字稿或我的筆記裡沒有足夠資訊，第一行就誠實說明可以怎麼回應（例如先確認需求、承諾會後補），不要編造數字或承諾。',
            '不要重述問題，不要加開場招呼，不要說明你是 AI。全部使用繁體中文（台灣用語）。',
          ].join('\n'),
        },
        {
          type: 'text',
          text: [
            `【我的背景筆記】\n${settings.notes || '（無）'}`,
            `【會議摘要】\n${summaryBlock}`,
            webBlock,
            `【近期逐字稿】\n${store.transcriptText({ limitChars: transcriptChars })}`,
          ].filter(Boolean).join('\n\n'),
        },
      ],
      messages: [{
        role: 'user',
        content: manual
          ? `我想知道：${question}`
          : `${asker} 問我：「${question}」。請給我回答建議。`,
      }],
      onDelta: (chunk) => {
        record.answer += chunk;
        broadcast('answerDelta', { id, chunk });
      },
      // 雲端整條斷掉時會退回 Claude Code。0.7 秒變成 10–30 秒，
      // 不講的話使用者只會覺得「今天特別慢」，然後去懷疑自己的網路。
      onFallback: ({ reason }) => {
        broadcast('answerNote', { id, note: `雲端後端暫時不可用（${reason}），改用 Claude Code —— 會慢很多（10–30 秒）。` });
      },
    });
    store.updateAnswer(id, { streaming: false });
    broadcast('answerDone', { id, answer: record.answer });
  } catch (err) {
    store.updateAnswer(id, { streaming: false, error: String(err.message || err) });
    broadcast('answerDone', { id, answer: record.answer, error: String(err.message || err) });
    throw err;
  }
}

// ── 存檔給 Claude Code（用 Pro 訂閱做高品質摘要／看畫面的免費路線） ──
// 把「會議畫面截圖」和「逐字稿 Markdown」寫進下載資料夾的同一個子目錄，
// 之後在 Claude Code 說「看一下剛剛的畫面和逐字稿」就能直接讀檔，
// 不必把圖片送進 API（那才會按量計費）。
/**
 * 存一張目前畫面的 PNG，回傳**本機絕對路徑**。
 *
 * 需要絕對路徑是因為 Claude Code 是本機程序：它讀檔案，不收 base64。
 * chrome.downloads.download 只回傳 id，路徑得再用 search 查；而且要等
 * state 變成 complete 才保證檔案已經寫完，否則 Claude Code 可能讀到空檔。
 */
/**
 * 截圖成 base64 data URL，給雲端視覺模型用。
 *
 * 跟 captureScreenFile 的差別不只是格式：
 *
 *  - **用 JPEG 而不是 PNG。** 整頁截圖的 PNG 動輒好幾 MB，base64 之後再脹
 *    三分之一，會撞到請求大小上限（而失敗訊息不會告訴你是圖片太大）。
 *    會議畫面是簡報和人臉，JPEG 品質 70 完全夠讀。
 *  - **不落地成檔案。** 雲端要的是 base64，存檔只是多一次磁碟往返，
 *    而且會在使用者的下載資料夾裡累積一堆截圖。
 */
async function captureScreenDataUrl() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('找不到作用中的分頁');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
  if (!dataUrl) throw new Error('截圖是空的');
  return dataUrl;
}

async function captureScreenFile() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('找不到作用中的分頁');

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: `會議助手/提問畫面-${stamp}.png`,
    saveAs: false,
  });

  for (let i = 0; i < 20; i++) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === 'complete' && item.filename) return item.filename;
    if (item?.state === 'interrupted') throw new Error(item.error || '截圖存檔被中斷');
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('截圖存檔逾時');
}

async function snapshotForClaudeCode() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = '會議助手';
  const saved = [];

  const md = store.toMarkdown();
  await chrome.downloads.download({
    url: `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`,
    filename: `${dir}/逐字稿-${stamp}.md`,
    saveAs: false,
  });
  saved.push(`逐字稿-${stamp}.md`);

  // 畫面截圖：需要會議分頁是作用中的分頁
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      await chrome.downloads.download({
        url: dataUrl,
        filename: `${dir}/畫面-${stamp}.png`,
        saveAs: false,
      });
      saved.push(`畫面-${stamp}.png`);
    }
  } catch (err) {
    // 截圖失敗不該讓逐字稿也存不下來
    return { ok: true, saved, dir, warning: `逐字稿已存檔，但畫面擷取失敗：${err.message}` };
  }

  return { ok: true, saved, dir };
}

// ── 聽會議聲音（逐字稿的來源） ──────────────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '擷取會議分頁音訊，在平台字幕不可用時做語音辨識備援。',
  });
}

/**
 * 開始聆聽。**streamId 由側邊欄取得後傳進來，不在這裡呼叫 tabCapture。**
 *
 * `chrome.tabCapture.getMediaStreamId()` 要求使用者手勢，而**手勢不會跨
 * sendMessage 傳到 service worker** —— 之前是側邊欄按鈕送訊息、背景去呼叫，
 * 背景那邊沒有手勢，所以按了永遠失敗（症狀：「按了沒反應」）。
 * 現在側邊欄在點擊處理函式裡直接呼叫，只把拿到的 id 交過來。
 */
async function startAudioFallback(streamId, engineOverride) {
  const settings = await getSettings();

  if (!streamId) {
    const message = '沒有拿到分頁音訊串流。請按側邊欄的「▶ 開始聆聽」。';
    reportError(new Error(message));
    return { ok: false, error: message };
  }

  // 三條引擎都不會產生按量費用（Groq 是免費方案、另外兩條在本機跑）。
  // 曾經有 Deepgram 那條按量計費的，已整個移除。
  let engine = engineOverride || settings.sttEngine || 'groq';

  // 雲端要有金鑰才走得通。沒有的話**現在就退回本機**，不要等到第一段音訊
  // 送出去才失敗 —— 那時候使用者已經在講話了，前幾句會直接掉掉，
  // 而畫面上只會顯示「聆聽中」。
  const keys = await getKeys();
  let engineNote = '';
  if (engine === 'groq' && !keys.groq) {
    engine = 'whisper-native';
    engineNote = '沒有設定 Groq 金鑰，改用本機辨識（較慢、中文準確度較低）。'
      + '要用雲端辨識請到設定頁貼上 Groq 的 API 金鑰。';
  }

  // **順序很重要：先讓 offscreen 把串流接走，再去啟動辨識伺服器。**
  //
  // `getMediaStreamId()` 拿到的 id **幾秒內沒被用掉就失效**。原本的順序是
  // 先跑 sttEnsure（冷啟動載入 small 模型要好幾秒）再交給 offscreen，
  // 於是 getUserMedia 拿到的是過期的 id —— 擷取靜靜失敗，狀態卻已經
  // 顯示「聆聽中」，講再多話都不會有逐字稿，而且沒有任何錯誤訊息。
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: 'ma:offscreen:start',
    streamId,
    engine,
    options: {
      modelId: settings.sttModel || 'Xenova/whisper-base',
      model: settings.sttNativeModel || 'small',
      endpoint: STT_ENDPOINT,
      toTraditional: settings.sttTraditional !== false,
      // 金鑰只在啟動時傳一次給 offscreen，不存在那邊的持久狀態裡。
      groqKey: keys.groq,
      groqSttModel: settings.sttGroqModel || 'whisper-large-v3-turbo',
    },
  });
  // 收不到回覆也算失敗：offscreen 沒起來時 sendMessage 會回 undefined，
  // 當成成功的話就是「安靜地什麼都不做」。
  if (!res || res.ok === false) {
    await stopAudioFallback();
    const message = `音訊擷取啟動失敗：${res?.error || 'offscreen 沒有回應'}`;
    reportError(new Error(message));
    return { ok: false, error: message };
  }

  // 串流已經接住了，現在才去拉辨識伺服器。前幾段音訊會在佇列裡等它就緒。
  // 雲端那條不需要這一步（沒有要啟動的東西），所以只有本機引擎會進來。
  let sttNote = engineNote;
  if (engineNote) broadcast('audioNote', { message: engineNote });
  let finalEngine = engine;
  if (engine === 'whisper-native') {
    try {
      const r = await sttEnsure(settings.sttNativeModel);
      // 用 += 而不是 = ：前面可能已經有一句「沒有金鑰所以退回本機」，
      // 蓋掉的話使用者就看不到自己為什麼在用比較差的引擎。
      if (!r.reused && r.startMs) sttNote += `本機辨識伺服器已啟動（載入模型 ${(r.startMs / 1000).toFixed(1)} 秒）。`;
    } catch (err) {
      // 原生起不來就改用瀏覽器內的 WASM。串流已經在跑，只要換掉引擎就好。
      finalEngine = 'whisper';
      sttNote += `原生本機辨識無法啟動（${String(err.message || err)}），已改用瀏覽器內建的備援引擎 —— 一樣免費，但較慢且中文準確度較差。想要更好的結果請執行 tools\\install-whisper.ps1。`;
      broadcast('audioNote', { message: sttNote });
      await chrome.runtime.sendMessage({ type: 'ma:offscreen:engine', engine: 'whisper' });
    }
  }

  store.setStatus({ audioFallback: true, sttEngine: finalEngine });
  broadcast('status', store.getState().status);
  return { ok: true, engine: finalEngine, note: sttNote };
}

async function stopAudioFallback() {
  try { await chrome.runtime.sendMessage({ type: 'ma:offscreen:stop' }); } catch {}
  try { await chrome.offscreen.closeDocument(); } catch {}
  // 原生辨識伺服器（small 模型約 400 MB 記憶體）不該在停止擷取後還留著。
  // 斷開 native 連線時主機端的 finally 也會收一次，這裡是明確的那一次。
  try { await sttShutdown(); } catch {}
  store.setStatus({ audioFallback: false });
  broadcast('status', store.getState().status);
  return { ok: true };
}
