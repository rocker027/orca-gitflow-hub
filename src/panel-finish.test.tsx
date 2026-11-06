import { assert, mockHost, mount, test } from 'orca/testing'
import type { HubAction, Preview } from './protocol'
import * as panel from './panel'
import { dashboardFor, requests, snapshot, workspaces } from './panel.check.ts'

function calls(host: ReturnType<typeof mockHost>, name: string) {
  return host.calls.filter((call) => call.method === 'plugin.request' &&
    (call.params as { name?: string })?.name === name)
}

function finishHost(options: { clean?: boolean; preview?: Partial<Preview> } = {}) {
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests,
    ...(options.clean ? { 'hub.inspect': { ...snapshot, files: [], workingDiff: '' } } : {}),
    'hub.preview': (action) => {
      previews.push(action)
      return { token: `token-${previews.length}`, title: '完成工作', summary: '把 feature/login 合併到 main。', detail: '技術細節內容',
        steps: ['提交全部 2 個檔案的變更', '切換到 main'], ...options.preview }
    },
    'hub.execute': { status: 'completed', message: '完成了！已合併到 main。',
      steps: [{ id: 'merge', label: '合併到 main', status: 'done', detail: 'main · abc123' }] }
  } })
  return { host, previews }
}

test('首頁直接顯示目前工作與收尾主按鈕，分開說明未提交與待合併狀態', async () => {
  const { host } = finishHost()
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '目前工作' }))
  assert.ok(view.find({ text: '登入功能' }))
  assert.ok(view.find({ text: '2 個檔案未提交' }))
  assert.ok(view.find({ text: '2 個提交待合併至 main' }))
  assert.equal(view.find({ testId: `finish:${workspaces[0].id}` })?.text, '完成這個工作')
  // 每個畫面的主要動作用實心按鈕，其餘用外框或文字按鈕。
  assert.equal(view.find({ testId: `finish:${workspaces[0].id}` })?.props.variant, 'solid')
  assert.equal(view.find({ testId: `open:${workspaces[0].id}` }), null)
  await view.press({ text: '完成這個工作' })
  assert.ok(view.find({ type: 'Heading', text: '完成工作' }))
  assert.ok(view.find({ text: 'feature/login' }))
  assert.equal(calls(host, 'hub.preview').length, 0)
  await view.unmount()
})

test('目前在主要分支時，首頁引導開始新工作，不提供完成按鈕', async () => {
  const onMain = workspaces.map((workspace) => ({ ...workspace, isActive: workspace.id === workspaces[1].id }))
  const host = mockHost({ requests: { ...requests,
    'hub.list': { workspaces: onMain, warnings: [] },
    'hub.dashboard': { ...dashboardFor(), workspaces: onMain, activeWorkspaceId: workspaces[1].id }
  } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '目前在主要分支' }))
  assert.equal(view.find({ text: '目前工作' }), null)
  assert.equal(view.find({ testId: `finish:${workspaces[1].id}` }), null)
  assert.equal(view.find({ text: '開始新工作' })?.props.variant, 'solid')
  assert.ok(view.find({ testId: `finish:${workspaces[0].id}` }))
  await view.unmount()
})

test('收尾頁預設一般合併、保留每個提交，說明文字隨選項改變', async () => {
  const { host } = finishHost()
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  assert.equal(view.valueOf({ label: '合併方式' }), 'merge')
  assert.equal(view.valueOf({ label: '合成 1 個提交（Squash）' }), false)
  const strategy = view.find({ label: '合併方式' })?.props.options as { value: string; label: string; description?: string }[]
  assert.deepEqual(strategy.map(({ value, label }) => ({ value, label })), [
    { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }
  ])
  assert.ok(view.find({ text: '保留分支紀錄（預設）。' }))
  await view.select({ label: '合併方式' }, 'rebase')
  assert.equal(view.valueOf({ label: '合併方式' }), 'rebase')
  assert.ok(view.find({ text: '將提交接到目標分支的最新進度後。' }))
  assert.equal(view.find({ text: '保留分支紀錄（預設）。' }), null)
  assert.ok(view.find({ text: /提交編號可能改變/ }))
  await view.select({ label: '合併方式' }, 'merge')
  assert.equal(view.find({ text: /提交編號可能改變/ }), null)
  assert.ok(view.find({ text: '先檢查，確認後才會合併。' }))
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  assert.equal(view.valueOf({ label: '合成 1 個提交（Squash）' }), true)
  assert.ok(view.find({ text: '目標有新進度時，可能再多 1 個合併提交。' }))
  await view.unmount()
})

test('沒有未提交變更時選合成一個，自動產生訊息即可進下一步', async () => {
  const { host, previews } = finishHost({ clean: true })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  assert.equal(view.find({ text: '請 AI 幫我寫' }), null)
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  assert.equal(view.find({ text: '請 AI 幫我寫' }), null)
  assert.equal(view.find({ text: '下一步：確認' })?.disabled, false)
  assert.equal(view.find({ text: '請填寫「這次完成了什麼」。' }), null)
  await view.press({ text: '下一步：確認' })
  assert.deepEqual(previews, [{ kind: 'finish', workspaceId: workspaces[0].id, targetWorkspaceId: workspaces[1].id,
    message: '完成 feature/login', remove: true, strategy: 'merge', squash: true }])
  await view.unmount()
})

test('改回保留每個提交且沒有變更時，不再送出說明', async () => {
  const { host, previews } = finishHost({ clean: true })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  await view.press({ text: '下一步：確認' })
  assert.equal(previews[0].kind === 'finish' && previews[0].message, '')
  await view.unmount()
})

test('確認頁顯示結果與提醒，步驟和技術細節按需展開', async () => {
  const { host } = finishHost({ preview: {
    summary: '把 feature/login 合併到 main。main 會接上這個工作的 1 個提交，紀錄是一直線。',
    warnings: [{ title: '提交編號會改變', text: '這個工作的提交會合成一個，編號會變，內容不會遺失。' }],
    steps: ['提交全部 2 個檔案的變更', '把 3 個提交合成 1 個', '把提交搬到 main 最新進度後面（rebase）'] } })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.select({ label: '合併方式' }, 'rebase')
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  await view.press({ text: '下一步：確認' })
  assert.equal(view.findAll({ type: 'Card' })[0]?.label, '最後確認')
  assert.ok(view.find({ type: 'Callout', label: '完成後會變成這樣' }))
  assert.ok(view.find({ type: 'Callout', label: '提交編號會改變', text: /內容不會遺失/ }))
  assert.equal(view.find({ text: '2. 把 3 個提交合成 1 個' }), null)
  await view.toggle({ label: '執行步驟與提交訊息' })
  assert.ok(view.find({ text: '2. 把 3 個提交合成 1 個' }))
  assert.ok(view.find({ text: '3. 把提交搬到 main 最新進度後面（rebase）' }))
  assert.equal(view.find({ text: '技術細節內容' }), null)
  await view.toggle({ label: '技術細節' })
  assert.ok(view.find({ text: '技術細節內容' }))
  await view.press({ text: '確認，開始合併' })
  assert.deepEqual((calls(host, 'hub.execute')[0].params as { input: unknown }).input, { token: 'token-1' })
  assert.ok(view.find({ label: '完成了' }))
  assert.equal(view.find({ text: 'main · abc123' }), null)
  await view.toggle({ label: '執行明細' })
  assert.ok(view.find({ text: 'main · abc123' }))
  await view.unmount()
})

test('從確認頁返回修改後改變合併方式，舊確認不能再執行', async () => {
  const { host, previews } = finishHost()
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.press({ text: '下一步：確認' })
  await view.press({ text: '返回修改' })
  await view.select({ label: '合併方式' }, 'rebase')
  assert.equal(view.find({ text: '確認，開始合併' }), null)
  await view.press({ text: '下一步：確認' })
  await view.press({ text: '確認，開始合併' })
  assert.deepEqual(previews.map((action) => action.kind === 'finish' && action.strategy), ['merge', 'rebase'])
  assert.deepEqual(calls(host, 'hub.execute').map((call) => (call.params as { input: unknown }).input), [{ token: 'token-2' }])
  await view.unmount()
})

test('選了合成一個但仍是一般合併時，一鍵改用 Rebase', async () => {
  const { host } = finishHost()
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  assert.equal(view.find({ text: '改用 Rebase' }), null)
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  await view.press({ text: '改用 Rebase' })
  assert.equal(view.valueOf({ label: '合併方式' }), 'rebase')
  assert.equal(view.valueOf({ label: '合成 1 個提交（Squash）' }), true)
  assert.equal(view.find({ text: '改用 Rebase' }), null)
  await view.unmount()
})

test('確認頁提醒 main 會多出 2 個提交時，一鍵改用接到最後面並重新產生確認頁', async () => {
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests,
    'hub.preview': (action) => {
      previews.push(action)
      const twoCommits = action.kind === 'finish' && action.squash && action.strategy === 'merge'
      return { token: `token-${previews.length}`, title: '完成工作', summary: twoCommits ? 'main 會多 2 個提交。' : 'main 只多 1 個提交。', detail: '',
        steps: ['提交全部 2 個檔案的變更'], warnings: twoCommits
          ? [{ title: 'main 會多出 2 個提交（不是錯誤）', tone: 'accent', text: '要讓 main 只多 1 個，請按下方按鈕。', fix: 'rebase' }] : [] }
    },
    'hub.execute': { status: 'completed', message: '完成了！' }
  } })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  await view.press({ text: '下一步：確認' })
  assert.ok(view.find({ type: 'Callout', label: '完成後會變成這樣', text: /main 會多 2 個提交。/ }))
  await view.press({ text: '改成讓 main 只多 1 個提交' })
  assert.equal(view.findAll({ type: 'Card' })[0]?.label, '最後確認')
  assert.ok(view.find({ type: 'Callout', label: '完成後會變成這樣', text: /main 只多 1 個提交。/ }))
  assert.equal(view.find({ text: '改成讓 main 只多 1 個提交' }), null)
  assert.deepEqual(previews.map((action) => action.kind === 'finish' && [action.strategy, action.squash, action.message]),
    [['merge', true, '完成 feature/login'], ['rebase', true, '完成 feature/login']])
  await view.press({ text: '確認，開始合併' })
  assert.deepEqual(calls(host, 'hub.execute').map((call) => (call.params as { input: unknown }).input), [{ token: 'token-2' }])
  await view.unmount()
})

test('執行期間保留確認頁並說明正在進行，不退回收尾表單', async () => {
  let release!: () => void
  const finished = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const running = new Promise<void>((resolve) => { started = resolve })
  const host = mockHost({ requests: { ...requests,
    'hub.preview': { token: 'run', title: '完成工作', summary: '把 feature/login 合併到 main。', detail: '', steps: ['提交全部 2 個檔案的變更', '切換到 main'] },
    'hub.execute': async () => { started(); await finished; return { status: 'completed', message: '完成了！' } }
  } })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.press({ text: '下一步：確認' })
  const pressing = view.press({ text: '確認，開始合併' })
  await running
  // 宿主收到請求時面板可能尚未重繪，等畫面更新後再檢查。
  for (let round = 0; round < 50 && !view.find({ text: '正在合併，請勿關閉 Orca。' }); round++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(view.findAll({ type: 'Card' })[0]?.label, '最後確認')
  assert.ok(view.find({ text: '正在合併，請勿關閉 Orca。' }))
  assert.equal(view.find({ label: '合併方式' }), null)
  assert.equal(view.find({ text: '返回修改' }), null)
  release()
  await pressing
  assert.ok(view.find({ label: '完成了' }))
  assert.equal(view.find({ text: '正在合併，請勿關閉 Orca。' }), null)
  await view.unmount()
})

test('收尾一完成就顯示結果，不等清單重新整理', async () => {
  let reads = 0
  let releaseDashboard!: () => void
  const dashboardHeld = new Promise<void>((resolve) => { releaseDashboard = resolve })
  const host = mockHost({ requests: { ...requests,
    'hub.dashboard': async ({ repoId }: { repoId?: string }) => {
      if (reads++ > 0) await dashboardHeld
      return dashboardFor(repoId)
    },
    'hub.preview': { token: 'done', title: '完成工作', summary: '把 feature/login 合併到 main。', detail: '', steps: ['切換到 main'] },
    'hub.execute': { status: 'completed', workspaceId: workspaces[1].id, message: '完成了！已合併到這台電腦的 main。' }
  } })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.press({ text: '下一步：確認' })
  const pressing = view.press({ text: '確認，開始合併' })
  for (let round = 0; round < 100 && !view.find({ label: '完成了' }); round++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(view.find({ label: '完成了' }), '重新整理期間就應看到結果')
  assert.equal(view.find({ label: '最後確認' }), null)
  assert.ok(view.find({ type: 'Spinner', label: '已完成，正在更新畫面…' }))
  assert.ok(view.find({ type: 'Callout', label: '已完成' }))
  releaseDashboard()
  await pressing
  assert.ok(view.find({ label: '完成了' }))
  await view.unmount()
})

test('部分完成時不說已完成，失敗步驟不重複上方已寫的整段說明', async () => {
  const conflict = 'main 沒有被改動，你的改動都還在。有衝突，無法自動合併。原因：main 和這個工作都改過 a.txt。'
  let reads = 0
  let releaseDashboard!: () => void
  const dashboardHeld = new Promise<void>((resolve) => { releaseDashboard = resolve })
  const host = mockHost({ requests: { ...requests,
    'hub.dashboard': async ({ repoId }: { repoId?: string }) => { if (reads++ > 0) await dashboardHeld; return dashboardFor(repoId) },
    'hub.preview': { token: 'conflict', title: '完成工作', summary: '把 feature/login 合併到 main。', detail: '', steps: ['切換到 main'] },
    'hub.execute': { status: 'needs_attention', workspaceId: workspaces[0].id, message: `收尾已停止。${conflict}`, steps: [
      { id: 'commit', label: '提交變更', status: 'done', detail: 'abc123' },
      { id: 'rebase', label: '搬到 main 最新進度後面', status: 'failed', detail: conflict },
      { id: 'merge', label: '合併到 main', status: 'skipped', detail: '尚未執行' }] }
  } })
  const view = await mount(panel, { host })
  await view.press({ text: '完成這個工作' })
  await view.press({ text: '下一步：確認' })
  const pressing = view.press({ text: '確認，開始合併' })
  for (let round = 0; round < 100 && !view.find({ label: '還沒全部完成' }); round++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(view.find({ type: 'Spinner', label: '正在更新畫面…' }))
  assert.equal(view.find({ type: 'Spinner', label: /已完成/ }), null)
  releaseDashboard()
  await pressing
  assert.equal(view.findAll({ text: conflict }).length, 0, '失敗步驟下方不應再印一次整段說明')
  assert.ok(view.find({ type: 'Callout', label: '需要處理', text: /原因：main 和這個工作都改過 a\.txt/ }))
  assert.ok(view.find({ text: 'abc123' }))
  // 結束後不再鎖住畫面：可以隱藏結果、重新整理、開啟資料夾或再做一次。
  assert.equal(view.find({ label: '重新整理' })?.disabled, false, '重新整理應可按')
  for (const text of ['隱藏結果', '開啟「登入功能」資料夾', '完成這個工作']) {
    assert.equal(view.find({ text })?.disabled, false, `${text} 應可按`)
  }
  await view.press({ text: '隱藏結果' })
  assert.equal(view.find({ label: '還沒全部完成' }), null)
  await view.unmount()
})
