import { read } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import type { Execution, HubAction } from './protocol'
import * as panel from './panel'
import { requests, workspaces } from './panel.check.ts'
import { state } from './panel-state'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function summaryHost(execute: () => Execution | Promise<Execution> = () => ({ message: '已填入 Claude 寫的說明。', draft: 'feat: Claude 寫的說明' })) {
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests,
    'hub.preview': (action) => {
      previews.push(action)
      return { token: `token-${previews.length}`, title: '請 Claude 撰寫完成說明', summary: 'a', detail: '確認後會傳給 Claude（Anthropic 的 AI 服務）。\n\nMATERIAL' }
    },
    'hub.execute': execute
  } })
  const executes = () => host.calls.filter((call) => call.method === 'plugin.request'
    && (call.params as { name?: string }).name === 'hub.execute')
  return { host, previews, executes }
}

async function openFinish(view: Awaited<ReturnType<typeof mount>>) {
  await view.press({ testId: `finish:${workspaces[0].id}` })
}

// U1：把變更傳給外部 AI 前，一定要先說明並取得確認；完成後只填欄位，不自動合併。
test('AI 說明先確認才傳送，完成後填入欄位並停留在合併頁', async () => {
  const f = summaryHost()
  const view = await mount(panel, { host: f.host })
  await openFinish(view)
  await view.press({ text: '請 AI 幫我寫' })
  assert.deepEqual(f.previews, [{ kind: 'finish-summary', workspaceId: workspaces[0].id }])
  assert.equal(f.executes().length, 0)
  assert.ok(view.find({ text: /Anthropic/ }))
  await view.toggle({ label: '查看會傳送的內容' })
  assert.ok(view.find({ text: /MATERIAL/ }))
  await view.press({ text: '確認傳送給 Claude' })
  assert.equal(f.executes().length, 1)
  assert.deepEqual((f.executes()[0].params as { input: unknown }).input, { token: 'token-1' })
  assert.equal(view.valueOf({ label: '2. 這次完成了什麼' }), 'feat: Claude 寫的說明')
  assert.ok(view.find({ text: '下一步：確認合併內容' }))
  assert.equal(view.find({ text: '確認合併' }), null)
  assert.equal(f.previews.length, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('取消或自行修改說明會撤回尚未確認的傳送', async () => {
  const f = summaryHost()
  const view = await mount(panel, { host: f.host })
  await openFinish(view)
  await view.press({ text: '請 AI 幫我寫' })
  await view.press({ text: '取消' })
  assert.equal(view.find({ text: '確認傳送給 Claude' }), null)
  await view.press({ text: '請 AI 幫我寫' })
  await view.type({ label: '2. 這次完成了什麼' }, '我自己寫')
  assert.equal(view.find({ text: '確認傳送給 Claude' }), null)
  assert.equal(f.executes().length, 0)
  assert.equal(view.valueOf({ label: '2. 這次完成了什麼' }), '我自己寫')
  await view.unmount()
})

test('Claude 失敗時顯示原因，保留原說明並可再試一次', async () => {
  const f = summaryHost(() => { throw new Error('Claude 無法產生說明。請先在終端執行 claude 確認已安裝並登入，再試一次。') })
  const view = await mount(panel, { host: f.host })
  await openFinish(view)
  await view.type({ label: '2. 這次完成了什麼' }, '原本的說明')
  await view.press({ text: '請 AI 幫我寫' })
  await view.press({ text: '確認傳送給 Claude' })
  assert.ok(view.find({ text: /請先在終端執行 claude/ }))
  assert.equal(view.valueOf({ label: '2. 這次完成了什麼' }), '原本的說明')
  assert.ok(view.find({ text: '請 AI 幫我寫' }))
  assert.equal(view.find({ text: '確認傳送給 Claude' }), null)
  await view.unmount()
})

test('撰寫期間鎖定表單並顯示進度，重複點擊不會再次傳送', async () => {
  const pending = deferred<Execution>()
  const started = deferred<void>()
  const f = summaryHost(() => { started.resolve(); return pending.promise })
  const view = await mount(panel, { host: f.host })
  await openFinish(view)
  await view.press({ text: '請 AI 幫我寫' })
  const writing = view.press({ text: '確認傳送給 Claude' })
  await started.promise
  // 點擊後的畫面在下一個 task 才更新。
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(view.find({ text: /Claude 正在撰寫說明/ }))
  assert.equal(view.find({ label: '2. 這次完成了什麼' })?.disabled, true)
  assert.equal(view.find({ text: '下一步：確認合併內容' })?.disabled, true)
  assert.equal(view.find({ text: '請 AI 幫我寫' }), null)
  pending.resolve({ message: '已填入。', draft: '完成說明' })
  await writing
  assert.equal(f.executes().length, 1)
  assert.equal(read(state.finishMessage), '完成說明')
  await view.unmount()
})
