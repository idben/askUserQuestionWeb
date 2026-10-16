#!/usr/bin/env bash
# 把 askUserQuestion Web 安裝成 Claude Code skill：複製 server.js、detect.mjs、presence.mjs、public/、SKILL.md 到 ~/.claude/skills/askuserquestionweb
set -euo pipefail

srcDir="$(cd "$(dirname "$0")/.." && pwd)"
destDir="${HOME}/.claude/skills/askuserquestionweb"

mkdir -p "$destDir"
rm -rf "$destDir/public"
cp "$srcDir/server.js" "$srcDir/detect.mjs" "$srcDir/presence.mjs" "$srcDir/package.json" "$srcDir/SKILL.md" "$destDir/"
cp -R "$srcDir/public" "$destDir/public"

echo "已安裝到 $destDir"
echo "在 Claude Code 輸入 /askuserquestionweb 或說「啟動 askUserQuestion 網頁版」即可使用"
