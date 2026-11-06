import { read } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import type { Execution, HubAction } from './protocol'
import * as panel from './panel'
import { requests, workspaces } from './panel.check.ts'
import { cancelAdvice, previewAdvice, state, writeAdvice } from './panel-state'

function calls(host: ReturnType<typeof mockHost>, name: string) {
  return host.calls.filter((call) => call.method === 'plugin.request' && (call.params as { name?: string })?.name === name)
}

function adviceHost(answer: Execution = { message: '已取得建議。', advice: { level: '中', text: '兩邊都改過 src/login.ts。\n- 建議先找人看過',
  facts: { conflict: false, overlap: ['src/login.ts'] }, raised: false } }) {
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests,
    'hub.preview': (action) => {
      previews.push(action)
      return { token: `advice-${previews.length}`, title: '請 Claude 評估合併風險', summary: '', detail: '會傳送的內容：MATERIAL' }
    },
    'hub.execute': answer
  } })
  return { host, previews }
}

// 介面入口已移除，暫留的狀態流程仍須保護預覽、執行與選項失效邊界。
test('P1 建議狀態流程先取得預覽才可送出，回覆不改變收尾選項', async () => {
  const { host, previews } = adviceHost()
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.select({ label: '合併方式' }, 'rebase')
  await writeAdvice()
  assert.equal(calls(host, 'hub.execute').length, 0)
  await previewAdvice()
  assert.deepEqual(previews, [{ kind: 'finish-advice', workspaceId: workspaces[0].id, targetWorkspaceId: workspaces[1].id, strategy: 'rebase', squash: false }])
  assert.equal(calls(host, 'hub.execute').length, 0)
  assert.match(read(state.advicePreview)?.detail ?? '', /MATERIAL/)
  await writeAdvice()
  assert.deepEqual((calls(host, 'hub.execute')[0].params as { input: unknown }).input, { token: 'advice-1' })
  assert.equal(read(state.advicePreview), null)
  assert.match(read(state.advice)?.text ?? '', /兩邊都改過 src\/login\.ts/)
  assert.equal(view.valueOf({ label: '合併方式' }), 'rebase')
  assert.equal(view.valueOf({ label: '合成 1 個提交（Squash）' }), false)
  assert.equal(calls(host, 'hub.preview').length, 1)
  await view.unmount()
})

test('P2 取消會撤回尚未送出的請求；改合成選項會清掉舊建議，改清理選項不會', async () => {
  const { host } = adviceHost()
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await previewAdvice()
  cancelAdvice()
  assert.equal(read(state.advicePreview), null)
  await writeAdvice()
  assert.equal(calls(host, 'hub.execute').length, 0)
  await previewAdvice()
  await writeAdvice()
  const advice = read(state.advice)
  assert.ok(advice)
  await view.toggle({ label: '完成後移除資料夾' })
  assert.deepEqual(read(state.advice), advice, '改清理選項不影響建議')
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  assert.equal(read(state.advice), null)
  await view.unmount()
})

test('P3 建議送出失敗時清除舊預覽並允許重新取得預覽', async () => {
  const failing = mockHost({ requests: { ...requests,
    'hub.preview': { token: 'advice-x', title: '評估', summary: '', detail: 'MATERIAL' },
    'hub.execute': () => { throw new Error('Claude 無法完成這次請求。請先在終端執行 claude 確認已安裝並登入，再試一次。') }
  } })
  const view = await mount(panel, { host: failing })
  await view.press({ text: '完成這個工作' })
  await previewAdvice()
  await writeAdvice()
  assert.match(read(state.error), /請先在終端執行 claude/)
  assert.equal(read(state.advicePreview), null)
  assert.equal(read(state.adviceWriting), false)
  await previewAdvice()
  assert.ok(read(state.advicePreview))
  assert.equal(calls(failing, 'hub.preview').length, 2)
  assert.equal(calls(failing, 'hub.execute').length, 1)
  await view.unmount()
})
