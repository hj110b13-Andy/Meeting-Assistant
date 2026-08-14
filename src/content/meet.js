/**
 * Google Meet adapter
 *
 * Meet 的字幕 DOM 每隔幾個月就會改一次 class name，所以這裡列出多組已知選擇器，
 * 全部失效時退回 core.js 的啟發式搜尋（靠 aria-label 含「字幕 / captions」判斷）。
 * 前提：使用者需在會議中開啟字幕（右下角「⋮」→「開啟字幕」／CC 按鈕）。
 */
(() => {
  const { CaptionEngine, heuristicRoot, clean, genericParse, speakingFrom } = globalThis.__MA_CORE__;

  // 名牌的位置。`[data-self-name]` 是自己的磚，另外兩個是別人的 ——
  // 全部是雜湊 class，所以 soleName 才會用「這一層只有一個名字」當條件，
  // 而不是相信任何一個名字。
  const MEET_NAME_SELECTORS = ['[data-self-name]', 'div.zWGUib', 'div.dwSJ2e', '[class*="zWGUib"]'];

  // 語意選擇器排最前面。Meet 的 class name（.a4cQT、.nMcdL、.NWpY1d…）是編譯產生的，
  // 每隔幾個月就整批換掉；但字幕面板一直是個帶 aria-label 的 role="region"，
  // 因為那是無障礙需求，Google 不會為了改版把它拿掉。
  // 雜湊 class 留在後面當補強，不當主力。
  const ROOT_SELECTORS = [
    '[role="region"][aria-label*="Captions" i]',
    '[role="region"][aria-label*="字幕"]',
    'div[jsname="dsyhDe"]',
    'div.a4cQT',
    'div[jscontroller="KPn5nb"]',
    'div[aria-label*="字幕"]',
    'div[aria-label*="Captions" i]',
  ];

  const ENTRY_SELECTORS = [
    'div.nMcdL',           // 現行版本：每則字幕一個 block
    'div.bj4p3b',
    'div.TBMuR',
  ];

  const NAME_SELECTORS = ['div.NWpY1d', 'span.NWpY1d', 'div.zs7s8d', 'div.jxFHg', '[class*="NWpY1d"]'];
  // .ygicle.VbkSUe 是現行版本放字幕文字的元素（不是一則字幕的容器，別放進 ENTRY）
  const TEXT_SELECTORS = [
    'div[jsname="tgaKEf"]',
    'div.ygicle.VbkSUe',
    'div.ygicle',
    'div.iTTPOb',
    'div.VbkSUe',
    '[jsname="tgaKEf"]',
  ];

  /**
   * 結構化的最後退路：所有已知 class 都失效時，靠「一則字幕長什麼樣」來拆。
   * Meet 的每一則是：頭像 <img> ＋ 說話者（第一個 <span>）＋ 內容（最後一個非圖片 <div>）。
   * 這不依賴任何會被改版換掉的名字。
   */
  function structuralParse(entry) {
    const span = entry.querySelector('span');
    const speaker = clean(span?.textContent);
    const divs = [...entry.querySelectorAll('div')]
      .filter((d) => !d.querySelector('img') && clean(d.textContent));
    const text = clean(divs.length ? divs[divs.length - 1].textContent : '');
    if (!text || text === speaker) return null;
    return { speaker, text };
  }

  const adapter = {
    platform: 'google-meet',

    findRoot() {
      for (const sel of ROOT_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && clean(el.textContent)) return el;
      }
      // 有些版本字幕在一個沒有識別特徵的 div，但父層 region 帶 aria-label
      return heuristicRoot(/字幕|caption|subtitle/i);
    },

    entries(root) {
      for (const sel of ENTRY_SELECTORS) {
        const found = root.querySelectorAll(sel);
        if (found.length) return [...found];
      }
      // 退回：把 root 的直接子元素當成一則一則字幕
      const kids = [...root.children].filter((el) => clean(el.textContent));
      return kids.length ? kids : [root];
    },

    parse(entry) {
      let speaker = '';
      for (const sel of NAME_SELECTORS) {
        const el = entry.querySelector(sel);
        if (el) { speaker = clean(el.textContent); break; }
      }
      let text = '';
      for (const sel of TEXT_SELECTORS) {
        const els = entry.querySelectorAll(sel);
        if (els.length) { text = clean([...els].map((e) => e.textContent).join(' ')); break; }
      }
      if (!text) {
        // 先試結構化解析（不依賴 class name），再退到 core 的通用解析
        const s = structuralParse(entry);
        if (s) return { speaker: speaker || s.speaker, text: s.text };
        const g = genericParse(entry);
        if (!g) return null;
        return { speaker: speaker || g.speaker, text: g.text };
      }
      return { speaker, text };
    },

    /** 從參與者面板／視訊磚抓名字，用來校正說話者標註與偵測「有人叫我」 */
    participants() {
      const names = new Set();
      document.querySelectorAll('[data-participant-id] [data-self-name], div.zWGUib, div.dwSJ2e')
        .forEach((el) => { const n = clean(el.textContent); if (n && n.length < 40) names.add(n); });
      return [...names];
    },

    /**
     * Meet 的發言指示器。
     *
     * Meet 在說話者的視訊磚上顯示一組會跳動的音量條。那個元素**一直存在**，
     * 只是靠樣式切換顯示 —— 所以 detectSpeaking 一定要看可見性，
     * 否則會變成「每個人都一直在講話」，比抓不到更糟。
     *
     * 這幾個雜湊 class 是現行版本的，會被改版換掉；換掉之後 core 的
     * SPEAKING_HINTS（掃屬性值裡的 speaking／dominant 字樣）還會接著試。
     * 兩層都失效就是拿不到名字 —— 逐字稿照常，只是顯示「其他人」。
     */
    speakingHints: [
      'div.IisKdb',            // 音量條（現行版本）
      'div[jsname="A5il2e"]',
      '[class*="IisKdb"]',
    ],

    activeSpeakers(engine) {
      return speakingFrom(engine, adapter, MEET_NAME_SELECTORS);
    },
  };

  const engine = new CaptionEngine(adapter);
  // 診斷用（在會議分頁的 console 跑 __MA_SPEAKER_DEBUG__()）
  globalThis.__MA_ENGINE__ = engine;
  engine.start();
})();
