/**
 * Tavily 網路查證。
 *
 * ## 為什麼不是每題都查
 *
 * 會議裡被點名時，絕大多數問題問的是**這場會議自己的內容**——「剛剛那個數字
 * 是多少」、「你覺得這個做法可行嗎」。這類問題的答案在逐字稿裡，去查網路
 * 不但沒有幫助，還會多花 1–2 秒，而那 1–2 秒正是這個功能的全部價值。
 *
 * 所以只有在問題明顯需要**外部、時效性、可查證**的事實時才呼叫（見 needsSearch）。
 * 判斷用關鍵詞而不是再叫一次模型：多叫一次模型就多一次來回，
 * 那正好抵銷掉查證省下來的時間。
 *
 * ## 額度
 *
 * Tavily 免費方案是每月固定的查詢點數，不需信用卡、用完就是被拒。
 * 因為只在需要時才查，一場會議通常只會用掉個位數。
 */

import { getKeys } from './keys.js';

const SEARCH_URL = 'https://api.tavily.com/search';

/**
 * 這個問題需要查網路嗎？
 *
 * 抓的是「指向會議之外」的訊號：時效性的詞（最新、今年、目前）、
 * 明顯的外部實體（法規、匯率、競品），以及直接要求查證的說法。
 *
 * 刻意保守 —— 誤判成「要查」的代價是慢 1–2 秒，
 * 誤判成「不用查」的代價只是答案少了外部佐證，後者輕得多。
 */
const EXTERNAL_HINTS = [
  /最新|近期|目前|現在|今年|去年|明年|這個月|上個月/,
  /法規|法令|規定|條例|稅|勞基法|個資法|GDPR/i,
  /匯率|股價|利率|油價|市場行情/,
  /競品|競爭對手|同業|業界|市佔|市占/,
  /查一下|查證|搜尋|找資料|有沒有資料|最新消息/,
  /新聞|報導|發布|公告/,
];

export function needsSearch(question) {
  const q = String(question || '').trim();
  if (q.length < 4) return false;
  return EXTERNAL_HINTS.some((re) => re.test(q));
}

/**
 * 查一次。回傳 { ok, results, answer }。
 *
 * **失敗一律不擋住回答。** 查證只是加分，查不到就照原本的逐字稿回答 ——
 * 為了一個附加功能讓主要功能整個失敗是划不來的，所以這裡的錯誤
 * 只會被記下來，不會往上丟。
 */
export async function searchWeb(question, { maxResults = 3, timeoutMs = 6000 } = {}) {
  const keys = await getKeys();
  if (!keys.tavily) return { ok: false, error: '沒有 Tavily 金鑰', results: [] };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keys.tavily}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: question,
        max_results: maxResults,
        // 讓 Tavily 直接給一句摘要，省掉我們再叫一次模型整理
        include_answer: true,
        search_depth: 'basic',
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `Tavily 回應 ${res.status}`, results: [] };
    }
    const json = await res.json();
    return {
      ok: true,
      answer: String(json.answer || ''),
      results: (json.results || []).slice(0, maxResults).map((r) => ({
        title: String(r.title || ''),
        url: String(r.url || ''),
        content: String(r.content || '').slice(0, 400),
      })),
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '查證逾時' : String(err.message || err);
    return { ok: false, error: msg, results: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把查證結果整理成可以塞進提示詞的一段文字。
 * 附網址是刻意的 —— 回答建議是要照唸出去的，講出來源才站得住腳。
 */
export function formatForPrompt(found) {
  if (!found?.ok || (!found.answer && !found.results?.length)) return '';
  const lines = ['【網路查證結果，僅供參考，請自行判斷可信度】'];
  if (found.answer) lines.push(`摘要：${found.answer}`);
  for (const r of found.results || []) {
    lines.push(`- ${r.title}（${r.url}）：${r.content}`);
  }
  return lines.join('\n');
}

/** 設定頁的「測試」按鈕用。 */
export async function testTavily(key) {
  if (!key) return { ok: false, error: '沒有填金鑰' };
  const started = Date.now();
  try {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '台灣 台北 天氣', max_results: 1 }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const json = await res.json();
    return { ok: true, ms: Date.now() - started, count: (json.results || []).length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
