# askUserQuestion Web

在瀏覽器回答 Claude Code 的 AskUserQuestion。沿用 webToAgent skill 的核心技術：本機 Node bridge server + stdout 標記行 + Claude Code Monitor 監看，方向反轉為「Claude 出題 → 使用者在網頁作答」。

## 特色
- 題目格式與 AskUserQuestion 相同（1～4 題、每題 2～4 個選項、單選 / 複選）
- 選項有 `preview` 時左右分欄預覽（手機上下堆疊）
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

單獨執行（除錯用）：`node server.js [--port 5700] [--fallback-sec 60]`

## 自動改回傳統 AskUserQuestion 的判斷
Claude 無法直接得知使用者用哪個裝置，改用「桌面頁面是否可見」（Page Visibility API）判斷：

| 情況 | 行為 |
|------|------|
| 出題前 `.auq/presence.json` 的 `visible` 為 0 | Claude 直接用傳統 AskUserQuestion |
| 已出題，沒有開著的頁面 | 10 秒後 server 印 `[AUQ] fallback`，Claude 改用傳統方式重問 |
| 已出題，頁面開著但在背景 | `--fallback-sec`（預設 60 秒）後 fallback，期間有提示音與通知 |

## stdout 標記
| 標記 | 意義 |
|------|------|
| `[AUQ:ready] <url>` | 啟動完成 |
| `[AUQ:asked] <id>` | 題目已推到頁面（Monitor 不監看） |
| `[AUQ] answer <id>` + `Q1 [header] 題目 => 答案 \| 備註: ...` | 已作答 |
| `[AUQ] cancel <id>` | 使用者略過 |
| `[AUQ] fallback <id> :: <原因>` | 改回傳統 AskUserQuestion |
| `[AUQ:error] ...` | 題目格式錯誤或啟動失敗 |

## 安全
- 只綁 `127.0.0.1`；作答 API 檢查 Origin，防止其他網站跨站送出假答案
- 出題只能透過本機檔案系統，網頁無法偽造題目；題目檔與 body 有大小上限
- 頁面一律以 `textContent` 呈現題目，避免 XSS
- 答案只存在本機 `.auq/`（已列入 `.gitignore`）
