<#
  下載本機語音辨識需要的執行檔與模型到 vendor/（約 99 MB，一次性）。

  用法：  powershell -ExecutionPolicy Bypass -File tools\fetch-vendor.ps1

  為什麼要內建而不是執行期抓：MV3 禁止擴充功能載入遠端程式碼，而且這條路線
  的重點就是零費用、資料不離開這台電腦。內建之後執行期完全不連任何伺服器
  （tests\run-vendor-check.ps1 會把 DNS 封鎖來證明這件事）。

  模型選擇：whisper-base 而不是 tiny。實測 tiny 會把「小陳」聽成「小春」，
  而自動回答整個功能都建立在「逐字稿裡出現我的名字」上，名字聽錯就失效。
  base 的 RTF 0.5～0.6（tiny 0.36），慢一倍但仍在即時範圍內。
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot

$TF_VERSION = '3.7.5'
$MODEL = 'Xenova/whisper-base'

$tf = Join-Path $root 'vendor\transformers'
$md = Join-Path $root "vendor\models\$($MODEL -replace '/', '\')"
New-Item -ItemType Directory -Force -Path $tf, (Join-Path $md 'onnx') | Out-Null

$cdn = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@$TF_VERSION/dist"
$hf = "https://huggingface.co/$MODEL/resolve/main"

$files = @(
  @{ u = "$cdn/transformers.min.js";                  p = "$tf\transformers.min.js" }
  @{ u = "$cdn/ort-wasm-simd-threaded.jsep.mjs";      p = "$tf\ort-wasm-simd-threaded.jsep.mjs" }
  @{ u = "$cdn/ort-wasm-simd-threaded.jsep.wasm";     p = "$tf\ort-wasm-simd-threaded.jsep.wasm" }
  @{ u = "$hf/config.json";                           p = "$md\config.json" }
  @{ u = "$hf/generation_config.json";                p = "$md\generation_config.json" }
  @{ u = "$hf/preprocessor_config.json";              p = "$md\preprocessor_config.json" }
  @{ u = "$hf/tokenizer.json";                        p = "$md\tokenizer.json" }
  @{ u = "$hf/tokenizer_config.json";                 p = "$md\tokenizer_config.json" }
  @{ u = "$hf/added_tokens.json";                     p = "$md\added_tokens.json" }
  @{ u = "$hf/special_tokens_map.json";               p = "$md\special_tokens_map.json" }
  @{ u = "$hf/normalizer.json";                       p = "$md\normalizer.json" }
  @{ u = "$hf/vocab.json";                            p = "$md\vocab.json" }
  @{ u = "$hf/merges.txt";                            p = "$md\merges.txt" }
  @{ u = "$hf/onnx/encoder_model_quantized.onnx";     p = "$md\onnx\encoder_model_quantized.onnx" }
  @{ u = "$hf/onnx/decoder_model_merged_quantized.onnx"; p = "$md\onnx\decoder_model_merged_quantized.onnx" }
)

$fail = 0
foreach ($f in $files) {
  $name = Split-Path $f.p -Leaf
  try {
    Invoke-WebRequest $f.u -OutFile $f.p -UseBasicParsing -TimeoutSec 600
    Write-Host ("  OK  {0,9} KB  {1}" -f [math]::Round((Get-Item $f.p).Length / 1KB, 0), $name)
  } catch {
    Write-Host "  失敗  $name  →  $($_.Exception.Message)" -ForegroundColor Red
    $fail++
  }
}

$sum = (Get-ChildItem (Join-Path $root 'vendor') -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Host ("vendor/ 合計 {0:N1} MB" -f ($sum / 1MB))
if ($fail) { Write-Host "$fail 個檔案失敗。" -ForegroundColor Red; exit 1 }
Write-Host '完成。接著跑 tests\run-vendor-check.ps1 驗證離線可用。' -ForegroundColor Green
