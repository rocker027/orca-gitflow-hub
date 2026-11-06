import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaService } from '../src/services/orca'
import type { Run, Workspace } from '../src/contracts'

const base: Workspace = {id: 'repo::/repo', repoId: 'repo', path: '/repo', head: 'a'.repeat(40), branch: 'refs/heads/feature/test', displayName: 'test', hostId: 'local', isMainWorktree: false}
const envelope = (value: unknown) => JSON.stringify({ok: true, result: value})
const listed = (workspaces = [base], extra = {}) => envelope({worktrees: workspaces.map(workspace => ({...workspace, isBare: false})), truncated: false, hostScope: {hostIds: ['local'], omittedHostIds: []}, ...extra})

const psRow = (workspace: Workspace, extra = {}) => ({worktreeId: workspace.id, repoId: workspace.repoId,
  hostId: workspace.hostId, path: workspace.path, branch: workspace.branch, isMainWorktree: workspace.isMainWorktree,
  repo: 'Project', defaultBranch: false, isActive: false, ...extra})
const psListed = (workspaces = [base], extra = {}) => envelope({worktrees: workspaces.map(workspace => psRow(workspace)),
  truncated: false, hostScope: {hostIds: ['local'], omittedHostIds: []}, ...extra})
const withMetadata = (workspace: Workspace): Workspace => ({...workspace, repoName: 'Project', isActive: false, isDefaultBranch: false})

test('工作區清單只提供可識別的本機 Git 工作區並揭露範圍限制', async () => {
  const workspaces = [base, {...base, id: 'remote::/repo', hostId: 'ssh:remote'}]
  const run: Run = async (_tool, args) => args[1] === 'list'
    ? listed(workspaces, {hostScope: {hostIds: ['local'], omittedHostIds: ['ssh:other']}}) : psListed(workspaces)
  const found = await new OrcaService(run).list()
  assert.deepEqual(found.workspaces, [withMetadata(base)])
  assert.ok(found.warnings.length >= 2)
})

test('未知 ID 不得以 path 或 branch 猜測工作區', async () => {
  const calls: string[][] = []
  const service = new OrcaService(async (tool, args) => {calls.push([tool, ...args]); return args[1] === 'list' ? listed() : psListed()})
  await assert.rejects(service.resolve('/repo'), /工作區/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'orca')
})

test('本機工作區必須對應同一個實體 Git 根目錄', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'gitflow-orca-')))
  try {
    const workspace = {...base, path: folder, id: `repo::${folder}`}
    const service = new OrcaService(async (tool, args) => tool === 'orca' ? (args[1] === 'list' ? listed([workspace]) : psListed([workspace])) : `${folder}\n`)
    assert.deepEqual(await service.resolve(workspace.id), withMetadata(workspace))
    const wrong = new OrcaService(async (tool, args) => tool === 'orca' ? (args[1] === 'list' ? listed([workspace]) : psListed([workspace])) : '/another/repo\n')
    await assert.rejects(wrong.resolve(workspace.id), /根目錄/)
    await symlink(folder, `${folder}-alias`)
    const alias = {...workspace, path: `${folder}-alias`, id: `repo::${folder}-alias`}
    await assert.rejects(new OrcaService(async (_tool, args) => args[1] === 'list' ? listed([alias]) : psListed([alias])).resolve(alias.id), /符號連結/)
  } finally {await rm(`${folder}-alias`, {force: true}); await rm(folder, {recursive: true, force: true})}
})

test('不合法或失敗的 Orca JSON 不能當作空清單', async () => {
  for (const value of ['not json', JSON.stringify({ok: false, error: {message: 'secret'}}), envelope({worktrees: 'bad'})]) {
    await assert.rejects(new OrcaService(async () => value).list(), /Orca/)
  }
})

test('建立工作區固定 repo、停用 setup 且不啟動未選取的 Agent', async () => {
  let called: readonly string[] = []
  const created = {...base, id: 'repo::/created', path: '/created'}
  const service = new OrcaService(async (_tool, args) => {called = args; return envelope({worktree: created})})
  assert.deepEqual(await service.create(base, {name: 'feature-new', base: 'origin/main', agent: '', prompt: ''}), created)
  assert.ok(called.includes('--no-parent'))
  assert.ok(called.includes('--setup'))
  assert.ok(called.includes('skip'))
  assert.ok(called.includes('id:repo'))
  assert.equal(called.includes('--agent'), false)
})

test('建立或啟動時拒絕 option 注入與不支援的 Agent', async () => {
  let calls = 0
  const service = new OrcaService(async () => {calls += 1; return listed()})
  await assert.rejects(service.create(base, {name: '--force', base: 'main', agent: '', prompt: ''}), /名稱/)
  await assert.rejects(service.create(base, {name: 'safe', base: '-bad', agent: '', prompt: ''}), /分支/)
  await assert.rejects(service.launch(base, 'sh', 'hello'), /Agent/)
  assert.equal(calls, 0)
})

test('啟動 Agent 只接受已投遞的回條，遺失結果不盲目重試', async () => {
  const service = new OrcaService(async () => envelope({launch: {outcome: {kind: 'structured', handle: 'agent-1'}, prompt: {outcome: 'journaled'}}}))
  assert.equal(await service.launch(base, 'codex', 'hello'), 'agent-1')
  const unknown = new OrcaService(async () => envelope({launch: {outcome: {kind: 'structured', handle: 'agent-1'}, prompt: {outcome: 'unknown'}}}))
  await assert.rejects(unknown.launch(base, 'codex', 'hello'), /未知/)
})

test('清理只在明確沒有 Agent 與終端時允許', async () => {
  const idle = {worktreeId: base.id, hostId: 'local', liveTerminalCount: 0, unverifiableTerminalCount: 0, agents: [], terminalVerdict: 'none', hasAttachedPty: false}
  const serviceFor = (row: unknown, extra = {}) => new OrcaService(async () => envelope({worktrees: [row], truncated: false, hostScope: {hostIds: ['local'], omittedHostIds: []}, ...extra}))
  await serviceFor(idle).assertIdle(base)
  for (const row of [{...idle, liveTerminalCount: 1}, {...idle, unverifiableTerminalCount: 1}, {...idle, agents: [{state: 'working'}]}, {...idle, hasAttachedPty: true}]) {
    await assert.rejects(serviceFor(row).assertIdle(base), /終端|Agent|活動/)
  }
  await assert.rejects(serviceFor(idle, {truncated: true}).assertIdle(base), /完整/)
  await assert.rejects(serviceFor({...idle, liveTerminalCount: undefined}).assertIdle(base), /未知/)
})

test('已完成的 Agent 歷史可收尾，活動中子 Agent 與未知狀態仍拒絕', async () => {
  const idle = {worktreeId:base.id,hostId:'local',liveTerminalCount:0,unverifiableTerminalCount:0,hasAttachedPty:false}
  const serviceFor = (agents: unknown[]) => new OrcaService(async () => envelope({worktrees:[{...idle,agents}],truncated:false,hostScope:{hostIds:['local'],omittedHostIds:[]}}))
  await serviceFor([{state:'done',children:[]}]).assertIdle(base)
  await serviceFor([{state:'done',mainAgent:{state:'done'},children:[{state:'done'}]}]).assertIdle(base)
  for (const agents of [[{state:'done',children:[{state:'working'}]}],[{state:'done',mainAgent:{state:'working'}}],[{state:'done',children:[{}]}],[{state:'done',children:'unknown'}],[{}]]) {
    await assert.rejects(serviceFor(agents).assertIdle(base), /AI 助手|Agent|未知|活動/)
  }
})

test('清單保留目前專案與預設分支識別，不必以名稱猜測', async () => {
  const service = new OrcaService(async (_tool, args) => args[1] === 'list'
    ? listed([base], {worktrees: [{...base, repo: 'Wrong source', isActive: false, defaultBranch: false}]})
    : psListed([base], {worktrees: [psRow(base, {repo: 'Project', isActive: true, defaultBranch: true})]}))
  const found = (await service.list()).workspaces[0]
  assert.equal(found.repoName,'Project')
  assert.equal(found.isActive,true)
  assert.equal(found.isDefaultBranch,true)
})

test('建立保留使用者指定的分支名稱，工作樹目錄名稱另行正規化', async () => {
  let called:readonly string[]=[]
  const created={...base,id:'repo::/feature-login',path:'/feature-login',branch:'refs/heads/feature/login'}
  const service=new OrcaService(async(_tool,args)=>{called=args;return envelope({worktree:created})})
  await service.create(base,{name:'feature/login',base:'main',agent:'',prompt:''})
  assert.equal(called[called.indexOf('--branch')+1],'feature/login')
  assert.equal(called[called.indexOf('--name')+1],'feature-login')
})

test('主要工作區拒絕移除，其他工作區只呼叫不強制的 Orca 移除', async () => {
  const calls: readonly string[][] = []
  const mutableCalls = calls as string[][]
  const service = new OrcaService(async (_tool, args) => {
    mutableCalls.push([...args])
    if (args[1] === 'ps') return envelope({worktrees: [{worktreeId: base.id, hostId: 'local', liveTerminalCount: 0, unverifiableTerminalCount: 0, agents: [], hasAttachedPty: false}], truncated: false, hostScope: {hostIds: ['local'], omittedHostIds: []}})
    if (args[0] === 'status') return envelope({runtime: {capabilities: ['worktree.remove-branch-policy.v1']}})
    return envelope({removed: true})
  })
  await assert.rejects(service.remove({...base, isMainWorktree: true}), /主要/)
  assert.equal(calls.length, 0)
  await service.remove(base)
  assert.deepEqual(calls[2], ['worktree', 'rm', '--worktree', `id:${base.id}`, '--json'])
})

test('PR 關聯只接受完整且不含憑證的 HTTPS URL', async () => {
  let called: readonly string[] = []
  const service = new OrcaService(async (_tool, args) => {called = args; return envelope({added: true})})
  await service.link(base, 'https://github.example/owner/repo/pull/42')
  assert.deepEqual(called, ['reference', 'add', 'https://github.example/owner/repo/pull/42', '--worktree', `id:${base.id}`, '--json'])
  await assert.rejects(service.link(base, 'https://secret@github.example/owner/repo/pull/42'), /URL/)
  await assert.rejects(service.link(base, 'https://github.example/owner/repo/-/merge_requests/42'), /URL/)
  await assert.rejects(service.link(base, 'https://github.example/owner/repo/pull/0'), /URL/)
  await assert.rejects(service.link(base, 'https://github.example/owner/repo/pull/42?token=secret'), /URL/)
})


test('舊 runtime 缺少保留分支能力時拒絕清理', async () => {
  let removed = false
  const service = new OrcaService(async (_tool, args) => {
    if (args[1] === 'ps') return envelope({worktrees: [{worktreeId: base.id, hostId: 'local', liveTerminalCount: 0, unverifiableTerminalCount: 0, agents: [], hasAttachedPty: false}], truncated: false, hostScope: {hostIds: ['local'], omittedHostIds: []}})
    if (args[0] === 'status') return envelope({runtime: {capabilities: []}})
    removed = true
    return envelope({removed: true})
  })
  await assert.rejects(service.remove(base), /保留分支/)
  assert.equal(removed, false)
})


test('真實 list 與 ps 分離的欄位以完整工作區身分合併', async () => {
  const calls: readonly string[][] = []
  const service = new OrcaService(async (_tool, args) => {
    ;(calls as string[][]).push([...args])
    if (args[1] === 'list') return listed([base])
    if (args[1] === 'ps') return psListed([base], {worktrees: [psRow(base, {repo: 'Current Project', isActive: true,
      defaultBranch: true, agents: [{prompt: 'SECRET PROMPT'}]})]})
    throw new Error('unexpected command')
  })
  const found = (await service.list()).workspaces[0]
  assert.equal(found.repoName, 'Current Project')
  assert.equal(found.isActive, true)
  assert.equal(found.isDefaultBranch, true)
  assert.equal(found.id, base.id)
  assert.equal(found.head, base.head)
  assert.equal(JSON.stringify(found).includes('SECRET PROMPT'), false)
  assert.deepEqual(calls, [['worktree', 'list', '--limit', '10000', '--json'], ['worktree', 'ps', '--limit', '10000', '--json']])
})

test('ps metadata 缺失重複或身分不一致時整個清單拒絕，不能繞過預設分支護欄', async () => {
  const invalidRows = [[], [psRow(base), psRow(base)], [psRow(base, {repoId: 'other'})],
    [psRow(base, {path: '/other'})], [psRow(base, {branch: 'refs/heads/other'})],
    [psRow(base, {isMainWorktree: true})], [psRow(base, {hostId: 'ssh:remote'})],
    [psRow(base, {repo: ''})], [psRow(base, {defaultBranch: undefined})], [psRow(base, {isActive: undefined})]]
  for (const worktrees of invalidRows) {
    const service = new OrcaService(async (_tool, args) => args[1] === 'list' ? listed() : psListed([base], {worktrees}))
    await assert.rejects(service.list(), /Orca|工作區/, JSON.stringify(worktrees))
  }
})

test('list 或 ps 截斷、未涵蓋本機與 ps 執行失敗時拒絕提供不完整 metadata', async () => {
  for (const command of ['list', 'ps']) {
    for (const invalid of [{truncated: true}, {truncated: undefined}, {hostScope: {hostIds: [], omittedHostIds: ['local']}}]) {
      const service = new OrcaService(async (_tool, args) => args[1] === 'list'
        ? listed([base], command === 'list' ? invalid : {}) : psListed([base], command === 'ps' ? invalid : {}))
      await assert.rejects(service.list(), /Orca|完整/)
    }
  }
  const failed = new OrcaService(async (_tool, args) => {
    if (args[1] === 'list') return listed()
    throw new Error('SECRET PROMPT')
  })
  await assert.rejects(failed.list(), error => {
    assert.doesNotMatch(String(error), /SECRET/)
    return true
  })
})
