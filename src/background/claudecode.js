/**
 * Claude Code 後端 —— 用你已經買的 Claude Pro 訂閱額度，不經過 API，不按量計費。
 *
 * 走 Chrome 的 Native Messaging：擴充功能啟動 bridge\host.bat（PowerShell），
 * 由它呼叫本機的 claude.exe。需要先執行一次 bridge\install.ps1 註冊。
 *
 * 取捨：一次呼叫要 10–30 秒（每次都重新啟動 CLI 程序），
 * 所以適合摘要，不適合「有人剛問我、三秒內要答案」。
 */

const HOST_NAME = 'com.meetingassistant.claudecode';

let port = null;
const pending = new Map();
let seq = 0;

export class BridgeUnavailable extends Error {}

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    throw new BridgeUnavailable(`無法連線到 Claude Code 橋接：${err.message}`);
  }

  port.onMessage.addListener((msg) => {
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    if (msg.ok) job.resolve(String(msg.text ?? ''));
    else job.reject(new Error(msg.error || 'Claude Code 執行失敗'));
  });

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || '橋接連線中斷';
    port = null;
    for (const [, job] of pending) {
      job.reject(new BridgeUnavailable(
        `${reason}。請確認已執行 bridge\\install.ps1，且擴充功能 ID 與註冊時一致。`));
    }
    pending.clear();
  });

  return port;
}

function request(payload, timeoutMs) {
  const p = connect();
  const id = `cc-${++seq}-${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Claude Code 逾時（${Math.round(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      p.postMessage({ ...payload, id });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new BridgeUnavailable(`送不出請求：${err.message}`));
    }
  });
}

/** 橋接是否已安裝並可用（會實際 ping 一次主機） */
export async function bridgeHealthy() {
  try {
    const text = await request({ type: 'ping' }, 8000);
    return text === 'pong';
  } catch {
    return false;
  }
}

function flatten({ system, messages }) {
  const systemText = (Array.isArray(system) ? system : [{ text: system || '' }])
    .map((b) => b.text).filter(Boolean).join('\n\n');
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  return { system: systemText, user: String(user) };
}

export async function ccComplete(opts) {
  // imagePath 是本機檔案路徑：Claude Code 讀不到 base64，但可以用 Read 工具看檔案。
  // 有附圖時主機端會多開 --allowedTools Read，因此比純文字慢一倍以上。
  const payload = { type: 'run', ...flatten(opts), imagePath: opts.imagePath || null };
  return { text: await request(payload, opts.timeoutMs ?? 180000), stopReason: 'end_turn' };
}

/**
 * Claude Code 沒有逐字串流（CLI 一次回傳完整結果），
 * 所以這裡把整段當成一塊 delta 送出，讓上層的串流介面照樣運作。
 */
export async function ccStream(opts) {
  const { text, stopReason } = await ccComplete(opts);
  if (text) opts.onDelta?.(text);
  return { text, stopReason };
}
