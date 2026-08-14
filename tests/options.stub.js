/**
 * 設定頁測試用的 chrome stub。
 *
 * 這裡刻意**接上真正的 settings.js 與 keys.js**（由 run.ps1 轉換後載入），
 * 而不是自己假裝儲存 —— 會出問題的正是「設定頁寫進去、下次讀回來」
 * 這條來回，只驗設定頁單邊等於什麼都沒驗。
 *
 * storage 是行程內的一個物件，模擬 chrome.storage.local 的持久性：
 * 「關掉再打開設定頁」在測試裡就是「再呼叫一次 load()」，storage 不清空。
 */
window.__storage = {};

window.chrome = {
  runtime: {
    lastError: undefined,
    id: 'test-extension-id',
    // 設定頁的每一次操作都是走 sendMessage 到 service worker。
    // 這裡把路由照抄一份，行為要跟 service-worker.js 的 case 一致。
    sendMessage: async (msg) => {
      switch (msg?.type) {
        case 'ma:settings:get':
          return getSettings();
        case 'ma:settings:set':
          return saveSettings(msg.patch);
        case 'ma:keys:get': {
          const keys = await getKeys();
          return {
            masked: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, maskKey(v)])),
            present: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, !!v])),
            mismatched: mismatchedKeys(keys),
          };
        }
        case 'ma:keys:set': {
          const next = await saveKeys(msg.patch || {});
          return { ok: true, mismatched: mismatchedKeys(next) };
        }
        case 'ma:keys:test': {
          const keys = await getKeys();
          const stored = { groq: keys.groq, nim: keys.nvidia, nim2: keys.nvidia2, tavily: keys.tavily };
          const key = String(msg.key || stored[msg.vendor] || '').trim();
          if (!key) return { ok: false, noKey: true, error: '還沒有金鑰' };
          window.__tested.push({ vendor: msg.vendor, key });
          return { ok: true, ms: 700, model: 'test-model' };
        }
        case 'ma:jitsi:sync':
          return { ok: true, granted: [] };
        case 'ma:stt:status':
          return { ok: true, installed: true, running: false, models: ['ggml-small-q5_1.bin'] };
        case 'ma:stt:stop':
          return { ok: true };
        default:
          return undefined;
      }
    },
  },
  storage: {
    local: {
      get: async (key) => (window.__storage[key] === undefined ? {} : { [key]: window.__storage[key] }),
      set: async (obj) => { Object.assign(window.__storage, obj); },
    },
  },
  permissions: { request: async () => true },
};

window.__tested = [];
