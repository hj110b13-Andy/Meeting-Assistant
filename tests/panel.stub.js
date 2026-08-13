/** panel.js 執行前先安裝的 chrome API stub */

// 假的 Chrome 內建模型。真實的 LanguageModel.availability() 是對瀏覽器程序的
// 非同步呼叫，測試等不到，而且結果會隨機器狀態變動；換成假的才有確定性，
// 也才驗得到 promptStreaming → ma:local:delta 的串接。
self.LanguageModel = {
  availability: async () => 'available',
  create: async () => ({
    clone: async () => ({
      promptStreaming: async function* () { yield '這是'; yield '本機模型的回答。'; },
      destroy() {},
    }),
  }),
};
window.__ports = [];
window.__sent = [];
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
      // 讓側邊欄以為目前是免費模式，才能驗證徽章與「啟用免費模型」按鈕
      if (msg.type === 'ma:provider') {
        return { provider: 'chrome-ai', label: 'Chrome 內建模型（免費）', free: true,
                 supportsImages: false, needsPanel: true, panelReachable: true };
      }
      if (msg.type === 'ma:snapshot') return { ok: true, dir: '會議助手', saved: ['逐字稿.md', '畫面.png'] };
      // 側邊欄啟動時會讀設定，決定要不要自動開麥克風／本機辨識
      if (msg.type === 'ma:settings:get') {
        return { micAuto: true, sttAuto: true, sttEngine: 'whisper', captureScreen: false, deepgramKey: '' };
      }
      return { ok: true };
    },
    openOptionsPage: () => {},
  },
  tabs: { query: async () => [{ id: 1 }] },
};
