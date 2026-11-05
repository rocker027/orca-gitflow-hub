# Orca 官方型別

來源：stablyai/orca，固定 commit `318f5432931cb0800414740832123ef04c186dc5`。
原路徑為 `resources/plugins/declarative/*.d.ts` 與 `resources/plugins/types/*.d.ts`。

本機 Orca 1.4.249 的 `plugin create` / `plugin types` 缺少打包的 `orca.d.ts`，因此保留官方型別副本供 tsc 使用。這些檔案只有型別，不取代 Orca 的執行期。

升級時先驗 manifest、host API 與執行期，再更新來源 SHA。原專案授權見 https://github.com/stablyai/orca/blob/318f5432931cb0800414740832123ef04c186dc5/LICENSE 。
