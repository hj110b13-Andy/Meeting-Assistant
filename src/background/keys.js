/**
 * 雲端服務的 API 金鑰。
 *
 * ## 為什麼跟 settings 分開存
 *
 * 金鑰的敏感度跟其他設定完全不同。分開一個 storage entry 有兩個好處：
 * 匯出／備份設定時不會順手把金鑰一起帶出去，而且以後要「清掉所有金鑰」
 * 只是刪一個 key，不必逐欄位挑。
 *
 * ## 為什麼不寫在程式碼裡
 *
 * 這個 repo 是**公開**的。金鑰只要進過版控就等於外洩 —— 就算之後用 commit
 * 刪掉，GitHub 仍保留該 blob，而且掃描機器人通常在幾分鐘內就會撿走。
 * 所以金鑰只存在每台機器自己的 chrome.storage.local，由設定頁貼進去，
 * 換一台電腦就要重貼一次（README 的「換一台電腦」有寫）。
 *
 * ## NVIDIA 為什麼可以放多把
 *
 * NIM 的免費額度是**綁帳號**的，所以多個帳號的金鑰可以輪流用，
 * 把「單一帳號撞到上限」的機率往後推。輪替邏輯在 cloud.js。
 */

const STORAGE_KEY = 'cloudKeys';

export const EMPTY_KEYS = {
  groq: '',        // GroqCloud：語音辨識與對話都靠它，是主力
  nvidia: '',      // NVIDIA NIM 帳號 1
  nvidia2: '',     // NVIDIA NIM 帳號 2（可留空）
  tavily: '',      // Tavily 網路查證（可留空，沒有就跳過查證）
};

/**
 * 金鑰的長相。用來擋「貼錯欄位」這個很常見又很難查的錯誤 ——
 * 把 Groq 的金鑰貼到 NVIDIA 欄位，症狀是 401，而 401 看起來像「金鑰過期」，
 * 使用者會跑去重新簽發一把新的，然後再貼錯一次。
 */
export const KEY_SHAPES = {
  groq:    { prefix: 'gsk_',   label: 'GroqCloud' },
  nvidia:  { prefix: 'nvapi-', label: 'NVIDIA NIM' },
  nvidia2: { prefix: 'nvapi-', label: 'NVIDIA NIM（帳號 2）' },
  tavily:  { prefix: 'tvly-',  label: 'Tavily' },
};

/** 回傳哪些欄位的內容跟預期的字首對不起來（空字串不算錯，代表沒填）。 */
export function mismatchedKeys(keys) {
  return Object.entries(KEY_SHAPES)
    .filter(([field, shape]) => {
      const v = String(keys?.[field] || '').trim();
      return v && !v.startsWith(shape.prefix);
    })
    .map(([field, shape]) => ({ field, label: shape.label, prefix: shape.prefix }));
}

export async function getKeys() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const keys = { ...EMPTY_KEYS, ...(stored[STORAGE_KEY] || {}) };
  // 使用者常常連同前後空白一起貼進來，而空白會讓 Authorization 標頭直接失效。
  for (const k of Object.keys(keys)) keys[k] = String(keys[k] || '').trim();
  return keys;
}

export async function saveKeys(patch) {
  const current = await getKeys();
  const next = { ...current, ...patch };
  for (const k of Object.keys(next)) next[k] = String(next[k] || '').trim();
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** 有沒有可用的雲端金鑰。沒有的話整條雲端路線都要退回本機。 */
export function hasCloud(keys) {
  return !!(keys.groq || keys.nvidia || keys.nvidia2);
}

/**
 * 給 UI 顯示用的遮罩。**永遠不要把完整金鑰送回畫面上** ——
 * 側邊欄與設定頁的內容會出現在截圖、螢幕分享與錄影裡，
 * 而這個擴充功能的使用情境正好就是「開會時在分享畫面」。
 */
export function maskKey(value) {
  const v = String(value || '').trim();
  if (!v) return '（未設定）';
  if (v.length <= 12) return `${v.slice(0, 4)}…`;
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
}
