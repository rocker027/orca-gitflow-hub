# 本機收尾驗證矩陣

需求：首頁以目前工作的「完成這個工作」為主入口。使用者選擇目標分支、merge 或 rebase、是否合成一個提交，以及是否清理工作樹。一次預覽確認完整流程，不逐步要求重複確認。預設 merge 且保留每個提交：可快轉則快轉，分歧時建立合併提交。

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
| F13 | 選 rebase 或 squash 時有衝突 | 改寫前以 merge-tree 模擬（rebase 逐提交串接），衝突即停止；不改寫來源、不碰目標，列出兩邊都改過的檔案。無未提交變更時在預覽擋下 |
| F14 | git rebase 通過模擬後仍失敗（hook 拒絕、中途停止）；來源有被忽略的本機檔案位於 rebase 會寫到的路徑 | 被忽略的檔案或資料夾與 rebase 會寫到的路徑重疊時，預覽與執行前都拒絕（git rebase 沒有 --no-overwrite-ignore）。會寫到的路徑含雙方差異、搬移的提交與模擬串接的每一步；比對不分大小寫（core.ignoreCase）並統一 Unicode 正規化，檔案取代被忽略的資料夾也算重疊。Hub 只 abort 自己啟動的 rebase，核對 HEAD、分支與已追蹤內容都回到 rebase 前才如此回報；abort 或核對失敗標 UNKNOWN 保留現場。成功時結果 tree 必須等於模擬，目標只以 --ff-only 前進 |
| F15 | squash 時來源在預覽後移動、多個共同起點、簽章失敗 | 執行前核對來源 HEAD 與狀態；update-ref 帶舊值比對；多個共同起點拒絕；commit-tree 失敗時分支不變。合成提交 tree 與原 HEAD 相同，來源工作樹維持乾淨 |
| F16 | rebase 不合成而來源含合併提交；改寫已上傳的提交 | 含合併提交時在預覽拒絕，建議改用 merge 或合成。已在遠端追蹤分支的提交被改寫時，確認頁提醒需要 force push；外掛不推送 |

| F17 | 預覽時來源有 ignored 本機檔案且選擇移除資料夾 | 提交與合併前拒絕，提示取消勾選「完成後移除資料夾」再檢查；取消後可合併並保留檔案。最終清理前仍重驗，預覽後新出現的 ignored 檔不得被刪除 |

| F18 | 開啟目標會自動產生終端，或清理成功後開啟目標失敗 | 合併後先完成所有安全清理檢查與移除，再開啟目標。開啟失敗時明示已合併、已移除資料夾、保留分支；清理拒絕時保留來源且不先開啟目標 |

Git hooks 依可信任儲存庫設定執行；合成提交以 commit-tree 建立，不執行 commit hooks。失敗不 reset、不 abort 使用者既有 Git 操作、不自動 stash、不推送遠端；唯一例外是 F14 中 Hub 自己啟動的 rebase。
本次採 Native Git 合併與 Orca 管理生命週期；參考 Worktrunk 的清單與收尾互動，未引入第二套工作樹管理者。
