import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Run, Workspace, WorkspaceSummary } from '../src/contracts'
import { OverviewService } from '../src/services/overview'

const run: Run = async (tool, args, options = {}) => new Promise((resolve, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const child = spawn(tool, [...args], {cwd: options.cwd, shell: false,
    env: {...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}})
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)))
  child.stdin.end(options.input)
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitflow-overview-')))
  const targetPath = join(root, 'main')
  const sourcePath = join(root, 'feature')
  await mkdir(targetPath)
  const git = (cwd: string, ...args: string[]) => run('git', args, {cwd})
  await git(targetPath, 'init', '-b', 'main')
  await git(targetPath, 'config', 'user.name', 'Fixture')
  await git(targetPath, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(targetPath, 'base.txt'), 'base\n')
  await git(targetPath, 'add', '--', 'base.txt')
  await git(targetPath, 'commit', '-m', 'initial subject')
  await git(targetPath, 'worktree', 'add', '-b', 'feature/test', sourcePath)
  const workspace = async (path: string, main = false): Promise<Workspace> => ({id: `repo::${path}`, repoId: 'repo', path,
    head: (await git(path, 'rev-parse', 'HEAD')).trim(), branch: main ? 'main' : 'feature/test',
    displayName: main ? 'main' : 'feature', hostId: 'local', isMainWorktree: main})
  return {root, git, source: await workspace(sourcePath), target: await workspace(targetPath, true), service: new OverviewService(run)}
}

function assertUnknown(summary: WorkspaceSummary): void {
  assert.ok(summary.error)
  assert.equal(summary.changedFiles, -1)
  assert.equal(summary.ahead, null)
  assert.equal(summary.behind, null)
}

async function commit(git: Awaited<ReturnType<typeof fixture>>['git'], workspace: Workspace, subject: string): Promise<void> {
  await git(workspace.path, 'commit', '--allow-empty', '-m', subject)
}

test('乾淨工作區回傳輕量狀態、最新提交與零差異', async () => {
  const f = await fixture()
  try {
    const summary = await f.service.summary(f.source, f.target)
    assert.equal(summary.workspaceId, f.source.id)
    assert.equal(summary.branch, 'feature/test')
    assert.equal(summary.head, f.source.head)
    assert.equal(summary.lastMessage, 'initial subject')
    assert.equal(summary.changedFiles, 0)
    assert.equal(summary.ahead, 0)
    assert.equal(summary.behind, 0)
    assert.equal(summary.error, undefined)
  } finally { await rm(f.root, {recursive: true, force: true}) }
})

test('計算每個變更檔案一次，包含未追蹤資料夾中的檔案而不讀取內容', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source.path, 'base.txt'), 'staged\n')
    await f.git(f.source.path, 'add', '--', 'base.txt')
    await writeFile(join(f.source.path, 'base.txt'), 'working\n')
    await mkdir(join(f.source.path, 'new'))
    await writeFile(join(f.source.path, 'new/a.txt'), 'a'.repeat(3 * 1024 * 1024))
    await writeFile(join(f.source.path, 'new/b.txt'), 'b')
    const calls: readonly string[][] = []
    const service = new OverviewService(async (tool, args, options) => {
      ;(calls as string[][]).push([...args])
      assert.deepEqual(args.slice(0, 3), ['--no-pager', '-c', 'core.fsmonitor=false'])
      assert.equal(args.some(arg => ['diff', 'show', 'cat-file', 'hash-object', 'ls-files'].includes(arg)), false)
      return run(tool, args, options)
    })
    const summary = await service.summary(f.source)
    assert.equal(summary.changedFiles, 3)
    assert.equal(calls.some(args => args.includes('--untracked-files=all')), true)
  } finally { await rm(f.root, {recursive: true, force: true}) }
})

test('NUL porcelain rename 的舊檔名不重複計數且保留特殊檔名', async () => {
  const f = await fixture()
  try {
    await f.git(f.source.path, 'mv', 'base.txt', 'new\nname.txt')
    await writeFile(join(f.source.path, ':(glob)*.txt'), 'new')
    assert.equal((await f.service.summary(f.source)).changedFiles, 2)
  } finally { await rm(f.root, {recursive: true, force: true}) }
})

test('ahead 與 behind 以雙方釘選的 HEAD 計算並支援分歧', async () => {
  const f = await fixture()
  try {
    await commit(f.git, f.source, 'source one')
    await commit(f.git, f.source, 'source two')
    let summary = await f.service.summary(f.source, f.target)
    assert.deepEqual([summary.ahead, summary.behind], [2, 0])
    summary = await f.service.summary(f.target, f.source)
    assert.deepEqual([summary.ahead, summary.behind], [0, 2])
    await commit(f.git, f.target, 'target one')
    summary = await f.service.summary(f.source, f.target)
    assert.deepEqual([summary.ahead, summary.behind], [2, 1])
    assert.equal(summary.lastMessage, 'source two')
  } finally { await rm(f.root, {recursive: true, force: true}) }
})

test('未指定目標保留未知計數，相同工作區則回傳零', async () => {
  const f = await fixture()
  try {
    const noTarget = await f.service.summary(f.source)
    assert.deepEqual([noTarget.ahead, noTarget.behind], [null, null])
    const same = await f.service.summary(f.source, f.source)
    assert.deepEqual([same.ahead, same.behind], [0, 0])
  } finally { await rm(f.root, {recursive: true, force: true}) }
})

test('detached HEAD 顯示空分支且仍保留提交資訊', async () => {
  const f = await fixture()
  try {
    await f.git(f.source.path, 'checkout', '--detach')
    const summary = await f.service.summary(f.source, f.target)
    assert.equal(summary.branch, '')
    assert.equal(summary.head, f.source.head)
    assert.equal(summary.changedFiles, 0)
    assert.equal(summary.error, undefined)
  } finally { await rm(f.root, {recursive: true, force: true}) }
})

test('錯誤路徑、非根目錄與符號連結不被誤認為乾淨工作區', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.source.path, 'nested'))
    await symlink(f.source.path, join(f.root, 'alias'))
    for (const path of [join(f.root, 'missing'), join(f.source.path, 'nested'), join(f.root, 'alias')]) {
      assertUnknown(await f.service.summary({...f.source, path, id: `repo::${path}`}))
    }
  } finally { await rm(f.root, {recursive: true, force: true}) }
})

test('即使 repoId 相同，獨立 Git repository 也不能當作比較目標', async () => {
  const first = await fixture()
  const second = await fixture()
  try { assertUnknown(await first.service.summary(first.source, second.target)) }
  finally { await rm(first.root, {recursive: true, force: true}); await rm(second.root, {recursive: true, force: true}) }
})

for (const changedSide of ['source', 'target'] as const) {
  test(`回覆前 ${changedSide} HEAD 已變更時回傳 UNKNOWN`, async () => {
    const f = await fixture()
    try {
      let changed = false
      const service = new OverviewService(async (tool, args, options) => {
        const output = await run(tool, args, options)
        if (!changed && args.includes('rev-list')) {
          changed = true
          await commit(f.git, f[changedSide], 'new head after comparison')
        }
        return output
      })
      const summary = await service.summary(f.source, f.target)
      assertUnknown(summary)
      assert.match(summary.error ?? '', /變更|過期/)
    } finally { await rm(f.root, {recursive: true, force: true}) }
  })
}

test('CLI 失敗、格式錯誤或超過上限皆回 UNKNOWN，不洩漏原始錯誤', async () => {
  const f = await fixture()
  try {
    for (const status of [null, 'R  renamed\0', '?? absent terminator', '?? '+ 'x'.repeat(2 * 1024 * 1024)+'\0']) {
      const service = new OverviewService(async (tool, args, options) => {
        if (!args.includes('status')) return run(tool, args, options)
        if (status === null) throw new Error('credentials SECRET from stderr')
        return status
      })
      const summary = await service.summary(f.source)
      assertUnknown(summary)
      assert.doesNotMatch(summary.error ?? '', /SECRET|credentials/)
    }
  } finally { await rm(f.root, {recursive: true, force: true}) }
})
