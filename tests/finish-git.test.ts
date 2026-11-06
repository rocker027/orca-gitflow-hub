import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Run } from '../src/contracts'
import { FinishGitService, type FinishPlan } from '../src/services/finish'
import { fixture, run, save } from './git-fixture'

test('乾淨且已合併的來源可免提交訊息收尾，不新增提交', async () => {
  const f = await fixture()
  try {
    const plan = await f.service.prepare(f.source, f.target, '')
    assert.equal(plan.needsCommit, false)
    assert.deepEqual(plan.files, [])
    assert.equal(plan.mergeMode, 'already_merged')
    assert.equal(plan.ahead, 0)
    assert.equal(plan.behind, 0)
    const head = await f.service.commit(f.source, plan, '')
    assert.equal(head, plan.source.head)
    assert.equal(await f.service.merge(f.source, f.target, plan, head), plan.target.head)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('預覽完整列出 staged、unstaged、刪除與特殊檔名，且不變更 index', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'staged\n')
    await f.git(f.source, 'add', '--', 'base.txt')
    await writeFile(join(f.source, 'base.txt'), 'final\n')
    await rm(join(f.source, '.gitignore'))
    const special = ':(glob)*\n shell;$value.txt'
    await writeFile(join(f.source, special), 'literal\n')
    const before = await f.snapshots.snapshot(f.source)
    const plan = await f.service.prepare(f.source, f.target, 'feat: finish')
    assert.equal(plan.needsCommit, true)
    assert.deepEqual([...plan.files].sort(), ['.gitignore', 'base.txt', special].sort())
    assert.equal((await f.snapshots.snapshot(f.source)).fingerprint, before.fingerprint)
    const head = await f.service.commit(f.source, plan, 'feat: finish')
    assert.equal(await f.git(f.source, 'show', `${head}:base.txt`), 'final\n')
    assert.equal(await f.git(f.source, 'show', `${head}:${special}`), 'literal\n')
    assert.equal(await f.git(f.source, 'status', '--porcelain'), '')
    assert.equal(await f.service.merge(f.source, f.target, plan, head), head)
    assert.equal(await readFile(join(f.target, special), 'utf8'), 'literal\n')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('已暫存 rename 的舊路徑不使完整提交失敗', async () => {
  const f = await fixture()
  try {
    await f.git(f.source, 'mv', 'base.txt', 'renamed.txt')
    const plan = await f.service.prepare(f.source, f.target, 'rename')
    assert.equal(plan.source.files[0].originalPath, 'base.txt')
    const head = await f.service.commit(f.source, plan, 'rename')
    assert.equal(await f.git(f.source, 'show', `${head}:renamed.txt`), 'initial\n')
    assert.equal(await f.git(f.source, 'status', '--porcelain'), '')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('只有已暫存刪除時仍可提交與合併，預覽保留刪除路徑', async () => {
  const f = await fixture()
  try {
    await f.git(f.source, 'rm', '--', 'base.txt')
    const plan = await f.service.prepare(f.source, f.target, 'delete')
    assert.deepEqual(plan.files, ['base.txt'])
    const head = await f.service.commit(f.source, plan, 'delete')
    assert.equal(await f.service.merge(f.source, f.target, plan, head), head)
    await assert.rejects(readFile(join(f.target, 'base.txt')), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('已暫存刪除後同名檔案重建時，完整提交重建後內容且清單不重複', async () => {
  const f = await fixture()
  try {
    await f.git(f.source, 'rm', '--', 'base.txt')
    await writeFile(join(f.source, 'base.txt'), 'recreated\n')
    const plan = await f.service.prepare(f.source, f.target, 'recreate')
    assert.deepEqual(plan.files, ['base.txt'])
    const head = await f.service.commit(f.source, plan, 'recreate')
    assert.equal(await f.git(f.source, 'show', `${head}:base.txt`), 'recreated\n')
    assert.equal(await f.git(f.source, 'status', '--porcelain'), '')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('乾淨來源的既有提交可 fast-forward，ahead/behind 以雙方 HEAD 計算', async () => {
  const f = await fixture()
  try {
    const head = await save(f, f.source, 'feature.txt', 'feature\n')
    const plan = await f.service.prepare(f.source, f.target, '')
    assert.equal(plan.ahead, 1)
    assert.equal(plan.behind, 0)
    assert.equal(plan.mergeMode, 'fast_forward')
    assert.equal(await f.service.merge(f.source, f.target, plan, head), head)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('分歧且無衝突時保留雙方歷史並建立 merge commit', async () => {
  const f = await fixture()
  try {
    const targetHead = await save(f, f.target, 'target.txt', 'target\n')
    const sourceHead = await save(f, f.source, 'source.txt', 'source\n')
    const plan = await f.service.prepare(f.source, f.target, '')
    assert.equal(plan.ahead, 1)
    assert.equal(plan.behind, 1)
    assert.equal(plan.mergeMode, 'merge_commit')
    const merged = await f.service.merge(f.source, f.target, plan, sourceHead)
    assert.deepEqual((await f.git(f.target, 'show', '-s', '--format=%P', merged)).trim().split(' '), [targetHead, sourceHead])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('真正衝突在 merge-tree 預檢拒絕，保留來源提交且目標 HEAD/index/內容不動', async () => {
  const f = await fixture()
  try {
    await save(f, f.target, 'base.txt', 'target\n')
    await writeFile(join(f.source, 'base.txt'), 'source\n')
    const plan = await f.service.prepare(f.source, f.target, 'source commit')
    const head = await f.service.commit(f.source, plan, 'source commit')
    const before = await f.snapshots.snapshot(f.target)
    await assert.rejects(f.service.merge(f.source, f.target, plan, head), /衝突|conflict/i)
    assert.equal((await f.snapshots.snapshot(f.target)).fingerprint, before.fingerprint)
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), head)
    assert.equal(await readFile(join(f.target, 'base.txt'), 'utf8'), 'target\n')
    await assert.rejects(readFile(join(f.target, '.git/MERGE_HEAD')), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const kind of ['staged', 'unstaged', 'untracked'] as const) {
  test(`目標有 ${kind} 變更時，來源提交前拒絕`, async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.target, kind === 'untracked' ? 'new.txt' : 'base.txt'), 'changed\n')
      if (kind === 'staged') await f.git(f.target, 'add', '--', 'base.txt')
      const before = await f.snapshots.snapshot(f.source)
      await assert.rejects(f.service.prepare(f.source, f.target, ''), /目標.*(乾淨|變更)|target.*dirty/i)
      assert.equal((await f.snapshots.snapshot(f.source)).fingerprint, before.fingerprint)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

test('來源內容在預覽後改變時不暫存或提交', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'preview\n')
    const plan = await f.service.prepare(f.source, f.target, 'change')
    await writeFile(join(f.source, 'base.txt'), 'later\n')
    await assert.rejects(f.service.commit(f.source, plan, 'change'), /來源|過期|變更/)
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), plan.source.head)
    assert.equal(await f.git(f.source, 'diff', '--cached'), '')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const side of ['source', 'target'] as const) {
  test(`${side} 分支在預覽後改變，即使 SHA 相同也拒絕合併`, async () => {
    const f = await fixture()
    try {
      const head = await save(f, f.source, 'source.txt', 'source\n')
      const plan = await f.service.prepare(f.source, f.target, '')
      await f.git(f[side], 'checkout', '-b', `changed-${side}`)
      const before = await f.snapshots.snapshot(f.target)
      await assert.rejects(f.service.merge(f.source, f.target, plan, head), /分支|過期|變更/)
      assert.equal((await f.snapshots.snapshot(f.target)).fingerprint, before.fingerprint)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

test('merge-tree 執行期間目標漂移時，再次核對並拒絕真實合併', async () => {
  const f = await fixture()
  try {
    const head = await save(f, f.source, 'source.txt', 'source\n')
    let injected = false
    const guardedRun: Run = async (tool, args, options) => {
      const output = await run(tool, args, options)
      if (args.includes('merge-tree')) {
        injected = true
        await writeFile(join(f.target, 'base.txt'), 'concurrent\n')
      }
      return output
    }
    const service = new FinishGitService(guardedRun)
    // 預覽也會跑 merge-tree 預檢；用一般服務建立計畫，只在合併時注入漂移。
    const plan = await f.service.prepare(f.source, f.target, '')
    await assert.rejects(service.merge(f.source, f.target, plan, head), /目標|過期|變更/)
    assert.equal(injected, true)
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), plan.target.head)
    assert.equal(await readFile(join(f.target, 'base.txt'), 'utf8'), 'concurrent\n')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('跨 repo、同一工作樹與主要來源工作樹均拒絕', async () => {
  const f = await fixture()
  const other = await fixture()
  try {
    await assert.rejects(f.service.prepare(f.source, other.target, ''), /repo|儲存庫|同一/)
    await assert.rejects(f.service.prepare(f.source, f.source, ''), /不同|相同|同一/)
    await assert.rejects(f.service.prepare(f.target, f.source, ''), /主要/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(other.root, { recursive: true, force: true })
  }
})

for (const entry of [
  { file: '.env', content: 'TOKEN=fixture' },
  { file: 'ordinary.txt', content: '-----BEGIN PRIVATE KEY-----\nfixture' },
] as const) {
  test(`未暫存的 ${entry.file} 機密在預覽即拒絕且 index 不動`, async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.source, entry.file), entry.content)
      const before = await f.snapshots.snapshot(f.source)
      await assert.rejects(f.service.prepare(f.source, f.target, 'secret'), /敏感|機密|私鑰/)
      assert.equal((await f.snapshots.snapshot(f.source)).fingerprint, before.fingerprint)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

test('未追蹤 symlink 在預覽拒絕且不讀取外部內容', async () => {
  const f = await fixture()
  try {
    await symlink(join(f.root, 'missing-outside'), join(f.source, 'link'))
    await assert.rejects(f.service.prepare(f.source, f.target, 'link'), /symlink|連結/)
    assert.equal(await f.git(f.source, 'diff', '--cached'), '')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
  test(`來源有 ${marker} 時拒絕且保留操作現場`, async () => {
    const f = await fixture()
    try {
      const gitDir = (await f.git(f.source, 'rev-parse', '--absolute-git-dir')).trim()
      const path = join(gitDir, marker)
      if (marker.startsWith('rebase-')) await mkdir(path)
      else await writeFile(path, (await f.git(f.source, 'rev-parse', 'HEAD')).trim())
      await assert.rejects(f.service.prepare(f.source, f.target, ''), /進行中|鎖|操作|lock/)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

test('detached HEAD、工作樹鎖及 submodule 都在預覽拒絕', async () => {
  const f = await fixture()
  try {
    await f.git(f.source, 'checkout', '--detach')
    await assert.rejects(f.service.prepare(f.source, f.target, ''), /detached|分支/)
    await f.git(f.source, 'checkout', 'feature/test')
    await f.git(f.target, 'worktree', 'lock', f.source)
    await assert.rejects(f.service.prepare(f.source, f.target, ''), /鎖|lock/)
    await f.git(f.target, 'worktree', 'unlock', f.source)
    const head = (await f.git(f.source, 'rev-parse', 'HEAD')).trim()
    await f.git(f.source, 'update-index', '--add', '--cacheinfo', `160000,${head},module`)
    await assert.rejects(f.service.prepare(f.source, f.target, 'module'), /submodule/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('目標 ignored 檔案與合併內容同名時拒絕覆蓋，來源提交保留', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'ignored.txt'), 'source tracked\n')
    await f.git(f.source, 'add', '-f', '--', 'ignored.txt')
    await f.git(f.source, 'commit', '-m', 'tracked ignored name')
    await writeFile(join(f.target, 'ignored.txt'), 'keep ignored\n')
    const plan = await f.service.prepare(f.source, f.target, '')
    await assert.rejects(f.service.merge(f.source, f.target, plan, plan.source.head), /ignored|忽略|overwritten|覆蓋/i)
    assert.equal(await readFile(join(f.target, 'ignored.txt'), 'utf8'), 'keep ignored\n')
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), plan.target.head)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('dirty 來源訊息必填，Git pre-commit hook 拒絕時不提交', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'changed\n')
    await assert.rejects(f.service.prepare(f.source, f.target, ''), /訊息/)
    await writeFile(join(f.target, '.git/hooks/pre-commit'), '#!/bin/sh\necho hook-refused >&2\nexit 1\n', { mode: 0o755 })
    const plan = await f.service.prepare(f.source, f.target, 'change')
    await assert.rejects(f.service.commit(f.source, plan, 'change'), /hook-refused/)
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), plan.source.head)
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), plan.target.head)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('預覽可經 JSON 儲存並於新的服務 instance 完成提交與合併', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'serialized\n')
    const plan = JSON.parse(JSON.stringify(await f.service.prepare(f.source, f.target, 'serialized'))) as FinishPlan
    const service = new FinishGitService(run)
    const head = await service.commit(f.source, plan, 'serialized')
    const restored = JSON.parse(JSON.stringify(plan)) as FinishPlan
    assert.equal(await new FinishGitService(run).merge(f.source, f.target, restored, head), head)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('目標預覽後變髒時，commit 在 stage 前拒絕', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'source\n')
    const plan = await f.service.prepare(f.source, f.target, 'change')
    await writeFile(join(f.target, 'later.txt'), 'target\n')
    const before = await f.snapshots.snapshot(f.source)
    await assert.rejects(f.service.commit(f.source, plan, 'change'), /目標.*變更/)
    assert.equal((await f.snapshots.snapshot(f.source)).fingerprint, before.fingerprint)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('序列化計畫中的目標身分或 SHA 不符時拒絕執行', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'source\n')
    const plan = await f.service.prepare(f.source, f.target, 'change')
    const alteredIdentity = structuredClone(plan)
    alteredIdentity.identity.target.commonDir = f.root
    await assert.rejects(f.service.commit(f.source, alteredIdentity, 'change'), /身分|過期|變更/)
    const alteredHead = structuredClone(plan)
    alteredHead.target.head = '0'.repeat(40)
    await assert.rejects(f.service.commit(f.source, alteredHead, 'change'), /目標.*變更|過期/)
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), plan.source.head)
    assert.equal(await f.git(f.source, 'diff', '--cached'), '')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('pre-commit hook 改寫 tree 時標示 UNKNOWN，不可沿用原預覽繼續合併', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'preview\n')
    await writeFile(join(f.target, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf "hook changed\\n" > base.txt\ngit add -- base.txt\n', { mode: 0o755 })
    const plan = await f.service.prepare(f.source, f.target, 'change')
    await assert.rejects(f.service.commit(f.source, plan, 'change'), /UNKNOWN.*tree/)
    const head = (await f.git(f.source, 'rev-parse', 'HEAD')).trim()
    assert.notEqual(head, plan.source.head)
    assert.equal(await f.git(f.source, 'show', `${head}:base.txt`), 'hook changed\n')
    await assert.rejects(f.service.merge(f.source, f.target, plan, head), /本次收尾|預覽/)
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), plan.target.head)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('post-commit hook 改寫 HEAD 時標示 UNKNOWN 並停止合併', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.source, 'base.txt'), 'preview\n')
    await writeFile(join(f.target, '.git/hooks/post-commit'), '#!/bin/sh\ngit update-ref HEAD "$(git rev-parse HEAD^)"\n', { mode: 0o755 })
    const plan = await f.service.prepare(f.source, f.target, 'change')
    await assert.rejects(f.service.commit(f.source, plan, 'change'), /UNKNOWN/)
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), plan.target.head)
    assert.equal(plan.identity.committedHead, undefined)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('merge-tree 不支援時不退回真實 merge，目標保持未動', async () => {
  const f = await fixture()
  try {
    const head = await save(f, f.source, 'source.txt', 'source\n')
    let merges = 0
    const failingRun: Run = async (tool, args, options) => {
      if (args.includes('merge-tree')) throw new Error('unknown option write-tree')
      if (args.includes('merge')) merges++
      return run(tool, args, options)
    }
    const service = new FinishGitService(failingRun)
    await assert.rejects(service.prepare(f.source, f.target, ''), /預檢失敗.*merge-tree/)
    const plan = await f.service.prepare(f.source, f.target, '')
    await assert.rejects(service.merge(f.source, f.target, plan, head), /預檢失敗.*merge-tree/)
    assert.equal(merges, 0)
    assert.equal((await f.snapshots.snapshot(f.target)).fingerprint, plan.target.fingerprint)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('pre-merge-commit hook 拒絕時標示 UNKNOWN 並保留已寫入的合併現場', async () => {
  const f = await fixture()
  try {
    await save(f, f.target, 'target.txt', 'target\n')
    const head = await save(f, f.source, 'source.txt', 'source\n')
    await writeFile(join(f.target, '.git/hooks/pre-merge-commit'), '#!/bin/sh\necho merge-hook-refused >&2\nexit 1\n', { mode: 0o755 })
    const plan = await f.service.prepare(f.source, f.target, '')
    await assert.rejects(f.service.merge(f.source, f.target, plan, head), /UNKNOWN.*merge-hook-refused/s)
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), plan.target.head)
    assert.equal((await readFile(join(f.target, '.git/MERGE_HEAD'), 'utf8')).trim(), head)
    assert.equal(await readFile(join(f.target, 'source.txt'), 'utf8'), 'source\n')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('儲存庫 mergeOptions 的 squash 或 no-commit 不得改變保留歷史的收尾模式', async () => {
  const f = await fixture()
  try {
    const targetHead = await save(f, f.target, 'target.txt', 'target\n')
    const sourceHead = await save(f, f.source, 'source.txt', 'source\n')
    await f.git(f.target, 'config', 'branch.main.mergeOptions', '--squash --no-commit')
    await f.git(f.target, 'config', 'merge.autoStash', 'true')
    const plan = await f.service.prepare(f.source, f.target, '')
    const merged = await f.service.merge(f.source, f.target, plan, sourceHead)
    assert.deepEqual((await f.git(f.target, 'show', '-s', '--format=%P', merged)).trim().split(' '), [targetHead, sourceHead])
    assert.equal(await f.git(f.target, 'status', '--porcelain'), '')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('Hub 持有 common-dir 的 gitflow-hub.lock 目錄時仍可安全完成收尾', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.target, '.git/gitflow-hub.lock'))
    await writeFile(join(f.source, 'base.txt'), 'hub locked\n')
    const plan = await f.service.prepare(f.source, f.target, 'hub lock')
    const head = await f.service.commit(f.source, plan, 'hub lock')
    assert.equal(await f.service.merge(f.source, f.target, plan, head), head)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const kind of ['file', 'symlink', 'ref'] as const) {
  test(`Hub 鎖豁免不接受 ${kind} lock`, async () => {
    const f = await fixture()
    try {
      if (kind === 'file') await writeFile(join(f.target, '.git/gitflow-hub.lock'), 'lock')
      if (kind === 'symlink') await symlink(f.root, join(f.target, '.git/gitflow-hub.lock'))
      if (kind === 'ref') await writeFile(join(f.target, '.git/refs/heads/main.lock'), 'lock')
      await assert.rejects(f.service.prepare(f.source, f.target, ''), /鎖|lock/)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

for (const kind of ['assume-unchanged', 'skip-worktree', 'sparse-checkout'] as const) {
  for (const side of ['source', 'target'] as const) {
    test(`${side} 的 ${kind} 隱藏變更設定在預覽及寫入前拒絕，原內容保留`, async () => {
      const f = await fixture()
      try {
        const mutations: string[][] = []
        const watched: Run = async (tool, args, options) => {
          if (args.some((arg) => ['add', 'commit', 'merge', 'remove'].includes(arg))) mutations.push([...args])
          return run(tool, args, options)
        }
        const service = new FinishGitService(watched)
        const plan = await service.prepare(f.source, f.target, '')
        if (kind === 'sparse-checkout') await f.git(f[side], 'sparse-checkout', 'set', '--no-cone', '*')
        else {
          await f.git(f[side], 'update-index', `--${kind}`, '--', 'base.txt')
          await writeFile(join(f[side], 'base.txt'), 'hidden local content\n')
          assert.equal(await f.git(f[side], 'status', '--porcelain'), '')
        }
        const before = await readFile(join(f[side], 'base.txt'), 'utf8')
        const indexBefore = await f.git(f[side], 'ls-files', '--stage', '-z')
        const refusal = /assume-unchanged|skip-worktree|sparse checkout/
        await assert.rejects(service.prepare(f.source, f.target, ''), refusal)
        await assert.rejects(service.commit(f.source, plan, ''), refusal)
        await assert.rejects(service.merge(f.source, f.target, plan, plan.source.head), refusal)
        assert.deepEqual(mutations, [])
        assert.equal(await readFile(join(f[side], 'base.txt'), 'utf8'), before)
        assert.equal(await f.git(f[side], 'ls-files', '--stage', '-z'), indexBefore)
        assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), plan.source.head)
        assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), plan.target.head)
      } finally { await rm(f.root, { recursive: true, force: true }) }
    })
  }

  test(`cleanupCheck 拒絕 ${kind}，不把可刪除的隱藏內容誤判安全`, async () => {
    const f = await fixture()
    try {
      if (kind === 'sparse-checkout') await f.git(f.source, 'sparse-checkout', 'set', '--no-cone', '*')
      else {
        await f.git(f.source, 'update-index', `--${kind}`, '--', 'base.txt')
        await writeFile(join(f.source, 'base.txt'), 'hidden cleanup content\n')
        assert.equal(await f.git(f.source, 'status', '--porcelain'), '')
      }
      const before = await readFile(join(f.source, 'base.txt'), 'utf8')
      const check = await f.snapshots.cleanupCheck(f.source, 'main')
      assert.equal(check.safe, false)
      assert.match(check.reasons.join(' '), /assume-unchanged|skip-worktree|sparse checkout/)
      assert.equal(await readFile(join(f.source, 'base.txt'), 'utf8'), before)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

test('隱藏變更旗標解析只看 NUL 記錄前綴，不誤判小寫及含換行的正常檔名', async () => {
  const f = await fixture()
  try {
    const name = 'lowercase\ns false flag.txt'
    await save(f, f.source, name, 'ordinary\n')
    const plan = await f.service.prepare(f.source, f.target, '')
    const head = await f.service.merge(f.source, f.target, plan, plan.source.head)
    assert.equal(head, plan.source.head)
    assert.equal((await f.snapshots.cleanupCheck(f.source, 'main')).safe, true)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
