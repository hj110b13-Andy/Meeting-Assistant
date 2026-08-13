<#
  Native Messaging 主機：擴充功能 ↔ 本機程式的橋樑

  Chrome 會啟動這個程式，並用 stdio 交換訊息。協定是固定的：
  每則訊息 = 4 bytes 小端 uint32 長度 + 該長度的 UTF-8 JSON。
  因此 stdout 絕對不能印任何其他東西，否則 Chrome 會判定協定錯誤而斷線。

  處理兩件事：

  1. {type:'run', id, system, user, imagePath} → 呼叫 claude.exe，
     回傳 {id, ok:true, text} 或 {id, ok:false, error}。
     用的是你已登入的 Claude Code（Pro 訂閱額度），不經過 Anthropic API，不按量計費。

  2. {type:'sttStart'|'sttStop'|'sttStatus'} → 管理本機語音辨識伺服器
     （whisper-server.exe）。擴充功能自己不能啟動本機程序，只能透過這裡。
     伺服器啟動後由擴充功能直接用 HTTP 打 127.0.0.1，音訊不經過這個管道 ——
     Native Messaging 單則訊息有 1 MB 上限，音訊塞不下。

  Chrome 為每個 connectNative 連線各開一個主機程序，所以擴充功能會另外開一條
  專給 STT 用的連線：這樣「啟動伺服器」不會排在一個跑了 30 秒的 Claude Code
  呼叫後面，反之亦然。
#>

$ErrorActionPreference = 'Stop'

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

# claude.exe 路徑由 install.ps1 寫進同目錄的 config.json
$configPath = Join-Path $PSScriptRoot 'config.json'
$config = if (Test-Path $configPath) { Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$claudeExe = $config.claudeExe
$timeoutMs = if ($config.timeoutSeconds) { [int]$config.timeoutSeconds * 1000 } else { 120000 }

# 只在連線一開始生效一次：吃掉可能存在的 UTF-8 BOM。
#
# Chrome 不會送 BOM，但用 .NET 寫測試工具時很容易不小心送出一個：
# 讀取 Process.StandardInput.BaseStream 這個屬性會 flush 那個 StreamWriter，
# 而 flush 會把編碼的 preamble（EF BB BF）寫進管線。那 3 個 byte 會讓長度前綴
# 整個位移，算出一個天文數字，於是下面的防呆檢查讓主機**靜靜地結束** ——
# 症狀是「橋接沒回應」，但橋接其實是好的。踩過兩次了，所以直接容錯掉。
$bomChecked = $false

function Read-HostMessage {
    $lenBytes = New-Object byte[] 4
    $got = 0
    while ($got -lt 4) {
        $n = $stdin.Read($lenBytes, $got, 4 - $got)
        if ($n -le 0) { return $null }          # Chrome 關閉了連線
        $got += $n
    }
    if (-not $script:bomChecked) {
        $script:bomChecked = $true
        if ($lenBytes[0] -eq 0xEF -and $lenBytes[1] -eq 0xBB -and $lenBytes[2] -eq 0xBF) {
            # 前 3 個 byte 是 BOM，第 4 個其實是長度的第 1 個 byte：補讀 3 個
            $lenBytes[0] = $lenBytes[3]
            $got = 1
            while ($got -lt 4) {
                $n = $stdin.Read($lenBytes, $got, 4 - $got)
                if ($n -le 0) { return $null }
                $got += $n
            }
        }
    }
    $len = [BitConverter]::ToUInt32($lenBytes, 0)
    if ($len -eq 0 -or $len -gt 33554432) { return $null }   # 上限 32MB，防呆
    $buf = New-Object byte[] $len
    $got = 0
    while ($got -lt $len) {
        $n = $stdin.Read($buf, $got, $len - $got)
        if ($n -le 0) { return $null }
        $got += $n
    }
    return [Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json
}

function Write-HostMessage($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 12
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $stdout.Write([BitConverter]::GetBytes([uint32]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Invoke-ClaudeCode($system, $user, $imagePath) {
    if (-not $claudeExe -or -not (Test-Path $claudeExe)) {
        throw "找不到 claude.exe（設定值：$claudeExe）。請重新執行 bridge\install.ps1。"
    }

    # 指令與資料全部走 stdin，-p 只放一句固定的話。
    # 這樣就不必處理命令列引號轉義，也不會撞到命令列長度上限。
    # 變數不要叫 $input —— 那是 PowerShell 的自動變數（管線輸入的列舉器），覆寫它遲早出事。
    $promptText = if ($system) { "$system`n`n---`n`n$user" } else { $user }

    # Claude Code 讀不到 base64 影像，但讀得到本機檔案。所以擴充功能先把
    # 會議畫面存成 PNG，這裡只把路徑交給它，並開放 Read 工具讓它自己去看。
    # 沒有附圖時完全不開工具 —— 少一次工具往返，快很多（實測 4.6 秒 vs 16.8 秒）。
    if ($imagePath) {
        if (-not (Test-Path $imagePath)) { throw "找不到畫面截圖：$imagePath" }
        $promptText = "【會議畫面截圖】請先用 Read 工具讀取這個檔案，再結合下方逐字稿作答：`n$imagePath`n`n$promptText"
        $instruction = '請完全依照下方輸入的指示與資料作答。除了讀取指定的截圖外不要使用其他工具。只輸出結果本身，不要說明你做了什麼。'
        $toolArgs = ' --allowedTools Read'
    } else {
        $instruction = '請完全依照下方輸入的指示與資料作答。只輸出結果本身，不要說明你做了什麼，不要使用任何工具。'
        $toolArgs = ''
    }

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $claudeExe
    $psi.Arguments = "-p `"$instruction`"$toolArgs"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.WorkingDirectory = $PSScriptRoot

    $proc = [Diagnostics.Process]::Start($psi)
    try {
        $writer = New-Object IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object Text.UTF8Encoding($false)))
        $writer.Write($promptText)
        $writer.Flush()
        $writer.Close()

        # 先讀完 stdout 再等結束，否則輸出塞滿管線會互相等待造成死鎖
        $out = $proc.StandardOutput.ReadToEnd()
        $err = $proc.StandardError.ReadToEnd()

        if (-not $proc.WaitForExit($timeoutMs)) {
            try { $proc.Kill() } catch {}
            throw "Claude Code 逾時（超過 $($timeoutMs / 1000) 秒）。"
        }
        if ($proc.ExitCode -ne 0) {
            throw "Claude Code 結束碼 $($proc.ExitCode)：$($err.Trim())"
        }
        return $out.Trim()
    } finally {
        $proc.Dispose()
    }
}

# ── 本機語音辨識伺服器（whisper.cpp） ───────────────────────────
# 安裝位置由 tools\install-whisper.ps1 決定。必須是純 ASCII 路徑：
# whisper.cpp 用窄字元 API 開檔，路徑經過系統 ANSI（CP950）轉換後
# 中文資料夾名會變成亂碼而開檔失敗。
$STT_PORT = 8317
$sttDirs = @(
    (Join-Path $env:LOCALAPPDATA 'MeetingAssistant\whisper'),
    'C:\MeetingAssistant\whisper'
)
$sttDir = $sttDirs | Where-Object { Test-Path (Join-Path $_ 'whisper-server.exe') } | Select-Object -First 1
$sttPidFile = Join-Path $env:LOCALAPPDATA 'MeetingAssistant\whisper-server.pid'
$sttProc = $null

function Test-SttListening {
    $null -ne (Get-NetTCPConnection -LocalPort $STT_PORT -State Listen -ErrorAction SilentlyContinue)
}

function Get-SttOwner {
    $conn = Get-NetTCPConnection -LocalPort $STT_PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
}

function Stop-SttServer {
    # 三個來源都要處理：這次啟動的、上次留下的（pid 檔）、以及正在佔用埠號的。
    # 主機被硬殺時 finally 不會執行，pid 檔就是那時候的補救。
    foreach ($p in @($sttProc, $(
            if (Test-Path $sttPidFile) {
                $old = (Get-Content $sttPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
                if ($old) { Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue }
            }
        ))) {
        if ($p -and -not $p.HasExited -and $p.ProcessName -like 'whisper-server*') {
            try { $p.Kill(); $p.WaitForExit(5000) | Out-Null } catch { }
        }
    }
    $script:sttProc = $null
    Remove-Item $sttPidFile -Force -ErrorAction SilentlyContinue
}

function Start-SttServer($modelName) {
    if (-not $sttDir) {
        throw '找不到本機辨識程式。請先執行 tools\install-whisper.ps1。'
    }
    $model = switch ($modelName) {
        'base'  { 'ggml-base-q5_1.bin' }
        default { 'ggml-small-q5_1.bin' }
    }
    $modelPath = Join-Path $sttDir $model
    if (-not (Test-Path $modelPath)) {
        throw "找不到模型 $model。請執行 tools\install-whisper.ps1 下載。"
    }

    if (Test-SttListening) {
        $owner = Get-SttOwner
        if ($owner -and $owner.ProcessName -like 'whisper-server*') {
            # 已經有一台在跑（可能是前一次連線留下的）。直接沿用，
            # 省掉 6 秒的模型載入時間。
            return @{ reused = $true; model = $model; owner = $owner.Id }
        }
        throw "127.0.0.1:$STT_PORT 已被其他程式（$($owner.ProcessName)）占用，無法啟動本機辨識伺服器。"
    }

    # 埠號沒人聽但 pid 檔還在 → 上次沒收乾淨，先清掉
    if (Test-Path $sttPidFile) { Stop-SttServer }

    # 刻意不給 --prompt：實測用繁體 initial prompt 引導雖然讓輸出變繁體，
    # 但會把「對帳」聽成「對戰／對象」。改成不下 prompt（讓模型專心聽），
    # 簡繁問題交給擴充功能端的 src/lib/s2t.js 字表轉換處理。
    # -nt 不要時間戳、-sns 抑制非語音符號（避免 [音樂] 這類雜訊進逐字稿）。
    # 不要叫 $args —— 那是 PowerShell 的自動變數，覆寫它遲早出事（$input 已經踩過）
    $serverArgs = @(
        '-m', $modelPath, '-l', 'zh', '-t', '4',
        '--host', '127.0.0.1', '--port', "$STT_PORT",
        '--public', (Join-Path $sttDir 'public'),
        '-nt', '-sns'
    )
    $logDir = Split-Path -Parent $sttPidFile
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $log = Join-Path $logDir 'whisper-server.log'

    $script:sttProc = Start-Process -FilePath (Join-Path $sttDir 'whisper-server.exe') `
        -WorkingDirectory $sttDir -PassThru -WindowStyle Hidden -ArgumentList $serverArgs `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    Set-Content -Path $sttPidFile -Value $sttProc.Id -Encoding ascii

    # small 模型冷啟動實測約 6 秒，磁碟沒快取時更久，所以等到 40 秒。
    # 伺服器是「載完模型才綁埠號」，所以埠號一開始聽就代表真的可以用了。
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 40000) {
        if ($sttProc.HasExited) {
            $err = if (Test-Path "$log.err") { (Get-Content "$log.err" -Tail 5) -join ' / ' } else { '' }
            Stop-SttServer
            throw "本機辨識伺服器啟動後立刻結束。$err"
        }
        if (Test-SttListening) {
            return @{ reused = $false; model = $model; startMs = $sw.ElapsedMilliseconds; owner = $sttProc.Id }
        }
        Start-Sleep -Milliseconds 300
    }
    Stop-SttServer
    throw '本機辨識伺服器啟動逾時（超過 40 秒）。'
}

# ── 主迴圈 ──────────────────────────────────────────────────────
try {
    while ($true) {
        $msg = Read-HostMessage
        if ($null -eq $msg) { break }

        switch ($msg.type) {
            'ping' {
                Write-HostMessage @{ id = $msg.id; ok = $true; text = 'pong'; claudeExe = $claudeExe }
            }
            'sttStatus' {
                Write-HostMessage @{
                    id = $msg.id; ok = $true; port = $STT_PORT
                    installed = [bool]$sttDir
                    dir = $sttDir
                    running = (Test-SttListening)
                    models = @(if ($sttDir) { (Get-ChildItem $sttDir -Filter 'ggml-*.bin' -ErrorAction SilentlyContinue).Name })
                }
            }
            'sttStart' {
                try {
                    $r = Start-SttServer $msg.model
                    Write-HostMessage @{ id = $msg.id; ok = $true; port = $STT_PORT
                                         reused = $r.reused; model = $r.model; startMs = $r.startMs }
                } catch {
                    Write-HostMessage @{ id = $msg.id; ok = $false; error = $_.Exception.Message }
                }
            }
            'sttStop' {
                Stop-SttServer
                Write-HostMessage @{ id = $msg.id; ok = $true }
            }
            'run' {
                try {
                    $text = Invoke-ClaudeCode $msg.system $msg.user $msg.imagePath
                    Write-HostMessage @{ id = $msg.id; ok = $true; text = $text }
                } catch {
                    Write-HostMessage @{ id = $msg.id; ok = $false; error = $_.Exception.Message }
                }
            }
            default {
                Write-HostMessage @{ id = $msg.id; ok = $false; error = "未知的訊息型別：$($msg.type)" }
            }
        }
    }
} finally {
    # Chrome 關掉連線（使用者停止辨識、關閉瀏覽器）時要把伺服器一起收掉，
    # 否則 small 模型會留著約 400 MB 記憶體常駐。
    Stop-SttServer
}
