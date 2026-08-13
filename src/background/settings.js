/**
 * 設定的單一來源。存在 chrome.storage.local，不上傳任何伺服器。
 *
 * 這個檔案刻意**只留使用者非填不可的欄位**。後端、辨識引擎、模型、摘要頻率
 * 全部寫死成實測最佳的組合，不做成選項 —— 每多一個開關就多一種設錯的方式，
 * 而設錯的症狀（品質變差、變慢、安靜地不動）使用者根本看不出是設定造成的。
 *
 * ## 寫死的組合，以及為什麼
 *
 * 前提：**只花 Claude Pro 訂閱的錢，其他一律不花**。所以按量計費的路
 * （Claude API、Deepgram）整個移除，連設定欄位都不留 —— 留著就有誤觸的可能。
 *
 *   摘要   → Claude Code（Pro 訂閱額度，免費）
 *            一次 10–30 秒，但摘要本來就不需要即時，換到最好的品質。
 *   問答   → Chrome 內建 Gemini Nano（免費、離線、1–3 秒）
 *            被點名時要秒回，10–30 秒的後端在這裡沒有意義。
 *            Nano 跑不動的機器會自動退回 Claude Code（見 resolveProvider）。
 *   逐字稿 → 本機 whisper.cpp small 模型（免費、離線）
 *
 * 三條路都不會產生任何按量費用。
 */

export const DEFAULT_SETTINGS = {
  // ── 使用者要填的（只有這兩個）─────────────────────────────
  myNames: '',                 // 逗號分隔：別人叫到這些名字時視為在問我
  notes: '',                   // 我的背景知識／立場，回答建議會參考

  // ── 以下全部寫死，設定頁不顯示 ────────────────────────────

  // 摘要走 Claude Code、問答走 Nano。見 resolveProvider。
  provider: 'claude-code',
  fastAnswersLocal: true,

  // 摘要頻率：兩個條件都成立才觸發（AND）。
  // 5 分鐘而不是 1 分鐘：Claude Code 每次呼叫都是一個完整的 CLI session，
  // 一分鐘一次會很快吃掉 Pro 的用量額度。
  summaryEverySegments: 8,
  summaryEveryMs: 300000,
  autoAnswer: true,

  // 語音辨識：本機 whisper.cpp，small 模型。
  // 用 small 是因為中文差距很大 —— 同一段音訊 base 把「這季／結帳／對帳／小陳」
  // 全聽錯，small 全對，而原生 small 的 RTF（0.47）還比 WASM base（0.50）低。
  sttEngine: 'whisper-native',
  sttNativeModel: 'small',
  sttModel: 'Xenova/whisper-base',   // 原生起不來時的 WASM 備援
  sttTraditional: true,              // 辨識結果轉繁體（台灣用字）

  // 音訊優先：進到會議就直接開始聽分頁聲音，不等字幕。
  // 平台字幕實測斷斷續續又常抓不到（Meet 的 DOM 每幾個月改一次），
  // 本機 whisper 反而穩定得多；字幕改成只拿來校正說話者姓名（見 core.js）。
  sttAuto: true,

  // 提問時附上會議畫面截圖。預設關閉：多花 10–20 秒，而且多耗一次 Pro 額度。
  captureScreen: false,

  // 自架的 Jitsi 網域（逗號分隔）。公開站不必填。
  jitsiDomains: '',

  // 由側邊欄偵測後寫回：Gemini Nano 需要 >4GB VRAM 與 >22GB 可用磁碟，
  // 不是每台機器都跑得動。背景沒有 LanguageModel，問不到，只能由側邊欄回報。
  localModelUnsupported: false,

  // 設定結構的版本。用來做一次性遷移（見 migrate）。
  schemaVersion: 3,
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
 * 實際要用哪個後端。分角色決定，因為兩件事對延遲的要求完全不同：
 *   summary — 可以慢，優先挑品質 → Claude Code
 *   answer  — 要秒級          → Gemini Nano
 *
 * 兩者都是免費的（Pro 訂閱額度／本機執行），這個函式不可能回傳付費後端。
 */
export function resolveProvider(settings, role = 'summary') {
  const localOk = !settings.localModelUnsupported;

  // 即時回答走本機模型（1–3 秒）；這台機器跑不動 Nano 就退回 Claude Code。
  // 慢，但有東西可用勝過整個功能靜靜地失敗。
  //
  // fastAnswersLocal 預設開啟，設定頁不再顯示它。留著這個判斷是因為
  // 「回答要快還是要準」是真的有取捨的：關掉之後回答改走 Claude Code，
  // 品質好得多但每題要等 10–30 秒。需要時直接改 storage 就能切換。
  if (role === 'answer' && localOk && settings.fastAnswersLocal !== false) return 'chrome-ai';
  return 'claude-code';
}
