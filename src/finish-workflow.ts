import type { Workspace } from './contracts'
import type { Execution, FinishStepId, HubAction } from './protocol'
import type { FinishGitService, FinishPlan } from './services/finish'
import type { GitService } from './services/git'
import { workspaceLabel, type OrcaService } from './services/orca'
import { lstat } from 'node:fs/promises'

export type FinishAction = Extract<HubAction, {kind:'finish'}>
export interface FinishContext { target: Workspace; plan: FinishPlan }
type Step = NonNullable<Execution['steps']>[number]
interface Version { head: string; fingerprint: string }
type SourceUse = Pick<FinishAction, 'remove' | 'strategy'>

export class FinishWorkflow {
  constructor(private readonly git: GitService, private readonly orca: OrcaService,
    private readonly finish: FinishGitService, private readonly open: (id:string)=>Promise<{opened:boolean}>) {}
  private validate(source: Workspace, target: Workspace): void {
    if (source.isMainWorktree || source.isDefaultBranch) throw new Error('主要工作樹或預設分支不能作為收尾來源，請選功能工作樹。')
    if (source.id === target.id || source.path === target.path) throw new Error('來源與目標工作樹不可相同。')
    if (source.repoId !== target.repoId) throw new Error('收尾目標必須位於同一個儲存庫。')
  }
  /**
   * 核對雙方身分未變並檢查活動狀態。目標會被合併寫入，一律要求沒有終端與 AI 助手。
   * @param sourceUse 決定來源終端是否需要關閉的選項
   * @param offerChoice 是否提示改選能避開的選項；只在尚未改動任何東西時傳 true
   */
  private async participants(source: Workspace, target: Workspace, sourceUse: SourceUse, offerChoice = false): Promise<void> {
    for (const original of [source, target]) {
      const current = await this.orca.resolve(original.id)
      if (current.path !== original.path || current.repoId !== original.repoId || current.isMainWorktree !== original.isMainWorktree || current.isDefaultBranch !== original.isDefaultBranch) {
        throw new Error('工作樹身分已變更，請重新預覽。')
      }
      if (original === target) await this.orca.assertIdle(current)
      else await this.checkSource(current, sourceUse, offerChoice)
    }
  }

  /**
   * 來源一律不能有執行中的 AI 助手，因為提交時寫入的內容可能混進提交。
   * 終端只有在要移除資料夾，或選 Rebase 時才要求關閉；rebase 失敗的自動還原會覆蓋終端剛改的檔案。
   */
  private async checkSource(source: Workspace, sourceUse: SourceUse, offerChoice: boolean): Promise<void> {
    const {agentsBusy, terminalsOpen} = await this.orca.activity(source)
    const name = workspaceLabel(source)
    if (agentsBusy) throw new Error(`${name}還有 AI 助手在執行。請等它結束或在 Orca 關掉後再試一次。`)
    if (!terminalsOpen || !(sourceUse.remove || sourceUse.strategy === 'rebase')) return
    const choice = !offerChoice ? ''
      : sourceUse.strategy === 'rebase' ? 'Rebase 會改寫來源的檔案，必須關閉來源的終端機；改選 Merge 並保留資料夾就不必關閉。'
      : '若要保留資料夾，也可以取消勾選「完成後移除資料夾」，就不必關閉來源的終端機。'
    throw new Error(`${name}還開著終端機。請在 Orca 把它關掉後再試一次。${choice}`)
  }
  async prepare(source: Workspace, action: FinishAction): Promise<FinishContext> {
    const target = await this.orca.resolve(action.targetWorkspaceId)
    this.validate(source, target)
    await this.participants(source, target, action, true)
    if (action.remove && await this.git.hasIgnoredFiles(source.path)) {
      throw new Error('工作資料夾內有未由 Git 保存的忽略檔案，無法安全移除。請取消勾選「完成後移除資料夾」，再按「下一步：確認」。這些本機檔案會留在原資料夾。')
    }
    return {target, plan:await this.finish.prepare(source.path, target.path, action.message, {strategy:action.strategy, squash:action.squash})}
  }

  /** 只列本次相關的步驟；未選 squash／rebase 就不出現，讓結果頁對應使用者的選擇。 */
  private initialSteps(plan: FinishPlan, action: FinishAction): Step[] {
    const into = plan.target.branch
    const pending = (id: FinishStepId, label: string, detail = '尚未執行'): Step => ({id, label, status:'skipped', detail})
    return [
      pending('commit', plan.needsCommit ? '提交變更' : '沿用既有提交'),
      ...(action.squash ? [pending('squash', '合成一個提交')] : []),
      ...(action.strategy === 'rebase' ? [pending('rebase', `搬到 ${into} 最新進度後面`)] : []),
      pending('merge', `合併到 ${into}`),
      pending('cleanup', '移除工作資料夾', action.remove ? '尚未執行' : '依選項保留工作資料夾'),
      pending('open', `切換到 ${into}`)
    ]
  }

  async execute(source: Workspace, action: FinishAction, context: FinishContext): Promise<Execution> {
    const {target, plan} = context
    const into = plan.target.branch
    const steps = this.initialSteps(plan, action)
    const mark = (id: FinishStepId, status: Step['status'], detail: string) => {
      const index = steps.findIndex(step => step.id === id)
      steps[index] = {...steps[index], status, detail}
    }
    let current: FinishStepId = 'commit'
    let rewritten = false
    let merged = false
    try {
      if (target.id !== action.targetWorkspaceId) throw new Error('收尾目標與預覽不一致。')
      this.validate(source, target)
      await this.participants(source, target, action, true)
      let head = await this.finish.commit(source.path, plan, action.message)
      mark('commit', plan.needsCommit ? 'done' : 'skipped', `${head.slice(0,12)}${plan.needsCommit ? '' : '（沒有新變更）'}`)

      if (action.squash) {
        current = 'squash'
        await this.participants(source, target, action)
        const squashed = await this.finish.squash(source.path, plan, head, action.message)
        rewritten ||= squashed !== head
        mark('squash', squashed !== head ? 'done' : 'skipped', squashed !== head ? `${plan.squashCount} 個提交合成 1 個 · ${squashed.slice(0,12)}` : '沒有 2 個以上的提交，不需要合成')
        head = squashed
      }
      if (action.strategy === 'rebase') {
        current = 'rebase'
        await this.participants(source, target, action)
        const rebased = await this.finish.rebase(source.path, plan, head)
        rewritten ||= rebased !== head
        mark('rebase', rebased !== head ? 'done' : 'skipped', rebased !== head ? `已接在 ${into} 後面 · ${rebased.slice(0,12)}` : '沒有需要搬移的提交')
        head = rebased
      }
      const finalSource = await this.git.snapshot(source.path)
      if (finalSource.head !== head || finalSource.files.length) throw new Error('提交後工作樹又有變更，請核對已產生的提交。')

      current = 'merge'
      await this.participants(source, target, action)
      const targetHead = await this.finish.merge(source.path, target.path, plan, head)
      merged = true
      mark('merge', 'done', `${into} · ${targetHead.slice(0,12)}`)
      const mergedState = await this.git.snapshot(target.path)

      // 開啟目標可能自動建立終端；先完成清理，避免自己觸發的終端阻擋活動狀態檢查。
      if (action.remove) {
        current = 'cleanup'
        await this.cleanup(source, target, {head, fingerprint:finalSource.fingerprint}, {head:targetHead, fingerprint:mergedState.fingerprint})
        mark('cleanup', 'done', '已移除工作資料夾，保留本機分支')
      }
      current = 'open'
      if (!(await this.open(target.id)).opened) throw new Error('Orca 尚未確認已開啟目標。')
      mark('open', 'done', target.displayName)
      const kept = action.remove ? '並移除工作資料夾（分支保留）' : '工作資料夾仍保留'
      return {status:'completed',message:`完成了！已合併到這台電腦的 ${into}，${kept}。還沒上傳到 GitHub。`,workspaceId:target.id,steps}
    } catch (error) {
      const detail = error instanceof Error ? error.message : '操作結果待核對。'
      mark(current, 'failed', detail)
      const label = steps.find(step => step.id === current)?.label ?? '下一步'
      const tidied = rewritten ? '這個工作的提交已整理，' : ''
      const removed = steps.some(step => step.id === 'cleanup' && step.status === 'done') ? '，工作資料夾已移除（分支保留）' : ''
      // 合併步驟本身失敗時目標可能已被寫入（UNKNOWN），只有更早的步驟失敗才能保證目標沒被改動。
      const message = merged ? `已合併到 ${into}${removed}，但「${label}」未完成或結果待核對。${detail}`
        : current === 'merge' ? `${tidied}${detail.includes('UNKNOWN') ? `合併到 ${into} 的結果待核對。` : `還沒合併到 ${into}。`}${detail}`
        : detail.startsWith(`${into} 沒有被改動`) ? `收尾已停止。${tidied}${detail}`
        : `收尾已停止。${into} 沒有被改動。${tidied}${detail.includes('UNKNOWN') ? '' : '你的改動都還在，沒有遺失。'}${detail}`
      return {status:'needs_attention',message,workspaceId:merged ? target.id : source.id,steps}
    }
  }

  /** 移除前重新核對雙方仍是合併後的版本、來源可安全清理，再由 Orca 移除並確認目錄已不存在。 */
  private async cleanup(source: Workspace, target: Workspace, expectedSource: Version, expectedTarget: Version): Promise<void> {
    await this.participants(source, target, {remove:true, strategy:'merge'})
    const currentSource = await this.git.snapshot(source.path)
    const currentTarget = await this.git.snapshot(target.path)
    if (currentSource.head !== expectedSource.head || currentSource.fingerprint !== expectedSource.fingerprint ||
      currentTarget.head !== expectedTarget.head || currentTarget.fingerprint !== expectedTarget.fingerprint || currentTarget.files.length) {
      throw new Error('合併後工作樹又有變更，已停止清理。')
    }
    const check = await this.git.cleanupCheck(source.path, expectedTarget.head)
    if (!check.safe) throw new Error(`工作樹保留：${check.reasons.join('、')}`)
    await this.orca.remove(source)
    const remaining = await this.orca.list()
    if (remaining.workspaces.some(workspace => workspace.id === source.id) || remaining.warnings.some(warning => warning.includes('截斷'))) {
      throw new Error('Orca 清理結果仍待核對，請重新整理。')
    }
    let exists = true
    try { await lstat(source.path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false
      else throw error
    }
    if (exists) throw new Error('來源目錄仍存在，清理結果待核對。')
  }
}
