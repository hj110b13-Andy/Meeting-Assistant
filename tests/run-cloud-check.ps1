<#
  會議助手 — 雲端端到端驗證

  用法：  powershell -ExecutionPolicy Bypass -File tests\run-cloud-check.ps1

  跟 tests\run.ps1 的差別：run.ps1 用 stub 驗「程式自洽」，這支用**真金鑰打真 API**，
  驗的是「我們送出去的東西對方真的收得下」。兩件事會分開失敗 ——
  請求形狀寫錯時 stub 照樣會回應，只有真的打過去才會被拒。

  這支**不進 run.ps1**，因為它需要金鑰與網路，而且會消耗免費額度。
  改動 cloud.js / tavily.js / offscreen.js 的請求形狀之後跑一次就好。

  金鑰來源：專案根目錄的 API Key.txt（已被 .gitignore 擋住），
  格式是每行「名稱：金鑰」。也可以用環境變數 GROQ_API_KEY 等覆蓋。

  注意：headless Chrome 從 file:// 打外部 API 會被 CORS 擋掉
  （Groq 不對瀏覽器發 CORS 標頭）。擴充功能有 host_permissions 所以沒這問題，
  但這支驗證程式沒有，因此用 --disable-web-security ＋ 獨立的 user-data-dir。
  那個旗標只影響這個拋棄式的設定檔，不會動到你平常在用的 Chrome。

  ── 這支**不量延遲**，原因要記下來 ──────────────────────────────
  要讓 headless Chrome 等非同步工作跑完，只能用 --virtual-time-budget，
  而那個旗標會**把時鐘虛擬化**：`Date.now()` 前進的是虛擬時間，不是真實時間。
  於是每一次 API 呼叫都會量到 10 毫秒上下（實測真實值是 700–1000 毫秒）。

  這比量不到更糟 —— 「回答夠快（3 秒內）」那種斷言會**永遠通過**，
  而通過的項目沒有人會去看。所以這裡只驗這個環境真的驗得到的東西
  （請求對方收不收、回來的內容對不對），延遲另外用 PowerShell 直接量。

  同理，串流「分成幾塊」也不驗：虛擬時間會把整個回應緩衝完才交給 reader，
  永遠是 1 塊，跟串流有沒有壞無關。只驗 onDelta 有被呼叫、而且拼回來的
  文字跟回傳值一致 —— 那證明的是 SSE 解析器認得 Groq 真正的事件格式。
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmp  = Join-Path $PSScriptRoot '.tmp\cloud'

# **設定檔一定要放在專案資料夾外面。**
# Chrome 會在自己的 user-data-dir 裡放 `_locales`、`_metadata` 這些資料夾，
# 而 Chrome 保留底線開頭的名字給自己 —— 專案資料夾裡只要出現一個，
# **整個擴充功能就拒絕載入**（不是忽略那個檔案，是整個載不進去）。
# 之前放在 tests\.cloudprofile，跑完這支驗證就會把擴充功能弄壞，
# 而錯誤訊息完全不會指向這裡。
$profileDir = Join-Path $env:TEMP 'MeetingAssistant-cloudcheck'

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error '找不到 Chrome 或 Edge。'; exit 2 }

# ── 金鑰 ────────────────────────────────────────────────────────
$keys = @{ groq = $env:GROQ_API_KEY; nvidia = $env:NVIDIA_API_KEY; nvidia2 = $env:NVIDIA_API_KEY2; tavily = $env:TAVILY_API_KEY }
$keyFile = Join-Path $root 'API Key.txt'
if (Test-Path $keyFile) {
  $sep = [char]0xFF1A     # 全形冒號
  foreach ($line in [IO.File]::ReadAllLines($keyFile, [Text.UTF8Encoding]::new($false))) {
    $i = $line.IndexOf($sep)
    if ($i -lt 0) { $i = $line.IndexOf(':') }
    if ($i -lt 0) { continue }
    $name = $line.Substring(0, $i)
    $val  = $line.Substring($i + 1).Trim()
    if (-not $val) { continue }
    if     ($val.StartsWith('gsk_'))   { if (-not $keys.groq)   { $keys.groq = $val } }
    elseif ($val.StartsWith('tvly-'))  { if (-not $keys.tavily) { $keys.tavily = $val } }
    elseif ($val.StartsWith('nvapi-')) {
      # 「帳號2」那行是第二把。靠字面判斷比靠行號穩 —— 使用者會重新排列。
      if ($name -match '2|二') { $keys.nvidia2 = $val } elseif (-not $keys.nvidia) { $keys.nvidia = $val }
    }
  }
}
if (-not $keys.groq) {
  Write-Host '找不到 Groq 金鑰。請在專案根目錄放 API Key.txt，或設環境變數 GROQ_API_KEY。' -ForegroundColor Red
  exit 2
}
Write-Host ("金鑰：Groq {0}　NVIDIA {1}／{2}　Tavily {3}" -f
  $(if ($keys.groq) { 'v' } else { '-' }), $(if ($keys.nvidia) { 'v' } else { '-' }),
  $(if ($keys.nvidia2) { 'v' } else { '-' }), $(if ($keys.tavily) { 'v' } else { '-' })) -ForegroundColor DarkGray

# ── 串流（真實時間）─────────────────────────────────────────────
# 串流**不能**在 headless Chrome 裡測：--virtual-time-budget 會快轉時鐘，
# 留著逾時計時器就會在回應回來前把串流 abort 掉（實測只收到第一個 token），
# 拿掉計時器則整頁卡死。兩種都不是產品的問題，卻都會產生紅字。
#
# 用 curl 在真實時間下驗，反而比原本更準：看得到 Groq 真的是一塊一塊吐的。
# 至於 SSE 解析器本身（半行 JSON、事件切在 chunk 邊界），由 run.ps1 的
# background 測試用合成串流涵蓋，不需要網路也不受時鐘影響。
$psPass = 0; $psFail = 0
function PsCheck($name, $cond, $detail = '') {
  if ($cond) { $script:psPass++; Write-Host "  PASS  $name" -ForegroundColor DarkGreen }
  else       { $script:psFail++; Write-Host "  FAIL  $name  ->  $detail" -ForegroundColor Red }
}

Write-Host ''
Write-Host '── 串流（curl，真實時間）──' -ForegroundColor Cyan
$curl = "$env:SystemRoot\System32\curl.exe"
$bodyFile = Join-Path $tmp 'stream-body.json'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$streamBody = @{
  model = 'llama-3.3-70b-versatile'
  messages = @(@{ role = 'user'; content = '用繁體中文寫三句話說明如何降低退款延遲。' })
  max_tokens = 200
  temperature = 0.3
  stream = $true
} | ConvertTo-Json -Depth 5 -Compress
[IO.File]::WriteAllText($bodyFile, $streamBody, [Text.UTF8Encoding]::new($false))

# -N 關掉緩衝，才看得出「一塊一塊回來」而不是一次收完。
#
# **輸出一定要寫檔再用 UTF-8 讀回來，不能直接接 `$raw = & curl …`。**
# PowerShell 5.1 讀原生程式的 stdout 時用主控台的字碼頁（正體中文機器是
# CP950）解碼，UTF-8 的中文會整片變成亂碼 —— 然後「內容是不是繁體」
# 這種比對就必然失敗，而失敗訊息看起來像模型吐了亂碼，完全指錯方向。
$rawFile = Join-Path $tmp 'stream-raw.txt'
& $curl -s -N -m 60 -o $rawFile 'https://api.groq.com/openai/v1/chat/completions' `
  -H "Authorization: Bearer $($keys.groq)" -H 'Content-Type: application/json' `
  -H 'Accept: text/event-stream' --data-binary "@$bodyFile" 2>$null
$raw = if (Test-Path $rawFile) { [IO.File]::ReadAllText($rawFile, [Text.UTF8Encoding]::new($false)) } else { '' }

$dataLines = @($raw -split "`n" | Where-Object { $_ -match '^data:\s*\{' })
# 不要把 foreach 敘述直接接到管線 —— PowerShell 5.1 會報
# 「An empty pipe element is not allowed」。用一般的迴圈累積就好。
$deltas = @()
foreach ($line in $dataLines) {
  try {
    $c = (($line -replace '^data:\s*', '') | ConvertFrom-Json).choices[0].delta.content
    if ($c) { $deltas += $c }
  } catch { }
}
$joined = -join $deltas

PsCheck 'Groq 的串流端點回得了 SSE' ($dataLines.Count -gt 0) "收到 $($dataLines.Count) 行 data:"
PsCheck '真的是一塊一塊吐（不是一次回完）' ($deltas.Count -gt 3) "$($deltas.Count) 塊"
PsCheck '串流內容是繁體中文' ($joined -match '[繁體會議對帳這個們設進來還發應退款]' -and $joined -notmatch '[这个们对帐会议应发]') $joined.Substring(0, [Math]::Min(60, $joined.Length))
PsCheck '串流有正常收尾（收到 [DONE]）' ($raw -match '\[DONE\]') '沒有看到 [DONE]'
if ($joined) {
  Write-Host ("      [串流 llama-3.3-70b-versatile：{0} 塊] {1}…" -f $deltas.Count,
    ($joined -replace '\s+', ' ').Substring(0, [Math]::Min(70, ($joined -replace '\s+', ' ').Length))) -ForegroundColor DarkGray
}
Remove-Item $bodyFile, $rawFile -Force -ErrorAction SilentlyContinue
Write-Host ''

# ── 準備待測檔案（跟 run.ps1 同樣的模組轉換）────────────────────
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
function Convert-Module($src, $dest) {
  $s = [IO.File]::ReadAllText($src)
  $s = [regex]::Replace($s, '(?m)^import[^\r\n]*\r?\n', '')
  $names = [regex]::Matches($s, '(?m)^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)') |
    ForEach-Object { $_.Groups[1].Value }
  $s = [regex]::Replace($s, '(?m)^export\s*\{[^}]*\}\s*;?\s*\r?\n', '')
  $s = [regex]::Replace($s, '(?m)^export\s+(?=(async\s+)?(function|const|let|class))', '')
  $key = ([IO.Path]::GetFileNameWithoutExtension($dest) -replace '\.test$', '') -replace '[^\w]', '_'
  $list = $names -join ', '
  $assign = if ($names) { "`nObject.assign(globalThis, { $list });`nglobalThis['__module_$key'] = { $list };`n" } else { '' }
  [IO.File]::WriteAllText($dest, "(() => {`n$s$assign})();`n", [Text.UTF8Encoding]::new($false))
}
Convert-Module (Join-Path $root 'src\background\keys.js')   (Join-Path $tmp 'keys.js')
Convert-Module (Join-Path $root 'src\background\cloud.js')  (Join-Path $tmp 'cloud.js')
Convert-Module (Join-Path $root 'src\background\tavily.js') (Join-Path $tmp 'tavily.js')
Copy-Item (Join-Path $root 'src\offscreen\offscreen.js') $tmp -Force
Copy-Item (Join-Path $root 'src\lib\s2t.js')            $tmp -Force
Copy-Item (Join-Path $root 'src\lib\s2t-table.js')      $tmp -Force
Copy-Item (Join-Path $PSScriptRoot 'speech.js')         $tmp -Force

# ── 測試頁 ──────────────────────────────────────────────────────
# 金鑰用 JSON 注入。這個檔案在 tests\.tmp 底下（已 gitignore），跑完就刪。
$keysJson = ($keys | ConvertTo-Json -Compress)
$page = @"
<!doctype html>
<html><head><meta charset="utf-8"><title>雲端端到端驗證</title></head>
<body><pre id="out">（尚未執行）</pre>
<script>
addEventListener('error', (e) => {
  document.getElementById('out').textContent = 'FAIL  測試頁拋出錯誤  ->  ' + e.message + ' @' + e.lineno;
});
addEventListener('unhandledrejection', (e) => {
  document.getElementById('out').textContent = 'FAIL  未處理的 rejection  ->  ' + (e.reason && (e.reason.stack || e.reason));
});
// **把長延遲的計時器關掉。**
//
// --virtual-time-budget 會在頁面「閒著等網路」時快轉虛擬時鐘，於是
// cloud.js 與 tavily.js 用 setTimeout 排的逾時 abort 會在回應還沒回來
// 之前就觸發，把進行中的請求砍掉。實測症狀：
//   * 串流只收到第一個 token（「為」）就被中止
//   * Tavily 在 preflight 階段被砍，fetch 丟 TypeError: Failed to fetch
// 兩個看起來都像「產品壞了」，其實是這個 harness 的時鐘造成的。
//
// 逾時邏輯本來就不是這支要驗的東西（它驗的是請求送得出去、回應收得回來），
// 所以直接讓 >= 3 秒的計時器不生效。短計時器留著，不影響其他行為。
const _setTimeout = window.setTimeout.bind(window);
window.setTimeout = (fn, ms, ...rest) => (ms >= 3000 ? 0 : _setTimeout(fn, ms, ...rest));

const REAL_KEYS = $keysJson;
// keys.js 讀的是 chrome.storage.local，這裡用真金鑰餵它
window.chrome = {
  runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {}, getURL: (p) => p, lastError: undefined },
  storage: { local: { get: async (k) => (k === 'cloudKeys' ? { cloudKeys: REAL_KEYS } : {}), set: async () => {} } },
};
</script>
<script src="s2t-table.js"></script>
<script src="s2t.js"></script>
<script src="keys.js"></script>
<script src="cloud.js"></script>
<script src="tavily.js"></script>
<script src="offscreen.js"></script>
<script src="speech.js"></script>
<script>
const results = [];
const outEl = document.getElementById('out');

// **每一步都立刻寫進畫面。**
// 這支會真的打網路，而 --dump-dom 是一次性的：只在最後才寫的話，
// 任何一個請求卡住就只會看到「（尚未執行）」，完全看不出停在哪一步。
// 逐步寫入之後，卡住時畫面會停在最後一個完成的動作上。
const render = () => { outEl.textContent = results.join('\n'); };
const step = (what) => { results.push('…    ' + what); render(); };
const check = (name, cond, detail = '') => {
  // 步驟標記只是進度，被它後面的結果取代掉，不留在最終報告裡
  if (results.length && results[results.length - 1].startsWith('…')) results.pop();
  results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  ->  ' + detail));
  render();
};
const isTraditional = (t) => /[繁體會議對帳這個們設進來還發應]/.test(t) && !/[这个们对帐会议应发]/.test(t);

(async () => {
try {

// ══ 1. 對話：真的打得通，而且回繁體中文 ═══════════════════════
const prompt = [
  '以下是會議逐字稿片段：',
  '王小明：這季的結帳失敗率上升到百分之三，主要卡在金流商的回調延遲。',
  '主持人：Andy，你怎麼看這個問題？',
  '',
  '你是 Andy。請用繁體中文，條列 3 點簡短的回答建議。',
].join('\n');

// 這裡刻意不量時間：headless 的虛擬時鐘會讓每次呼叫都量到 10 毫秒左右，
// 斷言「夠快」會永遠通過。延遲請用 PowerShell 直接量（見檔頭）。
step('打 Groq 的 chat completions（即時回答）');
const ans = await cloudComplete({ role: 'answer', prompt, maxTokens: 300 });
check('即時回答打得通（真的 Groq API）', !!ans.text, JSON.stringify(ans).slice(0, 200));
check('回答是繁體中文', isTraditional(ans.text), ans.text.slice(0, 60));
check('回傳形狀跟 Claude Code 一致', ans.stopReason === 'end_turn', String(ans.stopReason));
check('沒有殘留 <think> 思考過程', !/<think>/i.test(ans.text), ans.text.slice(0, 60));
results.push('      [回答 ' + ans.vendor + '/' + ans.model + '] ' + ans.text.replace(/\s+/g, ' ').slice(0, 90));

// ══ 2. 摘要：走的是另一個模型（額度分桶）══════════════════════
step('打 Groq 的 chat completions（摘要，另一個模型）');
const sum = await cloudComplete({
  role: 'summary', maxTokens: 300,
  prompt: '把下面的逐字稿整理成三個重點，繁體中文：\n王小明：結帳失敗率百分之三。李美玲：退款要等兩天。',
});
check('摘要打得通', !!sum.text, JSON.stringify(sum).slice(0, 200));
check('摘要用的是跟回答不同的模型（額度分桶）', sum.model !== ans.model, sum.model + ' vs ' + ans.model);
check('摘要是繁體中文', isTraditional(sum.text), sum.text.slice(0, 60));
results.push('      [摘要 ' + sum.vendor + '/' + sum.model + '] ' + sum.text.replace(/\s+/g, ' ').slice(0, 90));

// ══ 3. 串流不在這裡測 ═════════════════════════════════════════
// 串流跟 headless 的虛擬時鐘根本不相容：
//   * 留著逾時計時器 → 虛擬時鐘快轉，abort 在回應回來前就把串流砍掉
//     （實測只收到第一個 token「為」）
//   * 拿掉逾時計時器 → 串流永遠不結束，整頁卡死在這一步
// 兩邊都不是產品的問題，但兩邊都會產生紅字，而紅字應該只留給真的壞掉的東西。
//
// 所以拆成兩半，各用適合的工具驗：
//   * **即時的 SSE 契約**（Groq 真的一塊一塊吐嗎）→ 這支腳本的 PowerShell 段
//     用 curl 在真實時間下驗，見上面的「串流（真實時間）」區塊。
//   * **SSE 解析器**（半行 JSON、事件切在 chunk 邊界）→ run.ps1 的
//     background 測試，用合成的串流餵它，不需要網路也不受時鐘影響。

// ══ 4. 語音辨識：真的音訊、真的 API ═══════════════════════════
// speech.js 是 16.6 秒的真實中文會議錄音（22050 Hz）
const wavBytes = Uint8Array.from(atob(window.__wavB64), (c) => c.charCodeAt(0));
const dv = new DataView(wavBytes.buffer);
const srcRate = dv.getUint32(24, true);
const pcm = new Int16Array(wavBytes.buffer, 44, (wavBytes.length - 44) >> 1);
const asFloat = Float32Array.from(pcm, (v) => v / 32768);
const audio = downsample(asFloat, srcRate);   // offscreen.js 的真函式

cloudKey = REAL_KEYS.groq;
cloudModel = 'whisper-large-v3-turbo';
cloudPrompt = '以下是繁體中文（台灣）的會議逐字稿。';
step('上傳 16.6 秒音訊到 Groq 辨識（這一步最久）');
const raw = await groqTranscribe(audio);      // offscreen.js 的真函式
const text = globalThis.toTraditional ? globalThis.toTraditional(raw) : raw;

check('雲端辨識打得通', !!raw.trim(), JSON.stringify(raw));
// 這幾個詞是本機 base 模型全部聽錯、small 才對的 —— 拿來當品質的實測基準
check('聽對「這季」', text.includes('這季'), text);
check('聽對「結帳」', text.includes('結帳'), text);
check('聽對「對帳」', text.includes('對帳'), text);
check('聽對人名「小陳」', text.includes('小陳'), text);
check('輸出是繁體', isTraditional(text), text);
results.push('      [辨識 ' + cloudModel + '] ' + text);

// ══ 5. Tavily 查證 ════════════════════════════════════════════
if (REAL_KEYS.tavily) {
  step('打 Tavily 查證');
  const found = await window.__module_tavily.searchWeb('台灣 營利事業所得稅 稅率');
  check('Tavily 查得到結果', found.ok && found.results.length > 0, JSON.stringify(found).slice(0, 200));
  check('整理成提示詞區塊', window.__module_tavily.formatForPrompt(found).includes('網路查證'),
    window.__module_tavily.formatForPrompt(found).slice(0, 80));
} else {
  results.push('SKIP  Tavily（沒有金鑰）');
}

// ══ 6. NVIDIA NIM 備援真的可用 ════════════════════════════════
if (REAL_KEYS.nvidia) {
  step('打 NVIDIA NIM 帳號 1');
  const r1 = await testKey('nim', REAL_KEYS.nvidia);
  check('NVIDIA 帳號 1 可用', r1.ok, JSON.stringify(r1));
  results.push('      [NIM#1 ' + (r1.model || '') + ']');
}
if (REAL_KEYS.nvidia2) {
  step('打 NVIDIA NIM 帳號 2');
  const r2 = await testKey('nim', REAL_KEYS.nvidia2);
  check('NVIDIA 帳號 2 可用', r2.ok, JSON.stringify(r2));
  results.push('      [NIM#2 ' + (r2.model || '') + ']');
}

// ══ 7. 壞金鑰要回可讀的錯誤，不是安靜失敗 ═════════════════════
step('用一把故意寫壞的金鑰打 Groq');
const bad = await testKey('groq', 'gsk_FAKEthiskeyisdeliberatelyinvalid00000');
check('壞金鑰會明確失敗', bad.ok === false && !!bad.error, JSON.stringify(bad));
check('壞金鑰的狀態碼是 401（可據以提示使用者）', bad.status === 401, String(bad.status));

} catch (err) {
  results.push('FAIL  測試中斷  ->  ' + (err && (err.stack || err.message || err)));
}

// 收尾。跑到這裡才寫「完成」那一行 —— 沒有這一行就代表中途卡住了，
// PowerShell 那邊據此分辨「真的跑完」與「虛擬時間用完才被截斷」。
const failed = results.filter((r) => r.startsWith('FAIL')).length;
results.push('---');
results.push(failed === 0
  ? ('全部 ' + results.filter((r) => r.startsWith('PASS')).length + ' 項通過')
  : (failed + ' 項失敗'));
results.push('__DONE__');
render();
})();
</script>
</body></html>
"@
$pagePath = Join-Path $tmp 'cloud.check.html'
[IO.File]::WriteAllText($pagePath, $page, [Text.UTF8Encoding]::new($false))

# ── 執行 ────────────────────────────────────────────────────────
$stdout = Join-Path $tmp 'out.txt'
$stderr = Join-Path $tmp 'err.txt'
$url = 'file:///' + ($pagePath -replace '\\', '/')

Write-Host '執行中（會真的打 API，約 15–60 秒）…' -ForegroundColor DarkGray
# 預算給得寬：這支要等好幾次真實的網路來回（其中上傳 16.6 秒音訊最久），
# 預算用完 Chrome 就直接把當下的 DOM 倒出來，看起來像「什麼都沒跑」。
Start-Process -FilePath $chrome -NoNewWindow -Wait `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
  -ArgumentList @(
    '--headless', '--dump-dom', '--virtual-time-budget=180000',
    '--disable-web-security', "--user-data-dir=$profileDir",
    '--no-first-run', '--no-default-browser-check', $url)

$dom = [IO.File]::ReadAllText($stdout)
$m = [regex]::Match($dom, '(?s)<pre id="out">(.*?)</pre>')

# 金鑰不留在磁碟上。跑完就刪，免得哪天有人把整個 tests 資料夾打包寄出去。
Remove-Item $pagePath -Force -ErrorAction SilentlyContinue

Write-Host ''
if (-not $m.Success) {
  Write-Host '沒有測試輸出 — 頁面可能在載入時就拋錯' -ForegroundColor Red
  Get-Content $stderr -TotalCount 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  exit 1
}

Write-Host '── 其餘（headless Chrome，跑真正的原始碼）──' -ForegroundColor Cyan

$text = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
$finished = $text -match '__DONE__'
$text = $text -replace '__DONE__', ''

# 從 curl 那一段帶過來，否則串流的失敗會在總計裡消失
$pass = $psPass; $fail = $psFail
foreach ($line in ($text -split "`n")) {
  if     ($line -match '^PASS') { $pass++; Write-Host "  $line" -ForegroundColor DarkGreen }
  elseif ($line -match '^FAIL') { $fail++; Write-Host "  $line" -ForegroundColor Red }
  elseif ($line -match '^SKIP') { Write-Host "  $line" -ForegroundColor DarkYellow }
  # 「…」開頭的是進度標記：只有卡在那一步時才會留下來
  elseif ($line -match '^…')    { Write-Host "  $line  ← 卡在這一步" -ForegroundColor Yellow }
  elseif ($line.Trim())         { Write-Host "  $line" -ForegroundColor DarkGray }
}

# 沒跑完就不是「通過」，不論已經綠了幾項。
# 舊版在這裡會印「0 項失敗（通過 0 項）」，那個訊息什麼都沒說 ——
# 它同時可以表示「一切正常但沒有測試」與「整個卡死」。
if (-not $finished) {
  Write-Host ''
  Write-Host '測試沒有跑完（頁面在中途停住，或虛擬時間預算用完就被截斷）。' -ForegroundColor Red
  if ($pass -eq 0 -and $fail -eq 0) {
    Write-Host '一項都沒跑到 —— 通常是連不上 API，或金鑰讀錯了。' -ForegroundColor Red
  } else {
    Write-Host "已完成 $pass 項，卡在上面標「←」的那一步。" -ForegroundColor Red
  }
  Write-Host 'Chrome 的錯誤輸出（前 15 行）：' -ForegroundColor DarkGray
  Get-Content $stderr -TotalCount 15 -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  exit 1
}

Write-Host ''
if ($fail -eq 0 -and $pass -gt 0) {
  Write-Host "雲端端到端驗證全部通過：$pass 項" -ForegroundColor Green
  Write-Host '（這支驗的是「對方收不收、回來的內容對不對」。延遲量不到 ——' -ForegroundColor DarkGray
  Write-Host '  headless 的虛擬時鐘會讓每次呼叫都顯示 10 毫秒左右，見檔頭說明。' -ForegroundColor DarkGray
  Write-Host '  實測的真實延遲：回答 0.7 秒、辨識 1.0 秒／16.6 秒音檔。）' -ForegroundColor DarkGray
  exit 0
} else {
  Write-Host "$fail 項失敗（通過 $pass 項）" -ForegroundColor Red
  exit 1
}
