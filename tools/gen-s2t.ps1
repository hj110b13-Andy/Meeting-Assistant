<#
  產生 src/lib/s2t-table.js — 簡體→繁體（台灣用字）對照表

  用法：  powershell -ExecutionPolicy Bypass -File tools\gen-s2t.ps1

  為什麼需要這個：本機語音辨識用的 whisper small 模型中文明顯比 base 準
  （「這季／結帳／對帳／小陳」base 全錯、small 全對），但它輸出簡體中文。
  在 initial prompt 裡要求繁體只有部分效果、而且不穩定（同一段音檔跑兩次
  可能一次簡一次繁），所以最後一道防線是在 JS 端做確定性的字表轉換。

  資料來源：OpenCC（Apache-2.0）的 STCharacters / STPhrases / TWVariants。
  這支腳本會自己下載，需要網路。產生出來的 .js 是純資料，執行時完全離線。

  ── 這個檔案為什麼一定要有 UTF-8 BOM ─────────────────────────────
  Windows PowerShell 5.1 讀 .ps1 時，沒有 BOM 就用系統 ANSI（正體中文機器
  上是 Big5/CP950）解碼，檔案裡的中文會變成亂碼，而且錯誤訊息通常是
  莫名其妙的 MissingEndCurlyBrace。存檔時務必保留 BOM。
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmp  = Join-Path $PSScriptRoot '.opencc'
$out  = Join-Path $root 'src\lib\s2t-table.js'
$enc  = [Text.UTF8Encoding]::new($false)
$base = 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary'

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

foreach ($n in 'STCharacters.txt', 'STPhrases.txt', 'TWVariants.txt') {
  $dest = Join-Path $tmp $n
  if (Test-Path $dest) { Write-Host "已有 $n，跳過下載"; continue }
  Write-Host "下載 $n ..."
  Invoke-WebRequest -Uri "$base/$n" -OutFile $dest -UseBasicParsing -TimeoutSec 120
}

function Read-Dict($name) {
  $d = [ordered]@{}
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $tmp $name), $enc)) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $parts = $line -split "`t"
    if ($parts.Count -lt 2) { continue }
    # 一對多時取第一個候選（OpenCC 的慣例：第一個最常用）
    $d[$parts[0]] = ($parts[1] -split ' ')[0]
  }
  $d
}

$chars   = Read-Dict 'STCharacters.txt'
$phrases = Read-Dict 'STPhrases.txt'
$twvar   = Read-Dict 'TWVariants.txt'

# ── 台灣用字修正 ────────────────────────────────────────────────
# OpenCC 的 s2tw 給的是「標準繁體」，有幾個字跟台灣的實際用法不一樣。
# 這些都是會議裡真的會出現的詞，錯了很刺眼，所以在輸出端統一改掉：
#
#   臺 → 台   OpenCC 把 台北 轉成 臺北。官方文書是臺，但日常一律寫台。
#   賬 → 帳   結賬／對賬 在台灣不用，一律是結帳／對帳。（這個是實測抓到的）
#   佈 → 布   教育部標準用「布」：發布、分布、布局、布置。
#
# 這是套在「轉換結果」上的，所以連帶讓相關的詞組規則變成多餘而被自動剔除。
$twFix = @{ '臺' = '台'; '賬' = '帳'; '佈' = '布' }

function Convert-ByTable($s, $table) {
  $sb = New-Object Text.StringBuilder
  $i = 0
  while ($i -lt $s.Length) {
    $len = if ([char]::IsHighSurrogate($s[$i]) -and $i + 1 -lt $s.Length) { 2 } else { 1 }
    $k = $s.Substring($i, $len)
    [void]$sb.Append($(if ($table.Contains($k)) { $table[$k] } else { $k }))
    $i += $len
  }
  $sb.ToString()
}

# 台灣字形（僞→偽 這類）再加上上面那份修正表
function ToTW($s)   { Convert-ByTable (Convert-ByTable $s $twvar) $twFix }
function ByChar($s) { Convert-ByTable $s $chars }

# ── 只留「逐字轉換會轉錯」的詞組 ────────────────────────────────
# STPhrases 原始檔近 1 MB。絕大多數詞組逐字轉的結果本來就一樣，
# 只有一對多的字（发→發/髮、干→乾/幹）才真的需要詞組決定選哪個。
$keep = [ordered]@{}
foreach ($k in $phrases.Keys) {
  $want = ToTW $phrases[$k]
  if ($want -ne (ToTW (ByChar $k))) { $keep[$k] = $want }
}

# ── 單字表：拆成「一個 BMP 字元 → 一個 BMP 字元」的快路徑 ──────
# 其餘（代理對、一對多字）丟進詞組表，由同一個最長匹配迴圈處理。
$allChars = [ordered]@{}
foreach ($k in $chars.Keys) { $allChars[$k] = ToTW $chars[$k] }
# 來源已經是繁體、但用了非台灣字形時也要能單獨修正
foreach ($k in $twvar.Keys) { if (-not $allChars.Contains($k)) { $allChars[$k] = ToTW $twvar[$k] } }
foreach ($k in $twFix.Keys) { $allChars[$k] = $twFix[$k] }

$simpleFrom = New-Object Text.StringBuilder
$simpleTo   = New-Object Text.StringBuilder
foreach ($k in $allChars.Keys) {
  $v = $allChars[$k]
  if ($v -eq $k) { continue }
  if ($k.Length -eq 1 -and $v.Length -eq 1 -and -not [char]::IsSurrogate($k[0]) -and -not [char]::IsSurrogate($v[0])) {
    [void]$simpleFrom.Append($k); [void]$simpleTo.Append($v)
  } elseif (-not $keep.Contains($k)) {
    $keep[$k] = $v
  }
}

$maxLen = 0
foreach ($k in $keep.Keys) { if ($k.Length -gt $maxLen) { $maxLen = $k.Length } }

Write-Host ''
Write-Host "單字（快路徑）：$($simpleFrom.Length) 條"
Write-Host "詞組／特例：$($keep.Count) 條（原始詞組 $($phrases.Count) 條，最長 $maxLen 個 UTF-16 單位）"

# ── 產生 JS ─────────────────────────────────────────────────────
# 詞組表用一長串字串存，不用 JSON 物件：省掉幾萬組引號與冒號。
# 分隔符用 | 與 =，因為字典內容全是中日韓文字，不會出現這兩個 ASCII 符號；
# 真的出現就是資料格式的假設被打破了，寧可在產生階段就中斷。
$pairs = foreach ($k in $keep.Keys) {
  $v = $keep[$k]
  if ($k -match '[|=]' -or $v -match '[|=]') { throw "字典項目含有分隔符：$k -> $v" }
  "$k=$v"
}
$blob = $pairs -join '|'

function Esc($s) { $s.Replace('\', '\\').Replace("'", "\'") }

$lines = @(
  '/**',
  ' * 簡體→繁體（台灣用字）對照表',
  ' *',
  ' * 這個檔案由 tools/gen-s2t.ps1 從 OpenCC 字典產生，請勿手改。',
  ' * 資料來源：OpenCC STCharacters / STPhrases / TWVariants（Apache-2.0）。',
  " * 單字 $($simpleFrom.Length) 條；詞組／特例 $($keep.Count) 條（只留逐字轉換會轉錯的）。",
  ' *',
  ' * 刻意寫成傳統腳本而不是 ES module：offscreen 文件與內容腳本都是傳統腳本，',
  ' * 用同一種載入方式兩邊都能吃，測試頁也不必特別處理。',
  ' */',
  '',
  'globalThis.S2T_DATA = {',
  "  maxPhrase: $maxLen,",
  '  // 兩條等長字串：from[i] 對應 to[i]',
  "  from: '$(Esc $simpleFrom.ToString())',",
  "  to:   '$(Esc $simpleTo.ToString())',",
  '  // 以 | 分隔的條目，每條是「來源=結果」',
  "  phrases: '$(Esc $blob)',",
  '};',
  ''
)
[IO.File]::WriteAllText($out, ($lines -join "`n"), $enc)
Write-Host "已寫入 $out（$([math]::Round((Get-Item $out).Length / 1KB, 1)) KB）"
