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
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmp  = Join-Path $PSScriptRoot '.tmp\cloud'
$profileDir = Join-Path $PSScriptRoot '.cloudprofile'

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
const check = (name, cond, detail = '') =>
  results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  ->  ' + detail));
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

const t0 = Date.now();
const ans = await cloudComplete({ role: 'answer', prompt, maxTokens: 300 });
const ansMs = Date.now() - t0;
check('即時回答打得通（真的 Groq API）', !!ans.text, JSON.stringify(ans).slice(0, 200));
check('回答夠快（3 秒內）', ansMs < 3000, ansMs + ' 毫秒');
check('回答是繁體中文', isTraditional(ans.text), ans.text.slice(0, 60));
check('回傳形狀跟 Claude Code 一致', ans.stopReason === 'end_turn', String(ans.stopReason));
check('沒有殘留 <think> 思考過程', !/<think>/i.test(ans.text), ans.text.slice(0, 60));
results.push('      [回答 ' + ans.vendor + '/' + ans.model + ' ' + ansMs + 'ms] ' + ans.text.replace(/\s+/g, ' ').slice(0, 90));

// ══ 2. 摘要：走的是另一個模型（額度分桶）══════════════════════
const t1 = Date.now();
const sum = await cloudComplete({
  role: 'summary', maxTokens: 300,
  prompt: '把下面的逐字稿整理成三個重點，繁體中文：\n王小明：結帳失敗率百分之三。李美玲：退款要等兩天。',
});
const sumMs = Date.now() - t1;
check('摘要打得通', !!sum.text, JSON.stringify(sum).slice(0, 200));
check('摘要用的是跟回答不同的模型（額度分桶）', sum.model !== ans.model, sum.model + ' vs ' + ans.model);
check('摘要是繁體中文', isTraditional(sum.text), sum.text.slice(0, 60));
results.push('      [摘要 ' + sum.vendor + '/' + sum.model + ' ' + sumMs + 'ms] ' + sum.text.replace(/\s+/g, ' ').slice(0, 90));

// ══ 3. 串流：真的 SSE，不是一次吐完 ═══════════════════════════
const chunks = [];
let firstDeltaMs = 0;
const t2 = Date.now();
const streamed = await cloudStream({
  role: 'answer', maxTokens: 200,
  prompt: '用繁體中文寫三句話說明如何降低退款延遲。',
  onDelta: (d) => { if (!chunks.length) firstDeltaMs = Date.now() - t2; chunks.push(d); },
});
check('串流拿得到內容', !!streamed.text, JSON.stringify(streamed).slice(0, 200));
check('真的是逐塊送達（不是一次吐完）', chunks.length > 3, chunks.length + ' 塊');
check('第一個字很快就出現（1.5 秒內）', firstDeltaMs > 0 && firstDeltaMs < 1500, firstDeltaMs + ' 毫秒');
check('串流組回來的文字跟回傳值一致',
  chunks.join('').replace(/\s/g, '').includes(streamed.text.replace(/\s/g, '').slice(0, 20)),
  streamed.text.slice(0, 40));
results.push('      [串流 ' + streamed.model + ' 首字 ' + firstDeltaMs + 'ms、共 ' + chunks.length + ' 塊]');

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
const t3 = Date.now();
const raw = await groqTranscribe(audio);      // offscreen.js 的真函式
const sttMs = Date.now() - t3;
const text = globalThis.toTraditional ? globalThis.toTraditional(raw) : raw;

check('雲端辨識打得通', !!raw.trim(), JSON.stringify(raw));
check('辨識比即時快很多（RTF < 0.3）', sttMs / 16600 < 0.3, 'RTF ' + (sttMs / 16600).toFixed(3));
// 這幾個詞是本機 base 模型全部聽錯、small 才對的 —— 拿來當品質的實測基準
check('聽對「這季」', text.includes('這季'), text);
check('聽對「結帳」', text.includes('結帳'), text);
check('聽對「對帳」', text.includes('對帳'), text);
check('聽對人名「小陳」', text.includes('小陳'), text);
check('輸出是繁體', isTraditional(text), text);
results.push('      [辨識 ' + sttMs + 'ms RTF ' + (sttMs / 16600).toFixed(3) + '] ' + text);

// ══ 5. Tavily 查證 ════════════════════════════════════════════
if (REAL_KEYS.tavily) {
  const found = await window.__module_tavily.search('台灣 營利事業所得稅 稅率');
  check('Tavily 查得到結果', found.ok && found.results.length > 0, JSON.stringify(found).slice(0, 200));
  check('整理成提示詞區塊', window.__module_tavily.formatForPrompt(found).includes('網路查證'),
    window.__module_tavily.formatForPrompt(found).slice(0, 80));
} else {
  results.push('SKIP  Tavily（沒有金鑰）');
}

// ══ 6. NVIDIA NIM 備援真的可用 ════════════════════════════════
if (REAL_KEYS.nvidia) {
  const r1 = await testKey('nim', REAL_KEYS.nvidia);
  check('NVIDIA 帳號 1 可用', r1.ok, JSON.stringify(r1));
  results.push('      [NIM#1 ' + (r1.ms || '?') + 'ms ' + (r1.model || '') + ']');
}
if (REAL_KEYS.nvidia2) {
  const r2 = await testKey('nim', REAL_KEYS.nvidia2);
  check('NVIDIA 帳號 2 可用', r2.ok, JSON.stringify(r2));
  results.push('      [NIM#2 ' + (r2.ms || '?') + 'ms ' + (r2.model || '') + ']');
}

// ══ 7. 壞金鑰要回可讀的錯誤，不是安靜失敗 ═════════════════════
const bad = await testKey('groq', 'gsk_FAKEthiskeyisdeliberatelyinvalid00000');
check('壞金鑰會明確失敗', bad.ok === false && !!bad.error, JSON.stringify(bad));
check('壞金鑰的狀態碼是 401（可據以提示使用者）', bad.status === 401, String(bad.status));

} catch (err) {
  results.push('FAIL  測試中斷  ->  ' + (err && (err.stack || err.message || err)));
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
document.getElementById('out').textContent =
  results.join('\n') + '\n---\n' + (failed === 0 ? ('全部 ' + results.filter(r=>r.startsWith('PASS')).length + ' 項通過') : (failed + ' 項失敗'));
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

Write-Host '執行中（會真的打 API，約 15–30 秒）…' -ForegroundColor DarkGray
Start-Process -FilePath $chrome -NoNewWindow -Wait `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
  -ArgumentList @(
    '--headless', '--dump-dom', '--virtual-time-budget=60000',
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

$text = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
$pass = 0; $fail = 0
foreach ($line in ($text -split "`n")) {
  if     ($line -match '^PASS') { $pass++; Write-Host "  $line" -ForegroundColor DarkGreen }
  elseif ($line -match '^FAIL') { $fail++; Write-Host "  $line" -ForegroundColor Red }
  elseif ($line -match '^SKIP') { Write-Host "  $line" -ForegroundColor DarkYellow }
  elseif ($line.Trim())         { Write-Host "  $line" -ForegroundColor DarkGray }
}

Write-Host ''
if ($fail -eq 0 -and $pass -gt 0) {
  Write-Host "雲端端到端驗證全部通過：$pass 項" -ForegroundColor Green
  exit 0
} else {
  Write-Host "$fail 項失敗（通過 $pass 項）" -ForegroundColor Red
  exit 1
}
