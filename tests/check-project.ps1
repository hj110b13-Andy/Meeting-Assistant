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

  # 程式碼裡出現的每一個外部端點都要有對應的 host permission。
  # 少了的話 fetch 會被擋掉，而且錯誤訊息只會說 Failed to fetch ——
  # 看起來像網路問題或金鑰問題，完全不指向 manifest。
  # 只認**字串字面值**裡的網址。不加引號限制的話會掃到註解裡的範例
  # （settings.js 就有一個 https://jitsi.x.com/room 用來說明輸入格式），
  # 然後要求為一個根本不存在的網域加權限。
  $hosts = @{}
  foreach ($f in (Get-ChildItem (Join-Path $root 'src') -Recurse -Filter '*.js')) {
    foreach ($m in [regex]::Matches([IO.File]::ReadAllText($f.FullName), '[''"`]https://([a-z0-9.-]+\.[a-z]{2,})/')) {
      $hosts[$m.Groups[1].Value] = $true
    }
  }
  # 會議平台的網域由 content_scripts 的 matches 涵蓋，不需要 host permission
  $platform = @('meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'meet.jit.si')
  foreach ($h in ($hosts.Keys | Sort-Object)) {
    if ($platform -contains $h) { continue }
    $covered = $manifest.host_permissions | Where-Object { $_ -like "https://$h/*" -or $_ -eq 'https://*/*' }
    Check "manifest 有 $h 的 host permission" ([bool]$covered) ($manifest.host_permissions -join ', ')
  }
}

# ── 3b. 金鑰不能進版控 ──────────────────────────────────────────
# 這個 repo 是公開的。金鑰只要推上去一次就等於外洩 —— 就算之後 commit
# 刪掉，GitHub 仍保留該 blob，掃描機器人通常幾分鐘內就會撿走，
# 只能到各家後台重新簽發。所以在能推之前先擋下來。
Write-Host ''
Write-Host '── 金鑰外洩防護 ──' -ForegroundColor Cyan
$secretPatterns = @(
  @{ Name = 'GroqCloud';  Regex = 'gsk_[A-Za-z0-9]{20,}' },
  @{ Name = 'NVIDIA NIM'; Regex = 'nvapi-[A-Za-z0-9_\-]{20,}' },
  @{ Name = 'Tavily';     Regex = 'tvly-[A-Za-z0-9\-]{20,}' },
  @{ Name = 'Anthropic';  Regex = 'sk-ant-[A-Za-z0-9\-]{20,}' }
)

# 只檢查 git 追蹤中的檔案：未追蹤的（例如使用者自己的 API Key.txt）
# 本來就不會被推上去，對它們報錯只會製造雜訊。
$tracked = @()
try { $tracked = & git -C $root ls-files 2>$null } catch {}

if (-not $tracked) {
  Check 'git 追蹤清單讀得到' $false '不在 git repo 裡，或 git 不可用 —— 無法檢查金鑰外洩'
} else {
  $leaks = @()
  foreach ($rel in $tracked) {
    $full = Join-Path $root $rel
    if (-not (Test-Path $full)) { continue }
    # 只讀文字檔，跳過圖片之類的二進位檔
    if ($rel -match '\.(png|jpg|jpeg|gif|ico|zip|bin|exe|dll|wasm)$') { continue }
    $text = ''
    try { $text = [IO.File]::ReadAllText($full) } catch { continue }
    foreach ($p in $secretPatterns) {
      foreach ($m in [regex]::Matches($text, $p.Regex)) {
        # 測試需要「長得像真的」的假金鑰（例如驗證遮罩不會洩漏中段），
        # 所以約定假金鑰一律含大寫 FAKE。真的金鑰不會有這個字串，
        # 而且這個約定是**明示**的 —— 比整個跳過 tests/ 安全，
        # 因為除錯時最容易不小心把真金鑰貼進測試檔。
        if ($m.Value -cmatch 'FAKE') { continue }
        $leaks += "$rel（$($p.Name)）"
      }
    }
  }
  Check '版控裡沒有任何 API 金鑰' ($leaks.Count -eq 0) ($leaks -join '; ')

  # .gitignore 要真的擋得住使用者放金鑰的那個檔案
  $ignored = & git -C $root check-ignore 'API Key.txt' 2>$null
  Check '「API Key.txt」被 .gitignore 擋住' ([bool]$ignored) '這個檔名沒有被忽略，貼了金鑰就會被推上去'
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

# ── 4.5 側邊欄文案沒有指向已經不存在的東西 ──────────────────────
#
# 側邊欄的說明文字是使用者遇到問題時唯一的指引，指向一顆已經移除的按鈕、
# 或一條已經刪掉的付費路線，比不給建議更糟 —— 使用者會照著去找，找不到，
# 然後以為是自己哪裡設錯了。
#
# 這類錯誤不會有例外、不會有紅字，功能也照常運作，所以只能靠掃描抓。
Write-Host ''
Write-Host '── 側邊欄文案 ──' -ForegroundColor Cyan
$panelJs = [IO.File]::ReadAllText((Join-Path $root 'src\sidepanel\panel.js'), [Text.UTF8Encoding]::new($false))
$panelHtml = [IO.File]::ReadAllText((Join-Path $root 'src\sidepanel\panel.html'), [Text.UTF8Encoding]::new($false))

# 只看真正會顯示給使用者的字串（引號裡的），不看註解 —— 註解本來就會
# 為了解釋「為什麼拿掉」而提到這些名字。
$panelStrings = ([regex]::Matches($panelJs, "'([^'\r\n]*)'") | ForEach-Object { $_.Groups[1].Value }) -join "`n"
$panelStrings += "`n" + (([regex]::Matches($panelJs, '`([^`]*)`') | ForEach-Object { $_.Groups[1].Value }) -join "`n")

foreach ($gone in @('存檔給 Claude Code', 'Deepgram', '按量計費')) {
  Check "文案沒有提到已移除的「$gone」" ($panelStrings -notmatch [regex]::Escape($gone)) `
    '這條路已經刪掉了，訊息會把使用者帶到死路'
}

# panel.js 拿得到的每個元素都要真的在 panel.html 裡。$('x') 回傳 null 時
# 後面接的 .textContent／.addEventListener 會直接丟例外，而那是在模組頂層 ——
# **整支 panel.js 停掉**，側邊欄變成一片空白，看起來像檔案沒載入。
# 移除按鈕時最容易漏掉這種殘留。
$panelIds = [regex]::Matches($panelJs, "\`$\('([A-Za-z0-9_]+)'\)") |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($id in $panelIds) {
  Check "panel.js 用到的 #$id 在 panel.html 裡存在" ($panelHtml -match "id=""$id""") `
    'panel.js 會在這裡丟 null 例外，而且是整支腳本停掉'
}

# 每個 startAudioFallback 回得出來的引擎都要有自己的說明分支。
# 少一個的話使用者會收到「描述另一條路」的訊息 —— 踩過一次：預設換成
# groq 之後忘了加分支，所有正常設定好金鑰的人都被叫去裝本機 whisper。
$swJs = [IO.File]::ReadAllText((Join-Path $root 'src\background\service-worker.js'), [Text.UTF8Encoding]::new($false))
$msgFn = [regex]::Match($panelJs, 'function sttStartedMessage[\s\S]*?\n\}')
Check 'panel.js 有 sttStartedMessage' $msgFn.Success '找不到引擎說明的函式'
foreach ($engine in @('groq', 'whisper-native')) {
  Check "引擎「$engine」有自己的說明分支" ($msgFn.Value -match [regex]::Escape("'$engine'")) `
    '會掉到最後那句備援訊息，描述的是使用者根本沒在走的路'
}
Check 'service-worker 的預設引擎是 groq' ($swJs -match "settings\.sttEngine \|\| 'groq'") `
  '預設引擎改了的話，上面那些分支也要跟著檢查'

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
