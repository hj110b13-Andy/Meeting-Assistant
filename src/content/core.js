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
  const SPEAKING_SCAN_MS = 400;      // 掃描「誰在講話」的間隔
  const SPEAKING_HEARTBEAT_MS = 1500; // 同一個人持續講話時，多久回報一次

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
   * 「現在誰在講話」—— 從畫面上的發言指示器讀出來。
   *
   * ## 為什麼需要這條路
   *
   * 語音辨識完全不做說話者分離，姓名原本只能靠平台字幕。但字幕要**使用者
   * 自己在會議裡開啟**，而那一步很容易漏掉（也常常根本不想開）——
   * 於是整份逐字稿每一段都是「其他人」，這是實測後使用者第一個抱怨的事。
   *
   * 而 Meet／Teams／Jitsi 都會在畫面上標出正在說話的人（頭像外框、音量條、
   * 名牌高亮），**那個資訊不需要開字幕就存在**。讀它就等於免費多一個姓名來源。
   *
   * ## 為什麼用「屬性名稱裡有 speak」這種找法
   *
   * 這三家的 class name 都是編譯產生的雜湊，會整批換掉。但「發言中」這個狀態
   * 幾乎一定會在某個屬性上留下語意字樣 —— Teams 用 `data-tid`（他們的測試 id
   * 慣例，相當穩定），Meet／Jitsi 也常在 class 裡留 `speaking`／`dominant`。
   * 所以掃「屬性值裡含這些字樣」比寫死任何一組 class 都撐得久。
   *
   * ## 安全網：名字一定要對得上參與者名單
   *
   * 這種找法最危險的失敗模式是抓到介面文字（字幕選擇器就踩過這個坑：
   * 抓到 `arrow_drop_down` 當成說話者）。所以偵測出來的名字**必須出現在
   * 參與者名單裡**才採用。對不上就整個丟掉 —— 顯示「其他人」只是資訊不足，
   * 把話掛到錯的人身上會一路汙染摘要與回答建議，而且看起來完全正常。
   */
  const SPEAKING_HINTS = [
    // Teams 的 data-tid 是測試 id 慣例，比 class 穩定得多
    '[data-tid*="speaking" i]',
    '[data-tid*="voice-level" i]',
    // Meet／Jitsi／一般 SPA 常見的語意字樣
    '[class*="speaking" i]',
    '[class*="dominant" i]',
    '[class*="active-speaker" i]',
    '[data-is-speaking="true"]',
    '[aria-label*="正在說話"]',
    '[aria-label*="is speaking" i]',
  ];

  /** 從指示器往上找到「這一塊是誰」的名字。往上最多爬 6 層就放棄。 */
  function nameNear(el, nameOf) {
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const name = nameOf(node);
      if (name) return name;
      node = node.parentElement;
    }
    return '';
  }

  /**
   * 通用的發言者偵測。
   *
   * @param {(el: Element) => string} nameOf  從一個容器元素取出參與者名字
   * @param {string[]} extraHints             平台自己額外的指示器選擇器
   * @returns {{ names: string[], strategy: string }}
   */
  function detectSpeaking(nameOf, extraHints = []) {
    for (const sel of [...extraHints, ...SPEAKING_HINTS]) {
      let els;
      try { els = document.querySelectorAll(sel); } catch { continue; }
      if (!els.length) continue;
      const names = new Set();
      for (const el of els) {
        // 指示器常常一直存在，只用 CSS 顯示／隱藏 —— 看不見的不算在講話
        if (!isVisible(el)) continue;
        const n = nameNear(el, nameOf);
        if (n) names.add(n);
      }
      if (names.size) return { names: [...names], strategy: sel };
    }
    return { names: [], strategy: '' };
  }

  /**
   * 元素現在看得見嗎。
   *
   * 發言指示器有兩種做法，這裡要同時應付：
   *   1. **加／拿掉 class**（Jitsi 的 `.dominant-speaker` 就是這種）——
   *      元素存在就代表在講話，可見性其實不影響判斷。
   *   2. **永遠都在 DOM 裡，靠樣式切換顯示**（Meet／Teams 的音量條）——
   *      不看可見性的話會變成「每個人都一直在講話」，比抓不到更糟，
   *      因為它會把名字亂掛。
   *
   * **刻意不看寬高。** 一度用 `getBoundingClientRect()` 的 0×0 當「隱藏」，
   * 但指示器很可能是空元素、靠 `::before` 或背景圖顯示，那些在幾何上就是
   * 0×0 —— 於是變成永遠偵測不到，而且是安靜地偵測不到。
   * display／visibility／opacity 才是真的用來切換顯示的三個屬性。
   */
  function isVisible(el) {
    if (!el.isConnected) return false;
    if (typeof getComputedStyle !== 'function') return true;
    const s = getComputedStyle(el);
    if (!s) return true;
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (s.opacity !== '' && Number(s.opacity) === 0) return false;
    return true;
  }

  /** 這串文字像人名，不像介面文字或一整句話 */
  function looksLikeName(s) {
    const t = clean(s);
    if (!t || t.length > 40) return false;
    if (/^[a-z_]+$/.test(t)) return false;         // arrow_drop_down 這類圖示名稱
    if (/[。，、？！,.?!]/.test(t)) return false;   // 有標點的是句子，不是名字
    return true;
  }

  /**
   * 這個容器裡**唯一**的名字。有兩個以上就回空字串。
   *
   * 這是往上爬找名字時最重要的安全條件。指示器往上第三、四層很可能已經是
   * 「裝著所有人視訊磚的格線」—— 在那裡 querySelector 會回**第一個人**的名字，
   * 於是所有人講的話都被掛到畫面上第一個人頭上。而且那個結果看起來完全正常，
   * 只有當事人自己看得出不對。
   *
   * 「只有一個名字」等於「這一層就是某一個人的磚」，這個條件不依賴任何 class。
   */
  function soleName(el, selectors) {
    if (!el || typeof el.querySelectorAll !== 'function') return '';
    for (const sel of selectors) {
      let els;
      try { els = el.querySelectorAll(sel); } catch { continue; }
      if (els.length !== 1) continue;
      const node = els[0];
      const raw = node.getAttribute?.('alt') || node.getAttribute?.('aria-label') || node.textContent;
      const n = clean(raw);
      if (looksLikeName(n)) return n;
    }
    return '';
  }

  /**
   * 把偵測結果收斂成「可以採用的名字」。
   *
   * 兩道關卡，都是為了**寧可沒有名字，也不要掛錯人**：
   *
   *  1. **名字要對得上參與者名單。** 這種掃屬性的找法最容易抓到介面文字
   *     （字幕選擇器就踩過：把 `arrow_drop_down` 當成說話者）。
   *  2. **同時偵測到兩個人就整個丟掉。** 兩個人同時被判定在講話時沒有辦法
   *     知道這段音訊是誰的，硬選一個就是二分之一的機率掛錯。
   */
  function speakingFrom(engine, adapter, nameSelectors) {
    const nameOf = (el) => soleName(el, nameSelectors);
    const { names, strategy } = detectSpeaking(nameOf, adapter.speakingHints || []);
    engine.speakerStrategy = strategy;
    if (!names.length) return [];

    const roster = adapter.participants?.() || [];
    const ok = names.filter((n) => looksLikeName(n)
      // 名單讀不到時（參與者面板沒開、選擇器失效）就只靠 looksLikeName ——
      // 名字本來就是從那個人的磚上讀來的，不是憑空生出來的。
      && (!roster.length || roster.some((r) => r === n || r.includes(n) || n.includes(r))));
    return ok.length === 1 ? ok : [];
  }

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
      this.lastSpeaking = '';
      this.lastSpeakingSentAt = 0;
      this.speakerStrategy = '';
    }

    start() {
      this.timer = setInterval(() => this.enabled && this.scan(), SCAN_MS);
      this.statusTimer = setInterval(() => this.reportStatus(), 3000);
      // 發言指示器要掃得比字幕勤：一句話可能只有兩三秒，掃太慢會整段錯過，
      // 而錯過的後果是那段話拿不到名字（不是拿到錯的名字，所以是安全的）。
      this.speakingTimer = setInterval(() => this.enabled && this.pollSpeaking(), SPEAKING_SCAN_MS);
      this.reportStatus();
    }

    /**
     * 回報「現在誰在講話」。
     *
     * 兩種情況要送：**名單變了**（換人、開始講、停止講），
     * 以及**同一個人持續在講**時每隔一段時間送一次心跳 ——
     * 背景是用「時間區間」比對的，沒有心跳的話一句講了 30 秒的話
     * 只會留下一個 0 長度的區間，後面 28 秒的音訊全部對不上。
     */
    pollSpeaking() {
      if (!this.adapter.activeSpeakers) return;
      let names = [];
      try { names = this.adapter.activeSpeakers(this) || []; } catch { return; }

      const sig = names.join('|');
      const now = Date.now();
      if (sig === this.lastSpeaking && now - this.lastSpeakingSentAt < SPEAKING_HEARTBEAT_MS) return;
      // 沒人在講的時候不必一直送空的心跳，只在「剛從有人變成沒人」時送一次
      if (!names.length && !this.lastSpeaking) return;

      this.lastSpeaking = sig;
      this.lastSpeakingSentAt = now;
      this.send('ma:speaking', {
        names, at: now, platform: this.adapter.platform, sessionId: this.sessionId,
      });
    }

    statusPayload() {
      return {
        platform: this.adapter.platform,
        captionsFound: !!this.root && this.root.isConnected,
        title: document.title,
        url: location.href,
        sessionId: this.sessionId,
        participants: this.adapter.participants?.() || [],
        // 「發言指示器有沒有找到」是姓名功能唯一的線索。找不到時使用者只會
        // 看到每段都是「其他人」，而畫面上沒有任何東西指向原因 ——
        // 設定頁的診斷會把這個欄位印出來。
        speakerStrategy: this.speakerStrategy,
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

  globalThis.__MA_CORE__ = {
    CaptionEngine, mergeCaption, overlaps, genericParse, heuristicRoot, clean,
    detectSpeaking, looksLikeName, isVisible, soleName, speakingFrom,
  };

  /**
   * 在會議分頁的 console 裡跑 `__MA_SPEAKER_DEBUG__()`，印出發言指示器的偵測結果。
   *
   * 這個專案有一條硬教訓：**合成 DOM 的測試只能證明「選擇器與邏輯自洽」，
   * 不能證明真實的 DOM 長得跟合成的一樣。** 字幕選擇器就是這樣第一次寫錯的
   * （抓到 Meet 的介面文字而不是字幕）。發言指示器同樣沒有公開文件，
   * 所以留一個能在真實會議裡問「你到底看到什麼」的工具，
   * 下一輪修選擇器才是照著實際結果改，而不是繼續猜。
   */
  globalThis.__MA_SPEAKER_DEBUG__ = () => {
    const eng = globalThis.__MA_ENGINE__;
    const out = {
      platform: eng?.adapter?.platform || '(引擎沒有啟動)',
      參與者名單: eng?.adapter?.participants?.() || [],
      目前偵測到在講話: eng?.adapter?.activeSpeakers?.(eng) || [],
      命中的選擇器: eng?.speakerStrategy || '(沒有命中任何選擇器)',
      各選擇器的命中數: {},
    };
    for (const sel of [...(eng?.adapter?.speakingHints || []), ...SPEAKING_HINTS]) {
      let n = 0; let visible = 0;
      try {
        const els = document.querySelectorAll(sel);
        n = els.length;
        for (const el of els) if (isVisible(el)) visible++;
      } catch { n = -1; }
      if (n !== 0) out.各選擇器的命中數[sel] = `${n} 個（看得見 ${visible} 個）`;
    }
    console.log('[會議助手] 發言者偵測診斷', out);
    return out;
  };
})();
