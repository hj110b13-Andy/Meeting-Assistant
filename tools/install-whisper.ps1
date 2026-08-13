<#
  安裝本機原生語音辨識（whisper.cpp）

  用法：  powershell -ExecutionPolicy Bypass -File tools\install-whisper.ps1
  只裝小模型：  ... -Models small
  重新下載：    ... -Force

  為什麼要有這個而不是把檔案放進擴充功能資料夾：

  1. 檔案太大（執行檔 20 MB + 模型 57／181 MB），不適合放在擴充功能裡。
  2. **whisper.cpp 在 Windows 上打不開非 ASCII 路徑。** 它用窄字元 API 開檔，
     路徑會先被轉成系統 ANSI（正體中文機器是 CP950），像「會議助手」這種
     資料夾名會變成亂碼，開檔直接失敗（實測 whisper-cli 結束碼 9）。
     所以執行檔與模型一定要裝在純 ASCII 路徑，這支腳本會檢查。

  裝好之後，擴充功能透過 bridge（Native Messaging）啟動 whisper-server.exe，
  再用 HTTP POST 把音訊送到 127.0.0.1。伺服器只綁本機位址，不對外開放。
#>

param(
  [ValidateSet('both', 'small', 'base')]
  [string]$Models = 'both',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest 的進度條會讓大檔下載慢好幾倍

$WHISPER_VERSION = 'v1.9.2'
$ZIP_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VERSION/whisper-blas-bin-x64.zip"
$MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

# ── 決定安裝位置（必須是純 ASCII） ──────────────────────────────
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'MeetingAssistant\whisper'),
  'C:\MeetingAssistant\whisper'
)
$dst = $null
foreach ($c in $candidates) {
  if ($c -match '^[\x20-\x7E]+$') { $dst = $c; break }
}
if (-not $dst) {
  Write-Error @'
找不到可用的純 ASCII 安裝路徑。
你的使用者資料夾含有非 ASCII 字元，而 whisper.cpp 在 Windows 上打不開這種路徑。
請自行建立一個純英文路徑（例如 C:\whisper），把這支腳本的 $candidates 改成它再執行。
'@
  exit 2
}

Write-Host "安裝位置：$dst"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dst 'public') | Out-Null

# ── 需要的檔案 ──────────────────────────────────────────────────
# ggml-cpu-*.dll 是各代 CPU 的最佳化版本，whisper 執行時自己挑一個載入，
# 所以全部保留（合計約 8 MB）；SDL2.dll 只有麥克風串流範例用得到，不要。
$needed = @('whisper-server.exe', 'whisper-cli.exe', 'whisper.dll', 'ggml.dll',
            'ggml-base.dll', 'ggml-blas.dll', 'libopenblas.dll')
$neededPattern = 'ggml-cpu-*.dll'

$haveBinaries = -not $Force
foreach ($f in $needed) { if (-not (Test-Path (Join-Path $dst $f))) { $haveBinaries = $false } }

if ($haveBinaries) {
  Write-Host '執行檔已存在，跳過下載（要重抓請加 -Force）'
} else {
  $zip = Join-Path $env:TEMP "whisper-blas-$WHISPER_VERSION.zip"
  if ((Test-Path $zip) -and -not $Force) {
    Write-Host '使用已下載的 zip'
  } else {
    Write-Host "下載 whisper.cpp $WHISPER_VERSION（約 20 MB）…"
    Invoke-WebRequest -Uri $ZIP_URL -OutFile $zip -UseBasicParsing -TimeoutSec 600
  }

  $unzip = Join-Path $env:TEMP "whisper-blas-$WHISPER_VERSION-x"
  if (Test-Path $unzip) { Remove-Item $unzip -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $unzip -Force

  # release zip 內的版面偶有變動，用搜尋而不是固定相對路徑
  $srcDir = (Get-ChildItem $unzip -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1).DirectoryName
  if (-not $srcDir) { Write-Error 'zip 裡找不到 whisper-server.exe，發佈檔內容可能改了。'; exit 3 }

  foreach ($f in $needed) {
    $p = Join-Path $srcDir $f
    if (-not (Test-Path $p)) { Write-Error "zip 裡缺少 $f"; exit 3 }
    Copy-Item $p $dst -Force
  }
  Get-ChildItem $srcDir -Filter $neededPattern | ForEach-Object { Copy-Item $_.FullName $dst -Force }
  Write-Host '執行檔安裝完成'
}

# whisper-server 啟動時會 mount 這個資料夾當靜態網站根目錄；
# 資料夾不存在的話它會印一行錯誤然後**直接結束**（而且訊息很容易被忽略）。
$indexPath = Join-Path $dst 'public\index.html'
if (-not (Test-Path $indexPath)) {
  [IO.File]::WriteAllText($indexPath,
    '<!doctype html><meta charset="utf-8"><title>會議助手本機辨識</title><p>會議助手的本機語音辨識伺服器正在執行。這個頁面沒有用途，擴充功能呼叫的是 /inference。',
    [Text.UTF8Encoding]::new($false))
}

# ── 模型 ────────────────────────────────────────────────────────
$wanted = switch ($Models) {
  'both'  { @('ggml-small-q5_1.bin', 'ggml-base-q5_1.bin') }
  'small' { @('ggml-small-q5_1.bin') }
  'base'  { @('ggml-base-q5_1.bin') }
}
foreach ($m in $wanted) {
  $p = Join-Path $dst $m
  if ((Test-Path $p) -and -not $Force) {
    Write-Host "$m 已存在，跳過"
    continue
  }
  $mb = if ($m -like '*small*') { 181 } else { 57 }
  Write-Host "下載 $m（約 $mb MB，慢的話請耐心等）…"
  # 先下載到暫存檔再改名：中途失敗時不會留下一個看起來完整的壞模型
  $tmp = "$p.part"
  Invoke-WebRequest -Uri "$MODEL_BASE/$m" -OutFile $tmp -UseBasicParsing -TimeoutSec 3600
  Move-Item $tmp $p -Force
}

# ── 自我測試：真的啟動一次伺服器並送一段靜音進去 ────────────────
Write-Host ''
Write-Host '自我測試：啟動伺服器…'
$model = if (Test-Path (Join-Path $dst 'ggml-small-q5_1.bin')) { 'ggml-small-q5_1.bin' } else { 'ggml-base-q5_1.bin' }
$port = 8317
$log = Join-Path $env:TEMP 'ma-whisper-selftest.log'

$proc = Start-Process -FilePath (Join-Path $dst 'whisper-server.exe') -WorkingDirectory $dst -PassThru -WindowStyle Hidden `
  -ArgumentList @('-m', (Join-Path $dst $model), '-l', 'zh', '-t', '4',
                  '--host', '127.0.0.1', '--port', "$port",
                  '--public', (Join-Path $dst 'public'), '-nt', '-sns') `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err"

$ok = $false
foreach ($i in 1..60) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listening) { $ok = $true; break }
}

if ($ok) {
  Write-Host "✓ 伺服器可以啟動並在 127.0.0.1:$port 監聽（模型：$model）"
} else {
  Write-Host '✗ 伺服器啟動失敗，錯誤輸出：'
  Get-Content "$log.err" -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "   $_" }
}
if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit(8000) }

Write-Host ''
Get-ChildItem $dst -File | Measure-Object -Property Length -Sum |
  ForEach-Object { Write-Host "安裝完成：$($_.Count) 個檔案，共 $([math]::Round($_.Sum / 1MB, 0)) MB" }
Write-Host "位置：$dst"
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 確認已執行過 bridge\install.ps1（本機辨識伺服器由 bridge 啟動）'
Write-Host '  2. 在設定頁把「語音辨識引擎」選成「本機原生 whisper.cpp」'
if (-not $ok) { exit 1 }
