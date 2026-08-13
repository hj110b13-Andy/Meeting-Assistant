/**
 * Jitsi Meet adapter
 *
 * 這支的選擇器不是猜的：直接讀 meet.jit.si 的 app.bundle.min.js（v9365）
 * 找出字幕元件實際產生的 DOM。結論是 Jitsi 有兩個地方顯示字幕，結構完全不同：
 *
 * A. 聊天面板的「字幕」分頁 —— 資料最完整（有姓名和時間），而且有穩定的 DOM id：
 *
 *      <div id="subtitles-messages-container">
 *        <div id="subtitles-messages-list">
 *          <div class="{groupContainer}">          ← 同一位說話者一組
 *            <Avatar/>
 *            <div class="{messagesContainer}">
 *              <div class="{messageContainer} {interim?}">
 *                <div class="{messageContent}">
 *                  <div class="{messageHeader}">顯示名稱</div>  ← 只有整組第一則有
 *                  <div class="{messageText}">內容</div>
 *                  <div class="{timestamp}">上午11:19:29</div>
 *
 *    兩個關鍵陷阱：**姓名只出現在每組第一則**（第二則之後要從同組繼承），
 *    而且**每則都帶一個時間戳元素**（不排除的話會被當成字幕內容的一部分）。
 *
 * B. 舞台上疊著的那層字幕：<div class="{transcriptionSubtitles}"><p><span>文字</span></p>
 *    資料較少（姓名夾在文字裡，用「名字: 內容」格式），而且沒有姓名元素。
 *
 * class name 全部是 tss/emotion 產生的雜湊，**不能拿來當選擇器**，所以 A 走 DOM id、
 * 再靠結構（最後一個子元素是時間）辨識訊息節點；B 靠結構（子元素都是 p > span）找容器。
 * 這樣 Jitsi 改版換樣式也不會壞。
 *
 * 前提：使用者要在會議中開啟字幕（工具列「⋯」→ 字幕／Subtitles）。
 * 字幕本身由部署端的 Jigasi 轉錄服務提供，沒裝就沒有字幕可抓。
 */
(() => {
  const { CaptionEngine, heuristicRoot, clean, genericParse } = globalThis.__MA_CORE__;

  // 聊天面板字幕分頁的容器（實際存在於 bundle 裡的 id，不是猜的）
  const LIST_SELECTORS = ['#subtitles-messages-list', '#subtitles-messages-container'];

  // 舊版／自架版可能還在用語意化 class；新版是雜湊 class，這些只是保險
  const LEGACY_SELECTORS = [
    '.transcription-subtitles',
    '#transcription-subtitles',
    '.subtitles-container',
    '[class*="transcriptionSubtitles"]',
  ];

  // 時間戳：Chrome 的 toLocaleTimeString() 在 zh-TW 會給「上午11:19:29」，
  // 英文語系是「11:19:29 AM」，兩種都要認得出來才能把它從內容裡排除。
  const TIME_RE = /^(上午|下午|午前|午後|AM|PM)?\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s*(AM|PM)?$/i;

  /** 這個元素是不是一則字幕的內容區（[姓名?][內容][時間]） */
  function isMessageContent(el) {
    const kids = [...el.children];
    if (kids.length < 2 || kids.length > 3) return false;
    if (!kids.every((k) => k.tagName === 'DIV' && !k.children.length)) return false;
    return TIME_RE.test(clean(kids[kids.length - 1].textContent));
  }

  /** 找到 el 所屬的「說話者分組」＝ root 的直接子元素 */
  function groupOf(el, root) {
    let n = el;
    while (n && n.parentElement && n.parentElement !== root) n = n.parentElement;
    return n && n.parentElement === root ? n : null;
  }

  /** 同一組裡第一則訊息才有姓名，往回找 */
  function inheritedSpeaker(entry, root) {
    const group = groupOf(entry, root);
    if (!group) return '';
    for (const el of group.querySelectorAll('*')) {
      if (isMessageContent(el) && el.children.length === 3) {
        return clean(el.children[0].textContent);
      }
    }
    return '';
  }

  /** 舞台字幕容器：子元素都是 <p>，而且 p 裡面只有 span */
  function findStageRoot() {
    for (const div of document.querySelectorAll('div')) {
      const kids = [...div.children];
      if (kids.length < 1 || kids.length > 6) continue;
      if (!kids.every((k) => k.tagName === 'P')) continue;
      if (!clean(div.textContent)) continue;
      return div;
    }
    return null;
  }

  /**
   * 從「名字: 內容」切出說話者（只有舞台字幕會用到）。
   *
   * Jitsi 的格式是 `${displayName}: ${text}`，**冒號後面一定有空白** ——
   * 這是最可靠的判準。光看「有沒有冒號」會把句子裡的時間碼切壞
   * （「時間是 14:30」會變成說話者「時間是 14」、內容「30」）。
   *
   * 另外三道防呆是給「這個版面其實沒有名字前綴」的情況：前綴含句中標點、
   * 太長、或純數字時都當成整句話 —— 寧可標「未標註」，也不要編出一個不存在的人。
   */
  function splitSpeaker(raw) {
    const at = raw.search(/[:：]/);
    if (at <= 0) return { speaker: '', text: raw };
    if (!/^\s/.test(raw.slice(at + 1))) return { speaker: '', text: raw };

    const name = clean(raw.slice(0, at));
    const rest = clean(raw.slice(at + 1));
    if (!rest) return { speaker: '', text: raw };
    if (name.length > 30) return { speaker: '', text: raw };
    if (/[。．.？?！!，,、；;]/.test(name)) return { speaker: '', text: raw };
    if (/^[\d\s:：]+$/.test(name)) return { speaker: '', text: raw };

    return { speaker: name, text: rest };
  }

  const adapter = {
    platform: 'jitsi',

    findRoot() {
      // 聊天面板的字幕分頁優先：它有姓名和時間，資料品質最好
      for (const sel of LIST_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && clean(el.textContent)) { this.mode = 'list'; return el; }
      }
      for (const sel of LEGACY_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && clean(el.textContent)) { this.mode = 'stage'; return el; }
      }
      const stage = findStageRoot();
      if (stage) { this.mode = 'stage'; return stage; }

      const h = heuristicRoot(/subtitle|caption|transcription|字幕/i);
      if (h) { this.mode = 'stage'; return h; }
      return null;
    },

    entries(root) {
      if (this.mode === 'list') {
        return [...root.querySelectorAll('*')].filter(isMessageContent);
      }
      const ps = root.querySelectorAll('p');
      if (ps.length) return [...ps];
      const kids = [...root.children].filter((el) => clean(el.textContent));
      return kids.length ? kids : [root];
    },

    parse(entry) {
      if (this.mode === 'list') {
        const kids = [...entry.children];
        // 最後一個子元素是時間戳，一定要排除，否則會被當成字幕內容
        const hasName = kids.length === 3;
        const text = clean(kids[hasName ? 1 : 0].textContent);
        if (!text) return null;
        const speaker = hasName
          ? clean(kids[0].textContent)
          : inheritedSpeaker(entry, this.root);
        return { speaker, text };
      }

      const g = genericParse(entry);
      if (!g) return null;
      if (g.speaker) return g;
      return splitSpeaker(clean(g.text));
    },

    participants() {
      const names = new Set();
      document.querySelectorAll('.displayname, [id^="participant_"] .displayname, span[id$="_name"]')
        .forEach((el) => { const n = clean(el.textContent); if (n && n.length < 40) names.add(n); });
      return [...names];
    },
  };

  const engine = new CaptionEngine(adapter);
  // parse() 需要知道目前的 root 才能往上找同組的姓名
  adapter.root = null;
  const origScan = engine.scan.bind(engine);
  engine.scan = function scan() { adapter.root = this.root; return origScan(); };
  engine.start();
})();
