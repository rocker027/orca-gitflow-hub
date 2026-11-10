import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Run, Workspace } from '../src/contracts'
import { FinishWorkflow, type FinishAction } from '../src/finish-workflow'
import type { OrcaService } from '../src/services/orca'
import { fixture, run } from './git-fixture'

const ignoredNotice = '工作資料夾內有未由 Git 保存的忽略檔案，無法安全移除。請取消勾選「完成後移除資料夾」，再按「下一步：確認」。這些本機檔案會留在原資料夾。'

async function workflowFixture(t: { after(fn: () => Promise<void>): void }) {
  const mutations: string[][] = []
  const watched: Run = async (tool, args, options) => {
    if (args.some(arg => ['add', 'commit', 'commit-tree', 'update-ref', 'rebase', 'merge'].includes(arg))) mutations.push([...args])
    return run(tool, args, options)
  }
  const f = await fixture(watched)
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const workspace = (path: string, isMainWorktree: boolean): Workspace => ({
    id: `repo::${path}`, repoId: 'repo', path, branch: isMainWorktree ? 'main' : 'feature/test',
    displayName: isMainWorktree ? 'main' : 'feature/test', head: '', hostId: 'local', isMainWorktree
  })
  const source = workspace(f.source, false)
  const target = workspace(f.target, true)
  let removals = 0
  const orca = {
    resolve: async (id: string) => {
      const match = [source, target].find(entry => entry.id === id)
      if (!match) throw new Error('未知工作樹')
      return match
    },
    assertIdle: async () => undefined,
    activity: async () => ({agentsBusy: false, terminalsOpen: false}),
    remove: async () => { removals++ }
  } as unknown as OrcaService
  const workflow = new FinishWorkflow(f.snapshots, orca, f.service, async () => ({ opened: true }))
  const action: FinishAction = { kind: 'finish', workspaceId: source.id, targetWorkspaceId: target.id,
    message: '完成收尾測試', strategy: 'merge', squash: false, remove: true }
  await writeFile(join(f.source, 'feature.txt'), 'feature content\n')
  return { ...f, workspace: source, workflow, action, mutations, removals: () => removals }
}

test('選擇移除且已有 ignored 檔時，預覽先拒絕，尚未提交或合併', async t => {
  const f = await workflowFixture(t)
  await writeFile(join(f.source, 'ignored.txt'), 'local-only fixture\n')
  await writeFile(join(f.target, '.git/info/exclude'), 'node_modules/\n')
  await mkdir(join(f.source, 'node_modules'))
  await writeFile(join(f.source, 'node_modules', 'local.txt'), 'local dependency\n')
  const sourceHead = await f.git(f.source, 'rev-parse', 'HEAD')
  const targetHead = await f.git(f.target, 'rev-parse', 'HEAD')
  const index = await f.git(f.source, 'ls-files', '--stage', '-z')
  await assert.rejects(f.workflow.prepare(f.workspace, f.action), { message: ignoredNotice })
  assert.deepEqual(f.mutations, [])
  assert.equal(await f.git(f.source, 'rev-parse', 'HEAD'), sourceHead)
  assert.equal(await f.git(f.target, 'rev-parse', 'HEAD'), targetHead)
  assert.equal(await f.git(f.source, 'ls-files', '--stage', '-z'), index)
  assert.equal(await readFile(join(f.source, 'ignored.txt'), 'utf8'), 'local-only fixture\n')
  assert.equal(await readFile(join(f.source, 'node_modules', 'local.txt'), 'utf8'), 'local dependency\n')
})

test('取消移除後，相同 ignored 檔不擋合併，工作資料夾與本機檔保留', async t => {
  const f = await workflowFixture(t)
  await writeFile(join(f.source, 'ignored.txt'), 'local-only fixture\n')
  const action = { ...f.action, remove: false }
  const context = await f.workflow.prepare(f.workspace, action)
  const outcome = await f.workflow.execute(f.workspace, action, context)
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome))
  assert.equal(await readFile(join(f.target, 'feature.txt'), 'utf8'), 'feature content\n')
  assert.equal(await readFile(join(f.source, 'ignored.txt'), 'utf8'), 'local-only fixture\n')
  assert.equal(f.removals(), 0)
})

test('預覽後才出現 ignored 檔時，最後的清理檢查仍保留工作資料夾', async t => {
  const f = await workflowFixture(t)
  const context = await f.workflow.prepare(f.workspace, f.action)
  await writeFile(join(f.source, 'ignored.txt'), 'created after preview\n')
  const outcome = await f.workflow.execute(f.workspace, f.action, context)
  assert.equal(outcome.status, 'needs_attention', JSON.stringify(outcome))
  assert.equal(outcome.steps?.find(step => step.id === 'merge')?.status, 'done')
  assert.equal(outcome.steps?.find(step => step.id === 'cleanup')?.status, 'failed')
  assert.equal(await readFile(join(f.target, 'feature.txt'), 'utf8'), 'feature content\n')
  assert.equal(await readFile(join(f.source, 'ignored.txt'), 'utf8'), 'created after preview\n')
  assert.equal(f.removals(), 0)
})
