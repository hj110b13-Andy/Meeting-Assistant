# 給在這個專案上工作的 Claude Code

會議助手是一個**免建置**的 Chrome MV3 側邊欄擴充功能：讀取瀏覽器裡 Google Meet /
Microsoft Teams / Jitsi Meet 的會議字幕，產生逐字稿、滾動式摘要，以及被點名提問時的
回答建議。沒有 Node.js、沒有打包工具、沒有 npm —— 原始碼就是執行的東西。

設計背景與量測數據在 [README.md](README.md)，操作方式在手冊（README 頂端有連結）。
這份檔案只寫**動手改之前必須知道的事**。

---

## 最高原則：只花 Claude Pro 訂閱的錢

使用者已經買了 Claude Pro，**不接受任何按量計費的東西**。這條規則決定了很多設計：

- 摘要與問答預設走 **Claude Code 橋接**（Native Messaging 呼叫本機 `claude.exe`，用訂閱額度）
  或 **Chrome 內建 Gemini Nano**，不走 Claude API。
- 語音辨識用**本機 whisper.cpp**，不用雲端服務。Deepgram 那條存在但預設關閉，
  而且**自動啟動永遠不會選它** —— 自動花錢是不能接受的。
- 提出任何新方案前先確認它不會產生額外費用。會的話要先講清楚成本再問。

Claude Pro 訂閱**不含 API 額度**，兩者是分開計費的。橋接是唯一能動用訂閱的路。

---

## 會安靜地弄壞東西的五件事

這些都踩過，而且症狀都不指向真正的原因。改完跑 `tests\check-project.ps1` 可以全部抓到。

### 1. `.ps1` 必須是 UTF-8 **with BOM**

Windows PowerShell 5.1 讀沒有 BOM 的檔案時用系統 ANSI（正體中文機器是 Big5/CP950）解碼，
中文字串的位元組會吃掉後面的引號，報出 `MissingEndCurlyBrace`，**而且行號跟真正的問題無關**。

編輯器很容易在存檔時把 BOM 拿掉。改完 `.ps1` 一定要確認。

### 2. `.bat` 必須是 CRLF，而且要靠 `.gitattributes` 的 `-text` 保證

cmd.exe 讀 LF-only 的批次檔會把指令 token 切錯 —— `powershell.exe` 被拆成 `powershell.`
與 `exe`，Native Messaging 主機一啟動就死。

`.gitattributes` 用的是 `*.bat -text`（完全不轉換），**不是** `text eol=crlf`。差別很關鍵：
`eol=crlf` 是「repo 裡存 LF、checkout 時轉 CRLF」，`git clone` 沒問題，但 GitHub 的
「Download ZIP」直接送 repo 裡的 blob、不套用該規則，下載 ZIP 的人會拿到壞掉的檔案。

### 3. 檔名不能以底線開頭

Chrome 保留 `_` 開頭給自己（`_metadata`、`_locales`）。資料夾裡只要有一個底線開頭的
檔案或目錄，**整個擴充功能就拒絕載入** —— 不是忽略那個檔案，是整個載不進去。
放暫存檔時要避開這個字首。

### 4. whisper.cpp 打不開非 ASCII 路徑

它用窄字元 Win32 API 開檔，路徑先被轉成系統 ANSI，`會議助手` 這種資料夾名會變成亂碼，
開檔直接失敗（`whisper-cli` 結束碼 9，而且錯誤訊息常被 stderr 緩衝吃掉）。

**這就是原生辨識裝在 `%LOCALAPPDATA%\MeetingAssistant\whisper` 而不是專案裡的原因。**
`tools\install-whisper.ps1` 會檢查路徑是不是純 ASCII。不要把它搬進專案資料夾。

### 5. 測試 Native Messaging 時的 BOM 陷阱

讀取 `Process.StandardInput.BaseStream` 這個**屬性**會 flush 那個 StreamWriter，
而 flush 會把編碼的 preamble（`EF BB BF`）寫進管線 —— 即使你只往 BaseStream 寫原始位元組。
那 3 個 byte 讓長度前綴整個位移，主機算出天文數字後**靜靜結束**，看起來像「主機沒回應」。

測試前先設 `[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)`。
`bridge/host.ps1` 現在也會主動吃掉開頭的 BOM 當保險。

---

## 測試

沒有 Node/npm，所以**直接把 Chrome 當測試執行環境**：每個測試頁把 `chrome.*` 換成 stub，
載入**真正的原始碼**（不是複本），再用 `--headless --dump-dom` 把結果讀回來。

```powershell
powershell -ExecutionPolicy Bypass -File tests\run.ps1            # 行為測試
powershell -ExecutionPolicy Bypass -File tests\check-project.ps1  # 專案一致性
```

**兩個都要綠才能推。** 第二個抓的是「行為測試跑得過但東西載不進去」的那類問題
（上面那五件事的前三件、manifest 提到的檔案存不存在、橋接與擴充功能的埠號有沒有對上、
`src/` 下每個 `.js` 的語法）。

背景模組是 ES module，`run.ps1` 的 `Convert-Module` 會把 `import`/`export` 拿掉、
包進 IIFE、再把匯出掛到 `globalThis` 以及 `__module_<檔名>`。新增匯出時不必手動維護清單。
檔名裡的連字號會被換成底線（`globalThis.__module_whisper-native` 是語法錯誤，
而且會**安靜地**讓整個模組不執行）。

**這些測試證明什麼、不證明什麼**：合成 DOM 驗證的是「選擇器與引擎邏輯自洽」，
**不能**證明真實的 Meet DOM 長得跟合成的一樣。字幕選擇器**從來沒有在真實會議裡驗證過** ——
那是目前最大的未知數，只有真的進一場會議能確認。

---

## 架構

```
會議分頁 content script（core.js + meet/teams/jitsi.js）
    讀字幕 DOM → mergeCaption 合併串流改寫 → 判斷「這句講完了」
        │ ma:segment
        ▼
service worker（背景）
    ├─ store.js       逐字稿狀態、**照說話時間插入**、chrome.storage.local 備份
    ├─ provider.js    後端切換（claude / chrome-ai / claude-code），分角色決定
    ├─ 摘要排程        兩個條件都成立才觸發（AND），失敗時退避
    └─ 提問偵測        問句 + 有沒有點到你的名字
        │ port 廣播
        ▼
側邊欄 panel.js
```

**offscreen 文件**負責音訊：`tabCapture` → 降取樣到 16 kHz → 分段 → 三個引擎之一
（原生 whisper.cpp / WASM whisper / Deepgram）→ 簡繁轉換 → 回報成 segment。

幾個不明顯但重要的決定：

- **逐字稿照「說話時間」排序，不是抵達順序。** 麥克風即時、本機辨識延遲十幾秒，
  照抵達順序排會讓你自己晚說的話排在別人早說的話前面 —— 送去摘要的對話順序就是錯的。
- **原生辨識另開一條 `connectNative`**，不跟 Claude Code 共用。`host.ps1` 是單執行緒循序
  處理訊息，共用的話「啟動辨識伺服器」會排在一個跑了 30 秒的 Claude Code 呼叫後面。
  附帶好處：連線關閉時 `host.ps1` 的 `finally` 會把伺服器一起收掉。
- **音訊不走 Native Messaging**（單則訊息上限 1 MB），是 offscreen 直接 HTTP POST 到
  `127.0.0.1:8317`。所以 `manifest.json` 需要那個 host permission，**埠號改了三個地方要一起改**
  （`manifest.json`、`whisper-native.js` 的 `STT_PORT`、`host.ps1` 的 `$STT_PORT`）。
- **選擇器優先用語意而不是雜湊 class。** Meet 第一順位是 `[role="region"][aria-label*="Captions"]`；
  Teams 清單最後留一條 `[data-tid*="closed-caption"]` 的網。全部失效時 Meet 還有結構化解析。

---

## 不要手改的檔案

- `src/lib/s2t-table.js` —— 由 `tools\gen-s2t.ps1` 從 OpenCC 字典產生。
  要改對照表就改那支腳本裡的 `$twFix`（台灣用字修正）再重新產生。
- `bridge/config.json`、`bridge/manifest.json` —— 由 `bridge\install.ps1` 產生，
  帶著機器專屬的路徑與擴充功能 ID，已經 gitignore。

## 不在版控裡、每台機器要自己裝

`vendor/`（WASM 備援，`tools\fetch-vendor.ps1`）、原生 whisper.cpp
（`tools\install-whisper.ps1`）、橋接註冊（`bridge\install.ps1 -ExtensionId <該台的ID>`）。
詳見 README 的「換一台電腦」。

---

## 寫程式的慣例

- **註解寫「為什麼」，不寫「做了什麼」。** 這個專案的註解密度偏高，因為很多決定
  （分段 12 秒、摘要用 AND、不下 initial prompt）是量測或踩坑得來的，
  沒有寫下來的話下一個人會很合理地把它改回錯的版本。
- **中文（台灣用語）**寫註解、UI 文案與 commit message。
- 失敗要**明確告訴使用者**，不要安靜地降級。例如原生辨識起不來會退到 WASM，
  但一定會在側邊欄說明原因與怎麼修。
- 加功能時想一下**它會不會花錢**，以及**沒有它的人會看到什麼**。
