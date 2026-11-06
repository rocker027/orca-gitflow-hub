# 架構與操作契約

GitFlow Hub 以 Orca TSX 面板與可信 Worker 管理工作樹及本機收尾。GitHub PR 保留為次要功能。驗證層級與結果以現行 initiative 的 verification.md 為準。

## 元件責任

| 元件 | 原始碼 | 責任 |
| --- | --- | --- |
| 面板 | `src/panel.tsx`、`src/panel-state.ts` | 工作樹清單、聚焦收尾與進階 Git／PR；預覽與確認；忽略切換工作區後到達的舊回應 |
| 面板契約 | `src/protocol.ts`、`src/contracts.ts` | request、操作參數與回覆型別 |
| Worker／Hub | `src/worker.ts`、`src/hub.ts` | 重新解析工作區，編排服務與預覽執行 |
| 操作紀錄 | `src/operations.ts`、`src/actions.ts` | 參數驗證、預覽 token、持久狀態與 repo 寫入鎖 |
| Orca 服務 | `src/services/orca.ts` | Worktree、Agent、PR 關聯；Worktree 生命週期由 Orca 唯一管理 |
| Git 服務 | `src/services/git.ts` | 狀態、Diff、內容指紋、暫存、提交、Push 與清理檢查 |
| 清單摘要 | `src/services/overview.ts` | 輕量狀態、ahead／behind、最後提交；錯誤保留 UNKNOWN |
| 本機收尾 | `src/finish-workflow.ts`、`src/services/finish.ts`、`src/finish-text.ts` | 版本綁定、提交、合成、rebase、合併、開啟與清理的逐步結果；確認頁白話文字 |
| GitHub 服務 | `src/services/github.ts` | Host／owner／repo、Draft PR、分頁查詢與審查資訊 |
| 程序執行器 | `src/services/process.ts` | `shell: false`、argv／stdin、逾時、輸出上限與取消 |

面板只傳工作區 ID 與定義好的操作欄位，不接受任意命令或 cwd。
Hub 從 Orca 清單取得路徑，核對本機身分、實體路徑與 Git top-level，再交給服務。
開啟工作區使用 Orca host API；Git 與 GitHub 資料操作由 Worker 呼叫 CLI。
PR 清單與詳細資料分別走 `hub.prs`、`hub.pr`；契約保留 PR number、HEAD SHA、checks、reviews 與未知狀態。

## 預覽與寫入

1. `hub.preview` 驗證參數，讀取工作區與 Git snapshot，建立預覽 token。
2. 指紋包含 HEAD、分支、index、Diff 與未追蹤內容。預覽保存完整操作參數，必要時保存基準 SHA 與 GitHub 身分。
3. 確認後 `hub.execute` 只接收 token。有效期限 10 分鐘，執行前重新核對工作區、指紋與版本。
4. 寫入使用 Git common dir 下的 `gitflow-hub.lock` 目錄，同 repository 的 Hub 操作共用此鎖。
5. 操作由 `prepared` 進入 `running`，再進入 `succeeded` 或 `failed`。成功 token 重送只回傳已存結果，執行中或失敗 token 不重跑。

Worker 中斷可能留下 `running` 紀錄或鎖。重新啟動不代表先前寫入失敗，需查實際 Git／Orca／GitHub 狀態。
鎖只協調 Hub，不能阻止外部 Agent、終端或編輯器同時修改 Git。指紋與原生 Git 鎖不構成跨程序交易。

## 工作樹清單與本機收尾

`hub.dashboard` 預設採用 Orca `isActive` 所在專案，僅對所選專案查詢輕量摘要。目標預設選登錄的預設分支工作樹，再退至主要工作樹。摘要無完整 Diff；檢視／收尾才讀詳細 snapshot。錯誤不當作乾淨，非同步舊回覆不覆蓋新選擇。

建立表單單擊「建立並開啟」，內部仍依序 preview／execute，操作期間停用重複送出。Orca 管理分支名稱後綴及完整工作樹 ID，Hub 開啟實際回傳 ID。收尾則保留獨立預覽與確認。表單只選目標、合併方式和是否合成提交。提交訊息由來源分支自動產生，確認頁可查看；清理與選用 AI 風險評估放在「其他選項」。

1. 核對來源為功能工作樹、目標屬同 Orca repo 與 canonical Git common dir，雙方沒有活動中或未知程序、Git 操作或鎖。目標須乾淨。若選擇移除資料夾且來源已有 ignored 檔，預覽先拒絕並提示取消移除，避免合併後才發現不能清理。
2. 預覽列出來源全部變更；固定雙方身分、HEAD、內容、提交訊息與清理選項。參數與計畫可序列化保存於 token。
3. 鎖定共用 repo 後重新驗證，僅暫存列出的合法路徑，再提交。驗證新提交的 parent 與 tree，hook 改寫不視為預覽內容。
4. 依使用者選擇整理來源。每一步改寫前都以 `merge-tree --write-tree` 模擬，衝突就停止，不改寫來源也不碰目標。
   - 合成（squash）：`commit-tree <來源 tree> -p <共同起點>` 建立單一提交，`update-ref` 比對舊值後更新來源分支；tree 不變，來源工作樹仍乾淨。不執行 commit hooks，`commit.gpgSign=true` 時加 `-S`。
   - rebase：目標已前進、且來源還有未併入的提交才執行。以 `merge-tree --merge-base` 逐提交串接模擬，被忽略的本機檔案會被寫到時拒絕，再以固定參數執行 `git rebase`，結果 tree 必須等於模擬。失敗時由 Hub abort 自己的 rebase 並核對已還原，無法核對才標 UNKNOWN。
5. 再核對雙方狀態，合併固定來源 SHA。merge 可快轉則快轉、分歧則建立合併提交；rebase 只用 `--ff-only`。合併後驗證雙方 ancestry 與 tree。四種組合結束時，來源 HEAD 都是目標的祖先，清理檢查不需放寬。
6. 若選擇清理，再核對雙方版本、來源無變更／ignored 檔案、來源 SHA 已合入及活動狀態。由 Orca 移除，保留分支；核對 Orca 清單與實際目錄均已移除。
7. 最後開啟目標工作樹，避免 Orca 自動開啟的終端阻擋前一步清理。若切換失敗，結果仍保留已合併、已清理的證據，提供目標工作樹供再次開啟。

結果只列本次相關步驟（`commit`、`squash`、`rebase`、`merge`、`cleanup`、`open`），每一步保留 `done`／`skipped`／`failed`。中途失敗以 `needs_attention` 回覆已完成步驟，舊 token 不重做。命令失敗但可能已寫入時標示 UNKNOWN，保留現場。GitHub API 不參與本機收尾。完整邊界見 [F1–F18 矩陣](finish-safety-matrix.md)。

## Git 與 AI 草稿

暫存只接受目前狀態列出的選取路徑，以 literal pathspec 傳入 Git，拒絕越界路徑與不支援的連結。
提交涵蓋全部已暫存內容，包含外部工具先前暫存的檔案。預覽列出檔案、訊息與 Diff，並執行有限的敏感檔案／私鑰檢查；這不是完整秘密掃描器。
Diff 禁用 external diff 與 textconv，避免讀取時觸發這些自訂程式。Git commit 保留 hooks，預覽會明說。

AI 草稿沿用 Orca 的 Codex／Claude Code／OMP 設定。Hub 送出 staged Diff 與限定產生訊息的提示詞，提供 Git 目錄內的草稿路徑。
Agent 完成後由使用者匯入 UTF-8 純文字。Hub 核對原 snapshot、檔案型態與大小，再填入訊息欄位；仍需預覽確認提交。
Agent 權限取決於 Orca 設定，提示詞不能代替唯讀沙箱。Diff、提交訊息與 Agent 回覆不當作 Shell 命令執行。

## GitHub 身分與 Draft PR

`identity()` 讀取 `git remote get-url --all origin` 與 `--push --all origin` 的展開結果，涵蓋 `insteadOf`／`pushurl`。
MVP 要求單一、可解析且同 GitHub.com owner／repo 的目的地，拒絕其他 Host。Git Push 另要求 fetch／push URL 一致，並比對預覽 URL。
接受 HTTPS、SSH 或 SCP，不接受 HTTP、內嵌 HTTPS 憑證、模糊路徑與 fork PR。
`gh api` 明確傳 `--hostname` 與 `/repos/{owner}/{repo}` 路徑，驗證回覆的 repository ID、PR 與連結身分。
PR number 只在指定儲存庫內有意義，不能單獨當成跨儲存庫識別。Token 由 `gh` 管理，Hub 不提供 Token 欄位或另存 Token。

Push 與 Draft PR 是獨立預覽操作。建立前核對本機分支／HEAD、遠端 SHA、預覽身分，並查詢相同 head／base 的既有 PR。
不存在時才以 JSON stdin 呼叫建立 PR API，傳入 `head`、`base`、`title`、`body` 與 `draft: true`。
草稿狀態由 GitHub 的布林欄位表達，不依賴標題前綴。Hub 不自動 Push、force push 或 merge。[建立 PR 契約](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)

若 POST 逾時或回覆不符，只查回已建立的 PR，不再 POST。仍無法確認時回報 `UNKNOWN`。
PR 已建立但 Orca reference 關聯失敗時保留 URL；重新預覽可復用 PR 並補關聯。
這是失敗恢復策略，不宣稱 GitHub API 提供跨程序 exactly-once 保證。

## Checks、留言與審查

CI 查詢綁定 PR 的 `headSha`，同時讀取 check runs 與 commit statuses，避免誤用其他分支或舊提交的結果。
Check run 保留 status、conclusion 與 SHA；commit status 保留其狀態，不能把尚未完成、缺席或無權限當成成功。[Checks API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)、[Commit statuses API](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)

一般 PR 留言與 reviews 分開顯示。Review 保留作者、state 與 commit SHA，舊提交的核准不能單獨代表目前 HEAD 已通過。
`reviewDecision` 顯示 GitHub 彙整的審查狀態；`mergeStateStatus` 另顯示合併狀態。這些欄位不等於 Hub 授權合併。[PR 查詢欄位](https://cli.github.com/manual/gh_pr_view)

`mergeable: null` 保留為未知，GitHub 可能仍在計算。即使 `mergeable: true`，也只表示可合併性資訊，不能取代保護分支、必要審查、checks、合併佇列與目前使用者權限。
留言清單不提供未解決審查討論數量的完整保證，MVP 不把沒有留言視為沒有阻塞討論。
各查詢採有界分頁，超限或格式不符時回報無法完整讀取。Checks 或審查資料缺席、無權限及新舊 SHA 不一致時，保留警告與未知。
MVP 不發布評論、不變更審查、不合併遠端 PR。最終合併條件由 GitHub 執行。

## 清理與鎖恢復

清理要求非主要工作區且非預設分支，HEAD 是指定基準 ref 的祖先，且沒有 tracked／untracked／ignored 變更、submodule、Git 操作或 worktree lock。
基準使用本機 ref；Hub 不自動 fetch，使用者須先更新基準。
Orca 活動資料必須完整。任何存活終端、無法確認的終端、PTY 或未完成／狀態不明 Agent 都會阻止收尾／清理，包括閒置 shell。遞迴確認完成的 Agent 與子 Agent 歷史不阻擋。
還須確認 Orca 支援保留分支的移除契約，再由 Orca 移除 Worktree。Hub 不 force、不刪分支。

若共用 Git 目錄留有 `gitflow-hub.lock`：

1. 確認沒有 Hub、Git 或 Orca CLI 操作仍在進行，核對前次操作結果。
2. 用 `git rev-parse --path-format=absolute --git-common-dir` 定位共用 Git 目錄。
3. 確認為遺留鎖後，人工以 `rmdir` 移除其中的空 `gitflow-hub.lock`。
4. 重新整理並建立新預覽。外掛不自動清鎖，也不因重啟自動重送寫入。

## 執行與打包

`trusted-worker` 擁有目前使用者的檔案與網路權限。固定 CLI 與子命令，參數不經 Shell，原始 stderr 不顯示於面板。
執行器移除繼承的 `GIT_*` 控制變數，設定非互動模式、預設 30 秒逾時與 2 MiB 輸出上限；特定 Orca 操作延長到 120 秒。
這些限制不隔離 repository hooks、使用者的 SSH／credential helper 或 Agent 權限。

`npm run package` 使用 `scripts/package.mjs` 產生 `.orca/package/gitflow-hub`，載入前對此目錄執行 `orca plugin inspect`。
打包排除開發依賴與 test／check；原始碼目錄可跑 `check`／`validate`，但 `inspect` 的嚴格檔案檢查可能拒絕 `node_modules` 連結。
本機原生 scaffold 缺少型別時，使用 [vendor/orca](../vendor/orca/README.md) 的官方 `.d.ts`；型別相容不證明 runtime 相容。

## 來源與現行計畫

- Orca 固定來源：[`318f5432931cb0800414740832123ef04c186dc5`](https://github.com/stablyai/orca/tree/318f5432931cb0800414740832123ef04c186dc5)，[Plugin Authoring](https://github.com/stablyai/orca/blob/318f5432931cb0800414740832123ef04c186dc5/docs/reference/plugin-authoring.md)、[Host API](https://github.com/stablyai/orca/blob/318f5432931cb0800414740832123ef04c186dc5/docs/reference/plugin-host-api.md)。
- GitHub 官方文件於 2026-11-05 查閱：[PR REST API](https://docs.github.com/en/rest/pulls/pulls)、[Checks](https://docs.github.com/en/rest/checks/runs)、[Commit statuses](https://docs.github.com/en/rest/commits/statuses)、[PR GraphQL](https://docs.github.com/en/graphql/reference/objects#pullrequest)、[GitHub CLI](https://cli.github.com/manual/gh_pr_view)。文件為浮動版本，GitHub Enterprise Server 不在本次支援範圍。
- 現行計畫：[AISDLC-2026-1105-finish-strategy](/Users/devrune/Documents/code/ai-sdlc-hub/projects/orca-gitflow-hub/initiatives/AISDLC-2026-1105-finish-strategy/plan.md)（local-only），沿用 [AISDLC-2026-1105-worktree-finish](/Users/devrune/Documents/code/ai-sdlc-hub/projects/orca-gitflow-hub/initiatives/AISDLC-2026-1105-worktree-finish/plan.md) 的收尾契約。
- [安全矩陣](security-matrix.md) 定義對抗案例；P2／P3 不在此 MVP 實作範圍。
