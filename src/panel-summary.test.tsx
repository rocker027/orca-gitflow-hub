import { assert, mockHost, mount, test } from 'orca/testing'
import type { HubAction } from './protocol'
import * as panel from './panel'
import { requests, snapshot, workspaces } from './panel.check.ts'

for (const clean of [false, true]) {
  for (const strategy of ['merge', 'rebase'] as const) {
    for (const squash of [false, true]) {
      test(`${clean ? '乾淨' : '有變更'}來源使用 ${strategy}、${squash ? 'Squash' : '保留提交'} 時不必填寫完成說明`, async () => {
        const previews: HubAction[] = []
        const host = mockHost({ requests: { ...requests,
          ...(clean ? { 'hub.inspect': { ...snapshot, files: [], workingDiff: '' } } : {}),
          'hub.preview': (action) => {
            previews.push(action)
            return { token: 'finish', title: '完成工作', summary: '確認後合併', detail: '' }
          }
        } })
        const view = await mount(panel, { host })
        await view.press({ testId: `finish:${workspaces[0].id}` })
        await view.select({ label: '2. 怎麼合併' }, strategy)
        await view.select({ label: '3. 要不要把提交合成一個' }, squash ? 'squash' : 'keep')
        assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
        assert.equal(view.find({ text: '請 AI 幫我寫' }), null)
        assert.equal(view.find({ text: '下一步：確認' })?.disabled, false)
        await view.press({ text: '下一步：確認' })
        const message = !clean || squash ? '完成 feature/login' : ''
        assert.deepEqual(previews, [{ kind: 'finish', workspaceId: workspaces[0].id,
          targetWorkspaceId: workspaces[1].id, message, strategy, squash, remove: true }])
        assert.equal(Boolean(view.find({ text: '提交訊息：完成 feature/login（自動產生）' })), Boolean(message))
        assert.equal(host.calls.filter((call) => call.method === 'plugin.request'
          && (call.params as { name?: string }).name === 'hub.execute').length, 0)
        await view.unmount()
      })
    }
  }
}

test('其他選項預設收起，仍說明清理後果；展開後可以保留工作資料夾', async () => {
  const host = mockHost({ requests })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  assert.equal(view.find({ label: '完成後移除這個工作資料夾' }), null)
  assert.equal(view.find({ text: '（可選）請 AI 評估合併風險' }), null)
  assert.ok(view.find({ text: '完成後移除工作資料夾，分支保留。可在「其他選項」改成保留資料夾。' }))
  await view.toggle({ label: '其他選項' })
  assert.equal(view.valueOf({ label: '完成後移除這個工作資料夾' }), true)
  assert.ok(view.find({ text: '（可選）請 AI 評估合併風險' }))
  assert.equal(view.find({ text: '請 AI 幫我寫' }), null)
  await view.toggle({ label: '完成後移除這個工作資料夾' })
  assert.ok(view.find({ text: '完成後保留工作資料夾與分支。' }))
  await view.unmount()
})
