/**
 * 聲紋分離（speaker diarization）—— 把不同的聲音分開，標成「講者 1／2／3」。
 *
 * ## 為什麼需要這條路
 *
 * 語音辨識完全不做說話者分離：whisper 回來的就是一整段文字。原本姓名只有
 * 兩個來源，兩個都靠不住：
 *
 *   1. **會議字幕** —— 要使用者自己在會議裡開啟，很容易漏掉，也常常不想開。
 *   2. **畫面上的發言指示器** —— 實測發現致命問題：**在看共享畫面的時候，
 *      Teams／Meet 根本不顯示視訊磚**，沒有磚就沒有指示器也沒有名牌。
 *      而「有人在分享畫面」正是最需要逐字稿的場合。
 *
 * 聲紋這條不看畫面、不需要字幕、共享畫面時照樣有效 —— 因為它只看聲音本身。
 *
 * ## 做得到與做不到
 *
 * **做得到**：把聲音分成幾群，同一個人的話標成同一個「講者 N」。
 * **做不到**：憑聲音知道那個人叫什麼名字（那不可能，聲音裡沒有姓名）。
 *
 * 所以兩條路是**互補**的，不是替代：聲紋負責「這是不是同一個人」，
 * 字幕／指示器負責「這個人叫什麼」。只要在任何一刻對上過一次名字，
 * `nameCluster()` 就把名字記在那一群上，之後同一個人的話都會顯示真名 ——
 * **即使字幕後來又斷掉了**。這比單靠字幕穩定得多。
 *
 * ## 為什麼是自己寫，而不是用現成的模型
 *
 * 正統的 diarization（pyannote 之類）要另外下載幾百 MB 的模型、要 Python，
 * 而這個專案的前提是免建置、不花錢、退路要能離線跑。而會議的情境其實
 * 比通用 diarization 簡單得多：VAD 已經把音訊切成「一句一段」，每一段
 * 幾乎都只有一個人在講 —— 剩下的只是「這一段跟前面哪一段是同一個人」。
 * 那用 MFCC 統計量 ＋ 線上分群就夠了，而且完全在瀏覽器裡跑、零依賴。
 */
(() => {
  if (globalThis.__MA_VOICEPRINT__) return;

  // ── FFT（radix-2，就地運算）─────────────────────────────────────
  // 自己寫是因為不能引入外部函式庫（免建置、CSP 也不允許外部腳本）。
  // 只需要 forward transform，而且長度固定是 2 的次方，所以很短。
  function fft(re, im) {
    const n = re.length;
    // 位元反轉排序
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang); const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1; let ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k]; const ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  const FRAME = 512;          // 32 毫秒 @16kHz
  const HOP = 256;
  const MEL_BANDS = 26;
  const MFCC_COEFS = 13;      // 丟掉 c0（那是整體音量，跟講話的人無關）
  const SAMPLE_RATE = 16000;

  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

  /**
   * 梅爾濾波器組。**只取 300–3400 Hz**（電話頻寬）：
   * 會議音訊經過各家平台的編碼器壓縮，那個範圍以外的資訊本來就不可靠，
   * 拿進來只會讓不同會議、不同麥克風之間的特徵對不上。
   */
  const melFilters = (() => {
    const nBins = FRAME / 2 + 1;
    const lo = hzToMel(300); const hi = hzToMel(3400);
    const points = [];
    for (let i = 0; i < MEL_BANDS + 2; i++) {
      const mel = lo + (hi - lo) * (i / (MEL_BANDS + 1));
      points.push(Math.floor((melToHz(mel) / (SAMPLE_RATE / 2)) * (nBins - 1)));
    }
    const filters = [];
    for (let b = 0; b < MEL_BANDS; b++) {
      const start = points[b]; const mid = points[b + 1]; const end = points[b + 2];
      const w = new Float32Array(nBins);
      for (let k = start; k <= mid; k++) if (mid > start) w[k] = (k - start) / (mid - start);
      for (let k = mid; k <= end; k++) if (end > mid) w[k] = (end - k) / (end - mid);
      if (mid === start && mid < nBins) w[mid] = 1;
      filters.push(w);
    }
    return filters;
  })();

  /** DCT-II 矩陣，把 log-mel 轉成 MFCC */
  const dctMatrix = (() => {
    const m = [];
    for (let i = 1; i <= MFCC_COEFS; i++) {
      const row = new Float32Array(MEL_BANDS);
      for (let j = 0; j < MEL_BANDS; j++) {
        row[j] = Math.cos((Math.PI * i * (j + 0.5)) / MEL_BANDS);
      }
      m.push(row);
    }
    return m;
  })();

  /**
   * 算一段音訊的聲紋向量。
   *
   * 用 **MFCC 的平均值 ＋ 標準差**，不是只用平均值。標準差帶的是
   * 「這個人講話時頻譜怎麼變化」—— 語調、氣息、共振峰的移動幅度，
   * 而那些比平均值更能區分兩個音色相近的人。
   *
   * **只算有聲音的訊框。** 一段話裡的靜音會把平均值往「無聲的頻譜」拉，
   * 而每個人的靜音聽起來都一樣 —— 靜音佔比不同的兩段話會因此被判成
   * 不同的人，那是實際會發生的誤判來源。
   *
   * 回傳 L2 正規化後的向量（給餘弦相似度用），資訊不足時回傳 null ——
   * **回 null 比回一個亂猜的向量重要**：亂猜會污染分群中心，錯一次之後
   * 整場都跟著錯。
   */
  function embed(audio, sampleRate = SAMPLE_RATE) {
    if (!audio || audio.length < FRAME * 4) return null;

    const re = new Float32Array(FRAME);
    const im = new Float32Array(FRAME);
    // Hann 窗：不加窗的話訊框邊界會產生頻譜洩漏，把不同的聲音抹平
    const window = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

    const sums = new Float64Array(MFCC_COEFS);
    const sumSquares = new Float64Array(MFCC_COEFS);
    let frames = 0;

    // 先算整段的能量門檻：用相對值而不是絕對值，因為不同麥克風的音量差很多
    let peak = 0;
    for (let i = 0; i < audio.length; i++) {
      const a = Math.abs(audio[i]);
      if (a > peak) peak = a;
    }
    if (peak < 1e-4) return null;             // 整段幾乎是靜音
    const gate = peak * 0.08;

    for (let start = 0; start + FRAME <= audio.length; start += HOP) {
      // 這個訊框有沒有聲音
      let frameMax = 0;
      for (let i = 0; i < FRAME; i++) {
        const a = Math.abs(audio[start + i]);
        if (a > frameMax) frameMax = a;
      }
      if (frameMax < gate) continue;

      for (let i = 0; i < FRAME; i++) { re[i] = audio[start + i] * window[i]; im[i] = 0; }
      fft(re, im);

      // 功率頻譜 → 梅爾能量 → 取對數
      const nBins = FRAME / 2 + 1;
      const power = new Float32Array(nBins);
      for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];

      const logMel = new Float32Array(MEL_BANDS);
      for (let b = 0; b < MEL_BANDS; b++) {
        const w = melFilters[b];
        let e = 0;
        for (let k = 0; k < nBins; k++) e += power[k] * w[k];
        logMel[b] = Math.log(e + 1e-10);
      }

      for (let c = 0; c < MFCC_COEFS; c++) {
        const row = dctMatrix[c];
        let v = 0;
        for (let b = 0; b < MEL_BANDS; b++) v += logMel[b] * row[b];
        sums[c] += v;
        sumSquares[c] += v * v;
      }
      frames++;
    }

    // 訊框太少時統計量沒有意義（標準差尤其），寧可不給答案
    if (frames < 8) return null;

    const vec = new Float32Array(MFCC_COEFS * 2);
    for (let c = 0; c < MFCC_COEFS; c++) {
      const mean = sums[c] / frames;
      const variance = Math.max(0, sumSquares[c] / frames - mean * mean);
      vec[c] = mean;
      vec[MFCC_COEFS + c] = Math.sqrt(variance);
    }

    // 各維度的量級差很大（低階 MFCC 遠大於高階），不先縮放的話餘弦相似度
    // 幾乎只反映第一個係數 —— 於是所有人的相似度都是 0.99，永遠分不開。
    // 除以固定的經驗尺度讓每一維的貢獻接近，再做 L2 正規化。
    const scale = [40, 25, 20, 18, 15, 14, 13, 12, 11, 10, 10, 9, 9];
    for (let c = 0; c < MFCC_COEFS; c++) {
      vec[c] /= scale[c];
      vec[MFCC_COEFS + c] /= scale[c];
    }

    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (!(norm > 0)) return null;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  /**
   * 線上分群：每來一段就決定「這是誰」，不能等整場結束再算。
   *
   * 逐字稿是即時顯示的，所以不能用需要看完全部資料的演算法
   * （凝聚式分群、譜分群那些）。線上分群的代價是**開頭幾段可能分錯**，
   * 換來的是每一段都立刻有標籤。
   */
  class SpeakerBook {
    /**
     * @param {object} opts
     *   threshold: 相似度高於這個值就算同一個人。**這是唯一需要調的參數。**
     *              調高 → 同一個人被拆成好幾個講者；調低 → 兩個人被併成一個。
     *              寧可偏高（拆開）：「講者 1 和講者 3 其實是同一個人」看得出來，
     *              「兩個人的話混在同一個標籤下」看不出來，而且會把摘要帶歪。
     *   maxSpeakers: 上限。超過就併進最近的一群 —— 會議不會有 12 個人輪流講，
     *                無上限的話雜訊會生出一堆只有一段話的假講者。
     */
    constructor({ threshold = 0.72, maxSpeakers = 8 } = {}) {
      this.threshold = threshold;
      this.maxSpeakers = maxSpeakers;
      this.clusters = [];   // { id, centroid, count, name }
      this.nextId = 1;
    }

    /**
     * 這段聲音是誰。回傳 { id, similarity, isNew } 或 null（資訊不足）。
     *
     * 中心點用**累進平均**更新：新的一段權重是 1/count，所以講得越多的人
     * 中心點越穩定，不會被一段有雜訊的話拉走。
     */
    assign(vec) {
      if (!vec) return null;

      let best = null;
      for (const c of this.clusters) {
        const sim = cosine(vec, c.centroid);
        if (!best || sim > best.sim) best = { cluster: c, sim };
      }

      if (best && best.sim >= this.threshold) {
        const c = best.cluster;
        c.count++;
        for (let i = 0; i < vec.length; i++) {
          c.centroid[i] += (vec[i] - c.centroid[i]) / c.count;
        }
        return { id: c.id, similarity: best.sim, isNew: false };
      }

      if (this.clusters.length >= this.maxSpeakers) {
        // 額滿：併進最近的一群，而不是硬開新的。寧可標錯一段，
        // 也不要讓「講者 12」這種東西出現在逐字稿上。
        if (!best) return null;
        const c = best.cluster;
        c.count++;
        return { id: c.id, similarity: best.sim, isNew: false };
      }

      const cluster = {
        id: this.nextId++,
        centroid: Float32Array.from(vec),
        count: 1,
        name: '',
      };
      this.clusters.push(cluster);
      return { id: cluster.id, similarity: best ? best.sim : 0, isNew: true };
    }

    /**
     * 把真實姓名綁在某一群上。
     *
     * **這是整個設計的關鍵。** 字幕或發言指示器只要在**任何一刻**對上過一次，
     * 那個名字就記在這一群聲音上 —— 之後同一個人講話都會顯示真名，
     * 即使字幕已經斷掉、或畫面切到共享畫面沒有視訊磚了。
     *
     * 單靠字幕的話，字幕斷掉的那幾分鐘就全部變回「其他人」。
     */
    nameCluster(id, name) {
      const c = this.clusters.find((x) => x.id === id);
      if (!c || !name) return false;
      if (c.name === name) return false;
      c.name = name;
      return true;
    }

    /** 顯示用的標籤：有真名就用真名，否則用「講者 N」 */
    labelFor(id) {
      const c = this.clusters.find((x) => x.id === id);
      if (!c) return '';
      return c.name || `講者 ${c.id}`;
    }

    /** 目前分出幾群、各自的狀態（診斷用） */
    describe() {
      return this.clusters.map((c) => ({
        id: c.id, name: c.name || `講者 ${c.id}`, segments: c.count,
      }));
    }

    reset() {
      this.clusters = [];
      this.nextId = 1;
    }
  }

  globalThis.__MA_VOICEPRINT__ = { embed, cosine, SpeakerBook, fft };
})();
