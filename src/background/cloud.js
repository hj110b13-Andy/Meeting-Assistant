/**
 * 雲端 LLM 用戶端（GroqCloud 與 NVIDIA NIM，兩家都是 OpenAI 相容的介面）。
 *
 * ## 為什麼加這條路
 *
 * 原本摘要與即時回答都走 Claude Code 橋接。橋接是免費的（用 Pro 訂閱額度），
 * 但**每次呼叫都是一個完整的 CLI session，實測 10–30 秒**。開會時被點名，
 * 等 30 秒才看到建議，等於沒有這個功能。
 *
 * 這台機器實測的延遲（同一段提示詞、同一份逐字稿）：
 *
 *   Groq llama-3.3-70b-versatile   0.7 秒
 *   Groq gpt-oss-120b              0.7 秒
 *   Groq llama-3.1-8b-instant      0.4 秒
 *   Claude Code 橋接               10–30 秒
 *
 * 快了一個數量級，而且兩家的免費方案都**不需要信用卡、不會轉成按量計費**——
 * 撞到上限就是回 429，不是開始扣錢。這點很重要：這個專案的前提是
 * 只花已經買了的 Claude Pro 訂閱，不接受任何按量費用。
 *
 * ## 免費額度（2026-08 查證，見 README）
 *
 *   Groq  ：每個模型各自計算。llama-3.3-70b-versatile 為 30 RPM／1,000 RPD／
 *           12,000 TPM／100,000 TPD。**額度是「每個模型一個桶」**，
 *           所以摘要與回答刻意用不同模型 —— 等於把可用額度變成兩份，
 *           而且摘要吃掉的 token 不會排擠到「被點名時要秒回」這件事。
 *   NIM   ：綁帳號，約 40 RPM。免費額度用的是帳號的點數。
 *
 * ## 退避順序
 *
 * 每個角色都有一條候選鏈，前面的失敗（429／5xx／逾時）就換下一個。
 * 全部失敗才丟 CloudUnavailable，由 provider.js 決定要不要退回 Claude Code。
 * **不會安靜地降級** —— 換了後端一定會讓上層有機會告訴使用者。
 */

import { getKeys } from './keys.js';

export class CloudUnavailable extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CloudUnavailable';
    this.detail = detail || [];
  }
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/**
 * 候選鏈。順序就是優先順序。
 *
 * 回答用 llama-3.3-70b-versatile 而不是 gpt-oss-120b／qwen：後兩者是推理模型，
 * 會先吐一大段 <think> 思考過程才給答案。思考內容有被切掉（見 cleanText），
 * 但**產生那些 token 仍然要花時間也仍然計入額度** —— 對「要秒回」的角色不划算。
 *
 * 摘要則相反：慢一點沒關係，推理模型整理重點的品質較好，而且用掉的是
 * 另一個模型的額度桶，不會排擠回答。
 *
 * NIM 放在最後，而且**用的是 8B 不是 70B**。這是實測出來的，差距大到不能忽略：
 *
 *   NIM meta/llama-3.1-8b-instruct    0.9 秒
 *   NIM meta/llama-3.3-70b-instruct  87.4 秒
 *
 * 兩者都回 HTTP 200、繁體中文品質都可以用，差別純粹在排隊時間 ——
 * 免費方案的大模型顯然是跟別人擠同一批 GPU。87 秒對「被點名要秒回」
 * 完全沒有意義，所以 70B 只留在摘要鏈的最後一格（摘要慢一點無所謂），
 * 回答鏈只用 8B。
 */
// 匯出是為了讓 run-cloud-check.ps1 能把裡面的模型 ID 挖出來，逐一問 Groq
// 「這個還在嗎」。模型下架或改名時 API 回 404，而 404 在畫面上跟「額度用完」
// 長得一模一樣（都是「改用 Claude Code」），使用者只會覺得今天特別慢。
export const CHAINS = {
  answer: [
    { vendor: 'groq', model: 'llama-3.3-70b-versatile', timeoutMs: 20000 },
    { vendor: 'groq', model: 'llama-3.1-8b-instant', timeoutMs: 15000 },
    { vendor: 'nim', model: 'meta/llama-3.1-8b-instruct', timeoutMs: 25000 },
  ],
  summary: [
    { vendor: 'groq', model: 'openai/gpt-oss-120b', timeoutMs: 45000 },
    { vendor: 'groq', model: 'llama-3.3-70b-versatile', timeoutMs: 45000 },
    { vendor: 'nim', model: 'meta/llama-3.1-8b-instruct', timeoutMs: 30000 },
    // 最後一格才用 NIM 的 70B：品質最好但實測要等 87 秒，只有在
    // 前面全部撞到額度時才值得等。
    { vendor: 'nim', model: 'meta/llama-3.3-70b-instruct', timeoutMs: 120000 },
  ],
  /**
   * 看得懂圖片的模型 —— **目前是空的，因為 Groq 一個都沒有。**
   *
   * 這裡一度放了 `meta-llama/llama-4-scout-17b-16e-instruct` 與
   * `…-maverick-…`，想讓「附上會議畫面」不必依賴 Claude Code 橋接。
   * **兩個都回 404。** 實際去問 Groq 的 `/models`（`tools\list-groq-models.ps1`）
   * 得到的清單裡沒有任何視覺模型：只有兩支 whisper、llama-3.1/3.3、
   * gpt-oss、qwen3.6、compound 這些純文字的。
   *
   * 記在這裡是為了**不要再猜一次**。要新增的話先跑那支腳本看清單，
   * 不要照著別處看到的模型名稱寫上去 —— 名稱錯的症狀是 404，
   * 而 404 在畫面上跟「額度用完」長得很像（都是「雲端不能用，改走退路」），
   * 使用者只會覺得變慢了。
   *
   * 所以看畫面這件事仍然走 Claude Code 橋接。橋接原本的脆弱點
   * （config.json 存 claude.exe 的絕對路徑，Claude Code 一更新就失效）
   * 已經在 `bridge/host.ps1` 修掉了 —— 路徑不存在時它會自己重新找一次。
   */
  vision: [],
};

const VENDOR = {
  groq: { url: GROQ_URL, label: 'Groq', keyFields: ['groq'] },
  // 兩把金鑰輪流用。NIM 的免費額度綁帳號，輪替是為了把「單一帳號撞上限」往後推。
  nim: { url: NIM_URL, label: 'NVIDIA NIM', keyFields: ['nvidia', 'nvidia2'] },
};

/**
 * 冷卻表：`vendor:model:金鑰序號` → 可以再試的時間戳。
 *
 * 撞到 429 之後如果不記下來，下一次呼叫又會從鏈的最前面開始撞，
 * 每一次都白白多花一個來回。額度是以「分鐘」為單位恢復的，
 * 所以記住「這個組合幾點以前不要再試」就能直接跳過。
 */
const cooldown = new Map();

/** NIM 兩把金鑰的輪替位置。每次成功呼叫後往前走一格，讓用量平均分散。 */
let nimCursor = 0;

/** 最近一次成功用的是哪一個，給 UI 顯示。使用者要看得出來現在是誰在回答。 */
export const lastUsed = { vendor: '', model: '', ms: 0, at: 0 };

function cooldownKey(vendor, model, keyIndex) {
  return `${vendor}:${model}:${keyIndex}`;
}

function isCooling(vendor, model, keyIndex) {
  const until = cooldown.get(cooldownKey(vendor, model, keyIndex));
  if (!until) return false;
  if (Date.now() >= until) {
    cooldown.delete(cooldownKey(vendor, model, keyIndex));
    return false;
  }
  return true;
}

/**
 * 429 之後要冷卻多久。優先用伺服器給的 Retry-After（秒），沒給就用 60 秒。
 *
 * 「等一下再試」之所以有意義，是因為 **Groq 的額度是持續回填的水桶，
 * 不是每天午夜歸零**。實際跟它要標頭驗證過：每天 1000 次的桶，用掉一次
 * 之後 `x-ratelimit-reset-requests` 回 86.4 秒（＝ 86400 ÷ 1000）；
 * 每分鐘 12000 token 的桶，用掉 37 個之後回 185 毫秒（＝ 37 ÷ 200/秒）。
 * 兩個都完全對得上連續回填。
 *
 * 所以撞到額度不必放棄整場會議，冷卻一下就會有配額。上限壓在 5 分鐘，
 * 免得一次暫時性的尖峰讓某個模型整場都被跳過。
 */
function noteRateLimited(vendor, model, keyIndex, retryAfter) {
  const sec = Math.min(300, Math.max(5, Number(retryAfter) || 60));
  cooldown.set(cooldownKey(vendor, model, keyIndex), Date.now() + sec * 1000);
  return sec;
}

/**
 * 把推理模型的思考段落與常見的開場白切掉。
 *
 * gpt-oss / qwen 這類模型會輸出 <think>…</think>。Groq 多數情況會自己收進
 * 另一個欄位，但不保證 —— 實測 qwen3.6 就直接吐在 content 裡。沒切掉的話
 * 側邊欄會顯示一大段英文思考過程，使用者要在裡面自己找答案。
 */
function cleanText(raw) {
  let t = String(raw || '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 只有開頭的 <think> 而沒有收尾（被 max_tokens 截斷）時，整段都是思考過程
  if (/^\s*<think>/i.test(t)) t = t.replace(/^\s*<think>[\s\S]*$/i, '');
  return t.trim();
}

/**
 * 把上層的 opts 轉成 OpenAI 相容的 body。
 *
 * 形狀刻意跟 claudecode.js 的 ccComplete 一致（`{ system, messages }`，
 * system 可以是字串或 [{text}] 的區塊陣列）—— provider.js 會在雲端失敗時
 * 直接把**同一個 opts** 交給橋接重跑，兩邊形狀不一樣的話那個退路就是壞的，
 * 而且只有在雲端失敗的時候才會發現。
 */
function toMessages({ system, messages, prompt }) {
  const systemText = Array.isArray(system)
    ? system.map((b) => b?.text || '').filter(Boolean).join('\n\n')
    : String(system || '');

  const out = [];
  if (systemText) out.push({ role: 'system', content: systemText });

  if (Array.isArray(messages) && messages.length) {
    for (const m of messages) {
      // 有些呼叫端的 content 是 Anthropic 那種區塊陣列，這裡一律攤平成字串
      const content = Array.isArray(m.content)
        ? m.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n')
        : String(m.content || '');
      if (content) out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
    }
  } else if (prompt) {
    out.push({ role: 'user', content: String(prompt) });
  }

  return out;
}

function buildBody({ system, messages, prompt, model, maxTokens, temperature, stream }) {
  return {
    model,
    messages: toMessages({ system, messages, prompt }),
    max_tokens: maxTokens || 800,
    temperature: temperature === undefined ? 0.3 : temperature,
    stream: !!stream,
  };
}

/**
 * 打一次，不重試。失敗時丟出的 Error 會帶 `.status`，
 * 讓上層分得出「這個組合暫時不能用」（429）與「金鑰錯了」（401）——
 * 兩者的處置完全不同：前者換一個候選，後者換再多候選也沒用。
 */
async function callOnce(url, key, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error?.message || j?.detail || '';
      } catch { detail = await res.text().catch(() => ''); }
      const err = new Error(`${res.status} ${detail}`.trim());
      err.status = res.status;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }

    const json = await res.json();
    const text = cleanText(json?.choices?.[0]?.message?.content);
    if (!text) {
      const err = new Error('回應是空的');
      err.status = 0;
      throw err;
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`逾時（${Math.round(timeoutMs / 1000)} 秒）`);
      e.status = 408;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 展開候選鏈：每個候選 × 它能用的金鑰，並跳過冷卻中與沒填金鑰的組合。 */
function candidates(role, keys) {
  const out = [];
  for (const cand of CHAINS[role] || CHAINS.answer) {
    const vendor = VENDOR[cand.vendor];
    if (!vendor) continue;
    // NIM 從輪替游標開始，讓兩個帳號的用量平均分散
    const fields = vendor.keyFields;
    const order = cand.vendor === 'nim'
      ? fields.map((_, i) => fields[(nimCursor + i) % fields.length])
      : fields;
    for (const field of order) {
      const key = keys[field];
      if (!key) continue;
      const keyIndex = fields.indexOf(field);
      if (isCooling(cand.vendor, cand.model, keyIndex)) continue;
      out.push({ ...cand, key, keyIndex, keyField: field, url: vendor.url, label: vendor.label });
    }
  }
  return out;
}

/**
 * 依序試候選鏈，第一個成功就回傳。
 *
 * 回傳 { text, vendor, model, ms, attempts }。attempts 帶著每一次失敗的原因，
 * 因為「為什麼用到了比較差的後端」是使用者唯一會問的問題，
 * 而沒有這份清單就只能猜。
 */
export async function cloudComplete(opts = {}) {
  const { system, messages, prompt, role = 'answer', maxTokens, temperature } = opts;
  const keys = await getKeys();
  const list = candidates(role, keys);
  if (!list.length) {
    throw new CloudUnavailable(
      '沒有可用的雲端金鑰（或全部都在冷卻中）。請到設定頁貼上 Groq／NVIDIA 的 API 金鑰。');
  }

  const attempts = [];
  for (const c of list) {
    const started = Date.now();
    try {
      const text = await callOnce(
        c.url, c.key,
        buildBody({ system, messages, prompt, model: c.model, maxTokens, temperature }),
        c.timeoutMs);
      const ms = Date.now() - started;
      if (c.vendor === 'nim') nimCursor = (nimCursor + 1) % VENDOR.nim.keyFields.length;
      Object.assign(lastUsed, { vendor: c.vendor, model: c.model, ms, at: Date.now() });
      // stopReason 是為了跟 ccComplete 的回傳形狀一致，見 toMessages 的說明
      return { text, stopReason: 'end_turn', vendor: c.vendor, model: c.model, label: c.label, ms, attempts };
    } catch (err) {
      const status = err.status || 0;
      if (status === 429) {
        const sec = noteRateLimited(c.vendor, c.model, c.keyIndex, err.retryAfter);
        attempts.push({ vendor: c.vendor, model: c.model, error: `額度用完，冷卻 ${sec} 秒`, status });
      } else if (status === 401 || status === 403) {
        // 金鑰壞掉的話，同一把金鑰的其他候選也不用試了 —— 冷卻久一點避免刷錯誤
        noteRateLimited(c.vendor, c.model, c.keyIndex, 300);
        attempts.push({ vendor: c.vendor, model: c.model, error: `金鑰被拒（${status}）`, status });
      } else if (status === 404) {
        // **404 跟 429 是完全不同的事。** 429 是「現在不行，等一下就好」，
        // 404 是「這個模型名稱不存在」—— 再等一萬年也不會出現。
        // 不冷卻的話，每一次呼叫都會重新撞一遍整條鏈，白花兩個來回的延遲。
        // 踩過一次：vision 鏈的兩個模型 ID 都寫錯，於是每次勾「附上會議畫面」
        // 都先浪費兩次 404 才退到橋接。
        noteRateLimited(c.vendor, c.model, c.keyIndex, 300);
        attempts.push({
          vendor: c.vendor, model: c.model, status,
          error: '模型名稱不存在（404）—— 可能已下架或改名，請更新候選鏈',
        });
      } else {
        attempts.push({ vendor: c.vendor, model: c.model, error: String(err.message || err), status });
      }
    }
  }

  const summary = attempts.map((a) => `${a.vendor}/${a.model}：${a.error}`).join('；');
  throw new CloudUnavailable(`雲端後端全部失敗（${summary}）`, attempts);
}

/**
 * 串流版本，只給即時回答用。
 *
 * 被點名的時候，「開始看到字」比「拿到完整答案」重要得多 —— 先出現前兩個字，
 * 使用者就知道系統有在動，而不是盯著一個不會變的畫面猜它是不是壞了。
 *
 * ## 已經吐出字之後就不能再換後端
 *
 * 這是這個函式最重要的一條規則。上層（provider.js 的 withFallback）看到
 * CloudUnavailable 會**用同一個 opts 重跑一次**，而 onDelta 是累加到同一則
 * 回答上的 —— 已經吐過字還讓它重跑，畫面上就會出現兩段接不起來的文字，
 * 比慢還糟。所以：
 *
 *   還沒吐字 → 丟 CloudUnavailable，讓上層去試別的候選或退回橋接
 *   已經吐字 → 就地把這一段收尾回傳，不丟例外
 */
export async function cloudStream(opts = {}) {
  const { system, messages, prompt, role = 'answer', maxTokens, temperature, onDelta } = opts;
  const keys = await getKeys();
  const list = candidates(role, keys);
  if (!list.length) {
    throw new CloudUnavailable('沒有可用的雲端金鑰（或全部都在冷卻中）。');
  }

  // 一個字都還沒吐出去的失敗是可以重試的，所以依序試候選鏈；
  // 只要開始吐字就不再換人（見上面的說明）。
  const attempts = [];
  for (const cand of list) {
    try {
      return await streamOnce(cand, { system, messages, prompt, maxTokens, temperature, onDelta });
    } catch (err) {
      if (err instanceof StreamStarted) throw err.inner;   // 已經吐字，不重試
      attempts.push({ vendor: cand.vendor, model: cand.model, error: String(err.message || err), status: err.status || 0 });
    }
  }
  const summary = attempts.map((a) => `${a.vendor}/${a.model}：${a.error}`).join('；');
  throw new CloudUnavailable(`雲端串流全部失敗（${summary}）`, attempts);
}

/** 內部標記：用來區分「還沒吐字的失敗」與「吐到一半的失敗」。 */
class StreamStarted extends Error {
  constructor(inner) { super('串流已開始'); this.inner = inner; }
}

async function streamOnce(c, { system, messages, prompt, maxTokens, temperature, onDelta }) {
  let emitted = false;
  // full 宣告在 try 外面：catch 裡要拿它把已經收到的部分收尾回傳
  let full = '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(c.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(buildBody({
        system, messages, prompt, model: c.model, maxTokens, temperature, stream: true,
      })),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      if (res.status === 429) noteRateLimited(c.vendor, c.model, c.keyIndex, res.headers.get('retry-after'));
      const err = new Error(`${res.status}`);
      err.status = res.status;
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let thinking = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 的訊息以空行分隔。**一定要保留最後一段不處理** ——
      // 網路封包可以切在任何位置，最後一段常常是半行 JSON，
      // 直接 parse 會丟例外並中斷整個串流。
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let delta = '';
        try { delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || ''; } catch { continue; }
        if (!delta) continue;

        // 推理模型的 <think> 要即時濾掉，不能等收完 —— 等收完就失去串流的意義了
        full += delta;
        if (!thinking && /<think>/i.test(full) && !/<\/think>/i.test(full)) thinking = true;
        if (thinking) {
          if (/<\/think>/i.test(full)) thinking = false;
          continue;
        }
        emitted = true;
        onDelta?.(delta);
      }
    }

    const text = cleanText(full);
    if (!text) {
      const err = new Error('串流沒有內容');
      err.status = 0;
      throw err;
    }
    const ms = Date.now() - started;
    if (c.vendor === 'nim') nimCursor = (nimCursor + 1) % VENDOR.nim.keyFields.length;
    Object.assign(lastUsed, { vendor: c.vendor, model: c.model, ms, at: Date.now() });
    return { text, stopReason: 'end_turn', vendor: c.vendor, model: c.model, label: c.label, ms };
  } catch (err) {
    // 逾時包成 CloudUnavailable，上層才分得出「雲端不行」與「程式有 bug」——
    // 只有前者該退回橋接，後者要讓它浮出來，不能被退路蓋住。
    const wrapped = err.name === 'AbortError'
      ? new CloudUnavailable(`串流逾時（${Math.round(c.timeoutMs / 1000)} 秒）`)
      : err;

    // 已經吐字了就不能重來（會在畫面上接出兩段不連續的文字）。
    // 把手上這一段收尾回傳，讓使用者至少看得到已經出現的內容。
    if (emitted) {
      const partial = cleanText(full);
      if (partial) {
        return {
          text: partial, stopReason: 'truncated',
          vendor: c.vendor, model: c.model, label: c.label,
          ms: Date.now() - started,
          error: String(wrapped.message || wrapped),
        };
      }
      throw new StreamStarted(wrapped);
    }
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

/** 現在有沒有可用的雲端後端。給 UI 與 provider 的判斷用。 */
export async function cloudReady() {
  const keys = await getKeys();
  return candidates('answer', keys).length > 0;
}

/** 目前的冷卻狀況，給側邊欄顯示「為什麼變慢了」。 */
export function cooldownState() {
  const now = Date.now();
  const items = [];
  for (const [k, until] of cooldown) {
    if (until <= now) continue;
    const [vendor, model] = k.split(':');
    items.push({ vendor, model, secondsLeft: Math.ceil((until - now) / 1000) });
  }
  return items;
}

/** 測試一把金鑰能不能用。設定頁的「測試」按鈕會呼叫這個。 */
export async function testKey(vendor, key) {
  const v = VENDOR[vendor];
  if (!v) return { ok: false, error: `不認得的服務：${vendor}` };
  if (!key) return { ok: false, error: '沒有填金鑰' };
  const model = CHAINS.answer.find((c) => c.vendor === vendor)?.model
    || CHAINS.summary.find((c) => c.vendor === vendor)?.model;
  const started = Date.now();
  try {
    const text = await callOnce(v.url, key,
      buildBody({ prompt: '回覆兩個字：可以', model, maxTokens: 16, temperature: 0 }),
      20000);
    return { ok: true, ms: Date.now() - started, model, sample: text.slice(0, 20) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), status: err.status || 0, model };
  }
}
