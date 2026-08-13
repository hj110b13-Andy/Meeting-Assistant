/**
 * 逐字稿與摘要狀態（存在 service worker 記憶體 + chrome.storage.local 備份）
 *
 * Service worker 會被瀏覽器休眠回收，所以每次變動都寫回 storage，喚醒後重建。
 */

const MAX_SEGMENTS = 4000;

const state = {
  meeting: null,        // {sessionId, platform, title, url, startedAt}
  segments: [],         // 已定稿：{id, speaker, text, ts, source}
  partials: new Map(),  // id -> 未定稿的即時文字
  summary: null,        // {topics, summary, decisions, actions, open_questions, updatedAt}
  answers: [],          // {id, question, asker, answer, ts, streaming}
  status: { captionsFound: false, platform: null, enabled: true, lastError: null, audioFallback: false },
  pendingSinceSummary: 0,
  lastSummaryAt: 0,
};

const stripQuery = (u) => String(u).split(/[?#]/)[0];

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 800);
}

async function persist() {
  await chrome.storage.local.set({
    session: {
      meeting: state.meeting,
      segments: state.segments.slice(-MAX_SEGMENTS),
      summary: state.summary,
      answers: state.answers.slice(-50),
    },
  });
}

export async function restore() {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return;
  state.meeting = session.meeting || null;
  state.segments = session.segments || [];
  state.summary = session.summary || null;
  state.answers = session.answers || [];
  // Service worker 被回收再喚醒時，別讓時間條件立刻成立
  state.lastSummaryAt = Date.now();
}

export function getState() {
  return {
    meeting: state.meeting,
    segments: state.segments,
    partials: [...state.partials.values()],
    summary: state.summary,
    answers: state.answers,
    status: state.status,
  };
}

export function setStatus(patch) {
  Object.assign(state.status, patch);
}

export function startMeetingIfNeeded(info) {
  if (state.meeting?.sessionId === info.sessionId) return false;

  // 同一個會議網址（重新整理分頁、或瀏覽器重開後回到同一場會議）
  // 只更新 sessionId，不清空已累積的逐字稿。
  const sameUrl = state.meeting?.url && info.url && stripQuery(state.meeting.url) === stripQuery(info.url);
  if (sameUrl) {
    state.meeting.sessionId = info.sessionId;
    state.meeting.title = info.title || state.meeting.title;
    scheduleSave();
    return false;
  }

  state.meeting = {
    sessionId: info.sessionId,
    platform: info.platform,
    title: info.title,
    url: info.url,
    startedAt: Date.now(),
  };
  state.segments = [];
  state.partials.clear();
  state.summary = null;
  state.answers = [];
  state.pendingSinceSummary = 0;
  // 用會議開始時間當基準，而不是 0。若留 0，「距上次摘要超過 everyMs」
  // 會在第一次就成立，設定的頻率等於失效（開場兩句話就送一次摘要）。
  state.lastSummaryAt = Date.now();
  scheduleSave();
  return true;
}

/** 收到一段字幕。回傳是否為新定稿（呼叫端據此決定要不要觸發摘要／問答）。 */
export function upsertSegment(seg) {
  if (!seg.final) {
    state.partials.set(seg.id, seg);
    return { isNewFinal: false, segment: seg };
  }
  state.partials.delete(seg.id);

  const existingIdx = state.segments.findIndex((s) => s.id === seg.id);
  const record = {
    id: seg.id,
    speaker: seg.speaker,
    text: seg.text,
    ts: seg.ts,
    startedAt: seg.startedAt,
    source: seg.source || 'captions',
  };
  if (existingIdx >= 0) {
    state.segments[existingIdx] = record;
    scheduleSave();
    return { isNewFinal: false, segment: record };
  }
  // 照「說話時間」插入，不是照抵達順序。
  //
  // 混合來源時這件事是必須的：麥克風是即時的，本機語音辨識要 20 秒才回來，
  // 直接 push 會讓你自己晚說的話排在別人早說的話前面 —— 逐字稿難讀，
  // 而且送給模型做摘要的對話順序是錯的。
  //
  // 字幕來源本來就是遞增的，所以下面的迴圈會立刻結束，等同於 push。
  const at = record.startedAt || record.ts || 0;
  let i = state.segments.length;
  while (i > 0 && (state.segments[i - 1].startedAt || state.segments[i - 1].ts || 0) > at) i--;
  state.segments.splice(i, 0, record);
  if (state.segments.length > MAX_SEGMENTS) state.segments.shift();
  state.pendingSinceSummary += 1;
  scheduleSave();
  return { isNewFinal: true, segment: record };
}

/**
 * 兩個條件都要成立（AND）：
 *   everyMs       — 最短間隔，這是真正的節流上限
 *   everySegments — 最少新內容，避免冷場時為兩句話燒一次額度
 *
 * 舊版是 OR（任一條先到就觸發），等於完全沒有上限：熱烈討論時
 * 十來段可能一分鐘內就講完，於是每分鐘都在呼叫模型。免費路線多半
 * 落在 Claude Code，每次都是一個完整的 CLI session，很快就會撞到
 * Claude Pro 的用量限制。
 *
 * 手動按 ↻ 摘要不走這裡，永遠可以立刻要一份。
 */
export function summaryDue({ everySegments, everyMs }) {
  if (state.pendingSinceSummary === 0) return false;
  const enoughTime = Date.now() - state.lastSummaryAt >= everyMs;
  const enoughSegments = state.pendingSinceSummary >= everySegments;
  return enoughTime && enoughSegments;
}

/**
 * 摘要失敗後的退避。時間基準往前推，但**保留**累積的段數：
 * 內容不會遺失，下次成功時一起送出。
 *
 * 沒有這個的話，失敗後觸發條件仍然成立，下一段發言講完就立刻重試 ——
 * 若失敗原因是逾時或 Pro 額度用盡，等於每一段發言都燒掉一次呼叫。
 */
export function deferSummary() {
  state.lastSummaryAt = Date.now();
  scheduleSave();
}

export function markSummarized(summary) {
  state.summary = { ...summary, updatedAt: Date.now() };
  state.pendingSinceSummary = 0;
  state.lastSummaryAt = Date.now();
  scheduleSave();
}

export function unsummarizedTail() {
  return state.segments.slice(-Math.max(state.pendingSinceSummary, 1));
}

export function addAnswer(answer) {
  state.answers.push(answer);
  if (state.answers.length > 50) state.answers.shift();
  scheduleSave();
  return answer;
}

export function updateAnswer(id, patch) {
  const a = state.answers.find((x) => x.id === id);
  if (a) { Object.assign(a, patch); scheduleSave(); }
  return a;
}

export function clearAll() {
  state.segments = [];
  state.partials.clear();
  state.summary = null;
  state.answers = [];
  state.pendingSinceSummary = 0;
  state.lastSummaryAt = 0;
  scheduleSave();
}

/** 把逐字稿攤平成給模型讀的文字，尾端優先（會議越後面越重要）。 */
export function transcriptText({ limitChars = 12000, from = 0 } = {}) {
  const lines = state.segments.slice(from).map((s) => `${s.speaker}：${s.text}`);
  let out = lines.join('\n');
  if (out.length > limitChars) out = '（前段省略）\n' + out.slice(-limitChars);
  return out;
}

export function toMarkdown() {
  const m = state.meeting;
  const head = [
    `# ${m?.title || '會議逐字稿'}`,
    '',
    `- 平台：${m?.platform || '未知'}`,
    `- 開始時間：${m?.startedAt ? new Date(m.startedAt).toLocaleString('zh-TW') : '未知'}`,
    `- 段落數：${state.segments.length}`,
    '',
  ];
  if (state.summary) {
    head.push('## 重點摘要', ...(state.summary.summary || []).map((s) => `- ${s}`), '');
    if (state.summary.decisions?.length) head.push('## 決議', ...state.summary.decisions.map((s) => `- ${s}`), '');
    if (state.summary.actions?.length) {
      head.push('## 待辦事項', ...state.summary.actions.map((a) => `- [ ] （${a.owner || '未指定'}）${a.task}`), '');
    }
    if (state.summary.open_questions?.length) {
      head.push('## 未解問題', ...state.summary.open_questions.map((s) => `- ${s}`), '');
    }
  }
  head.push('## 逐字稿', '');
  for (const s of state.segments) {
    const t = new Date(s.ts).toLocaleTimeString('zh-TW', { hour12: false });
    head.push(`**[${t}] ${s.speaker}：** ${s.text}`, '');
  }
  return head.join('\n');
}
