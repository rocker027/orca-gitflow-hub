import type { Workspace } from './contracts'
import type { Execution, HubAction } from './protocol'
import type { FinishGitService, FinishPlan } from './services/finish'
import type { GitService } from './services/git'
import type { OrcaService } from './services/orca'
import { lstat } from 'node:fs/promises'

export type FinishAction = Extract<HubAction, {kind:'finish'}>
export interface FinishContext { target: Workspace; plan: FinishPlan }

export class FinishWorkflow {
  constructor(private readonly git: GitService, private readonly orca: OrcaService,
    private readonly finish: FinishGitService, private readonly open: (id:string)=>Promise<{opened:boolean}>) {}
  private validate(source: Workspace, target: Workspace): void {
    if (source.isMainWorktree || source.isDefaultBranch) throw new Error('主要工作樹或預設分支不能作為收尾來源，請選功能工作樹。')
    if (source.id === target.id || source.path === target.path) throw new Error('來源與目標工作樹不可相同。')
    if (source.repoId !== target.repoId) throw new Error('收尾目標必須位於同一個儲存庫。')
  }
  private async participants(source: Workspace, target: Workspace): Promise<void> {
    for (const original of [source, target]) {
      const current = await this.orca.resolve(original.id)
      if (current.path !== original.path || current.repoId !== original.repoId || current.isMainWorktree !== original.isMainWorktree || current.isDefaultBranch !== original.isDefaultBranch) {
        throw new Error('工作樹身分已變更，請重新預覽。')
      }
      await this.orca.assertIdle(current)
    }
  }
  async prepare(source: Workspace, action: FinishAction): Promise<FinishContext> {
    const target = await this.orca.resolve(action.targetWorkspaceId)
    this.validate(source, target)
    await this.participants(source, target)
    return {target, plan:await this.finish.prepare(source.path, target.path, action.message)}
  }
  async execute(source: Workspace, action: FinishAction, context: FinishContext): Promise<Execution> {
    const {target, plan} = context
    const steps: NonNullable<Execution['steps']> = [
      {id:'commit',label:plan.needsCommit ? '提交變更' : '沿用既有提交',status:'skipped',detail:'尚未執行'},
      {id:'merge',label:'合回目標分支',status:'skipped',detail:'尚未執行'},
      {id:'open',label:'切換至目標工作樹',status:'skipped',detail:'尚未執行'},
      {id:'cleanup',label:'清理來源工作樹',status:'skipped',detail:action.remove ? '尚未執行' : '依選項保留工作樹'}
    ]
    let phase = 0
    let merged = false
    try {
      if (target.id !== action.targetWorkspaceId) throw new Error('收尾目標與預覽不一致。')
      this.validate(source, target)
      await this.participants(source, target)
      const sourceHead = await this.finish.commit(source.path, plan, action.message)
      const committed = await this.git.snapshot(source.path)
      if (committed.head !== sourceHead || committed.files.length) throw new Error('提交後工作樹又有變更，請核對已產生的提交。')
      steps[0] = {...steps[0],status:plan.needsCommit ? 'done' : 'skipped',detail:`${sourceHead.slice(0,12)}${plan.needsCommit ? '' : '（沒有新變更）'}`}

      phase = 1
      await this.participants(source, target)
      const targetHead = await this.finish.merge(source.path, target.path, plan, sourceHead)
      merged = true
      steps[1] = {...steps[1],status:'done',detail:`${plan.target.branch} · ${targetHead.slice(0,12)}`}
      const mergedState = await this.git.snapshot(target.path)

      phase = 2
      if (!(await this.open(target.id)).opened) throw new Error('Orca 尚未確認已開啟目標。')
      steps[2] = {...steps[2],status:'done',detail:target.displayName}

      if (action.remove) {
        phase = 3
        await this.participants(source, target)
        const currentSource = await this.git.snapshot(source.path)
        const currentTarget = await this.git.snapshot(target.path)
        if (currentSource.head !== sourceHead || currentSource.fingerprint !== committed.fingerprint ||
          currentTarget.head !== targetHead || currentTarget.fingerprint !== mergedState.fingerprint || currentTarget.files.length) {
          throw new Error('合併後工作樹又有變更，已停止清理。')
        }
        const check = await this.git.cleanupCheck(source.path, targetHead)
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
        steps[3] = {...steps[3],status:'done',detail:'已移除工作樹，保留本機分支'}
      }
      return {status:'completed',message:action.remove ? '已提交、合回並清理工作樹。' : '已合回目標，來源工作樹已保留。',workspaceId:target.id,steps}
    } catch (error) {
      const detail = error instanceof Error ? error.message : '操作結果待核對。'
      steps[phase] = {...steps[phase],status:'failed',detail}
      return {status:'needs_attention',message:merged ? `已合回目標，${steps[phase].label}未完成或結果待核對。${detail}` : `收尾已停止，請核對已完成步驟與 Git 狀態。${detail}`,
        workspaceId:merged ? target.id : source.id,steps}
    }
  }
}
