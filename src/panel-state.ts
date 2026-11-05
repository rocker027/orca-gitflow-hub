import { atom, plugin, read, set, type Atom, type PanelContext } from 'orca'
import type { GitSnapshot, PullRequest, PrDetails, Workspace } from './contracts'
import type { Dashboard, Execution, HubAction, HubList, Preview } from './protocol'

export const state = {
  list: atom<HubList>({ workspaces: [], warnings: [] }),
  dashboard: atom<Dashboard | null>(null),
  repoId: atom(''),
  search: atom(''),
  workspaceId: atom(''),
  detailsOpen: atom(false),
  finishOpen: atom(false),
  createOpen: atom(false),
  githubOpen: atom(false),
  snapshot: atom<GitSnapshot | null>(null),
  selectedPaths: atom<string[]>([]),
  preview: atom<Preview | null>(null),
  execution: atom<Execution | null>(null),
  busy: atom(false),
  executing: atom(false),
  error: atom(''),
  notice: atom(''),
  name: atom(''),
  base: atom(''),
  createAgent: atom(''),
  agent: atom('codex'),
  prompt: atom(''),
  message: atom(''),
  finishMessage: atom(''),
  finishTargetId: atom(''),
  removeAfterFinish: atom(true),
  targetBranch: atom(''),
  prTitle: atom(''),
  prDescription: atom(''),
  prs: atom<PullRequest[] | null>(null),
  pr: atom<PrDetails | null>(null)
}

let requestSequence = 0
let panelSignal: AbortSignal | undefined

function isCurrent(sequence: number): boolean {
  return sequence === requestSequence && !panelSignal?.aborted
}

function begin(): number {
  set(state.busy, true)
  set(state.error, '')
  set(state.notice, '')
  return ++requestSequence
}

async function run<T>(request: () => Promise<T>, apply: (answer: T) => void): Promise<void> {
  const sequence = begin()
  try {
    const answer = await request()
    if (isCurrent(sequence)) apply(answer)
  } catch (error) {
    if (isCurrent(sequence)) set(state.error, error instanceof Error ? error.message : '操作失敗，請重新整理。')
  } finally {
    if (isCurrent(sequence)) set(state.busy, false)
  }
}

export function safeWebUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

export function selectedWorkspace(): Workspace | undefined {
  return read(state.list).workspaces.find((workspace) => workspace.id === read(state.workspaceId) && workspace.repoId === read(state.repoId))
}

export function projectWorkspaces(): Workspace[] {
  return read(state.list).workspaces.filter((workspace) => workspace.repoId === read(state.repoId))
}

export function finishTargets(): Workspace[] {
  const source = selectedWorkspace()
  return source ? projectWorkspaces().filter((workspace) => workspace.id !== source.id) : []
}

export function canFinish(workspace: Workspace): boolean {
  return !workspace.isMainWorktree && !workspace.isDefaultBranch
}

export function branchName(workspace: Workspace): string {
  return workspace.branch.replace(/^refs\/heads\//, '') || workspace.displayName
}

export function invalidatePreview(): void {
  set(state.preview, null)
  ++requestSequence
  set(state.busy, false)
}

export function edit<T>(field: Atom<T>, value: T): void {
  if (read(state.executing)) return
  if (field === state.search) {
    set(field, value)
    return
  }
  if (read(state.busy)) return
  invalidatePreview()
  set(state.execution, null)
  set(field, value)
}

function clearWorkspaceData(): void {
  set(state.snapshot, null)
  set(state.selectedPaths, [])
  set(state.preview, null)
  set(state.execution, null)
  set(state.message, '')
  set(state.finishMessage, '')
  set(state.finishTargetId, '')
  set(state.removeAfterFinish, true)
  set(state.prs, null)
  set(state.pr, null)
  set(state.githubOpen, false)
  set(state.notice, '')
}

function applyDashboard(dashboard: Dashboard, preferredId: string): void {
  const workspaces = dashboard.workspaces.filter((workspace) => workspace.repoId === dashboard.repoId)
  const selected = workspaces.find((workspace) => workspace.id === preferredId)
    ?? workspaces.find((workspace) => workspace.id === dashboard.activeWorkspaceId)
    ?? workspaces.find((workspace) => workspace.id === dashboard.defaultTargetId) ?? workspaces[0]
  if (selected?.id !== read(state.workspaceId)) clearWorkspaceData()
  set(state.list, { workspaces: dashboard.workspaces, warnings: dashboard.warnings })
  set(state.dashboard, dashboard)
  set(state.repoId, dashboard.repoId)
  set(state.workspaceId, selected?.id ?? '')
  const base = workspaces.find((workspace) => workspace.id === dashboard.defaultTargetId) ?? selected
  if (!read(state.base) && base) set(state.base, branchName(base))
}

export async function refresh(preferredId = read(state.workspaceId), initial = false): Promise<void> {
  invalidatePreview()
  set(state.dashboard, null)
  set(state.snapshot, null)
  set(state.selectedPaths, [])
  const sequence = begin()
  const repoId = initial ? undefined : read(state.repoId) || undefined
  try {
    const list = await plugin.request('hub.list', undefined, { signal: panelSignal })
    if (!isCurrent(sequence)) return
    set(state.list, list)
    if (initial && !read(state.repoId)) {
      const active = list.workspaces.find((workspace) => workspace.isActive) ?? list.workspaces[0]
      set(state.repoId, active?.repoId ?? '')
    }
    const dashboard = await plugin.request('hub.dashboard', { ...(repoId ? { repoId } : {}) }, { signal: panelSignal })
    if (!isCurrent(sequence)) return
    applyDashboard(dashboard, preferredId)
    if ((read(state.detailsOpen) || read(state.finishOpen)) && read(state.workspaceId)) {
      const snapshot = await plugin.request('hub.inspect', { workspaceId: read(state.workspaceId) }, { signal: panelSignal })
      if (isCurrent(sequence)) set(state.snapshot, snapshot)
    }
  } catch (error) {
    if (isCurrent(sequence)) set(state.error, error instanceof Error ? error.message : '無法讀取工作樹。')
  } finally {
    if (isCurrent(sequence)) set(state.busy, false)
  }
}

export async function selectProject(repoId: string): Promise<void> {
  if (read(state.executing)) return
  invalidatePreview()
  clearWorkspaceData()
  set(state.repoId, repoId)
  set(state.workspaceId, '')
  set(state.dashboard, null)
  set(state.search, '')
  set(state.base, '')
  set(state.detailsOpen, false)
  set(state.finishOpen, false)
  set(state.createOpen, false)
  await refresh('')
}

export async function selectWorkspace(workspaceId: string, mode: 'details' | 'finish' = 'details'): Promise<void> {
  if (read(state.executing)) return
  const workspace = projectWorkspaces().find((entry) => entry.id === workspaceId)
  if (!workspace || (mode === 'finish' && !canFinish(workspace))) return
  invalidatePreview()
  clearWorkspaceData()
  set(state.workspaceId, workspaceId)
  set(state.createOpen, false)
  set(state.detailsOpen, mode === 'details')
  set(state.finishOpen, mode === 'finish')
  const targets = finishTargets()
  const target = targets.find((entry) => entry.id === read(state.dashboard)?.defaultTargetId)
    ?? targets.find((entry) => entry.isDefaultBranch || entry.isMainWorktree) ?? targets[0]
  set(state.finishTargetId, target?.id ?? '')
  await inspectWorkspace()
}

export function returnToList(): void {
  if (read(state.executing)) return
  invalidatePreview()
  clearWorkspaceData()
  set(state.detailsOpen, false)
  set(state.finishOpen, false)
}

export async function inspectWorkspace(): Promise<void> {
  const workspaceId = selectedWorkspace()?.id
  if (!workspaceId) return
  invalidatePreview()
  set(state.snapshot, null)
  await run(() => plugin.request('hub.inspect', { workspaceId }, { signal: panelSignal }), (snapshot) => {
    set(state.snapshot, snapshot)
    set(state.selectedPaths, [])
  })
}

export async function requestPreview(action: HubAction): Promise<void> {
  if (read(state.busy) || read(state.executing) || !selectedWorkspace()) return
  set(state.preview, null)
  set(state.execution, null)
  await run(() => plugin.request('hub.preview', action, { signal: panelSignal, timeoutMs: 120000 }), (preview) => set(state.preview, preview))
}

export async function previewFinish(): Promise<void> {
  const workspace = selectedWorkspace()
  const snapshot = read(state.snapshot)
  const target = finishTargets().find((entry) => entry.id === read(state.finishTargetId))
  if (!workspace || !canFinish(workspace) || !target || !snapshot) return
  if (snapshot.files.length > 0 && !read(state.finishMessage).trim()) return
  await requestPreview({ kind: 'finish', workspaceId: workspace.id, targetWorkspaceId: target.id,
    message: snapshot.files.length > 0 ? read(state.finishMessage) : '', remove: read(state.removeAfterFinish) })
}

export async function executePreview(): Promise<void> {
  const preview = read(state.preview)
  if (!preview || read(state.busy) || read(state.executing)) return
  await executeWithToken(async () => preview.token)
}

export async function createAndOpen(): Promise<void> {
  const workspace = selectedWorkspace()
  if (!workspace || read(state.busy) || read(state.executing) || !read(state.name).trim() || !read(state.base).trim()) return
  const action: HubAction = { kind: 'create', workspaceId: workspace.id,
    name: read(state.name), base: read(state.base), agent: read(state.createAgent),
    prompt: read(state.createAgent) ? read(state.prompt) : '' }
  await executeWithToken(async () => {
    const preview = await plugin.request('hub.preview', action, { signal: panelSignal, timeoutMs: 120000 })
    return preview.token
  })
}

async function executeWithToken(obtainToken: () => Promise<string>): Promise<void> {
  const executionSignal = panelSignal
  set(state.executing, true)
  set(state.preview, null)
  set(state.execution, null)
  const sequence = begin()
  try {
    const token = await obtainToken()
    if (!isCurrent(sequence)) return
    const answer = await plugin.request('hub.execute', { token }, { signal: panelSignal, timeoutMs: 120000 })
    if (!isCurrent(sequence)) return
    set(state.detailsOpen, false)
    set(state.finishOpen, false)
    set(state.createOpen, false)
    set(state.snapshot, null)
    await refresh(answer.workspaceId ?? read(state.workspaceId))
    if (executionSignal !== panelSignal || executionSignal?.aborted) return
    set(state.execution, answer)
  } catch (error) {
    if (isCurrent(sequence)) set(state.error, error instanceof Error ? error.message : '結果未知，請重新整理後核對。')
  } finally {
    if (executionSignal === panelSignal && !executionSignal?.aborted) {
      set(state.executing, false)
      set(state.busy, false)
    }
  }
}

export async function openWorkspace(workspaceId = read(state.workspaceId)): Promise<void> {
  if (read(state.busy) || read(state.executing)) return
  if (!projectWorkspaces().some((workspace) => workspace.id === workspaceId)) return
  await run(() => plugin.request('hub.open', { workspaceId }, { signal: panelSignal }), ({ opened }) => {
    set(state.notice, opened ? '已在 Orca 開啟。' : 'Orca 未開啟工作樹。')
  })
}

export async function loadPrs(): Promise<void> {
  const workspaceId = selectedWorkspace()?.id
  if (!workspaceId) return
  set(state.pr, null)
  await run(() => plugin.request('hub.prs', { workspaceId }, { signal: panelSignal }), (prs) => set(state.prs, prs))
}

export async function loadPr(number: number): Promise<void> {
  const workspaceId = selectedWorkspace()?.id
  if (!workspaceId) return
  set(state.pr, null)
  await run(() => plugin.request('hub.pr', { workspaceId, number }, { signal: panelSignal }), (pr) => set(state.pr, pr))
}

export async function toggleGithub(open: boolean): Promise<void> {
  edit(state.githubOpen, open)
  if (open) await loadPrs()
}

export async function importAiMessage(): Promise<void> {
  const workspaceId = selectedWorkspace()?.id
  if (!workspaceId) return
  invalidatePreview()
  await run(() => plugin.request('hub.ai-result', { workspaceId }, { signal: panelSignal }), ({ message }) => {
    set(state.message, message)
    set(state.notice, '已匯入 AI 草稿，請檢查訊息後預覽提交。')
  })
}

export function setupState(ctx: PanelContext): void {
  panelSignal = ctx.signal
  ++requestSequence
  void refresh('', true)
  ctx.subscriptions.push({ dispose: () => { ++requestSequence } })
}
