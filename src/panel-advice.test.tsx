import { assert, mockHost, mount, test } from 'orca/testing'
import type { Execution, HubAction } from './protocol'
import * as panel from './panel'
import { requests, workspaces } from './panel.check.ts'

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

async function openFinish(view: Awaited<ReturnType<typeof mount>>) {
  await view.press({ text: '完成這個工作' })
  await view.toggle({ label: '其他選項' })
}

test('P1 先說明要傳送的內容並取得同意才送出；結果標示僅供參考，不改變使用者的選擇', async () => {
  const { host, previews } = adviceHost()
  const view = await mount(panel, { host })
  await openFinish(view)
  await view.select({ label: '2. 怎麼合併' }, 'rebase')
  await view.press({ text: '（可選）請 AI 評估合併風險' })
  assert.deepEqual(previews, [{ kind: 'finish-advice', workspaceId: workspaces[0].id, targetWorkspaceId: workspaces[1].id, strategy: 'rebase', squash: false }])
  assert.equal(calls(host, 'hub.execute').length, 0)
  assert.ok(view.find({ type: 'Callout', label: '要把變更傳給 Claude 評估嗎？' }))
  await view.toggle({ label: '查看會傳送的內容' })
  assert.ok(view.find({ text: /MATERIAL/ }))
  await view.press({ text: '確認傳送給 Claude' })
  assert.deepEqual((calls(host, 'hub.execute')[0].params as { input: unknown }).input, { token: 'advice-1' })
  const result = view.find({ type: 'Callout', label: 'AI 合併建議：風險中' })
  assert.ok(result)
  assert.match(result.text, /兩邊都改過 src\/login\.ts/)
  assert.match(result.text, /僅供參考，AI 可能判斷錯誤。按「下一步：確認」只會先顯示確認頁；真的有衝突時，外掛會停下來，不會改動 main。/)
  assert.ok(view.find({ type: 'Text', text: 'Git 檢查：可以自動合併（只看已提交的內容）；兩邊都改過：src/login.ts' }))
  assert.equal(result.props.tone, 'accent')
  // Orca 的 Text 不保留換行；每一行要各自成為一行文字，條列才不會擠成一段。
  assert.ok(view.find({ type: 'Text', text: '- 建議先找人看過' }))
  assert.ok(view.find({ type: 'Text', text: '兩邊都改過 src/login.ts。' }))
  assert.equal(view.valueOf({ label: '2. 怎麼合併' }), 'rebase')
  assert.equal(view.valueOf({ label: '3. 要不要把提交合成一個' }), 'keep')
  assert.equal(calls(host, 'hub.preview').length, 1)
  await view.unmount()
})

test('P2 取消會撤回尚未送出的請求；改合成選項會清掉舊建議，改清理選項不會', async () => {
  const { host } = adviceHost()
  const view = await mount(panel, { host })
  await openFinish(view)
  await view.press({ text: '（可選）請 AI 評估合併風險' })
  await view.press({ text: '取消' })
  assert.equal(view.find({ type: 'Callout', label: '要把變更傳給 Claude 評估嗎？' }), null)
  assert.equal(calls(host, 'hub.execute').length, 0)
  await view.press({ text: '（可選）請 AI 評估合併風險' })
  await view.press({ text: '確認傳送給 Claude' })
  assert.ok(view.find({ type: 'Callout', label: 'AI 合併建議：風險中' }))
  await view.toggle({ label: '完成後移除這個工作資料夾' })
  assert.ok(view.find({ type: 'Callout', label: 'AI 合併建議：風險中' }), '改清理選項不影響建議')
  await view.select({ label: '3. 要不要把提交合成一個' }, 'squash')
  assert.equal(view.find({ type: 'Callout', label: 'AI 合併建議：風險中' }), null)
  assert.ok(view.find({ text: '（可選）請 AI 評估合併風險' }))
  await view.unmount()
})

test('P3 等級不明時用中性樣式並提醒自行判斷；送出失敗時顯示原因並可重試', async () => {
  const unknown = adviceHost({ message: '已取得建議。', advice: { level: '未知', text: '我覺得可以合併', facts: { conflict: false, overlap: [] }, raised: false } })
  const view = await mount(panel, { host: unknown.host })
  await openFinish(view)
  await view.press({ text: '（可選）請 AI 評估合併風險' })
  await view.press({ text: '確認傳送給 Claude' })
  const result = view.find({ type: 'Callout', label: 'AI 合併建議：無法判斷風險' })
  assert.ok(result)
  assert.equal(result.props.tone, 'neutral')
  await view.unmount()
  const failing = mockHost({ requests: { ...requests,
    'hub.preview': { token: 'advice-x', title: '評估', summary: '', detail: 'MATERIAL' },
    'hub.execute': () => { throw new Error('Claude 無法完成這次請求。請先在終端執行 claude 確認已安裝並登入，再試一次。') }
  } })
  const second = await mount(panel, { host: failing })
  await openFinish(second)
  await second.press({ text: '（可選）請 AI 評估合併風險' })
  await second.press({ text: '確認傳送給 Claude' })
  assert.ok(second.find({ text: /請先在終端執行 claude/ }))
  assert.ok(second.find({ text: '（可選）請 AI 評估合併風險' }))
  await second.unmount()
})

test('P4 Git 檢查有衝突而調高等級時標示原因，風險高用警告色而不是錯誤色', async () => {
  const { host } = adviceHost({ message: '已取得建議。', advice: { level: '高', text: '可以合併。', facts: { conflict: true, overlap: ['a.txt'] }, raised: true } })
  const view = await mount(panel, { host })
  await openFinish(view)
  await view.press({ text: '（可選）請 AI 評估合併風險' })
  await view.press({ text: '確認傳送給 Claude' })
  const result = view.find({ type: 'Callout', label: 'AI 合併建議：風險高（依 Git 檢查調高）' })
  assert.ok(result)
  assert.equal(result.props.tone, 'warning')
  assert.ok(view.find({ type: 'Text', text: 'Git 檢查：可能有衝突（只看已提交的內容）；兩邊都改過：a.txt' }))
  await view.unmount()
})
