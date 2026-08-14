/** panel.js 載入後執行：餵一份逼真的 state 進去，檢查 UI 真的長出來 */
(async () => {
  // 讓已排入的 microtask 跑完（stub 都是同步 resolve，不會拖到 load 事件之後）
  const tick = () => Promise.resolve();
  const results = [];
  const check = (name, cond, extra = '') =>
    results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  →  ' + extra}`);

  // 整段包在 try 裡：沒有它的話，中途一個例外（例如讀到 undefined 的屬性）
  // 會讓 #testout 根本不會被建立，runner 只看得到「沒有測試輸出」——
  // 那句話完全不指向真正的原因，而且已經完成的結果也一起消失。
  try {

  const port = window.__ports[0];
  check('panel.js 建立了與背景的連線', !!port && port.name === 'ma-panel', port ? port.name : '沒有 port');
  check('panel.js 註冊了訊息監聽器', !!port && port.listeners.length === 1,
    port ? `${port.listeners.length} 個` : '—');

  const emit = (type, payload) => port.listeners.forEach((fn) => fn({ type, payload }));
  const now = Date.now();

  emit('state', {
    meeting: { sessionId: 's1', platform: 'google-meet', title: '產品週會', url: 'https://meet.google.com/x', startedAt: now },
    // 音訊優先：正常運作中的會議是「正在聽聲音」，字幕只是額外提供姓名
    status: { captionsFound: true, platform: 'google-meet', audioFallback: true },
    segments: [
      { id: 'A', speaker: '王小明', text: '我們先看金流的部分', ts: now, source: 'captions' },
      { id: 'B', speaker: '李美華', text: '結帳失敗率上週是 2.3%', ts: now, source: 'captions' },
      { id: 'C', speaker: '我（麥克風）', text: '我這邊在等第三方對帳 API', ts: now, source: 'me' },
    ],
    partials: [{ id: 'D', speaker: '王小明', text: '那我們下一步' }],
    summary: {
      topics: ['金流', '結帳失敗率'],
      summary: ['檢視金流結帳失敗率', '失敗率上週 2.3%'],
      decisions: ['先處理第三方對帳'],
      actions: [{ owner: '王小明', task: '追第三方 API 開通進度' }],
      open_questions: ['對帳 API 何時開通'],
      updatedAt: now,
    },
    answers: [{ id: 'a1', question: '你那邊進度如何？', asker: '李美華', answer: '對帳 API 還在等開通，預計 8/20。\n・已完成串接程式碼\n・卡在對方帳號審核', ts: now, streaming: false, manual: false }],
  });

  const txt = (sel) => (document.querySelector(sel)?.textContent || '');

  // 逐字稿
  check('狀態列顯示會議標題', txt('#meetingTitle').includes('產品週會'), txt('#meetingTitle'));
  check('狀態列顯示正在聆聽', txt('#statusText').includes('聆聽中'), txt('#statusText'));
  check('狀態燈為 live', document.querySelector('#statusDot').className.includes('live'),
    document.querySelector('#statusDot').className);
  check('逐字稿渲染出三段', document.querySelectorAll('#transcript .seg').length === 3,
    `${document.querySelectorAll('#transcript .seg').length} 段`);
  check('說話者姓名有出現', txt('#transcript').includes('李美華'));
  check('說話者有上色', !!document.querySelector('#transcript .who')?.style.color,
    document.querySelector('#transcript .who')?.style.color || '沒有顏色');
  check('自己的發言有標記 class', document.querySelectorAll('#transcript .seg.me').length === 1);
  check('未定稿文字顯示在下方', !document.querySelector('#partial').classList.contains('hidden')
    && txt('#partial').includes('那我們下一步'), txt('#partial'));

  // 搜尋高亮
  document.querySelector('#search').value = '失敗率';
  document.querySelector('#search').dispatchEvent(new Event('input'));
  check('搜尋只留下符合的段落', document.querySelectorAll('#transcript .seg').length === 1,
    `${document.querySelectorAll('#transcript .seg').length} 段`);
  check('搜尋關鍵字有高亮', document.querySelectorAll('#transcript mark').length === 1,
    `${document.querySelectorAll('#transcript mark').length} 個 mark`);
  document.querySelector('#search').value = '';
  document.querySelector('#search').dispatchEvent(new Event('input'));

  // 重點
  check('重點：主題 chip 有渲染', document.querySelectorAll('#insights .chip').length === 2,
    `${document.querySelectorAll('#insights .chip').length} 個`);
  check('重點：摘要條目有渲染', txt('#insights').includes('失敗率上週 2.3%'));
  check('重點：待辦含負責人', txt('#insights .action .owner').includes('王小明'), txt('#insights .action .owner'));
  check('重點：未解問題有渲染', txt('#insights').includes('對帳 API 何時開通'));

  // 問答
  check('問答：卡片有渲染', document.querySelectorAll('#answers .qa').length === 1);
  check('問答：顯示提問者', txt('#answers .q').includes('李美華'), txt('#answers .q'));
  check('問答：第一行是可照唸的答案', txt('#answers .a .lead').includes('對帳 API 還在等開通'),
    txt('#answers .a .lead'));

  // 串流增量更新
  emit('answer', { id: 'a2', question: '預算呢？', asker: '王小明', answer: '', ts: now, streaming: true, manual: false });
  emit('answerDelta', { id: 'a2', chunk: '預算還有' });
  emit('answerDelta', { id: 'a2', chunk: '兩成沒動用。' });
  const a2 = document.querySelector('.qa[data-id="a2"] .a');
  check('串流增量累積在同一張卡片', a2 && a2.textContent.includes('預算還有兩成沒動用。'),
    a2 ? a2.textContent : '找不到卡片');
  check('串流中顯示等待指示', !!document.querySelector('.qa[data-id="a2"] .spinner'));
  emit('answerDone', { id: 'a2', answer: '預算還有兩成沒動用。' });
  check('串流結束後移除等待指示', !document.querySelector('.qa[data-id="a2"] .spinner'));

  // 新逐字稿段落即時追加
  emit('segment', { id: 'E', speaker: '陳大文', text: '我補一個數字', ts: now, source: 'captions' });
  check('新段落即時追加', txt('#transcript').includes('我補一個數字'));

  // 分頁未讀數
  check('未讀徽章有數字', !document.querySelector('#badgeQa').classList.contains('hidden'),
    document.querySelector('#badgeQa').textContent);

  // 分頁切換
  document.querySelector('.tabs button[data-tab="insights"]').click();
  check('切到重點分頁', document.querySelector('#tab-insights').classList.contains('active'));
  check('切換後清掉該分頁未讀', document.querySelector('#badgeInsights').classList.contains('hidden'));

  // 錯誤橫幅
  emit('error', { message: 'API 金鑰無效' });
  check('錯誤橫幅顯示訊息', !document.querySelector('#banner').classList.contains('hidden')
    && txt('#banner').includes('API 金鑰無效'), txt('#banner'));

  // 狀態列以「有沒有在聽聲音」為主，不再以字幕為主
  emit('status', { captionsFound: false, platform: 'google-meet', audioFallback: true });
  check('聆聽中時狀態列說「聆聽中」', txt('#statusText').includes('聆聽中'), txt('#statusText'));
  check('聆聽中時狀態燈是綠的',
    document.querySelector('#statusDot').classList.contains('live'));
  check('沒字幕不再被當成錯誤（字幕只提供姓名）',
    !txt('#statusText').includes('找不到字幕'), txt('#statusText'));

  // 有字幕時會註明姓名來源
  emit('status', { captionsFound: true, platform: 'google-meet', audioFallback: true });
  check('有字幕時說明它提供姓名', txt('#statusText').includes('姓名'), txt('#statusText'));

  // 擷取分頁音訊需要**使用者手勢**（chrome.tabCapture.getMediaStreamId 的硬性要求），
  // 所以不能自動啟動 —— 計時器觸發的呼叫一定被 Chrome 拒絕。
  // 這是回歸測試：曾經做成自動啟動，結果每次都失敗，而錯誤訊息
  // （"Extension has not been invoked"）會把人帶往「權限沒給」的錯誤方向。
  window.__sent.length = 0;
  emit('status', { captionsFound: false, platform: 'google-meet', audioFallback: false });
  for (let i = 0; i < 10; i++) await tick();
  check('沒按按鈕時不會自作主張啟動擷取（沒有手勢一定失敗）',
    !window.__sent.some((m) => m.type === 'ma:audio:start'),
    JSON.stringify(window.__sent.filter((m) => m.type === 'ma:audio:start')));
  check('還沒開始時顯示「開始聆聽」按鈕',
    !document.querySelector('#btnListen').classList.contains('hidden'));
  check('狀態列告訴使用者怎麼開始（點工具列圖示）',
    txt('#statusText').includes('工具列'), txt('#statusText'));

  // 按下去才會送出擷取請求
  document.querySelector('#btnListen').click();
  for (let i = 0; i < 10; i++) await tick();
  check('按下「開始聆聽」才送出 ma:audio:start',
    window.__sent.some((m) => m.type === 'ma:audio:start'),
    JSON.stringify(window.__sent.map((m) => m.type)));

  // **getMediaStreamId 必須由側邊欄呼叫** —— 使用者手勢不會跨 sendMessage
  // 傳到 service worker，交給背景呼叫的話 Chrome 會拒絕（按了沒反應）。
  check('串流 id 由側邊欄自己取得（手勢只存在於這裡）',
    window.__capturedTab === 77, `對著分頁 ${window.__capturedTab}`);
  const startMsg = window.__sent.find((m) => m.type === 'ma:audio:start');
  check('把取得的 streamId 交給背景，而不是叫背景自己去拿',
    startMsg?.streamId === 'stream-id', JSON.stringify(startMsg));

  // 開始之後按鈕就收起來
  emit('status', { captionsFound: false, platform: 'google-meet', audioFallback: true });
  check('聆聽中時隱藏「開始聆聽」按鈕',
    document.querySelector('#btnListen').classList.contains('hidden'));

  // ── 免費模式的 UI ─────────────────────────────────────────────
  check('顯示「免費模式」徽章', txt('#providerBadge') === '免費模式', txt('#providerBadge'));
  check('徽章套用免費樣式', document.querySelector('#providerBadge').classList.contains('freeMode'));
  check('免費模式時顯示「啟用免費模型」按鈕',
    !document.querySelector('#btnLocal').classList.contains('hidden'));
  check('模型就緒時按鈕標示已就緒', txt('#btnLocal').includes('已就緒'), txt('#btnLocal'));

  // 背景要求跑一次本機推論：應該逐塊串流回背景，最後送出 done
  emit('localRun', { id: 'run-1', system: '你是助手', user: '這題怎麼答' });
  for (let i = 0; i < 40; i++) await tick();   // async generator 每個項目要好幾個 microtask
  const localMsgs = window.__sent.filter((m) => m.id === 'run-1');
  check('本機推論把結果逐塊串流回背景',
    localMsgs.filter((m) => m.type === 'ma:local:delta').map((m) => m.chunk).join('') === '這是本機模型的回答。',
    JSON.stringify(localMsgs));
  check('本機推論結束後送出 done',
    localMsgs.some((m) => m.type === 'ma:local:done' && m.text === '這是本機模型的回答。'),
    JSON.stringify(localMsgs.filter((m) => m.type === 'ma:local:done')));

  // 介面刻意精簡：這些按鈕已經移除，因為它們代表的動作現在都自動發生
  for (const id of ['btnAudio', 'btnSnapshot']) {
    check(`#${id} 已移除（動作改成自動）`, !document.querySelector(`#${id}`));
  }

  // ── 「我的發言」改成自動，不再是一顆要記得按的按鈕 ─────────────
  // 分頁擷取抓的是分頁播放出來的聲音，你自己講的話不會經過那裡。
  // 少了這條，逐字稿裡就永遠沒有你自己說過的話 —— 而那正是回答建議
  // 最需要的上下文之一（「我剛剛才答應過什麼」）。
  check('#btnMic 已移除（改成跟著聆聽自動開關）', !document.querySelector('#btnMic'));

  // 先回到「沒在聽」的狀態，才有乾淨的起點 —— 頁面載入時餵的 state
  // 已經是 audioFallback: true，麥克風那時就開起來了。
  emit('status', { platform: 'google-meet', audioFallback: false });
  await tick();
  window.__recognizers.length = 0;

  emit('status', { platform: 'google-meet', audioFallback: true, captionsFound: false });
  await tick();
  check('開始聆聽時自動啟動麥克風',
    window.__recognizers.length === 1 && window.__recognizers[0]?.started === true,
    JSON.stringify(window.__recognizers.map((r) => ({ s: r.started, e: r.stopped }))));

  // renderStatus 會被呼叫很多次，不能每次都開一支新的
  emit('status', { platform: 'google-meet', audioFallback: true, captionsFound: true });
  await tick();
  check('重複收到聆聽中的狀態不會開出第二支麥克風',
    window.__recognizers.length === 1, `${window.__recognizers.length} 支`);

  emit('status', { platform: 'google-meet', audioFallback: false });
  await tick();
  check('停止聆聽時自動關掉麥克風', window.__recognizers[0]?.stopped === true,
    JSON.stringify(window.__recognizers.map((r) => ({ s: r.started, e: r.stopped }))));

  // ── 手動產生重點 ──────────────────────────────────────────────
  check('有「產生重點」按鈕', !!document.querySelector('#btnSummary'));

  emit('status', { platform: 'google-meet', audioFallback: true });
  await tick();
  window.__sent.length = 0;
  document.querySelector('#btnSummary').click();
  await tick(); await tick();
  check('按下去會要求背景立刻產生一次摘要',
    window.__sent.some((m) => m.type === 'ma:summarizeNow'),
    JSON.stringify(window.__sent.map((m) => m.type)));
  // 立刻反映在畫面上，不要等背景廣播回來 —— 中間的空窗會讓人以為沒按到
  check('按下去馬上顯示產生中', txt('#btnSummary').includes('產生中'), txt('#btnSummary'));

  // 沒有逐字稿時按了也沒意義
  emit('state', {
    meeting: { sessionId: 's1', platform: 'google-meet', title: '產品週會', url: 'x', startedAt: now },
    status: { platform: 'google-meet', audioFallback: true },
    segments: [], partials: [], summary: null, answers: [],
  });
  await tick();
  check('沒有逐字稿時「產生重點」是停用的',
    document.querySelector('#btnSummary').disabled);

  // ── 「為什麼每個人都叫其他人」要看得到答案 ──────────────────────
  //
  // 這是使用者第一眼就會問的問題，而答案完全不在畫面上：語音辨識拿不到
  // 姓名（whisper 不做說話者分離），真實姓名只有平台字幕有 ——
  // 而開字幕是在會議裡，不是在這個擴充功能裡。沒說的話使用者只會以為壞了。
  const heardSeg = (id, speaker, text) => ({
    id, speaker, text, ts: now, startedAt: now, final: true, source: 'audio',
  });
  emit('state', {
    meeting: { sessionId: 's2', platform: 'google-meet', title: '產品週會', url: 'x', startedAt: now },
    status: { platform: 'google-meet', audioFallback: true, captionsFound: false },
    segments: [heardSeg('h1', '其他人（雲端辨識）', '那我開始今天的報告。')],
    partials: [], summary: null, answers: [],
  });
  await tick();
  check('沒有真名時說明為什麼，而且給出這個平台的具體步驟',
    txt('#transcript').includes('靠聲音分出來的')
    && txt('#transcript').includes('開啟字幕'),
    txt('#transcript').slice(0, 160));

  // 已經抓到真名就不要再提醒 —— 那只是雜訊
  emit('state', {
    meeting: { sessionId: 's2', platform: 'google-meet', title: '產品週會', url: 'x', startedAt: now },
    status: { platform: 'google-meet', audioFallback: true, captionsFound: true },
    segments: [heardSeg('h2', 'Eden', '那我開始今天的報告。'), heardSeg('h3', 'Mei', '準備好就可以開始了。')],
    partials: [], summary: null, answers: [],
  });
  await tick();
  check('已經有真名時不再提醒開字幕',
    !txt('#transcript').includes('靠聲音分出來的'),
    txt('#transcript').slice(0, 120));
  // 這才是使用者要的樣子：一句一個人，名字各自標出來
  check('不同的說話者各自顯示自己的名字',
    txt('#transcript').includes('Eden') && txt('#transcript').includes('Mei'),
    txt('#transcript').slice(0, 120));
  check('兩個人用不同的顏色（同一人永遠同色）',
    document.querySelectorAll('#transcript .who').length === 2
    && new Set([...document.querySelectorAll('#transcript .who')].map((e) => e.style.color)).size === 2,
    [...document.querySelectorAll('#transcript .who')].map((e) => `${e.textContent}=${e.style.color}`).join(' '));

  // ── 開始聆聽之後的說明：每個引擎都要有自己的分支 ────────────────
  //
  // 踩過一次：預設引擎從本機換成 groq 之後忘了加分支，於是**所有正常設定好
  // 金鑰的人**（也就是走雲端的人）看到的是最後那句備援訊息 ——
  // 「瀏覽器內建備援引擎…執行 install-whisper.ps1 可換成原生引擎」。
  // 描述的是一條他根本沒在走的路，還叫他去裝一個不需要的東西。
  //
  // 這種錯誤不會有例外、不會有紅字、逐字稿照樣正常出現，所以只能靠測試守。
  const startMessages = {};
  for (const engine of ['groq', 'whisper-native', 'whisper']) {
    window.__audioStartReply = { ok: true, engine };
    // 先回到「沒在聽」：按鈕才會回來，sttStarting 也才會被 resetListening 清掉
    emit('status', { platform: 'google-meet', audioFallback: false });
    await tick();
    document.querySelector('#btnListen').click();
    for (let i = 0; i < 10; i++) await tick();
    startMessages[engine] = txt('#banner');
  }
  window.__audioStartReply = null;

  check('走雲端時說得出是雲端辨識，不是備援引擎',
    startMessages.groq.includes('雲端') && !startMessages.groq.includes('備援'),
    startMessages.groq);
  // 音訊離開這台電腦是雲端相對本機唯一的取捨，使用者有權在送出去之前就知道，
  // 不能只寫在 README 裡（offscreen.js 的 startGroq 註解也是這樣寫的）。
  check('走雲端時明講音訊會送到 Groq 的伺服器',
    startMessages.groq.includes('Groq 的伺服器'), startMessages.groq);
  check('走雲端時不會叫使用者去裝本機 whisper（他不需要）',
    !startMessages.groq.includes('install-whisper'), startMessages.groq);
  check('三個引擎的說明各不相同（少一個分支就會有兩個一樣）',
    new Set(Object.values(startMessages)).size === 3,
    JSON.stringify(startMessages));
  check('本機原生引擎的說明講的是本機',
    startMessages['whisper-native'].includes('本機'), startMessages['whisper-native']);
  check('WASM 備援的說明才提到 install-whisper.ps1',
    startMessages.whisper.includes('install-whisper'), startMessages.whisper);
  // 按量計費的路線已經整個移除，文案裡也不該再出現
  check('沒有任何一個說明提到按量計費',
    !Object.values(startMessages).some((m) => m.includes('按量計費')),
    JSON.stringify(startMessages));

  // ── Chrome 內建模型：用不到就完全不要碰 ──────────────────────
  // 每一次 LanguageModel 呼叫，只要沒帶 outputLanguage，Chrome 就會在
  // 擴充功能的錯誤頁累積一筆「No output language was specified」。
  // 使用者看到的是錯誤一直長出來，卻完全看不出跟什麼有關。
  check('問內建模型狀態時有帶 outputLanguage（否則錯誤頁會一直累積警告）',
    window.__lmCalls.length > 0 && window.__lmCalls.every((c) => c.opts && c.opts.outputLanguage),
    JSON.stringify(window.__lmCalls));
  check('而且不是指定 zh（Chrome 只接受 de/en/es/fr/ja，指定 zh 會直接失敗）',
    window.__lmCalls.every((c) => c.opts.outputLanguage !== 'zh'),
    JSON.stringify(window.__lmCalls.map((c) => c.opts.outputLanguage)));

  // 走雲端時內建模型根本不會被使用，那就一次都不該碰它
  window.__lmCalls.length = 0;
  window.__providerInfo = {
    provider: 'cloud', label: '雲端免費方案（Groq）', answerLabel: '雲端免費方案（Groq）',
    free: true, supportsImages: false, needsPanel: false, panelReachable: true,
    cloudConfigured: true, cloudCooldown: [],
  };
  await refreshProviderBadge();
  await tick(); await tick();
  check('走雲端時完全不碰內建模型（錯誤頁才不會長出警告）',
    window.__lmCalls.length === 0, JSON.stringify(window.__lmCalls));
  check('走雲端時徽章顯示雲端', txt('#providerBadge').includes('雲端'), txt('#providerBadge'));
  check('走雲端時不顯示「啟用免費模型」按鈕',
    document.querySelector('#btnLocal').classList.contains('hidden'));

  } catch (err) {
    // 中斷也要把已完成的結果印出來，否則看不出斷在哪一步
    results.push(`FAIL  測試中斷  →  ${err && (err.stack || err.message || err)}`);
  }

  const failed = results.filter((x) => x.startsWith('FAIL')).length;
  const pre = document.createElement('pre');
  pre.id = 'testout';
  pre.textContent = results.join('\n') + '\n---\n' + (failed === 0 ? `全部 ${results.length} 項通過` : `${failed} 項失敗`);
  document.body.appendChild(pre);
})();
