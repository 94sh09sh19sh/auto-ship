# auto-ship

Claude Code 改完 repo 裡的檔，回合結束時自動要求 commit＋push 到目前分支；新增 repo 前先問公開或私人。

## 運作方式
- `PreToolUse`（Write、Edit、MultiEdit、NotebookEdit、Bash、PowerShell）：第一次碰到某個 repo 時記下基準（HEAD 與 `git status`）；Bash 會看 cwd、`cd <路徑>`、`git -C <路徑>`。
- 同一個 hook 也檢查新增 repo 的指令（`git init`、`gh repo create`、`toolkeeper new`）：這個 session 還沒選可見性就 deny；`gh repo create` 帶的 `--public`／`--private` 要跟使用者選的一致。
- `PostToolUse`（AskUserQuestion）：從答案讀出「公開／私人」；`UserPromptSubmit`：使用者在 prompt 裡提到 repo 並講了公開或私人，或很短的回覆，也算。
- `Stop`：比對基準，列出各 repo 的未 commit 檔與未 push 的 commit，用 `decision: block` 要求 Claude 處理；commit 訊息由 Claude 自己寫，不機械式 commit。
- 只算這個 session 改的檔；開始前就未 commit 的檔、疑似機密檔（`.env`、`*.pem`、`*.key` 等）另外列出、要求不要加。
- 新 repo 沒有遠端時，提示 `gh repo create <名稱> --<可見性> --source . --push`；沒有遠端的既有 repo 只要求 commit；detached HEAD 只 commit 不 push。
- 擋一次後同樣狀況還是停下就放行並提醒使用者，不會無限迴圈；沒事時完全不輸出。

## 安裝
- 把 `hook.js`、`lib.js`、`config.json` 放到 `~/.claude/auto-ship/`，在 `settings.json` 掛上 `deploy.json` 列的四個事件。
- 建議在全域 `CLAUDE.md` 加一條「改完 repo 一律 commit＋push 到目前分支；新增 repo 前先問公開或私人」，讓 Claude 主動做，hook 當最後一道關卡。

## 設定
- 預設值在 `config.json`；個人設定放執行端的 `config.local.json`，不會被部署覆蓋，也不會進 repo。
- `skip`：不要自動 commit＋push 的 repo 路徑（含子資料夾）。
- `exempt`：完全不追蹤、也不擋 `git init` 的資料夾；`exemptTmp: true` 時系統暫存資料夾也算。
- `debug: true`：把每個事件的輸入存到 `state/<session>/debug-<事件>.json`，用來查 hook 收到什麼。

## 限制
- 可見性一個 session 問一次，同一個 session 建第二個 repo 沿用同一個答案。
- Bash 指令裡用變數或子 shell 切換資料夾，追不到；這種情況靠 CLAUDE.md 規則。
- 多個 Stop hook 同時跑時（例：iter-chain 判斷本輪結束），對方可能在 commit 完成前就先動作。

## 現成方案比較
- `gitwatch/gitwatch`（1.7k 星，GPL-3.0）：監看檔案、每次變動就自動 commit＋push。缺 R：Windows 要另裝監看工具、commit 訊息只有時間戳記、不分本 session 與使用者原有的改動、沒有新增 repo 的可見性詢問。吸收：只參考「改了就推」的目標。
- `carlrannaberg/claudekit`（763 星，MIT）：Stop 時用 `git stash create` 存檢查點。缺 R：不 commit 到分支、不 push。吸收：沒改動時完全不輸出。
- `atompilot/claude-code-auto-commit`（0 星，MIT）：`/auto-commit` 指令。缺 R：要手動叫用。吸收：staging 前偵測 `.env`、金鑰等機密檔。
- `meszmate/checkpoints`（0 星，無授權）：checkpoint skill 在里程碑時 commit。缺 R：靠 Claude 自己記得、不強制。吸收：只 stage 相關的檔，不一律 `git add -A`。
- 搜尋到的其他 ≥1000 星結果都是大型合集或不相關工具（星數屬於整個合集），沒有符合需求的單一功能。
