/**
 * 簡體 → 繁體（台灣用字）轉換
 *
 * 為什麼需要：本機原生辨識用的 whisper small 模型中文明顯比 base 準
 * （實測「這季／結帳／對帳／小陳」base 全錯、small 全對），但它輸出簡體。
 *
 * 為什麼不用 initial prompt 解決：試過了，而且是**負面**的。用繁體 prompt
 * 引導時輸出確實變繁體，但同一段音檔的「對帳」會變成「對戰」或「對象」——
 * 換到腳本正確、內容錯誤，不划算。所以改成：辨識時不給 prompt（讓模型
 * 專心聽），輸出後在這裡做確定性的字表轉換。
 *
 * 對照表在 s2t-table.js（由 tools/gen-s2t.ps1 從 OpenCC 字典產生）。
 * 傳統腳本，不是 module —— offscreen 文件是傳統腳本，這樣兩邊都能直接用。
 */

(() => {
  const data = globalThis.S2T_DATA;
  if (!data) return;

  const charMap = new Map();
  for (let i = 0; i < data.from.length; i++) charMap.set(data.from[i], data.to[i]);

  const phraseMap = new Map();
  // 只有「可能是詞組開頭」的字才需要跑最長匹配。少了這個判斷，每個字都要
  // 試 12 次查表；有了它，絕大多數字（標點、數字、英文、非詞組首字）直接跳過。
  const phraseHeads = new Set();
  if (data.phrases) {
    for (const entry of data.phrases.split('|')) {
      const at = entry.indexOf('=');
      if (at <= 0) continue;
      const key = entry.slice(0, at);
      phraseMap.set(key, entry.slice(at + 1));
      phraseHeads.add(key[0]);
    }
  }

  /**
   * 轉換一段文字。對已經是繁體的文字幾乎是無動作（表裡只有簡體字與
   * 非台灣字形），所以字幕來源誤用也不會壞掉。
   */
  function toTraditional(text) {
    if (!text) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (phraseHeads.has(ch)) {
        const limit = Math.min(data.maxPhrase, text.length - i);
        let matched = 0;
        for (let len = limit; len >= 1; len--) {
          const hit = phraseMap.get(text.substr(i, len));
          if (hit !== undefined) { out += hit; matched = len; break; }
        }
        if (matched) { i += matched; continue; }
      }
      out += charMap.get(ch) ?? ch;
      i += 1;
    }
    return out;
  }

  globalThis.toTraditional = toTraditional;
  globalThis.__s2tStats = () => ({ chars: charMap.size, phrases: phraseMap.size, maxPhrase: data.maxPhrase });
})();
