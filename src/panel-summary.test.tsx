import { assert, mockHost, mount, test } from 'orca/testing'
import type { HubAction } from './protocol'
import * as panel from './panel'
import { expandFinishOptions, requests, snapshot, workspaces } from './panel.check.ts'

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
        await view.select({ label: '合併方式' }, strategy)
        await expandFinishOptions(view)
        if (squash) await view.toggle({ label: '合成 1 個提交（Squash）' })
        assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
        assert.equal(view.find({ text: '請 AI 幫我寫' }), null)
        assert.equal(view.find({ text: `預覽 ${strategy === 'merge' ? 'Merge' : 'Rebase'} 收尾` })?.disabled, false)
        await view.press({ text: `預覽 ${strategy === 'merge' ? 'Merge' : 'Rebase'} 收尾` })
        const message = !clean || squash ? '完成 feature/login' : ''
        assert.deepEqual(previews, [{ kind: 'finish', workspaceId: workspaces[0].id,
          targetWorkspaceId: workspaces[1].id, message, strategy, squash, remove: false }])
        assert.equal(view.find({ text: '提交訊息：完成 feature/login（自動產生）' }), null)
        await view.toggle({ label: '執行步驟與提交訊息' })
        assert.equal(Boolean(view.find({ text: '提交訊息：完成 feature/login（自動產生）' })), Boolean(message))
        assert.equal(host.calls.filter((call) => call.method === 'plugin.request'
          && (call.params as { name?: string }).name === 'hub.execute').length, 0)
        await view.unmount()
      })
    }
  }
}

test('清理須明確勾選，收合後與確認頁仍顯示精確路徑與保留分支提醒', async () => {
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests, 'hub.preview': (action) => {
    previews.push(action)
    return { token: 'cleanup', title: '完成工作', summary: '確認後合併', detail: '' }
  } } })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  assert.equal(view.find({ label: '完成後移除資料夾' }), null)
  assert.equal(view.find({ label: 'AI 風險建議' }), null)
  assert.equal(view.find({ text: '（可選）請 AI 評估合併風險' }), null)
  await expandFinishOptions(view)
  assert.equal(view.valueOf({ label: '完成後移除資料夾' }), false)
  await view.toggle({ label: '完成後移除資料夾' })
  await view.toggle({ label: '其他選項' })
  assert.equal(view.find({ label: '完成後移除資料夾' }), null)
  assert.ok(view.find({ type: 'Callout', label: '完成後移除這個工作資料夾' }))
  assert.ok(view.find({ text: workspaces[0].path }))
  assert.ok(view.find({ text: /清理檢查通過才移除，本機分支會保留/ }))
  await view.press({ text: '預覽 Merge 收尾' })
  assert.ok(view.find({ type: 'Callout', label: '完成後移除這個工作資料夾' }))
  assert.ok(view.find({ text: workspaces[0].path }))
  assert.equal(previews[0].kind === 'finish' && previews[0].remove, true)
  assert.equal(host.calls.filter((call) => call.method === 'plugin.request'
    && (call.params as { name?: string }).name === 'hub.execute').length, 0)
  await view.unmount()
})
