# askUserQuestion Web

在瀏覽器回答 Claude Code 的 AskUserQuestion。沿用 webToAgent skill 的核心技術：本機 Node bridge server + stdout 標記行 + Claude Code Monitor 監看，方向反轉為「Claude 出題 → 使用者在網頁作答」。

## 特色
- 題目格式與 AskUserQuestion 相同（1～4 題、每題 2～4 個選項、單選 / 複選）
- 選項有 `previewHtml`（HTML，可用 tailwind）或 `preview`（純文字）時左右分欄預覽（手機上下堆疊）
- 每題自動附 Other 自填與備註
- 新題目到達時發出提示音與桌面通知
- **使用者不在電腦前時自動改回傳統 AskUserQuestion**（例：改用 Claude Code 手機 app）

## 架構
```
Claude ──Write──▶ .auq/outbox/<id>.json ──fs.watch──▶ server.js ──SSE──▶ 瀏覽器
Claude ◀─Monitor── .auq/server.log ◀──stdout [AUQ]── server.js ◀─POST /api/answer── 瀏覽器
```

| 檔案 | 用途 |
|------|------|
| `server.js` | 零相依的 Node server（只綁 127.0.0.1） |
| `public/` | 作答頁面（tailwind + daisyUI CDN） |
| `SKILL.md` | Claude Code skill 說明（啟動、出題、收答、fallback、結束） |
| `scripts/install-skill.sh` | 安裝成 skill 到 `~/.claude/skills/askuserquestionweb` |

## 安裝與使用
```bash
scripts/install-skill.sh
```
在 Claude Code 輸入 `/askuserquestionweb` 或說「啟動 askUserQuestion 網頁版」，開啟回報的網址，按「🔔 啟用通知」。

單獨執行（除錯用）：`node server.js [--port 5700] [--idle-close-sec 60]`；判斷出題方式：`node detect.mjs`

## 出題方式判斷（detect.mjs）
Claude Code 沒有提供「目前是否用手機 app」的資訊，先判斷使用者在哪，再看 server 與頁面狀態：

比較兩個時間，**較新者勝**：
- 桌機最後一次鍵盤滑鼠操作：現在 − macOS 系統閒置秒數
- 最後一則手機訊息：session 紀錄中最後一則使用者訊息有 `queueSkipSlashCommands: true`（手機 app 送出）時的時間戳記

手機訊息較新 → 在手機；桌機操作較新或沒有手機訊息 → 在電腦前

| 輸出 | 條件 | Claude 的動作 |
|------|------|--------------|
| `classic` | 在手機 | 傳統 AskUserQuestion |
| `start` | 在電腦前，server 沒在跑 | 重啟 server、開頁、等連線後網頁出題 |
| `open` | 在電腦前，頁面沒開 | 開頁、等連線後網頁出題 |
| `web` | 在電腦前，頁面已連線 | 網頁出題（頁面在背景也一樣，靠提示音與通知） |

- 已出題後，只有作答頁面全部關閉 10 秒才自動 fallback；使用者從手機傳訊息時，Claude 撤回網頁題目改用傳統方式重問
- 最後一題結束後 1 分鐘（`--idle-close-sec`）沒有新題目，頁面自動斷線並嘗試關閉，server 繼續待命
- 限制：工作中插話與 AskUserQuestion 的回答沒有來源欄位；訊息來源是 Claude Code 內部欄位，改版可能失效

## stdout 標記
| 標記 | 意義 |
|------|------|
| `[AUQ:ready] <url>` | 啟動完成 |
| `[AUQ:asked] <id>` | 題目已推到頁面（Monitor 不監看） |
| `[AUQ] answer <id>` + `Q1 [header] 題目 => 答案 \| 備註: ...` | 已作答 |
| `[AUQ] cancel <id>` | 使用者略過 |
| `[AUQ] fallback <id> :: <原因>` | 有未答題目時頁面全部關閉，改回傳統 AskUserQuestion |
| `[AUQ:idle-close]` | 閒置通知頁面關閉（Monitor 不監看） |
| `[AUQ:error] ...` | 題目格式錯誤或啟動失敗 |

## 安全
- 只綁 `127.0.0.1`；作答 API 檢查 Origin，防止其他網站跨站送出假答案
- 出題只能透過本機檔案系統，網頁無法偽造題目；題目檔與 body 有大小上限
- 頁面一律以 `textContent` 呈現題目，避免 XSS；`previewHtml` 放在 `sandbox="allow-scripts"`（無 same-origin）的 iframe，無法存取主頁面與 API
- 答案只存在本機 `.auq/`（已列入 `.gitignore`）
