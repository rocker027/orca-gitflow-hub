import { defineCheck } from 'orca/testing'
import type { GitSnapshot, PrDetails, Workspace } from './contracts'
import type { Dashboard } from './protocol'

export const workspaces: Workspace[] = [
  { id: 'repo::/fixture/feature', repoId: 'repo', repoName: 'App', path: '/fixture/feature', branch: 'feature/login',
    head: 'a'.repeat(40), displayName: '登入功能', hostId: 'local', isMainWorktree: false, isActive: true },
  { id: 'repo::/fixture/main', repoId: 'repo', repoName: 'App', path: '/fixture/main', branch: 'main',
    head: 'b'.repeat(40), displayName: 'main', hostId: 'local', isMainWorktree: true, isDefaultBranch: true },
  { id: 'docs::/fixture/docs', repoId: 'docs', repoName: 'Docs', path: '/fixture/docs', branch: 'docs-main',
    head: 'c'.repeat(40), displayName: '文件專案', hostId: 'local', isMainWorktree: true, isDefaultBranch: true }
]

export const snapshot: GitSnapshot = {
  head: 'a'.repeat(40), branch: 'feature/login', fingerprint: 'fixture-fingerprint',
  files: [{ path: 'src/login.ts', index: ' ', working: 'M' }, { path: 'notes.md', index: '?', working: '?' }],
  stagedDiff: '', workingDiff: 'diff --git a/src/login.ts b/src/login.ts\n+新增登入驗證'
}

export function dashboardFor(repoId = 'repo'): Dashboard {
  const sameRepo = workspaces.filter((workspace) => workspace.repoId === repoId)
  return {
    workspaces, warnings: [], repoId,
    activeWorkspaceId: sameRepo.find((workspace) => workspace.isActive)?.id,
    defaultTargetId: sameRepo.find((workspace) => workspace.isDefaultBranch)?.id,
    summaries: sameRepo.map((workspace) => ({ workspaceId: workspace.id, branch: workspace.branch,
      head: workspace.head, changedFiles: workspace.isMainWorktree ? 0 : 2,
      ahead: workspace.isMainWorktree ? 0 : 2, behind: 0,
      lastMessage: workspace.isMainWorktree ? '初始化專案' : '補上登入驗證' }))
  }
}

export const prDetail: PrDetails = {
  identity: { host: 'github.com', owner: 'team', repo: 'app', projectPath: 'team/app',
    remoteUrl: 'git@github.com:team/app.git', webUrl: 'https://github.com/team/app' },
  pr: { id: 100, number: 7, title: '登入功能', url: 'https://github.com/team/app/pull/7',
    state: 'open', draft: true, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    headBranch: 'feature/login', baseBranch: 'main', repoId: 1, mergeable: null },
  comments: [{ id: 1, body: '請補上錯誤處理。', author: 'reviewer' }],
  checks: [], reviews: [], reviewDecision: 'unknown', mergeStateStatus: 'UNKNOWN',
  warnings: ['審查決策尚未取得。']
}

export const requests = {
  'hub.list': { workspaces, warnings: [] },
  'hub.dashboard': ({ repoId }: { repoId?: string }) => dashboardFor(repoId),
  'hub.inspect': ({ workspaceId }: { workspaceId: string }) => workspaceId === workspaces[0].id ? snapshot
    : { ...snapshot, branch: workspaceId === workspaces[1].id ? 'main' : 'docs-main', files: [], workingDiff: '' },
  'hub.prs': [prDetail.pr], 'hub.pr': prDetail,
  'hub.open': { opened: true }, 'hub.ai-result': { message: 'feat: 補上登入驗證' }
}

export default defineCheck({
  worktrees: { requests },
  empty: { requests: {
    'hub.list': { workspaces: [], warnings: [] },
    'hub.dashboard': { workspaces: [], warnings: [], repoId: '', summaries: [] }
  } },
  unavailable: { requests: { 'hub.list': () => { throw new Error('找不到 Orca CLI，請檢查安裝。') } } }
})
