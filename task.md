# askUserQuestion 網頁版

## Plan（來自 plan.md）
- 看一下 skill webToAgent
- 用它的核心技術做出 askUserQuestion 的網頁版

## webToAgent 核心技術拆解
| 技術 | webToAgent 的用法 | 本專案的對應用法 |
|------|------------------|----------------|
| 本機 Node bridge server（零相依，`127.0.0.1`，port 自動往後找） | 預覽 HTML + 收需求 | 提供問答頁面 + 收答案 |
| 瀏覽器 → server：`POST /api/feedback`（同源檢查、body 上限） | 送出圈選需求 | 送出答案 `POST /api/answer` |
| server → Claude Code：stdout 印 `[WTA] ...` 標記行，Claude 用 Monitor `tail -f \| grep` 監看 | 收到批次需求 | 印 `[AUQ] answer <id> ...` 行，Claude 收到即取得答案 |
| `inbox.jsonl` 持久化 + `POST /api/status` 回寫狀態 | 記錄需求與處理狀態 | 記錄問題與答案（pending / answered / cancelled） |
| server → 瀏覽器：SSE 推播 | 檔案變更時自動重整 | Claude 出新題目時即時推到頁面（不用重整） |
| `[WTA:ready]` / `[WTA:error]` 啟動標記 | 回報網址 | 同樣做法 `[AUQ:ready]` |

## 運作流程（方向反轉：Claude 出題 → 使用者在網頁作答）
1. Claude 背景啟動 `node server.js`，等 `[AUQ:ready]` 取得網址，開 Monitor 監看
2. Claude 把題目 JSON 寫入 `.auq/outbox/<id>.json`（server 用 fs.watch 監看，驗證格式後推給頁面；格式錯誤印 `[AUQ:error]`）。題目（JSON 格式比照 AskUserQuestion：1～4 題，每題 header / question / options 2～4 個含 label、description、preview，multiSelect）
3. 頁面透過 SSE 立即顯示題目卡片；使用者選擇（單選 / 多選 / Other 自填 / 備註），按送出
4. server 寫入 inbox、stdout 印 `[AUQ] answer <askId> :: <題目> => <答案>`，Monitor 通知 Claude
5. 新題目到達時發出桌面通知（Notification API）+ 提示音（Web Audio 產生，不需音檔）

## 待辦（確認後執行）
- [x] 1. `server.js`：HTTP server、監看 `.auq/outbox/`（讀取後移到 `.auq/processed/`）、`/api/answer`（同源檢查）、`/events` SSE、inbox.jsonl
  - 實作差異：未另做 `/api/pending`，改由 SSE 連線時送出 snapshot 補回未答題目（重連也適用）；inbox 改為只追加不改寫；另加 `/api/cancel`（略過）
- [x] 2. `public/index.html` + `app.js` + `app.css`：tailwind + daisyUI（CDN），mobile-first，題目卡片、preview 區（monospace，有 preview 時左右分欄）、Other 自填 + 備註、送出後顯示已答狀態、桌面通知 + 提示音（首次點擊後才請求權限）
- [x] 3. `SKILL.md`：仿 webToAgent 的啟動 / 監看 / 出題 / 收答 / 結束流程，讓 Claude Code 能以 skill 形式使用
- [x] 4. 測試：寫入 outbox 出題 → 瀏覽器作答 → 確認 stdout 與 inbox；單選、多選、Other、preview、多題、頁面重開補回
  - 結果：curl 測 API（單選限制、Origin 檢查、格式錯誤）、agent-browser 測桌面 1280 與手機 390 版面、預覽分欄、Other 必填、備註、略過，全部通過
  - 測試中修正：選項的 data-preview 與預覽區選擇器撞名；SSE done 事件比 fetch 回應先到導致誤顯示「其他分頁作答」
  - 未驗證：提示音與桌面通知（headless 瀏覽器無法確認）；headless 截圖中 preview 方框字元對不齊，需在實際 Chrome 確認
- [x] 5. `scripts/install-skill.sh`：把 server.js、public/、SKILL.md 複製到 `~/.claude/skills/askuserquestionweb`
  - 已用暫時 HOME 驗證，並已安裝到 ~/.claude/skills/askuserquestionweb
- [x] 6. README.md + git commit

## 新增需求：手機 app 自動改回傳統 AskUserQuestion
Claude 無法直接得知使用者用哪個裝置，改用「桌面頁面是否有人看著」判斷：
- [x] 7. 頁面用 Page Visibility API 回報可見狀態（`POST /api/presence`），server 記錄可見分頁數與最後可見時間，寫入 `.auq/presence.json`
- [x] 8. 出題前判斷：SKILL.md 規定 Claude 先讀 `.auq/presence.json`（或 server 未啟動），沒有可見分頁 → 直接用傳統 AskUserQuestion
- [x] 9. 出題後保險：題目送出後 15 秒內沒有可見分頁，server 自動取消該題並印 `[AUQ] fallback <id>`，Claude 收到後改用傳統 AskUserQuestion 重問
  - 實作差異：沒有頁面時 10 秒 fallback；頁面開著但在背景時給 `--fallback-sec`（預設 60 秒），讓提示音和通知有機會提醒；server 結束時 presence.json 寫入 `running: false`

## 試用回饋（2026-10-15，網頁作答 test1）
- 結果：preview 方框字元在實際 Chrome 有對齊；提示音與桌面通知未出現（頁面未點擊過，音效被自動播放政策擋下；頁面在前景時本來就不跳通知）
- [x] 10. SKILL.md 啟動步驟加上：`[AUQ:ready]` 後執行 `open <網址>` 自動開啟頁面（使用者已選擇）
- [x] 11. ~~提示音未解鎖時顯示提示列~~：使用者選擇維持現狀（保留「🔔 啟用通知」按鈕）；桌面通知維持「頁面不是焦點時」才跳
- [x] 12. preview 改用 HTML 呈現（使用者回饋：中文 / emoji 混在方框字元中仍對不齊）
  - 題目選項新增 `previewHtml` 欄位，用 `<iframe sandbox srcdoc>` 呈現，與主頁面隔離（樣式不互相影響、無法存取主頁面）
  - 保留原本的 `preview`（純文字），與 AskUserQuestion 格式相容，fallback 回傳統 AskUserQuestion 時可直接沿用
  - iframe 高度依內容自動調整，上限 24rem
  - SKILL.md 說明兩種 preview 的使用時機與 HTML 撰寫規範
  - 決定：新增 `previewHtml`；iframe `sandbox="allow-scripts"`（無 same-origin）並載入 tailwind + daisyUI
  - 結果：使用者在實際 Chrome 確認預覽正常、切換正常（test3）

- [x] 13. 改進「是否在電腦前」判斷（使用者回饋：頁面不在前景就改回 AskUserQuestion 不好，在電腦前切去終端機也會被誤判）
  - 使用者希望能精準偵測「手機 app / 非手機 app」，閒置時間、螢幕鎖定、手動切換等間接訊號暫緩
  - 調查結果：
    - 環境變數只有 `CLAUDE_CODE_ENTRYPOINT=cli`、`CLAUDE_CODE_BRIDGE_SESSION_ID`（Remote Control 橋接已開），沒有「目前是否有手機連線」的資訊
    - `~/.claude/sessions/<pid>.json` 只有 bridgeSessionId，沒有遠端連線狀態
    - session 紀錄 (`~/.claude/projects/<專案>/<sessionId>.jsonl`) 每則使用者訊息有 `origin`、`promptSource`、`entrypoint` 欄位；目前終端機打字的訊息為 `origin.kind=human`、`promptSource=typed`
  - 實測（2026-10-15 手機 app 送出一則訊息，Claude 閒置時）：
    | 來源 | promptSource | queueSkipSlashCommands | 寫入方式 |
    |------|-------------|------------------------|---------|
    | 終端機（閒置時輸入） | typed | 無 | 直接成為 user 紀錄 |
    | 終端機（工作中插話） | — | — | queue-operation + attachment(queued_command)，無來源欄位 |
    | 手機 app（閒置時） | queued | true | queue-operation enqueue 後成為 user 紀錄 |
  - 判讀：`queueSkipSlashCommands: true` 是目前唯一能區分手機訊息的欄位（遠端輸入不解析 slash command）
  - 限制：只有 1 筆樣本；工作中插話的訊息（不論手機或終端機）都沒有來源欄位；這些是 Claude Code 內部欄位，沒有官方文件，改版可能失效
  - 原規劃：請使用者從手機 app 送一則訊息，比對欄位是否不同（已完成）
  - 追加發現：AskUserQuestion 的回答（tool_result）沒有任何來源欄位；使用者在手機被問、回桌機作答時，「最後訊息來源」會停在手機而誤判
  - 修正方案（兩訊號互補，閒置時間只當「在電腦前」的正向證據）：
    1. 頁面沒開 → 傳統
    2. 系統閒置 < 60 秒 → 網頁（不論頁面是否在前景）
    3. 最後一則人類訊息 `queueSkipSlashCommands: true`（手機）→ 傳統
    4. 其他 → 網頁
  - 出題後：只在「頁面關閉」時 fallback；移除「背景 60 秒 fallback」
  - 實作：新增 `detect.mjs`（改用 Node，避免 Python 環境；輸出 web / classic 與原因），SKILL.md 出題前執行；server 只在頁面全關 10 秒 fallback，presence.json 加 pid；SKILL.md 加入 Claude 撤回網頁題目（`/api/cancel` reason=claude-reask）
  - 驗證：工作中從手機、桌機各插話一次，紀錄格式相同，證實需要閒置時間訊號；detect.mjs 實測輸出 `web :: 系統閒置 0 秒`
    - 若不同：出題前讀 session 紀錄，**依最後一則使用者訊息的來源**決定（手機 → 傳統 AskUserQuestion，電腦 → 網頁），取代頁面可見判斷
    - 若相同：回到間接訊號方案再討論

## 新增需求：閒置自動關閉（2026-10-15）
- 需求：每次問完問題，3 分鐘內沒有新問題就關掉
- [x] 14. 閒置自動關閉作答頁面（使用者選擇：只關頁面，server 繼續待命）
  - server：最後一題結束（作答 / 略過 / fallback）且沒有未答題目時倒數 `--idle-close-sec`（預設 60 秒，使用者由 180 秒改為 1 分鐘），期間有新題目就取消；時間到透過 SSE 送 `idle-close`
  - 頁面：收到 `idle-close` 先關閉 SSE 連線（presence 歸零），再 `window.close()`；瀏覽器不允許關閉時改顯示「已閒置關閉，可關閉此分頁」與「重新連線」按鈕（需實測 `open` 開的分頁能否關閉）
  - 結果：agent-browser 測試斷線與提示畫面正常；實際 Chrome 中 `open` 開啟的分頁在 180 秒後被 `window.close()` 成功關閉（使用者確認看不到頁面），presence connected 歸零
- [x] 15. detect.mjs 改為先判斷「使用者在哪」，再判斷頁面狀態（使用者選擇：自動重啟並開頁）
  - 在手機（最後訊息來自手機且閒置 ≥ 60 秒）→ `classic`
  - 在電腦前：server 沒在跑 → `start`（重啟 server + open 頁面）；server 在跑但頁面沒開 → `open`（open 頁面）；頁面已連線 → `web`
  - 結果：頁面關閉後 detect.mjs 回 `open`，自動開頁後網頁出題正常（使用者確認）
  - 誤判（2026-10-15）：使用者在手機送出「現在再問我問題」（queueSkipSlashCommands: true），但桌機 21 秒前剛有操作（網頁作答），閒置 < 60 秒優先判為電腦前 → 題目送到網頁，使用者看不到
  - [x] 修正：比較「桌機最後操作時間（現在 − 閒置秒數）」與「最後一則手機訊息時間戳記」，較新者勝；手機訊息較新 → classic，桌機操作較新 → 電腦前
    - 移除 `--idle-sec`（不再用固定門檻）；實測使用者回到桌機時輸出 `web :: 桌機最後操作 0 秒前，比手機訊息 (108 秒前) 新`，並向使用者確認讀數正確
  - SKILL.md：`start` / `open` 時執行對應動作，用背景 until 迴圈等 presence.json 出現連線（上限 15 秒）後出題；逾時改用傳統 AskUserQuestion

## 安全（ISO27001 考量）
- 只綁 `127.0.0.1`；`/api/answer` 檢查 Origin；出題只能透過本機檔案系統（網頁無法偽造題目）；題目 JSON 大小與欄位長度設上限
- 答案內容只存本機 `.auq/`，加入 `.gitignore`
- 前端一律用 `textContent` 呈現題目文字，避免 XSS

## 待確認事項
- [x] 交付形式：專案 + 可安裝 skill
- [x] 出題方式：寫入檔案（outbox 資料夾）
- [x] 功能範圍：preview 分欄、Other 自填 + 備註、瀏覽器通知音效（不做歷史紀錄）
