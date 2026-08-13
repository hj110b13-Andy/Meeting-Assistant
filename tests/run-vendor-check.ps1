<#
  vendor/ 離線驗證：確認內建的 whisper 模型與 ONNX Runtime 不靠網路就能用。

  用法：  powershell -ExecutionPolicy Bypass -File tests\run-vendor-check.ps1

  為什麼要單獨一支：主測試（run.ps1）是純邏輯測試，用 headless Chrome 就夠。
  但 WASM 推論在 --virtual-time-budget 下不會前進（虛擬時鐘快轉，ORT 的排程卡住），
  所以這支必須開真正的 Chrome，並用**視窗標題**回報進度 —— 那是唯一不需要
  本機伺服器或 CDP 就能從 PowerShell 讀到頁面狀態的通道。

  --host-resolver-rules 會把所有 DNS 導到死路，證明真的沒有連外。
  注意那個值裡有空格，**一定要連引號一起傳**：Start-Process 不會自動加引號，
  Chrome 會把 * 當成第二個網址，然後報「Multiple targets are not supported」。
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error '找不到 Chrome。'; exit 2 }

if (-not (Test-Path "$root\vendor\models\Xenova\whisper-base\onnx\decoder_model_merged_quantized.onnx")) {
  Write-Error "vendor/ 裡沒有模型檔。請先執行 tools\fetch-vendor.ps1 下載。"
  exit 2
}

$profile = Join-Path $PSScriptRoot '.vendorprofile'
$page = 'file:///' + (Join-Path $PSScriptRoot 'vendor-whisper.html').Replace('\', '/')

Write-Host '開啟 Chrome 執行離線驗證（所有 DNS 已封鎖）…' -ForegroundColor Cyan
Start-Process -FilePath $chrome -ArgumentList @(
  '--no-first-run', '--no-default-browser-check', '--window-size=680,460', '--window-position=40,40',
  '--allow-file-access-from-files', '--host-resolver-rules="MAP * 127.0.0.1:1"',
  "--user-data-dir=$profile", $page
) | Out-Null

$deadline = (Get-Date).AddMinutes(6)
$last = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 4
  $t = (Get-Process chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like 'MA|*' } | Select-Object -First 1).MainWindowTitle
  if ($t -and $t -ne $last) { Write-Host "  $t"; $last = $t }
  if ($t -match 'MA\|(DONE|FAIL)') { break }
}

Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'MA|*' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 5
Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $chrome } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 頁面把結果寫進 localStorage，關掉後再用 headless 撈出來
$reader = Join-Path $PSScriptRoot '.reader.html'
[IO.File]::WriteAllText($reader,
  '<pre id="out"></pre><script>document.getElementById("out").textContent=localStorage.getItem("ma_vendor")||"(空)";</script>',
  [Text.UTF8Encoding]::new($false))
$out = Join-Path $PSScriptRoot '.reader.out'
Start-Process -FilePath $chrome -NoNewWindow -Wait -RedirectStandardOutput $out -RedirectStandardError "$out.err" `
  -ArgumentList @('--headless', '--dump-dom', '--virtual-time-budget=8000', '--no-first-run',
    '--allow-file-access-from-files', "--user-data-dir=$profile",
    ('file:///' + $reader.Replace('\', '/')))

$m = [regex]::Match([IO.File]::ReadAllText($out), '(?s)<pre id="out">(.*?)</pre>')
$text = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
Write-Host ''
Write-Host $text
Remove-Item $reader, $out, "$out.err" -Force -ErrorAction SilentlyContinue

if ($text -match 'PASS') { Write-Host "`n離線驗證通過。" -ForegroundColor Green; exit 0 }
Write-Host "`n離線驗證失敗。" -ForegroundColor Red
exit 1
