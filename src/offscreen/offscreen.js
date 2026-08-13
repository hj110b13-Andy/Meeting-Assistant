/**
 * 聽會議分頁的聲音，轉成逐字稿。兩個引擎，**都在本機執行、零費用**：
 *
 *   whisper-native — 本機執行的 whisper.cpp（%LOCALAPPDATA%\MeetingAssistant\whisper），
 *                    由 bridge 啟動成一台只綁 127.0.0.1 的小伺服器，音訊用 HTTP 送過去。
 *                    **零費用、資料不出這台電腦、不需金鑰**，而且用 small 模型 ——
 *                    中文準確度遠勝 WASM 那條的 base 模型。這是預設。
 *   whisper        — 瀏覽器內的 WASM（vendor/ 裡的 whisper-base + ONNX Runtime）。
 *                    不必安裝任何東西，但慢、而且中文明顯較差。原生那條不可用時的備援。
 *
 * 曾經有第三條 Deepgram（雲端、按量計費），已整個移除：這個專案只花
 * Claude Pro 訂閱的錢，留著付費路線就有誤觸的可能。
 *
 * 兩者都拿不到真實姓名 —— 姓名只有平台字幕才有，所以字幕會拿來做姓名校正。
 *
 * ── 分段長度是量出來的，不是猜的 ────────────────────────────────
 * whisper 的編碼器不論音檔多長都跑滿 30 秒的窗，所以**每次呼叫有固定成本**，
 * 段落越短越吃虧。這台機器（i7-4720HQ、無可用 GPU）實測 RTF：
 *
 *   原生 small：6s→0.83　10s→0.54　12s→0.47　15s→0.40　20s→0.34
 *   原生 base ：6s→0.30　10s→0.20　12s→0.17　15s→0.15　20s→0.13
 *   WASM base ：3.4s→1.52（跟不上）　16.6s→0.50　31.7s→0.55
 *
 * 於是原生走 12 秒一段（延遲約 18 秒，RTF 0.47 還有兩倍餘裕），
 * WASM 走 20 秒一段。開會時 CPU 被視訊佔用會讓 RTF 上升，所以
 * 連續落後時會自動把段落拉長（見 noteDrop）。
 */

const TARGET_RATE = 16000;
const OVERLAP_SEC = 2;
const SILENCE_RMS = 0.004;     // 低於此值視為沒人講話，不送去辨識
const MAX_QUEUE = 1;           // 積壓超過這個就丟掉最舊的，寧可漏也不要越落後

const CHUNK_SEC_BY_ENGINE = { 'whisper-native': 12, whisper: 20 };
const MAX_CHUNK_SEC = 30;      // 再長就超過 whisper 的 30 秒窗，得多跑一輪編碼器

let mediaStream = null;
let recorder = null;
let socket = null;
let audioCtx = null;
const sessionId = `audio-${Date.now().toString(36)}`;
const liveBySpeaker = new Map();   // speaker -> {id, text}

let engineName = 'whisper-native';
let chunkSec = CHUNK_SEC_BY_ENGINE['whisper-native'];
let transcribe = null;         // async (Float32Array) => 文字
let worker = null;
let processor = null;
let pending = [];              // 等待辨識的音訊
let busy = false;
let carry = new Float32Array(0);
let buf = [];
let bufLen = 0;
let dropped = 0;
let lastResultText = '';       // 給 stripOverlap 比對用
let toTraditionalOn = true;
let nativeEndpoint = '';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'ma:offscreen:start') {
    const opts = msg.options || {};
    let run;
    if (msg.engine === 'whisper') run = startWhisperWasm(msg.streamId, opts);
    else run = startWhisperNative(msg.streamId, opts);
    run.then(() => reply({ ok: true }))
      .catch((err) => reply({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === 'ma:offscreen:stop') {
    stop();
    reply({ ok: true });
    return false;
  }
  return false;
});

/** tabCapture 會把分頁聲音「接走」，必須再輸出一次，否則使用者聽不到會議。 */
async function captureTab(streamId) {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(mediaStream);
  src.connect(audioCtx.destination);
  return src;
}


// ── 音訊處理（兩條 whisper 共用） ───────────────────────────────
function downsample(input, fromRate) {
  if (fromRate === TARGET_RATE) return Float32Array.from(input);
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / (a.length || 1));
}

/**
 * 去掉與上一段重疊的開頭。
 *
 * 分段之間刻意留 2 秒重疊（否則正好切在句子中間會漏字），代價是那 2 秒的話
 * 會被辨識兩次。字幕路徑靠 mergeCaption 處理同一件事，這裡要自己做：
 * 找「上一段的尾端」與「這一段的開頭」最長的相同片段，切掉。
 *
 * 只比對 60 個字以內 —— 2 秒的語音不可能更長，比對太長反而會誤砍
 * 真正重複的話（例如有人連續說了兩次「對、對」）。
 */
function stripOverlap(prev, next) {
  if (!prev || !next) return next;
  const max = Math.min(60, prev.length, next.length);
  for (let k = max; k >= 4; k--) {
    if (prev.endsWith(next.slice(0, k))) return next.slice(k).replace(/^[\s，。、,.!?！？]+/, '');
  }
  return next;
}

/**
 * whisper 對靜音或音樂會吐出括號標記（[BLANK_AUDIO]、(音樂)、【掌聲】）。
 * 伺服器端已經開了 -sns 抑制大部分，這裡是最後一道：整句都在括號裡就丟掉。
 */
function isNoiseOnly(text) {
  return /^[\s]*[[(（【][^\])）】]*[\])）】][\s]*$/.test(text);
}

/** Float32 → 16-bit PCM WAV。whisper-server 收的是檔案，不是原始樣本。 */
function toWavBlob(samples, rate = TARGET_RATE) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // 單聲道
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);   // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);
  let at = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    at += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * 接上音訊圖，每 chunkSec 秒切一段丟進佇列。
 *
 * chunkSec 每次切段時重讀，所以 noteDrop 拉長段落後會立刻生效。
 */
function startChunker(src) {
  // ScriptProcessorNode 雖然已棄用，但這裡只做「複製 + 降取樣」，
  // 推論在 Worker 或另一個程序裡，主執行緒不會被卡住，實務上夠穩。
  processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    const down = downsample(e.inputBuffer.getChannelData(0), audioCtx.sampleRate);
    buf.push(down);
    bufLen += down.length;
    if (bufLen < chunkSec * TARGET_RATE) return;

    const merged = new Float32Array(carry.length + bufLen);
    merged.set(carry, 0);
    let at = carry.length;
    for (const b of buf) { merged.set(b, at); at += b.length; }
    buf = []; bufLen = 0;
    carry = merged.slice(Math.max(0, merged.length - OVERLAP_SEC * TARGET_RATE));

    // 這段音訊實際「被說出來」的時間，不是辨識完成的時間。
    // 逐字稿要照說話時間排序 —— 辨識要十幾秒，麥克風是即時的，
    // 用完成時間排會讓兩邊的對話交錯錯亂。
    const startedAt = Date.now() - Math.round((merged.length / TARGET_RATE) * 1000);

    // Whisper 對靜音會產生幻覺文字（「謝謝大家」之類），所以先擋掉
    if (rms(merged) < SILENCE_RMS) return;
    enqueue(merged, startedAt);
  };

  // 必須接上 destination，ScriptProcessorNode 才會被排程執行。
  // 增益設 0，避免把聲音再放一次造成回音。
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  src.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);
}

/**
 * 落後的處置。
 *
 * 只丟最舊的那段（MAX_QUEUE = 1）：積壓下去只會越來越晚，寧可漏一段。
 * 每次略過都跳橫幅會把畫面洗掉，而且落後通常是連續發生的，所以只在
 * 第一次與之後每 5 段回報一次。
 *
 * 連續落後三次就把段落拉長 4 秒：每次呼叫有固定成本，段落越長 RTF 越低，
 * 所以「跟不上」的正確反應是加長而不是縮短。上限 30 秒 ——
 * 再長就超過 whisper 的 30 秒窗，得多跑一輪編碼器，反而更慢。
 */
function noteDrop() {
  dropped += 1;
  if (dropped % 3 === 0 && chunkSec < MAX_CHUNK_SEC) {
    chunkSec = Math.min(MAX_CHUNK_SEC, chunkSec + 4);
    notifyNote(`辨識跟不上，已把分段從 ${chunkSec - 4} 秒拉長到 ${chunkSec} 秒（段落越長每秒成本越低）。發言會延遲得久一些，但不會再一直漏。`);
  }
  if (dropped === 1 || dropped % 5 === 0) {
    notifyError(`本機辨識跟不上，已略過 ${dropped} 段。開會時 CPU 被視訊佔用會發生這種情況。`);
  }
}

function enqueue(audio, startedAt) {
  pending.push({ audio, startedAt });
  while (pending.length > MAX_QUEUE) {
    pending.shift();
    noteDrop();
  }
  pump();
}

async function pump() {
  if (busy || !pending.length || !transcribe) return;
  const job = pending.shift();
  busy = true;
  try {
    const raw = await transcribe(job.audio);
    handleResult(raw, job.startedAt);
  } catch (err) {
    notifyError(`本機辨識錯誤：${String(err.message || err)}`);
  } finally {
    busy = false;
    // 這一段處理期間可能又切了新的段落
    if (pending.length) pump();
  }
}

function handleResult(raw, startedAt) {
  const full = String(raw || '').trim();
  if (!full || isNoiseOnly(full)) return;

  let text = stripOverlap(lastResultText, full);
  // 比對用的一律是「這一段的完整結果」，不是切掉之後的 ——
  // 否則下一段會拿被截斷的尾巴去比，重疊就抓不到了。
  lastResultText = full;
  if (!text) return;

  // whisper small 的中文明顯比 base 準，但輸出簡體。在這裡做確定性轉換，
  // 而不是用 initial prompt 引導 —— 實測 prompt 會讓「對帳」變成「對戰」。
  if (toTraditionalOn && typeof globalThis.toTraditional === 'function') {
    text = globalThis.toTraditional(text);
  }
  emit(`${sessionId}-${Date.now().toString(36)}`, '其他人（本機辨識）', text, true, startedAt);
}

// ── 本機原生 whisper.cpp（HTTP 到 127.0.0.1） ──────────────────
async function startWhisperNative(streamId, options) {
  stop();
  engineName = 'whisper-native';
  chunkSec = CHUNK_SEC_BY_ENGINE['whisper-native'];
  toTraditionalOn = options.toTraditional !== false;
  nativeEndpoint = options.endpoint || 'http://127.0.0.1:8317/inference';

  const src = await captureTab(streamId);
  transcribe = nativeTranscribe;
  startChunker(src);

  notifyNote(`本機原生辨識已就緒（${options.model || 'small'} 模型，完全離線）。每 ${chunkSec} 秒產出一段，所以其他人的發言會延遲約 ${chunkSec + 6} 秒。`);
}

async function nativeTranscribe(audio) {
  const form = new FormData();
  form.append('file', toWavBlob(audio), 'chunk.wav');
  form.append('response_format', 'json');

  // 逾時要比「最壞情況」寬：段落 30 秒、RTF 1.5（CPU 被搶光）也才 45 秒。
  // 沒有逾時的話伺服器卡住會讓整條線永遠 busy，之後每一段都被丟掉。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), chunkSec * 3000 + 20000);
  try {
    const res = await fetch(nativeEndpoint, { method: 'POST', body: form, signal: ctrl.signal });
    if (!res.ok) throw new Error(`伺服器回應 ${res.status}`);
    const json = await res.json();
    return String(json.text || '');
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('本機辨識逾時');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── 瀏覽器內 WASM whisper（備援） ───────────────────────────────
async function startWhisperWasm(streamId, options) {
  stop();
  engineName = 'whisper';
  chunkSec = CHUNK_SEC_BY_ENGINE.whisper;
  toTraditionalOn = options.toTraditional !== false;

  const src = await captureTab(streamId);
  const modelId = options.modelId || 'Xenova/whisper-base';

  worker = new Worker(chrome.runtime.getURL('src/offscreen/whisper-worker.js'), { type: 'module' });
  const jobs = new Map();
  let seq = 0;

  // 讓還在等的工作全部失敗。Worker 掛掉（或模型載入失敗）時如果不做這件事，
  // 那些 promise 永遠不會 settle，pump 的 busy 就永遠是 true —— 之後每一段
  // 音訊都會被當成「積壓」丟掉，而且畫面上只會看到一次載入失敗的訊息。
  const failAll = (reason) => {
    for (const [, job] of jobs) job.reject(new Error(reason));
    jobs.clear();
  };

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      notifyNote(`瀏覽器內建辨識已就緒（載入 ${(msg.ms / 1000).toFixed(1)} 秒）。每 ${chunkSec} 秒產出一段，發言會延遲約 ${chunkSec + 10} 秒。裝了原生辨識會明顯更準也更快。`);
      return;
    }
    // 載入失敗回報的 error 沒有 id（不屬於任何一次辨識），要單獨處理，
    // 否則整段訊息會被 jobs.get(undefined) 吃掉，使用者什麼都看不到。
    if (msg.type === 'error' && !msg.id) {
      notifyError(`本機辨識載入失敗：${msg.error}`);
      failAll(msg.error);
      return;
    }
    const job = jobs.get(msg.id);
    if (!job) return;
    jobs.delete(msg.id);
    if (msg.type === 'error') job.reject(new Error(msg.error));
    else job.resolve(msg.text || '');
  };
  worker.onerror = (e) => {
    notifyError(`本機辨識載入失敗：${e.message}`);
    failAll(e.message || 'worker 錯誤');
  };
  worker.postMessage({ type: 'load', modelId });

  transcribe = (audio) => new Promise((resolve, reject) => {
    const id = `w-${++seq}`;
    // 首次呼叫要等模型載入（實測約 30 秒），所以逾時得寬一些
    const timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error('瀏覽器內建辨識逾時'));
    }, 120000);
    jobs.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    worker.postMessage({ type: 'transcribe', id, audio, modelId }, [audio.buffer]);
  });

  startChunker(src);
}

// ── 回報 ────────────────────────────────────────────────────────
function emit(id, speaker, text, final, startedAt) {
  chrome.runtime.sendMessage({
    type: 'ma:segment',
    payload: {
      id, speaker, text, final,
      // startedAt 是「這句話被說出來」的時間，ts 是「辨識完成」的時間。
      // 逐字稿照 startedAt 排序，本機辨識的延遲才不會把順序弄亂。
      ts: Date.now(), startedAt: startedAt || Date.now(),
      source: 'audio', platform: 'audio-fallback',
      sessionId, title: '音訊備援',
    },
  }, () => void chrome.runtime.lastError);
}

function notifyError(message) {
  chrome.runtime.sendMessage({ type: 'ma:audioError', message },
    () => void chrome.runtime.lastError);
}

function notifyNote(message) {
  chrome.runtime.sendMessage({ type: 'ma:audioNote', message },
    () => void chrome.runtime.lastError);
}

function stop() {
  try { recorder?.state !== 'inactive' && recorder?.stop(); } catch {}
  try { socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
  try { socket?.close(1000); } catch {}
  try { processor && (processor.onaudioprocess = null); } catch {}
  try { processor?.disconnect(); } catch {}
  try { worker?.terminate(); } catch {}
  try { mediaStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx?.close(); } catch {}
  recorder = null; socket = null; mediaStream = null; audioCtx = null;
  processor = null; worker = null; transcribe = null;
  pending = []; busy = false; buf = []; bufLen = 0; dropped = 0;
  carry = new Float32Array(0);
  lastResultText = '';
  liveBySpeaker.clear();
}
