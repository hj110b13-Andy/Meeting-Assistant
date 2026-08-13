/** panel.js 載入後執行：餵一份逼真的 state 進去，檢查 UI 真的長出來 */
(async () => {
  // 讓已排入的 microtask 跑完（stub 都是同步 resolve，不會拖到 load 事件之後）
  const tick = () => Promise.resolve();
  const results = [];
  const check = (name, cond, extra = '') =>
    results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  →  ' + extra}`);

  const port = window.__ports[0];
  check('panel.js 建立了與背景的連線', !!port && port.name === 'ma-panel', port ? port.name : '沒有 port');
  check('panel.js 註冊了訊息監聽器', !!port && port.listeners.length === 1,
    port ? `${port.listeners.length} 個` : '—');

  const emit = (type, payload) => port.listeners.forEach((fn) => fn({ type, payload }));
  const now = Date.now();

  emit('state', {
    meeting: { sessionId: 's1', platform: 'google-meet', title: '產品週會', url: 'https://meet.google.com/x', startedAt: now },
    status: { captionsFound: true, platform: 'google-meet', audioFallback: false },
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
  check('狀態列顯示字幕已連線', txt('#statusText').includes('字幕已連線'), txt('#statusText'));
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

  // 按鈕會送出對應訊息
  document.querySelector('#btnSummary').click();
  check('摘要按鈕送出 ma:summarizeNow',
    window.__sent.some((m) => m.type === 'ma:summarizeNow'),
    JSON.stringify(window.__sent));

  // 狀態更新（音訊備援）
  emit('status', { captionsFound: false, platform: 'google-meet', audioFallback: true });
  check('音訊備援狀態反映在按鈕', document.querySelector('#btnAudio').classList.contains('on'));
  check('沒有字幕時提示開啟字幕', txt('#statusText').includes('找不到字幕'), txt('#statusText'));

  // 剛偵測到「沒字幕」時**不能**馬上啟動本機辨識：使用者可能只是還沒按 CC。
  // 這是回歸測試 —— 原本的實作沒有等待期，會在 Meet 上白跑 Whisper。
  emit('status', { captionsFound: false, platform: 'google-meet', audioFallback: false });
  for (let i = 0; i < 10; i++) await tick();
  check('剛進會議還沒開字幕時，不會立刻啟動本機辨識',
    !window.__sent.some((m) => m.type === 'ma:audio:start'),
    JSON.stringify(window.__sent.filter((m) => m.type === 'ma:audio:start')));
  check('等待期間會提示稍後將自動改用本機辨識',
    txt('#statusText').includes('自動改用本機辨識'), txt('#statusText'));

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

  // 存檔給 Claude Code
  document.querySelector('#btnSnapshot').click();
  check('存檔按鈕送出 ma:snapshot', window.__sent.some((m) => m.type === 'ma:snapshot'));

  const failed = results.filter((x) => x.startsWith('FAIL')).length;
  const pre = document.createElement('pre');
  pre.id = 'testout';
  pre.textContent = results.join('\n') + '\n---\n' + (failed === 0 ? `全部 ${results.length} 項通過` : `${failed} 項失敗`);
  document.body.appendChild(pre);
})();
