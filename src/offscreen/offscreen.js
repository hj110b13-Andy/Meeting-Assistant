/**
 * 聽會議分頁的聲音，轉成逐字稿。三個引擎，**都不會產生按量費用**：
 *
 *   groq           — GroqCloud 的 whisper-large-v3-turbo。**這是預設。**
 *                    免費方案（不需信用卡，撞到上限是回 429，不是開始計費）。
 *                    音訊會離開這台電腦，這是唯一的取捨 —— 換來的是下面那張表。
 *   whisper-native — 本機執行的 whisper.cpp（%LOCALAPPDATA%\MeetingAssistant\whisper），
 *                    由 bridge 啟動成一台只綁 127.0.0.1 的小伺服器。
 *                    零費用、資料不出這台電腦、不需金鑰。沒有金鑰時的備援。
 *   whisper        — 瀏覽器內的 WASM（vendor/ 裡的 whisper-base + ONNX Runtime）。
 *                    不必安裝任何東西，但慢、而且中文明顯較差。最後的備援。
 *
 * 三者都拿不到真實姓名 —— 姓名只有平台字幕才有，所以字幕會拿來做姓名校正。
 *
 * ── 為什麼預設從本機換成雲端 ────────────────────────────────────
 * 同一段 16.6 秒的中文會議錄音，這台機器（i7-4720HQ、無可用 GPU）實測：
 *
 *   引擎                          RTF    逐字稿
 *   Groq whisper-large-v3-turbo   0.06   全對，標點齊全
 *   本機原生 small                0.47   大致正確
 *   瀏覽器 WASM base              0.50   這季／結帳／對帳／小陳 全錯
 *
 * **快 8 倍而且一字未錯。** 本機 small 在真實會議裡的問題是它「大致正確」——
 * 摘要與回答建議吃的是逐字稿，錯一個關鍵詞（對帳→對戰）整段推論就歪了。
 *
 * ── 分段長度是量出來的，不是猜的 ────────────────────────────────
 * whisper 的編碼器不論音檔多長都跑滿 30 秒的窗，所以**每次呼叫有固定成本**，
 * 段落越短越吃虧。本機引擎實測 RTF：
 *
 *   原生 small：6s→0.83　10s→0.54　12s→0.47　15s→0.40　20s→0.34
 *   原生 base ：6s→0.30　10s→0.20　12s→0.17　15s→0.15　20s→0.13
 *   WASM base ：3.4s→1.52（跟不上）　16.6s→0.50　31.7s→0.55
 *
 * 於是原生走 12 秒一段，WASM 走 20 秒一段。雲端那條瓶頸完全不同 ——
 * 不是算得慢，是**每分鐘只能打 20 次**，所以改用合併而不是丟棄（見 enqueue）。
 */

const TARGET_RATE = 16000;
const OVERLAP_SEC = 2;
const SILENCE_RMS = 0.004;     // 低於此值視為沒人講話

// ── VAD 切段參數 ───────────────────────────────────────────────
// 靜音多久算「這句講完了」。太短會把句中的換氣當成句尾（切成碎片），
// 太長則每段都要等很久才送出。0.7 秒是一般中文口語停頓的下限。
const CUT_SILENCE_MS = 700;
// 講不停時的上限。whisper 的窗是 30 秒，超過要多跑一輪 encoder。
const MAX_CHUNK_SEC = 24;
// 比這短的片段不送（咳嗽、單一個「嗯」只會得到幻覺文字）
const MIN_CHUNK_SEC = 1.0;

// 完全收不到聲音時要講出來。分頁被靜音、或只有自己在會議裡的時候，
// 症狀是「聆聽中 · 0 段」而且完全沒有線索 —— 那種安靜的失敗最難查。
const SILENT_WARN_MS = 30000;
let silentMs = 0;
let quietMs = 0;
let silentWarned = false;
const MAX_QUEUE = 1;           // 積壓超過這個就丟掉最舊的，寧可漏也不要越落後

// WASM 備援那條仍然用固定間隔切段（它跑在 Worker 裡，改動風險不值得），
// 原生與雲端那兩條已改成 VAD 切段，不再用這個表。
const CHUNK_SEC_BY_ENGINE = { 'whisper-native': 12, whisper: 20, groq: 12 };

// ── 雲端辨識的節流 ──────────────────────────────────────────────
// Groq 免費方案對 whisper-large-v3-turbo 的限制是 **20 RPM**
// （另有 7,200 音訊秒／小時、28,800 音訊秒／天，但那兩個對「一小時的會議
// 產生一小時的音訊」來說綽綽有餘，真正會先撞到的是每分鐘的請求數）。
//
// 3,400 毫秒 ≈ 17.6 RPM，留一點餘裕給重試。
const CLOUD_MIN_INTERVAL_MS = 3400;
// 合併的上限。whisper 的窗是 30 秒，超過要多跑一輪 encoder，
// 而且一段太長會讓逐字稿變成一大塊、難讀也難對上說話者。
const CLOUD_MERGE_MAX_SEC = 28;
let lastCloudSentAt = 0;
let cloudTimer = null;
let cloudKey = '';
let cloudModel = 'whisper-large-v3-turbo';
let cloudPrompt = '';
let merged = 0;                // 因為節流而被合併的段數，只拿來說明用

// 逐字稿上的說話者標籤。拿不到真實姓名（那只有平台字幕有），
// 但至少要讓使用者看得出這行是哪個引擎產生的 —— 出問題時這是第一個線索。
let speakerLabel = '其他人（本機辨識）';

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
    if (msg.engine === 'groq') run = startGroq(msg.streamId, opts);
    else if (msg.engine === 'whisper') run = startWhisperWasm(msg.streamId, opts);
    else run = startWhisperNative(msg.streamId, opts);
    run.then(() => reply({ ok: true }))
      .catch((err) => reply({ ok: false, error: String(err.message || err) }));
    return true;
  }
  // 串流已經接住之後才發現原生辨識起不來。**不能重接串流** —— streamId
  // 已經用掉了（而且幾秒就過期），所以這裡只把引擎標記換掉並清空佇列，
  // 由背景告訴使用者發生什麼事。要真的換成 WASM 得重新走一次 start 流程。
  if (msg?.type === 'ma:offscreen:engine') {
    engineName = msg.engine;
    pending.length = 0;
    reply({ ok: true });
    return false;
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
 * whisper 的幻覺文字，不是真的有人講的話。
 *
 * 兩類：
 *   1. 括號標記（[BLANK_AUDIO]、(音樂)、【掌聲】）—— 伺服器端的 -sns
 *      已經抑制大部分，這裡是最後一道。
 *   2. **訓練資料裡的字幕組署名。** whisper 的中文訓練資料含大量帶字幕的
 *      影片，所以聽到近似靜音或無意義的聲音時，很容易吐出「字幕by索蘭婭」、
 *      「請不吝點贊訂閱」這類句子。實測的逐字稿裡真的出現過 ——
 *      這些混進去會一路汙染摘要與回答建議。
 */
const HALLUCINATIONS = [
  /字幕\s*by/i,
  /字幕志願者/,
  /请不吝|請不吝/,
  /点赞|點贊|訂閱|订阅/,
  /明鏡與點點欄目|明镜与点点栏目/,
  /^(謝謝(大家|觀看|收看)|谢谢(大家|观看|收看))[。.!！]?$/,
  /^(下集再見|下集再见|再見|再见)[。.!！]?$/,
  /^(MUQ|muq)$/,
];

function isNoiseOnly(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^[\s]*[[(（【][^\])）】]*[\])）】][\s]*$/.test(t)) return true;
  return HALLUCINATIONS.some((re) => re.test(t));
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
 * 把累積的音訊送去辨識。**只在「講完一句」或「講太久」時呼叫。**
 *
 * 舊版是每 12 秒硬切一次，不管當下有沒有人在講話。實測的逐字稿長這樣：
 *
 *   [22:46:28] 你
 *   [22:46:39] 麥克風
 *   [22:46:52] 剛剛好嗎
 *
 * 每 12 秒才兩三個字 —— 因為句子被從中間切開，whisper 拿到的是半句話，
 * 前後文都沒了，辨識自然又短又錯。改成在靜音處切之後，一段就是一句話。
 */
function flushChunk() {
  if (!bufLen) return;

  const merged = new Float32Array(carry.length + bufLen);
  merged.set(carry, 0);
  let at = carry.length;
  for (const b of buf) { merged.set(b, at); at += b.length; }
  buf = []; bufLen = 0; quietMs = 0;
  // 留一點尾巴當下一段的前文，接在句子邊界時幫助不大但無害
  carry = merged.slice(Math.max(0, merged.length - OVERLAP_SEC * TARGET_RATE));

  // 太短的片段（咳嗽、一聲「嗯」）送去辨識只會得到幻覺文字
  if (merged.length < MIN_CHUNK_SEC * TARGET_RATE) return;

  // 這段音訊實際「被說出來」的時間，不是辨識完成的時間。
  // 逐字稿要照說話時間排序，用完成時間排會讓對話順序錯亂。
  const startedAt = Date.now() - Math.round((merged.length / TARGET_RATE) * 1000);
  enqueue(merged, startedAt);
}

/** 接上音訊圖。切段由 VAD 決定（見 flushChunk），不是固定間隔。 */
function startChunker(src) {
  // ScriptProcessorNode 雖然已棄用，但這裡只做「複製 + 降取樣」，
  // 推論在 Worker 或另一個程序裡，主執行緒不會被卡住，實務上夠穩。
  //
  // **輸入宣告成 2 聲道，不是 1。** 分頁音訊通常是立體聲，宣告成單聲道時
  // ScriptProcessorNode 的 channel 對應不保證是「混音後的結果」——
  // 實測會拿到空的（全 0）緩衝，症狀是「聆聽中但永遠 0 段」。
  // 自己把兩聲道相加平均，比依賴瀏覽器的降混行為可靠。
  processor = audioCtx.createScriptProcessor(4096, 2, 1);

  processor.onaudioprocess = (e) => {
    const inBuf = e.inputBuffer;
    const ch0 = inBuf.getChannelData(0);
    let mono;
    if (inBuf.numberOfChannels > 1) {
      const ch1 = inBuf.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    } else {
      mono = ch0;
    }
    const down = downsample(mono, audioCtx.sampleRate);
    const level = rms(down);

    // ── 靜音偵測：沒人講話時不要累積，也不要送去辨識 ──────────
    if (level < SILENCE_RMS) {
      quietMs += (down.length / TARGET_RATE) * 1000;
      // 完全沒收到過聲音時要講出來，否則畫面永遠是 0 段又沒有線索
      if (!bufLen) {
        silentMs += (down.length / TARGET_RATE) * 1000;
        if (silentMs >= SILENT_WARN_MS && !silentWarned) {
          silentWarned = true;
          notifyError(`聽了 ${Math.round(silentMs / 1000)} 秒都沒有聲音（音量 ${level.toFixed(5)}）。`
            + '請確認：會議分頁沒有被靜音（分頁上的喇叭圖示）、而且會議中真的有人在說話。'
            + '注意 tabCapture 抓的是分頁「播放出來」的聲音，你自己的麥克風不會經過這裡。');
        }
        return;
      }
      // 講完一句了（靜音夠久）→ 現在切，句子才不會被腰斬
      if (quietMs >= CUT_SILENCE_MS) flushChunk();
      return;
    }

    // 有聲音
    if (silentWarned) {
      notifyNote(`聽到聲音了（音量 ${level.toFixed(3)}），逐字稿即將出現。`);
      silentWarned = false;
    }
    silentMs = 0;
    quietMs = 0;
    buf.push(down);
    bufLen += down.length;

    // 一直講不停的話還是要切，否則會超過 whisper 的 30 秒窗
    if (bufLen >= MAX_CHUNK_SEC * TARGET_RATE) flushChunk();
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
 * 改成 VAD 切段之後，段落長度由「講多久」決定，不再是可調的參數 ——
 * 所以這裡只回報，不再自動拉長（拉長會把兩句話黏成一段，反而更難讀）。
 */
function noteDrop() {
  dropped += 1;
  if (dropped === 1 || dropped % 5 === 0) {
    notifyError(`本機辨識跟不上，已略過 ${dropped} 段。開會時 CPU 被視訊佔用會發生這種情況。`);
  }
}

/**
 * 辨識失敗的回報。**同一個錯誤只講一次。**
 *
 * 辨識錯誤幾乎都是持續性的：金鑰被拒、額度用完、網路斷掉 —— 一旦發生，
 * 接下來每一段（雲端約 3–5 秒一段）都會用完全一樣的訊息再失敗一次。
 * 沒有節流的話，一場一小時的會議會推出好幾百則一模一樣的橫幅，
 * 把真正需要看到的訊息全部洗掉，看起來也像擴充功能自己壞了。
 *
 * 所以只在**訊息內容改變**時回報，並帶上累計次數 —— 使用者仍然看得出
 * 「這件事一直在發生」，但不會被同一句話洗版。
 */
let sameError = { message: '', count: 0 };

function noteTranscribeError(message) {
  if (message === sameError.message) {
    sameError.count += 1;
    // 持續失敗仍然要偶爾提醒一次，否則使用者以為已經恢復了
    if (sameError.count % 10 !== 0) return;
    notifyError(`${message}（已連續失敗 ${sameError.count} 次）`);
    return;
  }
  sameError = { message, count: 1 };
  notifyError(message);
}

function enqueue(audio, startedAt) {
  // 雲端那條的瓶頸是「每分鐘幾次請求」，不是「算得多快」。
  // 丟掉等於白白丟掉使用者講的話，而合併不會 —— 兩段黏起來送一次，
  // 內容一個字都不會少，代價只是那一段的逐字稿晚幾秒出現。
  if (engineName === 'groq') {
    const tail = pending[pending.length - 1];
    if (tail && tail.audio.length + audio.length <= CLOUD_MERGE_MAX_SEC * TARGET_RATE) {
      const combined = new Float32Array(tail.audio.length + audio.length);
      combined.set(tail.audio, 0);
      combined.set(audio, tail.audio.length);
      tail.audio = combined;     // startedAt 保留較早的那個，排序才不會亂
      merged += 1;
      pump();
      return;
    }
    pending.push({ audio, startedAt });
    pump();
    return;
  }

  pending.push({ audio, startedAt });
  while (pending.length > MAX_QUEUE) {
    pending.shift();
    noteDrop();
  }
  pump();
}

async function pump() {
  if (busy || !pending.length || !transcribe) return;

  // 雲端要自己守住每分鐘的請求數。還沒到時間就掛一個計時器等，
  // **不要在這裡丟掉工作** —— 佇列裡的東西會在等待期間被合併（見 enqueue）。
  if (engineName === 'groq') {
    const wait = CLOUD_MIN_INTERVAL_MS - (Date.now() - lastCloudSentAt);
    if (wait > 0) {
      if (!cloudTimer) {
        cloudTimer = setTimeout(() => { cloudTimer = null; pump(); }, wait);
      }
      return;
    }
    lastCloudSentAt = Date.now();
  }

  const job = pending.shift();
  busy = true;
  try {
    const raw = await transcribe(job.audio);
    handleResult(raw, job.startedAt);
    sameError = { message: '', count: 0 };   // 成功一次就把重複計數清掉
  } catch (err) {
    noteTranscribeError(`${engineName === 'groq' ? '雲端' : '本機'}辨識錯誤：${String(err.message || err)}`);
  } finally {
    busy = false;
    // 這一段處理期間可能又切了新的段落
    if (pending.length) pump();
  }
}

/**
 * 把辨識結果變成逐字稿段落。
 *
 * `raw` 可以是一整段字串（本機引擎），也可以是 `{ text, parts }`（雲端，
 * parts 帶著每一句的相對秒數）。**有 parts 的時候要一句一段地送出**，
 * 每一段配上自己的絕對說話時間 —— 背景就能替每一句各自對上正確的姓名。
 * 全部黏成一段的話，一塊 28 秒的音訊會整段掛在同一個人名下，
 * 而那 28 秒裡換過三次人是很正常的。
 */
function handleResult(raw, startedAt) {
  const parts = Array.isArray(raw?.parts) && raw.parts.length ? raw.parts : null;
  const full = String((raw && raw.text !== undefined ? raw.text : raw) || '').trim();
  if (!full || isNoiseOnly(full)) return;

  const trimmed = stripOverlap(lastResultText, full);
  // 比對用的一律是「這一段的完整結果」，不是切掉之後的 ——
  // 否則下一段會拿被截斷的尾巴去比，重疊就抓不到了。
  lastResultText = full;
  if (!trimmed) return;

  if (!parts) {
    emitPiece(trimmed, startedAt);
    return;
  }

  // stripOverlap 砍掉的是**開頭**若干字（上一塊音訊尾巴的重複）。
  // 同樣的字數要從最前面的 parts 扣掉，否則重疊的內容會又出現一次。
  let toDrop = full.length - trimmed.length;
  for (const p of parts) {
    let text = p.text;
    if (toDrop > 0) {
      if (toDrop >= text.length) { toDrop -= text.length; continue; }
      text = text.slice(toDrop);
      toDrop = 0;
    }
    // 逐句過濾雜訊與幻覺：整段看起來正常，但其中一句可能是 [BLANK_AUDIO]
    if (!text.trim() || isNoiseOnly(text)) continue;
    emitPiece(text, startedAt + Math.round(p.start * 1000));
  }
}

function emitPiece(text, startedAt) {
  // whisper small 的中文明顯比 base 準，但輸出簡體。在這裡做確定性轉換，
  // 而不是用 initial prompt 引導 —— 實測 prompt 會讓「對帳」變成「對戰」。
  let out = text.trim();
  if (toTraditionalOn && typeof globalThis.toTraditional === 'function') {
    out = globalThis.toTraditional(out);
  }
  if (!out) return;
  // id 要含 startedAt：同一塊音訊會在同一毫秒送出好幾句，只用 Date.now()
  // 的話它們會拿到同一個 id，背景的 upsertSegment 會把它們**互相覆蓋**，
  // 28 秒的音訊最後只留下一句。
  emit(`${sessionId}-${startedAt.toString(36)}-${(pieceSeq++).toString(36)}`,
    speakerLabel, out, true, startedAt);
}

let pieceSeq = 0;

// ── 雲端 whisper（GroqCloud） ──────────────────────────────────
/**
 * Groq 的 whisper-large-v3-turbo。
 *
 * 音訊會離開這台電腦 —— 這是相對本機那條唯一的取捨，而且**必須讓使用者知道**，
 * 所以起動時的說明會直接寫出來。換來的是 RTF 0.06（本機 small 是 0.47）
 * 與明顯更好的中文準確度。
 */
async function startGroq(streamId, options) {
  stop();
  engineName = 'groq';
  chunkSec = CHUNK_SEC_BY_ENGINE.groq;
  toTraditionalOn = options.toTraditional !== false;
  speakerLabel = '其他人（雲端辨識）';
  cloudKey = options.groqKey || '';
  cloudModel = options.groqSttModel || 'whisper-large-v3-turbo';
  // 提示詞在這裡是**用來指定書寫系統**，不是用來餵詞彙的。
  // 實測：不給提示詞會吐簡體，給一句繁體的提示詞就直接吐繁體。
  // 仍然保留 s2t 轉換當保險 —— 提示詞的效果沒有保證，而 s2t 對已經是
  // 繁體的文字是無害的空操作。
  cloudPrompt = options.groqPrompt || '以下是繁體中文（台灣）的會議逐字稿。';
  lastCloudSentAt = 0;

  if (!cloudKey) throw new Error('沒有 Groq 金鑰');

  const src = await captureTab(streamId);
  transcribe = groqTranscribe;
  startChunker(src);

  const tracks = mediaStream?.getAudioTracks?.() || [];
  const trackInfo = tracks.length
    ? `音軌 ${tracks.length} 條（${tracks.map((t) => (t.enabled ? '啟用' : '停用')).join('、')}）`
    : '**沒有音軌** —— 這個分頁可能沒有在播放聲音';
  notifyNote(`雲端辨識已就緒（Groq ${cloudModel}）。${trackInfo}。`
    + '每講完一句話（停頓約 0.7 秒）就辨識一次，通常 1 秒內回來。'
    + '注意：這條路會把會議音訊送到 Groq 的伺服器辨識。要完全離線請改用本機引擎。');
}

/**
 * 打一次 Groq 的辨識，回傳 `{ text, parts }`。
 *
 * ## 為什麼要 verbose_json 而不是 json
 *
 * whisper **完全不做說話者分離** —— 回來的就是一整段文字。真實姓名只有平台
 * 字幕有，所以背景會拿「說話時間」去比對字幕記到的人（見 service-worker 的
 * speakerAt）。問題是一次請求的音訊可能橫跨好幾個人：雲端這條為了守住
 * 20 RPM 會把相鄰段落合併到 28 秒，28 秒裡換三次人是很正常的。
 * 只有一個時間點可比對的話，整段 28 秒都會被安到同一個人頭上。
 *
 * `verbose_json` ＋ `timestamp_granularities[]=segment` 讓 whisper 把它自己
 * 切出來的每一句都附上 start／end（相對於這塊音訊的秒數）。加上這塊音訊的
 * 起始時間就是每一句的**絕對說話時間**，於是每一句都能各自對上正確的人。
 *
 * 這不會多花額度也不會慢 —— 同一次請求，只是要求更詳細的回應格式。
 */
async function groqTranscribe(audio) {
  const form = new FormData();
  form.append('file', toWavBlob(audio), 'chunk.wav');
  form.append('model', cloudModel);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  // 指定語言可以省掉模型自己偵測的那一步，也避免中文被誤判成日文
  form.append('language', 'zh');
  if (cloudPrompt) form.append('prompt', cloudPrompt);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloudKey}` },
      body: form,
      signal: ctrl.signal,
    });

    if (res.status === 429) {
      // 撞到額度**不是**開始計費，是直接被拒。但使用者會看到逐字稿停住，
      // 所以要講清楚是哪一種停 —— 否則看起來跟當機一樣。
      const retry = res.headers.get('retry-after');
      throw new Error(`Groq 免費額度暫時用完${retry ? `（約 ${retry} 秒後恢復）` : ''}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Groq 金鑰被拒（${res.status}）—— 請到設定頁確認金鑰`);
    }
    if (!res.ok) throw new Error(`Groq 回應 ${res.status}`);

    const json = await res.json();
    // parts 是「這塊音訊裡的每一句 + 它的相對秒數」。**verbose_json 的支援
    // 不能假設永遠都在**（換模型、API 改版都可能讓 segments 消失），
    // 所以拿不到就退回整段文字 —— 逐字稿仍然完整，只是姓名的粒度變粗。
    const parts = Array.isArray(json.segments)
      ? json.segments
          .map((s) => ({
            text: String(s.text || '').trim(),
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
          }))
          .filter((s) => s.text)
      : [];
    return { text: String(json.text || ''), parts };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('雲端辨識逾時（45 秒）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── 本機原生 whisper.cpp（HTTP 到 127.0.0.1） ──────────────────
async function startWhisperNative(streamId, options) {
  stop();
  engineName = 'whisper-native';
  chunkSec = CHUNK_SEC_BY_ENGINE['whisper-native'];
  toTraditionalOn = options.toTraditional !== false;
  speakerLabel = '其他人（本機辨識）';
  nativeEndpoint = options.endpoint || 'http://127.0.0.1:8317/inference';

  const src = await captureTab(streamId);
  transcribe = nativeTranscribe;
  startChunker(src);

  // 把音軌狀態一起講出來。實測遇過「串流接住了但沒有音軌」與「音軌是靜音的」，
  // 兩種的畫面都是「聆聽中 · 0 段」，沒有這行就完全看不出差別。
  const tracks = mediaStream?.getAudioTracks?.() || [];
  const trackInfo = tracks.length
    ? `音軌 ${tracks.length} 條（${tracks.map((t) => (t.enabled ? '啟用' : '停用')).join('、')}）`
    : '**沒有音軌** —— 這個分頁可能沒有在播放聲音';
  notifyNote(`本機原生辨識已就緒（${options.model || 'small'} 模型，完全離線）。${trackInfo}。`
    + '每講完一句話（停頓約 0.7 秒）就辨識一次，所以逐字稿會在對方講完後幾秒出現。');
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
  speakerLabel = '其他人（本機辨識）';

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
  try { cloudTimer && clearTimeout(cloudTimer); } catch {}
  recorder = null; socket = null; mediaStream = null; audioCtx = null;
  processor = null; worker = null; transcribe = null;
  pending = []; busy = false; buf = []; bufLen = 0; dropped = 0;
  cloudTimer = null; lastCloudSentAt = 0; merged = 0;
  silentMs = 0; quietMs = 0; silentWarned = false;
  carry = new Float32Array(0);
  lastResultText = '';
  // 換引擎／重新開始時要清掉，否則新引擎的第一次失敗會被當成舊錯誤的延續而吞掉
  sameError = { message: '', count: 0 };
  liveBySpeaker.clear();
}
