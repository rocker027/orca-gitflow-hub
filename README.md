# Orca GitFlow Hub

Orca ADE 的工作樹管理與本機收尾面板。參考 [Worktrunk](https://worktrunk.dev/) 的 list／switch／merge 工作流程，讓建立、開啟、提交、合回與清理集中完成。

## 主要操作

1. **開始新工作**：點首頁主按鈕，輸入工作名稱（例如「修正登入畫面」），再點「建立並開啟工作」。系統預填起點分支；需要更換分支或啟動 AI 助手時，展開「調整起點與 AI 助手」。預設不啟動 AI。
2. **繼續工作**：首頁分開顯示進行中的工作與主要分支。從工作卡片直接開啟，或點「查看變更」確認檔案。搜尋沒有結果時，可一鍵清除。
3. **完成並合併**：選合併位置，填寫這次完成內容，再點「下一步：確認合併內容」。不知道怎麼寫時，可點「請 AI 幫我寫」，見下方「請 AI 撰寫完成說明」。確認頁列出來源、目標、全部變更檔案及是否移除來源資料夾；「返回修改」會保留欄位。
4. **查看結果**：成功、部分完成與尚未執行分開顯示。部分完成時先開啟工作核對結果，不直接重送。主要分支不提供「完成並合併」入口，並說明它用來接收完成的工作。

這裡的「工作」對應一個 Git 工作樹（獨立資料夾）。工作名稱也用作新分支名稱，Orca 在名稱已用過時會加數字後綴並回傳實際名稱。建立及合併採專注畫面，可隨時返回工作清單；執行期間禁止切換或重複執行。合併後預設移除來源工作資料夾，保留本機分支；可取消勾選保留資料夾。

面板會跟著 Orca 目前開啟的工作樹自動更新，不必按「重新整理」。切換到另一個工作樹時，尚未送出的建立、合併與 PR 欄位會清空，舊的確認頁也會失效，避免把輸入帶到錯的工作。只開關或更名終端不會清空欄位。建立或合併執行中切換時，會等操作完成並保留結果，再更新到新的工作樹。如果建立或合併自動開啟了結果所在的工作樹，切換事件晚到時仍會保留逐步結果。操作完成後改切到其他工作樹時，結果會清除。

## 請 AI 撰寫完成說明

在「完成並合併」頁點「請 AI 幫我寫」，面板會先說明要傳送的內容，可展開查看全文。按「確認傳送給 Claude」後，大約 10–60 秒，寫好的說明會取代「這次完成了什麼」的內容，你可以再修改。取消、修改欄位或切換工作樹，都會撤回尚未確認的傳送。

- **會傳送的內容**：這次未提交的變更，包括 staged、unstaged 與新檔案的文字內容，會傳給 Claude，也就是 Anthropic 的 AI 服務。內容超過 10 萬字時只傳前面的部分。新檔案每個最多傳 8000 位元組，二進位檔只列出檔名。`@` 會改成全形「＠」，避免被 Claude Code 當成檔案提及去讀取。
- **機密檢查**：下列情況會直接停止，不會傳送。
  - 變更涉及 `.env`、私鑰、`.npmrc`、`.netrc`、`.git-credentials`、`*.tfvars`、`kubeconfig` 等敏感檔，包括已刪除或改名的檔案。
  - 變更內容（包括刪除的行）含有私鑰，或 AWS、GitLab、GitHub、Anthropic、Stripe、Slack、Google、npm 的金鑰格式。

  這只是常見格式的檢查，無法保證沒有機密，送出前請展開確認內容。
- **Claude 的權限**：Worker 在背景以固定參數執行本機的 `claude` 命令列（`-p --output-format json --restricted --strict-mcp-config --disable-slash-commands --tools ""` 等）。Claude 沒有任何工具或 MCP，也不讀你的 Claude Code 設定檔與 hooks，只能回傳文字。執行目錄是用完即刪的暫存資料夾，所以不會讀到專案的 `CLAUDE.md`。個人層級的 `~/.claude/CLAUDE.md` 可能仍會載入，這一點尚未實測。撰寫期間不會鎖住儲存庫，面板逾時或關閉時會停止 `claude`。
- **前提**：本機要已安裝並登入 Claude Code（`claude`）。未登入或找不到命令時，面板會顯示原因，並提示先在終端執行 `claude` 確認登入。
- **只支援 Claude**：Codex 的唯讀沙箱仍能讀取整個磁碟，無法用同樣方式關閉，所以暫不提供。

合併保留既有提交歷史：可快轉則快轉，分歧時建立合併提交。未自動 squash 或 rebase。收尾只更新本機，不 Push、不建立 PR。無新變更時沿用既有提交。

Git Diff、勾選暫存、手動提交、AI 提交訊息與 GitHub Draft PR 保留在工作「查看變更」的進階操作中。GitHub PR 審查與遠端合併仍在 GitHub 完成。AI Code Review pipeline 與批次管理尚未實作。

本機收尾功能的驗證範圍與實際結果見[驗證紀錄](/Users/devrune/Documents/code/ai-sdlc-hub/projects/orca-gitflow-hub/initiatives/AISDLC-2026-1105-worktree-finish/verification.md)。真實 Git 收尾使用隔離儲存庫；fixture 通過不等於使用者專案或 GitHub 寫入已驗證。

本次介面調整見[新手導向介面驗證紀錄](/Users/devrune/Documents/code/ai-sdlc-hub/projects/orca-gitflow-hub/initiatives/AISDLC-2026-1105-guided-ui/verification.md)（local-only）。面板測試驗證操作與狀態，不代表已完成真人可用性、鍵盤或讀屏測試。

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

本機收尾採一次預覽、一次確認。預覽涵蓋全部 staged、unstaged 與 untracked 變更，並非只提交勾選檔案。要分批提交時，先到「查看變更」使用手動 Git 操作。

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
