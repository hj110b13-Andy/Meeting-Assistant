/**
 * 本機語音辨識（Whisper）—— 跑在 Web Worker 裡。
 *
 * 為什麼要用 Worker：offscreen 的主執行緒負責收音（ScriptProcessorNode 的
 * callback）。推論是一次好幾秒的同步 WASM 運算，如果跑在主執行緒上，
 * 收音 callback 會被餓死 → 推論期間的聲音全部遺失。
 *
 * 模型與 ONNX Runtime 都內建在 vendor/，執行期不連任何伺服器：
 * MV3 禁止載入遠端程式，而且這條路線的重點就是零費用、資料不外流。
 *
 * 實測（GTX 960M／8GB RAM／WASM，WebGPU 在該機器不可用）：
 *   每次呼叫有約 4 秒固定成本（encoder 固定跑 30 秒視窗），所以
 *     3.4 秒音檔 → 5.1 秒（RTF 1.52，跟不上）
 *    16.6 秒音檔 → 8.4 秒（RTF 0.50）
 *    31.7 秒音檔 → 17.4 秒（RTF 0.55）
 *   結論：**分段要長**。短分段會越跑越落後。
 */

let asr = null;
let loading = null;

async function ensureModel(modelId) {
  if (asr) return asr;
  if (loading) return loading;

  loading = (async () => {
    const { pipeline, env } = await import('/vendor/transformers/transformers.min.js');

    // 全部走本機檔案。allowRemoteModels 關掉，避免任何情況下偷偷連 huggingface。
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = '/vendor/models/';
    env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';

    asr = await pipeline('automatic-speech-recognition', modelId, { dtype: 'q8' });
    return asr;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'load') {
    try {
      const t0 = performance.now();
      await ensureModel(msg.modelId);
      self.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err.message || err) });
    }
    return;
  }

  if (msg.type === 'transcribe') {
    try {
      const model = await ensureModel(msg.modelId);
      const t0 = performance.now();
      const res = await model(msg.audio, {
        language: msg.language || 'chinese',
        task: 'transcribe',
        chunk_length_s: 30,
        // 不做 timestamp：會多一輪解碼，這台機器的餘裕不夠
        return_timestamps: false,
      });
      self.postMessage({
        type: 'result',
        id: msg.id,
        text: (res.text || '').trim(),
        ms: Math.round(performance.now() - t0),
        audioSec: msg.audio.length / 16000,
      });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, error: String(err.message || err) });
    }
  }
};
