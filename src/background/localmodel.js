/**
 * Chrome 內建模型後端（Gemini Nano）— 完全免費、離線、不需要金鑰。
 *
 * 為什麼不在 service worker 直接跑：
 *   1. 首次使用要下載模型，而下載必須由使用者操作觸發（service worker 沒有手勢）
 *   2. 側邊欄是實際顯示結果的地方，模型跑在那裡就不必跨情境搬運串流
 * 所以推論委派給側邊欄執行，這裡只負責「把請求送過去、把結果收回來」。
 *
 * 限制（相對於 Claude）：context window 小得多、不支援圖片、中文判斷品質明顯較弱。
 */

let deliver = null;              // (payload) => boolean，由 service-worker 注入
const pending = new Map();       // id -> {resolve, reject, onDelta, text}
let seq = 0;

export function bindPanelChannel(fn) { deliver = fn; }

/** 側邊欄目前是否開著。關著就沒有地方跑本機模型。 */
export function panelReachable() { return !!deliver && deliver.hasPanel?.(); }

export class LocalModelUnavailable extends Error {}

/** 處理側邊欄回傳的訊息。回傳是否有對應的等待中請求。 */
export function handlePanelMessage(msg) {
  const job = pending.get(msg.id);
  if (!job) return false;

  if (msg.type === 'ma:local:delta') {
    job.text += msg.chunk;
    job.onDelta?.(msg.chunk);
  } else if (msg.type === 'ma:local:done') {
    pending.delete(msg.id);
    job.resolve({ text: msg.text ?? job.text, stopReason: 'end_turn' });
  } else if (msg.type === 'ma:local:error') {
    pending.delete(msg.id);
    job.reject(new Error(msg.error || '本機模型執行失敗'));
  }
  return true;
}

/**
 * 送一次推論到側邊欄。system 與 messages 沿用 Claude 那邊的形狀，
 * 這裡攤平成 Nano 需要的「一段系統提示 + 一段使用者輸入」。
 */
function run({ system, messages, onDelta, timeoutMs = 90000 }) {
  if (!panelReachable()) {
    throw new LocalModelUnavailable('免費模型跑在側邊欄裡，請先開啟側邊欄（點工具列的擴充功能圖示）。');
  }

  const id = `local-${++seq}-${Date.now().toString(36)}`;
  const systemText = (Array.isArray(system) ? system : [{ text: system || '' }])
    .map((b) => b.text).filter(Boolean).join('\n\n');
  const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('本機模型逾時。可能是記憶體不足或模型仍在下載。'));
    }, timeoutMs);

    pending.set(id, {
      text: '',
      onDelta,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    if (!deliver({ id, system: systemText, user: String(userText) })) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new LocalModelUnavailable('側邊欄沒有開啟，無法執行免費模型。'));
    }
  });
}

export async function localStream(opts) { return run(opts); }

export async function localComplete(opts) { return run({ ...opts, onDelta: null }); }
