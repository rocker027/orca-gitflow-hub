export interface Workspace {
  id: string
  repoId: string
  path: string
  branch: string
  head: string
  displayName: string
  hostId: string
  isMainWorktree: boolean
  repoName?: string
  isActive?: boolean
  isDefaultBranch?: boolean
}

export interface WorkspaceSummary {
  workspaceId: string
  branch: string
  head: string
  changedFiles: number
  ahead: number | null
  behind: number | null
  lastMessage: string
  error?: string
}

export type Run = (
  tool: 'git' | 'orca' | 'gh',
  args: readonly string[],
  options?: { cwd?: string; input?: string; signal?: AbortSignal; timeoutMs?: number }
) => Promise<string>

export interface ChangedFile {
  path: string
  originalPath?: string
  index: string
  working: string
}

export interface GitSnapshot {
  head: string
  branch: string
  fingerprint: string
  files: ChangedFile[]
  stagedDiff: string
  workingDiff: string
}

export interface CommitPreview {
  fingerprint: string
  head: string
  message: string
  files: string[]
  diff: string
}

export interface GitHubIdentity {
  host: string
  owner: string
  repo: string
  projectPath: string
  remoteUrl: string
  webUrl: string
}

export interface PullRequest {
  id: number
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  draft: boolean
  headSha: string
  baseSha: string
  headBranch: string
  baseBranch: string
  repoId: number
  mergeable: boolean | null
}

export interface PrDetails {
  identity: GitHubIdentity
  pr: PullRequest
  comments: { id: number; body: string; author: string }[]
  checks: { name: string; status: string; conclusion: string | null; sha: string; url?: string }[]
  reviews: { author: string; state: string; commitSha: string }[]
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | 'unknown'
  mergeStateStatus: string
  warnings: string[]
}
