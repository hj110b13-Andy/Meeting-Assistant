/** 設定的單一來源。存在 chrome.storage.local，不上傳任何伺服器。 */

export const DEFAULT_SETTINGS = {
  // 模型後端：auto = 有金鑰就用 Claude，沒有就用 Chrome 內建模型
  provider: 'auto',            // auto | claude | chrome-ai | claude-code

  // Claude Code 一次呼叫要 10–30 秒，當不了即時回答。開著這個開關時，
  // 摘要走 Claude Code（品質最好），即時回答改走本機模型（1–3 秒），兩者都免費。
  fastAnswersLocal: true,

  apiKey: '',
  model: 'claude-sonnet-5',
  effortSummary: 'medium',     // low | medium | high | xhigh | max
  effortAnswer: 'low',

  myNames: '',                 // 逗號分隔：別人叫到這些名字時視為在問我
  notes: '',                   // 我的背景知識／立場，回答建議會參考

  summaryEverySegments: 8,
  // 5 分鐘而不是 1 分鐘：免費路線實際上多半落在 Claude Code，
  // 而它每次呼叫都是一個完整的 CLI session，一分鐘一次會很快吃掉 Pro 的用量額度。
  summaryEveryMs: 300000,
  autoAnswer: true,

  captureScreen: false,        // 提問時預設附上一張會議畫面截圖

  // 「聽會議聲音」的引擎。前兩個都是本機執行、零費用、不需金鑰。
  //
  //   whisper-native — 原生 whisper.cpp（要跑一次 tools\install-whisper.ps1）。
  //                    預設。用 small 模型，中文準確度遠勝 WASM 的 base：
  //                    實測「這季／結帳／對帳／小陳」base 全錯、small 全對，
  //                    而且原生 small 的 RTF（0.47）還比 WASM base（0.50）低。
  //   whisper        — 瀏覽器內 WASM，免安裝但慢又不準。原生不可用時的自動備援。
  //   deepgram       — 雲端，延遲低且有講者分群，但按量計費。
  sttEngine: 'whisper-native', // whisper-native | whisper | deepgram
  sttNativeModel: 'small',     // small（準）| base（快三倍，中文明顯較差）
  sttModel: 'Xenova/whisper-base',   // WASM 備援用的模型
  deepgramKey: '',             // 只有選 deepgram 時才需要

  // 把辨識結果轉成繁體中文（台灣用字）。whisper 的中文模型輸出簡體，
  // 而用繁體 initial prompt 引導會犧牲準確度（實測「對帳」變「對戰」），
  // 所以改成辨識後用字表確定性轉換。字幕來源不受影響（表裡只有簡體字）。
  sttTraditional: true,

  // 平台沒有字幕時（例如沒裝 Jigasi 的 Jitsi）自動開始聽分頁聲音。
  // 只在本機引擎下自動啟動 —— 自動花錢是不能接受的。
  sttAuto: true,

  // 抓不到字幕時自動開啟麥克風辨識。不無條件開啟，因為平台字幕本來就
  // 包含你自己的發言（還帶真實姓名），兩邊都收會讓逐字稿與摘要出現重複。
  micAuto: true,

  // 自架的 Jitsi 網域（逗號分隔，例如 jitsi.mycompany.com）。
  // Jitsi 可自架所以網域不固定，manifest 只能靜態註冊公開站；
  // 這裡的網域由 chrome.scripting 動態註冊內容腳本。
  jitsiDomains: '',

  // 由側邊欄偵測後寫回：Gemini Nano 需要 >4GB VRAM 與 >22GB 可用磁碟，
  // 不是每台機器都跑得動。背景沒有 LanguageModel，問不到，只能由側邊欄回報。
  localModelUnsupported: false,

  // 設定結構的版本。用來做一次性遷移（見 migrate）。
  schemaVersion: 2,
};

/**
 * 一次性遷移。
 *
 * 存起來的設定只包含使用者存過的欄位，所以「舊的預設值」與「使用者刻意選的值」
 * 長得一模一樣，沒有版本號就分不出來。第 2 版把語音辨識的預設從瀏覽器內 WASM
 * 換成原生 whisper.cpp（更準也更快），舊使用者需要跟著換過去，
 * 否則會一直停在明顯較差的那條路上而不知道。
 */
function migrate(stored) {
  const out = { ...stored };
  if (!(out.schemaVersion >= 2)) {
    if (out.sttEngine === 'whisper') out.sttEngine = 'whisper-native';
    out.schemaVersion = 2;
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
 *   summary — 可以慢，優先挑品質
 *   answer  — 要秒級，慢的後端不能用
 */
export function resolveProvider(settings, role = 'summary') {
  const localOk = !settings.localModelUnsupported;

  const explicit = ['claude', 'chrome-ai', 'claude-code'].includes(settings.provider)
    ? settings.provider
    : (settings.apiKey ? 'claude' : 'chrome-ai');

  // 這台機器跑不動 Gemini Nano 時，退到另一條同樣免費的路：Claude Code（Pro 額度）。
  // 慢，但有東西可用勝過整個功能靜靜地失敗。
  const picked = (explicit === 'chrome-ai' && !localOk) ? 'claude-code' : explicit;

  // Claude Code 每次要 10–30 秒，即時回答就別用它了 —— 前提是本機模型真的能跑
  if (role === 'answer' && picked === 'claude-code' && settings.fastAnswersLocal && localOk) {
    return 'chrome-ai';
  }
  return picked;
}
