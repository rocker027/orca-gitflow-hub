import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GitSnapshot, Run } from '../contracts'
import { GitService } from './git'

export interface FinishPlan {
  source: GitSnapshot
  target: GitSnapshot
  files: string[]
  ahead: number
  behind: number
  needsCommit: boolean
  mergeMode: 'already_merged' | 'fast_forward' | 'merge_commit'
  identity: {
    source: FinishWorktreeIdentity
    target: FinishWorktreeIdentity
    message: string
    committedHead?: string
  }
}

export interface FinishWorktreeIdentity {
  path: string
  commonDir: string
  gitDir: string
  identity: string
  branch: string
}

type PlanContext = FinishPlan['identity']

const OPERATION_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 核對並執行本機工作樹的提交與合併；生命週期由 Hub 管理。 */
export class FinishGitService {
  private readonly snapshots: GitService

  constructor(private readonly run: Run) { this.snapshots = new GitService(run) }

  private git(cwd: string, args: readonly string[]): Promise<string> {
    return this.run('git', ['--no-pager', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd })
  }

  private async assertIdle(gitDir: string, commonDir: string): Promise<void> {
    for (const directory of new Set([gitDir, commonDir])) {
      const entries = await readdir(directory)
      for (const name of entries.filter((entry) => OPERATION_MARKERS.includes(entry) || entry.endsWith('.lock'))) {
        if (directory === commonDir && name === 'gitflow-hub.lock' && (await lstat(join(directory, name))).isDirectory()) continue
        throw new Error('有進行中的 Git 操作或 lock 鎖，請先人工處理')
      }
    }
    const refs = await readdir(join(commonDir, 'refs'), { recursive: true })
    if (refs.some((name) => name.endsWith('.lock'))) throw new Error('Git 分支有進行中的 lock 鎖')
  }

  private async identity(cwd: string, source: boolean): Promise<FinishWorktreeIdentity> {
    const path = await realpath(cwd)
    const gitDir = await realpath((await this.git(cwd, ['rev-parse', '--absolute-git-dir'])).replace(/\n$/, ''))
    const commonDir = await realpath(resolve(cwd, (await this.git(cwd, ['rev-parse', '--git-common-dir'])).replace(/\n$/, '')))
    await this.assertIdle(gitDir, commonDir)
    await this.snapshots.assertCompleteWorktree(cwd)
    const records = (await this.git(cwd, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').filter(Boolean)
    const index = records.findIndex((record) => record.split('\0').includes(`worktree ${path}`))
    if (index < 0) throw new Error('無法確認工作樹登錄與路徑身分')
    if (source && index === 0) throw new Error('主要工作樹不可作為收尾來源')
    const fields = records[index].split('\0')
    if (fields.some((field) => /^(locked|prunable)(?: |$)/.test(field))) throw new Error('工作樹已鎖定或登錄失效')
    const branch = fields.find((field) => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)
    if (!branch) throw new Error('收尾需要本機分支，不支援 detached HEAD')
    const staged = await this.git(cwd, ['ls-files', '--stage', '-z'])
    const committed = await this.git(cwd, ['ls-tree', '-r', '-z', 'HEAD'])
    if ([staged, committed].some((value) => value.split('\0').some((entry) => entry.startsWith('160000 ')))) {
      throw new Error('含 submodule 的工作樹不提供自動收尾')
    }
    const stats = await Promise.all([path, gitDir, commonDir].map(async (entry) => {
      const stat = await lstat(entry)
      return [stat.dev, stat.ino]
    }))
    return { path, commonDir, gitDir, branch, identity: JSON.stringify([path, gitDir, commonDir, stats, branch]) }
  }

  private assertPair(source: FinishWorktreeIdentity, target: FinishWorktreeIdentity): void {
    if (source.path === target.path) throw new Error('來源與目標必須是不同工作樹')
    if (source.commonDir !== target.commonDir) throw new Error('來源與目標必須位於同一 Git 儲存庫 repo')
    if (source.branch === target.branch) throw new Error('來源與目標必須是不同本機分支')
  }

  private context(plan: FinishPlan): PlanContext {
    if (!plan.identity || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(plan.source.head)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(plan.target.head)) throw new Error('收尾預覽已過期或提交版本無效，請重新預覽')
    return plan.identity
  }

  private async checkPair(sourcePath: string, targetPath: string, context: PlanContext): Promise<void> {
    const source = await this.identity(sourcePath, true)
    const target = await this.identity(targetPath, false)
    this.assertPair(source, target)
    const fields: (keyof FinishWorktreeIdentity)[] = ['path', 'commonDir', 'gitDir', 'identity', 'branch']
    if (fields.some((field) => source[field] !== context.source[field] || target[field] !== context.target[field])) {
      throw new Error('來源或目標的路徑身分／分支已變更，請重新預覽')
    }
  }

  private async checkTarget(targetPath: string, plan: FinishPlan): Promise<void> {
    const target = await this.snapshots.snapshot(targetPath)
    if (target.fingerprint !== plan.target.fingerprint || target.head !== plan.target.head
      || target.branch !== plan.target.branch || target.files.length) throw new Error('目標工作樹已變更，預覽已過期')
  }

  async prepare(sourcePath: string, targetPath: string, message: string): Promise<FinishPlan> {
    const sourceIdentity = await this.identity(sourcePath, true)
    const targetIdentity = await this.identity(targetPath, false)
    this.assertPair(sourceIdentity, targetIdentity)
    const target = await this.snapshots.snapshot(targetPath)
    if (target.files.length) throw new Error('目標工作樹必須乾淨，請先處理變更')
    const source = await this.snapshots.previewAllChanges(sourcePath, message)
    const counts = (await this.git(sourcePath, ['rev-list', '--left-right', '--count', `${target.head}...${source.head}`])).trim().split(/\s+/).map(Number)
    if (counts.length !== 2 || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('無法核對分支領先與落後數量')
    const [behind, ahead] = counts
    const needsCommit = source.files.length > 0
    const mergeMode = !needsCommit && ahead === 0 ? 'already_merged' : behind === 0 ? 'fast_forward' : 'merge_commit'
    const context = { source: sourceIdentity, target: targetIdentity, message }
    const plan: FinishPlan = { source, target, files: [...new Set(source.files.map((file) => file.path))], ahead, behind, needsCommit, mergeMode, identity: context }
    await this.checkPair(sourcePath, targetPath, context)
    await this.checkTarget(targetPath, plan)
    if ((await this.snapshots.snapshot(sourcePath)).fingerprint !== source.fingerprint) throw new Error('來源工作樹在預覽期間已變更')
    return plan
  }

  async commit(sourcePath: string, plan: FinishPlan, message: string): Promise<string> {
    const context = this.context(plan)
    await this.checkPair(sourcePath, context.target.path, context)
    await this.checkTarget(context.target.path, plan)
    const current = await this.snapshots.previewAllChanges(sourcePath, message)
    if (current.fingerprint !== plan.source.fingerprint || current.head !== plan.source.head || current.branch !== plan.source.branch
      || (plan.needsCommit && message !== context.message)) {
      throw new Error('來源內容或提交訊息已變更，預覽已過期')
    }
    if (!plan.needsCommit) return current.head
    await this.snapshots.stage(sourcePath, plan.files, current.fingerprint)
    const preview = await this.snapshots.previewCommit(sourcePath, message)
    const expectedTree = (await this.git(sourcePath, ['write-tree'])).trim()
    await this.checkPair(sourcePath, context.target.path, context)
    await this.checkTarget(context.target.path, plan)
    try {
      const committed = await this.snapshots.commit(sourcePath, preview)
      const signature = (await this.git(sourcePath, ['show', '-s', '--format=%P%n%T', committed.head])).trim().split('\n')
      if (signature[0] !== plan.source.head || signature[1] !== expectedTree) throw new Error('提交 parent 或 tree 與預覽不符')
      const after = await this.snapshots.snapshot(sourcePath)
      if (after.head !== committed.head || after.branch !== plan.source.branch || after.files.length) throw new Error('提交後來源 HEAD、分支或內容已變更')
      context.committedHead = committed.head
      return committed.head
    } catch (error) {
      throw new Error(`提交結果待核對（UNKNOWN），可能已寫入，請保留工作樹：${errorText(error)}`)
    }
  }

  async merge(sourcePath: string, targetPath: string, plan: FinishPlan, sourceHead: string): Promise<string> {
    const context = this.context(plan)
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceHead)
      || sourceHead !== (plan.needsCommit ? context.committedHead : plan.source.head)) throw new Error('來源提交不屬於本次收尾，請重新預覽')
    await this.checkMergeState(sourcePath, targetPath, plan, sourceHead, context)
    let expectedTree: string
    try {
      expectedTree = (await this.git(targetPath, ['merge-tree', '--write-tree', plan.target.head, sourceHead])).split('\n')[0]
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedTree)) throw new Error('merge-tree 未回傳可核對的結果')
    } catch (error) {
      throw new Error(`合併預檢失敗（可能有衝突或 Git 不支援 merge-tree），未執行目標合併：${errorText(error)}`)
    }
    await this.checkMergeState(sourcePath, targetPath, plan, sourceHead, context)
    try {
      await this.git(targetPath, ['merge', '--ff', '--no-edit', '--no-overwrite-ignore', '--no-squash', '--commit', '--no-autostash', sourceHead])
      const merged = await this.snapshots.snapshot(targetPath)
      if (merged.branch !== plan.target.branch || merged.files.length) throw new Error('合併後目標分支或內容異常')
      await this.git(targetPath, ['merge-base', '--is-ancestor', sourceHead, merged.head])
      await this.git(targetPath, ['merge-base', '--is-ancestor', plan.target.head, merged.head])
      if ((await this.git(targetPath, ['rev-parse', `${merged.head}^{tree}`])).trim() !== expectedTree) throw new Error('合併後內容與 merge-tree 預檢不符')
      return merged.head
    } catch (error) {
      throw new Error(`合併結果待核對（UNKNOWN），可能已修改目標，請保留工作樹：${errorText(error)}`)
    }
  }

  private async checkMergeState(sourcePath: string, targetPath: string, plan: FinishPlan, sourceHead: string, context: PlanContext): Promise<void> {
    await this.checkPair(sourcePath, targetPath, context)
    const source = await this.snapshots.snapshot(sourcePath)
    if (source.head !== sourceHead || source.branch !== plan.source.branch || source.files.length) throw new Error('來源 HEAD、分支或內容已變更，不能合併')
    await this.checkTarget(targetPath, plan)
  }
}
