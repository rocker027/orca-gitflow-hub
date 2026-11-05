# Orca GitFlow Hub

Orca ADE 的工作樹管理與本機收尾面板。參考 [Worktrunk](https://worktrunk.dev/) 的 list／switch／merge 工作流程，讓建立、開啟、提交、合回與清理集中完成。

## 主要操作

1. **工作樹清單**：預設開啟目前 Orca 專案，顯示變更數、相對目標的領先／落後與最後提交。可搜尋分支，直接開啟、檢視或收尾。
2. **建立並開啟**：輸入 `feature/login` 這類分支名稱與基準，單擊建立。預設不啟動 Agent；名稱已被使用時，Orca 會加數字後綴並回傳實際名稱。
3. **本機收尾**：選擇同一儲存庫的目標工作樹，填提交訊息，預覽全部待提交檔案與流程，確認後依序提交、合回、開啟目標、清理來源。
4. **逐步結果**：提交完成但合併衝突，或合併完成但清理受阻，都保留現場與每一步結果。可選擇保留來源工作樹。

合併保留既有提交歷史：可快轉則快轉，分歧時建立合併提交。未自動 squash 或 rebase。收尾只更新本機，不 Push、不建立 PR。無新變更時沿用既有提交。

Git Diff、勾選暫存、手動提交、AI 提交訊息與 GitHub Draft PR 保留在工作樹「檢視」的進階操作中。GitHub PR 審查與遠端合併仍在 GitHub 完成。AI Code Review pipeline 與批次管理尚未實作。

本次驗證範圍與實際結果見[驗證紀錄](/Users/devrune/Documents/code/ai-sdlc-hub/projects/orca-gitflow-hub/initiatives/AISDLC-2026-1105-worktree-finish/verification.md)。真實 Git 收尾使用隔離儲存庫；fixture 通過不等於使用者專案或 GitHub 寫入已驗證。

## 環境與 GitHub 登入

需要 Orca Desktop `>=1.4.249`、Git 與 Orca 登錄的本機 Git 工作區。開發工具使用 Node.js 22 與 npm。
工作區須已有 Git commit；MVP 不支援 bare repository、遠端工作區或建立第一個 commit。
AI 草稿需要所選 Agent 已在 Orca 設定完成。

GitHub 功能需要 [GitHub CLI（gh）](https://cli.github.com/)，並確認 Worker 的 `PATH` 能找到 `git` 與 `gh`。
本次開發環境已安裝 `gh 2.102.1`，認證狀態檢查已通過；私人 PR 寫入尚未驗證。以 GitHub.com 為例：

```sh
gh --version
gh auth login --hostname github.com
gh auth status --hostname github.com
```

認證與憑證保存由 `gh` 管理，Hub 不把 Token 保存到外掛 storage。
Git Push 的 SSH／HTTPS 認證也必須已設定；Worker 不開啟互動式登入提示。
MVP 僅支援 `github.com`；GitHub Enterprise Server 尚未支援。登入細節見 [官方登入命令](https://cli.github.com/manual/gh_auth_login)與[狀態查詢](https://cli.github.com/manual/gh_auth_status)。

## 開發、檢查與載入

```sh
npm ci
npm run typecheck
npm test
npm run test:panel
npm run check
npm run validate
npm run package
orca plugin inspect .orca/package/gitflow-hub
```

型別、服務測試、Orca 測試工具、面板情境與 manifest 檢查各自驗證不同層。
fixture／mock 通過不代表真實 Orca、Agent 或 GitHub 流程已驗證。

`npm run package` 將 manifest、執行期原始碼與 README 複製到 `.orca/package/gitflow-hub`，排除 test／check 檔案與開發依賴。
請檢查及載入此打包目錄。原始碼目錄的 `check`／`validate` 會略過開發依賴，但嚴格的 `inspect` 可能因 `node_modules` 連結而拒絕。

```sh
orca plugin dev watch .orca/package/gitflow-hub
```

首次載入可信 Worker 需要檢視並核准 Orca 顯示的存取權限。若回報 `approval_required`，依 CLI 回傳的 fingerprint 與命令操作。
也可在 Settings → Plugins → Development folders 加入打包目錄並啟用。監看期間按 Ctrl-C 會卸載開發外掛。
修改原始碼後重新執行 `npm run package`，讓監看中的打包目錄更新。

本機 `plugin create`／`plugin types` 曾缺少打包的 `orca.d.ts`。專案已放入固定官方版本型別，見 [型別來源](vendor/orca/README.md)；這些檔案不取代 Orca runtime。

## 預覽與確認

本機收尾採一次預覽、一次確認。預覽涵蓋全部 staged、unstaged 與 untracked 變更，並非只提交勾選檔案。要分批提交時，先到「檢視」使用手動 Git 操作。

建立工作樹由表單直接確認，內部仍核對預覽與執行身分。其餘 Git／GitHub 寫入與 AI 委派保留預覽確認。
預覽綁定來源與目標的身分、HEAD、內容及參數，10 分鐘後失效。編輯輸入、切換工作樹或內容改變後需重新預覽。
Agent 權限由 Orca 設定控制；限定任務的提示詞沒有替 Agent 新增唯讀沙箱。

## 限制與恢復

- 僅支援本機工作區與同儲存庫 GitHub PR，拒絕 fork PR。
- `origin` 接受無內嵌憑證的 HTTPS、SSH 或 SCP URL。Git 展開後的 fetch／push 目的地須可核對；目前 Push 要求兩者 URL 一致。
- 不自動 fetch、force push、reset、刪分支、發布審查留言或遠端合併。未追蹤檔案會列出，但暫存前不會出現在一般 Git Diff。
- 清理拒絕主要工作區與預設分支、dirty／untracked／ignored 檔案、submodule、鎖定、進行中的 Git 操作，以及無法證明已合併的 HEAD。
- 收尾前需確認來源與目標都沒有存活或狀態不明的終端／Agent。已完成的 Agent 歷史可保留；閒置 shell 仍需關閉。清理完成保留本機分支。
- 本機收尾要求目標乾淨，來源為功能工作樹，且雙方都已登錄 Orca。不支援 detached HEAD、submodule、進行中的 Git 操作、未知鎖或隱藏變更的 index flags／稀疏 checkout。Git 需支援 `merge-tree --write-tree`。
- 衝突預檢失敗時，來源可能已提交，目標尚未合併。實際 merge／hook 失敗則可能已寫入目標，顯示 UNKNOWN 並保留現場，不自動 rollback 或重送。
- PR 建立逾時後只查詢，不重送 POST。結果未知時先在 GitHub 查明。PR 已建立但 Orca 關聯失敗時，可重新預覽以復用 PR 並補關聯。
- 分頁超限會回報無法完整讀取。Checks、留言或審查資訊無權限時保留警告，不顯示為通過。
- PR 使用 GitHub 的 `draft: true` 建立，草稿不是標題文字。`mergeable: null` 代表尚未取得可合併性結果；checks 全綠或 reviews 已核准也不取代 GitHub 分支保護與權限規則。

若中斷留下 `gitflow-hub.lock`，先確認沒有 Hub／Git／Orca CLI 操作仍在執行，並核對前次寫入的實際結果。
在工作區執行 `git rev-parse --path-format=absolute --git-common-dir` 找到共用 Git 目錄。
確認為遺留鎖後，才人工以 `rmdir` 移除其中的空 `gitflow-hub.lock` 目錄。外掛不自動清鎖。
重新整理並產生新預覽，不要直接重送結果未知的操作。

## 信任與文件

`trusted-worker` 以目前使用者權限執行 Node.js、Git、Orca CLI 與 `gh`，可存取該使用者的檔案與網路。
程式使用固定 argv／stdin、逾時與輸出上限，並過濾 Git 控制環境變數。Git commit／merge 保留儲存庫既有 hooks，請只對可信任的儲存庫使用。
外掛鎖只協調 Hub 寫入；外部 Agent 或使用者仍可能同時操作 Git。

- [架構與失敗處理](docs/architecture.md)、[收尾驗證矩陣](docs/finish-safety-matrix.md)、[GitHub／基礎操作安全矩陣](docs/security-matrix.md)
- 現行計畫：[AISDLC-2026-1105-worktree-finish](/Users/devrune/Documents/code/ai-sdlc-hub/projects/orca-gitflow-hub/initiatives/AISDLC-2026-1105-worktree-finish/plan.md)（local-only）。
- Worktrunk 參考：[list](https://worktrunk.dev/list/)、[switch](https://worktrunk.dev/switch/)、[merge](https://worktrunk.dev/merge/)。本專案沿用 Native Git 與 Orca，不需要安裝 Worktrunk。
- Orca 官方依據固定於 [`318f5432931cb0800414740832123ef04c186dc5`](https://github.com/stablyai/orca/tree/318f5432931cb0800414740832123ef04c186dc5)：[Plugin Authoring](https://github.com/stablyai/orca/blob/318f5432931cb0800414740832123ef04c186dc5/docs/reference/plugin-authoring.md)、[CLI](https://github.com/stablyai/orca/blob/318f5432931cb0800414740832123ef04c186dc5/docs/site/content/docs/cli/reference.mdx)。
