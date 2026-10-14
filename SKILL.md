---
name: askuserquestionweb
argument-hint: [--port 5700] [--fallback-sec 60]
description: 把 AskUserQuestion 改在瀏覽器作答：Claude 把題目寫進 .auq/outbox/，使用者在網頁點選 (支援 preview 分欄、Other 自填、備註、通知音效)，答案透過 Monitor 回到 Claude Code。當使用者說「啟動 askUserQuestion 網頁版」「askuserquestionweb」「網頁問答」「改用網頁回答問題」「在瀏覽器回答 AskUserQuestion」等情境時觸發。使用者不在電腦前 (例：改用 Claude Code 手機 app) 時自動改回傳統 AskUserQuestion。
---

# askUserQuestion Web：瀏覽器作答 → Claude Code

本 skill 所在路徑（下稱 `<skill>`）即為安裝資料夾，`server.js` 與 `public/` 都在這裡。所有指令用 `<skill>/server.js` 組出路徑，不要寫死。

## 啟動

1. **在目前專案根目錄背景執行**（Bash `run_in_background`，Node 依使用者指定的 nvm 環境）：
   ```bash
   mkdir -p .auq && node <skill>/server.js [--port N] [--fallback-sec N] >> .auq/server.log 2>&1
   ```
   - port 預設 5700，被占用時自動往後找
   - `--fallback-sec`：頁面開著但不在前景多久後改回傳統 AskUserQuestion，預設 60 秒
2. **確認啟動**：等 `.auq/server.log` 出現 `[AUQ:ready]`，取得網址交給使用者，請他開啟並按「🔔 啟用通知」；出現 `[AUQ:error]` 就回報原因
3. **開始監看**（Monitor，`timeout_ms` 設最大值）：
   ```bash
   tail -n 0 -f .auq/server.log | grep -E --line-buffered "^\[AUQ\]|\[AUQ:error\]"
   ```
   Monitor 到期時重新啟動監看，直到使用者說結束
4. **檢查 `.gitignore`**：目前專案若是 git repo 且 `.gitignore` 沒有 `.auq/`，用 AskUserQuestion 詢問是否加入 (選項：加入 (Recommended) / 不用)（答案內容不應進版控）

## 出題流程（取代 AskUserQuestion）

啟動後，凡是原本要呼叫 AskUserQuestion 的時機，依下列順序處理：

1. **先判斷使用者是否在電腦前**：讀 `.auq/presence.json`
   - `running` 為 true 且 `visible` ≥ 1 → 用網頁出題（第 2 步）
   - 檔案不存在、`running` 為 false、`visible` 為 0（頁面沒開、在背景，或使用者改用手機 app）→ **直接用傳統 AskUserQuestion**，不寫 outbox
2. **寫入題目**：用 Write 建立 `.auq/outbox/<簡短英文 id>.json`，格式與 AskUserQuestion 的 `questions` 相同：
   ```json
   {
     "questions": [
       {
         "header": "版面",
         "question": "首頁要用哪種版面配置？",
         "multiSelect": false,
         "options": [
           { "label": "左右分欄 (Recommended)", "description": "側欄導覽 + 主內容", "preview": "┌────┬────────┐\n│Nav │Content │\n└────┴────────┘" },
           { "label": "上下堆疊", "description": "頂部導覽列" }
         ]
       }
     ]
   }
   ```
   - 1～4 題，每題 2～4 個選項，`label` 不可重複；`preview` 選填（有的話頁面會左右分欄顯示）
   - 不用自己加 Other，頁面每題都會附 Other 自填與備註
   - id 只用英數、`-`、`_`；重複時 server 會自動加後綴
3. 寫入後告訴使用者「題目已送到網頁」，**結束這一輪回覆等待 Monitor 通知**，不要輪詢
4. 依 Monitor 收到的內容處理：

| 通知 | 意義 | 處理 |
|------|------|------|
| `[AUQ] answer <id> N questions` + 每題一行 `Q1 [header] 題目 => 答案 \| 備註: ...` | 使用者已作答 | 當成 AskUserQuestion 的回答繼續工作；`Other: ...` 是自填答案 |
| `[AUQ] cancel <id>` | 使用者按「略過」 | 等同拒絕回答，依情境用預設做法或在對話中詢問 |
| `[AUQ] fallback <id> :: <原因>` | 頁面沒開或長時間不在前景（例：使用者改用手機 app） | **立即用傳統 AskUserQuestion 重問同一組題目** |
| `[AUQ:error] <檔名> :: <原因>` | 題目格式錯誤（檔案已移到 `.auq/processed/*.invalid.json`） | 修正後用新檔名重寫 |

- 完整答案 (含結構化欄位) 存在 `.auq/inbox.jsonl`，以 id 查最後一筆即可；只追加不改寫
- 同一時間可以有多組題目，答案依 id 對應

## 結束

使用者說結束或不再需要時，停止 server 背景工作與 Monitor（TaskStop），之後恢復使用傳統 AskUserQuestion。
