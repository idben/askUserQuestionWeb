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

單獨執行（除錯用）：`node server.js [--port 5700]`；判斷出題方式：`node detect.mjs [--idle-sec 60]`

## 自動改回傳統 AskUserQuestion 的判斷
Claude Code 沒有提供「目前是否用手機 app」的資訊，`detect.mjs` 結合三個訊號判斷（依序，任一成立即決定）：

| 順序 | 條件 | 出題方式 |
|------|------|---------|
| 1 | 作答頁面沒開或 server 未執行 | 傳統 |
| 2 | macOS 系統閒置 < 60 秒（剛動過鍵盤滑鼠） | 網頁（頁面在背景也一樣） |
| 3 | session 紀錄中最後一則使用者訊息有 `queueSkipSlashCommands: true`（手機 app 送出） | 傳統 |
| 4 | 其他 | 網頁 |

- 已出題後，只有作答頁面全部關閉 10 秒才自動 fallback；使用者從手機傳訊息時，Claude 撤回網頁題目改用傳統方式重問
- 限制：工作中插話與 AskUserQuestion 的回答沒有來源欄位；訊息來源是 Claude Code 內部欄位，改版可能失效

## stdout 標記
| 標記 | 意義 |
|------|------|
| `[AUQ:ready] <url>` | 啟動完成 |
| `[AUQ:asked] <id>` | 題目已推到頁面（Monitor 不監看） |
| `[AUQ] answer <id>` + `Q1 [header] 題目 => 答案 \| 備註: ...` | 已作答 |
| `[AUQ] cancel <id>` | 使用者略過 |
| `[AUQ] fallback <id> :: <原因>` | 頁面全部關閉，改回傳統 AskUserQuestion |
| `[AUQ:error] ...` | 題目格式錯誤或啟動失敗 |

## 安全
- 只綁 `127.0.0.1`；作答 API 檢查 Origin，防止其他網站跨站送出假答案
- 出題只能透過本機檔案系統，網頁無法偽造題目；題目檔與 body 有大小上限
- 頁面一律以 `textContent` 呈現題目，避免 XSS；`previewHtml` 放在 `sandbox="allow-scripts"`（無 same-origin）的 iframe，無法存取主頁面與 API
- 答案只存在本機 `.auq/`（已列入 `.gitignore`）
