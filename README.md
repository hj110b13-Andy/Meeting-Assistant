# 會議助手 — 即時逐字稿與重點

> **三步就能用**：載入擴充功能 → 設定頁貼上一把免費的 Groq 金鑰 → 填你的名字。
> 詳見下方「[安裝](#安裝)」。這份 README 講的是「怎麼裝、怎麼運作、為什麼這樣設計」。

Chrome / Edge 擴充功能。**聽你瀏覽器裡正在進行的會議**（Google Meet、
Microsoft Teams 網頁版、Jitsi Meet），用**語音辨識**即時產生：

- **逐字稿**，每段都標註說話者（顏色固定，同一人永遠同色）
- **滾動式重點摘要**：重點、決議、待辦（含負責人）、未解問題
- **即時回答建議**：有人點名問你時，**約 1 秒內**給一句可以直接照唸的答案 + 2–4 個補充要點

**完全免費，而且不可能變成帳單。** 主力走 Groq 與 NVIDIA NIM 的免費方案 ——
兩家都不需要信用卡，用超過就是被拒絕（HTTP 429），不會自動轉成按量計費。
撞到額度或沒設金鑰時，會依序退到本機 whisper.cpp 與 Claude Code 橋接
（用你已經買的 Pro 訂閱額度），**而且側邊欄一定會告訴你換了、以及為什麼**。
綁信用卡按量計費的路線已經整個從程式碼裡移除。

不需要 Node.js、不需要建置、不需要自架伺服器。**需要一把免費的 API 金鑰**
（沒有也能跑，只是逐字稿慢 8 倍、回答從 1 秒變成 10–30 秒）。

### 支援的平台

| 平台 | 網域 | 逐字稿來源 | 說話者姓名 |
|---|---|---|---|
| Google Meet | `meet.google.com` | 語音辨識 | 開字幕才有真名 |
| Microsoft Teams | `teams.microsoft.com`、`teams.live.com` | 語音辨識 | 開字幕才有真名 |
| Jitsi Meet | `meet.jit.si`、`*.8x8.vc`、自架站 | 語音辨識 | 開字幕才有真名 |

**逐字稿一律來自語音辨識，不依賴平台字幕。** 這個預設在真實會議實測後反過來了：
Meet 的字幕斷斷續續、常常整段抓不到，而語音辨識完整得多。字幕唯一的優勢是
**帶真實姓名**（辨識只有聲音，拿不到），所以退成「誰在講話」的資料源 ——
有開字幕時會自動用說話時間比對，把真名補到辨識出來的段落上。

沒開字幕也能用，只是說話者會顯示成「其他人（雲端辨識）」。

Teams 的字幕在 iframe 裡，所以那個平台用 `all_frames: true`。

**三個平台都不會產生任何按量費用。**

**Jitsi 有兩件事跟另兩個平台不同：**

1. **字幕有兩個顯示位置，DOM 結構完全不同**，而且 class name 全是 tss/emotion 產生的雜湊，不能當選擇器。`jitsi.js` 的選擇器是直接讀 `meet.jit.si` 的 `app.bundle.min.js`（v9365）確認的，不是猜的：
   - **聊天面板的字幕分頁** —— 資料最完整（有姓名、時間），而且有穩定的 DOM id `#subtitles-messages-list`。兩個陷阱：**姓名只出現在每組第一則**（第二則要從同組繼承），每則都帶**時間戳元素**（不排除會被當成字幕內容）。訊息節點靠結構辨識：最後一個子元素是時間格式。
   - **舞台上疊的那層字幕** —— `<div><p><span>文字</span></p></div>`，姓名夾在文字裡（`名字: 內容`）。容器靠結構找（子元素都是 `p`）。切姓名的依據是「冒號後面有空白」，光看有沒有冒號會把句子裡的時間碼切壞（「時間是 14:30」會變成說話者「時間是 14」）。
2. **網域不固定**，因為 Jitsi 可以自架。公開站已內建，自架站要到**設定頁 → 自架的 Jitsi Meet**填網域並按「授權並啟用」（權限請求必須從設定頁的使用者手勢觸發），之後由 `chrome.scripting` 動態註冊內容腳本。

> ⚠️ **Jitsi 的字幕不一定開著，公開站也一樣。** 實際抓 `https://meet.jit.si/config.js` 看到的是：
>
> ```js
> transcription: {
>     enabled: false,
>     translationEnabled: false,
>     disableClosedCaptions: true,
>     inviteJigasiOnBackendTranscribing: true,
> }
> ```
>
> 也就是說**公開的 meet.jit.si 預設沒有字幕**（`inviteJigasiOnBackendTranscribing` 暗示轉錄由後端決定，應該只給付費／JaaS 租戶）。
> 自架站則要部署端裝了 **Jigasi** 才有字幕。
> **但這完全不影響使用**：逐字稿本來就來自語音辨識聽分頁的聲音，
> 字幕只是拿來補說話者姓名。沒字幕的 Jitsi 一樣有完整逐字稿，
> 只是說話者顯示成「其他人（雲端辨識）」。
>
> 判斷某個 Jitsi 站有沒有字幕，最快的方法是查它的 config：
>
> ```powershell
> (Invoke-WebRequest "https://網域/config.js" -UseBasicParsing).Content -split "`n" | Select-String 'transcri|subtitle'
> ```

## 全部免費，而且不可能變成帳單

逐字稿、說話者標註、搜尋、匯出**完全不碰任何模型**。只有「摘要」和「回答建議」
需要模型，而**每一條路都是免費的**：

| 用途 | 主力 | 實測速度 | 費用 |
|---|---|---|---|
| **逐字稿** | Groq `whisper-large-v3-turbo` | RTF 0.06（16.6 秒音檔約 1 秒） | 免費方案 |
| **即時回答** | Groq `llama-3.3-70b-versatile` | **0.7 秒** | 免費方案 |
| **摘要** | Groq `openai/gpt-oss-120b` | 0.7 秒 | 免費方案 |
| **查證**（選用） | Tavily | 1–2 秒 | 免費方案 |

撞到額度或沒設金鑰時會自動往下退，**而且側邊欄會告訴你為什麼**：

```
Groq 主力模型 → Groq 備用模型 → NVIDIA NIM（兩個帳號輪流）→ Claude Code 橋接
逐字稿：Groq → 本機 whisper.cpp small → 瀏覽器內 WASM whisper base
```

> **「免費方案」是什麼意思？**
> Groq、NVIDIA NIM、Tavily 三家都**不需要信用卡，也不會自動轉成按量計費**：
> 用超過就是回 HTTP 429 被拒，不是開始扣錢。這跟「綁了卡就一直扣」的
> API 完全不同，所以才符合這個專案的前提。

> ⚠️ **Claude Pro／Max 訂閱不含 API 額度。** 訂閱和 API 是分開計費的兩套東西，
> 擴充功能**無法**直接用訂閱額度呼叫 API。「Claude Code 橋接」是唯一能動用訂閱的方式 ——
> 它呼叫的是你本機的 CLI，不是 API。橋接每次呼叫都是一個完整的 CLI session，
> 所以要 10–30 秒；它現在的角色是**最後的退路**，不是主力。

**按量計費的路線已經整個移除**，不只是預設關閉：`src/background/claude.js`
（Claude API 用戶端）與 Deepgram 引擎都已刪除，`manifest.json` 也不再要求
`api.anthropic.com` 的權限。背景測試有一項迴歸測試守著這件事 ——
硬塞 `provider='claude'` 也不會生效。留著付費路線就有誤觸的可能。

### 免費額度（2026-08 查證）

| 服務 | 限制 | 怎麼恢復 | 一場一小時的會議會用掉多少 |
|---|---|---|---|
| Groq `whisper-large-v3-turbo` | 20 次/分、7,200 音訊秒/時、28,800 音訊秒/天 | **持續回填**（見下） | 3,600 音訊秒（額度的 1/8） |
| Groq `llama-3.3-70b-versatile` | 30 次/分、1,000 次/天、12,000 token/分 | **持續回填** | 看被點名幾次，通常個位數次 |
| NVIDIA NIM | 約 40 次/分，額度綁帳號 | 約每月（見下） | 只在 Groq 撞牆時才用到 |
| Tavily | 1,000 點/月 | **每月 1 號歸零重給**，用不完不累積 | 通常個位數次 |

**Groq 的額度是「每個模型一個桶」**，所以辨識、摘要、回答刻意用三個不同模型 ——
等於把可用額度變成三份，而且摘要吃掉的 token 不會排擠到「被點名要秒回」。

#### Groq 不是「每天午夜歸零」，是持續回填

這點很容易誤解，而它直接影響撞到額度之後該怎麼辦。實際跟 Groq 要它回報的
標頭（`x-ratelimit-*`）：

```
x-ratelimit-limit-requests: 1000        每天 1000 次
x-ratelimit-remaining-requests: 999     用掉 1 次
x-ratelimit-reset-requests: 1m26.4s     ← 86.4 秒後補回那一次

x-ratelimit-limit-tokens: 12000         每分鐘 12000 token
x-ratelimit-remaining-tokens: 11963     用掉 37 個
x-ratelimit-reset-tokens: 185ms         ← 185 毫秒後補回那 37 個
```

兩個數字都**完全對得上連續回填**：86400 秒 ÷ 1000 次 = 86.4 秒／次；
12000 token ÷ 60 秒 = 200 token／秒，37 ÷ 200 = 0.185 秒。

也就是說**撞到額度不必等到明天，等一下就有**。`cloud.js` 的冷卻機制正是
建立在這件事上：撞到 429 就把那個模型冷卻 60 秒（或用伺服器給的
`Retry-After`）再試，而不是整場會議都放棄它。

#### 另外兩家

- **NVIDIA NIM**：點數制、綁帳號，一般說法是每月約 1,000 點。
  但各家資料不一致（有來源說已改成不限點數、只靠 40 次/分的速率限制），
  **這一項我沒有實測確認**。反正它只是 Groq 撞牆時的備援，平常不會動到，
  而且可以填兩個帳號輪流用。
- **Tavily**：1,000 點/月，**每月 1 號**依日曆歸零重給（不是從你註冊日算），
  而且**用不完不會累積**。因為只在問題明顯需要外部資料時才查，
  一個月個位數到數十次，很難用完。

### API 金鑰怎麼設定

到設定頁（`chrome://extensions` → 這個擴充功能 → 詳細資料 → 擴充功能選項）
貼上金鑰，按頁面最下面的「儲存設定」。每一欄旁邊都有「測試」按鈕，會直接打一次
API 確認 —— 測的是你當下框裡那把，還沒儲存也能測。

> **這一頁只有一顆儲存按鈕，它存整頁的內容**（金鑰、名字、背景筆記、摘要頻率）。
> 先前金鑰與其他設定各有一顆，而金鑰那塊在最上面，所以「儲存金鑰」是最先遇到的
> 按鈕 —— 填完名字與摘要間隔之後按到它，那兩項不會被存，畫面上卻還是出現綠色的
> 「已儲存 ✓」。合併成一顆之後就沒有這個陷阱了，而且有未儲存的變更時
> 儲存列會顯示「● 有變更還沒儲存」。
>
> **存好之後金鑰輸入框會清空，那是正常的** —— 金鑰不留在畫面上，因為這一頁
> 很可能出現在螢幕分享或截圖裡。每個欄位會改成顯示「已儲存 gsk_abcd…6789」，
> 留空就是「不動它」，要換掉某一把才需要重新貼。

| 服務 | 申請 | 必要性 |
|---|---|---|
| **GroqCloud** | <https://console.groq.com/keys> | **最重要**，沒有它逐字稿慢 8 倍、回答慢 15–40 倍 |
| NVIDIA NIM | <https://build.nvidia.com/> | 選用，Groq 撞到額度時的備援。可以填兩個帳號輪流用 |
| Tavily | <https://app.tavily.com/> | 選用，只影響「需要查網路才答得出來」的問題 |

> 🔒 **金鑰只存在你這台電腦的瀏覽器裡**（`chrome.storage.local`），
> 不會上傳、也不會進入 GitHub。這個 repo 是公開的，所以金鑰絕對不放在程式碼裡；
> `tests\check-project.ps1` 有一道檢查會掃描版控中的所有檔案，
> 發現金鑰樣式就讓測試失敗。**換一台電腦要重新貼一次。**

#### 同一組金鑰可以用在多台電腦嗎

可以。金鑰綁的是**帳號**，不是機器，直接在另一台貼上就能用。兩件事要知道：

- **額度是共用的。** 免費額度算在帳號上，所以兩台電腦分的是同一個桶：
  Groq 辨識每天 28,800 音訊秒（約 8 小時會議）、回答每天 100,000 token，
  都是兩台加起來算。一個人不太可能同時開兩場會，實務上幾乎不會撞到 ——
  真要同時跑兩台會議，才需要幫第二台另外申請帳號。
- **429 的冷卻記錄是各台各自記的**（存在記憶體裡）。A 台撞到額度後會自己
  避開那個模型，B 台不知道，要自己撞一次才學到。代價只是多一個來回。

搬金鑰**不要用 git**（那正是 `.gitignore` 擋掉它的原因）—— 用密碼管理器、
USB 或你自己的加密筆記，別貼在聊天軟體或 email 裡。

哪天某台電腦不見了或被入侵，到各家後台**重新簽發**，然後**每一台都要重貼**。
多一台機器就多一個外洩面，這是共用金鑰的代價。

**要完全離線？** 不填 Groq 金鑰就好 —— 會自動退回本機 whisper.cpp，
音訊完全不離開這台電腦，代價是慢且中文準確度較低。側邊欄會說明現在走的是哪條路。

**⚠️ Gemini Nano 有硬體門檻**：顯示記憶體要 4GB 以上、Chrome 設定檔所在磁碟要
22GB 以上可用空間、Windows 10/11、非計量網路。達不到的機器會自動把即時回答
**改走 Claude Code**（同樣免費，只是慢），不需要改設定，側邊欄會說明原因。
首次使用需在側邊欄按一次「⚡ 啟用免費模型」下載（一次性，數 GB）。

**要看得懂共享畫面**：在問答分頁勾「附上會議畫面」再提問。做法是把截圖存成 PNG，
透過橋接把**檔案路徑**交給 Claude Code，讓它用 `Read` 工具看圖
（`claude -p --allowedTools Read`）—— 影像沒有經過 API，所以不計費，
代價是多一次工具往返（實測 10–17 秒 vs 純文字 4.6 秒）。

### 語音辨識（逐字稿的來源）

逐字稿由語音辨識產生，聽的是**分頁的聲音**（所有參與者）：

| 引擎 | RTF | 延遲 | 中文品質 | 何時用 |
|---|---|---|---|---|
| **Groq `whisper-large-v3-turbo`** | **0.06** | 講完一句後約 1–2 秒 | 16.6 秒樣本**一字未錯** | 預設（有 Groq 金鑰時） |
| 本機 whisper.cpp small | 0.47 | 約 15 秒 | 大致正確 | 沒有金鑰／要完全離線 |
| 瀏覽器內 WASM base | 0.50 | 約 25 秒 | 這季／結帳／對帳／小陳 **全錯** | 最後的退路 |

說話者標註：三者都拿不到真名（那只有平台字幕有），有字幕就補真名，
否則標成「其他人（雲端辨識）」或「其他人（本機辨識）」。

#### 兩條音訊來源：其他人靠分頁，你自己靠麥克風

`tabCapture` 抓的是分頁**播放出來**的聲音，也就是其他參與者的發言。
**你自己講的話不在裡面** —— Meet 不會把你的麥克風回放給你（否則你會聽到自己的回音）。
所以少了第二條路的話，逐字稿裡永遠不會出現你說過的任何一句。

那正是回答建議最需要的上下文之一：「我剛剛才答應過什麼」「我剛講的數字是多少」。

| 來源 | 抓到誰 | 用什麼 |
|---|---|---|
| 分頁擷取（`tabCapture`） | 其他所有人 | Groq／本機 whisper |
| 麥克風 | 只有你 | 瀏覽器內建的 `SpeechRecognition`（免金鑰、免安裝） |

**兩條都是自動的，沒有開關。** 麥克風跟著「開始聆聽」一起開、一起關 ——
早期版本有一顆「🎤 我的發言」按鈕，但那等於讓一個預設就該成立的東西
變成「使用者偶爾記得按才成立」，而漏掉的後果（回答建議少了你自己的脈絡）
在當下完全看不出來。

兩邊不會重複記錄：分頁聽不到你，麥克風只聽得到你。

> 第一次會跳**麥克風權限**詢問。拒絕的話其他人的發言照常記錄，只有你自己的
> 不會進逐字稿，側邊欄會明講。要改回來就點網址列左側的圖示允許麥克風，
> 再重開側邊欄。

> **雲端辨識會把會議音訊送到 Groq 的伺服器。** 這是相對本機那條唯一的取捨，
> 側邊欄在啟動時會明講。不接受的話就別填 Groq 金鑰，會自動走本機引擎。

#### 雲端辨識的節流：合併，不是丟掉

Groq 免費方案對辨識是 **20 次/分**，所以瓶頸是「每分鐘幾次請求」而不是「算得多快」。
本機那條積壓時會**丟掉最舊的**（寧可漏也不要越落後），雲端這條**完全相反**：
把相鄰的段落**合併**成一次送出。丟掉等於白白丟掉你講的話，合併不會少一個字，
代價只是那段逐字稿晚幾秒出現。節流間隔 3.4 秒（≈17.6 次/分，留餘裕給重試），
合併上限 28 秒（超過 whisper 的 30 秒窗要多跑一輪 encoder，而且一段太長很難讀）。

> **第一次啟動要先授權。** Chrome 要求擴充功能「已被該分頁叫用過」才給音訊串流，
> 所以進會議後要**在會議分頁點一次工具列的擴充功能圖示**。沒點的話側邊欄會出現
> 明確的提示，不會安靜地不動。

#### 安裝本機引擎（選用，當退路）

有 Groq 金鑰的話這一步可以跳過 —— 但裝了才有「網路斷了／額度用完」時的退路。

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-whisper.ps1
```

下載約 260 MB 到 `%LOCALAPPDATA%\MeetingAssistant\whisper`，最後會**真的啟動一次伺服器**自我測試。只要 `small` 模型就加 `-Models small`。

擴充功能透過 bridge 把它跑成一台**只綁 `127.0.0.1:8317`** 的小伺服器（`whisper-server.exe`），音訊用 HTTP POST 送過去。伺服器由 bridge 在需要時啟動、停止擷取或 Chrome 斷線時關掉，**執行期不連任何外部伺服器，零費用**。

> ⚠️ **whisper.cpp 在 Windows 上打不開非 ASCII 路徑。** 它用窄字元 API 開檔，路徑會先被轉成系統 ANSI（正體中文機器是 CP950），`會議助手` 這種資料夾名會變成亂碼，開檔直接失敗（實測 `whisper-cli` 結束碼 9，而且錯誤訊息很容易被緩衝吃掉）。**這就是執行檔與模型不放在專案資料夾、而是裝到 `%LOCALAPPDATA%` 的原因**，安裝腳本會檢查路徑是否為純 ASCII。

沒安裝也能用：原生引擎啟動失敗時會**自動退到瀏覽器內建的 WASM 備援**（`vendor/`，約 99 MB，`tools\fetch-vendor.ps1` 下載），並在側邊欄說明原因與怎麼裝回原生的。備援比較慢也比較不準，但不會讓功能整個消失。

#### 為什麼用 small，以及為什麼分段是 12 秒

Whisper 的 encoder 不論音檔多長都跑滿 30 秒的窗，所以**每次呼叫有固定成本**，段落越短越吃虧。這台機器（i7-4720HQ、無可用 GPU）實測 RTF（處理秒數 ÷ 音檔秒數，越低越好）：

| 引擎 / 模型 | 6 秒 | 10 秒 | 12 秒 | 15 秒 | 20 秒 |
|---|---|---|---|---|---|
| 原生 small | 0.83 | 0.54 | **0.47** | 0.40 | 0.34 |
| 原生 base | 0.30 | 0.20 | 0.17 | 0.15 | 0.13 |
| WASM base（備援） | — | — | — | 0.50（16.6 秒） | 0.55（31.7 秒） |

**中文準確度的差距遠大於速度差距。** 同一段測試音訊：

```
base ：我先講一下這技的目標、節障失敗率、目前假在第三方對障、小晨
small：我先講一下這季的目標、結帳失敗率、目前卡在第三方對帳、小陳
```

`base` 把「這季／結帳／對帳／小陳」全聽錯，`small` 全對。而**原生 small（0.47）還比瀏覽器內建的 base（0.50）更快** —— 等於用同樣的效能預算換到一個真正堪用的中文辨識。這也是為什麼不用 `tiny`：它更快，但實測把「小陳」聽成「小春」，而自動回答整個功能都建立在「逐字稿裡出現我的名字」上。

選 12 秒是折衷：RTF 0.47 留了兩倍餘裕，延遲約 18 秒。開會時 CPU 被視訊佔用會讓 RTF 上升，所以**連續落後三次就自動把分段拉長 4 秒**（上限 30 秒，再長就超過 whisper 的窗要多跑一輪 encoder）—— 跟不上的正確反應是加長而不是縮短。

#### 簡體→繁體是用字表轉的，不是用提示詞

`small` 的中文比 `base` 準，但**輸出簡體**。直覺做法是在 initial prompt 裡要求繁體，實測**那樣做是負面的**：

| 做法 | 輸出 |
|---|---|
| 不給 prompt | 我先讲一下这季的目标，结账失败率…第三方**对账** ✅ |
| 繁體 prompt | 我先講一下這季的目標，結帳失敗率…第三方**對象** ❌ |

換到腳本對、內容錯，不划算。所以辨識時不給 prompt（讓模型專心聽），輸出後由 `src/lib/s2t.js` 做確定性的字表轉換（OpenCC 的 STCharacters / STPhrases / TWVariants，`tools\gen-s2t.ps1` 產生）。

字表另外做了三個台灣用字修正，都是實測會議句子踩到的：**臺→台**（台北不寫成臺北）、**賬→帳**（結帳／對帳，OpenCC 的標準繁體給的是結賬）、**佈→布**（教育部標準用「布」）。轉換是冪等的，所以已經是繁體的字幕來源走同一條路也不會被弄壞。

> 順帶一個踩過的坑：**Chinese `--prompt` 走命令列會被 CP950 弄壞**，壞掉的 prompt 會讓解碼器整段崩掉 —— 15 秒與 20 秒的音檔曾經只吐出「MUQ」三個字。要下 prompt 就得走 HTTP 表單（UTF-8）。

#### 其他行為

**進到會議就開始聽，不等字幕。** 早期版本要連續 45 秒抓不到字幕才啟動本機辨識，
理由是「使用者可能只是還沒按 CC」。實測後拿掉了：等字幕反而讓逐字稿一直是殘缺的，
而字幕本來就不再是逐字稿的來源。

**逐字稿照「說話時間」排序，不是照抵達順序。** 不同來源的延遲差很多，照抵達順序排會讓早講的話排在晚講的**後面** —— 不只難讀，送去做摘要的對話順序也是錯的，模型會誤判誰在回應誰。所以 offscreen 回報的是「這段話被說出來的時間」（由分段長度反推），`store.upsertSegment` 依它插入。

**已知的取捨**：拿不到真實姓名（只有平台字幕有）。沒開字幕時全部標成「其他人（本機辨識）」，開了字幕才會用說話時間比對補上真名。RTF 是機器閒置時量的，開會時 CPU 被視訊佔用可能跟不上 —— 跟不上時會略過片段、拉長分段，並在側邊欄明確告知，而不是安靜地爛掉。

### 安裝 Claude Code 橋接（選用）

```powershell
# 擴充功能 ID 在 chrome://extensions 開啟開發人員模式後，卡片上會顯示
powershell -ExecutionPolicy Bypass -File bridge\install.ps1 -ExtensionId <你的擴充功能ID>
```

腳本會自動找出 VSCode 裡的 `claude.exe`、產生 `manifest.json` 與 `config.json`、在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\` 註冊主機（只影響目前使用者，不需管理員權限），最後**實際呼叫一次 Claude Code 自我測試**。移除：加上 `-Uninstall`。

> **改 `bridge/` 裡的檔案時有兩個編碼地雷**，兩個都會讓橋接以難懂的方式壞掉：
> - `host.bat` **必須是 CRLF 換行**。cmd.exe 讀 LF-only 批次檔會把指令 token 切錯，症狀是 `powershell.exe` 被拆成 `powershell.` 與 `exe`，主機一啟動就死。
> - `.ps1` **必須存成含 BOM 的 UTF-8**。Windows PowerShell 5.1 會把無 BOM 的檔案當 Big5 解碼，中文字串的位元組會吃掉後面的引號，報出對不上的括號錯誤（`MissingEndCurlyBrace`），而且指的行號跟真正的問題無關。
>
> 另外，**測試 Native Messaging 時不要用預設的 `Console.InputEncoding`**：它可能帶 BOM preamble，.NET 建立 `StandardInput` 的 StreamWriter 時會把那 3 個 byte 寫進管線，長度前綴整個位移，主機判定協定不同步後靜靜結束 —— 看起來像「主機沒回應」，其實橋接是好的。測試前先設 `[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)`。

裝好就生效，不必到設定頁選什麼 —— 後端是寫死的。

---

## 安裝

1. 開啟 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」，選擇這個資料夾 `d:\Claude\會議助手`
4. **到設定頁貼上 Groq 的 API 金鑰**（<https://console.groq.com/keys>，免費、不需信用卡），
   按「測試」確認，再按頁面最下面的「儲存設定」。這一步影響最大 ——
   沒有它逐字稿慢 8 倍、回答從 1 秒變成 10–30 秒
5. 同一頁填「我的名字／稱呼」與「背景筆記」——這兩項直接決定回答建議的品質

以上就能用了。下面兩個安裝腳本是**選用的退路**，裝了才有「網路斷了／額度用完」時的備援：

```powershell
# ① Claude Code 橋接（雲端不可用時的摘要與回答退路，也負責啟動本機辨識伺服器）
#    擴充功能 ID 在 chrome://extensions 的卡片上
powershell -ExecutionPolicy Bypass -File bridge\install.ps1 -ExtensionId <你的擴充功能ID>

# ② 本機語音辨識（雲端不可用時的逐字稿退路，約 260 MB）
powershell -ExecutionPolicy Bypass -File tools\install-whisper.ps1
```

**完全不想用雲端？** 跳過第 4 步，只跑上面兩個腳本 —— 一切都在本機執行，
音訊不離開這台電腦，代價是慢且中文準確度較低。側邊欄會說明現在走的是哪條路。

### 換一台電腦：從 clone 到能用

前提：**Windows**、已安裝並登入 **Claude Code**、有 **Chrome 或 Edge**。

```powershell
git clone https://github.com/hj110b13-Andy/Meeting-Assistant.git
cd Meeting-Assistant

# ① 本機語音辨識（沒有字幕的會議才用得到，但建議先裝，約 260 MB）
powershell -ExecutionPolicy Bypass -File tools\install-whisper.ps1
```

**② 載入擴充功能**：`chrome://extensions` → 右上角開啟「開發人員模式」→「載入未封裝項目」→ 選剛 clone 下來的資料夾 → **把卡片上顯示的擴充功能 ID 抄下來**。

```powershell
# ③ 註冊 Claude Code 橋接（摘要與問答要用；ID 就是上一步抄的）
powershell -ExecutionPolicy Bypass -File bridge\install.ps1 -ExtensionId <剛抄的ID>
```

**④ 設定頁一次填完**：「API 金鑰」至少貼上 **Groq** 那一把（按旁邊的「測試」確認），再填「我的名字／稱呼」與「我的背景筆記」，最後按頁面最下面的**「儲存設定」——只有這一顆，它存整頁的內容**。金鑰這一步影響最大：沒有它逐字稿慢 8 倍、回答從 1 秒變成 10–30 秒。名字空白的話自動回答幾乎不會觸發。金鑰不在 git 裡（這個 repo 是公開的），所以每一台都要自己貼。

順序不能顛倒：**③ 一定要在 ② 之後**，因為擴充功能 ID 要先載入才拿得到。

#### 為什麼這幾步不能省

| 東西 | 為什麼不跟著 git 走 |
|---|---|
| **API 金鑰** | **這個 repo 是公開的。** 金鑰推上去一次就等於外洩 —— 就算之後 commit 刪掉，GitHub 仍保留那個 blob，掃描機器人幾分鐘內就會撿走，只能重新簽發。所以金鑰只存在該台瀏覽器的 `chrome.storage.local` |
| `bridge/config.json`、`bridge/manifest.json` | 帶著該台電腦上 `claude.exe` 的絕對路徑與擴充功能 ID。**擴充功能 ID 由資料夾路徑決定**，換一台就變，所以只能各自產生 |
| 原生語音辨識（約 260 MB） | 裝在該台的 `%LOCALAPPDATA%\MeetingAssistant\whisper`。**必須是純 ASCII 路徑**，見上方 whisper.cpp 的說明 |
| `vendor/`（99 MB） | WASM 備援引擎，沒進版控。裝了原生的就用不到；真的要的話跑 `tools\fetch-vendor.ps1` |
| 「我的名字」「背景筆記」等設定 | 存在該台瀏覽器的 `chrome.storage.local` |

沒裝任何語音引擎也不會壞 —— 只是遇到沒有字幕的會議時，「聽會議聲音」會失敗並在側邊欄說明原因。字幕、逐字稿、摘要、問答都不受影響。

**作業系統限制**：擴充功能核心（字幕擷取、逐字稿、摘要、問答）跨平台；但**橋接與本機語音辨識目前只支援 Windows**，因為安裝腳本是 PowerShell、原生辨識用的是 Windows 版 whisper.cpp。macOS／Linux 上只有 Chrome 內建模型可用（即時回答），摘要與本機辨識需要移植安裝腳本。

### 在另一台電腦上改這個專案

```powershell
git pull --rebase        # ① 開工前先把另一台的變更接下來

# ② 確認基準是綠的（別在壞掉的基礎上改）
powershell -ExecutionPolicy Bypass -File tests\run.ps1
powershell -ExecutionPolicy Bypass -File tests\check-project.ps1

# ……改程式……

# ③ 改完兩個都要再跑一次，全綠才推
powershell -ExecutionPolicy Bypass -File tests\run.ps1
powershell -ExecutionPolicy Bypass -File tests\check-project.ps1

git pull --rebase        # ④ 再拉一次，萬一這期間另一台又推了
git add -A
git commit -m "說明改了什麼、以及為什麼"
git push
```

動到雲端請求形狀（`cloud.js`、`tavily.js`、`offscreen.js` 的 `groqTranscribe`）時，還要多跑一支：

```powershell
powershell -ExecutionPolicy Bypass -File tests\run-cloud-check.ps1
```

它用**真金鑰打真 API**（讀根目錄的 `API Key.txt`，或環境變數 `GROQ_API_KEY` 等）。
這跟上面兩支驗的是**不同的事** —— 請求形狀寫錯時 stub 照樣會回應，
只有真的打過去才會被拒。因為需要網路與金鑰、而且會消耗免費額度，所以不放進 `run.ps1`。

`check-project.ps1` 特別重要：它抓的是**測試跑得過、但擴充功能根本載不進去**的那類問題（少了 UTF-8 BOM、`.bat` 變成 LF、底線開頭的檔名、埠號對不上、manifest 少了新端點的 host permission）。這些在 Windows 上很容易不小心引入，而症狀都不會指向真正的原因。它同時是**金鑰外洩的最後一道防線**：會掃描所有 git 追蹤中的檔案，發現金鑰樣式就直接讓測試失敗。

專案的慣例與地雷寫在 **[`CLAUDE.md`](CLAUDE.md)** —— Claude Code 會自動讀那個檔案，所以在任何一台電腦上開始工作前不必特別交代。

#### 為什麼要 `git pull --rebase`

兩台電腦輪流改同一個 repo 時，遲早會遇到 push 被拒絕：

```
! [rejected]  main -> main (fetch first)
```

意思是**遠端有你手上沒有的 commit**。push 只做「快轉」，硬推等於把那個 commit 從歷史上抹掉，所以 git 一律擋下來要你先看過。這是保護機制，不是錯誤。

```
兩台都從 c848b9d 開始

A 電腦：改 panel.js  → 推成功    遠端變成 c848b9d → A1
B 電腦：改 store.js  → 想推      但 B 手上還停在 c848b9d
                                 ✗ rejected（B 沒有 A1）
```

`git pull --rebase` 把遠端的 commit 拿下來，再把**你的** commit 重新接到最新的後面：

```
之前：  c848b9d ──> A1        （遠端）
        c848b9d ──> B1        （你手上）

之後：  c848b9d ──> A1 ──> B1'
                          ↑ 內容一樣，只是基準點換了
```

變成一條直線就能推了。

不加 `--rebase` 的 `git pull` 是「合併」，也能解決，但會多一個合併 commit、歷史有分岔。**日常兩台同步建議用 `--rebase`**，歷史比較好讀。（本專案第一次推送時用的是合併，因為那時本地與 GitHub 自動產生的 initial commit 完全沒有共同祖先，rebase 反而彆扭。）

#### 如果兩台改到同一行

rebase 會停下來，衝突的檔案裡會出現：

```
<<<<<<< HEAD
（另一台的版本）
=======
（你的版本）
>>>>>>>
```

把檔案編輯成你要的樣子（連那三行標記一起刪掉），然後：

```powershell
git add <那個檔案>
git rebase --continue
```

想整個放棄回到原狀：`git rebase --abort`。

只有**兩邊動到同一個檔案的同一段**才會衝突。一台改 `panel.js`、一台改 `store.js` 是不會撞的。

## 使用

1. 進入 Google Meet / Teams / Jitsi 會議
2. **在會議分頁點一次工具列的擴充功能圖示**（授權音訊擷取，每個分頁一次）
3. 側邊欄會自動開始聆聽，約 15 秒後逐字稿開始出現

就這樣，不需要按任何開始按鈕。想要說話者顯示**真實姓名**的話，額外在會議裡
開啟字幕（Meet 的 **CC** 按鈕 / Teams 的「更多 → 語言和語音 → 開啟即時字幕」）——
字幕只用來補姓名，不影響逐字稿內容。

側邊欄左上圓點：🟢 聆聽中 ／ 🟡 正在啟動 ／ ⚪ 沒偵測到會議

側邊欄三個分頁：

| 分頁 | 內容 |
|---|---|
| **逐字稿** | 即時逐字稿，最下方灰色斜體是還沒定稿的當前發言。可搜尋、可關閉自動捲動。 |
| **重點** | 自動更新需要**兩個條件同時成立**：累積至少 N 段發言**且**距上次至少 M 秒（預設 8 段 / 300 秒，可在設定頁調整）。 |
| **問答** | 自動偵測的提問 + 你手動輸入的問題。每張卡片可一鍵複製。 |

**⬇ 匯出** 會把整份 Markdown（含摘要與逐字稿）複製到剪貼簿，並下載一份 `.md` 備份
（UTF-8 with BOM，Windows 的記事本與 Excel 都能正確開啟中文）。

### 設定頁

只有三組欄位：

| 欄位 | 說明 |
|---|---|
| **我的名字／稱呼** | **一定要填。** 別人講到這些名字時才會自動準備回答建議。多寫幾種叫法（全名、綽號、英文名）比較不會漏。 |
| **我的背景筆記** | 回答建議會參考。寫得越具體越能直接照唸。不要放密碼或金鑰。 |
| **摘要更新頻率** | 段數與秒數，兩個條件都成立才更新。預設 8 段 / 300 秒。 |

摘要頻率的兩個數字是 **AND**：秒數是真正的節流上限（設 300 就是最多每 5 分鐘一次，
即使累積了 50 段也會等到時間到），段數則避免冷場時為兩句話白跑一次。
**秒數設太小會很快吃掉 Claude Pro 的用量額度**（每次摘要都是一個完整的 CLI session），
建議不要低於 180。

「進階」摺疊區裡還有本機辨識的安裝檢查與自架 Jitsi 網域，通常不用動。

## 運作方式

```
Meet / Teams 分頁
   └─ content script（core.js + meet.js / teams.js）
        讀取字幕 DOM → 合併串流文字 → 判斷「這句講完了」
             │  ma:segment 訊息
             ▼
   service worker（背景）
        ├─ store.js      逐字稿狀態 + chrome.storage.local 備份
        ├─ 摘要排程       累積式更新（只送新增的逐字稿，不重送整場）
        └─ 提問偵測       中英文問句 + 是否點到你的名字 → 產生回答建議
             │  port 廣播
             ▼
   側邊欄 UI（panel.js）
```

### 為什麼聽聲音，而不是讀字幕

**這個決定在真實會議實測後反過來了。** 原本的設計是「字幕優先」，理由很合理：
平台字幕自帶真實姓名、延遲低、不花錢。但實測一場 Meet 會議的結果是：

- 字幕**斷斷續續**，常常整段抓不到
- `heuristicRoot` 的門檻有 bug（見下），失敗時抓到的是 Meet 的**介面文字** ——
  鍵盤快速鍵提示、Gemini 橫幅、`arrow_drop_down`，整份逐字稿是同一句重複二十次

而同一時期的離線驗證裡，本機 whisper small 把整段中文（含「小陳」這種人名）
完整辨識正確。查了其他會議工具也是同樣結論：Meeting Ink 錄分頁音訊、
SeaMeet 派機器人進會議拿音訊流、開源的 Meetily / Whishper / WhisperX 全部走
本機 Whisper —— **沒有一個是靠讀字幕 DOM 的**。它們品質好不是因為選擇器寫得好，
而是根本繞過了字幕這條路。

所以現在：**音訊是逐字稿的唯一來源，字幕退成「誰在講話」的資料源。**
音訊段落落在某則字幕的時間附近（±20 秒）時，就借用那則字幕的說話者姓名。

但**音訊沒在跑的時候字幕仍然會收** —— `tabCapture` 需要使用者先在會議分頁點過
擴充功能圖示，這步很容易漏掉，那時丟掉字幕等於整個功能靜靜失效。
有殘缺的逐字稿仍然勝過空白。

### 串流字幕的合併邏輯

字幕不是一行一行新增的，而是**同一個 DOM 節點的文字被反覆改寫**：`你好` → `你好，我是` → `你好，我是小陳`，長句還會出現只保留後半段的視窗滑動。`core.js` 的 `mergeCaption()` 用「最長重疊」把新片段接到既有文字尾端，避免重複與漏字；文字停止變動 2.2 秒後視為講完，寫入逐字稿。

### DOM 選擇器改版

Meet 與 Teams 的字幕 DOM 都不是公開 API，名字每隔幾個月換一批。策略是**不要把雜湊名字當主力**：

- **Meet**：第一順位是 `[role="region"][aria-label*="Captions"]` —— 那是無障礙需求，改版不會拿掉；雜湊 class（`.a4cQT`、`.nMcdL`、`.NWpY1d`、`.ygicle.VbkSUe`）排在後面當補強。全部失效時還有 `structuralParse()`：一則字幕的結構是「頭像 `<img>` ＋ 說話者（第一個 `<span>`）＋ 內容（最後一個非圖片 `<div>`）」，不依賴任何名字。
- **Teams**：`data-tid` 比 Meet 的 class 穩，但也換過好幾次（`closed-caption-window` → `closed-caption-v2-window` → `…-wrapper`）。所以清單最後留一條 `[data-tid*="closed-caption"]` 的網接住未來的新名字。另外 Teams 的字幕是**虛擬列表，DOM 節點會被回收**去裝別句話 —— 它有 `data-caption-id`，透過 `adapter.stableKey()` 拿來當 key，比用節點身分再靠文字重疊去猜可靠得多。

這幾條的實際名字是對照兩個持續維護的開源專案確認的（見下方參考），不是憑印象寫的。測試裡有「已知名字全部失效」的情境，因為那才是真正會發生的失敗模式。

若某天完全抓不到，`ROOT_SELECTORS` / `ENTRY_SELECTORS` / `NAME_SELECTORS` / `TEXT_SELECTORS` 就是要更新的地方。最壞情況也只是退到本機語音辨識（失去真實姓名），不是整個功能消失。

參考：
- Teams 選擇器 — [Zerg00s/Live-Captions-Saver](https://github.com/Zerg00s/Live-Captions-Saver)（`teams-captions-saver/content_script.js` 的 `SELECTORS`）
- Meet 的語意選擇器策略 — [S Anand, *Google Meet Captions as a Local Transcript Recorder*](https://www.s-anand.net/blog/google-meet-captions-local-transcript-recorder/)

### 各個後端的用法

**雲端（主力）** —— Groq 與 NVIDIA NIM，兩家都是 OpenAI 相容的介面：

- 一條**候選鏈**，前面失敗（429／5xx／逾時）就換下一個。全部失敗才丟
  `CloudUnavailable`，由 `provider.js` 決定要不要退回 Claude Code ——
  **而且退了一定會在側邊欄講出來**（0.7 秒變成 10–30 秒，不講的話
  使用者只會覺得「今天特別慢」，然後去懷疑自己的網路）
- 撞到 429 會**記住冷卻時間**（優先用伺服器給的 `Retry-After`，沒給就 60 秒）。
  不記的話下一次呼叫又會從鏈的最前面開始撞，每次都白花一個來回
- NVIDIA 的兩把金鑰**輪流用**（額度綁帳號），把「單一帳號撞上限」往後推
- 即時回答走 **SSE 串流**：被點名時「開始看到字」比「拿到完整答案」重要得多
- 推理模型的 `<think>` 段落會被切掉（`gpt-oss`、`qwen` 會吐）。沒切的話
  側邊欄會顯示一大段英文思考過程，使用者得自己在裡面找答案
- **回傳形狀刻意跟 `ccComplete` 一致**（`{ text, stopReason }`），
  因為退回橋接時是把**同一個 opts** 直接交過去 —— 形狀不一樣的話
  那個退路是壞的，而且只有在雲端失敗的時候才會被發現

**Claude Code 橋接（最後的退路）** —— 透過 Native Messaging 呼叫本機 `claude.exe`：

- 用 `claude -p`（print 模式）一次問一次答，每次呼叫都是一個完整的 CLI session
- **不用 JSON schema**：CLI 不保證結構化輸出，改成要求固定前綴的純文字
  （`主題: / 重點: / 決議: / 待辦: 負責人|事項 / 問題:`）再自己解析
- 附畫面時多帶 `--allowedTools Read` 與截圖的絕對路徑，讓它讀檔看圖

**Chrome 內建模型（即時回答）** —— `LanguageModel` API，跑在側邊欄：

- service worker 沒有 `LanguageModel`，所以推論**委派給側邊欄執行**，
  背景只負責把請求送過去、把串流結果收回來
- context 只有幾千 token，塞整場逐字稿會被截斷，所以 `provider.js` 的
  `BUDGET` 幫每個後端各自設了逐字稿字數上限（Nano 1500/2500、Claude Code 6000/12000、
  雲端 8000/16000）。雲端那個上限**不是模型的極限**（llama-3.3-70b 有 128k），
  是「不要在一場會議裡把一整天的 token 額度花光」
- 側邊欄關著就沒地方跑 —— 那時即時回答會安靜跳過，不噴錯誤

摘要是**累積式更新**：每次只把「新增的逐字稿」送給模型，不重送整場，
成本大致與會議長度成線性而非平方。

---

## 已知限制

1. **要先在會議分頁點一次擴充功能圖示。** Chrome 的 `tabCapture` 要求擴充功能
   「已被該分頁叫用過」才給音訊串流，否則會失敗並顯示
   *Extension has not been invoked for the current page*。側邊欄會給出可行動的說明，
   但這一步無法自動化 —— 那是 Chrome 的權限設計。

2. **語音辨識拿不到姓名。** 三個引擎都一樣 —— 姓名只有平台字幕有，
   所以沒開字幕時說話者只能標「其他人（雲端辨識）」或「其他人（本機辨識）」。
   雲端辨識延遲約 1–2 秒；退到本機時約 15 秒，而且開會時 CPU 被視訊佔用可能跟不上，
   此時會略過片段並告知。
   本機原生引擎有兩個外部條件：要跑過 `tools\install-whisper.ps1`，而且**要跑過
   `bridge\install.ps1`** —— 伺服器是由 bridge 啟動的，擴充功能自己不能執行本機程序。
   兩者缺一就會退到 WASM 備援（會明確告知）。

3. **雲端辨識會把會議音訊送到 Groq 的伺服器。** 這是它比本機快 8 倍、準得多的代價。
   不接受的話不要填 Groq 金鑰，就會自動走完全離線的本機引擎。
   免費額度也有上限（28,800 音訊秒/天 ≈ 8 小時會議），用完會退回本機並說明。

4. **退到本機時中文準確度會明顯下降。** 主力（Groq `whisper-large-v3-turbo`）
   實測 16.6 秒樣本一字未錯；退到本機 `small` 只是「大致正確」，
   再退到 WASM `base` 則會把「這季／結帳／對帳／小陳」全聽錯。
   摘要與回答建議吃的是逐字稿，**錯一個關鍵詞整段推論就歪了** ——
   所以側邊欄在退路上會明講現在用的是哪一個引擎。

5. **免費模型有硬性能力上限。** Chrome 內建的 Gemini Nano 的 context 只有幾千 token
   （所以回答只帶最近約 1500 字逐字稿）、**不支援圖片**，中文判斷品質與 Claude 有明顯差距。
   看不懂圖片這件事是用**升級**處理的，不是降級：勾了「附上會議畫面」時**那一題會自動
   改走 Claude Code**（`stream({ provider })` 蓋掉預設判斷），並在卡片上說明換了後端。

6. **免費模型跑在側邊欄，不是背景。** 因為首次下載必須由使用者手勢觸發，
   而 service worker 沒有手勢。實務影響：**側邊欄關著時即時回答會安靜跳過**
   （不會噴錯）。摘要走 Claude Code，不受這個限制。

7. **本機推論會吃資源，而且不是每台機器跑得動。** whisper small 常駐約 400 MB，
   8GB RAM 的機器上 Meet 開視訊本身就佔 1–2GB，疊起來可能造成頓挫。
   Gemini Nano 要求 4GB 以上顯示記憶體與 22GB 以上可用磁碟（例：GTX 960M 只有
   2GB VRAM 就直接不符），此時 `resolveProvider` 會把即時回答改判給 Claude Code ——
   於是那台機器上**唯一的回答路線也變成 10–30 秒**。

8. **Claude Code 橋接會吃 Pro 的用量額度，而且不便宜。** 它每次呼叫都是一個完整的
   Claude Code session，帶著 CLI 自己的系統提示，所以單次消耗遠大於同樣內容的 API 呼叫。
   **摘要間隔設太短會很快撞到 Pro 的用量上限**，預設 5 分鐘，建議不要低於 3 分鐘。
   另外要知道：Claude Code 是開發工具，把它當成應用程式的後端並不是它的設計用途 ——
   個人自用可行，但它比 API 脆弱（CLI 更新可能改變輸出格式），也沒有服務等級保證。

9. **橋接綁定擴充功能 ID。** 未封裝擴充功能的 ID 由資料夾路徑決定，
   **搬動資料夾會讓 ID 改變**，橋接就會失效，要重新跑一次 `install.ps1`。

10. **自動回答只在「有人點名你」時觸發**，避免每個問句都燒額度。判斷依據是設定裡的
   「我的名字」，或「請問／想請／你覺得／你認為／你這邊／麻煩你／交給你／由你」
   這類直接稱呼。**名字沒填的話自動回答等於沒作用** —— 想針對任何問題都拿建議，
   就手動在問答分頁輸入。

11. **字幕選擇器仍然脆弱。** Meet 的 DOM 每幾個月改一次，實測就遇過整組失效。
    現在字幕只影響「說話者姓名」，失效不會讓逐字稿消失，但真名會變回
    「其他人（本機辨識）」。

## 測試

```
powershell -ExecutionPolicy Bypass -File tests\run.ps1            # 行為測試（256 項）
powershell -ExecutionPolicy Bypass -File tests\check-project.ps1  # 專案一致性（52 項）
```

`check-project.ps1` 抓的是「行為測試跑得過、但東西還是壞的」那一類問題：`.ps1` 有沒有 UTF-8 BOM、`host.bat` 是不是 CRLF、`manifest.json` 提到的檔案存不存在、**橋接與擴充功能用的埠號有沒有對上**（不對上時 `fetch` 只會說 `Failed to fetch`）、`offscreen.html` 的腳本載入順序、以及 `src/` 下每個 `.js` 的語法。

這個專案沒有 Node/npm，所以直接把 **Chrome 當測試執行環境**：每個測試頁把 `chrome.*` API 換成 stub，載入**真正的原始碼**（不是複本），再用 `--headless --dump-dom` 把結果讀回來。目前 **324 項行為測試 + 61 項專案檢查**，分六組：

| 測試組 | 內容 |
|---|---|
| 字幕擷取引擎 | 用合成的 Meet / Teams / Jitsi 字幕 DOM 驅動引擎：串流改寫合併、視窗滑動、定稿時機、換人講話、節點重用，以及**已知選擇器全部失效時的退路**（Meet 靠 `role="region"`＋結構、Teams 靠 `data-tid*=` 與 `data-caption-id`） |
| 逐字稿狀態 | 定稿去重、partial 生命週期、重整分頁不清空、換會議要清空、**照說話時間插入**、摘要排程（AND 門檻與失敗退避）、Markdown 匯出 |
| 側邊欄 UI | 載入**真正的** `panel.html` + `panel.js`，餵一份逼真的 state，檢查逐字稿／重點／問答三個分頁、搜尋高亮、串流增量、未讀徽章、錯誤橫幅、無字幕等待期 |
| 背景邏輯 | 把 `fetch` 與 Native Messaging 換成 stub：提問偵測、SSE 串流解析（含事件被切在 chunk 邊界）、請求形狀、結構化摘要、錯誤中文化、附畫面時的後端升級、**原生辨識啟動失敗自動退到 WASM**、設定遷移、**雲端候選鏈與 429 退避**、**金鑰遮罩與貼錯欄位偵測**、**沒有金鑰時不解析成雲端**、Tavily 的查證判斷 |
| 音訊處理 | 重疊去重、靜音門檻、降取樣、**WAV 編碼**、本機跟不上時丟最舊的、**雲端積壓時改成合併而不是丟棄**、兩種引擎的 HTTP 請求形狀、額度／金鑰錯誤的訊息可讀性 |
| 簡繁轉換 | 實測會議句子、一對多字（发→發／髮、干→乾／幹）、台灣用字、繁體輸入不被弄壞、冪等性、邊界 |

引擎測試把 `setInterval` 和 `Date.now` 換成可控的假時鐘，所以整個擷取流程是**同步、確定性**地跑完，不靠 sleep 等待。

**這些測試證明什麼、不證明什麼**：合成 DOM 驗證的是「選擇器與引擎邏輯自洽」，**不能**證明真實的 Meet DOM 長得跟合成的一樣 —— 那只有真實會議能驗證。同理，`fetch` 是 stub，所以驗證的是「請求形狀正確、回應處理正確」，不是伺服器真的會回什麼。

**雲端那條有一份真的端對端驗證**（`tests\run-cloud-check.ps1`，不在 `run.ps1` 裡，因為需要金鑰、網路，而且會消耗免費額度）：用**真金鑰打真 API**，驗證回答／摘要／串流／語音辨識四條路都通、回來的是繁體中文、摘要與回答真的用不同模型、串流真的是逐塊送達、以及**壞金鑰會回 401 而不是安靜失敗**。語音辨識那一項用的是專案裡那段 16.6 秒的真實中文錄音，斷言「這季／結帳／對帳／小陳」四個詞都要聽對 —— 那正是本機 `base` 模型全部聽錯的四個詞。這跟上面的 stub 測試驗的是不同的事：請求形狀寫錯時 stub 照樣會回應，只有真的打過去才會被拒。

**本機辨識另外有一份真的端對端驗證**（同樣不在 `run.ps1` 裡，因為它需要真的裝好 whisper.cpp）：實際啟動 `bridge\host.bat`、走真正的 Native Messaging 協定發 `sttStart`、確認伺服器真的在 8317 監聽、用真實瀏覽器把一段 12 秒音訊經 `toWavBlob` 編碼後 POST 到 `/inference`、驗證回來的文字經 `s2t.js` 轉成繁體，最後確認 `sttStop` 與「Chrome 斷線」都會真的把伺服器收掉。這一段驗證的是單元測試碰不到的部分：WAV 編碼器產出的檔案 whisper-server 真的讀得懂、以及伺服器不會變成 400 MB 的常駐幽靈。

`tests\.tmp\` 是執行時產生的暫存目錄，可以隨時刪除。

## 檔案結構

```
manifest.json                 MV3 設定
src/content/core.js           字幕擷取引擎（平台無關）：合併、定稿、回報
src/content/meet.js           Google Meet 選擇器
src/content/teams.js          Teams 選擇器
src/content/jitsi.js          Jitsi Meet 選擇器 + 「名字: 內容」切分
src/offscreen/offscreen.js    音訊擷取 + VAD 切段 + 三個引擎的排程（含雲端節流與合併）
src/offscreen/whisper-worker.js  WASM 備援引擎（跑在 Worker，主執行緒才收得到音訊）
src/lib/s2t.js                簡體→繁體轉換（本機辨識輸出用）
src/lib/s2t-table.js          對照表（自動產生，勿手改）
tools/install-whisper.ps1     安裝原生 whisper.cpp 到 %LOCALAPPDATA%（純 ASCII 路徑）
tools/gen-s2t.ps1             從 OpenCC 字典產生 s2t-table.js
tools/.opencc/                OpenCC 原始字典的快取（可刪，刪了會重新下載）
vendor/                       WASM 備援用的 whisper-base 模型與 ONNX Runtime（約 99MB）
tools/fetch-vendor.ps1        下載 vendor/ 的內容
tests/run-vendor-check.ps1    封鎖 DNS 驗證離線可用
src/background/service-worker.js  訊息路由、摘要排程、提問偵測、問答、存檔
src/background/store.js       逐字稿狀態、照說話時間插入、持久化、Markdown 匯出
src/background/settings.js    設定的單一來源 + 後端自動判定 + 一次性遷移
src/background/provider.js    模型後端切換層（雲端 / Claude Code / Chrome 內建，都免費）
src/background/keys.js        雲端金鑰的儲存、遮罩、貼錯欄位偵測（與 settings 分開存）
src/background/cloud.js       Groq／NVIDIA NIM 用戶端：候選鏈、雙帳號輪替、429 冷卻、SSE 串流
src/background/tavily.js      網路查證（只在問題指向會議之外時才呼叫）
src/background/localmodel.js  Chrome 內建模型：把推論委派給側邊欄
src/background/claudecode.js  Claude Code 後端（Native Messaging，用 Pro 額度）
src/background/whisper-native.js  原生辨識伺服器的啟動與生命週期（另開一條 native 連線）
bridge/host.ps1               Native Messaging 主機（stdio 協定、呼叫 claude.exe、管辨識伺服器）
bridge/install.ps1            註冊橋接 + 自我測試（-Uninstall 可移除）
src/sidepanel/                側邊欄 UI
src/options/                  設定頁
tests/run.ps1                 測試執行器（用 headless Chrome 跑）
tests/check-project.ps1       專案一致性檢查（編碼、manifest、埠號、JS 語法、金鑰外洩）
tests/run-cloud-check.ps1     雲端端到端驗證（真金鑰打真 API，選用）
tests/*.test.html             六組測試頁
API Key.txt                   你自己的金鑰備忘（已被 .gitignore 擋住，不會進版控）
```

> **擴充功能資料夾裡不能有底線開頭的檔名或資料夾。** Chrome 保留 `_` 開頭給自己用（`_metadata`、`_locales`），
> 遇到就整個拒絕載入，錯誤是 *Cannot load extension with file or directory name X. Filenames starting with "_" are reserved for use by the system.*
> 這會擋掉**整個**擴充功能，不只是那個資料夾。放暫存檔時要避開這個字首。
>
> 另外 `d:\Claude\zz-whisper-delete-after-reboot\` 如果還在，重開機後可以直接刪掉（約 53 MB）。
> 那是把 whisper.cpp 誤裝在專案裡（中文路徑）時留下的殘骸 —— 當時有兩個 `whisper-server` / `whisper-cli`
> 程序卡在 OpenBLAS 的執行緒收尾而無法終止，連 `taskkill /F` 都殺不掉，把 DLL 鎖住了。已經搬出專案，不影響載入。

### 為什麼原生辨識另開一條 Native Messaging 連線

`host.ps1` 是單執行緒、循序處理訊息的。如果和 Claude Code 共用同一條連線，「啟動辨識伺服器」就會排在一個跑了 30 秒的 Claude Code 呼叫後面（反之亦然）。Chrome 會為每個 `connectNative` 各開一個主機程序，所以分成兩條就互不阻塞。

順帶一個好處：**連線開著就等於「伺服器該活著」**。`host.ps1` 的 `finally` 在 stdin 關閉時把伺服器一起收掉，所以停止擷取或關閉瀏覽器時，`small` 模型那 400 MB 記憶體會自動還回來。主機被硬殺時 `finally` 不會執行，那時靠 pid 檔在下次啟動時清掉殘留的程序。

**音訊不走這條管道** —— Native Messaging 單則訊息只有 1 MB，12 秒的 16 kHz 音訊 base64 之後就快滿了。音訊是由 offscreen 直接 HTTP POST 到 `127.0.0.1:8317`，這也是 `manifest.json` 需要 `http://127.0.0.1:8317/*` 這個 host permission 的原因。

## 除錯

- **側邊欄空白／沒反應**：`chrome://extensions` → 這個擴充功能 → 點「Service Worker」看背景 console
- **抓不到字幕**：在會議分頁按 F12，看 console 有無錯誤；確認字幕真的開了；Teams 的會議在 iframe 裡，manifest 已設 `all_frames: true`
- **摘要／問答沒出現**：側邊欄上方紅色橫幅會顯示 API 錯誤原因（金鑰、額度、模型名稱）
- 改完程式碼後要在 `chrome://extensions` 按 ↻ 重新載入，content script 的改動還需要重新整理會議分頁
