import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Run } from '../src/contracts'
import { GitService } from '../src/services/git'

const run: Run = async (tool, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(tool, [...args], { cwd: options.cwd, shell: false })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', reject)
  child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)))
  child.stdin.end(options.input)
})

async function fixture(): Promise<{ root: string; cwd: string; service: GitService; git: (...args: string[]) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'gitflow-git-'))
  const cwd = join(root, 'repo')
  await mkdir(cwd)
  const git = (...args: string[]) => run('git', args, { cwd })
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(cwd, 'base.txt'), 'initial\n')
  await git('add', '--', 'base.txt')
  await git('commit', '-m', 'initial')
  await git('checkout', '-b', 'feature/test')
  return { root, cwd, service: new GitService(run), git }
}

test('snapshot 指紋包含未追蹤檔案內容而非只有 status', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'new.txt'), 'first')
    const first = await f.service.snapshot(f.cwd)
    await writeFile(join(f.cwd, 'new.txt'), 'other')
    const second = await f.service.snapshot(f.cwd)
    assert.notEqual(first.fingerprint, second.fingerprint)
    assert.equal(first.branch, 'feature/test')
    assert.equal(first.files.find((file) => file.path === 'new.txt')?.index, '?')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('stage 將 pathspec 魔法與換行檔名視為字面值，未勾選檔案保持未追蹤', async () => {
  const f = await fixture()
  try {
    const name = ':(glob)*\n shell;$value.txt'
    await writeFile(join(f.cwd, name), 'selected')
    await writeFile(join(f.cwd, 'other.txt'), 'unselected')
    const before = await f.service.snapshot(f.cwd)
    const after = await f.service.stage(f.cwd, [name], before.fingerprint)
    assert.equal(after.files.find((file) => file.path === name)?.index, 'A')
    assert.equal(after.files.find((file) => file.path === 'other.txt')?.index, '?')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('stage 拒絕過期快照、任意檔案與外部 symlink', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'new.txt'), 'one')
    const before = await f.service.snapshot(f.cwd)
    await writeFile(join(f.cwd, 'new.txt'), 'two')
    await assert.rejects(f.service.stage(f.cwd, ['new.txt'], before.fingerprint), /變更|過期/)
    const current = await f.service.snapshot(f.cwd)
    await assert.rejects(f.service.stage(f.cwd, ['../outside'], current.fingerprint), /檔案|路徑/)
    await writeFile(join(f.root, 'outside'), 'private')
    await symlink(join(f.root, 'outside'), join(f.cwd, 'linked'))
    const linked = await f.service.snapshot(f.cwd)
    await assert.rejects(f.service.stage(f.cwd, ['linked'], linked.fingerprint), /連結|symlink/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('snapshot 正確解析 staged rename 的原始及新檔名', async () => {
  const f = await fixture()
  try {
    await f.git('mv', 'base.txt', 'new name.txt')
    const snapshot = await f.service.snapshot(f.cwd)
    assert.deepEqual(snapshot.files, [{ path: 'new name.txt', originalPath: 'base.txt', index: 'R', working: ' ' }])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('Git 服務拒絕非 repository 根目錄', async () => {
  const f = await fixture()
  try {
    const nested = join(f.cwd, 'nested')
    await mkdir(nested)
    await assert.rejects(f.service.snapshot(nested), /根目錄|top.level/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('commit 只提交已預覽的 staged tree 並保留未暫存與未追蹤內容', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'base.txt'), 'staged\n')
    await f.git('add', '--', 'base.txt')
    await writeFile(join(f.cwd, 'base.txt'), 'working\n')
    await writeFile(join(f.cwd, 'untracked.txt'), 'remain')
    const preview = await f.service.previewCommit(f.cwd, 'feat: literal $(touch marker); `literal`')
    assert.deepEqual(preview.files, ['base.txt'])
    const committed = await f.service.commit(f.cwd, preview)
    assert.equal(committed.head, (await f.git('rev-parse', 'HEAD')).trim())
    assert.equal(await f.git('show', 'HEAD:base.txt'), 'staged\n')
    assert.equal(await readFile(join(f.cwd, 'base.txt'), 'utf8'), 'working\n')
    assert.equal(await readFile(join(f.cwd, 'untracked.txt'), 'utf8'), 'remain')
    assert.equal((await f.git('log', '-1', '--format=%s')).trim(), preview.message)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('commit 在 index 或 HEAD 改變後拒絕執行', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'base.txt'), 'staged\n')
    await f.git('add', '--', 'base.txt')
    const preview = await f.service.previewCommit(f.cwd, 'feat: change')
    await writeFile(join(f.cwd, 'added.txt'), 'another')
    await f.git('add', '--', 'added.txt')
    await assert.rejects(f.service.commit(f.cwd, preview), /變更|過期/)
    assert.equal((await f.git('log', '-1', '--format=%s')).trim(), 'initial')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('提交預覽拒絕空 staged、機密檔案及私鑰內容', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.service.previewCommit(f.cwd, 'empty'), /暫存|staged/)
    await writeFile(join(f.cwd, '.env'), 'TOKEN=abc')
    await f.git('add', '--', '.env')
    await assert.rejects(f.service.previewCommit(f.cwd, 'secret'), /機密|敏感/)
    await f.git('reset', '--', '.env')
    await writeFile(join(f.cwd, 'config.txt'), '-----BEGIN PRIVATE KEY-----\ncontent')
    await f.git('add', '--', 'config.txt')
    await assert.rejects(f.service.previewCommit(f.cwd, 'secret'), /機密|私鑰|敏感/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('清理檢查拒絕主要工作區與 ignored 檔案', async () => {
  const f = await fixture()
  try {
    const main = await f.service.cleanupCheck(f.cwd, 'main')
    assert.equal(main.safe, false)
    assert.match(main.reasons.join(' '), /主要/)
    const child = join(f.root, 'child')
    await f.git('worktree', 'add', '-b', 'cleanup', child, 'main')
    const safe = await f.service.cleanupCheck(child, 'main')
    assert.equal(safe.safe, true)
    await writeFile(join(child, '.gitignore'), 'ignored\n')
    await run('git', ['add', '--', '.gitignore'], { cwd: child })
    await run('git', ['commit', '-m', 'ignore'], { cwd: child })
    await writeFile(join(child, 'ignored'), 'do not delete')
    const unsafe = await f.service.cleanupCheck(child, 'cleanup')
    assert.equal(unsafe.safe, false)
    assert.match(unsafe.reasons.join(' '), /忽略|變更|未保存/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('清理檢查拒絕 locked 與未合併工作區', async () => {
  const f = await fixture()
  try {
    const child = join(f.root, 'child')
    await f.git('worktree', 'add', '-b', 'cleanup', child, 'main')
    await f.git('worktree', 'lock', child)
    assert.equal((await f.service.cleanupCheck(child, 'main')).safe, false)
    await f.git('worktree', 'unlock', child)
    await writeFile(join(child, 'extra.txt'), 'extra')
    await run('git', ['add', '--', 'extra.txt'], { cwd: child })
    await run('git', ['commit', '-m', 'extra'], { cwd: child })
    const unmerged = await f.service.cleanupCheck(child, 'main')
    assert.equal(unmerged.safe, false)
    assert.match(unmerged.reasons.join(' '), /合併/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('push 使用明確 origin 分支 refspec 並拒絕 stale head 與 main', async () => {
  const f = await fixture()
  try {
    const remote = join(f.root, 'remote.git')
    await run('git', ['init', '--bare', remote])
    await f.git('remote', 'add', 'origin', remote)
    const head = (await f.git('rev-parse', 'HEAD')).trim()
    await assert.rejects(f.service.push(f.cwd, '0'.repeat(40)), /變更|過期/)
    await f.service.push(f.cwd, head)
    assert.equal((await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/feature/test'])).trim(), head)
    await f.git('checkout', 'main')
    await assert.rejects(f.service.push(f.cwd, head), /主要|保護|main/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('已追蹤檔案同為 M 狀態時，內容改變仍使暫存預覽失效', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'base.txt'), 'one\n')
    const before = await f.service.snapshot(f.cwd)
    await writeFile(join(f.cwd, 'base.txt'), 'two\n')
    const current = await f.service.snapshot(f.cwd)
    assert.equal(before.files[0].working, current.files[0].working)
    assert.notEqual(before.fingerprint, current.fingerprint)
    await assert.rejects(f.service.stage(f.cwd, ['base.txt'], before.fingerprint), /過期/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('Push 拒絕與 fetch 不同的 pushurl、多個 endpoint 及過期 remote', async () => {
  const f = await fixture()
  try {
    const remote = join(f.root, 'remote.git')
    await run('git', ['init', '--bare', remote])
    await f.git('remote', 'add', 'origin', remote)
    const head = (await f.git('rev-parse', 'HEAD')).trim()
    await f.git('config', 'remote.origin.pushurl', 'https://unexpected.invalid/group/repo.git')
    await assert.rejects(f.service.push(f.cwd, head), /pushurl|遠端/)
    await f.git('config', '--unset-all', 'remote.origin.pushurl')
    await f.git('config', '--add', 'remote.origin.url', 'https://other.invalid/group/repo.git')
    await assert.rejects(f.service.push(f.cwd, head), /遠端/)
    await f.git('config', '--unset-all', 'remote.origin.url')
    await f.git('config', 'remote.origin.url', remote)
    await assert.rejects(f.service.push(f.cwd, head, 'https://old.invalid/group/repo.git'), /遠端/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('Diff 不執行 repository 的 external diff 或 textconv', async () => {
  const f = await fixture()
  try {
    await f.git('config', 'diff.external', 'false')
    await f.git('config', 'diff.sentinal.textconv', 'false')
    await writeFile(join(f.cwd, '.gitattributes'), '*.txt diff=sentinal\n')
    await writeFile(join(f.cwd, 'base.txt'), 'changed\n')
    const snapshot = await f.service.snapshot(f.cwd)
    assert.match(snapshot.workingDiff, /changed/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('commit 保留 Git hook，hook 拒絕時不回報成功', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'base.txt'), 'changed\n')
    await f.git('add', '--', 'base.txt')
    await writeFile(join(f.cwd, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const preview = await f.service.previewCommit(f.cwd, 'change')
    await assert.rejects(f.service.commit(f.cwd, preview))
    assert.equal((await f.git('log', '-1', '--format=%s')).trim(), 'initial')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('讀取狀態不啟動 repository 的 fsmonitor', async () => {
  const f = await fixture()
  try {
    const hook = join(f.root, 'monitor.sh')
    const marker = join(f.root, 'fsmonitor-called')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, {mode: 0o755})
    await f.git('config', 'core.fsmonitor', hook)
    await f.service.snapshot(f.cwd)
    await assert.rejects(readFile(marker), {code: 'ENOENT'})
  } finally { await rm(f.root, {recursive:true,force:true}) }
})
