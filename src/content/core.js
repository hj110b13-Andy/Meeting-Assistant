/**
 * 字幕擷取引擎（平台無關）
 *
 * 各平台的即時字幕都是「同一個 DOM 節點的文字持續被改寫」，而不是一行一行新增。
 * 因此引擎的核心是三件事：
 *   1. 找到字幕容器（平台 adapter 提供選擇器，找不到時退回啟發式搜尋）
 *   2. 把不斷改寫的文字合併成一段連續的話（mergeCaption）
 *   3. 判斷一段話何時「講完」→ 送出 final，寫進逐字稿
 */
(() => {
  if (globalThis.__MA_CORE__) return;

  const SCAN_MS = 300;        // 掃描字幕節點的間隔
  const FINALIZE_MS = 2200;   // 文字停止變動多久後視為講完
  const PARTIAL_MS = 250;     // 送出即時（未定稿）文字的節流間隔

  /**
   * 合併串流字幕。平台會做這些事：
   *  - 逐步加長：「你好」→「你好，我是」
   *  - 修正前段：「你好我是」→「你好，我是小陳」
   *  - 視窗滑動：長句只保留後半段
   * 這裡用「最長重疊」把新片段接到既有文字後面，避免重複或漏字。
   */
  function mergeCaption(prev, next) {
    if (!prev) return next;
    if (!next) return prev;
    if (next === prev) return prev;
    if (next.startsWith(prev)) return next;   // 單純加長
    if (prev.endsWith(next)) return prev;     // 舊的已包含
    if (prev.includes(next)) return prev;

    // 找 prev 尾端與 next 開頭的最長重疊
    const max = Math.min(prev.length, next.length);
    for (let k = max; k > 2; k--) {
      if (prev.endsWith(next.slice(0, k))) return prev + next.slice(k);
    }
    // 完全不重疊：視窗滑動或換句，直接接上
    return prev + (/[\s，。、？！]$/.test(prev) ? '' : ' ') + next;
  }

  /**
   * 兩段文字是否屬於同一句話的不同時間點（有重疊）。
   * 用來區分「同一句被改寫」與「這個節點被拿去裝下一句話」——
   * Teams 的字幕是虛擬列表，會重用 DOM 節點，兩者一定要分得開。
   */
  function overlaps(prev, next) {
    if (!prev || !next) return false;
    if (next.startsWith(prev) || prev.endsWith(next) || prev.includes(next)) return true;
    const max = Math.min(prev.length, next.length);
    for (let k = max; k > 2; k--) if (prev.endsWith(next.slice(0, k))) return true;
    return false;
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /**
   * 通用的「一則字幕」解析：適用於 [頭像][名字][內容] 這種結構。
   * 平台 adapter 若有精確選擇器會優先使用，這裡是版面改版後的保險。
   */
  function genericParse(entry) {
    const texts = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = clean(child.nodeValue);
          if (t) texts.push({ t, el: node });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const style = child.getAttribute?.('aria-hidden');
          if (style === 'true') continue;
          walk(child);
        }
      }
    };
    walk(entry);
    if (!texts.length) return null;
    if (texts.length === 1) return { speaker: '', text: texts[0].t };

    // 第一段短文字（且不是整句話）通常是說話者名稱
    const first = texts[0].t;
    const rest = texts.slice(1).map((x) => x.t).join(' ');
    if (first.length <= 40 && !/[。？！?]$/.test(first) && rest.length > 0) {
      return { speaker: first, text: rest };
    }
    return { speaker: '', text: texts.map((x) => x.t).join(' ') };
  }

  class CaptionEngine {
    /**
     * @param {object} adapter
     *   platform: string
     *   findRoot(): Element|null
     *   entries(root): Element[]
     *   parse(entry): {speaker, text}|null
     *   participants?(): string[]
     */
    constructor(adapter) {
      this.adapter = adapter;
      this.root = null;
      this.keys = new WeakMap();   // entry element -> segment key
      this.live = new Map();       // key -> {id, speaker, text, seen, changedAt, sentAt, startedAt}
      this.finalized = new Map();  // key -> 該節點最後一次定稿的 {id, text, speaker}
      this.counter = 0;
      this.utterances = 0;
      this.enabled = true;
      this.lastStatus = null;
      this.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    }

    start() {
      this.timer = setInterval(() => this.enabled && this.scan(), SCAN_MS);
      this.statusTimer = setInterval(() => this.reportStatus(), 3000);
      this.reportStatus();
    }

    statusPayload() {
      return {
        platform: this.adapter.platform,
        captionsFound: !!this.root && this.root.isConnected,
        title: document.title,
        url: location.href,
        sessionId: this.sessionId,
        participants: this.adapter.participants?.() || [],
      };
    }

    reportStatus() {
      if (!this.root || !this.root.isConnected) this.root = this.adapter.findRoot();
      const payload = this.statusPayload();
      const sig = JSON.stringify(payload);
      if (sig === this.lastStatus) return;
      this.lastStatus = sig;
      this.send('ma:status', payload);
    }

    send(type, payload) {
      try {
        chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
      } catch { /* 擴充功能重載時會拋錯，忽略 */ }
    }

    keyFor(entry) {
      // 平台若提供穩定 id 就優先用它。Teams 的字幕是虛擬列表，DOM 節點會被
      // 回收去裝別句話 —— 用節點本身當 key 得靠「文字有沒有重疊」去猜是不是
      // 同一句，而它有 data-caption-id 可以直接問，不必猜。
      const stable = this.adapter.stableKey?.(entry);
      if (stable) return `k:${stable}`;
      let k = this.keys.get(entry);
      if (!k) { k = `s${++this.counter}`; this.keys.set(entry, k); }
      return k;
    }

    scan() {
      if (!this.root || !this.root.isConnected) {
        this.root = this.adapter.findRoot();
        if (!this.root) { this.flushAll(); return; }
      }
      const now = Date.now();
      let entries = [];
      try { entries = this.adapter.entries(this.root) || []; } catch { entries = []; }

      for (const entry of entries) {
        let parsed = null;
        try { parsed = this.adapter.parse(entry) || genericParse(entry); } catch { parsed = genericParse(entry); }
        if (!parsed) continue;
        const text = clean(parsed.text);
        if (!text) continue;
        const speaker = clean(parsed.speaker) || '未標註';

        const key = this.keyFor(entry);
        let seg = this.live.get(key);

        // 同一個節點換人講話 → 舊的先定稿
        if (seg && seg.speaker !== speaker) { this.finalize(key); seg = null; }

        if (!seg) {
          // 這個節點先前定稿過嗎？文字有重疊且同一人 → 是同一句被重新掛上來，
          // 沿用原本的 id 繼續累積；否則是新的一句（節點被重用），給新 id。
          const prev = this.finalized.get(key);
          const continues = prev && prev.speaker === speaker && overlaps(prev.text, text);
          seg = {
            id: continues ? prev.id : `${this.sessionId}-${key}-${++this.utterances}`,
            speaker,
            text: continues ? mergeCaption(prev.text, text) : text,
            startedAt: now, changedAt: now, sentAt: 0, seen: now,
          };
          this.live.set(key, seg);
        } else {
          const merged = mergeCaption(seg.text, text);
          if (merged !== seg.text) { seg.text = merged; seg.changedAt = now; }
          seg.seen = now;
        }
      }

      // 送出即時文字 + 判斷定稿
      for (const [key, seg] of [...this.live]) {
        const gone = now - seg.seen > SCAN_MS * 3;
        if (gone || now - seg.changedAt > FINALIZE_MS) { this.finalize(key); continue; }
        if (now - seg.sentAt > PARTIAL_MS) {
          seg.sentAt = now;
          this.emit(seg, false);
        }
      }
    }

    finalize(key) {
      const seg = this.live.get(key);
      if (!seg) return;
      this.live.delete(key);
      if (seg.text.length < 2) return;
      this.finalized.set(key, { id: seg.id, text: seg.text, speaker: seg.speaker });
      this.emit(seg, true);
    }

    flushAll() {
      for (const key of [...this.live.keys()]) this.finalize(key);
    }

    emit(seg, final) {
      this.send('ma:segment', {
        id: seg.id,
        speaker: seg.speaker,
        text: seg.text,
        final,
        startedAt: seg.startedAt,
        ts: Date.now(),
        source: 'captions',
        platform: this.adapter.platform,
        sessionId: this.sessionId,
        title: document.title,
      });
    }
  }

  /**
   * 找不到已知選擇器時，用 aria 屬性猜字幕容器。
   *
   * **只接受 label 真的像字幕的元素。** 這裡曾經用「像字幕得 100 分 ＋ 文字長度
   * 最多 1 分」再取 score >= 1，結果是一個完全不像字幕、但文字夠長（>=400 字）的
   * 元素剛好得 1.0 分就被接受 —— 實測會抓到 Meet 的鍵盤快速鍵提示、Gemini 橫幅、
   * 「會議記錄器」這類介面文字，整份逐字稿都是同一句重複幾十次。
   *
   * 抓不到字幕時**回傳 null 讓上層明講「沒偵測到字幕」**，比拿介面文字充數好：
   * 錯的逐字稿會一路汙染摘要與回答建議，而且使用者看不出來是壞的。
   */
  function heuristicRoot(keywords = /caption|subtitle|字幕|транскр/i) {
    const cands = [
      ...document.querySelectorAll('[aria-live="polite"],[aria-live="assertive"],[role="region"],[role="log"]'),
    ];
    let best = null;
    for (const el of cands) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tid') || ''} ${el.className || ''}`;
      // 硬性條件，不是加分項：label 不像字幕就直接不考慮
      if (!keywords.test(label)) continue;
      const txt = clean(el.textContent);
      if (!txt || txt.length < 2) continue;
      // 都像字幕的話，取文字最多的那個（巢狀容器裡通常最外層才是完整面板）
      const score = Math.min(txt.length, 400) / 400;
      if (!best || score > best.score) best = { el, score };
    }
    return best ? best.el : null;
  }

  globalThis.__MA_CORE__ = { CaptionEngine, mergeCaption, overlaps, genericParse, heuristicRoot, clean };
})();
