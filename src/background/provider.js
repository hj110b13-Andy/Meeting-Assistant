/**
 * 模型後端切換層。上層（service-worker）只呼叫這裡，不必知道底下是哪一個。
 *
 *   chrome-ai   — Chrome 內建 Gemini Nano：完全免費離線、1–3 秒，能力有限
 *   claude-code — 本機 Claude Code（Pro 訂閱額度）：品質最好、免費，但一次 10–30 秒
 *
 * **兩條都不會產生任何按量費用。** 曾經有第三條 Claude API（品質最好、支援圖片、
 * 可串流），但那是按量計費的，已整個移除 —— 這個專案只花 Claude Pro 訂閱的錢。
 * 注意 Pro／Max 訂閱**不含 API 額度**，兩者是分開計費的，橋接是唯一能動用訂閱的路。
 *
 * 每個呼叫都帶 role（'summary' | 'answer'），因為兩者對延遲的要求不同：
 * 摘要可以慢（走 Claude Code 換品質），即時回答要秒級（走 Nano）。
 */

import { getSettings, resolveProvider } from './settings.js';
import { localComplete, localStream, panelReachable, LocalModelUnavailable } from './localmodel.js';
import { ccComplete, ccStream, bridgeHealthy, BridgeUnavailable } from './claudecode.js';

export { LocalModelUnavailable, BridgeUnavailable, bridgeHealthy };

export async function currentProvider(role = 'summary') {
  return resolveProvider(await getSettings(), role);
}

/**
 * 兩個後端的能力差距很大，尤其 context。Nano 只有幾千 token，
 * 塞整場逐字稿會被截斷或直接失敗，所以由這裡統一決定字數上限。
 */
export const BUDGET = {
  'chrome-ai':   { transcript: { answer: 1500, summary: 2500 },  supportsImages: false, structuredJson: false, streams: true,  fast: true },
  'claude-code': { transcript: { answer: 6000, summary: 12000 }, supportsImages: false, structuredJson: false, streams: false, fast: false },
};

export async function budget(role = 'summary') {
  const provider = await currentProvider(role);
  const b = BUDGET[provider];
  return {
    provider,
    transcriptChars: b.transcript[role],
    supportsImages: b.supportsImages,
    structuredJson: b.structuredJson,
    fast: b.fast,
  };
}

const LABELS = {
  'chrome-ai': () => '本機模型（免費）',
  'claude-code': () => 'Claude Code（Pro 訂閱）',
};

/** 後端狀態，給 UI 顯示用 */
export async function describe() {
  const settings = await getSettings();
  const summary = resolveProvider(settings, 'summary');
  const answer = resolveProvider(settings, 'answer');

  return {
    provider: summary,
    answerProvider: answer,
    label: LABELS[summary](settings),
    answerLabel: LABELS[answer](settings),
    free: true,                       // 已經沒有付費後端了
    supportsImages: BUDGET[summary].supportsImages,
    localUnsupported: !!settings.localModelUnsupported,
    // 本機模型跑在側邊欄，側邊欄關著就沒地方跑
    needsPanel: summary === 'chrome-ai' || answer === 'chrome-ai',
    panelReachable: panelReachable(),
    needsBridge: summary === 'claude-code' || answer === 'claude-code',
  };
}

function backend(provider) {
  if (provider === 'claude-code') return { complete: ccComplete, stream: ccStream };
  return { complete: localComplete, stream: localStream };
}

// opts.provider 可以指定這一次要用哪個後端，蓋掉設定的判斷。
// 用途：使用者勾了「附上會議畫面」，但目前的後端看不懂圖片時，
// 這一題升級到看得懂的後端 —— 使用者要的是答案，不是一句「我看不懂」。
export async function complete(opts) {
  return backend(opts.provider || await currentProvider(opts.role || 'summary')).complete(opts);
}

export async function stream(opts) {
  return backend(opts.provider || await currentProvider(opts.role || 'answer')).stream(opts);
}
