<#
  專案一致性檢查 —— 抓的是「測試跑得過但東西還是壞的」那一類問題

  用法：  powershell -ExecutionPolicy Bypass -File tests\check-project.ps1

  檢查項目：
    1. 每個 .ps1 都有 UTF-8 BOM 且語法正確
       （PS 5.1 沒有 BOM 會用 Big5 解碼中文，報出跟真正問題無關的 MissingEndCurlyBrace）
    2. host.bat 是 CRLF
       （cmd.exe 讀 LF-only 批次檔會把 powershell.exe 切成 powershell. 與 exe）
    3. manifest.json 是合法 JSON，而且**裡面提到的每個檔案都真的存在**
    4. 每個 .js 都能被瀏覽器載入（module 與傳統腳本各用對應方式）
    5. 沒有測試檔案引用到已經改名／刪掉的來源檔
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pass = 0
$fail = 0

function Check($name, $ok, $detail = '') {
  if ($ok) { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor DarkGreen }
  else { $script:fail++; Write-Host "  FAIL  $name  ->  $detail" -ForegroundColor Red }
}

# ── 1. PowerShell 檔案的編碼與語法 ──────────────────────────────
Write-Host ''
Write-Host '── PowerShell 檔案 ──' -ForegroundColor Cyan
foreach ($f in Get-ChildItem $root -Recurse -Filter '*.ps1' -File | Where-Object { $_.FullName -notlike '*\.tmp\*' }) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [IO.File]::ReadAllText($f.FullName)
  $hasChinese = $text -match '[一-鿿]'
  # 只有含中文的檔案才非得要 BOM；純 ASCII 的檔案沒有 BOM 也不會被誤解
  Check "$rel BOM" ($hasBom -or -not $hasChinese) '含中文卻沒有 UTF-8 BOM，PS 5.1 會用 Big5 解碼'

  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors)
  Check "$rel 語法" (-not $errors) ($errors | Select-Object -First 1 | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" })
}

# ── 2. 批次檔換行 ───────────────────────────────────────────────
Write-Host ''
Write-Host '── 批次檔 ──' -ForegroundColor Cyan
foreach ($f in Get-ChildItem $root -Recurse -Filter '*.bat' -File) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $raw = [IO.File]::ReadAllBytes($f.FullName)
  $lf = 0; $crlf = 0
  for ($i = 0; $i -lt $raw.Length; $i++) {
    if ($raw[$i] -eq 0x0A) { if ($i -gt 0 -and $raw[$i - 1] -eq 0x0D) { $crlf++ } else { $lf++ } }
  }
  Check "$rel 是 CRLF" ($lf -eq 0) "有 $lf 個裸 LF，cmd.exe 會把指令 token 切錯"
}

# ── 2b. 底線開頭的檔名會擋掉整個擴充功能 ────────────────────────
# Chrome 保留 `_` 開頭給自己（_metadata、_locales）。資料夾裡只要有一個
# 底線開頭的檔案或目錄，**整個擴充功能就載入不了**，錯誤訊息是
# 「Cannot load extension with file or directory name X」。
# 放暫存檔時很容易踩到（我用 _delete-after-reboot 當暫名時就中過）。
Write-Host ''
Write-Host '── 保留字首 ──' -ForegroundColor Cyan
$reserved = Get-ChildItem $root -Recurse -Force |
  Where-Object { $_.Name.StartsWith('_') -and $_.FullName -notlike '*\.git\*' } |
  ForEach-Object { $_.FullName.Substring($root.Length + 1) }
Check '沒有底線開頭的檔案或資料夾' ($reserved.Count -eq 0) ($reserved -join ', ')

# ── 3. manifest.json ────────────────────────────────────────────
Write-Host ''
Write-Host '── manifest.json ──' -ForegroundColor Cyan
$manifestPath = Join-Path $root 'manifest.json'
$manifest = $null
try {
  $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  Check 'manifest.json 是合法 JSON' $true
} catch {
  Check 'manifest.json 是合法 JSON' $false $_.Exception.Message
}

if ($manifest) {
  $refs = New-Object System.Collections.Generic.List[string]
  $refs.Add($manifest.background.service_worker)
  $refs.Add($manifest.side_panel.default_path)
  $refs.Add($manifest.options_page)
  foreach ($cs in $manifest.content_scripts) { foreach ($js in $cs.js) { $refs.Add($js) } }
  foreach ($p in $manifest.icons.PSObject.Properties) { $refs.Add($p.Value) }
  foreach ($p in $manifest.action.default_icon.PSObject.Properties) { $refs.Add($p.Value) }

  foreach ($r in ($refs | Where-Object { $_ } | Sort-Object -Unique)) {
    Check "manifest 提到的 $r 存在" (Test-Path (Join-Path $root $r)) '檔案不存在'
  }

  # 本機辨識伺服器的 host permission 必須跟程式碼裡的埠號一致，
  # 不一致的話 fetch 會被擋掉，而且錯誤訊息只會說 Failed to fetch。
  $portInCode = ([regex]::Match([IO.File]::ReadAllText((Join-Path $root 'src\background\whisper-native.js')),
                 'STT_PORT\s*=\s*(\d+)')).Groups[1].Value
  $hasPerm = ($manifest.host_permissions -contains "http://127.0.0.1:$portInCode/*")
  Check "manifest 有 127.0.0.1:$portInCode 的 host permission" $hasPerm ($manifest.host_permissions -join ', ')

  $portInBridge = ([regex]::Match([IO.File]::ReadAllText((Join-Path $root 'bridge\host.ps1')),
                   'STT_PORT\s*=\s*(\d+)')).Groups[1].Value
  Check '橋接與擴充功能用同一個埠號' ($portInBridge -eq $portInCode) "bridge=$portInBridge, ext=$portInCode"
}

# ── 4. offscreen.html 的載入順序 ────────────────────────────────
Write-Host ''
Write-Host '── 載入順序 ──' -ForegroundColor Cyan
# 只看真正的 <script src>，不要用 IndexOf 掃全文 ——
# 註解裡也會提到這些檔名，掃全文會量到註解的位置。
$off = [IO.File]::ReadAllText((Join-Path $root 'src\offscreen\offscreen.html'))
$scripts = [regex]::Matches($off, '<script[^>]*\ssrc="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$order = $scripts -join ' → '
$iTable = [Array]::FindIndex([string[]]$scripts, [Predicate[string]] { $args[0] -like '*s2t-table.js' })
$iConv  = [Array]::FindIndex([string[]]$scripts, [Predicate[string]] { $args[0] -like '*/s2t.js' -or $args[0] -eq 's2t.js' })
$iMain  = [Array]::FindIndex([string[]]$scripts, [Predicate[string]] { $args[0] -like '*offscreen.js' })
Check 's2t-table.js 在 s2t.js 之前' ($iTable -ge 0 -and $iConv -gt $iTable) $order
Check 's2t.js 在 offscreen.js 之前' ($iConv -ge 0 -and $iMain -gt $iConv) $order

# ── 5. 測試執行器引用的來源檔都存在 ─────────────────────────────
Write-Host ''
Write-Host '── 測試執行器 ──' -ForegroundColor Cyan
$runner = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'run.ps1'))
foreach ($m in [regex]::Matches($runner, "Join-Path \`$root '([^']+)'")) {
  $p = $m.Groups[1].Value
  Check "run.ps1 引用的 $p 存在" (Test-Path (Join-Path $root $p)) '檔案不存在'
}

# ── 6. JavaScript 語法 ──────────────────────────────────────────
Write-Host ''
Write-Host '── JavaScript ──' -ForegroundColor Cyan
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Host '  （找不到 Chrome，跳過 JS 語法檢查）' -ForegroundColor DarkYellow
} else {
  $jsFiles = Get-ChildItem (Join-Path $root 'src') -Recurse -Filter '*.js' -File |
    ForEach-Object { ($_.FullName.Substring($root.Length + 1)) -replace '\\', '/' }

  # 每個檔案都用 <script type="module"> 載入。傳統腳本用 module 載入也能驗語法
  # （唯一差別是 top-level 的東西不會變全域，這裡不在意）。
  $tags = ($jsFiles | ForEach-Object { "    '$_'," }) -join "`n"
  $page = @"
<!doctype html><meta charset="utf-8"><pre id="out">x</pre>
<script>
const FILES = [
$tags
];
(async () => {
  const bad = [];
  for (const f of FILES) {
    try {
      await import('../' + f);
    } catch (err) {
      // 執行期錯誤（例如 chrome 不存在）不算語法錯誤，只挑真正的 SyntaxError
      const msg = String(err && err.message || err);
      if (err instanceof SyntaxError || /Unexpected|Invalid or unexpected/.test(msg)) {
        bad.push(f + ': ' + msg);
      }
    }
  }
  document.getElementById('out').textContent = bad.length ? bad.join('\n') : 'OK ' + FILES.length;
})();
</script>
"@
  $dir = Join-Path $PSScriptRoot '.tmp'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $probe = Join-Path $dir 'jscheck.html'
  [IO.File]::WriteAllText($probe, $page, [Text.UTF8Encoding]::new($false))

  $out = Join-Path $dir 'jscheck.out'
  Start-Process -FilePath $chrome -NoNewWindow -Wait -RedirectStandardOutput $out `
    -RedirectStandardError (Join-Path $dir 'jscheck.err') `
    -ArgumentList @('--headless', '--dump-dom', '--virtual-time-budget=20000',
                    '--allow-file-access-from-files',
                    ('file:///' + ($probe -replace '\\', '/')))

  $dom = [IO.File]::ReadAllText($out)
  $m = [regex]::Match($dom, '(?s)<pre id="out">(.*?)</pre>')
  $result = if ($m.Success) { [Net.WebUtility]::HtmlDecode($m.Groups[1].Value).Trim() } else { '(沒有輸出)' }
  Check 'src/ 下每個 .js 都沒有語法錯誤' ($result -like 'OK *') $result
  if ($result -like 'OK *') { Write-Host "        （檢查了 $($jsFiles.Count) 個檔案）" -ForegroundColor DarkGray }
}

Write-Host ''
if ($fail -eq 0) {
  Write-Host "專案檢查全部通過：$pass 項" -ForegroundColor Green
  exit 0
} else {
  Write-Host "$fail 項失敗（通過 $pass 項）" -ForegroundColor Red
  exit 1
}
