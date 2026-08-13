<#
  安裝 Native Messaging 橋接（讓擴充功能能呼叫你本機的 Claude Code）

  用法：
    powershell -ExecutionPolicy Bypass -File bridge\install.ps1 -ExtensionId <你的擴充功能ID>

  擴充功能 ID 在 chrome://extensions 開啟「開發人員模式」後，卡片上會顯示。

  這支程式會做兩件事（都只影響目前使用者，不需要管理員權限）：
    1. 在 bridge\ 產生 manifest.json 與 config.json
    2. 在登錄檔 HKCU\Software\Google\Chrome\NativeMessagingHosts\ 註冊主機

  移除：powershell -ExecutionPolicy Bypass -File bridge\install.ps1 -Uninstall
#>

param(
    [string]$ExtensionId,
    [string]$ClaudeExe,
    [int]$TimeoutSeconds = 120,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.meetingassistant.claudecode'
$RegPaths = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)

if ($Uninstall) {
    foreach ($base in $RegPaths) {
        $key = Join-Path $base $HostName
        if (Test-Path $key) { Remove-Item $key -Force; Write-Host "已移除註冊：$key" -ForegroundColor Yellow }
    }
    foreach ($f in 'manifest.json', 'config.json') {
        $p = Join-Path $PSScriptRoot $f
        if (Test-Path $p) { Remove-Item $p -Force; Write-Host "已刪除 $f" -ForegroundColor Yellow }
    }
    Write-Host '橋接已移除。' -ForegroundColor Green
    exit 0
}

if (-not $ExtensionId) {
    Write-Error '缺少 -ExtensionId。請到 chrome://extensions 開啟開發人員模式，複製本擴充功能的 ID。'
    exit 2
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Error "擴充功能 ID 格式不對（應為 32 個 a–p 的字母）：$ExtensionId"
    exit 2
}

# ── 找 claude.exe ───────────────────────────────────────────────
if (-not $ClaudeExe) {
    $candidates = @()
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $extRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
    if (Test-Path $extRoot) {
        # 版號大的排前面，取最新安裝的那份
        $candidates += Get-ChildItem $extRoot -Directory -Filter 'anthropic.claude-code-*' |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' }
    }
    $ClaudeExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

if (-not $ClaudeExe -or -not (Test-Path $ClaudeExe)) {
    Write-Error '找不到 claude.exe。請用 -ClaudeExe "完整路徑" 手動指定。'
    exit 2
}
Write-Host "使用 Claude Code： $ClaudeExe" -ForegroundColor Cyan

# ── 產生設定檔 ──────────────────────────────────────────────────
$batPath = Join-Path $PSScriptRoot 'host.bat'
if (-not (Test-Path $batPath)) { Write-Error "找不到 $batPath"; exit 2 }

@{ claudeExe = $ClaudeExe; timeoutSeconds = $TimeoutSeconds } |
    ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'config.json') -Encoding UTF8

$manifest = [ordered]@{
    name           = $HostName
    description    = '會議助手 → Claude Code 橋接'
    path           = $batPath
    type           = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestPath = Join-Path $PSScriptRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestPath -Encoding UTF8
Write-Host "已產生 $manifestPath" -ForegroundColor Cyan

# ── 註冊到 Chrome / Edge ────────────────────────────────────────
foreach ($base in $RegPaths) {
    if (-not (Test-Path $base)) { New-Item -Path $base -Force | Out-Null }
    $key = Join-Path $base $HostName
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    Write-Host "已註冊：$key" -ForegroundColor Cyan
}

# ── 自我測試：直接跑一次橋接，確認協定與 Claude Code 都通 ────────
Write-Host ''
Write-Host '正在自我測試（會實際呼叫一次 Claude Code，約需 10–30 秒）…' -ForegroundColor Cyan

$test = {
    param($bat, $deadlineSec)

    # 關鍵：預設的 Console.InputEncoding 可能帶 BOM preamble，.NET 建立
    # StandardInput 的 StreamWriter 時會把那 3 個 byte 寫進管線。對 Native
    # Messaging 來說那就是把長度前綴整個位移，主機會判定協定不同步後靜靜結束，
    # 於是自我測試看起來「沒有回應」，但其實橋接是好的。
    [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = "$env:ComSpec"
    $psi.Arguments = "/c `"$bat`""     # .bat 一律透過 cmd 啟動，和 Chrome 的做法一致
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [Diagnostics.Process]::Start($psi)

    $payload = [Text.Encoding]::UTF8.GetBytes('{"type":"run","id":"selftest","system":"","user":"只回答這四個字：橋接正常"}')
    $si = $proc.StandardInput.BaseStream
    $si.Write([BitConverter]::GetBytes([uint32]$payload.Length), 0, 4)
    $si.Write($payload, 0, $payload.Length)
    $si.Flush()

    # 主機的長度前綴與 body 是分兩次寫出的，所以要湊滿才算讀完；
    # 每次讀取都帶截止時間，避免任何一次 Read 卡死整個安裝流程。
    $out = $proc.StandardOutput.BaseStream
    $deadline = (Get-Date).AddSeconds($deadlineSec)
    $fill = {
        param($stream, $buf, $count)
        $got = 0
        while ($got -lt $count) {
            $ms = [int][Math]::Max(1, ($deadline - (Get-Date)).TotalMilliseconds)
            $t = $stream.ReadAsync($buf, $got, $count - $got)
            if (-not $t.Wait($ms)) { return -1 }
            if ($t.Result -le 0) { return $got }
            $got += $t.Result
        }
        return $got
    }

    $lenBytes = New-Object byte[] 4
    $got = & $fill $out $lenBytes 4
    if ($got -ne 4) {
        $err = $proc.StandardError.ReadToEnd()
        try { $proc.Kill() } catch {}
        if ($got -lt 0) { return "主機逾時，沒有送回長度前綴。stderr：$err" }
        return "主機沒有回應（讀到 $got bytes）。stderr：$err"
    }

    $len = [BitConverter]::ToUInt32($lenBytes, 0)
    $buf = New-Object byte[] $len
    $got = & $fill $out $buf $len
    try { $proc.Kill() } catch {}
    if ($got -lt 0) { return "主機回了長度 $len，但 body 讀取逾時。" }
    return [Text.Encoding]::UTF8.GetString($buf, 0, $got)
}

$job = Start-Job -ScriptBlock $test -ArgumentList $batPath, ($TimeoutSeconds + 20)
if (Wait-Job $job -Timeout ($TimeoutSeconds + 30)) {
    $result = Receive-Job $job -ErrorAction Continue 2>&1 | Out-String
    $result = $result.Trim()
    Write-Host "主機回應：$result"
    if ($result -match '"ok"\s*:\s*true') {
        Write-Host ''
        Write-Host '✓ 橋接安裝完成且測試通過。' -ForegroundColor Green
        Write-Host '  到擴充功能設定頁把「模型後端」選成「Claude Code（用 Pro 訂閱，免費）」即可。' -ForegroundColor Green
    } else {
        Write-Host ''
        Write-Host '✗ 橋接已註冊，但自我測試沒有成功。請看上面的回應內容。' -ForegroundColor Red
    }
} else {
    Stop-Job $job
    Write-Host '✗ 自我測試逾時。' -ForegroundColor Red
}
Remove-Job $job -Force -ErrorAction SilentlyContinue
