/**
 * Claude API 用戶端（直接從擴充功能呼叫，不經自架後端）
 *
 * 這台機器沒有 Node/npm，裝不了 @anthropic-ai/sdk，所以用 fetch 打 REST API。
 * 從瀏覽器情境直接呼叫必須帶 anthropic-dangerous-direct-browser-access: true，
 * 否則 API 會因為請求帶有瀏覽器 Origin 而拒絕。
 *
 * 注意：這代表 API 金鑰存在瀏覽器本機（chrome.storage.local）。個人使用可接受；
 * 若要多人部署，應改成把金鑰放在自己的後端代理，擴充功能只呼叫代理。
 */

import { getSettings } from './settings.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

function headers(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // 從瀏覽器情境直接呼叫 API 必備
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function friendlyError(status, body) {
  const detail = body?.error?.message || '';
  switch (status) {
    case 401: return `API 金鑰無效或未設定（401）。請到擴充功能選項重新填寫。${detail}`;
    case 403: return `這把金鑰沒有權限使用該模型（403）。${detail}`;
    case 404: return `找不到模型 ID（404）。請確認選項裡的模型名稱。${detail}`;
    case 413: return `請求太大（413）。逐字稿過長，請先清除或匯出後再試。${detail}`;
    case 429: return `達到速率上限（429），請稍後再試。${detail}`;
    case 529: return `服務暫時過載（529），請稍後再試。${detail}`;
    default:
      if (status >= 500) return `Claude 服務錯誤（${status}），請稍後重試。${detail}`;
      return `呼叫失敗（${status}）：${detail || '未知錯誤'}`;
  }
}

/** 建立請求 body。system 用陣列形式，方便掛 cache_control 省 token。 */
function buildBody({ model, system, messages, maxTokens, effort, thinking, format, stream }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    // Sonnet 5 不接受 temperature / top_p / top_k，這裡刻意不帶。
  };
  if (system) {
    body.system = (Array.isArray(system) ? system : [{ type: 'text', text: system }])
      .map((b, i, arr) => (i === arr.length - 1
        ? { ...b, cache_control: { type: 'ephemeral' } }   // 快取穩定前綴
        : b));
  }
  const outputConfig = {};
  if (effort) outputConfig.effort = effort;
  if (format) outputConfig.format = format;
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (thinking) body.thinking = thinking;
  if (stream) body.stream = true;
  return body;
}

/** 非串流呼叫，回傳 {text, usage} */
export async function claudeComplete(opts) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('尚未設定 Anthropic API 金鑰，請先開啟擴充功能選項填入。');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: headers(settings.apiKey),
    signal: opts.signal,
    body: JSON.stringify(buildBody({
      model: opts.model || settings.model,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens ?? 4096,
      effort: opts.effort,
      thinking: opts.thinking,
      format: opts.format,
      stream: false,
    })),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(friendlyError(res.status, json));

  if (json.stop_reason === 'refusal') {
    throw new Error('模型基於安全政策拒絕回答此段內容。');
  }
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: json.usage, stopReason: json.stop_reason };
}

/**
 * 串流呼叫。onDelta(textChunk) 會被逐段呼叫，回傳完整文字。
 * 即時問答一定要用串流：使用者在會議中等不起完整回應的延遲。
 */
export async function claudeStream(opts) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('尚未設定 Anthropic API 金鑰，請先開啟擴充功能選項填入。');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: headers(settings.apiKey),
    signal: opts.signal,
    body: JSON.stringify(buildBody({
      model: opts.model || settings.model,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens ?? 2048,
      effort: opts.effort,
      thinking: opts.thinking,
      stream: true,
    })),
  });

  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(friendlyError(res.status, json));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE：以空行分隔事件，每行 "data: {...}"
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          full += evt.delta.text;
          opts.onDelta?.(evt.delta.text);
        } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          stopReason = evt.delta.stop_reason;
        } else if (evt.type === 'error') {
          throw new Error(evt.error?.message || '串流過程發生錯誤');
        }
      }
    }
  }

  if (stopReason === 'refusal') throw new Error('模型基於安全政策拒絕回答此段內容。');
  return { text: full, stopReason };
}
