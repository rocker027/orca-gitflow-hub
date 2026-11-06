import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitService } from '../src/services/git'
import { fixture, run, save, type Fixture } from './git-fixture'

async function cleanup(f: Fixture) { await rm(f.root, { recursive: true, force: true }) }
const targetHead = async (f: Fixture) => (await f.git(f.target, 'rev-parse', 'HEAD')).trim()
// 測試用的假金鑰在執行時才組出，避免原始碼本身觸發提交機密檢查。
const fakeKey = () => ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')

test('M1 合併建議資料包含已提交與未提交變更、目標改過的檔名、兩邊都改過的檔案與 Git 預檢結果', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'source A\n')
    await save(f, f.source, 'shared.txt', 'source shared\n')
    await writeFile(join(f.source, 'draft.txt'), 'draft content\n')
    await save(f, f.target, 'main-only.txt', 'TARGET SECRET BODY\n')
    await save(f, f.target, 'shared.txt', 'target shared\n')
    const material = await f.snapshots.adviceMaterial(f.source, await targetHead(f), 'main', '接到最後面，合成一個提交')
    assert.match(material.text, /目標分支：main/)
    assert.match(material.text, /選擇：接到最後面，合成一個提交/)
    assert.match(material.text, /未提交的檔案 1 個（完成時會先一起提交）/)
    assert.match(material.text, /\+source A/)
    assert.match(material.text, /draft content/)
    assert.match(material.text, /main-only\.txt/)
    assert.match(material.text, /兩邊都改過的檔案：[^\n]*shared\.txt/)
    assert.match(material.text, /Git 預檢[^\n]*可能有衝突/)
    assert.doesNotMatch(material.text, /TARGET SECRET BODY/, '目標分支只送檔名，不送內容')
    assert.deepEqual([...material.files].sort(), ['a.txt', 'draft.txt', 'shared.txt'])
    // 確定的事實另外回傳給面板顯示，不只交給 AI 轉述。
    assert.deepEqual(material.facts, { conflict: true, overlap: ['shared.txt'] })
  } finally { await cleanup(f) }
})

test('M2 沒有衝突時寫明 Git 預檢可以自動合併', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'a\n')
    await save(f, f.target, 'b.txt', 'b\n')
    const material = await f.snapshots.adviceMaterial(f.source, await targetHead(f), 'main', '一般合併')
    assert.match(material.text, /Git 預檢[^\n]*可以自動合併/)
    assert.match(material.text, /兩邊都改過的檔案：無/)
    assert.deepEqual(material.facts, { conflict: false, overlap: [] })
  } finally { await cleanup(f) }
})

test('M3 已提交的變更刪掉共同起點裡的金鑰行時，刪除的那幾行也會擋下', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'config.txt', `key=${fakeKey()}\n`)
    await f.git(f.target, 'merge', '--ff-only', 'feature/test')
    await save(f, f.source, 'config.txt', 'key=removed\n')
    await assert.rejects(f.snapshots.adviceMaterial(f.source, await targetHead(f), 'main', '一般合併'), /機密|金鑰|私鑰/)
  } finally { await cleanup(f) }
})

test('M4 已提交的變更新增或刪除敏感檔都會擋下', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, '.env', 'TOKEN=abc\n')
    await assert.rejects(f.snapshots.adviceMaterial(f.source, await targetHead(f), 'main', '一般合併'), /敏感檔案/)
    await f.git(f.target, 'merge', '--ff-only', 'feature/test')
    await f.git(f.source, 'rm', '-q', '--', '.env')
    await f.git(f.source, 'commit', '-qm', 'remove env')
    await assert.rejects(f.snapshots.adviceMaterial(f.source, await targetHead(f), 'main', '一般合併'), /敏感檔案/)
  } finally { await cleanup(f) }
})

test('M5 沒有任何要合併的內容時說明不需要評估', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.snapshots.adviceMaterial(f.source, await targetHead(f), 'main', '一般合併'), /沒有要合併的內容/)
  } finally { await cleanup(f) }
})

test('M6 已提交的變更太大超過輸出上限時改送統計，不整個失敗', async () => {
  const f = await fixture()
  try {
    await save(f, f.source, 'a.txt', 'a\n')
    const calls: (readonly string[])[] = []
    const limited = new GitService(async (tool, args, options) => {
      calls.push(args)
      if (args.includes('diff') && args.includes('--no-color') && !args.some((arg) => arg.startsWith('--stat')) && !args.includes('--cached')
        && args.some((arg) => /^[0-9a-f]{40}$/.test(arg))) throw new Error('git 輸出超過上限，請縮小變更範圍。')
      return run(tool, args, options)
    })
    const material = await limited.adviceMaterial(f.source, await targetHead(f), 'main', '一般合併')
    assert.match(material.text, /變更太大，只傳送統計/)
    // 統計也不得觸發儲存庫設定的外部 diff 或 textconv 程式。
    assert.ok(calls.some((args) => args.some((arg) => arg.startsWith('--stat')) && args.includes('--no-ext-diff') && args.includes('--no-textconv')))
    assert.match(material.text, /a\.txt/)
    assert.equal(material.truncated, true)
  } finally { await cleanup(f) }
})
