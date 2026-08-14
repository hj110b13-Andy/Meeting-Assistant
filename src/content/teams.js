/**
 * Microsoft Teams（網頁版）adapter
 *
 * Teams 的即時字幕視窗用 data-tid 標記，比 Meet 穩定得多。
 * 前提：會議中開啟「更多」→「語言和語音」→「開啟即時字幕」。
 * Teams 會把會議畫面放進 iframe，因此 manifest 對 Teams 使用 all_frames: true。
 */
(() => {
  const { CaptionEngine, heuristicRoot, clean, genericParse, speakingFrom } = globalThis.__MA_CORE__;

  // Teams 的 data-tid 是他們的測試 id 慣例，比 class 穩定得多 ——
  // 字幕那邊的選擇器也是靠它撐過好幾次改版的。
  const TEAMS_NAME_SELECTORS = [
    '[data-tid="participant-name"]',
    '[data-tid="roster-participant-name"]',
    '[id^="roster-avatar-img-"]',      // 名字在 alt／aria-label 上
    '[data-tid="calling-participant-name"]',
  ];

  // 由上而下試。最後一條是萬用比對：Teams 改版時字幕視窗的 data-tid 換過好幾次
  // （closed-caption-window → closed-caption-v2-window → …-wrapper），但那串前綴
  // 一直都在，所以留一條 *= 的網把未來的新名字也接住。
  const ROOT_SELECTORS = [
    '[data-tid="closed-caption-v2-window-wrapper"]',
    '[data-tid="closed-caption-v2-window"]',
    '[data-tid="closed-caption-window"]',
    '[data-tid="closed-caption-v2-virtual-list-content"]',
    '[data-tid="closed-captions-renderer"]',
    '[data-tid*="closed-caption"]',
  ];

  const ENTRY_SELECTORS = [
    '.fui-ChatMessageCompact',
    '.ui-chat__item',
    '[data-tid="closed-caption-message"]',
    '[data-caption-id]',
  ];

  const adapter = {
    platform: 'ms-teams',

    findRoot() {
      for (const sel of ROOT_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return heuristicRoot(/caption|字幕|subtitle/i);
    },

    entries(root) {
      for (const sel of ENTRY_SELECTORS) {
        const found = root.querySelectorAll(sel);
        if (found.length) return [...found];
      }
      const kids = [...root.children].filter((el) => clean(el.textContent));
      return kids.length ? kids : [root];
    },

    /**
     * Teams 的字幕清單是虛擬列表：捲動時同一個 DOM 節點會被回收去裝另一句話。
     * 它自己有 data-caption-id，直接拿來當 key 比用節點身分可靠得多。
     */
    stableKey(entry) {
      return entry.getAttribute?.('data-caption-id')
        || entry.closest?.('[data-caption-id]')?.getAttribute('data-caption-id')
        || '';
    },

    parse(entry) {
      const nameEl = entry.querySelector('[data-tid="author"], .fui-ChatMessageCompact__author, .ui-chat__messageheader__author');
      const textEl = entry.querySelector('[data-tid="closed-caption-text"], .fui-ChatMessageCompact__body, .ui-chat__messagecontent');
      if (!textEl) {
        const g = genericParse(entry);
        if (!g) return null;
        return { speaker: clean(nameEl?.textContent) || g.speaker, text: g.text };
      }
      return { speaker: clean(nameEl?.textContent), text: clean(textEl.textContent) };
    },

    participants() {
      const names = new Set();
      // 參與者清單的每一列是 [data-tid^="participantsInCall-"]，名字在頭像的 alt／aria-label
      document.querySelectorAll('[data-tid^="participantsInCall-"]').forEach((row) => {
        const avatar = row.querySelector('[id^="roster-avatar-img-"]');
        const n = clean(avatar?.getAttribute('alt') || avatar?.getAttribute('aria-label') || '');
        if (n && n.length < 40) names.add(n);
      });
      document.querySelectorAll('[data-tid="participant-name"], [data-tid="roster-participant-name"]')
        .forEach((el) => { const n = clean(el.textContent); if (n && n.length < 40) names.add(n); });
      return [...names];
    },

    /**
     * Teams 的發言指示器。
     *
     * Teams 在說話的人頭像外面畫一圈會動的音量環，並在參與者清單那一列
     * 標出發言狀態。這些狀態幾乎都掛在 data-tid 上，所以這裡列的是
     * data-tid 而不是 class —— 跟字幕那邊同一個理由。
     *
     * 全部沒中的話，core 的 SPEAKING_HINTS 會再掃一次屬性裡的 speaking 字樣。
     */
    speakingHints: [
      '[data-tid="voice-level-stream-outline"]',
      '[data-tid*="voice-level" i]',
      '[data-tid*="speaking" i]',
      '[data-tid="participant-speaking-indicator"]',
    ],

    activeSpeakers(engine) {
      return speakingFrom(engine, adapter, TEAMS_NAME_SELECTORS);
    },
  };

  const engine = new CaptionEngine(adapter);
  // 診斷用（在會議分頁的 console 跑 __MA_SPEAKER_DEBUG__()）
  globalThis.__MA_ENGINE__ = engine;
  engine.start();
})();
