import { atom, on, plugin, read, set, type Atom, type PanelContext } from 'orca'
import type { GitSnapshot, PullRequest, PrDetails, Workspace } from './contracts'
import type { Dashboard, Execution, FinishStrategy, HubAction, HubList, Preview } from './protocol'

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
  finishTargetId: atom(''),
  /** 預設一般合併、保留每個提交；改寫歷史只在使用者明確選擇時發生。 */
  finishStrategy: atom<FinishStrategy>('merge'),
  finishSquash: atom(false),
  removeAfterFinish: atom(false),
  targetBranch: atom(''),
  prTitle: atom(''),
  prDescription: atom(''),
  prs: atom<PullRequest[] | null>(null),
  pr: atom<PrDetails | null>(null),
  /** 等待使用者確認是否把變更傳給 Claude 評估合併風險；確認前不會傳送。 */
  advicePreview: atom<Preview | null>(null),
  adviceWriting: atom(false),
  /** Claude 的合併建議，只供參考；改目標、合併方式或合成選項時清掉，因為建議是針對當時的選擇。 */
  advice: atom<NonNullable<Execution['advice']> | null>(null)
}

let requestSequence = 0
let panelSignal: AbortSignal | undefined
let contextSequence = 0
let observedActiveWorkspaceId: string | undefined
let pendingContextChange = false

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

/** Orca 目前開啟、且屬於這個專案的工作樹；首頁把它當作「目前的工作」。 */
export function currentWorkspace(): Workspace | undefined {
  return projectWorkspaces().find((workspace) => workspace.isActive)
}

/** 清單摘要的領先數以這個分支為準（通常是 main）。 */
export function defaultTarget(): Workspace | undefined {
  return projectWorkspaces().find((workspace) => workspace.id === read(state.dashboard)?.defaultTargetId)
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
  set(state.advicePreview, null)
  set(state.adviceWriting, false)
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
  if (field === state.finishTargetId || field === state.finishStrategy || field === state.finishSquash) set(state.advice, null)
  set(field, value)
}

function clearWorkspaceData(): void {
  set(state.snapshot, null)
  set(state.selectedPaths, [])
  set(state.preview, null)
  set(state.execution, null)
  set(state.message, '')
  set(state.finishTargetId, '')
  set(state.finishStrategy, 'merge')
  set(state.finishSquash, false)
  set(state.advice, null)
  set(state.removeAfterFinish, false)
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
    if (observedActiveWorkspaceId === undefined) {
      observedActiveWorkspaceId = list.workspaces.find((workspace) => workspace.isActive)?.id ?? ''
    }
    set(state.list, list)
    if (initial && !read(state.repoId)) {
      const active = list.workspaces.find((workspace) => workspace.isActive) ?? list.workspaces[0]
      set(state.repoId, active?.repoId ?? '')
    }
    const dashboard = await plugin.request('hub.dashboard', { ...(repoId ? { repoId } : {}) }, { signal: panelSignal })
    if (!isCurrent(sequence)) return
    applyDashboard(dashboard, preferredId)
    if (initial) observedActiveWorkspaceId = dashboard.workspaces.find((workspace) => workspace.isActive)?.id ?? ''
    if ((read(state.detailsOpen) || read(state.finishOpen)) && read(state.workspaceId)) {
      const snapshot = await plugin.request('hub.inspect', { workspaceId: read(state.workspaceId) }, { signal: panelSignal })
      if (isCurrent(sequence)) set(state.snapshot, snapshot)
    }
  } catch (error) {
    if (!isCurrent(sequence)) return
    // 初次讀取失敗也要結束「首次只記錄」階段，否則下一次真正的切換會被當成初次通知略過。
    if (observedActiveWorkspaceId === undefined) observedActiveWorkspaceId = ''
    set(state.error, error instanceof Error ? error.message : '無法讀取工作樹。')
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

function clearContextInputs(): void {
  clearWorkspaceData()
  set(state.search, '')
  set(state.base, '')
  set(state.name, '')
  set(state.prompt, '')
  set(state.createAgent, '')
  set(state.targetBranch, '')
  set(state.prTitle, '')
  set(state.prDescription, '')
  set(state.detailsOpen, false)
  set(state.finishOpen, false)
  set(state.createOpen, false)
}

async function applyActiveWorkspace(list: HubList): Promise<void> {
  const active = list.workspaces.find((workspace) => workspace.isActive)
  const activeId = active?.id ?? ''
  // 宿主會先送目前 context 給新訂閱者；首次只記錄，交給開啟時的初次讀取，避免重複載入。
  if (observedActiveWorkspaceId === undefined || activeId === observedActiveWorkspaceId) {
    observedActiveWorkspaceId = activeId
    return
  }
  // 建立或合併會自動開啟回傳的工作樹；切換事件晚於回應時，切到該工作樹仍保留逐步結果。
  const signal = panelSignal
  const outcome = read(state.execution)
  const keptOutcome = outcome?.workspaceId === activeId ? outcome : null
  observedActiveWorkspaceId = activeId
  invalidatePreview()
  clearContextInputs()
  set(state.list, list)
  set(state.dashboard, null)
  set(state.repoId, active?.repoId ?? '')
  set(state.workspaceId, active?.id ?? '')
  set(state.error, '')
  if (active) await refresh('', true)
  else set(state.notice, '目前沒有可用的本機工作樹，請在 Orca 選擇一個 Git 工作樹。')
  if (keptOutcome && observedActiveWorkspaceId === activeId && signal === panelSignal && !signal?.aborted && !read(state.execution)) {
    set(state.execution, keptOutcome)
  }
}

async function followActiveWorkspace(afterExecution = false): Promise<void> {
  if (read(state.executing) && !afterExecution) { pendingContextChange = true; return }
  const signal = panelSignal
  const sequence = ++contextSequence
  const current = () => sequence === contextSequence && signal === panelSignal && !signal?.aborted
  try {
    // 終端開關也會送出同一事件；以宿主清單的身分判斷，不使用可能重複的分支名稱。
    const list = await plugin.request('hub.list', undefined, { signal })
    if (!current()) return
    if (read(state.executing) && !afterExecution) { pendingContextChange = true; return }
    await applyActiveWorkspace(list)
  } catch (error) {
    if (!current()) return
    if (read(state.executing) && !afterExecution) { pendingContextChange = true; return }
    invalidatePreview()
    set(state.error, error instanceof Error ? error.message : '無法取得目前工作樹，請重新整理。')
  }
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
  set(state.createOpen, false)
  set(state.error, '')
}

export function startWork(): void {
  if (read(state.busy) || read(state.executing) || !selectedWorkspace()) return
  invalidatePreview()
  set(state.execution, null)
  set(state.error, '')
  set(state.notice, '')
  set(state.detailsOpen, false)
  set(state.finishOpen, false)
  set(state.createOpen, true)
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

/** 收尾的提交訊息由來源分支產生；沒有新提交且不合成時沿用原提交。 */
export function finishCommitMessage(): string {
  const workspace = selectedWorkspace()
  const needsMessage = Boolean(read(state.snapshot)?.files.length) || read(state.finishSquash)
  return workspace && needsMessage ? `完成 ${branchName(workspace)}` : ''
}

/** 收尾按鈕不能按時，用一句話告訴使用者還缺什麼；可以按時回傳空字串。 */
export function finishBlocker(): string {
  const workspace = selectedWorkspace()
  if (!workspace || !canFinish(workspace)) return '這是主要分支，不能在這裡完成。'
  if (!finishTargets().length) return '還沒有可以合併的分支。請先在 Orca 開啟同專案的另一個工作資料夾。'
  if (!read(state.snapshot)) return read(state.busy) ? '' : '還沒讀到變更，請按「重新整理」。'
  if (!finishTargets().some((entry) => entry.id === read(state.finishTargetId))) return '請選擇要合併到哪個分支。'
  return ''
}

/** 一鍵改用 Rebase；在確認頁按下會直接重新預覽，實際提交數以預檢結果為準。 */
export async function finishWithRebase(): Promise<void> {
  if (read(state.busy) || read(state.executing)) return
  const confirming = Boolean(read(state.preview))
  edit(state.finishStrategy, 'rebase')
  if (confirming) await previewFinish()
}

export async function previewFinish(): Promise<void> {
  const workspace = selectedWorkspace()
  const target = finishTargets().find((entry) => entry.id === read(state.finishTargetId))
  if (!workspace || !target || read(state.busy) || finishBlocker()) return
  await requestPreview({ kind: 'finish', workspaceId: workspace.id, targetWorkspaceId: target.id,
    message: finishCommitMessage(), remove: read(state.removeAfterFinish),
    strategy: read(state.finishStrategy), squash: read(state.finishSquash) })
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
  // 執行前已在讀取的切換查詢作廢，結束後一律重新同步一次，避免舊清單在完成後清掉結果。
  ++contextSequence
  pendingContextChange = true
  set(state.executing, true)
  // 執行期間保留確認頁，讓使用者看到正在做哪些步驟；收到結果或失敗後才移除，舊確認不能再送出。
  set(state.execution, null)
  const sequence = begin()
  try {
    const token = await obtainToken()
    if (!isCurrent(sequence)) return
    const answer = await plugin.request('hub.execute', { token }, { signal: panelSignal, timeoutMs: 120000 })
    set(state.preview, null)
    if (!isCurrent(sequence)) return
    // 先顯示結果再重新整理清單；否則重新整理期間看起來像回到原點。重新整理可能清掉結果，下方會再設一次。
    set(state.execution, answer)
    if (read(state.createOpen)) {
      set(state.name, '')
      set(state.prompt, '')
      set(state.createAgent, '')
    }
    set(state.detailsOpen, false)
    set(state.finishOpen, false)
    set(state.createOpen, false)
    set(state.snapshot, null)
    await refresh(answer.workspaceId ?? read(state.workspaceId))
    if (executionSignal !== panelSignal || executionSignal?.aborted) return
    set(state.execution, answer)
  } catch (error) {
    set(state.preview, null)
    if (isCurrent(sequence)) set(state.error, error instanceof Error ? error.message : '結果未知，請重新整理後核對。')
  } finally {
    if (executionSignal === panelSignal && !executionSignal?.aborted) {
      const outcome = read(state.execution)
      const error = read(state.error)
      // 自動開啟目標也會觸發切換。先完成寫入，再同步，期間仍禁止重送。
      while (pendingContextChange && executionSignal === panelSignal && !executionSignal?.aborted) {
        pendingContextChange = false
        await followActiveWorkspace(true)
      }
      if (executionSignal === panelSignal && !executionSignal?.aborted) {
        if (outcome) set(state.execution, outcome)
        if (error) set(state.error, error)
        set(state.executing, false)
        set(state.busy, false)
      }
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

/** 準備請 Claude 依目前的目標與選擇評估合併風險；只取得預覽，等使用者確認後才傳送。 */
export async function previewAdvice(): Promise<void> {
  const workspace = selectedWorkspace()
  const target = finishTargets().find((entry) => entry.id === read(state.finishTargetId))
  if (!workspace || !target || read(state.busy) || read(state.executing)) return
  invalidatePreview()
  set(state.advice, null)
  await run(() => plugin.request('hub.preview', { kind: 'finish-advice', workspaceId: workspace.id, targetWorkspaceId: target.id,
    strategy: read(state.finishStrategy), squash: read(state.finishSquash) }, { signal: panelSignal, timeoutMs: 120000 }),
  (preview) => set(state.advicePreview, preview))
}

/** 使用者確認後才傳送；建議只顯示，不改任何選項。切換工作樹後晚到的結果由 run() 丟棄。 */
export async function writeAdvice(): Promise<void> {
  const preview = read(state.advicePreview)
  if (!preview || read(state.busy) || read(state.executing)) return
  set(state.advicePreview, null)
  set(state.adviceWriting, true)
  await run(() => plugin.request('hub.execute', { token: preview.token }, { signal: panelSignal, timeoutMs: 120000 }), (answer) => {
    if (answer.advice) set(state.advice, answer.advice)
    set(state.notice, answer.message)
  })
  set(state.adviceWriting, false)
}

export function cancelAdvice(): void {
  set(state.advicePreview, null)
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
  ++contextSequence
  observedActiveWorkspaceId = undefined
  pendingContextChange = false
  ctx.subscriptions.push(on('workspace.changed', () => followActiveWorkspace()))
  void refresh('', true)
  ctx.subscriptions.push({ dispose: () => { ++requestSequence; ++contextSequence } })
}
