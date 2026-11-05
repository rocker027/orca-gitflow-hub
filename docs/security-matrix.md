# MVP 安全驗證矩陣

本矩陣記錄 P0＋P1 基礎操作與 GitHub 邊界；新增本機收尾另見 [F1–F12](finish-safety-matrix.md)。本機限定。先建立本矩陣，再實作輸入邊界。真實外部寫入僅由使用者預覽後執行。

| ID | 輸入／狀態 | 預期行為 |
| --- | --- | --- |
| S1 | 未列出的工作區 ID、任意 cwd、遠端 host、資料夾非 Git | 在執行 Git 前拒絕 |
| S2 | shell metacharacters、以 - 開頭參數、NUL、pathspec 魔法、../ 或絕對檔案路徑 | 固定 argv、不經 shell；檔案必須來自該工作區狀態且以 literal pathspec 傳入 |
| S3 | 跨目錄 symlink、失效工作區、Git top-level 不符 | 拒絕；不得讀取外部檔案作為 Diff |
| S4 | 未預覽、重複執行、過期 token、不同工作區或版本、Worker 重啟 | 拒絕或回報已執行／結果未知，不重新做寫入 |
| S5 | 同一 repo 的並行寫入 | 拒絕第二個操作，保留失敗紀錄 |
| S6 | 提交前 HEAD/index 改變、衝突、空 staged、機密檔案／明顯私鑰 | 拒絕，重新預覽；既存 staged 檔案必須清楚列出 |
| S7 | 主要工作區、dirty/untracked/ignored、submodule、locked、未合併、live/unknown agent | 不提供或拒絕清理，絕不 force，保留分支 |
| S8 | GitHub Host/repository 不符、非 HTTP(S)/SSH remote、fork 情境 | 固定解析身分且只接受 github.com，MVP 對不支援 fork 拒絕建立；不得把 Token 傳錯主機 |
| S9 | 已存在 PR、POST timeout、Push 失敗、PR 建立但關聯失敗 | 查詢既存 PR 復用；結果未知不可盲目重建；可重新關聯 |
| S10 | CLI 不存在、超時、非 JSON、非零 exit、輸出過大 | 顯示可恢復錯誤，不當成功、不卡死、不洩漏原始敏感 stderr |
| S11 | PR CI 缺席、pending、討論未解、核准未知、SHA 改變 | 顯示原狀與 UNKNOWN；不宣稱可合併；MVP 只開啟 GitHub 由人合併 |
| S12 | 非同步請求先後逆序、切工作區時舊回應到達 | 丟棄舊結果，預覽不跨工作區沿用 |
| S13 | 預覽後檔案內容改變但 status 碼不變，或選取路徑／訊息／目標改變 | 指紋涵蓋內容；token 保存不可更改的完整操作 payload；任何差異重新預覽 |
| S14 | pushurl／insteadOf 導向不同 Host/repository，或預覽後 remote 改變 | 核對 Git 展開後全部 fetch/push URLs，單一且同源才允許；token 綁定展開後 URL |
| S15 | external diff／textconv／pager／環境覆寫 Git 路徑 | Diff 固定 --no-ext-diff --no-textconv --no-color 並停 pager 與 core.fsmonitor；清除 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE 等繼承控制變數。commit hooks 保留，預覽明說會依 repo 設定執行 hooks；不保證不可信 repo 程式碼隔離 |

外部 Agent 或使用者可同時操作 Git。Hub 的鎖只能協調自己的操作，預覽指紋與 Git 原生鎖不能冒充全域隔離。不可宣稱解決外部程序所有競態。

2026-11-05：使用者改為 GitHub，遠端 API 改用 gh，新增 PR head SHA 對應 Checks/statuses、reviewDecision 與 mergeable null 不得視為通過。GitHub fixture 重新驗證原 S8–S11。
