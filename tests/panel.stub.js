/** panel.js 執行前先安裝的 chrome API stub */

// 假的 Chrome 內建模型。真實的 LanguageModel.availability() 是對瀏覽器程序的
// 非同步呼叫，測試等不到，而且結果會隨機器狀態變動；換成假的才有確定性，
// 也才驗得到 promptStreaming → ma:local:delta 的串接。
// 記錄每一次呼叫與它帶的選項。Chrome 對「沒指定 outputLanguage 的
// LanguageModel 呼叫」會在擴充功能錯誤頁累積警告，所以要驗兩件事：
// 用不到它的時候完全不碰，真的要碰時一定帶 outputLanguage。
window.__lmCalls = [];
self.LanguageModel = {
  availability: async (opts) => { window.__lmCalls.push({ fn: 'availability', opts }); return 'available'; },
  create: async () => ({
    clone: async () => ({
      promptStreaming: async function* () { yield '這是'; yield '本機模型的回答。'; },
      destroy() {},
    }),
  }),
};
// 假的瀏覽器語音辨識（「我的發言」用的）。真的那顆會要麥克風權限、
// 而且結果不確定，測試等不到；換成假的才驗得到「跟著聆聽自動開關」。
window.__recognizers = [];
window.SpeechRecognition = function () {
  const r = {
    started: false, stopped: false,
    start() { if (this.started && !this.stopped) throw new Error('已經在跑'); this.started = true; this.stopped = false; },
    stop() { this.stopped = true; this.onend?.(); },
  };
  window.__recognizers.push(r);
  return r;
};

window.__ports = [];
window.__sent = [];
// 預設讓側邊欄以為目前走 Chrome 內建模型（needsPanel: true），
// 這樣既有的徽章／「啟用免費模型」按鈕測試才有東西可驗。
window.__providerInfo = {
  provider: 'chrome-ai', label: 'Chrome 內建模型（免費）', answerLabel: 'Chrome 內建模型（免費）',
  free: true, supportsImages: false, needsPanel: true, panelReachable: true, cloudConfigured: true,
};
window.chrome = {
  runtime: {
    lastError: undefined,
    connect: ({ name }) => {
      const p = { name, listeners: [], onMessage: { addListener: (fn) => p.listeners.push(fn) }, postMessage: () => {} };
      window.__ports.push(p);
      return p;
    },
    sendMessage: async (msg) => {
      window.__sent.push(msg);
      // 讓側邊欄以為目前是免費模式，才能驗證徽章與「啟用免費模型」按鈕。
      // 可以換掉（見 __providerInfo），用來驗證走雲端時不會去碰內建模型。
      if (msg.type === 'ma:provider') return window.__providerInfo;
      if (msg.type === 'ma:snapshot') return { ok: true, dir: '會議助手', saved: ['逐字稿.md', '畫面.png'] };
      // 側邊欄啟動時會讀設定，決定要不要自動開麥克風／本機辨識
      if (msg.type === 'ma:settings:get') {
        return { sttAuto: true, sttEngine: 'whisper-native', captureScreen: false };
      }
      // 側邊欄要先問背景哪個分頁是會議分頁，才能對它擷取音訊
      if (msg.type === 'ma:meetingTab') return { tabId: window.__meetingTabId ?? 77 };
      return { ok: true };
    },
    openOptionsPage: () => {},
  },
  tabs: { query: async () => [{ id: 1 }] },
  // getMediaStreamId 必須由側邊欄呼叫（使用者手勢不跨 sendMessage 傳到背景）
  tabCapture: {
    getMediaStreamId: async ({ targetTabId }) => {
      window.__capturedTab = targetTabId;
      if (window.__captureFails) throw new Error('Extension has not been invoked for the current page');
      return 'stream-id';
    },
  },
};
