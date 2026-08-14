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
 * 兩條路是**互補**的：聲紋負責「這是不是同一個人」，字幕／指示器負責
 * 「這個人叫什麼」。只要在任何一刻對上過一次名字，`nameCluster()` 就把名字
 * 記在那一群上，之後同一個人的話都會顯示真名 —— **即使字幕後來斷掉了**。
 *
 * ## 兩個判斷條件，而且是 AND
 *
 * 第一版只用 MFCC 的餘弦相似度配一個固定門檻，**實測整場會議全部併成
 * 「講者 1」**。原因是合成測試騙了我：合成的兩個聲音共振峰差很遠，
 * 相似度 0.32 對 0.97，任何門檻都分得開。但真人不是這樣 ——
 * 同一個語言、同一支麥克風、同一個編碼器壓過的兩個人，MFCC 平均值裡
 * **共同成分遠大於個人成分**，兩個不同的人也有 0.95 以上的相似度。
 * 固定門檻在那個尺度上完全沒有鑑別力。
 *
 * 所以現在是兩個條件同時成立才算同一個人：
 *
 *   1. **基頻（音高）要接近** —— 這是絕對量，不受編碼器與語言影響，
 *      而且是最強的廉價線索（男聲約 85–155 Hz、女聲約 165–255 Hz）。
 *   2. **去掉共同成分之後的 MFCC 要相似** —— 減掉整場的**移動平均**
 *      （cepstral mean normalization，語音辨識的標準做法），剩下的殘差
 *      才是個人特徵。這一步就是第一版缺的東西。
 *
 * AND 而不是 OR：兩個條件都通過才併群，所以**偏向拆開**。這是刻意的 ——
 * 「講者 1 和講者 3 其實是同一個人」看得出來，「兩個人的話混在同一個標籤下」
 * 看不出來，而且會把摘要與回答建議一起帶歪。
 *
 * ## 為什麼是自己寫，而不是用現成的模型
 *
 * 正統的 diarization（pyannote 之類）要另外下載幾百 MB 的模型、要 Python，
 * 而這個專案的前提是免建置、不花錢、退路要能離線跑。而會議的情境其實
 * 比通用 diarization 簡單得多：VAD 已經把音訊切成「一句一段」，每一段
 * 幾乎都只有一個人在講 —— 剩下的只是「這一段跟前面哪一段是同一個人」。
 */
(() => {
  if (globalThis.__MA_VOICEPRINT__) return;

  // ── FFT（radix-2，就地運算）─────────────────────────────────────
  // 自己寫是因為不能引入外部函式庫（免建置，CSP 也不允許外部腳本）。
  function fft(re, im) {
    const n = re.length;
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

  // 基頻搜尋範圍。70–350 Hz 蓋住成人男女聲；再寬只會讓自相關抓到
  // 泛音或雜訊的假峰值。
  const F0_MIN = 70;
  const F0_MAX = 350;
  const PITCH_FRAME = 1024;   // 64 毫秒：至少要裝得下 F0_MIN 的兩個週期
  const PITCH_HOP = 512;

  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

  /**
   * 梅爾濾波器組。**只取 300–3400 Hz**（電話頻寬）：
   * 會議音訊經過各家平台的編碼器壓縮，那個範圍以外的資訊本來就不可靠。
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
   * 一個訊框的基頻，用自相關法。回傳 Hz，判定為無聲時回 0。
   *
   * 用**正規化**的自相關（除以能量）而不是原始值，門檻才有意義 ——
   * 原始自相關值跟音量成正比，大聲說話的無聲段會超過小聲說話的有聲段。
   */
  function frameF0(audio, offset) {
    let energy = 0;
    for (let i = 0; i < PITCH_FRAME; i++) {
      const v = audio[offset + i];
      energy += v * v;
    }
    if (energy < 1e-7) return 0;

    const minLag = Math.floor(SAMPLE_RATE / F0_MAX);
    const maxLag = Math.min(Math.floor(SAMPLE_RATE / F0_MIN), PITCH_FRAME - 1);
    let bestLag = 0; let bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0; let e2 = 0;
      for (let i = 0; i + lag < PITCH_FRAME; i++) {
        sum += audio[offset + i] * audio[offset + i + lag];
        e2 += audio[offset + i + lag] * audio[offset + i + lag];
      }
      const score = sum / (Math.sqrt(energy * e2) + 1e-12);
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    // 0.35 是「這個訊框有明確週期」的門檻。太低會把雜訊當成人聲，
    // 太高則氣息重的段落全被判成無聲、算不出音高。
    if (bestScore < 0.35 || !bestLag) return 0;
    return SAMPLE_RATE / bestLag;
  }

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  /**
   * 算一段音訊的原始特徵。**刻意不做正規化** ——
   * 正規化要用「整場的統計量」，那只有 SpeakerBook 知道（見 whiten）。
   *
   * 回傳 { mfcc: Float32Array(26), semitone, frames } 或 null。
   *
   * mfcc 是 **平均值 ＋ 標準差**，不是只有平均值。標準差帶的是「這個人講話時
   * 頻譜怎麼變化」—— 語調、氣息、共振峰的移動幅度，比平均值更能區分
   * 音色相近的人。
   *
   * **只算有聲音的訊框。** 一段話裡的靜音會把平均值往「無聲的頻譜」拉，
   * 而每個人的靜音聽起來都一樣 —— 靜音佔比不同的兩段話會因此被判成
   * 不同的人，那是實際會發生的誤判來源。
   *
   * 資訊不足時回 null。**回 null 比回一個亂猜的向量重要**：亂猜會污染
   * 分群中心，錯一次之後整場都跟著錯。
   */
  function analyze(audio, sampleRate = SAMPLE_RATE) {
    if (!audio || audio.length < FRAME * 4) return null;

    let peak = 0;
    for (let i = 0; i < audio.length; i++) {
      const a = Math.abs(audio[i]);
      if (a > peak) peak = a;
    }
    if (peak < 1e-4) return null;             // 整段幾乎是靜音
    const gate = peak * 0.08;

    const re = new Float32Array(FRAME);
    const im = new Float32Array(FRAME);
    const win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

    const sums = new Float64Array(MFCC_COEFS);
    const sumSquares = new Float64Array(MFCC_COEFS);
    let frames = 0;
    const nBins = FRAME / 2 + 1;
    const power = new Float32Array(nBins);
    const logMel = new Float32Array(MEL_BANDS);

    for (let start = 0; start + FRAME <= audio.length; start += HOP) {
      let frameMax = 0;
      for (let i = 0; i < FRAME; i++) {
        const a = Math.abs(audio[start + i]);
        if (a > frameMax) frameMax = a;
      }
      if (frameMax < gate) continue;

      for (let i = 0; i < FRAME; i++) { re[i] = audio[start + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
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

    const mfcc = new Float32Array(MFCC_COEFS * 2);
    for (let c = 0; c < MFCC_COEFS; c++) {
      const mean = sums[c] / frames;
      const variance = Math.max(0, sumSquares[c] / frames - mean * mean);
      mfcc[c] = mean;
      mfcc[MFCC_COEFS + c] = Math.sqrt(variance);
    }

    // 基頻取**中位數**而不是平均：一段話裡總有幾個訊框會抓到泛音（頻率翻倍），
    // 平均值會被那些離群值拉走，中位數不會。
    const f0s = [];
    for (let start = 0; start + PITCH_FRAME <= audio.length; start += PITCH_HOP) {
      const f = frameF0(audio, start);
      if (f > 0) f0s.push(f);
    }
    // 換成半音（對數尺度）：人耳與生理上的「音高差」是比例關係，不是差值。
    // 100 Hz 當基準點，純粹是為了讓數字好讀。
    const f0 = median(f0s);
    const semitone = f0 > 0 ? 12 * Math.log2(f0 / 100) : NaN;

    return { mfcc, semitone, frames, voicedFrames: f0s.length };
  }

  function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  /**
   * 線上分群：每來一段就決定「這是誰」，不能等整場結束再算。
   *
   * 逐字稿是即時顯示的，所以不能用需要看完全部資料的演算法。線上分群的
   * 代價是**開頭幾段可能分錯**，換來的是每一段都立刻有標籤。
   */
  class SpeakerBook {
    /**
     * @param {object} opts
     *   pitchTolerance: 音高差幾個半音以內算同一個人。2.5 半音約等於 16%。
     *                   同一個人講話的音高本來就會起伏（激動／平靜），
     *                   但一段話取中位數之後波動不大。
     *   residualThreshold: 去掉共同成分後的 MFCC 相似度門檻。
     *                   **這兩個是唯一要調的參數，而且是 AND** ——
     *                   兩個都通過才併群，所以整體偏向拆開。
     *   maxSpeakers: 上限。會議不會有 12 個人輪流講，無上限的話雜訊會
     *                生出一堆只有一段話的假講者。
     */
    constructor({ pitchTolerance = 2.5, residualThreshold = 0.3, maxSpeakers = 8 } = {}) {
      this.pitchTolerance = pitchTolerance;
      this.residualThreshold = residualThreshold;
      this.maxSpeakers = maxSpeakers;
      this.clusters = [];   // { id, mfcc(累進平均), semitone, count, name }
      this.nextId = 1;
      // 整場的移動平均，用來去掉共同成分（cepstral mean normalization）。
      // **這是第一版缺的東西**：不減掉它的話，真人的 MFCC 平均值裡
      // 「同一個語言、同一個編碼器」的共同成分遠大於個人差異，
      // 兩個不同的人也有 0.95 以上的相似度，門檻完全沒有鑑別力。
      this.globalMean = new Float32Array(MFCC_COEFS * 2);
      this.globalM2 = new Float64Array(MFCC_COEFS * 2);
      this.seen = 0;
    }

    /** 累進更新整場的平均與變異數（Welford） */
    observe(mfcc) {
      this.seen++;
      for (let i = 0; i < mfcc.length; i++) {
        const delta = mfcc[i] - this.globalMean[i];
        this.globalMean[i] += delta / this.seen;
        this.globalM2[i] += delta * (mfcc[i] - this.globalMean[i]);
      }
    }

    /**
     * 減掉共同成分，再按各維度的變異數縮放，最後 L2 正規化。
     *
     * 縮放（whitening）跟減平均一樣重要：低階 MFCC 的量級遠大於高階，
     * 不縮放的話餘弦相似度幾乎只反映前兩三個係數。
     */
    whiten(mfcc) {
      const out = new Float32Array(mfcc.length);
      const n = Math.max(1, this.seen - 1);
      let norm = 0;
      for (let i = 0; i < mfcc.length; i++) {
        // 變異數的下限：只看過一兩段時 M2 接近 0，直接除會把雜訊放大到爆掉
        const sd = Math.sqrt(this.globalM2[i] / n) + 0.5;
        out[i] = (mfcc[i] - this.globalMean[i]) / sd;
        norm += out[i] * out[i];
      }
      norm = Math.sqrt(norm);
      if (!(norm > 0)) return null;
      for (let i = 0; i < out.length; i++) out[i] /= norm;
      return out;
    }

    /**
     * 這段聲音是誰。回傳 { id, similarity, pitchDelta, isNew } 或 null。
     *
     * @param {object} feat  analyze() 的結果
     */
    assign(feat) {
      if (!feat || !feat.mfcc) return null;
      this.observe(feat.mfcc);

      if (!this.clusters.length) return this.create(feat, 0);

      // **前幾段只能靠音高判斷。**
      //
      // 去共同成分（CMN）的減數是「整場的平均」，而段落很少的時候那個平均
      // 就是這幾段自己 —— 只有兩段時平均正好是兩者的中點，於是兩個殘差
      // 剛好方向相反，餘弦相似度**恆等於 -1**，不管是不是同一個人。
      // 實測就是這樣：同一個人的第二句話得到 sim=-1.000，被判成新的講者。
      //
      // 所以要等統計量有意義了才把 MFCC 這一關加進來。在那之前音高單獨用，
      // 它是絕對量、不需要任何整場統計，本來就站得住。
      const trustResidual = this.seen >= 6;
      const mine = trustResidual ? this.whiten(feat.mfcc) : null;

      let best = null;
      for (const c of this.clusters) {
        // 音高是絕對量，不受編碼器與語言影響 —— 先用它擋掉明顯不同的人。
        const knowBoth = Number.isFinite(feat.semitone) && Number.isFinite(c.semitone);
        const pitchDelta = knowBoth ? Math.abs(feat.semitone - c.semitone) : NaN;
        if (knowBoth && pitchDelta > this.pitchTolerance) continue;

        if (!mine) {
          // 音高模式：挑音高最接近的。兩邊都算不出音高時（氣息很輕、雜訊多）
          // 就退而求其次挑段數最多的那一群 —— 那通常是主要發言者，
          // 比每次都開一個新講者好（後者會讓逐字稿長出一堆假講者）。
          const score = knowBoth ? -pitchDelta : -99;
          if (!best || score > best.score) best = { cluster: c, sim: 0, pitchDelta, score };
          continue;
        }
        const theirs = this.whiten(c.mfcc);
        if (!theirs) continue;
        const sim = cosine(mine, theirs);
        if (!best || sim > best.sim) best = { cluster: c, sim, pitchDelta, score: sim };
      }

      // 音高模式下不看 MFCC：只要通過音高那一關就算同一個人
      if (best && (!mine || best.sim >= this.residualThreshold)) {
        const c = best.cluster;
        c.count++;
        // 累進平均：講得越多的人中心點越穩定，不會被一段有雜訊的話拉走
        for (let i = 0; i < feat.mfcc.length; i++) {
          c.mfcc[i] += (feat.mfcc[i] - c.mfcc[i]) / c.count;
        }
        if (Number.isFinite(feat.semitone)) {
          c.semitone = Number.isFinite(c.semitone)
            ? c.semitone + (feat.semitone - c.semitone) / c.count
            : feat.semitone;
        }
        return { id: c.id, similarity: best.sim, pitchDelta: best.pitchDelta, isNew: false };
      }

      if (this.clusters.length >= this.maxSpeakers) {
        // 額滿：併進最近的一群（連音高都對不上時就併段數最多的那一群）。
        // 寧可標錯一段，也不要讓「講者 12」出現在逐字稿上。
        const c = best ? best.cluster
          : this.clusters.reduce((a, b) => (b.count > a.count ? b : a));
        c.count++;
        return { id: c.id, similarity: best ? best.sim : 0, pitchDelta: best ? best.pitchDelta : NaN, isNew: false };
      }
      return this.create(feat, best ? best.sim : 0);
    }

    create(feat, similarity) {
      const cluster = {
        id: this.nextId++,
        mfcc: Float32Array.from(feat.mfcc),
        semitone: feat.semitone,
        count: 1,
        name: '',
      };
      this.clusters.push(cluster);
      return { id: cluster.id, similarity, pitchDelta: NaN, isNew: true };
    }

    /**
     * 把真實姓名綁在某一群上。
     *
     * **這是整個設計的關鍵。** 字幕或發言指示器只要在**任何一刻**對上過一次，
     * 那個名字就記在這一群聲音上 —— 之後同一個人講話都會顯示真名，
     * 即使字幕已經斷掉、或畫面切到共享畫面沒有視訊磚了。
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
        id: c.id,
        name: c.name || `講者 ${c.id}`,
        segments: c.count,
        hz: Number.isFinite(c.semitone) ? Math.round(100 * (2 ** (c.semitone / 12))) : null,
      }));
    }

    reset() {
      this.clusters = [];
      this.nextId = 1;
      this.globalMean = new Float32Array(MFCC_COEFS * 2);
      this.globalM2 = new Float64Array(MFCC_COEFS * 2);
      this.seen = 0;
    }
  }

  globalThis.__MA_VOICEPRINT__ = { analyze, cosine, SpeakerBook, fft, frameF0 };
})();
