# 給在這個專案上工作的 Claude Code

會議助手是一個**免建置**的 Chrome MV3 側邊欄擴充功能：讀取瀏覽器裡 Google Meet /
Microsoft Teams / Jitsi Meet 的會議字幕，產生逐字稿、滾動式摘要，以及被點名提問時的
回答建議。沒有 Node.js、沒有打包工具、沒有 npm —— 原始碼就是執行的東西。

設計背景與量測數據在 [README.md](README.md)，操作方式在手冊（README 頂端有連結）。
這份檔案只寫**動手改之前必須知道的事**。

---

## 最高原則：不接受任何按量計費

使用者已經買了 Claude Pro，**不接受任何會變成帳單的東西**。注意這條原則的
真正界線是「**會不會產生沒有上限的費用**」，不是「是不是雲端」：

- **可以用**：免費方案（Groq、NVIDIA NIM、Tavily）—— 不需要信用卡，
  用超過就是回 HTTP 429，不會自動轉成計費。以及 Claude Pro 訂閱額度
  （透過 Claude Code 橋接）、本機執行的東西。
- **不可以用**：綁信用卡按量計費的 API。`src/background/claude.js`
  （Claude API 用戶端）已**整個刪除**，`manifest.json` 也不再要求
  `api.anthropic.com` 的權限。背景測試有一項迴歸測試在守這件事。

Claude Pro 訂閱**不含 API 額度**，兩者是分開計費的。橋接是唯一能動用訂閱的路。

提出任何新方案前先確認它不會產生額外費用。會的話要先講清楚成本再問。

### 目前的組合（2026-08 實測）

| 角色 | 主力 | 實測 | 退路 |
|---|---|---|---|
| 逐字稿 | Groq `whisper-large-v3-turbo` | RTF **0.06**、16.6 秒樣本一字未錯 | 本機 whisper.cpp small → 瀏覽器 WASM base |
| 即時回答 | Groq `llama-3.3-70b-versatile` | **0.7 秒** | Groq 8b-instant → NIM 8b → Claude Code |
| 摘要 | Groq `openai/gpt-oss-120b` | 0.7 秒 | Groq 70b → NIM 8b → NIM 70b → Claude Code |
| 看畫面 | Groq `llama-4-scout` | — | Groq `llama-4-maverick` → Claude Code |
| 查證 | Tavily（只在需要時） | 1–2 秒 | 沒有就跳過，不擋住回答 |

**「附上會議畫面」不要再無條件升級到橋接。** 原本雲端 `supportsImages: false`，
所以勾了附畫面就一定走 Claude Code。實測踩到的問題是**橋接比想像中脆弱**：
`bridge/config.json` 存的是 `claude.exe` 的**絕對路徑**，而 Claude Code 的
VS Code 擴充功能會自動更新到新的版號資料夾（`anthropic.claude-code-2.1.228-…`），
舊路徑就失效。使用者看到的是「勾了附上會議畫面就出錯，不勾就正常」——
完全聯想不到是**別的軟體更新**造成的。

兩邊都修了：雲端用 `vision` 候選鏈自己看圖（llama-4，一樣免費、1 秒內），
而 `host.ps1` 在設定的路徑不存在時會**自己重新找一次**並寫回 config.json，
使用者不必為了別人的版本更新去重跑安裝腳本。

雲端要的是 **base64 data URL**（`imageDataUrl`），橋接要的是**檔案路徑**
（`imagePath`），兩個不能互換。而且雲端那條用 **JPEG 品質 70** ——
PNG 的整頁截圖 base64 之後會撞到請求大小上限，而失敗訊息不會告訴你是圖片太大。

這是**從「本機 whisper ＋ Claude Code」換過來的**，原因是真實會議實測：
Claude Code 橋接每次呼叫都是一個完整的 CLI session，要 10–30 秒 ——
被點名時等 30 秒等於沒有這個功能；而本機 whisper small「大致正確」，
錯一個關鍵詞（對帳→對戰）就把摘要與回答一起帶歪。

幾個容易踩的實測結果：

- **Groq 的免費額度是「每個模型一個桶」。** 所以辨識／摘要／回答刻意用
  三個不同模型 —— 等於把可用額度變成三份，而且摘要吃掉的 token
  不會排擠到「被點名要秒回」。改模型時要記得這件事。
- **NVIDIA NIM 的模型之間差距大到不能忽略**：`llama-3.1-8b-instruct` 0.9 秒，
  `llama-3.3-70b-instruct` **87 秒**（兩者都回 200，差別純粹是排隊）。
  所以回答鏈只用 8B，70B 只留在摘要鏈的最後一格。
- **Chrome 內建的 Gemini Nano 不支援中文輸出。** `LanguageModel` 的 API 要求
  指定 `outputLanguage`，支援清單只有 `[de, en, es, fr, ja]`，指定 `zh` 直接失敗。
  這是個中文會議助手，回答要能照唸 —— 吐英文的模型在這裡沒有用。
  程式碼路徑留著（`fastAnswersLocal`），哪天支援中文再打開。

  **沒指定 `outputLanguage` 的呼叫會在 `chrome://extensions` 的錯誤頁
  累積警告，而且是每呼叫一次多一筆**（連 `availability()` 也算）。使用者看到的
  是錯誤一直長出來，卻完全看不出跟什麼有關。所以兩件事都要做：
  呼叫時一律帶 `outputLanguage: 'en'`，而且**用不到它的時候完全不要呼叫**——
  側邊欄只在 `describe()` 回報 `needsPanel` 時才去問狀態（那是唯一會用到它的
  情況）。踩過一次：預設走雲端之後仍然每開一次側邊欄就問一次，
  錯誤頁上莫名其妙一直長警告。`panel.drive.js` 有兩項測試守著。

## 第 1.5 原則：金鑰絕對不能進版控

**這個 repo 是公開的。** 金鑰只要推上去一次就等於外洩 —— 就算之後用 commit
刪掉，GitHub 仍保留該 blob，掃描機器人通常在幾分鐘內就會撿走，只能到各家
後台重新簽發。

- 金鑰存在 `chrome.storage.local`（`keys.js`，跟 `settings` 分開的 entry），
  由設定頁貼進去，**換一台電腦就要重貼一次**。
- 使用者自己的 `API Key.txt` 放在專案根目錄，已被 `.gitignore` 擋住。
- `tests\check-project.ps1` 會掃**所有 git 追蹤中的檔案**找金鑰樣式
  （`gsk_`／`nvapi-`／`tvly-`／`sk-ant-`）。測試需要長得像真的假金鑰時，
  **一律讓它含大寫 `FAKE`** —— 掃描器靠這個約定放行。
- 回到畫面上的金鑰一律經過 `maskKey()`。設定頁與側邊欄的內容會出現在截圖、
  螢幕分享與錄影裡，而這個擴充功能的使用情境正好就是在分享畫面。

## 第二原則：不要把選擇丟回給使用者

使用者要的是「能用、好上手」，不是功能完整。後端、模型、辨識引擎
**全部寫死成實測最佳組合**，設定頁只留他非填不可的欄位（金鑰、名字、背景筆記）。
每多一個開關就多一種設錯的方式，而設錯的症狀（變慢、品質變差、安靜地不動）
使用者根本看不出是設定造成的。側邊欄同理：按鈕從八顆砍下來，
其餘動作（聽聲音、記錄自己的發言、定期摘要）改成自動發生。

**判準是「漏掉的後果看不看得出來」。** 「🎤 我的發言」原本是一顆開關，
後來改成跟著聆聽自動開合 —— 忘記按的後果是逐字稿裡永遠沒有你自己說過的話，
而那件事在當下完全看不出來，只會讓回答建議莫名其妙地少了脈絡。
一個預設就該成立的東西不該變成「偶爾記得按才成立」。

反過來，**使用者有明確意圖的動作要留按鈕**。「✦ 產生重點」就是這種：
自動摘要有兩個門檻（累積夠多段 **且** 距上次夠久），而「我現在就想要一份」
是一個具體的當下需求，沒有按鈕就沒有別的辦法。按下去之後
`markSummarized` 會把段數與時間基準一起重設，所以自動摘要的節奏
從那一刻重新開始算，不會變成「才剛手動產生完，一分鐘後又自動跑一次」。

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

**最容易忘的來源是 Chrome 自己的 user-data-dir。** 測試腳本開 headless Chrome 時
如果把 `--user-data-dir` 指到專案裡（例如 `tests\.cloudprofile`），Chrome 會在那底下
建 `_locales`、`_metadata` —— 於是**跑一次測試就把擴充功能弄壞了**，而錯誤訊息
（「Cannot load extension with file or directory name _locales」）完全不會指向測試腳本。
所有 `--user-data-dir` 一律指到 `$env:TEMP` 底下。踩過兩次：一次是暫存資料夾命名，
一次是這個。`check-project.ps1` 會掃出來，但它只在你想起要跑的時候才幫得上忙。

順帶一提，PowerShell 裡**不要把變數命名為 `$profile`** —— 那是自動變數
（使用者設定檔的路徑）。`$args`、`$input` 同理。

### 4. whisper.cpp 打不開非 ASCII 路徑

它用窄字元 Win32 API 開檔，路徑先被轉成系統 ANSI，`會議助手` 這種資料夾名會變成亂碼，
開檔直接失敗（`whisper-cli` 結束碼 9，而且錯誤訊息常被 stderr 緩衝吃掉）。

**這就是原生辨識裝在 `%LOCALAPPDATA%\MeetingAssistant\whisper` 而不是專案裡的原因。**
`tools\install-whisper.ps1` 會檢查路徑是不是純 ASCII。不要把它搬進專案資料夾。

### 4.5 PowerShell 讀原生程式的輸出會用 CP950 解碼

`$out = & curl.exe …` 這種寫法，PowerShell 5.1 是用**主控台的字碼頁**
（正體中文機器是 CP950）去解碼那支程式的 stdout。對方吐 UTF-8 的話，
中文會整片變成亂碼 —— 而且**字串長度也對不上**，所以後續任何比對都會失敗。

踩過的實例：`run-cloud-check.ps1` 用 curl 驗 Groq 串流，「內容是不是繁體」
那一項一直失敗，失敗訊息看起來像模型吐了亂碼，實際上模型完全正常。

**輸出寫進檔案，再用 `[IO.File]::ReadAllText($f, [Text.UTF8Encoding]::new($false))`
讀回來。** 送進去的方向也一樣：body 用 `--data-binary "@檔案"`，
不要用 `-d "字串"`（見下面 host.bat 那條，以及 bench 腳本裡 `Invoke-RestMethod`
要自己把 body 轉成 UTF-8 位元組的說明）。

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

**兩個都要綠才能推。**

第三支是**選用**的，改動雲端請求形狀時才跑：

```powershell
powershell -ExecutionPolicy Bypass -File tests\run-cloud-check.ps1
```

它用**真金鑰打真 API**（讀根目錄的 `API Key.txt`），驗的是「我們送出去的東西
對方真的收得下」。這跟上面兩支驗的是不同的事 —— 請求形狀寫錯時 stub 照樣會
回應，只有真的打過去才會被拒。它不進 `run.ps1`，因為需要網路與金鑰而且會
消耗免費額度。附帶一提它用 `--disable-web-security` ＋ 獨立的 user-data-dir，
因為 Groq 不對瀏覽器發 CORS 標頭（擴充功能有 host_permissions 所以沒這問題）。 第二個抓的是「行為測試跑得過但東西載不進去」的那類問題
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

**`--virtual-time-budget` 會把時鐘虛擬化,而且串流完全測不了。**
那個旗標是讓 headless Chrome 等非同步工作跑完的唯一辦法，代價是
`Date.now()` 前進的是虛擬時間、`setTimeout` 會在頁面閒著等網路時提早觸發。
實測後果（都在 `run-cloud-check.ps1` 踩過）：

- 每次 API 呼叫都量到 10 毫秒（真實值 700–1000 毫秒），
  所以「回答夠快（3 秒內）」這類斷言**永遠通過** —— 比失敗更危險，
  因為沒有人會去看綠色的項目。**不要在這個環境寫任何跟時間有關的斷言。**
- 逾時用的 `setTimeout(() => ctrl.abort(), …)` 會在回應回來前就觸發，
  把進行中的請求砍掉。留著計時器 → 串流只收到第一個 token；
  拿掉計時器 → 串流永遠不結束、整頁卡死。**兩邊都不是產品的問題。**

所以**即時的串流契約用 curl 在真實時間下驗**（見 `run-cloud-check.ps1`
開頭的 PowerShell 段），SSE 解析器本身則用合成串流在 `run.ps1` 裡驗
（半行 JSON、事件切在 chunk 邊界）。兩件事分開，各用測得到的工具。

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
    ├─ keys.js        雲端金鑰（跟 settings 分開存，永遠遮罩後才回畫面）
    ├─ cloud.js       Groq／NIM 用戶端：候選鏈、NIM 雙帳號輪替、429 冷卻、SSE 串流
    ├─ tavily.js      網路查證（只在問題指向會議之外時才呼叫）
    ├─ provider.js    後端切換（cloud / claude-code / chrome-ai），分角色決定
    ├─ 摘要排程        兩個條件都成立才觸發（AND），失敗時退避
    └─ 提問偵測        問句 + 有沒有點到你的名字
        │ port 廣播
        ▼
側邊欄 panel.js
```

**offscreen 文件**負責音訊：`tabCapture` → 降取樣到 16 kHz → VAD 切段 →
三個引擎之一（Groq 雲端 / 原生 whisper.cpp / WASM whisper）→ 簡繁轉換 →
回報成 segment。

幾個不明顯但重要的決定：

- **雲端辨識的瓶頸是「每分鐘幾次請求」，不是「算得多快」。**
  Groq 免費方案對 `whisper-large-v3-turbo` 是 20 RPM。所以積壓時的處置
  跟本機那條**完全相反**：本機是丟掉最舊的（寧可漏也不要越落後），
  雲端是**把相鄰的段落合併**送一次 —— 丟掉等於白白丟掉使用者講的話，
  合併不會少一個字，代價只是那段逐字稿晚幾秒出現。
  節流間隔設 3,400 毫秒（≈17.6 RPM，留餘裕給重試），合併上限 28 秒
  （超過 whisper 的 30 秒窗要多跑一輪 encoder，而且一段太長很難讀）。
- **雲端辨識的提示詞是用來指定書寫系統，不是餵詞彙。**
  不給提示詞會吐簡體，給一句繁體的提示詞就直接吐繁體。但仍然保留
  `s2t` 轉換當保險 —— 提示詞的效果沒有保證，而 `s2t` 對已經是繁體的
  文字是無害的空操作。（本機那條相反：實測 initial prompt 會讓
  「對帳」變成「對戰」，所以本機**不下** prompt。）
- **`cloudComplete` 的回傳形狀必須跟 `ccComplete` 一致**（`{ text, stopReason }`，
  輸入是 `{ system, messages }`）。因為 `provider.js` 在雲端整條失敗時會把
  **同一個 opts** 直接交給橋接重跑，形狀不一樣的話那個退路是壞的，
  而且只有在雲端失敗的時候才會被發現。背景測試有一項守著這件事。
- **換後端一定要告訴使用者。** 雲端 0.7 秒、橋接 10–30 秒，
  不講的話使用者只會覺得「今天特別慢」，然後去懷疑自己的網路。
  `complete`／`stream` 都吃一個 `onFallback` 回呼，由 service-worker
  廣播成側邊欄上的一行說明。
- **音訊是逐字稿的主要來源，字幕只拿來補說話者姓名。**
  這個預設在真實會議實測後整個反過來了：Meet 的字幕斷斷續續、常常整段抓不到，
  而本機 whisper 完整得多。字幕唯一的優勢是**有真實姓名**（whisper 拿不到），
  所以退成「誰在講話」的資料源，靠說話時間比對回填到音訊段落上。
  但**音訊沒在跑的時候字幕仍然要收** —— `tabCapture` 需要使用者先在會議分頁點過
  擴充功能圖示，這步很容易漏掉，那時丟掉字幕等於整個功能靜靜失效。
- **逐字稿照「說話時間」排序，不是抵達順序。** 不同來源的延遲差很多，
  照抵達順序排會讓早講的話排在晚講的後面 —— 送去摘要的對話順序就是錯的。
- **姓名有兩個來源，字幕不是唯一的。** 除了字幕，還有**畫面上的發言指示器**
  （`ma:speaking`）—— Meet／Teams／Jitsi 都會標出正在說話的人，
  而那個資訊**不需要使用者開字幕**。字幕要使用者自己在會議裡開啟，
  那一步很容易漏掉（也常常根本不想開），結果就是整份逐字稿每一段都是「其他人」。

  這條路的資料來自 DOM，所以有三道防線，**每一道都是為了「寧可沒有名字，
  也不要掛錯人」**：名字要像名字（`looksLikeName`）、要對得上參與者名單、
  **同時偵測到兩個人就整個丟掉**。掛錯人在畫面上看起來完全正常，
  只有當事人自己看得出不對，而摘要與回答建議已經被帶歪了。

  往上爬找名字時最危險的一步是爬到「裝著所有人視訊磚的格線」那一層 ——
  在那裡 `querySelector` 會回**第一個人**的名字，於是所有人的話都掛到他頭上。
  所以 `soleName()` 的條件是「**這一層只有一個名字**」，那等於「這一層就是
  某一個人的磚」，而且不依賴任何 class。

  指示器的選擇器**沒有公開文件、也沒辦法用合成 DOM 證明**（字幕選擇器就是
  這樣第一次寫錯的）。所以在會議分頁的 console 留了 `__MA_SPEAKER_DEBUG__()`，
  印出每一條候選選擇器的命中數 —— 下一輪修選擇器要照著實際結果改，不要繼續猜。
  設定頁的診斷也會印出 `speakerStrategy`（命中哪一條）。
- **說話者姓名靠「時間區間」比對，而且雲端要逐句的時間戳。**
  語音辨識完全不做說話者分離，姓名只有平台字幕有。所以字幕記
  `{speaker, from, to}`，音訊的每一句拿自己的說話時間去問「這個時間點誰在講話」。

  記區間而不是時間點是必要的：一則字幕持續好幾秒又會被串流改寫（同一個 id
  定稿多次），只記一點的話比對變成「離哪一點最近」—— 一句講了 8 秒的話，
  後半段會離下一個人的起點更近，於是掛到**還沒開口的人**頭上。
  容許誤差 **±6 秒**；原本寫 20 秒是照本機辨識的**處理延遲**設的，
  但比對用的是說話時間，延遲根本不影響 —— 放那麼寬只是讓它安靜地掛錯人。

  雲端為了守 20 RPM 會把音訊合併到 28 秒，所以必須用
  `response_format=verbose_json` ＋ `timestamp_granularities[]=segment`
  拿到**每一句**的相對秒數，一句一段送出（`emitPiece`）。整塊只送一段的話，
  28 秒裡三個人的話會全部掛在同一個人頭上，而畫面上看起來完全正常。
  `emitPiece` 的 id 一定要含 `startedAt` 與序號 —— 同一毫秒送出好幾句，
  只用 `Date.now()` 會讓它們拿到同一個 id，然後 `upsertSegment` 把它們
  **互相覆蓋**，28 秒最後只剩一句。

  `segments` 欄位消失時要能退回整段文字（逐字稿完整，只是粒度變粗）。
  **這個欄位只有打真 API 才驗得到** —— 合成測試裡它是我們自己塞的，
  所以 `run-cloud-check.ps1` 有一項在守。
- **原生辨識另開一條 `connectNative`**，不跟 Claude Code 共用。`host.ps1` 是單執行緒循序
  處理訊息，共用的話「啟動辨識伺服器」會排在一個跑了 30 秒的 Claude Code 呼叫後面。
  附帶好處：連線關閉時 `host.ps1` 的 `finally` 會把伺服器一起收掉。
- **音訊擷取只能從 `chrome.action.onClicked` 啟動**（點工具列圖示）。這是查了三輪才確定的：

  `chrome.tabCapture.getMediaStreamId()` 要求使用者手勢，而**能被接受的手勢來源很窄**。
  實測不被接受的有：計時器（顯然）、**側邊欄裡的按鈕 click**、
  「側邊欄送 sendMessage、背景去呼叫」（手勢不跨情境傳遞）。
  也試過 `chrome.scripting.executeScript` 自己補授權，沒用。

  **關鍵陷阱：`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` 會讓
  `action.onClicked` 不再觸發**，等於把唯一可用的手勢來源關掉。所以那個設定要設成
  `false`，改在 `onClicked` 裡自己 `sidePanel.open()`，順便在同一個脈絡裡啟動擷取。

  Chrome 對這些失敗給的訊息都是
  `Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.`
  —— 兩句都會誤導：前半聽起來像權限沒給（於是白繞去重新整理、重新載入擴充功能），
  後半聽起來像目標分頁選錯（但目標明明是 Meet）。**真正的原因一直都是手勢來源。**
- **`getMediaStreamId()` 拿到的 id 幾秒內沒用掉就失效。** 所以順序是
  **先讓 offscreen 接住串流，再去啟動辨識伺服器**（`sttEnsure` 冷啟動載入 small
  模型要好幾秒）。反過來的話 `getUserMedia` 拿到過期的 id，擷取靜靜失敗，
  但狀態已經是「聆聽中」—— 講再多話都沒有逐字稿，**而且沒有任何錯誤訊息**。
  這是最難查的一種：每一層看起來都正常。背景測試有一項守著這個順序。
  順帶一提：`chrome.runtime.sendMessage` 沒人接時回 `undefined`，
  把它當成成功就會變成另一種安靜失敗，所以 `!res` 也要算失敗。
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

**API 金鑰**（設定頁貼上，見上面的第 1.5 原則）、`vendor/`（WASM 備援，
`tools\fetch-vendor.ps1`）、原生 whisper.cpp（`tools\install-whisper.ps1`）、
橋接註冊（`bridge\install.ps1 -ExtensionId <該台的ID>`）。
詳見 README 的「換一台電腦」。

金鑰是**唯一一個不裝就會明顯變差**的（逐字稿慢 8 倍、回答從 1 秒變 10–30 秒），
其餘三個都只是退路。所以側邊欄在沒有金鑰時會主動跳一次說明。

---

## 寫程式的慣例

- **註解寫「為什麼」，不寫「做了什麼」。** 這個專案的註解密度偏高，因為很多決定
  （分段 12 秒、摘要用 AND、不下 initial prompt）是量測或踩坑得來的，
  沒有寫下來的話下一個人會很合理地把它改回錯的版本。
- **中文（台灣用語）**寫註解、UI 文案與 commit message。
- 失敗要**明確告訴使用者**，不要安靜地降級。例如原生辨識起不來會退到 WASM，
  但一定會在側邊欄說明原因與怎麼修。
- **改了預設值就去檢查所有依它分流的文案。** 踩過一次：預設辨識引擎換成
  `groq` 之後，`sttStartedMessage` 忘了加對應分支，於是**所有正常設定好金鑰的人**
  都掉進最後那句備援訊息 ——「瀏覽器內建備援引擎…執行 install-whisper.ps1」，
  描述的是一條他根本沒在走的路，還叫他去裝一個不需要的東西。而且雲端那句
  本來要負責的另一件事（**音訊會離開這台電腦**）就這樣整個消失了。
  這種錯誤沒有例外、沒有紅字、逐字稿照樣正常出現，自己永遠不會浮出來。
  `check-project.ps1` 現在會比對引擎清單與分支，`panel.drive.js` 則驗
  「三個引擎的說明各不相同」。
- **持續性的失敗只講一次。** 辨識錯誤幾乎都是持續的（金鑰被拒、額度用完、
  斷線），雲端約 3–5 秒一段，沒有節流的話一小時會推出好幾百則一模一樣的橫幅，
  把真正該看到的訊息洗掉，看起來也像擴充功能自己壞了。`noteTranscribeError`
  只在**訊息內容改變**時回報，並帶上累計次數。
- **UI 先樂觀更新的話，背景每一條提早返回的路都要收尾。**
  「✦ 產生重點」會先把按鈕切成「產生中…」再送訊息（不然中間的空窗會讓人
  以為沒按到），所以 `runSummary` 只要提早 return 而沒補一則 `running:false`，
  按鈕就永遠停在「產生中…」且停用 —— 使用者只能關掉側邊欄重開，
  而畫面上完全看不出發生了什麼事。
- 加功能時想一下**它會不會花錢**，以及**沒有它的人會看到什麼**。
