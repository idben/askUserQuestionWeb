---
name: askuserquestionweb
argument-hint: [--port 5700] [--idle-close-sec 60]
description: 把 AskUserQuestion 改在瀏覽器作答：Claude 把題目寫進 .auq/outbox/，使用者在網頁點選 (支援 preview 分欄、Other 自填、備註、通知音效)，答案透過 Monitor 回到 Claude Code。當使用者說「啟動 askUserQuestion 網頁版」「askuserquestionweb」「網頁問答」「改用網頁回答問題」「在瀏覽器回答 AskUserQuestion」等情境時觸發；英文如 "start askUserQuestion Web"、"answer questions in the browser"、"ask me in the browser" 也觸發。使用者不在電腦前 (例：改用 Claude Code 手機 app) 時自動改回傳統 AskUserQuestion。
---

# askUserQuestion Web：瀏覽器作答 → Claude Code

本 skill 所在路徑（下稱 `<skill>`）即為安裝資料夾，`server.js`、`detect.mjs` 與 `public/` 都在這裡。所有指令用 `<skill>/server.js` 組出路徑，不要寫死。

## 啟動

1. **在目前專案根目錄背景執行**（Bash `run_in_background`，Node 依使用者指定的 nvm 環境）：
   ```bash
   mkdir -p .auq && node <skill>/server.js [--port N] [--idle-close-sec N] >> .auq/server.log 2>&1
   ```
   - port 預設 5700，被占用時自動往後找
   - `--idle-close-sec`：最後一題結束後多久沒有新題目就關閉作答頁面（server 繼續待命），預設 60 秒
2. **確認啟動並開啟頁面**：等 `.auq/server.log` 出現 `[AUQ:ready]`，取得網址後執行 `open <網址>`（macOS；Linux 用 `xdg-open`）自動開啟作答頁面，並告訴使用者網址，第一次使用時提醒按「🔔 啟用通知」（英文介面為「🔔 Enable alerts」）允許桌面通知，瀏覽器會記住，之後按鈕不再出現；提示音要點過頁面才會響；出現 `[AUQ:error]` 就回報原因
3. **開始監看**（Monitor，`timeout_ms` 設最大值）：
   ```bash
   tail -n 0 -f .auq/server.log | grep -E --line-buffered "^\[AUQ\]|\[AUQ:error\]"
   ```
   Monitor 到期時重新啟動監看，直到使用者說結束
4. **檢查 `.gitignore`**：目前專案若是 git repo 且 `.gitignore` 沒有 `.auq/`，用 AskUserQuestion 詢問是否加入 (選項：加入 (Recommended) / 不用)（答案內容不應進版控）

## 出題流程（取代 AskUserQuestion）

啟動後，凡是原本要呼叫 AskUserQuestion 的時機，依下列順序處理：

1. **先判斷出題方式**：在專案根目錄執行 `node <skill>/detect.mjs`，輸出 `<mode> :: <原因>`
   | mode | 意義 | 處理 |
   |------|------|------|
   | `web` | 使用者在電腦前且頁面已連線 | 直接用網頁出題（第 2 步） |
   | `open` | 使用者在電腦前，頁面沒開（例：閒置自動關閉） | `open <網址>` 開啟頁面 → 等頁面連線 → 第 2 步 |
   | `start` | 使用者在電腦前，server 沒在跑 | 依「啟動」第 1～3 步重啟 server 與 Monitor → 等頁面連線 → 第 2 步 |
   | `classic` | 使用者在手機上 | **直接用傳統 AskUserQuestion**，不寫 outbox |
   - 等頁面連線：用 Bash（前景，timeout 20 秒）執行 `for i in $(seq 30); do grep -qE '"connected": [1-9]' .auq/presence.json && break; sleep 0.5; done; grep -o '"connected": [0-9]*' .auq/presence.json`；15 秒內沒連上就改用傳統 AskUserQuestion
   - 判斷「使用者在哪」：比較「桌機最後一次鍵盤滑鼠操作」（macOS 系統閒置時間推算）與「最後一則手機訊息」（session 紀錄中 `queueSkipSlashCommands: true`）的時間，**較新者勝**
     - 手機訊息較新 → 在手機
     - 桌機操作較新，或沒有手機訊息 → 在電腦前，頁面在背景也照樣用網頁，靠提示音與通知提醒
   - 限制：工作中插話與 AskUserQuestion 的回答沒有來源欄位，只能靠閒置時間；訊息來源是 Claude Code 內部欄位，改版可能失效
2. **寫入題目**：用 Write 建立 `.auq/outbox/<簡短英文 id>.json`，格式與 AskUserQuestion 的 `questions` 相同：
   ```json
   {
     "questions": [
       {
         "header": "版面",
         "question": "首頁要用哪種版面配置？",
         "multiSelect": false,
         "options": [
           {
             "label": "左右分欄 (Recommended)",
             "description": "側欄導覽 + 主內容",
             "preview": "Nav | Content",
             "previewHtml": "<div class=\"flex gap-2 h-32\"><nav class=\"w-1/4 bg-primary/20 rounded p-2\">Nav</nav><main class=\"flex-1 bg-base-200 rounded p-2\">Content</main></div>"
           },
           { "label": "上下堆疊", "description": "頂部導覽列" }
         ]
       }
     ]
   }
   ```
   - 1～4 題，每題 2～4 個選項，`label` 不可重複
   - 預覽（選填，有的話頁面會左右分欄顯示）：
     - `previewHtml`：**網頁優先顯示這個**。HTML 片段（不含 `<html>`、`<head>`），放在 sandbox iframe 中呈現，已載入 tailwind + daisyUI（主題 corporate），可直接用 class；適合版面、元件、配色等視覺比較
     - `preview`：純文字（等寬字型），與 AskUserQuestion 相容；有 `previewHtml` 時也建議附上簡短的文字版，fallback 回傳統 AskUserQuestion 時會用到
     - iframe 無法存取主頁面，不要在 previewHtml 中放機敏資料或外部追蹤資源
   - 不用自己加 Other，頁面每題都會附 Other 自填與備註
   - id 只用英數、`-`、`_`；重複時 server 會自動加後綴
   - 所有需要使用者決定的事（包含推送、發布、刪除等不可逆動作的確認）都依此流程出題，網頁上的回答即視為確認，不另外改到終端機詢問
3. 寫入後告訴使用者「題目已送到網頁」，**結束這一輪回覆等待 Monitor 通知**，不要輪詢
4. 依 Monitor 收到的內容處理：

| 通知 | 意義 | 處理 |
|------|------|------|
| `[AUQ] answer <id> N questions` + 每題一行 `Q1 [header] 題目 => 答案 \| 備註: ...` | 使用者已作答 | 當成 AskUserQuestion 的回答繼續工作；`Other: ...` 是自填答案 |
| `[AUQ] cancel <id>` | 使用者按「略過」 | 等同拒絕回答，依情境用預設做法或在對話中詢問 |
| `[AUQ] cancel <id> :: claude-reask` | Claude 自己撤回（見下方） | 忽略 |
| `[AUQ] fallback <id> :: <原因>` | 有未答題目時作答頁面全部關閉超過 10 秒 | **立即用傳統 AskUserQuestion 重問同一組題目**（previewHtml 改用 preview 文字版） |
| `[AUQ:error] <檔名> :: <原因>` | 題目格式錯誤（檔案已移到 `.auq/processed/*.invalid.json`） | 修正後用新檔名重寫 |

- **題目已送到網頁，但使用者從手機傳訊息來**（例：「我在手機」「看不到題目」），或在等待中重新執行 detect.mjs 得到 `classic`：撤回網頁題目後用傳統 AskUserQuestion 重問（port 取自 `[AUQ:ready]` 那一行）：
  ```bash
  curl -s -H "Origin: http://127.0.0.1:<port>" -d '{"id":"<id>","reason":"claude-reask"}' http://127.0.0.1:<port>/api/cancel
  ```
- 最後一題結束後 `--idle-close-sec` 秒沒有新題目，server 會通知頁面斷線並嘗試關閉分頁（log 為 `[AUQ:idle-close]`，Monitor 不監看）；下次出題時 detect.mjs 會回 `open`
- 完整答案 (含結構化欄位) 存在 `.auq/inbox.jsonl`，以 id 查最後一筆即可；只追加不改寫
- 同一時間可以有多組題目，答案依 id 對應

## 結束

使用者說結束或不再需要時（例：「結束 askUserQuestion 網頁版」、"stop askUserQuestion Web"），停止 server 背景工作與 Monitor（TaskStop），之後恢復使用傳統 AskUserQuestion。
