<#
    列出你的 Groq 帳號現在真的可以用的模型。

    為什麼需要這支腳本：模型 ID 是**寫死在候選鏈裡的字串**（cloud.js 的 CHAINS），
    而 Groq 會下架、改名、換世代。名稱不對時 API 回 404，而 404 跟 429
    在畫面上看起來很像（都是「雲端不能用，改走退路」），使用者只會覺得變慢了。

    合成測試抓不到這種錯（stub 不會檢查模型名稱），所以要有一個能直接問
    「你現在到底有哪些模型」的工具。

    用法：
        powershell -ExecutionPolicy Bypass -File tools\list-groq-models.ps1

    金鑰讀專案根目錄的「API Key.txt」（已被 .gitignore 擋住），
    或用 -GroqKey 直接指定。
#>
[CmdletBinding()]
param(
    [string]$GroqKey
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# ── 找金鑰 ──────────────────────────────────────────────────────
if (-not $GroqKey) {
    $keyFile = Join-Path $root 'API Key.txt'
    if (-not (Test-Path $keyFile)) {
        Write-Error "找不到「API Key.txt」。請用 -GroqKey 直接指定，或把金鑰放進 $keyFile"
        exit 2
    }
    # 檔案是 UTF-8，明確指定編碼讀 —— PowerShell 5.1 預設會用系統 ANSI（CP950）
    $text = [IO.File]::ReadAllText($keyFile, [Text.UTF8Encoding]::new($false))
    $m = [regex]::Match($text, 'gsk_[A-Za-z0-9]{20,}')
    if (-not $m.Success) {
        Write-Error '在「API Key.txt」裡找不到 Groq 金鑰（應以 gsk_ 開頭）。'
        exit 2
    }
    $GroqKey = $m.Value
}

# ── 打 /models ──────────────────────────────────────────────────
# 用 curl 而不是 Invoke-RestMethod，並且**把輸出寫進檔案再讀回來**：
# PowerShell 5.1 是用主控台的字碼頁（CP950）去解碼原生程式的 stdout，
# 直接接管線會讓非 ASCII 內容整片變成亂碼，連字串長度都對不上。
$tmp = Join-Path $env:TEMP "groq-models-$PID.json"
try {
    $null = & curl.exe -s -o $tmp `
        -H "Authorization: Bearer $GroqKey" `
        'https://api.groq.com/openai/v1/models'
    if (-not (Test-Path $tmp)) { Write-Error 'curl 沒有產生輸出。'; exit 1 }

    $raw = [IO.File]::ReadAllText($tmp, [Text.UTF8Encoding]::new($false))
    $json = $raw | ConvertFrom-Json
} finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

if ($json.error) {
    Write-Host "Groq 回了錯誤：$($json.error.message)" -ForegroundColor Red
    exit 1
}
if (-not $json.data) {
    Write-Host '回應裡沒有 data 陣列。原始回應：' -ForegroundColor Red
    Write-Host $raw
    exit 1
}

# ── 印出來 ──────────────────────────────────────────────────────
# 分成三類，因為這三類在專案裡各自對應一條候選鏈，關心的欄位也不同。
$models = $json.data | Sort-Object id

function Show-Group($title, $items) {
    Write-Host ''
    Write-Host "── $title ──" -ForegroundColor Cyan
    if (-not $items) { Write-Host '  （沒有）' -ForegroundColor DarkGray; return }
    foreach ($m in $items) {
        $ctx = if ($m.context_window) { "context $($m.context_window)" } else { '' }
        $act = if ($m.active -eq $false) { ' [停用中]' } else { '' }
        Write-Host ("  {0,-52} {1}{2}" -f $m.id, $ctx, $act)
    }
}

# 看得懂圖片的模型：Groq 的 /models 回應**沒有** vision 旗標，
# 所以只能靠命名慣例挑出「可能是」的，再由人確認。
$vision = $models | Where-Object { $_.id -match 'vision|llama-4|scout|maverick|vl' }
$audio  = $models | Where-Object { $_.id -match 'whisper|tts' }
$text   = $models | Where-Object { $_.id -notmatch 'whisper|tts|vision|llama-4|scout|maverick|vl' }

Show-Group '可能看得懂圖片的（附上會議畫面用）' $vision
Show-Group '語音辨識（逐字稿用）' $audio
Show-Group '純文字（回答與摘要用）' $text

Write-Host ''
Write-Host "總共 $($models.Count) 個模型。" -ForegroundColor Green
Write-Host '候選鏈寫在 src\background\cloud.js 的 CHAINS。' -ForegroundColor DarkGray
