# 給在這個專案上工作的 Claude Code

會議助手是一個**免建置**的 Chrome MV3 側邊欄擴充功能：讀取瀏覽器裡 Google Meet /
Microsoft Teams / Jitsi Meet 的會議字幕，產生逐字稿、滾動式摘要，以及被點名提問時的
回答建議。沒有 Node.js、沒有打包工具、沒有 npm —— 原始碼就是執行的東西。

設計背景與量測數據在 [README.md](README.md)，操作方式在手冊（README 頂端有連結）。
這份檔案只寫**動手改之前必須知道的事**。

---

## 最高原則：只花 Claude Pro 訂閱的錢

使用者已經買了 Claude Pro，**不接受任何按量計費的東西**。付費路線現在已經
**整個從程式碼裡移除**，不只是預設關閉 —— 留著就有誤觸的可能：

- 摘要走 **Claude Code 橋接**（Native Messaging 呼叫本機 `claude.exe`，用訂閱額度），
  即時回答走 **Chrome 內建 Gemini Nano**（本機執行）。兩者都免費。
- 語音辨識用**本機 whisper.cpp**（small 模型）。Deepgram 那條已刪除。
- `src/background/claude.js`（Claude API 用戶端）已刪除，`manifest.json` 也不再
  要求 `api.anthropic.com` 的權限。`resolveProvider()` 不可能回傳付費後端，
  背景測試有一項迴歸測試在守這件事。
- 提出任何新方案前先確認它不會產生額外費用。會的話要先講清楚成本再問。

Claude Pro 訂閱**不含 API 額度**，兩者是分開計費的。橋接是唯一能動用訂閱的路。

## 第二原則：不要把選擇丟回給使用者

使用者要的是「能用、好上手」，不是功能完整。後端、模型、辨識引擎、摘要頻率
**全部寫死成實測最佳組合**，設定頁只留他非填不可的欄位（名字、背景筆記）。
每多一個開關就多一種設錯的方式，而設錯的症狀（變慢、品質變差、安靜地不動）
使用者根本看不出是設定造成的。側邊欄同理：按鈕從八顆砍到三顆，
其餘動作（聽聲音、摘要）改成自動發生。

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

### 6. `bridge/host.bat` 是 Big5 編碼，不是 UTF-8

裡面的中文註解是用 Big5（CP950）存的。用**以 UTF-8 讀寫的編輯工具**去改它，
那些位元組會解碼失敗、被替換成 U+FFFD（`EF BF BD`），註解整片變成不可逆的亂碼。
症狀很容易被誤判：終端機顯示本來就會亂碼，所以「看起來亂」不代表壞了 ——
**要看實際位元組**（`od -c` 找 `357 277 275`）才分得出來。

改這個檔案時只動 ASCII 的指令行，或用位元組層級的腳本、並以 `cp950` 編碼寫入新註解。
順帶一提：`powershell.exe` 要用完整路徑，因為 `System32\WindowsPowerShell\v1.0`
不一定在 `PATH` 裡（實測有機器被移掉），裸呼叫會讓橋接讀到 0 bytes 就結束。

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

**測試頁卡住時症狀是「沒有任何輸出」。** 測試用的是微任務時鐘，`setTimeout`
永遠不會走到，所以只要有一個 `await` 等不到回覆（例如 stub 沒處理 Claude Code 的
`type:'run'`、或沒人回本機模型的 `ma:local:done`），整個頁面就靜靜停住，
`#out` 停在「尚未執行」，看起來像頁面沒載入。新增後端呼叫時記得補上 stub 的自動回覆。
`run.ps1` 現在會把「這一頁跑出零項結果」當成失敗 —— 以前不會，
於是整個區塊消失時總數仍顯示「全部通過」，比一個紅字危險得多。

**這些測試證明什麼、不證明什麼**：合成 DOM 驗證的是「選擇器與引擎邏輯自洽」，
**不能**證明真實的 Meet DOM 長得跟合成的一樣。

字幕選擇器實測過一次，結果是**抓到 Meet 的介面文字而不是字幕**（鍵盤快速鍵提示、
Gemini 橫幅、`arrow_drop_down`），因為 `heuristicRoot` 的門檻寫成
「像字幕得 100 分 ＋ 文字長度最多 1 分」再取 `score >= 1` —— 一個完全不像字幕但
文字夠長的元素剛好得 1.0 分就被接受。現在改成硬性條件：label 不像字幕就直接不考慮。
**這也是後來把音訊改成主力的原因。**

---

## 架構

```
會議分頁 content script（core.js + meet/teams/jitsi.js）
    讀字幕 DOM → mergeCaption 合併串流改寫 → 判斷「這句講完了」
        │ ma:segment
        ▼
service worker（背景）
    ├─ store.js       逐字稿狀態、**照說話時間插入**、chrome.storage.local 備份
    ├─ provider.js    後端切換（chrome-ai / claude-code），分角色決定
    ├─ 摘要排程        兩個條件都成立才觸發（AND），失敗時退避
    └─ 提問偵測        問句 + 有沒有點到你的名字
        │ port 廣播
        ▼
側邊欄 panel.js
```

**offscreen 文件**負責音訊：`tabCapture` → 降取樣到 16 kHz → 分段 → 兩個引擎之一
（原生 whisper.cpp / WASM whisper 備援）→ 簡繁轉換 → 回報成 segment。

幾個不明顯但重要的決定：

- **音訊是逐字稿的主要來源，字幕只拿來補說話者姓名。**
  這個預設在真實會議實測後整個反過來了：Meet 的字幕斷斷續續、常常整段抓不到，
  而本機 whisper 完整得多。字幕唯一的優勢是**有真實姓名**（whisper 拿不到），
  所以退成「誰在講話」的資料源，靠說話時間比對回填到音訊段落上。
  但**音訊沒在跑的時候字幕仍然要收** —— `tabCapture` 需要使用者先在會議分頁點過
  擴充功能圖示，這步很容易漏掉，那時丟掉字幕等於整個功能靜靜失效。
- **逐字稿照「說話時間」排序，不是抵達順序。** 不同來源的延遲差很多，
  照抵達順序排會讓早講的話排在晚講的後面 —— 送去摘要的對話順序就是錯的。
- **原生辨識另開一條 `connectNative`**，不跟 Claude Code 共用。`host.ps1` 是單執行緒循序
  處理訊息，共用的話「啟動辨識伺服器」會排在一個跑了 30 秒的 Claude Code 呼叫後面。
  附帶好處：連線關閉時 `host.ps1` 的 `finally` 會把伺服器一起收掉。
- **`getMediaStreamId()` 必須由側邊欄呼叫，而且必須在點擊處理函式裡。** 兩個條件缺一不可：
  1. **要有使用者手勢** —— 計時器觸發的呼叫一定被拒。所以側邊欄有一顆
     「▶ 開始聆聽」，它存在的唯一理由就是提供那個手勢，不要想把它自動化掉。
  2. **手勢不會跨 `sendMessage` 傳到 service worker** —— 「按鈕送訊息、背景去呼叫」
     這種寫法照樣失敗，因為背景那邊沒有手勢。正確做法是側邊欄自己呼叫
     `chrome.tabCapture.getMediaStreamId()`，再把拿到的 id 傳給背景。

  Chrome 對這兩種失敗給的錯誤都是 `Extension has not been invoked for the current page`，
  聽起來像「權限沒給」，於是很容易繞去點工具列圖示、重新整理分頁、重新載入擴充功能 ——
  **那些全都沒用**。也試過用 `chrome.scripting.executeScript` 自己補授權，同樣沒用。
- **擷取音訊要對著 content script 回報的分頁**（`sender.tab.id`，存在背景的 `meetingTabId`，
  側邊欄用 `ma:meetingTab` 問）。側邊欄是獨立情境，`chrome.tabs.query({active:true})`
  拿到的不一定是會議分頁，猜錯時 tabCapture 永遠失敗，錯誤訊息又跟上面那個一模一樣。
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
