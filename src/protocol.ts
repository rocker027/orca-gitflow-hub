import type { GitSnapshot, PullRequest, PrDetails, Workspace, WorkspaceSummary } from './contracts'

export type HubAction =
  | { kind: 'create'; workspaceId: string; name: string; base: string; agent: string; prompt: string }
  | { kind: 'stage'; workspaceId: string; paths: string[]; fingerprint: string }
  | { kind: 'commit'; workspaceId: string; message: string }
  | { kind: 'push'; workspaceId: string }
  | { kind: 'draft'; workspaceId: string; targetBranch: string; title: string; description: string }
  | { kind: 'cleanup'; workspaceId: string; base: string }
  | { kind: 'ai-message'; workspaceId: string; agent: string }
  | { kind: 'finish'; workspaceId: string; targetWorkspaceId: string; message: string; remove: boolean }
  | { kind: 'finish-summary'; workspaceId: string }

export interface Preview {
  token: string
  title: string
  summary: string
  detail: string
  steps?: string[]
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
  steps?: { id: 'commit' | 'merge' | 'open' | 'cleanup'; label: string; status: 'done' | 'skipped' | 'failed'; detail: string }[]
  /** AI 寫好的完成說明，只填進表單，不會自動提交。 */
  draft?: string
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
