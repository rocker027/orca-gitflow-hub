import { assert, mockHost, mount, test, type TreeSnapshot } from 'orca/testing'
import { read } from 'orca'
import * as panel from './panel'
import { requests, snapshot, workspaces } from './panel.check.ts'
import { state } from './panel-state'

function calls(host: ReturnType<typeof mockHost>, name: string) {
  return host.calls.filter((call) => call.method === 'plugin.request' &&
    (call.params as { name?: string })?.name === name)
}

const longDiff = `diff --git a/example.ts b/example.ts\n${'+保留完整變更內容\n'.repeat(4_800)}LARGE_DIFF_TAIL`

function codeText(tree: TreeSnapshot | string | null): string[] {
  if (!tree || typeof tree === 'string') return []
  if (tree.type === 'Code') return [(tree.children ?? []).filter((child) => typeof child === 'string').join('')]
  return (tree.children ?? []).flatMap(codeText)
}

test('長收尾差異仍顯示確認頁並解除讀取，展開後可查看尾端內容', async () => {
  const host = mockHost({ requests: { ...requests,
    'hub.preview': { token: 'large-finish', title: '完成工作', summary: '確認後合併到 main。', detail: longDiff }
  } })
  const view = await mount(panel, { host })
  try {
    await view.press({ testId: `finish:${workspaces[0].id}` })
    await view.press({ text: /^預覽 (Merge|Rebase) 收尾$/ })
    assert.deepEqual(view.errors, [])
    assert.ok(view.find({ type: 'Card', label: '最後確認' }))
    assert.equal(view.find({ type: 'Spinner' }), null)
    assert.equal(read(state.busy), false)
    assert.equal(calls(host, 'hub.execute').length, 0)
    await view.toggle({ label: '技術細節' })
    assert.ok(view.find({ type: 'Code', text: /LARGE_DIFF_TAIL/ }))
    assert.equal(codeText(view.tree()).join(''), longDiff)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('極長差異明示節錄，保留完整預覽與原確認 token', async () => {
  const detail = `FULL_PREVIEW_START\n${'+完整來源\n'.repeat(20_000)}FULL_PREVIEW_END`
  const host = mockHost({ requests: { ...requests,
    'hub.preview': { token: 'unmodified-preview-token', title: '完成工作', summary: '確認後合併到 main。', detail },
    'hub.execute': { status: 'completed', message: '已完成合併。' }
  } })
  const view = await mount(panel, { host })
  try {
    await view.press({ testId: `finish:${workspaces[0].id}` })
    await view.press({ text: /^預覽 (Merge|Rebase) 收尾$/ })
    assert.deepEqual(view.errors, [])
    assert.equal(read(state.preview)?.detail, detail)
    assert.equal(read(state.preview)?.token, 'unmodified-preview-token')
    assert.equal(calls(host, 'hub.execute').length, 0)
    await view.toggle({ label: '技術細節' })
    assert.ok(view.find({ text: /內容較長/ }))
    assert.ok(view.find({ text: /版本控制/ }))
    const shown = codeText(view.tree()).join('')
    assert.ok(shown.startsWith('FULL_PREVIEW_START'))
    assert.ok(detail.startsWith(shown))
    assert.ok(shown.length > 16_384 && shown.length < detail.length)
    assert.equal(shown.includes('FULL_PREVIEW_END'), false)
    assert.ok(codeText(view.tree()).every((entry) => entry.length <= 16_384))
    assert.deepEqual(view.errors, [])
    await view.press({ text: /^確認 (Merge|Rebase) 到 / })
    assert.deepEqual((calls(host, 'hub.execute')[0].params as { input: unknown }).input,
      { token: 'unmodified-preview-token' })
  } finally { await view.unmount() }
})

test('長工作目錄與暫存差異不拖垮收尾頁，全部檔案與差異仍送交預檢', async () => {
  const stagedDiff = `${longDiff}\nSTAGED_DIFF_TAIL`
  const files = [...snapshot.files, { path: 'staged.ts', index: 'M', working: ' ' }]
  const host = mockHost({ requests: { ...requests,
    'hub.inspect': { ...snapshot, files, workingDiff: longDiff, stagedDiff },
    'hub.preview': { token: 'large-finish', title: '完成工作', summary: '確認後才會合併。', detail: longDiff }
  } })
  const view = await mount(panel, { host })
  try {
    await view.press({ testId: `finish:${workspaces[0].id}` })
    assert.deepEqual(view.errors, [])
    assert.equal(read(state.snapshot)?.workingDiff, longDiff)
    assert.equal(read(state.snapshot)?.stagedDiff, stagedDiff)
    assert.ok(view.find({ text: '會先提交全部 3 個變更檔案' }))
    assert.ok(view.find({ text: /包含已暫存、未暫存及新增檔案/ }))
    assert.ok(view.find({ text: /若要分批提交，請先在 Orca 版本控制處理/ }))
    assert.equal(view.find({ text: 'staged.ts' }), null)
    assert.equal(view.find({ type: 'Code' }), null)
    await view.toggle({ label: '收尾時提交 3 個檔案' })
    for (const file of files) assert.ok(view.find({ text: file.path }))
    await view.press({ text: '預覽 Merge 收尾' })
    assert.ok(view.find({ type: 'Card', label: '最後確認' }))
    await view.toggle({ label: '技術細節' })
    assert.ok(view.find({ type: 'Code', text: /LARGE_DIFF_TAIL/ }))
    assert.equal(view.find({ type: 'Spinner' }), null)
    assert.equal(calls(host, 'hub.execute').length, 0)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
