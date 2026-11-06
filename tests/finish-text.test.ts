import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finishSteps, finishSummary, finishWarnings } from '../src/finish-text'
import type { HubAction } from '../src/protocol'
import type { FinishPlan } from '../src/services/finish'

type FinishAction = Extract<HubAction, { kind: 'finish' }>
const snapshot = (branch: string) => ({ head: 'a'.repeat(40), branch, fingerprint: branch, files: [], stagedDiff: '', workingDiff: '' })
const action = (change: Partial<FinishAction> = {}): FinishAction =>
  ({ kind: 'finish', workspaceId: 's', targetWorkspaceId: 't', message: '說明', remove: true, strategy: 'merge', squash: false, ...change })
const plan = (change: Partial<FinishPlan> = {}): FinishPlan => ({ source: snapshot('feature/login'), target: snapshot('main'), files: [],
  ahead: 2, behind: 1, needsCommit: false, strategy: 'merge', squash: false, squashCount: 0, pushedCount: 0, mergeMode: 'merge_commit',
  identity: {} as FinishPlan['identity'], ...change })

test('已合併的工作選 rebase 不會警告改寫，也不說要搬移提交', () => {
  const merged = plan({ ahead: 0, behind: 3, strategy: 'rebase', mergeMode: 'already_merged' })
  assert.deepEqual(finishWarnings(merged), [])
  assert.ok(finishSteps(action({ strategy: 'rebase' }), merged).includes('沒有需要搬移的提交'))
  assert.match(finishSummary(action({ strategy: 'rebase' }), merged), /已經在 main 裡/)
})

test('rebase 搬移或合成兩個以上提交時提醒改寫；已上傳時再提醒 force push', () => {
  assert.equal(finishWarnings(plan({ strategy: 'rebase', mergeMode: 'rebase' })).length, 1)
  assert.equal(finishWarnings(plan({ squash: true, squashCount: 2, behind: 0, mergeMode: 'fast_forward' })).length, 1)
  assert.deepEqual(finishWarnings(plan({ squash: true, squashCount: 2, mergeMode: 'merge_commit' })).map((w) => w.title), ['main 會多出 2 個提交（不是錯誤）', '提交編號會改變'])
  for (const warning of finishWarnings(plan({ strategy: 'rebase', mergeMode: 'rebase', pushedCount: 2 }))) assert.doesNotMatch(warning.text, /reflog|force push/)
  assert.match(finishWarnings(plan({ strategy: 'rebase', mergeMode: 'rebase', pushedCount: 2 })).map((w) => w.text).join('\n'), /2 個提交之前上傳過/)
  assert.deepEqual(finishWarnings(plan({ squash: true, squashCount: 1, behind: 0, mergeMode: 'fast_forward' })), [])
})

test('合成數量為 0 或 1 時，步驟說明不需要合成', () => {
  assert.ok(finishSteps(action({ squash: true }), plan({ squash: true, squashCount: 0 })).includes('沒有需要合成的提交'))
  assert.ok(finishSteps(action({ squash: true }), plan({ squash: true, squashCount: 1 })).includes('只有 1 個提交，不需要合成'))
})

test('確認頁先列出清理或保留工作資料夾，最後才切換到目標', () => {
  assert.deepEqual(finishSteps(action(), plan()).slice(-2), ['確認安全後移除工作資料夾，分支保留', '切換到 main'])
  assert.deepEqual(finishSteps(action({ remove: false }), plan()).slice(-2), ['保留工作資料夾', '切換到 main'])
})
