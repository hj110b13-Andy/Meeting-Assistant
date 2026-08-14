/**
 * 模型後端切換層。上層（service-worker）只呼叫這裡，不必知道底下是哪一個。
 *
 *   cloud       — Groq／NVIDIA NIM 的免費方案：實測 0.4–0.7 秒，**這是預設**
 *   claude-code — 本機 Claude Code（Pro 訂閱額度）：品質最好，但一次 10–30 秒
 *   chrome-ai   — Chrome 內建 Gemini Nano：離線、1–3 秒，但不支援中文輸出
 *
 * **三條都不會產生任何按量費用。** 曾經有第四條 Claude API（按量計費）已整個移除。
 * 雲端那條走的是免費方案：不需信用卡、撞到上限是回 429 而不是開始扣錢。
 * 注意 Claude Pro／Max 訂閱**不含 API 額度**，兩者分開計費，橋接是唯一能動用訂閱的路。
 *
 * 每個呼叫都帶 role（'summary' | 'answer'），因為兩者對延遲的要求不同，
 * 而且雲端刻意讓兩者用不同模型 —— Groq 的免費額度是**每個模型一個桶**，
 * 分開用等於把可用額度變兩份，摘要也不會排擠到「被點名要秒回」。
 */

import { getSettings, resolveProvider } from './settings.js';
import { localComplete, localStream, panelReachable, LocalModelUnavailable } from './localmodel.js';
import { ccComplete, ccStream, bridgeHealthy, BridgeUnavailable } from './claudecode.js';
import { cloudComplete, cloudStream, cloudReady, CloudUnavailable, lastUsed, cooldownState } from './cloud.js';
import { getKeys, hasCloud } from './keys.js';

export { LocalModelUnavailable, BridgeUnavailable, CloudUnavailable, bridgeHealthy, cooldownState };

export async function currentProvider(role = 'summary') {
  return resolveProvider(await getSettings(), role, { cloudReady: await cloudReady() });
}

/**
 * 兩個後端的能力差距很大，尤其 context。Nano 只有幾千 token，
 * 塞整場逐字稿會被截斷或直接失敗，所以由這裡統一決定字數上限。
 */
export const BUDGET = {
  'chrome-ai':   { transcript: { answer: 1500, summary: 2500 },  supportsImages: false, structuredJson: false, streams: true,  fast: true },
  'claude-code': { transcript: { answer: 6000, summary: 12000 }, supportsImages: false, structuredJson: false, streams: false, fast: false },
  // 雲端模型的 context 很大（llama-3.3-70b 是 128k），塞得下整場逐字稿。
  // 但**額度是以 token 計的**（Groq 免費方案每天 10 萬），所以這裡的上限
  // 不是模型的極限，是「不要在一場會議裡把一整天的額度花光」——
  // 摘要每 5 分鐘一次，一小時 12 次 × 約 8000 字，剛好在安全範圍內。
  cloud:         { transcript: { answer: 8000, summary: 16000 }, supportsImages: false, structuredJson: false, streams: true,  fast: true },
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
  cloud: () => '雲端免費方案（Groq）',
};

/** 後端狀態，給 UI 顯示用 */
export async function describe() {
  const settings = await getSettings();
  const ready = await cloudReady();
  const summary = resolveProvider(settings, 'summary', { cloudReady: ready });
  const answer = resolveProvider(settings, 'answer', { cloudReady: ready });
  const keys = await getKeys();

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
    // 雲端的狀態。使用者最常問的兩件事是「現在是誰在回答」與「為什麼變慢了」，
    // 這三個欄位就是為了讓側邊欄能直接答出來。
    cloudConfigured: hasCloud(keys),
    cloudLastUsed: lastUsed.at ? { ...lastUsed } : null,
    cloudCooldown: cooldownState(),
  };
}

function backend(provider) {
  if (provider === 'cloud') return { complete: cloudComplete, stream: cloudStream };
  if (provider === 'claude-code') return { complete: ccComplete, stream: ccStream };
  return { complete: localComplete, stream: localStream };
}

/**
 * 雲端整條斷掉時退回 Claude Code 橋接。
 *
 * **一定要讓使用者知道換了後端。** 症狀差很多：雲端 0.7 秒、橋接 10–30 秒，
 * 使用者只會感覺到「今天特別慢」，然後開始懷疑是不是自己網路有問題。
 * 所以 opts.onFallback 會被呼叫，由 service-worker 廣播成側邊欄上的一行說明。
 *
 * 只有 CloudUnavailable 才退 —— 那代表「整條鏈都試過了」。其他例外
 * （例如程式自己的錯誤）照樣往上丟，不要用退路把 bug 蓋住。
 */
async function withFallback(opts, provider, run) {
  try {
    return await run(backend(provider));
  } catch (err) {
    if (provider !== 'cloud' || !(err instanceof CloudUnavailable)) throw err;
    const settings = await getSettings();
    if (settings.cloudFallbackToBridge === false) throw err;
    opts.onFallback?.({
      from: 'cloud',
      to: 'claude-code',
      reason: String(err.message || err),
    });
    return run(backend('claude-code'));
  }
}

// opts.provider 可以指定這一次要用哪個後端，蓋掉設定的判斷。
// 用途：使用者勾了「附上會議畫面」，但目前的後端看不懂圖片時，
// 這一題升級到看得懂的後端 —— 使用者要的是答案，不是一句「我看不懂」。
export async function complete(opts) {
  const provider = opts.provider || await currentProvider(opts.role || 'summary');
  return withFallback(opts, provider, (b) => b.complete(opts));
}

export async function stream(opts) {
  const provider = opts.provider || await currentProvider(opts.role || 'answer');
  return withFallback(opts, provider, (b) => b.stream(opts));
}
