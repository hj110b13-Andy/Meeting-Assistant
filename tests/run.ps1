<#
  會議助手 — 測試執行器

  用法：  powershell -ExecutionPolicy Bypass -File tests\run.ps1

  原理：這個專案沒有 Node/npm，所以直接把 Chrome 當測試執行環境。
  每個測試頁把 chrome.* API 換成 stub，載入「真正的」原始碼（不是複本），
  再用 --headless --dump-dom 把結果讀回來。

  引擎測試另外把 setInterval 與 Date.now 換成可控的假時鐘，
  所以字幕擷取流程是同步、確定性地跑完，不依賴 sleep。
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmp  = Join-Path $PSScriptRoot '.tmp'

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { Write-Error '找不到 Chrome 或 Edge，無法執行測試。'; exit 2 }

New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ── 準備待測檔案 ────────────────────────────────────────────────
# 內容腳本是傳統腳本，直接複製即可
Copy-Item (Join-Path $root 'src\content\core.js')     $tmp -Force
Copy-Item (Join-Path $root 'src\content\meet.js')     $tmp -Force
Copy-Item (Join-Path $root 'src\content\teams.js')    $tmp -Force
Copy-Item (Join-Path $root 'src\content\jitsi.js')    $tmp -Force
Copy-Item (Join-Path $root 'src\sidepanel\panel.js')  $tmp -Force
Copy-Item (Join-Path $root 'src\offscreen\offscreen.js') $tmp -Force
Copy-Item (Join-Path $root 'src\lib\s2t.js')           $tmp -Force
Copy-Item (Join-Path $root 'src\lib\s2t-table.js')     $tmp -Force
Copy-Item (Join-Path $root 'src\sidepanel\panel.css') $tmp -Force
Copy-Item (Join-Path $PSScriptRoot 'panel.stub.js')   $tmp -Force
Copy-Item (Join-Path $PSScriptRoot 'panel.drive.js')  $tmp -Force
Get-ChildItem $PSScriptRoot -Filter '*.test.html' | Copy-Item -Destination $tmp -Force

# 背景腳本是 ES module：只拿掉 import/export 關鍵字讓函式變成全域，其餘程式碼不動
# 每個模組包進自己的 IIFE，再把匯出的名稱掛到 globalThis。
# 不能直接攤平成全域：不同模組常有同名的 top-level const（例如 pending、seq），
# 攤平後會變成重複宣告，整個檔案不執行，而且錯誤很難看出來。
function Convert-Module($src, $dest) {
  $s = [IO.File]::ReadAllText($src)
  $s = [regex]::Replace($s, '(?m)^import[^\r\n]*\r?\n', '')

  # 只收集「這個檔案自己宣告」的匯出；純轉出的名稱由來源模組自己掛上
  $names = [regex]::Matches($s, '(?m)^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)') |
    ForEach-Object { $_.Groups[1].Value }

  $s = [regex]::Replace($s, '(?m)^export\s*\{[^}]*\}\s*;?\s*\r?\n', '')
  $s = [regex]::Replace($s, '(?m)^export\s+(?=(async\s+)?(function|const|let|class))', '')

  # 除了掛成全域，另外以 __module_<名稱> 匯出一份具名的命名空間物件。
  # service-worker.js 用 `import * as store`，測試頁需要一個等價的物件；
  # 手寫那份清單會在新增匯出時安靜漏掉（deferSummary 就漏過一次），所以自動生成。
  # 檔名裡的連字號不能直接接在屬性名後面（globalThis.__module_whisper-native = …
  # 是語法錯誤，而且會安靜地讓整個 IIFE 不執行 —— 踩過一次了）。
  # 一律換成底線，並且用中括號存取。
  $key = ([IO.Path]::GetFileNameWithoutExtension($dest) -replace '\.test$', '') -replace '[^\w]', '_'
  $list = $names -join ', '
  $assign = if ($names) {
    "`nObject.assign(globalThis, { $list });`nglobalThis['__module_$key'] = { $list };`n"
  } else { '' }
  [IO.File]::WriteAllText($dest, "(() => {`n$s$assign})();`n", [Text.UTF8Encoding]::new($false))
}
Convert-Module (Join-Path $root 'src\background\store.js')          (Join-Path $tmp 'store.test.js')
Convert-Module (Join-Path $root 'src\background\settings.js')       (Join-Path $tmp 'settings.test.js')
Convert-Module (Join-Path $root 'src\background\localmodel.js')     (Join-Path $tmp 'localmodel.test.js')
Convert-Module (Join-Path $root 'src\background\claudecode.js')     (Join-Path $tmp 'claudecode.test.js')
Convert-Module (Join-Path $root 'src\background\keys.js')           (Join-Path $tmp 'keys.test.js')
Convert-Module (Join-Path $root 'src\background\cloud.js')          (Join-Path $tmp 'cloud.test.js')
Convert-Module (Join-Path $root 'src\background\tavily.js')         (Join-Path $tmp 'tavily.test.js')
Convert-Module (Join-Path $root 'src\background\provider.js')       (Join-Path $tmp 'provider.test.js')
Convert-Module (Join-Path $root 'src\background\whisper-native.js') (Join-Path $tmp 'whisper-native.test.js')
Convert-Module (Join-Path $root 'src\background\service-worker.js') (Join-Path $tmp 'sw.test.js')

# 側邊欄測試用真正的 panel.html，只在 panel.js 前後插入 stub 與驅動腳本
$panel = [IO.File]::ReadAllText((Join-Path $root 'src\sidepanel\panel.html'))
$panel = $panel.Replace(
  '<script src="panel.js"></script>',
  "<script src=`"panel.stub.js`"></script>`n<script src=`"panel.js`"></script>`n<script src=`"panel.drive.js`"></script>")
[IO.File]::WriteAllText((Join-Path $tmp 'panel.test.html'), $panel, [Text.UTF8Encoding]::new($false))

# ── 逐頁執行 ────────────────────────────────────────────────────
$pages = @(
  @{ File = 'engine.test.html';     Name = '字幕擷取引擎（Meet / Teams）'; Pre = 'out' },
  @{ File = 'store.test.html';      Name = '逐字稿狀態與匯出';             Pre = 'out' },
  @{ File = 'panel.test.html';      Name = '側邊欄 UI';                    Pre = 'testout' },
  @{ File = 'background.test.html'; Name = '背景邏輯與 Claude 用戶端';     Pre = 'out' },
  @{ File = 'offscreen.test.html';  Name = '音訊處理（重疊去重／靜音／WAV／原生引擎）'; Pre = 'out' },
  @{ File = 's2t.test.html';        Name = '簡繁轉換（本機辨識輸出用）'; Pre = 'out' }
)

$totalPass = 0; $totalFail = 0

foreach ($p in $pages) {
  $stdout = Join-Path $tmp ($p.File + '.out')
  $stderr = Join-Path $tmp ($p.File + '.err')
  $url = 'file:///' + ((Join-Path $tmp $p.File) -replace '\\', '/')

  Start-Process -FilePath $chrome -NoNewWindow -Wait `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
    -ArgumentList @('--headless', '--dump-dom', '--virtual-time-budget=8000', $url)

  $dom = [IO.File]::ReadAllText($stdout)
  $m = [regex]::Match($dom, "(?s)<pre id=`"$($p.Pre)`">(.*?)</pre>")

  Write-Host ''
  Write-Host "── $($p.Name) ──" -ForegroundColor Cyan
  if (-not $m.Success) {
    Write-Host '  沒有測試輸出 — 頁面可能在載入時就拋錯' -ForegroundColor Red
    Get-Content $stderr -TotalCount 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    $totalFail++
    continue
  }

  $text = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
  $pagePass = 0; $pageFail = 0
  foreach ($line in ($text -split "`n")) {
    if ($line -match '^PASS') { $totalPass++; $pagePass++; Write-Host "  $line" -ForegroundColor DarkGreen }
    elseif ($line -match '^FAIL') { $totalFail++; $pageFail++; Write-Host "  $line" -ForegroundColor Red }
  }
  # 一個測試頁跑出零項結果，代表它在載入時就死了（例如引用了不存在的腳本）。
  # 不當成失敗的話，整個區塊會安靜地消失，而總數看起來仍然「全部通過」——
  # 這比一個紅字還危險，因為沒有人會發現少跑了幾十項。
  if ($pagePass -eq 0 -and $pageFail -eq 0) {
    Write-Host "  這一頁沒有產生任何測試結果（載入時就失敗？）" -ForegroundColor Red
    Write-Host "  頁面內容：$($text.Trim())" -ForegroundColor DarkGray
    $totalFail++
  }
}

Write-Host ''
if ($totalFail -eq 0) {
  Write-Host "全部通過：$totalPass 項" -ForegroundColor Green
  exit 0
} else {
  Write-Host "$totalFail 項失敗（通過 $totalPass 項）" -ForegroundColor Red
  exit 1
}
