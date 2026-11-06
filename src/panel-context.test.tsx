import { read } from 'orca'
import { assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { GitSnapshot, Workspace } from './contracts'
import type { Dashboard, Execution, HubAction, HubList, Preview } from './protocol'
import * as panel from './panel'
import { expandFinishOptions, requests, snapshot, workspaces } from './panel.check.ts'
import { previewAdvice, state, writeAdvice } from './panel-state'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

// 舊回覆必須在新切換「已套用」後才回來，才能驗到序號防護；先回來的舊回覆會被後續切換蓋掉而假通過。
async function until(condition: () => boolean) {
  for (let round = 0; round < 200 && !condition(); round++) await tick()
  assert.ok(condition(), '等待的面板狀態沒有出現')
}

const switchedTo = (repoId: string) => () => read(state.repoId) === repoId && Boolean(read(state.dashboard)) && !read(state.busy)

const partialOutcome = (): Execution => ({ status: 'needs_attention', workspaceId: workspaces[1].id, message: '已合併，但來源保留。',
  steps: [{ id: 'cleanup', label: '清理', status: 'failed', detail: '來源有新變更' }] })

function fixture(rows: Workspace[] = workspaces) {
  let activeId: string | null = rows.find((workspace) => workspace.isActive)?.id ?? null
  const overrides: {
    list?: () => HubList | Promise<HubList>
    inspect?: (id: string) => GitSnapshot | Promise<GitSnapshot>
    preview?: (action: HubAction) => Preview | Promise<Preview>
    execute?: () => Execution | Promise<Execution>
  } = {}
  const listing = (): HubList => ({
    workspaces: rows.map((workspace) => ({ ...workspace, isActive: workspace.id === activeId })), warnings: []
  })
  const dashboard = (requested?: string): Dashboard => {
    const list = listing()
    const active = list.workspaces.find((workspace) => workspace.isActive)
    const repoId = requested ?? active?.repoId ?? list.workspaces[0]?.repoId ?? ''
    const sameRepo = list.workspaces.filter((workspace) => workspace.repoId === repoId)
    const target = sameRepo.find((workspace) => workspace.isDefaultBranch) ?? sameRepo[0]
    return { ...list, repoId, activeWorkspaceId: active?.repoId === repoId ? active.id : target?.id,
      defaultTargetId: target?.id,
      summaries: sameRepo.map((workspace) => ({ workspaceId: workspace.id, branch: workspace.branch,
        head: workspace.head, changedFiles: workspace.isMainWorktree ? 0 : 2, ahead: 0, behind: 0, lastMessage: '測試提交' })) }
  }
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests,
    'hub.list': () => overrides.list ? overrides.list() : listing(),
    'hub.dashboard': ({ repoId }) => dashboard(repoId),
    'hub.inspect': ({ workspaceId }) => overrides.inspect ? overrides.inspect(workspaceId)
      : { ...snapshot, branch: rows.find((workspace) => workspace.id === workspaceId)?.branch ?? '' },
    'hub.preview': (action) => {
      previews.push(action)
      return overrides.preview ? overrides.preview(action) : { token: 'context-token', title: '預覽', summary: '確認後執行', detail: '' }
    },
    'hub.execute': () => overrides.execute ? overrides.execute() : { message: '工作已完成', status: 'completed' }
  } })
  const calls = (name: string) => host.calls.filter((call) => call.method === 'plugin.request'
    && (call.params as { name?: string }).name === name)
  const emit = (view: TestPanel, terminals: { id: string; title?: string }[] = []) => {
    const active = rows.find((workspace) => workspace.id === activeId)
    return view.emit('workspace.changed', { context: active ? {
      branch: active.branch, displayName: active.displayName, terminals
    } : null })
  }
  return { host, overrides, listing, calls, emit, previews, activate: (id: string | null) => { activeId = id } }
}

async function finishPreview(view: TestPanel) {
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.press({ text: /^預覽 (Merge|Rebase) 收尾$/ })
}

test('同專案切換工作樹會更新目前標記與下一次建立的來源', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  f.activate(workspaces[1].id)
  await f.emit(view)
  assert.ok(view.find({ text: '目前在主要分支' }))
  assert.equal(view.find({ text: '目前工作' }), null)
  assert.ok(view.find({ testId: `finish:${workspaces[0].id}` }))
  await view.press({ text: '開始新工作' })
  await view.type({ label: '工作名稱' }, '新工作')
  await view.press({ text: '建立並開啟工作' })
  assert.equal(f.previews[0].workspaceId, workspaces[1].id)
  assert.equal(f.calls('hub.execute').length, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('跨專案切換清除搜尋及舊合併確認，不會執行舊 token', async () => {
  // 其他工作超過 5 個才顯示搜尋框。
  const extras = Array.from({ length: 6 }, (_, index) => ({ ...workspaces[0], id: `repo::/fixture/extra-${index}`,
    branch: `feature/extra-${index}`, displayName: `額外工作 ${index}`, isActive: false }))
  const f = fixture([...workspaces, ...extras])
  const view = await mount(panel, { host: f.host })
  await view.type({ label: '搜尋工作' }, 'login')
  await finishPreview(view)
  f.activate(workspaces[2].id)
  await f.emit(view)
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.equal(read(state.search), '')
  assert.equal(view.find({ text: /^確認 (Merge|Rebase) 到 / }), null)
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  assert.ok(view.find({ text: '目前在主要分支' }))
  assert.equal(read(state.dashboard)?.activeWorkspaceId, workspaces[2].id)
  assert.equal(f.calls('hub.execute').length, 0)
  await view.unmount()
})

test('切換後建立草稿與收尾選項不會帶到新的工作樹', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  await view.press({ text: '開始新工作' })
  await view.type({ label: '工作名稱' }, '舊工作')
  await view.toggle({ label: '調整起點與 AI 助手' })
  await view.select({ label: '建立後啟動 AI 助手' }, 'claude')
  await view.type({ label: '請 AI 做什麼' }, '舊任務')
  f.activate(workspaces[2].id)
  await f.emit(view)
  await view.press({ text: '開始新工作' })
  assert.equal(view.valueOf({ label: '工作名稱' }), '')
  await view.toggle({ label: '調整起點與 AI 助手' })
  assert.equal(view.valueOf({ label: '起點分支' }), 'docs-main')
  assert.equal(view.valueOf({ label: '建立後啟動 AI 助手' }), 'none')
  await view.select({ label: '建立後啟動 AI 助手' }, 'claude')
  assert.equal(view.valueOf({ label: '請 AI 做什麼' }), '')
  await view.press({ text: '返回工作清單' })
  f.activate(workspaces[0].id)
  await f.emit(view)
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.select({ label: '合併方式' }, 'rebase')
  await expandFinishOptions(view)
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  await view.toggle({ label: '完成後移除資料夾' })
  f.activate(workspaces[2].id)
  await f.emit(view)
  f.activate(workspaces[0].id)
  await f.emit(view)
  await view.press({ testId: `finish:${workspaces[0].id}` })
  assert.equal(view.valueOf({ label: '合併方式' }), 'merge')
  await expandFinishOptions(view)
  assert.equal(view.valueOf({ label: '合成 1 個提交（Squash）' }), false)
  assert.equal(view.valueOf({ label: '完成後移除資料夾' }), false)
  await view.unmount()
})

test('初始通知與同工作樹終端事件保留表單，不重讀 dashboard', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  await f.emit(view)
  await view.press({ text: '開始新工作' })
  await view.type({ label: '工作名稱' }, '保留草稿')
  const reads = f.calls('hub.dashboard').length
  await f.emit(view, [{ id: 'terminal-new', title: '新終端' }])
  assert.equal(view.valueOf({ label: '工作名稱' }), '保留草稿')
  assert.equal(f.calls('hub.dashboard').length, reads)
  await view.unmount()
})

test('不同專案的同名分支與同名工作仍以身分切換', async () => {
  const sameName = workspaces.map((workspace) => ({ ...workspace, branch: 'main', displayName: 'main' }))
  const f = fixture(sameName)
  const view = await mount(panel, { host: f.host })
  f.activate(workspaces[2].id)
  await f.emit(view)
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.ok(view.find({ text: '目前在主要分支' }))
  assert.equal(read(state.dashboard)?.activeWorkspaceId, workspaces[2].id)
  assert.equal(view.find({ testId: `finish:${workspaces[0].id}` }), null)
  await view.unmount()
})

test('較慢的工作樹事件清單不會覆蓋後來的切換', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  const old = deferred<HubList>()
  const started = deferred<void>()
  f.activate(workspaces[1].id)
  const oldList = f.listing()
  f.overrides.list = () => { started.resolve(); return old.promise }
  const earlier = f.emit(view)
  await started.promise
  f.overrides.list = undefined
  f.activate(workspaces[2].id)
  const later = f.emit(view)
  await until(switchedTo('docs'))
  const reads = f.calls('hub.dashboard').length
  old.resolve(oldList)
  await Promise.all([earlier, later])
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.equal(f.calls('hub.dashboard').length, reads)
  assert.ok(view.find({ text: '目前在主要分支' }))
  assert.equal(read(state.dashboard)?.activeWorkspaceId, workspaces[2].id)
  await view.unmount()
})

test('執行中多次切換延後同步，保留部分完成結果且不重送操作', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  const execution = deferred<Execution>()
  const started = deferred<void>()
  f.overrides.execute = () => { started.resolve(); return execution.promise }
  await finishPreview(view)
  const running = view.press({ text: /^確認 (Merge|Rebase) 到 / })
  await started.promise
  const before = f.calls('hub.list').length
  f.activate(workspaces[1].id)
  const firstEvent = f.emit(view)
  f.activate(workspaces[2].id)
  const latestEvent = f.emit(view)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.calls('hub.list').length, before)
  assert.equal(view.find({ label: '專案' })?.disabled, true)
  execution.resolve(partialOutcome())
  await Promise.all([running, firstEvent, latestEvent])
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.ok(view.find({ label: '還沒全部完成' }))
  assert.ok(view.find({ text: '來源有新變更' }))
  assert.equal(f.calls('hub.execute').length, 1)
  await view.unmount()
})

test('建立的內部預覽期間切換仍完成原請求，再跟隨新工作樹', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  const preview = deferred<Preview>()
  const started = deferred<void>()
  f.overrides.preview = () => { started.resolve(); return preview.promise }
  await view.press({ text: '開始新工作' })
  await view.type({ label: '工作名稱' }, '原工作')
  const creating = view.press({ text: '建立並開啟工作' })
  await started.promise
  f.activate(workspaces[2].id)
  const event = f.emit(view)
  preview.resolve({ token: 'create-original', title: '建立', summary: '建立原工作', detail: '' })
  await Promise.all([creating, event])
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.equal(f.previews[0].workspaceId, workspaces[0].id)
  assert.deepEqual((f.calls('hub.execute')[0].params as { input: unknown }).input, { token: 'create-original' })
  assert.ok(view.find({ type: 'Callout', label: '已完成', text: /工作已完成/ }))
  assert.equal(f.calls('hub.execute').length, 1)
  await view.unmount()
})

test('執行失敗後跟隨新工作樹，仍保留原操作的錯誤', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  const execution = deferred<Execution>()
  const started = deferred<void>()
  f.overrides.execute = () => { started.resolve(); return execution.promise }
  await finishPreview(view)
  const running = view.press({ text: /^確認 (Merge|Rebase) 到 / })
  await started.promise
  f.activate(workspaces[2].id)
  const event = f.emit(view)
  execution.reject(new Error('原操作結果未知，請核對。'))
  await Promise.all([running, event])
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.ok(view.find({ text: '原操作結果未知，請核對。' }))
  assert.equal(view.find({ text: /^確認 (Merge|Rebase) 到 / }), null)
  assert.equal(f.calls('hub.execute').length, 1)
  await view.unmount()
})

for (const delayed of ['inspect', 'preview'] as const) {
  test(`切換後較慢的 ${delayed} 回覆不會復活舊工作畫面`, async () => {
    const f = fixture()
    const view = await mount(panel, { host: f.host })
    const started = deferred<void>()
    const oldInspect = deferred<GitSnapshot>()
    const oldPreview = deferred<Preview>()
    let oldRead: Promise<void>
    if (delayed === 'inspect') {
      f.overrides.inspect = () => { started.resolve(); return oldInspect.promise }
      oldRead = view.press({ testId: `finish:${workspaces[0].id}` })
    } else {
      await view.press({ testId: `finish:${workspaces[0].id}` })
      f.overrides.preview = () => { started.resolve(); return oldPreview.promise }
      oldRead = view.press({ text: /^預覽 (Merge|Rebase) 收尾$/ })
    }
    await started.promise
    f.activate(workspaces[2].id)
    const event = f.emit(view)
    await until(switchedTo('docs'))
    oldInspect.resolve({ ...snapshot, branch: 'OLD_BRANCH' })
    oldPreview.resolve({ token: 'old-token', title: '舊預覽', summary: '不得復活', detail: '' })
    await Promise.all([oldRead, event])
    assert.equal(view.valueOf({ label: '專案' }), 'docs')
    assert.equal(view.find({ text: /^確認 (Merge|Rebase) 到 / }), null)
    assert.equal(view.find({ text: 'OLD_BRANCH' }), null)
    // 切換後收尾頁已關閉，直接核對 state，確保舊 token／快照沒有寫回。
    assert.equal(read(state.preview), null)
    assert.notEqual(read(state.snapshot)?.branch, 'OLD_BRANCH')
    assert.equal(view.find({ type: 'Heading', text: '完成工作' }), null)
    assert.equal(f.calls('hub.execute').length, 0)
    await view.unmount()
  })
}

test('完成後才收到自動開啟目標的切換事件，仍保留逐步結果', async () => {
  const f = fixture()
  f.overrides.execute = partialOutcome
  const view = await mount(panel, { host: f.host })
  await finishPreview(view)
  await view.press({ text: /^確認 (Merge|Rebase) 到 / })
  assert.ok(view.find({ text: '來源有新變更' }))
  f.activate(workspaces[1].id)
  await f.emit(view)
  assert.ok(view.find({ text: '目前在主要分支' }))
  assert.ok(view.find({ label: '還沒全部完成' }))
  assert.ok(view.find({ text: '來源有新變更' }))
  assert.equal(f.calls('hub.execute').length, 1)
  await view.unmount()
})

test('執行前已送出的切換查詢在完成後才回來，不會清掉結果', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  await finishPreview(view)
  const old = deferred<HubList>()
  const started = deferred<void>()
  f.activate(workspaces[2].id)
  const oldList = f.listing()
  f.overrides.list = () => { started.resolve(); return old.promise }
  const event = f.emit(view)
  await started.promise
  f.overrides.list = undefined
  f.overrides.execute = partialOutcome
  const running = view.press({ text: /^確認 (Merge|Rebase) 到 / })
  await until(() => !read(state.executing) && Boolean(read(state.execution)))
  old.resolve(oldList)
  await Promise.all([event, running])
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.ok(view.find({ label: '還沒全部完成' }))
  assert.ok(view.find({ text: '來源有新變更' }))
  assert.equal(f.calls('hub.execute').length, 1)
  await view.unmount()
})

test('初次讀取失敗後，第一次切換仍會載入新的工作樹', async () => {
  const f = fixture()
  f.overrides.list = () => { throw new Error('初次讀取失敗') }
  const view = await mount(panel, { host: f.host })
  assert.ok(view.find({ text: /初次讀取失敗/ }))
  f.overrides.list = undefined
  f.activate(workspaces[2].id)
  await f.emit(view)
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.equal(view.find({ text: /初次讀取失敗/ }), null)
  assert.ok(view.find({ text: '目前在主要分支' }))
  assert.equal(read(state.dashboard)?.activeWorkspaceId, workspaces[2].id)
  await view.unmount()
})

test('Claude 評估期間切換工作樹，晚到的建議不會填進新的工作', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  const execution = deferred<Execution>()
  const started = deferred<void>()
  f.overrides.execute = () => { started.resolve(); return execution.promise }
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await previewAdvice()
  const writing = writeAdvice()
  await started.promise
  f.activate(workspaces[2].id)
  const event = f.emit(view)
  await until(switchedTo('docs'))
  execution.resolve({ message: '已取得建議。', advice: { level: '低', text: 'OLD_ADVICE', facts: { conflict: false, overlap: [] }, raised: false } })
  await Promise.all([writing, event])
  assert.equal(view.valueOf({ label: '專案' }), 'docs')
  assert.equal(read(state.advice), null)
  assert.equal(view.find({ text: /Claude 正在評估合併風險/ }), null)
  assert.equal(f.calls('hub.execute').length, 1)
  await view.unmount()
})

test('失去目前工作樹會清除操作入口，卸載後不再接收事件', async () => {
  const f = fixture()
  const view = await mount(panel, { host: f.host })
  await finishPreview(view)
  f.activate(null)
  await f.emit(view)
  assert.equal(view.find({ text: /^確認 (Merge|Rebase) 到 / }), null)
  assert.equal(view.find({ text: '開始新工作' }), null)
  assert.ok(view.find({ text: '目前沒有可用的本機工作樹，請在 Orca 選擇一個 Git 工作樹。' }))
  await view.unmount()
  const reads = f.calls('hub.list').length
  f.activate(workspaces[2].id)
  await f.emit(view)
  assert.equal(f.calls('hub.list').length, reads)
})
