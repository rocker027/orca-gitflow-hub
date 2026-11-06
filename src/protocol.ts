import type { GitSnapshot, PullRequest, PrDetails, Workspace, WorkspaceSummary } from './contracts'

/** merge：保留提交，必要時建立合併提交；rebase：把提交搬到目標最新進度後面，歷史是一直線。 */
export type FinishStrategy = 'merge' | 'rebase'
export type FinishStepId = 'commit' | 'squash' | 'rebase' | 'merge' | 'open' | 'cleanup'

export type HubAction =
  | { kind: 'create'; workspaceId: string; name: string; base: string; agent: string; prompt: string }
  | { kind: 'stage'; workspaceId: string; paths: string[]; fingerprint: string }
  | { kind: 'commit'; workspaceId: string; message: string }
  | { kind: 'push'; workspaceId: string }
  | { kind: 'draft'; workspaceId: string; targetBranch: string; title: string; description: string }
  | { kind: 'cleanup'; workspaceId: string; base: string }
  | { kind: 'ai-message'; workspaceId: string; agent: string }
  | { kind: 'finish'; workspaceId: string; targetWorkspaceId: string; message: string; remove: boolean
      strategy: FinishStrategy; squash: boolean }
  | { kind: 'finish-summary'; workspaceId: string }
  /** 請 AI 依目前選擇評估合併風險；只回傳建議，不改任何選項。 */
  | { kind: 'finish-advice'; workspaceId: string; targetWorkspaceId: string; strategy: FinishStrategy; squash: boolean }

export interface Preview {
  token: string
  title: string
  summary: string
  detail: string
  steps?: string[]
  /** 確認前必須讓使用者看到的提醒；標題直接說會發生什麼，內文說要不要處理。 */
  warnings?: {
    title: string
    text: string
    /** 只是提醒、不是問題時用 accent。 */
    tone?: 'accent' | 'warning'
    /** 面板可提供一鍵修正：rebase 表示改用「接到最後面」重新預覽。 */
    fix?: 'rebase'
  }[]
}

export interface Dashboard extends HubList {
  repoId: string
  activeWorkspaceId?: string
  defaultTargetId?: string
  summaries: WorkspaceSummary[]
}

export interface HubList {
  workspaces: Workspace[]
  warnings: string[]
}

export interface Execution {
  message: string
  url?: string
  workspaceId?: string
  status?: 'completed' | 'needs_attention'
  /** 只列本次相關的步驟；未選 squash／rebase 時不出現對應步驟。 */
  steps?: { id: FinishStepId; label: string; status: 'done' | 'skipped' | 'failed'; detail: string }[]
  /** AI 寫好的完成說明，只填進表單，不會自動提交。 */
  draft?: string
  /** AI 合併建議；只供參考，面板不會依此改變使用者的選擇。 */
  advice?: {
    level: '低' | '中' | '高' | '未知'
    text: string
    /** Git 算出的事實，面板直接顯示。 */
    facts: { conflict: boolean; overlap: string[] }
    /** 等級是否因 Git 事實而調高（AI 回答的等級比事實樂觀）。 */
    raised: boolean
  }
}

declare module 'orca' {
  interface PluginRequests {
    'hub.list': { output: HubList }
    'hub.dashboard': { input: { repoId?: string }; output: Dashboard }
    'hub.inspect': { input: { workspaceId: string }; output: GitSnapshot }
    'hub.preview': { input: HubAction; output: Preview }
    'hub.execute': { input: { token: string }; output: Execution }
    'hub.open': { input: { workspaceId: string }; output: { opened: boolean } }
    'hub.prs': { input: { workspaceId: string }; output: PullRequest[] }
    'hub.pr': { input: { workspaceId: string; number: number }; output: PrDetails }
    'hub.ai-result': { input: { workspaceId: string }; output: { message: string } }
  }
}
