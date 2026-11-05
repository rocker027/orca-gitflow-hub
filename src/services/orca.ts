import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Run, Workspace } from '../contracts'

export interface CreateWorkspace { name: string; base: string; agent: string; prompt: string }
type ObjectValue = Record<string, unknown>
const AGENTS = ['codex', 'claude', 'omp']
const isObject = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')

function decode(text: string): ObjectValue {
  let payload: unknown
  try { payload = JSON.parse(text) } catch { throw new Error('Orca 回應不是有效 JSON。') }
  if (!isObject(payload) || payload.ok !== true || !isObject(payload.result)) {
    throw new Error('Orca 操作失敗或回應格式不支援；請核對操作結果後再繼續。')
  }
  return payload.result
}

function parseWorkspace(value: unknown): Workspace | undefined {
  if (!isObject(value) || value.hostId !== 'local' || value.isBare === true) return undefined
  const fields = ['id', 'repoId', 'path', 'head', 'branch', 'displayName'] as const
  if (!fields.every(key => isString(value[key])) || typeof value.isMainWorktree !== 'boolean') return undefined
  if (!isAbsolute(value.path as string) || value.id !== `${value.repoId}::${value.path}`) return undefined
  return {id: value.id as string, repoId: value.repoId as string, path: value.path as string,
    head: value.head as string, branch: value.branch as string, displayName: value.displayName as string,
    hostId: 'local', isMainWorktree: value.isMainWorktree}
}

function completeRows(reply: ObjectValue): unknown[] {
  const scope = reply.hostScope
  if (!Array.isArray(reply.worktrees) || reply.truncated !== false || !isObject(scope) ||
    !Array.isArray(scope.hostIds) || !scope.hostIds.includes('local') ||
    !Array.isArray(scope.omittedHostIds) || scope.omittedHostIds.includes('local')) {
    throw new Error('Orca 工作區資料不完整，請重新整理後再操作。')
  }
  return reply.worktrees
}

function primaryWorkspaces(rows: unknown[]): Workspace[] {
  const workspaces: Workspace[] = []
  const ids = new Set<string>()
  for (const row of rows) {
    if (!isObject(row) || !isString(row.hostId)) throw new Error('Orca 工作區身分無法辨識。')
    if (row.hostId !== 'local' || row.isBare === true) continue
    const workspace = parseWorkspace(row)
    if (!workspace || ids.has(workspace.id)) throw new Error('Orca 本機工作區資料異常或重複，請重新整理。')
    ids.add(workspace.id)
    workspaces.push(workspace)
  }
  return workspaces
}

function activityMetadata(rows: unknown[]): Map<string, ObjectValue> {
  const metadata = new Map<string, ObjectValue>()
  for (const row of rows) {
    if (!isObject(row) || !isString(row.hostId)) throw new Error('Orca 活動清單身分無法辨識。')
    if (row.hostId !== 'local' || row.workspaceKind === 'folder') continue
    const fields = ['worktreeId', 'repoId', 'path', 'branch', 'repo'] as const
    if (!fields.every(key => isString(row[key])) || !(row.repo as string).trim() ||
      row.worktreeId !== `${row.repoId}::${row.path}` || !isAbsolute(row.path as string) ||
      typeof row.isMainWorktree !== 'boolean' || typeof row.defaultBranch !== 'boolean' || typeof row.isActive !== 'boolean' ||
      metadata.has(row.worktreeId as string)) throw new Error('Orca 活動清單資料異常或重複，請重新整理。')
    metadata.set(row.worktreeId as string, row)
  }
  return metadata
}

function mergeMetadata(workspace: Workspace, metadata: Map<string, ObjectValue>): Workspace {
  const activity = metadata.get(workspace.id)
  if (!activity || activity.repoId !== workspace.repoId || activity.path !== workspace.path ||
    activity.branch !== workspace.branch || activity.isMainWorktree !== workspace.isMainWorktree) {
    throw new Error('Orca 工作區與活動清單身分不一致，請重新整理後再操作。')
  }
  return {...workspace, repoName: activity.repo as string, isActive: activity.isActive as boolean,
    isDefaultBranch: activity.defaultBranch as boolean}
}

function local(workspace: Workspace): void {
  if (workspace.hostId !== 'local' || !isAbsolute(workspace.path) || workspace.id !== `${workspace.repoId}::${workspace.path}`) {
    throw new Error('只支援已識別的本機 Git 工作區。')
  }
}

function checkAgent(agent: string, allowEmpty = false): void {
  if ((allowEmpty && agent === '') || AGENTS.includes(agent)) return
  throw new Error('不支援此 Agent，請選擇 Codex、Claude 或 OMP。')
}

function checkText(value: string, label: string, max: number, empty = false): void {
  if (!isString(value) || (!empty && !value.trim()) || value.length > max) throw new Error(`${label}不合法或過長。`)
}

function checkRef(value: string): void {
  if (!isString(value) || !value || value.length > 240 || value.startsWith('-') || value.startsWith('/') ||
    /[\s~^:?*\[\\]/u.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new Error('起始分支不合法，請使用完整分支名稱。')
  }
}

function launchHandle(reply: ObjectValue): string {
  const launch = isObject(reply.launch) ? reply.launch : reply
  const outcome = launch.outcome
  const prompt = launch.prompt
  if (!isObject(outcome) || !isString(outcome.handle) || !isObject(prompt) ||
    !['journaled', 'handed-to-terminal'].includes(String(prompt.outcome))) {
    throw new Error('Agent 啟動或提示投遞結果未知；請先查看 Orca，勿重複啟動。')
  }
  return outcome.handle
}

function finishedAgent(value: unknown, depth = 0): boolean {
  if (!isObject(value) || depth > 20 || value.state !== 'done') return false
  if (value.mainAgent !== undefined && (!isObject(value.mainAgent) || value.mainAgent.state !== 'done')) return false
  return value.children === undefined || (Array.isArray(value.children) && value.children.every(child => finishedAgent(child, depth + 1)))
}

export class OrcaService {
  constructor(private readonly run: Run) {}

  async list(): Promise<{workspaces: Workspace[]; warnings: string[]}> {
    let replies: ObjectValue[]
    try {
      replies = await Promise.all(['list', 'ps'].map(async command =>
        decode(await this.run('orca', ['worktree', command, '--limit', '10000', '--json']))))
    } catch { throw new Error('Orca 工作區資料無法完整取得，請重新整理後再操作。') }
    const [listed, activities] = replies
    const listedRows = completeRows(listed)
    const activityRows = completeRows(activities)
    const metadata = activityMetadata(activityRows)
    const workspaces = primaryWorkspaces(listedRows).map(workspace => mergeMetadata(workspace, metadata))
    const warnings: string[] = []
    if (workspaces.length !== listedRows.length) warnings.push('已略過遠端或非 Git 工作區。')
    if (replies.some(reply => (reply.hostScope as ObjectValue).omittedHostIds instanceof Array &&
      ((reply.hostScope as ObjectValue).omittedHostIds as unknown[]).length > 0)) {
      warnings.push('Orca 部分遠端主機範圍未涵蓋，空清單不代表沒有工作區。')
    }
    return {workspaces, warnings}
  }

  async resolve(id: string): Promise<Workspace> {
    checkText(id, '工作區 ID', 4096)
    const workspace = (await this.list()).workspaces.find(item => item.id === id)
    if (!workspace) throw new Error('此本機工作區不在 Orca 清單中，請重新整理。')
    let canonical: string
    try { canonical = await realpath(workspace.path) } catch { throw new Error('工作區路徑已失效，請重新整理 Orca。') }
    if (canonical !== resolvePath(workspace.path)) throw new Error('工作區路徑包含符號連結，請在 Orca 登錄實體路徑。')
    const top = (await this.run('git', ['rev-parse', '--show-toplevel'], {cwd: canonical})).trim()
    if (top !== canonical) throw new Error('Git 根目錄與 Orca 工作區不一致，已拒絕操作。')
    return workspace
  }

  async create(workspace: Workspace, input: CreateWorkspace): Promise<Workspace> {
    local(workspace)
    checkText(input.name, '工作區名稱', 100)
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(input.name) || input.name.includes('..') ||
      input.name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
      throw new Error('工作區名稱必須是有效的新分支名稱。')
    }
    checkRef(input.base)
    checkAgent(input.agent, true)
    checkText(input.prompt, '提示詞', 100_000, true)
    const args = ['worktree', 'create', '--repo', `id:${workspace.repoId}`, '--name', input.name.replace(/\//g, '-'),
      '--branch', input.name, '--base-branch', input.base, '--no-parent', '--setup', 'skip', '--json']
    if (input.agent) args.push('--agent', input.agent, ...(input.prompt ? ['--prompt', input.prompt] : []))
    const reply = decode(await this.run('orca', args, {cwd: workspace.path, timeoutMs: 120_000}))
    const created = parseWorkspace(reply.worktree)
    if (!created || created.repoId !== workspace.repoId) throw new Error('工作區建立結果未知，請重新整理 Orca，勿重複建立。')
    if (input.agent && input.prompt) launchHandle(reply)
    return created
  }

  async launch(workspace: Workspace, agent: string, prompt: string): Promise<string> {
    local(workspace)
    checkAgent(agent)
    checkText(prompt, '提示詞', 100_000)
    return launchHandle(decode(await this.run('orca', ['agent', 'launch', '--agent', agent,
      '--worktree', `id:${workspace.id}`, '--prompt', prompt, '--json'], {cwd: workspace.path, timeoutMs: 120_000})))
  }

  async link(workspace: Workspace, url: string): Promise<void> {
    local(workspace)
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('PR URL 不合法。') }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(parsed.pathname)) throw new Error('PR URL 必須是完整 HTTPS 位址且不含憑證。')
    decode(await this.run('orca', ['reference', 'add', url, '--worktree', `id:${workspace.id}`, '--json'], {cwd: workspace.path}))
  }

  async assertIdle(workspace: Workspace): Promise<void> {
    local(workspace)
    const reply = decode(await this.run('orca', ['worktree', 'ps', '--limit', '10000', '--json']))
    const scope = reply.hostScope
    if (reply.truncated !== false || !Array.isArray(reply.worktrees) || !isObject(scope) ||
      !Array.isArray(scope.hostIds) || !scope.hostIds.includes('local') || !Array.isArray(scope.omittedHostIds) || scope.omittedHostIds.includes('local')) {
      throw new Error('無法取得完整的 Orca 活動狀態，已停止清理。')
    }
    const activity = reply.worktrees.find(item => isObject(item) && item.worktreeId === workspace.id && item.hostId === 'local')
    if (!isObject(activity) || typeof activity.liveTerminalCount !== 'number' || typeof activity.unverifiableTerminalCount !== 'number' ||
      !Array.isArray(activity.agents) || typeof activity.hasAttachedPty !== 'boolean') throw new Error('工作區活動狀態未知，已停止清理。')
    if (activity.liveTerminalCount !== 0 || activity.unverifiableTerminalCount !== 0 || activity.hasAttachedPty || !activity.agents.every(agent => finishedAgent(agent))) {
      throw new Error('工作區仍有終端或 Agent，請先在 Orca 關閉後再清理。')
    }
  }

  async remove(workspace: Workspace): Promise<void> {
    local(workspace)
    if (workspace.isMainWorktree) throw new Error('不可移除主要工作區。')
    await this.assertIdle(workspace)
    const status = decode(await this.run('orca', ['status', '--json']))
    if (!isObject(status.runtime) || !Array.isArray(status.runtime.capabilities) ||
      !status.runtime.capabilities.includes('worktree.remove-branch-policy.v1')) {
      throw new Error('Orca 尚未支援保留分支的清理契約，請先更新 Orca。')
    }
    decode(await this.run('orca', ['worktree', 'rm', '--worktree', `id:${workspace.id}`, '--json'], {cwd: workspace.path, timeoutMs: 120_000}))
  }
}
