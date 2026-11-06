import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GitSnapshot, Run } from '../contracts'
import { GitService } from './git'

/** merge：可快轉則快轉，否則建立合併提交；rebase：把來源提交搬到目標最新進度後面，目標再快轉。 */
export type FinishStrategy = 'merge' | 'rebase'
export interface FinishOptions { strategy: FinishStrategy; squash: boolean }

export interface FinishPlan {
  source: GitSnapshot
  target: GitSnapshot
  files: string[]
  ahead: number
  behind: number
  needsCommit: boolean
  strategy: FinishStrategy
  /** 是否先把來源分支相對共同起點的全部提交合成一個。 */
  squash: boolean
  /** 選 squash 時會合成的提交數，含本次新提交；未選時為 0。 */
  squashCount: number
  /** 目標之後的來源提交中，已出現在遠端追蹤分支的數量；改寫後遠端需要 force push。 */
  pushedCount: number
  mergeMode: 'already_merged' | 'fast_forward' | 'merge_commit' | 'rebase'
  identity: {
    source: FinishWorktreeIdentity
    target: FinishWorktreeIdentity
    message: string
    committedHead?: string
    /** squash 或 rebase 改寫來源後的最新 HEAD；後續步驟只接受這個版本。 */
    sourceHead?: string
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

/** 預覽或執行時依規則拒絕（不是衝突），訊息直接給使用者看。 */
class FinishRefusal extends Error {}

const OPERATION_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_CONFLICT_FILES = 10
// 面板整個執行請求最多等 120 秒；rebase 留一半給其他步驟，逾時會 abort 並核對還原。
const REBASE_TIMEOUT_MS = 60_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseOptions(options: FinishOptions): FinishOptions {
  if (!options || !['merge', 'rebase'].includes(options.strategy) || typeof options.squash !== 'boolean') throw new Error('請選擇合併方式與是否合成一個提交')
  return { strategy: options.strategy, squash: options.squash }
}

/** 與 git commit -F 的 whitespace 清理一致：去掉行尾空白、頭尾空行，連續空行只留一行。 */
function cleanMessage(message: string): string {
  const lines = message.split(/\r?\n/).map((line) => line.trimEnd())
  const kept = lines.filter((line, index) => line || (index > 0 && lines[index - 1]))
  return `${kept.join('\n').trim()}\n`
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 核對並執行本機工作樹的提交與合併；生命週期由 Hub 管理。 */
export class FinishGitService {
  private readonly snapshots: GitService

  constructor(private readonly run: Run) { this.snapshots = new GitService(run) }

  private git(cwd: string, args: readonly string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
    return this.run('git', ['--no-pager', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd, ...options })
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
    if (!plan.identity || !SHA.test(plan.source.head) || !SHA.test(plan.target.head)) throw new Error('收尾預覽已過期或提交版本無效，請重新預覽')
    return plan.identity
  }

  /** 每一步只接受上一步產生的來源 HEAD，避免跳步或沿用舊預覽。 */
  private assertSourceHead(plan: FinishPlan, context: PlanContext, sourceHead: string): void {
    const expected = context.sourceHead ?? (plan.needsCommit ? context.committedHead : plan.source.head)
    if (!SHA.test(sourceHead) || sourceHead !== expected) throw new Error('來源提交不屬於本次收尾，請重新預覽')
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

  async prepare(sourcePath: string, targetPath: string, message: string,
    options: FinishOptions = { strategy: 'merge', squash: false }): Promise<FinishPlan> {
    const { strategy, squash } = parseOptions(options)
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
    const squashCount = squash ? await this.countSince(sourcePath, await this.mergeBase(sourcePath, target.head, source.head), source.head) + (needsCommit ? 1 : 0) : 0
    if (squash && squashCount >= 2 && !message.trim()) throw new Error('選了「合成一個提交」，請填寫「這次完成了什麼」，它會成為合成後的提交說明')
    if (strategy === 'rebase' && !squash && behind > 0) await this.assertNoMerges(sourcePath, target.head, source.head)
    const mergeMode = !needsCommit && ahead === 0 ? 'already_merged' : behind === 0 ? 'fast_forward' : strategy === 'rebase' ? 'rebase' : 'merge_commit'
    const unpushed = Number((await this.git(sourcePath, ['rev-list', '--count', `${target.head}..${source.head}`, '--not', '--remotes'])).trim())
    const context = { source: sourceIdentity, target: targetIdentity, message }
    const plan: FinishPlan = { source, target, files: [...new Set(source.files.map((file) => file.path))], ahead, behind, needsCommit,
      strategy, squash, squashCount, pushedCount: Math.max(0, ahead - unpushed), mergeMode, identity: context }
    // 未提交內容還不是提交，無法模擬；那種情況由執行時每一步改寫前的預檢負責。
    const chain = !needsCommit && mergeMode !== 'already_merged' ? await this.simulate(sourcePath, targetPath, plan, source.head) : []
    if (mergeMode === 'rebase') await this.assertIgnoredUntouched(sourcePath, target.head, source.head, chain)
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

  /**
   * 把來源分支相對共同起點的全部提交合成一個，tree 不變所以來源工作樹仍然乾淨。
   * 以 commit-tree 建立提交、update-ref 比對舊值後更新，不會留下半完成的狀態；這一步不執行 commit hooks。
   */
  async squash(sourcePath: string, plan: FinishPlan, sourceHead: string, message: string): Promise<string> {
    const context = this.context(plan)
    this.assertSourceHead(plan, context, sourceHead)
    if (!plan.squash) return sourceHead
    const base = await this.mergeBase(sourcePath, plan.target.head, sourceHead)
    if (await this.countSince(sourcePath, base, sourceHead) < 2) return sourceHead
    if (message !== context.message || !message.trim()) throw new Error('合成提交的說明與預覽不同，請重新預覽')
    await this.precheck(sourcePath, context.target.path, plan, sourceHead)
    await this.checkMergeState(sourcePath, context.target.path, plan, sourceHead, context)
    const tree = (await this.git(sourcePath, ['rev-parse', '--verify', `${sourceHead}^{tree}`])).trim()
    const sign = (await this.git(sourcePath, ['config', '--bool', '--default=false', '--get', 'commit.gpgSign'])).trim() === 'true'
    let squashed: string
    try {
      squashed = (await this.git(sourcePath, ['commit-tree', ...(sign ? ['-S'] : []), tree, '-p', base, '-F', '-'], { input: cleanMessage(message) })).trim()
      if (!SHA.test(squashed)) throw new Error('commit-tree 未回傳提交')
    } catch (error) {
      throw new Error(`無法建立合成後的提交，分支沒有改變：${errorText(error)}`)
    }
    await this.checkMergeState(sourcePath, context.target.path, plan, sourceHead, context)
    try {
      await this.git(sourcePath, ['update-ref', '-m', 'gitflow-hub: squash', `refs/heads/${plan.source.branch}`, squashed, sourceHead])
      const after = await this.snapshots.snapshot(sourcePath)
      if (after.head !== squashed || after.branch !== plan.source.branch || after.files.length) throw new Error('合成後來源 HEAD、分支或內容異常')
    } catch (error) {
      throw new Error(`合成提交結果待核對（UNKNOWN），可能已改寫分支，請保留工作樹：${errorText(error)}`)
    }
    context.sourceHead = squashed
    return squashed
  }

  /**
   * 選 rebase 且目標已前進時，把來源提交搬到目標最新進度後面。
   * 先逐提交模擬，失敗時由 Hub 自己 abort 這次 rebase 並核對已還原；無法核對才標 UNKNOWN。
   */
  async rebase(sourcePath: string, plan: FinishPlan, sourceHead: string): Promise<string> {
    const context = this.context(plan)
    this.assertSourceHead(plan, context, sourceHead)
    // 目標已在來源之後（不用搬）或來源早已併入目標（沒有可搬的提交）時都不改寫。
    if (plan.strategy !== 'rebase' || await this.isAncestor(sourcePath, plan.target.head, sourceHead)
      || await this.isAncestor(sourcePath, sourceHead, plan.target.head)) return sourceHead
    const chain = await this.simulate(sourcePath, context.target.path, plan, sourceHead)
    const expectedTree = chain[chain.length - 1]
    await this.checkMergeState(sourcePath, context.target.path, plan, sourceHead, context)
    await this.assertIgnoredUntouched(sourcePath, plan.target.head, sourceHead, chain)
    try {
      await this.git(sourcePath, ['-c', 'core.editor=false', 'rebase', '--reapply-cherry-picks', '--no-autosquash', '--no-autostash',
        '--no-update-refs', '--no-rebase-merges', plan.target.head], { timeoutMs: REBASE_TIMEOUT_MS })
    } catch (error) {
      throw await this.restoreRebase(sourcePath, plan, sourceHead, error)
    }
    try {
      const after = await this.snapshots.snapshot(sourcePath)
      if (after.branch !== plan.source.branch || after.files.length) throw new Error('rebase 後來源分支或內容異常')
      await this.git(sourcePath, ['merge-base', '--is-ancestor', plan.target.head, after.head])
      if ((await this.git(sourcePath, ['rev-parse', `${after.head}^{tree}`])).trim() !== expectedTree) throw new Error('rebase 後內容與預檢不符')
      context.sourceHead = after.head
      return after.head
    } catch (error) {
      throw new Error(`rebase 結果待核對（UNKNOWN），${plan.target.branch} 尚未更新，請保留工作樹：${errorText(error)}`)
    }
  }

  private async restoreRebase(cwd: string, plan: FinishPlan, sourceHead: string, cause: unknown): Promise<Error> {
    try {
      const gitDir = (await this.git(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
      if (await exists(join(gitDir, 'rebase-merge')) || await exists(join(gitDir, 'rebase-apply'))) await this.git(cwd, ['rebase', '--abort'])
      const after = await this.snapshots.snapshot(cwd)
      if (after.head !== sourceHead || after.branch !== plan.source.branch || after.files.length) throw new Error('還原後的 HEAD 或內容與 rebase 前不同')
    } catch (error) {
      return new Error(`rebase 失敗，且無法確認是否已還原（UNKNOWN），請保留工作樹並人工檢查：${errorText(error)}；原因：${errorText(cause)}`)
    }
    return new Error(`rebase 沒有完成，分支與已追蹤的檔案已回到 rebase 前的狀態，${plan.target.branch} 沒有改變。可以改選「一般合併」再試一次。原因：${errorText(cause)}`)
  }

  async merge(sourcePath: string, targetPath: string, plan: FinishPlan, sourceHead: string): Promise<string> {
    const context = this.context(plan)
    this.assertSourceHead(plan, context, sourceHead)
    await this.checkMergeState(sourcePath, targetPath, plan, sourceHead, context)
    let expectedTree: string
    try {
      expectedTree = await this.mergeTree(targetPath, [plan.target.head, sourceHead])
    } catch (error) {
      throw await this.conflictError(targetPath, plan, sourceHead, error, context.sourceHead !== undefined)
    }
    await this.checkMergeState(sourcePath, targetPath, plan, sourceHead, context)
    try {
      // rebase 後目標只能快轉；任何非快轉都代表狀態與預檢不符，交給 Git 拒絕。
      const mode = plan.strategy === 'rebase' ? '--ff-only' : '--ff'
      // 以固定 SHA 合併避免分支在預覽後移動；說明改用分支名稱，否則紀錄只看得到一串提交編號。
      const message = `Merge branch '${plan.source.branch}' into ${plan.target.branch}`
      await this.git(targetPath, ['merge', mode, '--no-edit', '-m', message, '--no-overwrite-ignore', '--no-squash', '--commit', '--no-autostash', sourceHead])
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

  /** 不寫入任何分支，模擬本次策略合到目標後的內容並回傳預期 tree；有衝突時丟出列出檔案的說明。 */
  async precheck(sourcePath: string, targetPath: string, plan: FinishPlan, sourceHead: string): Promise<string> {
    const chain = await this.simulate(sourcePath, targetPath, plan, sourceHead)
    return chain[chain.length - 1]
  }

  /**
   * 依序回傳模擬過程的 tree，第一個是目標 HEAD 的 tree，最後一個是預期結果。
   * squash 以共同起點三方合併；rebase 逐提交以 merge-tree --merge-base 串接，與 git rebase 的結果一致。
   */
  private async simulate(sourcePath: string, targetPath: string, plan: FinishPlan, sourceHead: string): Promise<string[]> {
    const target = plan.target.head
    try {
      const targetTree = (await this.git(sourcePath, ['rev-parse', '--verify', `${target}^{tree}`])).trim()
      if (await this.isAncestor(sourcePath, sourceHead, target)) return [targetTree]
      if (plan.squash) return [targetTree, await this.mergeTree(sourcePath, [`--merge-base=${await this.mergeBase(sourcePath, target, sourceHead)}`, target, sourceHead])]
      if (plan.strategy === 'merge' || await this.isAncestor(sourcePath, target, sourceHead)) return [targetTree, await this.mergeTree(sourcePath, [target, sourceHead])]
      await this.assertNoMerges(sourcePath, target, sourceHead)
      const chain = [targetTree]
      for (const line of (await this.git(sourcePath, ['rev-list', '--reverse', '--parents', `${target}..${sourceHead}`])).trim().split('\n')) {
        const [commit, parent] = line.split(' ')
        if (!SHA.test(commit) || !SHA.test(parent)) throw new Error('無法辨識要搬移的提交')
        chain.push(await this.mergeTree(sourcePath, [`--merge-base=${parent}`, chain[chain.length - 1], commit]))
      }
      return chain
    } catch (error) {
      if (error instanceof FinishRefusal) throw error
      throw await this.conflictError(targetPath, plan, sourceHead, error, plan.identity?.sourceHead !== undefined)
    }
  }

  private async mergeTree(cwd: string, args: readonly string[]): Promise<string> {
    const tree = (await this.git(cwd, ['merge-tree', '--write-tree', '--no-messages', ...args])).split('\n')[0]
    if (!SHA.test(tree)) throw new Error('merge-tree 未回傳可核對的結果')
    return tree
  }

  /** @param afterRewrite 合成或 rebase 已完成後才發生時為 true，此時不能宣稱提交沒有被改寫。 */
  private async conflictError(cwd: string, plan: FinishPlan, sourceHead: string, cause: unknown, afterRewrite = false): Promise<Error> {
    const target = plan.target.branch
    const untouched = afterRewrite ? `${target} 沒有被改動。` : `${target} 沒有被改動，你的改動都還在。`
    const files = await this.overlap(cwd, plan.target.head, sourceHead).catch(() => [] as string[])
    if (!files.length) return new Error(`${untouched}合併預檢失敗（可能有衝突或 Git 不支援 merge-tree）：${errorText(cause)}`)
    const shown = files.slice(0, MAX_CONFLICT_FILES).join('、') + (files.length > MAX_CONFLICT_FILES ? ` 等 ${files.length} 個檔案` : '')
    const mergeWorks = plan.strategy === 'rebase' && !plan.squash
      && await this.mergeTree(cwd, [plan.target.head, sourceHead]).then(() => true, () => false)
    // 先安撫、再說要做什麼，原因放最後；焦慮的使用者不必讀完整段才知道下一步。
    const hint = mergeWorks ? '請再按一次「完成這個工作」，第 2 題選「一般合併」就能完成。'
      : `這需要手動處理衝突，請找熟悉 Git 的人協助；處理好後再按「完成這個工作」。`
    const where = mergeWorks ? `用「接到最後面」時，${target} 和這個工作都改過` : `${target} 和這個工作都改過`
    return new Error(`${untouched}有衝突，無法自動合併。${hint}原因：${where} ${shown}。`)
  }

  /**
   * 列出共同起點之後兩邊都改過的檔案，作為衝突提示；實際衝突是其中一部分。
   * 來源端另計每個提交動過的檔案：rebase 逐提交重放，改了又改回的檔案也可能衝突。
   */
  private async overlap(cwd: string, targetHead: string, sourceHead: string): Promise<string[]> {
    const base = (await this.git(cwd, ['merge-base', targetHead, sourceHead])).trim()
    const names = async (args: readonly string[]) => (await this.git(cwd, args)).split('\0').filter(Boolean)
    const ours = new Set(await names(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, targetHead]))
    const theirs = new Set([...await names(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, sourceHead]),
      ...await names(['log', '--format=', '--name-only', '-z', '--no-renames', `${base}..${sourceHead}`])])
    return [...theirs].filter((path) => ours.has(path))
  }

  /**
   * git rebase 沒有 --no-overwrite-ignore，會直接覆蓋被忽略的本機檔，abort 時還可能刪掉它們。
   * 會被寫到的路徑取來源與目標的差異、要搬移的提交，以及模擬串接中每一步的差異（涵蓋資料夾改名）。
   * 比對前去掉結尾斜線、統一 Unicode 正規化；core.ignoreCase 開啟時不分大小寫，同名檔案取代資料夾也算重疊。
   */
  private async assertIgnoredUntouched(cwd: string, targetHead: string, sourceHead: string, chain: readonly string[]): Promise<void> {
    const ignored = (await this.git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean)
    if (!ignored.length) return
    const names = async (args: readonly string[]) => (await this.git(cwd, args)).split('\0').filter(Boolean)
    const touched = [
      ...await names(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', sourceHead, targetHead]),
      ...await names(['log', '--format=', '--name-only', '-z', '--no-renames', `${targetHead}..${sourceHead}`])
    ]
    for (let index = 1; index < chain.length; index++) {
      touched.push(...await names(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', chain[index - 1], chain[index]]))
    }
    const ignoreCase = (await this.git(cwd, ['config', '--bool', '--default=false', '--get', 'core.ignoreCase'])).trim() === 'true'
    const key = (path: string) => {
      const plain = path.replace(/\/$/, '').normalize('NFC')
      return ignoreCase ? plain.toLowerCase() : plain
    }
    const written = touched.map(key)
    const hits = ignored.filter((path) => {
      const ignoredKey = key(path)
      return written.some((entry) => entry === ignoredKey || entry.startsWith(`${ignoredKey}/`) || ignoredKey.startsWith(`${entry}/`))
    })
    if (!hits.length) return
    const shown = hits.slice(0, MAX_CONFLICT_FILES).join('、') + (hits.length > MAX_CONFLICT_FILES ? ` 等 ${hits.length} 個` : '')
    throw new FinishRefusal(`這個工作資料夾裡有被 Git 忽略的本機檔案（例如 .env），rebase 可能會覆蓋或刪除它們：${shown}。請改選「一般合併」，或先把這些檔案移到別處。`)
  }

  private async mergeBase(cwd: string, targetHead: string, sourceHead: string): Promise<string> {
    let bases: string[]
    try { bases = (await this.git(cwd, ['merge-base', '--all', targetHead, sourceHead])).trim().split('\n').filter(Boolean) } catch { bases = [] }
    if (!bases.length) throw new FinishRefusal('這個工作和目標分支沒有共同起點，無法合成一個提交')
    if (bases.length > 1) throw new FinishRefusal('這個工作和目標分支的歷史有多個共同起點，無法安全合成一個提交，請改選「保留每個提交」')
    return bases[0]
  }

  private async countSince(cwd: string, base: string, head: string): Promise<number> {
    const count = Number((await this.git(cwd, ['rev-list', '--count', `${base}..${head}`])).trim())
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('無法計算提交數量')
    return count
  }

  private async assertNoMerges(cwd: string, targetHead: string, sourceHead: string): Promise<void> {
    if ((await this.git(cwd, ['rev-list', '--count', '--merges', `${targetHead}..${sourceHead}`])).trim() !== '0') {
      throw new FinishRefusal('這個工作含有合併提交，無法整理成一直線（rebase）。請改選「一般合併」，或選擇「合成一個提交」')
    }
  }

  private async isAncestor(cwd: string, ancestor: string, head: string): Promise<boolean> {
    return this.git(cwd, ['merge-base', '--is-ancestor', ancestor, head]).then(() => true, () => false)
  }

  private async checkMergeState(sourcePath: string, targetPath: string, plan: FinishPlan, sourceHead: string, context: PlanContext): Promise<void> {
    await this.checkPair(sourcePath, targetPath, context)
    const source = await this.snapshots.snapshot(sourcePath)
    if (source.head !== sourceHead || source.branch !== plan.source.branch || source.files.length) throw new Error('來源 HEAD、分支或內容已變更，不能合併')
    await this.checkTarget(targetPath, plan)
  }
}
