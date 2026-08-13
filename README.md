# 會議助手 — 即時逐字稿與重點

> 📖 **[操作手冊](https://claude.ai/code/artifact/21e99519-120e-4314-99e3-7d431700c5cd)** —— 側邊欄每顆按鈕的逐一說明、四種模式的使用情境、費用估算與疑難排解。
> 這份 README 講的是「怎麼裝、怎麼運作、為什麼這樣設計」；手冊講的是「怎麼用」。

Chrome / Edge 擴充功能。讀取你瀏覽器裡正在進行的 **Google Meet**、**Microsoft Teams（網頁版）** 或 **Jitsi Meet** 會議字幕，即時產生：

- **逐字稿**，每段都標註說話者（顏色固定，同一人永遠同色）
- **滾動式重點摘要**：重點、決議、待辦（含負責人）、未解問題
- **即時回答建議**：有人點名問你時，自動給一句可以直接照唸的答案 + 2–4 個補充要點

不需要 Node.js、不需要建置、不需要自架伺服器。

### 支援的平台

| 平台 | 網域 | 逐字稿來源 | 說話者 |
|---|---|---|---|
| Google Meet | `meet.google.com` | 平台字幕（**CC** 按鈕） | 真實姓名 |
| Microsoft Teams | `teams.microsoft.com`、`teams.live.com` | 平台字幕（更多 → 語言和語音 → 開啟即時字幕） | 真實姓名 |
| Jitsi Meet | `meet.jit.si`、`*.8x8.vc`、自架站 | 有字幕就用字幕；**沒字幕就自動用本機語音辨識** | 「我」／「其他人」 |

Teams 的字幕在 iframe 裡，所以那個平台用 `all_frames: true`。

**三個平台的總花費都只有你已經買的 Claude Pro 訂閱** —— 沒有 API 金鑰、沒有語音辨識服務費用。Jitsi 沒有字幕時，逐字稿由兩個免費來源疊出來：麥克風（你自己，即時）＋ 本機 whisper.cpp（其他人，延遲約 18 秒）。

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
> **但這不影響使用**：偵測到會議沒有字幕時，擴充功能會自動開始用**本機 Whisper**聽分頁的聲音（見下方「本機語音辨識」），
> 加上麥克風收自己的發言，逐字稿照樣完整，而且完全免費。
>
> 判斷某個 Jitsi 站有沒有字幕，最快的方法是查它的 config：
>
> ```powershell
> (Invoke-WebRequest "https://網域/config.js" -UseBasicParsing).Content -split "`n" | Select-String 'transcri|subtitle'
> ```

## 三條路線：先選你的計費方式

逐字稿、說話者標註、搜尋、匯出**永遠免費**，不碰任何 API。只有「摘要」和「回答建議」需要模型，而模型有三種來源：

| 路線 | 費用 | 速度 | 看得懂共享畫面？ | 品質 |
|---|---|---|---|---|
| **Chrome 內建模型** | 完全免費 | 1–3 秒 | ❌ | 最弱 |
| **Claude Code 橋接** | 免費（吃 Claude Pro 訂閱額度） | 純文字 4.6 秒／附圖 10–17 秒 | ✅（截圖存檔後讓它讀檔） | 最好 |
| **存檔給 Claude Code** | 免費（吃 Pro 額度） | 手動觸發 | ✅ | 最好 |
| **Claude API** | 按量計費，約 NT$10／小時 | 1–3 秒 | ✅ | 最好 |

**建議組合（全部免費，全部在側邊欄裡完成）**：設定選「Claude Code」並勾選「即時回答改用 Chrome 內建模型」。這樣**摘要走 Claude Code**（品質最好），**即時回答走本機模型**（1–3 秒），兩者都不碰 API。

- **不填金鑰也能用** —— 預設就落在免費模式。側邊欄按一次「⚡ 啟用免費模型」下載 Chrome 內建的 Gemini Nano（一次性，數 GB），之後完全在你電腦上跑，資料不外流。
- **⚠️ Gemini Nano 有硬體門檻**：**顯示記憶體要 4GB 以上**、**Chrome 設定檔所在磁碟要 22GB 以上可用空間**、Windows 10/11、非計量網路。達不到的機器 `availability()` 會回 `unavailable`，側邊欄會顯示「⚠ 本機不支援免費模型」。這時擴充功能會**自動把免費路線改走 Claude Code**（同樣不計費，只是慢），不需要改設定。
- **Claude Code 橋接**：透過 Chrome 的 Native Messaging 呼叫你電腦上已登入的 Claude Code，用的是 Pro 訂閱額度。需先跑一次 `bridge\install.ps1`（見下方）。每次呼叫都重新啟動一個 CLI session，短提示實測 4.6–5.4 秒，帶整段逐字稿會更久 —— 摘要很合適，「被點名後三秒內給答案」則勉強。
- **要看得懂共享畫面**：在問答分頁勾「附上會議畫面」再提問就行，答案直接出現在同一張卡片。做法是把截圖存成 PNG，透過橋接把**檔案路徑**交給 Claude Code，讓它用 `Read` 工具看圖（`claude -p --allowedTools Read`）—— 影像沒有經過 API，所以不計費，代價是多一次工具往返（實測 10–17 秒 vs 純文字 4.6 秒）。
  也可以按「📸 存檔給 Claude Code」把畫面 + 逐字稿存進下載資料夾，再自己到終端機問 —— 一次呼叫涵蓋整場會議，最省 Pro 額度。

> ⚠️ **Claude Pro／Max 訂閱不含 API 額度。** 訂閱和 API 是分開計費的兩套東西，擴充功能**無法**直接用訂閱額度呼叫 API。「Claude Code 橋接」是唯一能動用訂閱的方式 —— 它呼叫的是你本機的 CLI，不是 API。

### 本機語音辨識（沒有字幕的會議）

平台沒有字幕時（例如沒裝 Jigasi 的 Jitsi），逐字稿由兩個**免費**來源疊出來：

| 來源 | 抓到誰 | 延遲 | 引擎 |
|---|---|---|---|
| 🎤 我的麥克風 | 只有你自己 | 即時 | 瀏覽器內建語音辨識 |
| 🔊 聽會議聲音 | 其他所有人 | 約 18 秒 | 本機 whisper.cpp small（離線） |

#### 安裝（建議）

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

**有 45 秒的等待期。** 「偵測到平台但抓不到字幕」這個條件，在你剛進 Meet、還沒按下 CC 的那幾秒也成立 —— 一偵測到就啟動會白燒 CPU，還會在逐字稿裡留下一批沒有姓名的段落。所以要連續 45 秒都沒有字幕才啟動，這段時間狀態列會提示「稍後會自動改用本機辨識」。字幕一出現就停掉。

**這不是只有 Jitsi 會用到。** Teams 的即時字幕可以被公司的 IT 政策停用，某些會議語言也不支援 —— 那種情況下同一條備援路徑會接手。Meet 幾乎不會用到。

**逐字稿照「說話時間」排序，不是照抵達順序。** 混合來源時這件事是必須的：麥克風是即時的，本機辨識要十幾秒才回來，照抵達順序排會讓你自己晚說的話排在別人早說的話**前面** —— 不只難讀，送去做摘要的對話順序也是錯的，模型會誤判誰在回應誰。所以 offscreen 回報的是「這段話被說出來的時間」（由分段長度反推），`store.upsertSegment` 依它插入。字幕來源本來就遞增，所以那個迴圈會立刻結束，等同 push。

**已知的取捨**：拿不到真實姓名（只有平台字幕有），全部標成「其他人（本機辨識）」。RTF 是機器閒置時量的，開會時 CPU 被視訊佔用可能跟不上 —— 跟不上時會略過片段、拉長分段，並在側邊欄明確告知，而不是安靜地爛掉。

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

裝好後到設定頁把「模型後端」選成「Claude Code」。

---

## 安裝

1. 開啟 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」，選擇這個資料夾 `d:\Claude\會議助手`
4. 在設定裡填「我的名字／稱呼」與「背景筆記」——這兩項直接決定回答建議的品質

到這裡逐字稿、搜尋、匯出就已經可用了（完全不需要金鑰）。要摘要與回答建議，再選一條模型路線：

```powershell
# 免費路線（用 Claude Pro 訂閱額度）—— 建議
powershell -ExecutionPolicy Bypass -File bridge\install.ps1 -ExtensionId <你的擴充功能ID>

# 沒有字幕的會議要用本機語音辨識，再跑這個（需要上面的 bridge）
powershell -ExecutionPolicy Bypass -File tools\install-whisper.ps1
```

要走按量計費的 Claude API 才需要填金鑰：設定頁 → Claude API → 填入後按「測試 API 連線」。

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

**④ 填兩個欄位**：側邊欄的 ⚙ → 「我的名字／稱呼」與「我的背景筆記」。名字空白的話自動回答幾乎不會觸發。

順序不能顛倒：**③ 一定要在 ② 之後**，因為擴充功能 ID 要先載入才拿得到。

#### 為什麼這幾步不能省

| 東西 | 為什麼不跟著 git 走 |
|---|---|
| `bridge/config.json`、`bridge/manifest.json` | 帶著該台電腦上 `claude.exe` 的絕對路徑與擴充功能 ID。**擴充功能 ID 由資料夾路徑決定**，換一台就變，所以只能各自產生 |
| 原生語音辨識（約 260 MB） | 裝在該台的 `%LOCALAPPDATA%\MeetingAssistant\whisper`。**必須是純 ASCII 路徑**，見上方 whisper.cpp 的說明 |
| `vendor/`（99 MB） | WASM 備援引擎，沒進版控。裝了原生的就用不到；真的要的話跑 `tools\fetch-vendor.ps1` |
| 「我的名字」「背景筆記」等設定 | 存在該台瀏覽器的 `chrome.storage.local` |

沒裝任何語音引擎也不會壞 —— 只是遇到沒有字幕的會議時，「聽會議聲音」會失敗並在側邊欄說明原因。字幕、逐字稿、摘要、問答都不受影響。

**作業系統限制**：擴充功能核心（字幕擷取、逐字稿、摘要、問答）跨平台；但**橋接與本機語音辨識目前只支援 Windows**，因為安裝腳本是 PowerShell、原生辨識用的是 Windows 版 whisper.cpp。macOS／Linux 上要走 Claude API 或 Chrome 內建模型。

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

`check-project.ps1` 特別重要：它抓的是**測試跑得過、但擴充功能根本載不進去**的那類問題（少了 UTF-8 BOM、`.bat` 變成 LF、底線開頭的檔名、埠號對不上）。這些在 Windows 上很容易不小心引入，而症狀都不會指向真正的原因。

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

1. 進入 Google Meet 或 Teams 會議
2. **在會議中開啟字幕**（這是必要步驟）
   - Meet：底部工具列的 **CC**（開啟字幕）
   - Teams：**更多** → **語言和語音** → **開啟即時字幕**
3. 點瀏覽器工具列的擴充功能圖示，開啟側邊欄
4. 側邊欄左上圓點：🟢 字幕已連線 / 🟡 找到會議但沒抓到字幕 / ⚪ 沒偵測到會議

側邊欄三個分頁：

| 分頁 | 內容 |
|---|---|
| **逐字稿** | 即時逐字稿，最下方灰色斜體是還沒定稿的當前發言。可搜尋、可關閉自動捲動。 |
| **重點** | 自動更新需要**兩個條件同時成立**：距上次至少 N 秒（預設 300，這是真正的節流上限）**且**累積至少 M 段發言（預設 8）。按 ↻ 可立即更新，不受限制。 |
| **問答** | 自動偵測的提問 + 你手動輸入的問題。每張卡片可一鍵複製。 |

**⬇ 匯出** 會把整份 Markdown（含摘要與逐字稿）複製到剪貼簿，並下載一份 `.md` 備份。

---

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

### 為什麼讀字幕，而不是聽聲音

平台內建字幕**自帶說話者的真實姓名**、延遲低、不另外花錢。聲學方式（音訊擷取 + 語音辨識）只能把人分成「講者 1／2」，拿不到姓名，還要多付一份辨識費用。因此字幕是主要路徑。

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

### Claude API 用法

因為這台機器沒有 Node/npm，裝不了 `@anthropic-ai/sdk`，所以用 `fetch` 直接打 REST API。要點：

- 從瀏覽器情境呼叫必須帶 `anthropic-dangerous-direct-browser-access: true`
- 預設模型 `claude-sonnet-5`；**不帶** `temperature` / `top_p`（Sonnet 5 會拒絕）
- **摘要**：`thinking: adaptive` + `effort: medium` + 結構化輸出（`output_config.format` 的 JSON schema），所以解析摘要不需要容錯 parsing
- **即時回答**：`thinking: disabled` + `effort: low` + **串流**，因為會議中的重點是延遲
- `system` 用陣列形式並掛 `cache_control: ephemeral`，長逐字稿的重複前綴可命中提示快取

---

## 已知限制

1. **必須手動開啟平台字幕。** 沒有字幕就沒有逐字稿。擴充功能無法代你按那顆按鈕（那是平台自家 UI 的權限範圍）。
   **Jitsi 自架站還多兩個外部條件**：部署端要有 Jigasi 轉錄服務才有字幕可抓，而且網域要先在設定頁授權。兩者缺一，逐字稿就是空的。
2. **本機語音辨識有延遲，而且拿不到姓名。** 其他人的發言要約 18 秒才進逐字稿（見上方為什麼），說話者只能標「其他人（本機辨識）」。開會時 CPU 被視訊佔用可能跟不上，此時會略過片段、自動拉長分段並告知。Deepgram 雲端引擎延遲低且有講者分群，但**要另外付錢**（約 NT$11／小時，Claude Pro 不涵蓋），預設不啟用，自動啟動也只在本機引擎下生效 —— 自動花錢是不能接受的。
   原生引擎另外有兩個外部條件：要跑過 `tools\install-whisper.ps1`，而且**要跑過 `bridge\install.ps1`** —— 伺服器是由 bridge 啟動的，擴充功能自己不能執行本機程序。兩者缺一就會退到 WASM 備援（會明確告知）。
3. **音訊備援可能需要先在會議分頁點一下擴充功能圖示。** Chrome 的 `tabCapture` 要求擴充功能「已被該分頁叫用過」才給音訊串流。從側邊欄按鈕觸發時，這個條件不一定成立，會失敗並顯示 *Extension has not been invoked for the current page*。解法是先在**會議分頁**點一次工具列的擴充功能圖示（取得 activeTab 授權），再按「🔊 音訊備援」。主線的字幕路徑不受這個限制影響。
4. **麥克風模式只聽得到你自己，而且不會無條件自動開。** 側邊欄的 🎤 用瀏覽器內建語音辨識（免金鑰），抓的是麥克風，所以只會有你自己的發言，標為「我（麥克風）」。其他人的話仍走字幕。
   預設會在**找不到字幕時自動開啟**、字幕一恢復就自動關閉（`micAuto`）—— 不無條件開啟是因為平台字幕本來就含你自己的發言且帶真實姓名，兩邊都收會讓同一句話進逐字稿兩次。**首次必須手動按一次那顆按鈕授權麥克風**，因為權限提示需要使用者手勢，自動啟動拿不到；被拒一次後就不再自動重試，避免每次狀態更新都跳橫幅。
5. **API 金鑰存在瀏覽器本機。** 個人使用可接受。要發給團隊的話，應改成由自己的後端代理呼叫 Claude，擴充功能只呼叫代理，不散發金鑰。
6. **免費模型有硬性能力上限。** Chrome 內建的 Gemini Nano 的 context 只有幾千 token（所以摘要走累積式增量、回答只帶最近約 1500 字逐字稿）、**不支援圖片**、也不保證能輸出 JSON schema，因此免費路線的摘要改用固定前綴的純文字格式再解析。中文判斷品質與 Claude 有明顯差距。
   看不懂圖片這件事是用**升級**處理的，不是降級：勾了「附上會議畫面」而目前後端是本機模型時，**那一題會自動改走 Claude Code**（`stream({ provider })` 蓋掉設定的判斷），並在卡片上說明換了後端。橋接沒就緒時才退回純文字，並告訴你要跑 `install.ps1`。
7. **免費模型跑在側邊欄，不是背景。** 因為首次下載必須由使用者手勢觸發，而 service worker 沒有手勢。實務影響：**側邊欄關著時不會產生摘要**（會安靜跳過，不會噴錯），重新開啟後可按 ↻ 補做。
8. **本機推論會吃資源，而且不是每台機器跑得動。** 8GB RAM 的機器上，Meet 開視訊本身就佔 1–2GB，再疊本機模型可能造成頓挫。推論是爆發式的（每次幾秒），不是持續佔用。**更常見的情況是根本啟用不了**：Gemini Nano 要求 4GB 以上顯示記憶體與 22GB 以上可用磁碟（例：GTX 960M 只有 2GB VRAM 就直接不符），此時 `resolveProvider` 會把免費路線改判給 Claude Code —— 於是**那台機器上唯一的免費即時路線也變成 10–30 秒**，只能靠拉長摘要間隔與手動問答來配合，或改用 API 路線。
9. **Claude Code 橋接會吃 Pro 的用量額度，而且不便宜。** 它每次呼叫都是一個完整的 Claude Code session，帶著 CLI 自己的系統提示，所以單次消耗遠大於同樣內容的 API 呼叫。**每分鐘一次摘要會很快撞到 Pro 的用量上限**，建議把摘要間隔拉長到 5 分鐘以上，或改成只按 ↻ 手動觸發。另外要知道：Claude Code 是開發工具，把它當成應用程式的後端並不是它的設計用途 —— 個人自用可行，但它比 API 脆弱（CLI 更新可能改變輸出格式），也沒有服務等級保證。
10. **橋接綁定擴充功能 ID。** 未封裝擴充功能的 ID 由資料夾路徑決定，**搬動資料夾會讓 ID 改變**，橋接就會失效，要重新跑一次 `install.ps1`。
11. **自動回答只在「有人點名你」時觸發**，避免每個問句都花錢。判斷依據是設定裡的「我的名字」或「請問／你覺得／麻煩你」這類直接稱呼。想針對任何問題都拿建議，就手動在問答分頁輸入。

## 測試

```
powershell -ExecutionPolicy Bypass -File tests\run.ps1            # 行為測試（256 項）
powershell -ExecutionPolicy Bypass -File tests\check-project.ps1  # 專案一致性（52 項）
```

`check-project.ps1` 抓的是「行為測試跑得過、但東西還是壞的」那一類問題：`.ps1` 有沒有 UTF-8 BOM、`host.bat` 是不是 CRLF、`manifest.json` 提到的檔案存不存在、**橋接與擴充功能用的埠號有沒有對上**（不對上時 `fetch` 只會說 `Failed to fetch`）、`offscreen.html` 的腳本載入順序、以及 `src/` 下每個 `.js` 的語法。

這個專案沒有 Node/npm，所以直接把 **Chrome 當測試執行環境**：每個測試頁把 `chrome.*` API 換成 stub，載入**真正的原始碼**（不是複本），再用 `--headless --dump-dom` 把結果讀回來。目前 **256 項檢查**，分六組：

| 測試組 | 內容 |
|---|---|
| 字幕擷取引擎 | 用合成的 Meet / Teams / Jitsi 字幕 DOM 驅動引擎：串流改寫合併、視窗滑動、定稿時機、換人講話、節點重用，以及**已知選擇器全部失效時的退路**（Meet 靠 `role="region"`＋結構、Teams 靠 `data-tid*=` 與 `data-caption-id`） |
| 逐字稿狀態 | 定稿去重、partial 生命週期、重整分頁不清空、換會議要清空、**照說話時間插入**、摘要排程（AND 門檻與失敗退避）、Markdown 匯出 |
| 側邊欄 UI | 載入**真正的** `panel.html` + `panel.js`，餵一份逼真的 state，檢查逐字稿／重點／問答三個分頁、搜尋高亮、串流增量、未讀徽章、錯誤橫幅、無字幕等待期 |
| 背景邏輯 | 把 `fetch` 與 Native Messaging 換成 stub：提問偵測、SSE 串流解析（含事件被切在 chunk 邊界）、請求形狀、結構化摘要、錯誤中文化、附畫面時的後端升級、**原生辨識啟動失敗自動退到 WASM**、設定遷移 |
| 音訊處理 | 重疊去重、靜音門檻、降取樣、**WAV 編碼**、**跟不上時丟最舊的並自動拉長分段**、原生引擎的 HTTP 請求形狀 |
| 簡繁轉換 | 實測會議句子、一對多字（发→發／髮、干→乾／幹）、台灣用字、繁體輸入不被弄壞、冪等性、邊界 |

引擎測試把 `setInterval` 和 `Date.now` 換成可控的假時鐘，所以整個擷取流程是**同步、確定性**地跑完，不靠 sleep 等待。

**這些測試證明什麼、不證明什麼**：合成 DOM 驗證的是「選擇器與引擎邏輯自洽」，**不能**證明真實的 Meet DOM 長得跟合成的一樣 —— 那只有真實會議能驗證。同理，`fetch` 是 stub，所以驗證的是「請求形狀正確、回應處理正確」，不是伺服器真的會回什麼。

**本機辨識另外有一份真的端對端驗證**（不在 `run.ps1` 裡，因為它需要真的裝好 whisper.cpp）：實際啟動 `bridge\host.bat`、走真正的 Native Messaging 協定發 `sttStart`、確認伺服器真的在 8317 監聽、用真實瀏覽器把一段 12 秒音訊經 `toWavBlob` 編碼後 POST 到 `/inference`、驗證回來的文字經 `s2t.js` 轉成繁體，最後確認 `sttStop` 與「Chrome 斷線」都會真的把伺服器收掉。這一段驗證的是單元測試碰不到的部分：WAV 編碼器產出的檔案 whisper-server 真的讀得懂、以及伺服器不會變成 400 MB 的常駐幽靈。

`tests\.tmp\` 是執行時產生的暫存目錄，可以隨時刪除。

## 檔案結構

```
manifest.json                 MV3 設定
src/content/core.js           字幕擷取引擎（平台無關）：合併、定稿、回報
src/content/meet.js           Google Meet 選擇器
src/content/teams.js          Teams 選擇器
src/content/jitsi.js          Jitsi Meet 選擇器 + 「名字: 內容」切分
src/offscreen/offscreen.js    音訊擷取 + 分段 + 三個引擎的排程
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
src/background/provider.js    模型後端切換層（Claude / Chrome 內建 / Claude Code）
src/background/claude.js      Claude API 用戶端（含 SSE 串流解析）
src/background/localmodel.js  Chrome 內建模型：把推論委派給側邊欄
src/background/claudecode.js  Claude Code 後端（Native Messaging，用 Pro 額度）
src/background/whisper-native.js  原生辨識伺服器的啟動與生命週期（另開一條 native 連線）
bridge/host.ps1               Native Messaging 主機（stdio 協定、呼叫 claude.exe、管辨識伺服器）
bridge/install.ps1            註冊橋接 + 自我測試（-Uninstall 可移除）
src/sidepanel/                側邊欄 UI
src/options/                  設定頁
tests/run.ps1                 測試執行器（用 headless Chrome 跑）
tests/check-project.ps1       專案一致性檢查（編碼、manifest、埠號、JS 語法）
tests/*.test.html             六組測試頁
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
