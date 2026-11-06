import type { Workspace } from './contracts'
import type { HubAction, Preview } from './protocol'
import type { FinishPlan } from './services/finish'

type FinishAction = Extract<HubAction, { kind: 'finish' }>

/** 這次收尾是否會改寫來源分支的提交（提交編號會改變）。 */
export function rewritesHistory(plan: FinishPlan): boolean {
  return (plan.squash && plan.squashCount >= 2) || movesCommits(plan)
}

/** rebase 只在目標已前進、而且這個工作還有沒併入的內容時才會搬移提交。 */
function movesCommits(plan: FinishPlan): boolean {
  return plan.strategy === 'rebase' && plan.behind > 0 && plan.mergeMode !== 'already_merged'
}

function integrationStep(plan: FinishPlan, into: string): string {
  switch (plan.mergeMode) {
    case 'already_merged': return `已經合併到 ${into}，不需要再合併`
    case 'fast_forward': return `讓 ${into} 直接前進到這個工作的最新提交（不會多出合併提交）`
    case 'merge_commit': return `在 ${into} 建立一個合併提交，保留雙方的紀錄`
    case 'rebase': return `讓 ${into} 前進到搬好的提交，紀錄是一直線`
  }
}

/** 確認頁依序列出的步驟；只列本次會碰到的步驟，文字給不熟 Git 的人看。 */
export function finishSteps(action: FinishAction, plan: FinishPlan): string[] {
  const into = plan.target.branch
  return [
    plan.needsCommit ? `提交全部 ${plan.files.length} 個檔案的變更（包含已暫存的內容）` : '沒有未提交的變更，沿用現有提交',
    ...(action.squash ? [plan.squashCount >= 2 ? `把 ${plan.squashCount} 個提交合成 1 個`
      : plan.squashCount === 1 ? '只有 1 個提交，不需要合成' : '沒有需要合成的提交'] : []),
    ...(action.strategy === 'rebase' ? [movesCommits(plan) ? `把提交搬到 ${into} 最新進度後面（rebase）`
      : plan.mergeMode === 'already_merged' ? '沒有需要搬移的提交' : `已經在 ${into} 最新進度後面，不需要搬移`] : []),
    integrationStep(plan, into),
    action.remove ? '確認安全後移除工作資料夾，分支保留' : '保留工作資料夾',
    `切換到 ${into}`
  ]
}

/** 一句話說明完成後目標分支會變成怎樣。 */
export function finishSummary(action: FinishAction, plan: FinishPlan): string {
  const into = plan.target.branch
  const tail = action.remove ? '完成後移除工作資料夾，分支保留。' : '工作資料夾會保留。'
  if (plan.mergeMode === 'already_merged') return `${plan.source.branch} 已經在 ${into} 裡，不需要合併。${tail}`
  const commits = plan.squash && plan.squashCount >= 2 ? 1 : plan.ahead + (plan.needsCommit ? 1 : 0)
  const targetChange = plan.mergeMode === 'merge_commit'
    ? `${into} 會帶入這個工作的 ${commits} 個提交，再加 1 個合併提交。`
    : `${into} 會接上這個工作的 ${commits} 個提交，紀錄是一直線。`
  return `把 ${plan.source.branch} 合併到 ${into}。${targetChange}${tail}`
}

type Warning = NonNullable<Preview['warnings']>[number]

/** 確認前要讓使用者看到的提醒；只放會影響決定的事，Git 術語留在技術細節。 */
export function finishWarnings(plan: FinishPlan): Warning[] {
  const into = plan.target.branch
  const warnings: Warning[] = []
  if (plan.squash && plan.mergeMode === 'merge_commit') {
    warnings.push({ title: `${into} 會多出 2 個提交（不是錯誤）`, tone: 'accent', fix: 'rebase',
      text: `合成後的提交，加上 1 個合併提交。要讓 ${into} 只多 1 個，按下方按鈕就會改用「接到最後面」。` })
  }
  if (!rewritesHistory(plan)) return warnings
  const how = plan.squash && plan.squashCount >= 2 ? '合成一個' : `重新接到 ${into} 最新進度後面`
  warnings.push({ title: '提交編號會改變', text: `這個工作的提交會${how}，編號會變，內容不會遺失。` })
  if (plan.pushedCount > 0) {
    warnings.push({ title: 'GitHub 上的舊版本不會自動更新', text: `有 ${plan.pushedCount} 個提交之前上傳過。只有你在用這個工作、也沒有開 PR 的話，就不用處理。同事也在用或已經開了 PR，請返回改選「一般合併」和「保留每個提交」。` })
  }
  return warnings
}

/** 技術細節，放在可展開區塊，供需要核對的人查看。 */
export function finishDetail(action: FinishAction, plan: FinishPlan, target: Workspace): string {
  const strategy = action.strategy === 'rebase' ? 'rebase（搬到最新進度後面）' : 'merge（一般合併）'
  const files = plan.needsCommit ? `本次提交全部變更（包含既有暫存）：\n${plan.files.join('\n')}` : '沒有未提交變更，沿用目前提交。'
  const message = action.message.trim() ? `提交訊息：\n${action.message}` : '沿用既有提交訊息。'
  const hooks = action.squash ? '合成提交以 commit-tree 建立，不執行 commit hooks；其餘步驟會執行儲存庫既有 Git hooks。' : '會執行儲存庫既有 Git hooks。'
  const rewrite = rewritesHistory(plan) ? `改寫前的提交可從 git reflog 找回。${plan.pushedCount > 0 ? `已上傳的 ${plan.pushedCount} 個提交被改寫後，遠端分支要 force push 才會一致；外掛不會自動 push。` : ''}` : ''
  return [
    `${plan.source.branch} → ${plan.target.branch}`,
    `目標：${target.path}`,
    `合併方式：${strategy}；合成一個提交：${action.squash ? '是' : '否'}`,
    `目標領先 ${plan.behind} 個提交；這個工作領先 ${plan.ahead} 個提交。`,
    action.remove ? '完成後移除來源工作樹，保留分支。' : '完成後保留來源工作樹。',
    '',
    message,
    '',
    files,
    '',
    `${hooks}目標變更、衝突或活動狀態不明時停止並保留現場。${rewrite}`,
    '',
    plan.source.stagedDiff,
    plan.source.workingDiff
  ].join('\n')
}

export function describeFinish(action: FinishAction, plan: FinishPlan, target: Workspace): Pick<Preview, 'summary' | 'steps' | 'warnings' | 'detail'> {
  return { summary: finishSummary(action, plan), steps: finishSteps(action, plan), warnings: finishWarnings(plan), detail: finishDetail(action, plan, target) }
}
