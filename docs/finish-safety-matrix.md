# 本機收尾驗證矩陣

需求：工作樹清單與快速收尾為主入口。使用者選擇「提交 → 合回本機目標分支 → 清理工作樹」。一次預覽確認完整流程，不逐步要求重複確認。合併保留提交歷史，可快轉則快轉，分歧時建立合併提交。

| ID | 狀態或繞過嘗試 | 必須成立的結果 |
| --- | --- | --- |
| F1 | 來源是主要工作樹或預設分支、來源等於目標、跨 repo、未登錄或路徑身分改變 | 寫入前拒絕；Orca repoId 與 canonical Git common dir 都須相同，目標只接受已登錄工作樹 ID |
| F2 | 來源／目標 HEAD、內容、分支在預覽後改變 | 執行前拒絕；提交後只接受本次提交造成的來源前進（parent／預提交 tree 核對），合併前目標身分、分支、HEAD、完整內容仍須等於預覽 |
| F3 | 來源或目標有衝突、rebase/merge/cherry-pick、lock、submodule、detached HEAD、assume-unchanged／skip-worktree／sparse checkout | 收尾前拒絕，不清理現場 |
| F4 | 目標有 staged、unstaged、untracked 變更 | 提交來源前拒絕；ignored 路徑不得被合併覆蓋 |
| F5 | 全部變更包含私鑰、敏感路徑、symlink、pathspec 或特殊檔名 | 預覽列出全部檔案；literal pathspec；沿用或補強機密檢查，不盲目 git add -A |
| F6 | Git 歷史分歧或真正衝突 | 可合併時保留雙方提交；merge-tree 不支援／失敗即拒絕。預檢衝突不碰目標；實際 merge／hook 失敗可能已修改目標，保留現場、不宣稱未寫入、不清理 |
| F7 | 來源／目標有活動中或未知 Agent；清理前出現終端／Agent | stage／commit／merge 前核對雙方活動狀態，活動中或未知皆拒絕。已完成 Agent 可保留歷史；清理前重核，存活終端仍拒絕，不 force、不刪分支 |
| F8 | 提交成功但合併失敗，或合併成功但切換／清理失敗 | 顯示逐步結果與實際完成邊界；命令失敗但可能已寫入要標示待核對，保留現場。再次預覽依現況繼續，不重送舊 token |
| F9 | 同 repo 並行收尾、重複確認、Worker 中斷 | 沿用共用 repo 鎖及一次性 token；未知不自動重試；其他工具不在 Hub 鎖保證內 |
| F10 | source HEAD 不屬於合併後 target，或清理前 target/source 再變 | 不清理。清理仍核對 dirty/ignored/已合併/Agent，保留本機分支 |
| F11 | 清單查詢失敗、跨專案／切換來源時舊回覆到達 | 顯示 UNKNOWN／錯誤，不誤判乾淨；舊詳情及預覽不得套到新來源 |
| F12 | 新建工作樹的預設基準或同名來源不存在 | 使用可核對基準；新建預設不啟動 Agent；建立後開啟指定完整 ID |

Git hooks 依可信任儲存庫設定執行。失敗不 reset、不 abort 使用者既有 Git 操作、不自動 stash、不推送遠端。
本次採 Native Git 合併與 Orca 管理生命週期；參考 Worktrunk 的清單與收尾互動，未引入第二套工作樹管理者。
