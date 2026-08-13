/**
 * 背景協調者：接收字幕、維護逐字稿、排程摘要、偵測提問、產生回答建議。
 */

import * as store from './store.js';
import { getSettings, saveSettings, jitsiPatterns } from './settings.js';
import { complete, stream, budget, describe, bridgeHealthy, BUDGET, LocalModelUnavailable } from './provider.js';
import { bindPanelChannel, handlePanelMessage } from './localmodel.js';
import { sttEnsure, sttStatus, sttShutdown, STT_ENDPOINT } from './whisper-native.js';

const ports = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch { /* setPanelBehavior 已處理 */ }
});

// ── 自架 Jitsi：動態註冊內容腳本 ─────────────────────────────────
// Jitsi 可自架，網域無法事先列舉，所以 manifest 只靜態註冊公開站，
// 自架站由使用者在設定頁授權後在這裡註冊。
const JITSI_SCRIPT_ID = 'ma-jitsi-custom';

async function syncJitsiScripts() {
  if (!chrome.scripting?.registerContentScripts) return { ok: false, error: '這個 Chrome 版本不支援動態註冊' };

  const { jitsiDomains } = await getSettings();
  const matches = jitsiPatterns(jitsiDomains);

  // 先移除舊的再註冊，否則改網域時會殘留上一次的比對規則
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [JITSI_SCRIPT_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [JITSI_SCRIPT_ID] });
  } catch { /* 沒註冊過 */ }

  if (!matches.length) return { ok: true, matches: [] };

  // 只註冊「已經拿到授權」的網域 —— 沒授權時 registerContentScripts 會整批失敗
  const granted = [];
  for (const m of matches) {
    if (await chrome.permissions.contains({ origins: [m] })) granted.push(m);
  }
  if (!granted.length) return { ok: false, error: '網域尚未授權', matches, granted };

  try {
    await chrome.scripting.registerContentScripts([{
      id: JITSI_SCRIPT_ID,
      matches: granted,
      js: ['src/content/core.js', 'src/content/jitsi.js'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    }]);
    return { ok: true, matches, granted };
  } catch (err) {
    return { ok: false, error: String(err.message || err), matches, granted };
  }
}

// Service worker 會被回收再喚醒，restore() 必須先完成才能處理訊息，
// 否則喚醒後第一段字幕會先寫進空 state，接著被 restore 覆蓋掉。
const ready = store.restore();

// ── 與側邊欄的連線 ───────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ma-panel') return;
  ports.add(port);
  ready.then(() => port.postMessage({ type: 'state', payload: store.getState() }));
  port.onDisconnect.addListener(() => ports.delete(port));
});

function broadcast(type, payload) {
  for (const p of ports) {
    try { p.postMessage({ type, payload }); } catch { ports.delete(p); }
  }
}

function pushState() { broadcast('state', store.getState()); }

// 免費模型（Chrome 內建）跑在側邊欄裡：首次使用要使用者手勢觸發下載，
// 而 service worker 沒有手勢。這裡把「把推論請求送去側邊欄」的通道接上。
const deliverLocal = (payload) => {
  if (!ports.size) return false;
  broadcast('localRun', payload);
  return true;
};
deliverLocal.hasPanel = () => ports.size > 0;
bindPanelChannel(deliverLocal);

// ── 訊息路由 ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    switch (msg?.type) {
      case 'ma:segment':
        await onSegment(msg.payload);
        return reply?.({ ok: true });

      case 'ma:status': {
        const changed = store.startMeetingIfNeeded(msg.payload);
        store.setStatus({
          captionsFound: msg.payload.captionsFound,
          platform: msg.payload.platform,
          participants: msg.payload.participants,
        });
        if (changed) pushState(); else broadcast('status', store.getState().status);
        return reply?.({ ok: true });
      }

      // 側邊欄回傳的本機模型結果
      case 'ma:local:delta':
      case 'ma:local:done':
      case 'ma:local:error':
        handlePanelMessage(msg);
        return reply?.({ ok: true });

      case 'ma:provider':
        return reply?.(await describe());

      case 'ma:bridge:check':
        return reply?.({ ok: await bridgeHealthy() });

      case 'ma:snapshot':
        return reply?.(await snapshotForClaudeCode());

      case 'ma:audioError':
        reportError(new Error(msg.message));
        return reply?.({ ok: true });

      case 'ma:getState':
        return reply?.(store.getState());

      case 'ma:ask':
        answerQuestion({
          question: msg.question, asker: '我', manual: true, withScreen: !!msg.withScreen,
        }).catch(reportError);
        return reply?.({ ok: true });

      case 'ma:summarizeNow':
        runSummary(true).catch(reportError);
        return reply?.({ ok: true });

      case 'ma:clear':
        store.clearAll();
        pushState();
        return reply?.({ ok: true });

      case 'ma:export': {
        const md = store.toMarkdown();
        return reply?.({ ok: true, markdown: md });
      }

      case 'ma:settings:get':
        return reply?.(await getSettings());

      case 'ma:settings:set': {
        const next = await saveSettings(msg.patch);
        // 網域改了就要重新註冊，否則設定存了卻沒生效
        if (msg.patch?.jitsiDomains !== undefined) await syncJitsiScripts();
        return reply?.(next);
      }

      case 'ma:jitsi:sync':
        return reply?.(await syncJitsiScripts());

      case 'ma:audio:start':
        return reply?.(await startAudioFallback(msg.tabId, msg.engine));

      case 'ma:stt:status':      // 設定頁用：本機原生辨識裝好了沒
        return reply?.(await sttStatus());

      case 'ma:stt:stop':        // 設定頁用：把常駐的辨識伺服器收掉
        return reply?.(await sttShutdown());

      case 'ma:audioNote':      // offscreen 的進度說明，不是錯誤
        broadcast('audioNote', { message: msg.message });
        return reply?.({ ok: true });

      case 'ma:audio:stop':
        return reply?.(await stopAudioFallback());

      default:
        return reply?.({ ok: false, error: 'unknown message' });
    }
  })().catch((err) => { reportError(err); reply?.({ ok: false, error: String(err.message || err) }); });
  return true; // 保持非同步 reply 通道
});

function reportError(err) {
  const message = String(err?.message || err);
  console.error('[會議助手]', err);
  store.setStatus({ lastError: message });
  broadcast('error', { message });
}

// ── 字幕進來 ────────────────────────────────────────────────────
async function onSegment(seg) {
  // 只有字幕來源可以「開新會議」。音訊備援與字幕會同時存在，
  // 若讓它也重設 session，逐字稿會被清空。
  if (seg.source !== 'audio') {
    store.startMeetingIfNeeded({
      sessionId: seg.sessionId, platform: seg.platform, title: seg.title, url: seg.url,
    });
  }
  const { isNewFinal, segment } = store.upsertSegment(seg);
  broadcast(seg.final ? 'segment' : 'partial', segment);

  if (!isNewFinal) return;

  const settings = await getSettings();
  if (settings.autoAnswer) await maybeAnswer(segment, settings);
  if (store.summaryDue({
    everySegments: settings.summaryEverySegments,
    everyMs: settings.summaryEveryMs,
  })) {
    runSummary(false).catch(reportError);
  }
}

// ── 滾動式摘要 ──────────────────────────────────────────────────
const SUMMARY_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      topics: { type: 'array', items: { type: 'string' }, description: '目前正在討論的主題，最多 5 個短詞' },
      summary: { type: 'array', items: { type: 'string' }, description: '整場會議的重點，每點一句話' },
      decisions: { type: 'array', items: { type: 'string' }, description: '已明確做出的決議' },
      actions: {
        type: 'array',
        description: '待辦事項',
        items: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '負責人姓名，未指定就寫「未指定」' },
            task: { type: 'string' },
          },
          required: ['owner', 'task'],
          additionalProperties: false,
        },
      },
      open_questions: { type: 'array', items: { type: 'string' }, description: '尚未有結論、需要後續追蹤的問題' },
    },
    required: ['topics', 'summary', 'decisions', 'actions', 'open_questions'],
    additionalProperties: false,
  },
};

/**
 * 免費的 Chrome 內建模型不保證支援 JSON schema 輸出，
 * 所以改要求固定前綴的純文字，再在這裡解析。
 */
function parsePlainSummary(text) {
  const lines = String(text).split('\n');
  const pick = (label) => lines
    .filter((l) => l.trim().startsWith(label))
    .map((l) => l.slice(l.indexOf(label) + label.length).replace(/^[:：\s\-—]+/, '').trim())
    .filter(Boolean);

  return {
    topics: pick('主題').flatMap((s) => s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean)),
    summary: pick('重點'),
    decisions: pick('決議'),
    actions: pick('待辦').map((l) => {
      const parts = l.split(/[|｜]/);
      return parts.length > 1
        ? { owner: parts[0].trim() || '未指定', task: parts.slice(1).join('|').trim() }
        : { owner: '未指定', task: l };
    }),
    open_questions: pick('問題'),
  };
}

const PLAIN_SUMMARY_FORMAT = [
  '用以下格式輸出，每行一項，不要加其他文字：',
  '主題: 詞1, 詞2',
  '重點: 一句話',
  '決議: 一句話',
  '待辦: 負責人|要做的事',
  '問題: 尚未有結論的問題',
  '同一種標籤可以有多行。沒有內容的標籤就整行省略。',
].join('\n');

let summaryRunning = false;

async function runSummary(force) {
  if (summaryRunning) return;
  const s = store.getState();
  if (!s.segments.length) return;

  const limits = await budget('summary');

  // Chrome 內建模型跑在側邊欄，關著就先不跑（而不是每次都噴錯誤）
  if (limits.provider === 'chrome-ai' && !(await describe()).panelReachable) return;

  summaryRunning = true;
  broadcast('summaryStatus', { running: true });
  try {
    const settings = await getSettings();
    const previous = s.summary
      ? JSON.stringify({
          topics: s.summary.topics, summary: s.summary.summary,
          decisions: s.summary.decisions, actions: s.summary.actions,
          open_questions: s.summary.open_questions,
        }, null, 0)
      : '（尚無先前摘要）';
    const tail = force
      ? store.transcriptText({ limitChars: limits.transcriptChars })
      : store.unsummarizedTail().map((x) => `${x.speaker}：${x.text}`).join('\n');

    const rules = [
      '你是會議記錄員。根據既有摘要與新增的逐字稿，輸出「更新後的完整摘要」。',
      '規則：',
      '- 摘要是累積的：保留先前仍然成立的重點，加入新資訊，修正被推翻的內容。',
      '- 只寫逐字稿真正說過的事，不要推測或補充背景知識。',
      '- 涉及人名時保留原文姓名，方便對照發言者。',
      '- 全部使用繁體中文（台灣用語）。每點一句話，不要贅字。',
      limits.structuredJson ? '- 若某個欄位沒有內容，回傳空陣列，不要硬湊。' : PLAIN_SUMMARY_FORMAT,
    ].join('\n');

    const { text } = await complete({
      role: 'summary',
      maxTokens: 4096,
      effort: settings.effortSummary,
      thinking: { type: 'adaptive' },
      format: limits.structuredJson ? SUMMARY_SCHEMA : undefined,
      system: [{ type: 'text', text: rules }],
      messages: [{
        role: 'user',
        content: `【既有摘要】\n${previous}\n\n【新增逐字稿】\n${tail || '（無）'}`,
      }],
    });

    const parsed = limits.structuredJson ? JSON.parse(text) : parsePlainSummary(text);
    store.markSummarized(parsed);
    broadcast('summary', store.getState().summary);
  } catch (err) {
    // 段數不歸零（逐字稿留著下次一起送），但時間基準往前推，
    // 否則下一段發言講完就會立刻重試 —— 逾時或額度用盡時最不該這樣。
    store.deferSummary();
    throw err;
  } finally {
    summaryRunning = false;
    broadcast('summaryStatus', { running: false });
  }
}

// ── 偵測「有人在問我」 ─────────────────────────────────────────
const QUESTION_MARKS = /[?？]/;
const ZH_QUESTION = /(嗎|呢|如何|怎麼|怎樣|為什麼|為何|是不是|有沒有|可不可以|能不能|要不要|哪一?個|什麼時候|多少|意見|看法|想法)/;
const EN_QUESTION = /\b(what|why|how|when|where|which|who|can you|could you|do you|would you|any thoughts|your take)\b/i;
const DIRECT_ADDRESS = /(請問|想請|你覺得|你認為|你這邊|麻煩你|交給你|由你)/;

function looksLikeQuestion(text) {
  if (text.length < 4) return false;
  return QUESTION_MARKS.test(text) || ZH_QUESTION.test(text) || EN_QUESTION.test(text);
}

function addressesMe(text, myNames) {
  if (!myNames.length) return false;
  return myNames.some((n) => n && text.includes(n));
}

async function maybeAnswer(segment, settings) {
  if (segment.source === 'me') return;   // 我自己說的話不用回答
  const myNames = (settings.myNames || '').split(/[,，、\s]+/).filter(Boolean);
  const isQuestion = looksLikeQuestion(segment.text);
  if (!isQuestion) return;
  // 有點名我、或直接對人講話 → 才自動產生建議，避免每個問句都燒 token
  const targeted = addressesMe(segment.text, myNames) || DIRECT_ADDRESS.test(segment.text);
  if (!targeted) return;
  await answerQuestion({ question: segment.text, asker: segment.speaker, manual: false });
}

// ── 產生回答建議（串流） ────────────────────────────────────────
async function answerQuestion({ question, asker, manual, withScreen }) {
  const settings = await getSettings();
  const id = `a-${Date.now().toString(36)}`;
  const record = store.addAnswer({
    id, question, asker, answer: '', ts: Date.now(), streaming: true, manual,
  });
  broadcast('answer', record);

  const s = store.getState();
  const summaryBlock = s.summary
    ? [
        `目前重點：${(s.summary.summary || []).join('；') || '（無）'}`,
        `已決議：${(s.summary.decisions || []).join('；') || '（無）'}`,
        `待辦：${(s.summary.actions || []).map((a) => `${a.owner}-${a.task}`).join('；') || '（無）'}`,
      ].join('\n')
    : '（尚無摘要）';

  const limits = await budget('answer');

  // 畫面截圖：Claude Code 讀不到 base64，但讀得到檔案，所以存成 PNG 只把路徑交給它。
  // 截圖失敗不該讓回答整個失效 —— 少了畫面，逐字稿本身通常還是答得出來。
  let provider = limits.provider;
  let transcriptChars = limits.transcriptChars;
  let imagePath = null;

  if (withScreen) {
    // 本機模型看不懂圖片。既然使用者明確要求看畫面，就把這一題升級到
    // Claude Code（同樣免費，只是慢），而不是回一句「我看不懂」。
    if (provider === 'chrome-ai' && await bridgeHealthy()) {
      provider = 'claude-code';
      transcriptChars = BUDGET['claude-code'].transcript.answer;
      broadcast('answerNote', { id, note: '本機模型看不懂圖片，這一題改用 Claude Code（較慢，但看得懂畫面）。' });
    }

    if (provider === 'claude-code') {
      try {
        imagePath = await captureScreenFile();
        broadcast('answerNote', { id, note: '正在讀取會議畫面…（多一次工具往返，約 10–20 秒）' });
      } catch (err) {
        broadcast('answerNote', { id, note: `畫面擷取失敗，只依逐字稿回答：${err.message}` });
      }
    } else if (provider === 'chrome-ai') {
      broadcast('answerNote', { id, note: '本機模型看不懂圖片，而 Claude Code 橋接未就緒（需執行 bridge\\install.ps1），只依逐字稿回答。' });
    } else {
      // Claude API 看得懂圖片，但這條路的即時看畫面還沒接上，別假裝有做
      broadcast('answerNote', { id, note: 'API 路線的即時看畫面尚未實作，只依逐字稿回答。可改用「📸 存檔給 Claude Code」。' });
    }
  }

  try {
    await stream({
      role: 'answer',
      provider,
      maxTokens: 1200,
      imagePath,
      effort: settings.effortAnswer,
      // 即時回答重點是延遲：關閉思考，靠上下文與低 effort 換速度。
      thinking: { type: 'disabled' },
      system: [
        {
          type: 'text',
          text: [
            '你是使用者在會議中的即時助手。使用者剛被提問，需要能「照著唸」的回答。',
            '輸出格式（純文字，不要 Markdown 標題）：',
            '第一行：一句話的直接回答，30 字以內，可以直接講出口。',
            '接著 2–4 個「・」開頭的補充要點，每點一行、一句話。',
            '若逐字稿或我的筆記裡沒有足夠資訊，第一行就誠實說明可以怎麼回應（例如先確認需求、承諾會後補），不要編造數字或承諾。',
            '不要重述問題，不要加開場招呼，不要說明你是 AI。全部使用繁體中文（台灣用語）。',
          ].join('\n'),
        },
        {
          type: 'text',
          text: `【我的背景筆記】\n${settings.notes || '（無）'}\n\n【會議摘要】\n${summaryBlock}\n\n【近期逐字稿】\n${store.transcriptText({ limitChars: transcriptChars })}`,
        },
      ],
      messages: [{
        role: 'user',
        content: manual
          ? `我想知道：${question}`
          : `${asker} 問我：「${question}」。請給我回答建議。`,
      }],
      onDelta: (chunk) => {
        record.answer += chunk;
        broadcast('answerDelta', { id, chunk });
      },
    });
    store.updateAnswer(id, { streaming: false });
    broadcast('answerDone', { id, answer: record.answer });
  } catch (err) {
    store.updateAnswer(id, { streaming: false, error: String(err.message || err) });
    broadcast('answerDone', { id, answer: record.answer, error: String(err.message || err) });
    throw err;
  }
}

// ── 存檔給 Claude Code（用 Pro 訂閱做高品質摘要／看畫面的免費路線） ──
// 把「會議畫面截圖」和「逐字稿 Markdown」寫進下載資料夾的同一個子目錄，
// 之後在 Claude Code 說「看一下剛剛的畫面和逐字稿」就能直接讀檔，
// 不必把圖片送進 API（那才會按量計費）。
/**
 * 存一張目前畫面的 PNG，回傳**本機絕對路徑**。
 *
 * 需要絕對路徑是因為 Claude Code 是本機程序：它讀檔案，不收 base64。
 * chrome.downloads.download 只回傳 id，路徑得再用 search 查；而且要等
 * state 變成 complete 才保證檔案已經寫完，否則 Claude Code 可能讀到空檔。
 */
async function captureScreenFile() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('找不到作用中的分頁');

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: `會議助手/提問畫面-${stamp}.png`,
    saveAs: false,
  });

  for (let i = 0; i < 20; i++) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === 'complete' && item.filename) return item.filename;
    if (item?.state === 'interrupted') throw new Error(item.error || '截圖存檔被中斷');
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('截圖存檔逾時');
}

async function snapshotForClaudeCode() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = '會議助手';
  const saved = [];

  const md = store.toMarkdown();
  await chrome.downloads.download({
    url: `data:text/markdown;charset=utf-8,${encodeURIComponent(md)}`,
    filename: `${dir}/逐字稿-${stamp}.md`,
    saveAs: false,
  });
  saved.push(`逐字稿-${stamp}.md`);

  // 畫面截圖：需要會議分頁是作用中的分頁
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      await chrome.downloads.download({
        url: dataUrl,
        filename: `${dir}/畫面-${stamp}.png`,
        saveAs: false,
      });
      saved.push(`畫面-${stamp}.png`);
    }
  } catch (err) {
    // 截圖失敗不該讓逐字稿也存不下來
    return { ok: true, saved, dir, warning: `逐字稿已存檔，但畫面擷取失敗：${err.message}` };
  }

  return { ok: true, saved, dir };
}

// ── 音訊備援（字幕抓不到時） ────────────────────────────────────
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '擷取會議分頁音訊，在平台字幕不可用時做語音辨識備援。',
  });
}

async function startAudioFallback(tabId, engineOverride) {
  const settings = await getSettings();

  // 預設走本機辨識：零費用、不需金鑰。只有明確選了 deepgram（或設定裡
  // 偏好雲端而且有金鑰）才走雲端那條，因為那條會按量計費。
  let engine = engineOverride
    || (settings.sttEngine === 'deepgram' && settings.deepgramKey ? 'deepgram' : settings.sttEngine)
    || 'whisper-native';
  if (engine === 'deepgram' && !settings.deepgramKey) {
    const message = '雲端語音辨識需要 Deepgram 金鑰。留空的話請改用本機辨識（免費）。';
    reportError(new Error(message));
    return { ok: false, error: message };
  }

  // 原生辨識要先請 bridge 把 whisper-server 拉起來。裝不起來就退回
  // 瀏覽器內的 WASM ——「慢一點但有東西」勝過整個功能靜靜地失敗。
  let sttNote = '';
  if (engine === 'whisper-native') {
    try {
      const r = await sttEnsure(settings.sttNativeModel);
      if (!r.reused && r.startMs) sttNote = `本機辨識伺服器已啟動（載入模型 ${(r.startMs / 1000).toFixed(1)} 秒）。`;
    } catch (err) {
      engine = 'whisper';
      sttNote = `原生本機辨識無法啟動（${String(err.message || err)}），已改用瀏覽器內建的備援引擎 —— 一樣免費，但較慢且中文準確度較差。想要更好的結果請執行 tools\\install-whisper.ps1。`;
      broadcast('audioNote', { message: sttNote });
    }
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    // Chrome 要求擴充功能「已被該分頁叫用過」才給音訊串流。
    // 從側邊欄按鈕觸發時這個條件不一定成立，原始錯誤訊息看不出該怎麼辦。
    const raw = String(err?.message || err);
    const message = /not been invoked|activeTab/i.test(raw)
      ? '無法擷取分頁音訊：請先在「會議分頁」點一次工具列的擴充功能圖示，取得該分頁的授權，再按「音訊備援」。'
      : `無法擷取分頁音訊：${raw}`;
    // 上面可能已經把辨識伺服器拉起來了。這裡失敗就沒有東西會去停它，
    // 而 small 模型是常駐約 400 MB —— 這條路很容易走到（tabCapture 常因為
    // 沒先點過擴充功能圖示而失敗），不收掉的話等於白白佔著記憶體。
    try { await sttShutdown(); } catch { /* 本來就沒起來 */ }
    reportError(new Error(message));
    return { ok: false, error: message };
  }

  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: 'ma:offscreen:start',
    streamId,
    engine,
    deepgramKey: settings.deepgramKey,
    options: {
      modelId: settings.sttModel || 'Xenova/whisper-base',
      model: settings.sttNativeModel || 'small',
      endpoint: STT_ENDPOINT,
      toTraditional: settings.sttTraditional !== false,
    },
  });
  if (res && res.ok === false) {
    await stopAudioFallback();
    const message = `音訊擷取啟動失敗：${res.error}`;
    reportError(new Error(message));
    return { ok: false, error: message };
  }
  store.setStatus({ audioFallback: true, sttEngine: engine });
  broadcast('status', store.getState().status);
  return { ok: true, engine, note: sttNote };
}

async function stopAudioFallback() {
  try { await chrome.runtime.sendMessage({ type: 'ma:offscreen:stop' }); } catch {}
  try { await chrome.offscreen.closeDocument(); } catch {}
  // 原生辨識伺服器（small 模型約 400 MB 記憶體）不該在停止擷取後還留著。
  // 斷開 native 連線時主機端的 finally 也會收一次，這裡是明確的那一次。
  try { await sttShutdown(); } catch {}
  store.setStatus({ audioFallback: false });
  broadcast('status', store.getState().status);
  return { ok: true };
}
