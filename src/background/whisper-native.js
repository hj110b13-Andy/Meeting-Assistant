/**
 * 本機原生語音辨識（whisper.cpp）的啟動與生命週期管理
 *
 * 為什麼要有這一層：擴充功能不能直接啟動本機程序，只能透過 Native Messaging
 * 請 bridge\host.ps1 幫忙啟動 whisper-server.exe。伺服器起來之後，音訊是
 * **由 offscreen 直接用 HTTP 打 127.0.0.1**，不經過這個管道 ——
 * Native Messaging 單則訊息只有 1 MB，12 秒的 16 kHz 音訊 base64 後就快滿了。
 *
 * 為什麼另開一條 connectNative 而不共用 claudecode.js 那條：
 * Chrome 為每個連線各開一個主機程序，而 host.ps1 是單執行緒循序處理訊息。
 * 共用的話，「啟動辨識伺服器」會排在一個跑了 30 秒的 Claude Code 呼叫後面。
 *
 * 連線保持開著就等於「辨識伺服器該活著」：host.ps1 在 stdin 關閉時會把
 * 伺服器一起收掉，所以停止擷取時只要斷開這條連線，記憶體就會還回來。
 */

const HOST_NAME = 'com.meetingassistant.claudecode';
export const STT_PORT = 8317;
export const STT_ENDPOINT = `http://127.0.0.1:${STT_PORT}/inference`;

let port = null;
const pending = new Map();
let seq = 0;

export class NativeSttUnavailable extends Error {}

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    throw new NativeSttUnavailable(`無法連線到本機橋接：${err.message}`);
  }

  port.onMessage.addListener((msg) => {
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    if (msg.ok) job.resolve(msg);
    else job.reject(new Error(msg.error || '本機辨識伺服器操作失敗'));
  });

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || '橋接連線中斷';
    port = null;
    for (const [, job] of pending) {
      job.reject(new NativeSttUnavailable(
        `${reason}。請確認已執行 bridge\\install.ps1，且擴充功能 ID 與註冊時一致。`));
    }
    pending.clear();
  });

  return port;
}

function request(payload, timeoutMs) {
  const p = connect();
  const id = `stt-${++seq}-${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`本機辨識伺服器沒有回應（${Math.round(timeoutMs / 1000)} 秒）。`));
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
      reject(new NativeSttUnavailable(`送不出請求：${err.message}`));
    }
  });
}

/** 有沒有裝、現在有沒有在跑、裝了哪些模型 */
export async function sttStatus() {
  try {
    const r = await request({ type: 'sttStatus' }, 8000);
    return { ok: true, installed: !!r.installed, running: !!r.running, dir: r.dir || '', models: r.models || [], port: r.port || STT_PORT };
  } catch (err) {
    return { ok: false, installed: false, running: false, models: [], error: String(err.message || err) };
  }
}

/**
 * 確保伺服器在跑。回傳 {ok, reused, model, startMs}。
 *
 * 逾時給 60 秒：主機端自己等 40 秒（small 模型冷啟動實測 6 秒，
 * 磁碟沒快取時更久），這裡要比它寬，否則會先於主機放棄、
 * 留下一台沒人管的伺服器。
 */
export async function sttEnsure(model) {
  const r = await request({ type: 'sttStart', model: model || 'small' }, 60000);
  return { ok: true, reused: !!r.reused, model: r.model, startMs: r.startMs || 0, port: r.port || STT_PORT };
}

/** 停掉伺服器並斷開連線（斷線本身也會讓主機端收掉伺服器）。 */
export async function sttShutdown() {
  if (!port) return { ok: true };
  try { await request({ type: 'sttStop' }, 10000); } catch { /* 斷線的 finally 會補做 */ }
  try { port.disconnect(); } catch { }
  port = null;
  pending.clear();
  return { ok: true };
}
