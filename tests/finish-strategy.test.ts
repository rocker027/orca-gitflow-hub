import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Run } from '../src/contracts'
import { FinishGitService, type FinishOptions, type FinishPlan } from '../src/services/finish'
import { fixture, run, save, type Fixture } from './git-fixture'

const SHA = /^[a-f0-9]{40}$/

async function cleanup(f: Fixture) { await rm(f.root, { recursive: true, force: true }) }

/** 目標新增 main.txt；來源新增 a.txt、b.txt 兩個提交，兩邊沒有衝突。 */
async function diverged(f: Fixture) {
  const base = (await f.git(f.target, 'rev-parse', 'HEAD')).trim()
  const first = await save(f, f.source, 'a.txt', 'a\n', 'add a')
  const second = await save(f, f.source, 'b.txt', 'b\n', 'add b')
  const targetHead = await save(f, f.target, 'main.txt', 'main\n', 'add main')
  return { base, first, second, targetHead }
}

async function parents(f: Fixture, rev: string): Promise<string[]> {
  return (await f.git(f.target, 'rev-list', '--parents', '-n', '1', rev)).trim().split(' ').slice(1)
}

/** 依工作流程順序執行全部 Git 步驟，回傳最後的來源與目標 HEAD。 */
async function finishAll(f: Fixture, plan: FinishPlan, message: string) {
  let head = await f.service.commit(f.source, plan, message)
  await f.service.precheck(f.source, f.target, plan, head)
  head = await f.service.squash(f.source, plan, head, message)
  head = await f.service.rebase(f.source, plan, head)
  const merged = await f.service.merge(f.source, f.target, plan, head)
  return { source: head, target: merged }
}

async function prepare(f: Fixture, options: FinishOptions, message = '') {
  return f.service.prepare(f.source, f.target, message, options)
}

test('merge 不合成：分歧時建立合併提交，保留來源的兩個提交', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    const plan = await prepare(f, { strategy: 'merge', squash: false })
    assert.equal(plan.mergeMode, 'merge_commit')
    const result = await finishAll(f, plan, '')
    assert.equal(result.source, d.second)
    assert.deepEqual(await parents(f, result.target), [d.targetHead, d.second])
    assert.equal((await f.snapshots.cleanupCheck(f.source, result.target)).safe, true)
  } finally { await cleanup(f) }
})

test('merge 合成一個：來源兩個提交合成一個後，以合併提交接到目標', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    const plan = await prepare(f, { strategy: 'merge', squash: true }, '完成登入功能')
    assert.equal(plan.squashCount, 2)
    const result = await finishAll(f, plan, '完成登入功能')
    assert.match(result.source, SHA)
    assert.notEqual(result.source, d.second)
    assert.deepEqual(await parents(f, result.source), [d.base])
    assert.equal((await f.git(f.source, 'log', '-1', '--format=%B', result.source)).trim(), '完成登入功能')
    assert.equal((await f.git(f.source, 'rev-parse', `${result.source}^{tree}`)).trim(),
      (await f.git(f.source, 'rev-parse', `${d.second}^{tree}`)).trim())
    assert.deepEqual(await parents(f, result.target), [d.targetHead, result.source])
    assert.equal(await f.git(f.source, 'status', '--porcelain'), '')
    assert.equal((await f.snapshots.cleanupCheck(f.source, result.target)).safe, true)
  } finally { await cleanup(f) }
})

test('rebase 不合成：來源提交接到目標最後面，目標快轉且歷史為一直線', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    const plan = await prepare(f, { strategy: 'rebase', squash: false })
    assert.equal(plan.mergeMode, 'rebase')
    const result = await finishAll(f, plan, '')
    assert.equal(result.target, result.source)
    assert.equal((await f.git(f.target, 'rev-list', '--count', `${d.targetHead}..${result.target}`)).trim(), '2')
    assert.equal((await f.git(f.target, 'rev-list', '--count', '--merges', `${d.targetHead}..${result.target}`)).trim(), '0')
    assert.deepEqual(await parents(f, `${result.target}~1`), [d.targetHead])
    for (const file of ['a.txt', 'b.txt', 'main.txt']) await lstat(join(f.target, file))
    assert.equal((await f.snapshots.cleanupCheck(f.source, result.target)).safe, true)
  } finally { await cleanup(f) }
})

test('rebase 合成一個：目標只多一個提交，父提交是原本的目標 HEAD', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    const plan = await prepare(f, { strategy: 'rebase', squash: true }, '完成登入功能')
    const result = await finishAll(f, plan, '完成登入功能')
    assert.equal(result.target, result.source)
    assert.deepEqual(await parents(f, result.target), [d.targetHead])
    assert.equal((await f.git(f.target, 'log', '-1', '--format=%B', result.target)).trim(), '完成登入功能')
    for (const file of ['a.txt', 'b.txt', 'main.txt']) await lstat(join(f.target, file))
    assert.equal((await f.snapshots.cleanupCheck(f.source, result.target)).safe, true)
  } finally { await cleanup(f) }
})

test('rebase 在目標沒有前進時略過搬移，直接快轉', async () => {
  const f = await fixture()
  try {
    const head = await save(f, f.source, 'a.txt', 'a\n')
    const plan = await prepare(f, { strategy: 'rebase', squash: false })
    assert.equal(plan.mergeMode, 'fast_forward')
    const result = await finishAll(f, plan, '')
    assert.equal(result.source, head)
    assert.equal(result.target, head)
  } finally { await cleanup(f) }
})

test('未提交變更加上 squash：先提交再合成，說明沿用同一段文字', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    await writeFile(join(f.source, 'c.txt'), 'c\n')
    const plan = await prepare(f, { strategy: 'rebase', squash: true }, '一次完成')
    assert.equal(plan.needsCommit, true)
    assert.equal(plan.squashCount, 3)
    const result = await finishAll(f, plan, '一次完成')
    assert.deepEqual(await parents(f, result.target), [d.targetHead])
    await lstat(join(f.target, 'c.txt'))
  } finally { await cleanup(f) }
})

test('預檢衝突在預覽就拒絕並列出兩邊都改過的檔案，不改寫來源也不動目標', async () => {
  const f = await fixture()
  try {
    const sourceHead = await save(f, f.source, 'base.txt', 'source\n')
    const targetHead = await save(f, f.target, 'base.txt', 'target\n')
    for (const options of [{ strategy: 'rebase', squash: false }, { strategy: 'merge', squash: true }, { strategy: 'rebase', squash: true }] as FinishOptions[]) {
      await assert.rejects(prepare(f, options, '說明'), /衝突[\s\S]*base\.txt/)
    }
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), sourceHead)
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), targetHead)
    const gitDir = (await f.git(f.source, 'rev-parse', '--absolute-git-dir')).trim()
    await assert.rejects(lstat(join(gitDir, 'rebase-merge')), { code: 'ENOENT' })
  } finally { await cleanup(f) }
})

test('有未提交變更時於執行預檢擋下衝突，只留下新提交，不合成也不搬移', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'a\n')
    const targetHead = await save(f, f.target, 'base.txt', 'target\n')
    await writeFile(join(f.source, 'base.txt'), 'source\n')
    const plan = await prepare(f, { strategy: 'rebase', squash: true }, '說明')
    const head = await f.service.commit(f.source, plan, '說明')
    await assert.rejects(f.service.precheck(f.source, f.target, plan, head), /衝突[\s\S]*base\.txt/)
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), head)
    assert.equal((await f.git(f.source, 'rev-list', '--count', 'HEAD')).trim(), '3')
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), targetHead)
  } finally { await cleanup(f) }
})

/** 讓真正的 git rebase 在第一個提交後停下，模擬預檢通過但執行中斷。 */
function interruptRebase(abortFails = false): Run {
  return async (tool, args, options) => {
    const index = args.indexOf('rebase')
    if (tool === 'git' && index >= 0 && args.includes('--abort') && abortFails) throw new Error('abort failed')
    if (tool === 'git' && index >= 0 && !args.includes('--abort')) {
      return run(tool, [...args.slice(0, -1), '--exec', 'exit 1', args.at(-1)!], options)
    }
    return run(tool, args, options)
  }
}

test('git rebase 中途失敗時自動還原來源，目標不變且沒有進行中的 rebase', async () => {
  const f = await fixture(interruptRebase())
  try {
    const d = await diverged(f)
    const plan = await prepare(f, { strategy: 'rebase', squash: false })
    const head = await f.service.commit(f.source, plan, '')
    await f.service.precheck(f.source, f.target, plan, head)
    await assert.rejects(f.service.rebase(f.source, plan, head), (error: Error) =>
      /已回到 rebase 前的狀態/.test(error.message) && !/UNKNOWN/.test(error.message))
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), d.second)
    assert.equal(await f.git(f.source, 'status', '--porcelain'), '')
    assert.equal((await f.git(f.target, 'rev-parse', 'HEAD')).trim(), d.targetHead)
    const gitDir = (await f.git(f.source, 'rev-parse', '--absolute-git-dir')).trim()
    await assert.rejects(lstat(join(gitDir, 'rebase-merge')), { code: 'ENOENT' })
  } finally { await cleanup(f) }
})

test('rebase 還原也失敗時標示 UNKNOWN 並保留現場', async () => {
  const f = await fixture(interruptRebase(true))
  try {
    await diverged(f)
    const plan = await prepare(f, { strategy: 'rebase', squash: false })
    const head = await f.service.commit(f.source, plan, '')
    await assert.rejects(f.service.rebase(f.source, plan, head), /UNKNOWN/)
    const gitDir = (await f.git(f.source, 'rev-parse', '--absolute-git-dir')).trim()
    await lstat(join(gitDir, 'rebase-merge'))
    await f.git(f.source, 'rebase', '--abort')
  } finally { await cleanup(f) }
})

test('pre-rebase hook 拒絕時沒有開始 rebase，回報已回到原狀而非 UNKNOWN', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    const hooks = join(f.root, 'hooks')
    await f.git(f.target, 'config', 'core.hooksPath', hooks)
    await mkdir(hooks)
    await writeFile(join(hooks, 'pre-rebase'), '#!/bin/sh\necho rebase-refused >&2\nexit 1\n', { mode: 0o755 })
    const plan = await prepare(f, { strategy: 'rebase', squash: false })
    const head = await f.service.commit(f.source, plan, '')
    await assert.rejects(f.service.rebase(f.source, plan, head), (error: Error) =>
      /已回到 rebase 前的狀態/.test(error.message) && !/UNKNOWN/.test(error.message))
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), d.second)
  } finally { await cleanup(f) }
})

test('rebase 不合成時，來源含合併提交在預覽拒絕；改選合成一個則可完成', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'a\n')
    await f.git(f.source, 'checkout', '-b', 'side')
    await save(f, f.source, 'side.txt', 'side\n')
    await f.git(f.source, 'checkout', 'feature/test')
    await f.git(f.source, 'merge', '--no-ff', '-m', 'merge side', 'side')
    const targetHead = await save(f, f.target, 'main.txt', 'main\n')
    await assert.rejects(prepare(f, { strategy: 'rebase', squash: false }), /合併提交/)
    const plan = await prepare(f, { strategy: 'rebase', squash: true }, '整理後完成')
    const result = await finishAll(f, plan, '整理後完成')
    assert.deepEqual(await parents(f, result.target), [targetHead])
    for (const file of ['a.txt', 'side.txt', 'main.txt']) await lstat(join(f.target, file))
  } finally { await cleanup(f) }
})

test('選了合成一個且有兩個以上提交時，說明必填', async () => {
  const f = await fixture()
  try {
    await diverged(f)
    await assert.rejects(prepare(f, { strategy: 'merge', squash: true }, ''), /說明/)
    await assert.rejects(prepare(f, { strategy: 'merge', squash: true }, '   '), /說明/)
  } finally { await cleanup(f) }
})

test('只有一個提交時 squash 略過，不改寫來源', async () => {
  const f = await fixture()
  try {
    const head = await save(f, f.source, 'a.txt', 'a\n')
    const plan = await prepare(f, { strategy: 'merge', squash: true })
    assert.equal(plan.squashCount, 1)
    assert.equal(await f.service.squash(f.source, plan, head, ''), head)
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), head)
  } finally { await cleanup(f) }
})

test('預覽後來源分支被移動時 squash 拒絕，不更新分支', async () => {
  const f = await fixture()
  try {
    await diverged(f)
    const plan = await prepare(f, { strategy: 'merge', squash: true }, '說明')
    const head = await f.service.commit(f.source, plan, '說明')
    const moved = await save(f, f.source, 'late.txt', 'late\n')
    await assert.rejects(f.service.squash(f.source, plan, head, '說明'), /變更|過期/)
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), moved)
  } finally { await cleanup(f) }
})

test('squash 依 commit.gpgSign 要求簽章；簽章失敗時不更新分支', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    const plan = await prepare(f, { strategy: 'merge', squash: true }, '說明')
    const head = await f.service.commit(f.source, plan, '說明')
    await f.git(f.target, 'config', 'commit.gpgSign', 'true')
    await f.git(f.target, 'config', 'gpg.program', join(f.root, 'missing-gpg'))
    await assert.rejects(f.service.squash(f.source, plan, head, '說明'), (error: Error) => !/UNKNOWN/.test(error.message))
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), d.second)
  } finally { await cleanup(f) }
})

test('改寫的提交中已有提交在遠端追蹤分支時回報數量', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    await f.git(f.target, 'update-ref', 'refs/remotes/origin/feature/test', d.first)
    const plan = await prepare(f, { strategy: 'rebase', squash: false })
    assert.equal(plan.pushedCount, 1)
  } finally { await cleanup(f) }
})

test('預覽可經 JSON 儲存後由新的服務 instance 完成 rebase 與 squash', async () => {
  const f = await fixture()
  try {
    const d = await diverged(f)
    const plan = JSON.parse(JSON.stringify(await prepare(f, { strategy: 'rebase', squash: true }, '序列化'))) as FinishPlan
    const service = new FinishGitService(run)
    let head = await service.commit(f.source, plan, '序列化')
    await service.precheck(f.source, f.target, plan, head)
    head = await service.squash(f.source, plan, head, '序列化')
    head = await service.rebase(f.source, plan, head)
    assert.equal(await service.merge(f.source, f.target, plan, head), head)
    assert.deepEqual(await parents(f, head), [d.targetHead])
  } finally { await cleanup(f) }
})

test('rebase 會碰到來源被忽略的本機檔時在預覽拒絕，檔案保持原樣', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'a\n')
    await writeFile(join(f.target, 'ignored.txt'), 'shared settings\n')
    await f.git(f.target, 'add', '-f', '--', 'ignored.txt')
    await f.git(f.target, 'commit', '-m', 'track ignored file')
    await writeFile(join(f.source, 'ignored.txt'), 'LOCAL SECRET\n')
    await assert.rejects(prepare(f, { strategy: 'rebase', squash: false }), /忽略[\s\S]*ignored\.txt/)
    await assert.rejects(prepare(f, { strategy: 'rebase', squash: true }, '說明'), /忽略[\s\S]*ignored\.txt/)
    assert.equal(await readFile(join(f.source, 'ignored.txt'), 'utf8'), 'LOCAL SECRET\n')
    const plan = await prepare(f, { strategy: 'merge', squash: false })
    await finishAll(f, plan, '')
    assert.equal(await readFile(join(f.source, 'ignored.txt'), 'utf8'), 'LOCAL SECRET\n')
  } finally { await cleanup(f) }
})

test('預覽後才出現的被忽略檔案，rebase 執行前再次擋下', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'a\n')
    await writeFile(join(f.target, 'ignored.txt'), 'shared settings\n')
    await f.git(f.target, 'add', '-f', '--', 'ignored.txt')
    await f.git(f.target, 'commit', '-m', 'track ignored file')
    const plan = await prepare(f, { strategy: 'rebase', squash: false })
    const head = await f.service.commit(f.source, plan, '')
    await writeFile(join(f.source, 'ignored.txt'), 'LOCAL SECRET\n')
    await assert.rejects(f.service.rebase(f.source, plan, head), /忽略[\s\S]*ignored\.txt/)
    assert.equal(await readFile(join(f.source, 'ignored.txt'), 'utf8'), 'LOCAL SECRET\n')
    assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), head)
  } finally { await cleanup(f) }
})

test('被忽略的整個資料夾與 rebase 帶入的路徑重疊時也拒絕', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'a\n')
    await save(f, f.target, '.gitignore', 'ignored.txt\ncache/\n')
    await mkdir(join(f.target, 'cache'))
    await writeFile(join(f.target, 'cache', 'kept.txt'), 'tracked\n')
    await f.git(f.target, 'add', '-f', '--', 'cache/kept.txt')
    await f.git(f.target, 'commit', '-m', 'track cache file')
    await writeFile(join(f.source, '.gitignore'), 'ignored.txt\ncache/\n')
    await f.git(f.source, 'commit', '-am', 'same ignore rules')
    await mkdir(join(f.source, 'cache'))
    await writeFile(join(f.source, 'cache', 'local.bin'), 'local\n')
    await assert.rejects(prepare(f, { strategy: 'rebase', squash: false }), /忽略[\s\S]*cache/)
  } finally { await cleanup(f) }
})

test('已合併的工作選 rebase 且目標已前進時，不搬移、不警告改寫，直接完成', async () => {
  for (const squash of [false, true]) {
    const f = await fixture()
    try {
      const sourceHead = (await f.git(f.source, 'rev-parse', 'HEAD')).trim()
      const targetHead = await save(f, f.target, 'main.txt', 'main\n')
      const plan = await prepare(f, { strategy: 'rebase', squash })
      assert.equal(plan.mergeMode, 'already_merged')
      const result = await finishAll(f, plan, '')
      assert.equal(result.source, sourceHead)
      assert.equal(result.target, targetHead)
      assert.equal((await f.git(f.source, 'rev-parse', 'HEAD')).trim(), sourceHead)
      assert.equal((await f.snapshots.cleanupCheck(f.source, result.target)).safe, true)
    } finally { await cleanup(f) }
  }
})

test('檔名只差大小寫的被忽略檔案，在不分大小寫的磁碟上也會擋下 rebase', async (t) => {
  const f = await fixture()
  try {
    if ((await f.git(f.target, 'config', '--bool', '--default=false', '--get', 'core.ignorecase')).trim() !== 'true') {
      t.skip('此檔案系統區分大小寫，不會發生覆蓋')
      return
    }
    await save(f, f.source, '.gitignore', 'ignored.txt\nsecret.txt\n', 'source ignore rules')
    await save(f, f.target, '.gitignore', 'ignored.txt\nsecret.txt\n', 'target ignore rules')
    await writeFile(join(f.target, 'secret.txt'), 'shared\n')
    await f.git(f.target, 'add', '-f', '--', 'secret.txt')
    await f.git(f.target, 'commit', '-m', 'track secret')
    await writeFile(join(f.source, 'Secret.txt'), 'LOCAL SECRET\n')
    await assert.rejects(prepare(f, { strategy: 'rebase', squash: false }), /忽略[\s\S]*Secret\.txt/)
    assert.equal(await readFile(join(f.source, 'Secret.txt'), 'utf8'), 'LOCAL SECRET\n')
  } finally { await cleanup(f) }
})

test('目標用同名檔案取代被忽略的資料夾時擋下 rebase，資料夾內容保留', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, '.gitignore', 'ignored.txt\nlogs/\n', 'source ignore rules')
    await save(f, f.target, '.gitignore', 'ignored.txt\nlogs/\n', 'target ignore rules')
    await save(f, f.target, 'logs', 'now a file\n')
    await mkdir(join(f.source, 'logs'))
    await writeFile(join(f.source, 'logs', 'keep.log'), 'local log\n')
    await assert.rejects(prepare(f, { strategy: 'rebase', squash: false }), /忽略[\s\S]*logs/)
    assert.equal(await readFile(join(f.source, 'logs', 'keep.log'), 'utf8'), 'local log\n')
  } finally { await cleanup(f) }
})

test('rebase 有衝突但一般合併可行時，訊息先安撫、再說改選一般合併，原因放最後', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'base.txt', 'temporary\n', 'try change')
    await save(f, f.source, 'base.txt', 'initial\n', 'revert change')
    await save(f, f.source, 'a.txt', 'a\n')
    await save(f, f.target, 'base.txt', 'target\n')
    await assert.rejects(prepare(f, { strategy: 'rebase', squash: false }), (error: Error) =>
      /^main 沒有被改動，你的改動都還在。有衝突，無法自動合併。請再按一次「完成這個工作」，第 2 題選「一般合併」就能完成。原因：用「接到最後面」時，main 和這個工作都改過 base\.txt。$/.test(error.message))
    const plan = await prepare(f, { strategy: 'merge', squash: false })
    assert.equal(plan.mergeMode, 'merge_commit')
  } finally { await cleanup(f) }
})

test('一般合併產生的合併提交用分支名稱寫說明，不只是一串提交編號', async () => {
  const f = await fixture()
  try {
    await diverged(f)
    const plan = await prepare(f, { strategy: 'merge', squash: false })
    const result = await finishAll(f, plan, '')
    assert.equal((await f.git(f.target, 'log', '-1', '--format=%s', result.target)).trim(), "Merge branch 'feature/test' into main")
  } finally { await cleanup(f) }
})
