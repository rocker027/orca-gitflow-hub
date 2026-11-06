import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseAction } from '../src/actions'
import type { GitSnapshot, Workspace } from '../src/contracts'
import { Hub } from '../src/hub'
import type { GitService } from '../src/services/git'
import type { GitHubService } from '../src/services/github'
import type { OrcaService } from '../src/services/orca'
import type { SummaryService } from '../src/services/summary'

/** 來源功能工作樹與目標 main，git／summary 以 mock 記錄送出的資料與當下是否持有 repo 鎖。 */
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'gitflow-advice-hub-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ws = (name: string, main: boolean, repoId = 'r'): Workspace => ({ id: `${repoId}::${root}/${name}`, repoId, path: join(root, name),
    branch: name, head: (main ? 'b' : 'a').repeat(40), displayName: name, hostId: 'local', isMainWorktree: main, isDefaultBranch: main })
  const source = ws('feature', false)
  const target = ws('main', true)
  await mkdir(source.path); await mkdir(target.path)
  const state = { fingerprint: 'v1', targetHead: 'b'.repeat(40), material: 'MATERIAL-V1', facts: { conflict: false, overlap: ['a.txt'] }, level: '中' }
  const workspaces = new Map([[source.id, source], [target.id, target]])
  const snapshot = (path: string): GitSnapshot => path === source.path
    ? { head: source.head, branch: 'feature', fingerprint: state.fingerprint, files: [], stagedDiff: '', workingDiff: '' }
    : { head: state.targetHead, branch: 'main', fingerprint: 'target', files: [], stagedDiff: '', workingDiff: '' }
  const materials: { targetHead: string; targetBranch: string; choice: string }[] = []
  const git = {
    snapshot: async (path: string) => snapshot(path),
    adviceMaterial: async (_cwd: string, targetHead: string, targetBranch: string, choice: string) => {
      materials.push({ targetHead, targetBranch, choice })
      return { fingerprint: state.fingerprint, files: ['a.txt'], text: state.material, truncated: false, facts: state.facts }
    }
  } as unknown as GitService
  const orca = { resolve: async (id: string) => { const found = workspaces.get(id); if (!found) throw new Error('工作區已移除'); return structuredClone(found) } } as unknown as OrcaService
  const sent: string[] = []
  const observed: { locked?: boolean; signal?: AbortSignal } = {}
  const summary = { advise: async (text: string, signal?: AbortSignal) => {
    sent.push(text)
    observed.locked = await access(join(root, 'gitflow-hub.lock')).then(() => true, () => false)
    observed.signal = signal
    return { level: state.level, text: '兩邊都改過 a.txt。\n- 建議先找人看過' }
  } } as unknown as SummaryService
  const values = new Map<string, unknown>()
  const hub = new Hub(async () => root, { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)) } },
    async () => ({ opened: true }), { git, github: {} as GitHubService, orca, summary })
  const action = { kind: 'finish-advice', workspaceId: source.id, targetWorkspaceId: target.id, strategy: 'rebase', squash: true }
  return { hub, action, state, sent, observed, materials, source, target, workspaces, ws }
}

test('H1 預覽先說明會傳給 Claude 的內容且不送出；確認後只送預覽內容一次並回傳建議', async (t) => {
  const f = await fixture(t)
  const preview = await f.hub.preview(f.action)
  assert.equal(f.sent.length, 0)
  assert.match(preview.detail, /Claude/)
  assert.match(preview.detail, /Anthropic/)
  assert.match(preview.detail, /MATERIAL-V1/)
  assert.deepEqual(f.materials, [{ targetHead: 'b'.repeat(40), targetBranch: 'main', choice: '接到最後面（rebase），合成一個提交' }])
  f.state.material = 'MATERIAL-V2'
  const outcome = await f.hub.execute(preview.token)
  assert.deepEqual(f.sent, ['MATERIAL-V1'])
  assert.deepEqual(outcome.advice, { level: '中', text: '兩邊都改過 a.txt。\n- 建議先找人看過', facts: { conflict: false, overlap: ['a.txt'] }, raised: false })
  await f.hub.execute(preview.token)
  assert.equal(f.sent.length, 1)
})

test('H2 預覽後來源內容或目標分支變了就拒絕送出', async (t) => {
  const f = await fixture(t)
  const changedSource = await f.hub.preview(f.action)
  f.state.fingerprint = 'v2'
  await assert.rejects(f.hub.execute(changedSource.token), /失效|變更/)
  const movedTarget = await f.hub.preview(f.action)
  f.state.targetHead = 'c'.repeat(40)
  await assert.rejects(f.hub.execute(movedTarget.token), /目標|變更/)
  assert.equal(f.sent.length, 0)
})

test('H3 呼叫 Claude 時不持有 repo 鎖，並傳遞面板的取消訊號', async (t) => {
  const f = await fixture(t)
  const preview = await f.hub.preview(f.action)
  const controller = new AbortController()
  await f.hub.execute(preview.token, controller.signal)
  assert.equal(f.observed.locked, false)
  assert.equal(f.observed.signal, controller.signal)
})

test('H4 主要分支、相同工作樹或不同專案的目標都拒絕', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.hub.preview({ ...f.action, workspaceId: f.target.id }), /主要|預設/)
  await assert.rejects(f.hub.preview({ ...f.action, targetWorkspaceId: f.source.id }), /相同/)
  const other = f.ws('other', true, 'x')
  f.workspaces.set(other.id, other)
  await assert.rejects(f.hub.preview({ ...f.action, targetWorkspaceId: other.id }), /同一個儲存庫/)
  assert.equal(f.materials.length, 0)
})

test('H5 操作欄位只接受明確的目標、合併方式與布林值，不接受命令或額外欄位', () => {
  const action = { kind: 'finish-advice', workspaceId: 's', targetWorkspaceId: 't', strategy: 'merge', squash: false }
  assert.deepEqual(parseAction(action), action)
  for (const change of [{ strategy: 'squash' }, { squash: 'no' }, { targetWorkspaceId: '' }, { command: 'claude --dangerously-skip-permissions' }, { agent: 'codex' }, { message: 'x' }]) {
    assert.throws(() => parseAction({ ...action, ...change }))
  }
})

test('H6 AI 說風險低但 Git 檢查有衝突或兩邊改到同一檔時，顯示等級依事實調高並標示', async (t) => {
  const f = await fixture(t)
  f.state.level = '低'
  f.state.facts = { conflict: true, overlap: ['a.txt'] }
  const conflict = await f.hub.execute((await f.hub.preview(f.action)).token)
  assert.equal(conflict.advice?.level, '高')
  assert.equal(conflict.advice?.raised, true)
  f.state.facts = { conflict: false, overlap: ['a.txt'] }
  const overlap = await f.hub.execute((await f.hub.preview(f.action)).token)
  assert.equal(overlap.advice?.level, '中')
  f.state.facts = { conflict: false, overlap: [] }
  const clean = await f.hub.execute((await f.hub.preview(f.action)).token)
  assert.equal(clean.advice?.level, '低')
  assert.equal(clean.advice?.raised, false)
})
