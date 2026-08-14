/**
 * 設定的單一來源。存在 chrome.storage.local，不上傳任何伺服器。
 *
 * 這個檔案刻意**只留使用者非填不可的欄位**。後端、辨識引擎、模型、摘要頻率
 * 全部寫死成實測最佳的組合，不做成選項 —— 每多一個開關就多一種設錯的方式，
 * 而設錯的症狀（品質變差、變慢、安靜地不動）使用者根本看不出是設定造成的。
 *
 * ## 寫死的組合，以及為什麼
 *
 * 前提：**不接受任何按量計費**。所以會轉成帳單的路（Claude API、Deepgram）
 * 整個移除，連設定欄位都不留 —— 留著就有誤觸的可能。
 *
 *   逐字稿 → Groq whisper-large-v3-turbo（免費方案）
 *            實測 RTF 0.06、16.6 秒的樣本一字未錯。本機 small 是 RTF 0.47
 *            而且「大致正確」—— 摘要吃的是逐字稿，錯一個關鍵詞整段就歪了。
 *   摘要   → Groq gpt-oss-120b（免費方案）
 *   問答   → Groq llama-3.3-70b-versatile（免費方案，實測 0.7 秒）
 *
 * 三條都退得回本機／訂閱制的免費路（本機 whisper.cpp、Claude Code 橋接），
 * 沒有金鑰或撞到額度時自動接手，見 resolveProvider 與 provider.js。
 *
 * ## 這些「免費」到底是什麼意思
 *
 * Groq 與 NVIDIA NIM 的免費方案**不需要信用卡，也不會自動轉成按量計費**：
 * 用超過就是回 HTTP 429，不是開始扣錢。這跟 Claude API 那種
 * 「綁了卡就一直扣」的模式完全不同，所以才符合「只花已經買了的訂閱」這個前提。
 * 額度數字與查證日期寫在 README。
 */

export const DEFAULT_SETTINGS = {
  // ── 使用者要填的（只有這兩個）─────────────────────────────
  myNames: '',                 // 逗號分隔：別人叫到這些名字時視為在問我
  notes: '',                   // 我的背景知識／立場，回答建議會參考

  // ── 以下全部寫死，設定頁不顯示 ────────────────────────────

  // 摘要與問答優先走雲端免費方案（快一個數量級），沒有金鑰或撞到額度時
  // 自動退回 Claude Code 橋接。見 resolveProvider。
  provider: 'cloud',
  fastAnswersLocal: false,

  // 雲端不可用時要不要退回 Claude Code。關掉的話會直接告訴使用者失敗原因，
  // 而不是安靜地變成一個要等 30 秒的後端 —— 有些人寧可知道它壞了。
  cloudFallbackToBridge: true,

  // 摘要頻率：兩個條件都成立才觸發（AND）。
  // 5 分鐘而不是 1 分鐘：Claude Code 每次呼叫都是一個完整的 CLI session，
  // 一分鐘一次會很快吃掉 Pro 的用量額度。
  summaryEverySegments: 8,
  summaryEveryMs: 300000,
  autoAnswer: true,

  // 語音辨識：Groq 的 whisper-large-v3-turbo。
  // 同一段 16.6 秒的中文會議錄音實測，RTF 0.06（本機原生 small 是 0.47、
  // 瀏覽器 WASM base 是 0.50），而且逐字稿一字未錯 —— 本機 small 只是
  // 「大致正確」，錯一個關鍵詞（對帳→對戰）就會把摘要與回答建議一起帶歪。
  // 沒有金鑰時自動退回 whisper-native，見 service-worker 的 startAudioFallback。
  sttEngine: 'groq',
  sttGroqModel: 'whisper-large-v3-turbo',
  sttNativeModel: 'small',
  sttModel: 'Xenova/whisper-base',   // 原生起不來時的 WASM 備援
  sttTraditional: true,              // 辨識結果轉繁體（台灣用字）

  // 這裡曾經有 sttAuto（「進到會議就自動開始聽分頁聲音」）。**拿掉了，
  // 因為那件事做不到**：chrome.tabCapture.getMediaStreamId 要求呼叫發生在
  // 使用者手勢的脈絡裡，計時器觸發的一定被拒。留著一個永遠不會被讀取的
  // 開關，只會讓下一個人以為自動啟動是可設定的，然後去找它為什麼沒生效。
  // 唯一可用的手勢來源是點工具列圖示，見 service-worker 的 onClicked。

  // 提問時附上會議畫面截圖。預設關閉：多花 10–20 秒，而且多耗一次 Pro 額度。
  captureScreen: false,

  // 自架的 Jitsi 網域（逗號分隔）。公開站不必填。
  jitsiDomains: '',

  // 由側邊欄偵測後寫回：Gemini Nano 需要 >4GB VRAM 與 >22GB 可用磁碟，
  // 不是每台機器都跑得動。背景沒有 LanguageModel，問不到，只能由側邊欄回報。
  localModelUnsupported: false,

  // 回答需要外部事實時，先用 Tavily 查一次網路再作答。
  // 預設開啟但**只在問題看起來需要查證時才會呼叫**（見 tavily.js 的判斷），
  // 因為每次查證都會多花 1–2 秒，而多數會議問題靠逐字稿就答得出來。
  webSearch: true,

  // 設定結構的版本。用來做一次性遷移（見 migrate）。
  schemaVersion: 5,
};

/**
 * 一次性遷移。
 *
 * 存起來的設定只包含使用者存過的欄位，所以「舊的預設值」與「使用者刻意選的值」
 * 長得一模一樣，沒有版本號就分不出來。
 *
 *   第 2 版：語音辨識預設從瀏覽器內 WASM 換成原生 whisper.cpp（更準也更快）。
 *   第 3 版：砍掉所有付費路線與後端選項。舊設定若停在 Claude API 或 Deepgram，
 *           一律拉回免費組合 —— 使用者的要求是「只花 Pro 訂閱的錢」，
 *           留著舊值會在他不知道的情況下繼續計費。
 *   第 4 版：即時回答不再走 Chrome 內建模型（不支援中文輸出），改走 Claude Code。
 *           舊設定存的是 fastAnswersLocal: true，不遷移的話會繼續用一個
 *           吐不出中文的模型回答中文會議的問題。
 */
function migrate(stored) {
  const out = { ...stored };
  if (!(out.schemaVersion >= 2)) {
    if (out.sttEngine === 'whisper') out.sttEngine = 'whisper-native';
    out.schemaVersion = 2;
  }
  if (!(out.schemaVersion >= 3)) {
    // 付費後端 → 免費組合
    if (out.provider !== 'claude-code') out.provider = 'claude-code';
    if (out.sttEngine === 'deepgram') out.sttEngine = 'whisper-native';
    // 這些欄位已經不存在了，清掉避免殘留在 storage 裡
    delete out.apiKey;
    delete out.deepgramKey;
    delete out.model;
    delete out.effortSummary;
    delete out.effortAnswer;
    delete out.micAuto;
    out.schemaVersion = 3;
  }
  if (!(out.schemaVersion >= 4)) {
    out.fastAnswersLocal = false;
    out.schemaVersion = 4;
  }
  if (!(out.schemaVersion >= 5)) {
    // 主力從「本機 whisper ＋ Claude Code」換成「Groq 免費方案」。
    // 舊設定存的是 sttEngine: 'whisper-native' 與 provider: 'claude-code'，
    // 不遷移的話升級後一切照舊 —— 使用者會以為新版沒生效。
    //
    // 只搬「停在舊預設值」的情況。使用者若刻意留在本機引擎（例如不希望
    // 音訊離開這台電腦），那是個有意識的選擇，不該被升級偷偷改掉。
    if (out.sttEngine === 'whisper-native' || out.sttEngine === undefined) out.sttEngine = 'groq';
    if (out.provider === 'claude-code' || out.provider === undefined) out.provider = 'cloud';
    out.schemaVersion = 5;
  }
  return out;
}

/**
 * 把使用者輸入的自架 Jitsi 網域整理成 match pattern。
 * 允許他們貼整個網址（https://jitsi.x.com/room）或只寫網域，兩種都要能用。
 */
export function jitsiPatterns(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))
    .map((host) => `https://${host}/*`);
}

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...migrate(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/**
 * 實際要用哪個後端。**兩者都免費**（Pro 訂閱額度／本機執行），
 * 這個函式不可能回傳付費後端。
 *
 * ## 為什麼摘要與問答都走 Claude Code
 *
 * 本來即時回答走 Chrome 內建的 Gemini Nano（1–3 秒，比 Claude Code 快得多）。
 * 但**那顆模型不支援中文輸出** —— Chrome 的 `LanguageModel.create()` 要求指定
 * `outputLanguage`，而支援清單只有 [en, es, ja]（實測錯誤訊息列出 de/en/es/fr/ja），
 * 沒有 zh。不指定會在擴充功能的錯誤頁一直累積警告，指定 zh 直接失敗。
 *
 * 這是一個**中文會議助手**，回答建議要能直接照唸 —— 一個吐英文的模型
 * 在這裡沒有用。所以即時回答也改走 Claude Code：慢（10–30 秒），
 * 但至少是可用的中文。
 *
 * `fastAnswersLocal` 保留給「哪天 Nano 支援中文了」或使用者主要開英文會議的情況，
 * 預設關閉。要打開的話直接改 storage。
 */
export function resolveProvider(settings, role = 'summary', opts = {}) {
  const localOk = !settings.localModelUnsupported;

  // 雲端免費方案優先 —— 但**只有真的有金鑰時**（cloudReady 由 provider.js 帶進來）。
  // 沒有金鑰卻回傳 'cloud' 的話，每一次呼叫都要先失敗一輪才退回橋接，
  // 使用者看到的是「每次都慢 20 秒」而不是「沒設定金鑰」。
  if (settings.provider === 'cloud' && opts.cloudReady) return 'cloud';

  // 預設不再走 Nano（不支援中文輸出）。fastAnswersLocal 明確設成 true 才會用。
  if (role === 'answer' && localOk && settings.fastAnswersLocal === true) return 'chrome-ai';
  return 'claude-code';
}
