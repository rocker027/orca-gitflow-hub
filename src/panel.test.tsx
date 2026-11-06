import { assert, mockHost, mount, test } from 'orca/testing'
import type { Execution, HubAction } from './protocol'
import * as panel from './panel'
import { dashboardFor, prDetail, requests, snapshot, workspaces } from './panel.check.ts'

function calls(host: ReturnType<typeof mockHost>, name: string) {
  return host.calls.filter((call) => call.method === 'plugin.request' &&
    (call.params as { name?: string })?.name === name)
}

function fixtureHost(execution: Execution = { message: '操作完成。', status: 'completed' }) {
  const previews: HubAction[] = []
  const host = mockHost({ requests: {
    ...requests,
    'hub.preview': (action) => {
      previews.push(action)
      return { token: 'preview-token', title: '操作預覽', summary: '確認後才會寫入。', detail: JSON.stringify(action),
        ...(action.kind === 'finish' ? { steps: ['提交全部變更', '合回 main', '開啟 main', '安全清理來源'] } : {}) }
    },
    'hub.execute': execution
  } })
  return { host, previews }
}

/** 其他工作超過 5 個才顯示搜尋框；回傳加上額外工作後的清單與 dashboard。 */
function manyWorkspaces() {
  const extras = Array.from({ length: 6 }, (_, index) => ({ ...workspaces[0], id: `repo::/fixture/extra-${index}`,
    branch: `feature/extra-${index}`, displayName: `額外工作 ${index}`, isActive: false }))
  const all = [...workspaces, ...extras]
  return { all, list: { workspaces: all, warnings: [] }, dashboard: { ...dashboardFor(), workspaces: all } }
}

async function inspect(view: Awaited<ReturnType<typeof mount>>, workspaceId = workspaces[0].id) {
  if (view.find({ text: '返回工作清單' })) await view.press({ text: '返回工作清單' })
  await view.press({ testId: `inspect:${workspaceId}` })
}

async function inspectGit(view: Awaited<ReturnType<typeof mount>>) {
  await inspect(view)
  await view.toggle({ label: 'Git 差異與逐檔提交' })
}

test('首屏依目前專案顯示摘要，不先讀完整 Diff 或預設第一個專案', async () => {
  const host = mockHost({ requests: { ...requests,
    'hub.list': { workspaces: [workspaces[2], workspaces[1], workspaces[0]], warnings: [] }
  } })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: '專案' }), 'repo')
  assert.deepEqual((calls(host, 'hub.dashboard')[0].params as { input: unknown }).input, {})
  assert.equal(calls(host, 'hub.inspect').length, 0)
  assert.ok(view.find({ testId: `inspect:${workspaces[0].id}` }))
  assert.equal(view.find({ testId: `inspect:${workspaces[2].id}` }), null)
  assert.ok(view.find({ text: /2 個檔案未提交/ }))
  assert.equal(view.find({ text: '領先 2 · 落後 0' }), null)
  assert.equal(view.find({ text: '補上登入驗證' }), null)
  assert.ok(view.find({ text: '登入功能' }))
  assert.ok(view.find({ text: '開始新工作' }))
  assert.equal(view.find({ type: 'Tabs' }), null)
  assert.equal(view.find({ text: workspaces[0].id }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('工作少時不顯示搜尋框，主要分支不提供收尾', async () => {
  const { host } = fixtureHost()
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: '搜尋工作' }), null)
  assert.equal(view.find({ testId: `finish:${workspaces[1].id}` }), null)
  assert.ok(view.find({ testId: `open:${workspaces[1].id}` }))
  await view.unmount()
})

test('工作多時可搜尋其他工作，目前的工作不受搜尋影響', async () => {
  const many = manyWorkspaces()
  const host = mockHost({ requests: { ...requests, 'hub.list': many.list, 'hub.dashboard': many.dashboard } })
  const view = await mount(panel, { host })
  await view.type({ label: '搜尋工作' }, 'extra-1')
  assert.ok(view.find({ testId: 'inspect:repo::/fixture/extra-1' }))
  assert.equal(view.find({ testId: 'inspect:repo::/fixture/extra-2' }), null)
  assert.equal(view.find({ testId: `inspect:${workspaces[1].id}` }), null)
  assert.ok(view.find({ testId: `finish:${workspaces[0].id}` }))
  await view.unmount()
})

test('長清單選收尾或檢視後聚焦內容，確認預覽位於檔案清單之前', async () => {
  const extras = Array.from({ length: 30 }, (_, index) => ({ ...workspaces[0],
    id: `repo::/fixture/extra-${index}`, branch: `feature/extra-${index}`, isActive: false }))
  const all = [workspaces[1], ...extras, workspaces[0], workspaces[2]]
  const dashboard = { ...dashboardFor(), workspaces: all }
  const host = mockHost({ requests: { ...requests,
    'hub.list': { workspaces: all, warnings: [] }, 'hub.dashboard': dashboard,
    'hub.preview': { token: 'finish', title: '收尾操作預覽', summary: '提交後合回 main，再安全清理。',
      detail: '完整差異很長', steps: ['提交全部變更', '合回 main', '開啟 main', '清理來源'] }
  } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ testId: 'inspect:repo::/fixture/extra-29' }))
  await view.press({ testId: `finish:${workspaces[0].id}` })
  assert.equal(view.find({ label: '搜尋工作' }), null)
  assert.equal(view.find({ text: '開始新工作' }), null)
  assert.equal(view.find({ testId: `inspect:${workspaces[1].id}` }), null)
  assert.ok(view.find({ type: 'Heading', text: '完成工作' }))
  assert.ok(view.find({ text: 'feature/login' }))
  await view.press({ text: '下一步：確認' })
  assert.equal(view.findAll({ type: 'Card' })[0]?.label, '最後確認')
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  assert.ok(view.find({ text: 'feature/login → main' }))
  assert.equal(view.find({ text: '4. 清理來源' }), null)
  await view.toggle({ label: '執行步驟與提交訊息' })
  assert.ok(view.find({ text: '4. 清理來源' }))
  assert.equal(view.find({ text: '完整差異很長' }), null)
  assert.equal(calls(host, 'hub.execute').length, 0)
  await view.press({ text: '返回工作清單' })
  assert.equal(view.find({ text: '確認，開始合併' }), null)
  assert.ok(view.find({ label: '搜尋工作' }))
  await inspect(view)
  assert.equal(view.find({ label: '搜尋工作' }), null)
  assert.equal(view.find({ text: '開始新工作' }), null)
  assert.equal(view.findAll({ type: 'Card' })[0]?.label, '查看變更：feature/login')
  await view.press({ text: '返回工作清單' })
  assert.ok(view.find({ testId: `inspect:${workspaces[1].id}` }))
  await view.unmount()
})

test('收尾只接受同專案目標，一次預覽全部變更與四個步驟', async () => {
  const { host, previews } = fixtureHost()
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  assert.deepEqual(view.find({ label: '合併到' })?.props.options, [{ value: workspaces[1].id, label: 'main（主要分支）' }])
  assert.equal(view.valueOf({ label: '完成後移除資料夾' }), true)
  assert.equal(view.valueOf({ label: '合併方式' }), 'merge')
  assert.equal(view.valueOf({ label: '合成 1 個提交（Squash）' }), false)
  assert.ok(view.find({ label: '收尾時提交 2 個檔案' }))
  await view.toggle({ label: '收尾時提交 2 個檔案' })
  assert.ok(view.find({ text: /src\/login.ts/ }))
  assert.ok(view.find({ text: /notes.md/ }))
  await view.press({ text: '下一步：確認' })
  assert.deepEqual(previews, [{ kind: 'finish', workspaceId: workspaces[0].id,
    targetWorkspaceId: workspaces[1].id, message: '完成 feature/login', remove: true, strategy: 'merge', squash: false }])
  await view.toggle({ label: '執行步驟與提交訊息' })
  assert.ok(view.find({ text: '4. 安全清理來源' }))
  assert.equal(calls(host, 'hub.execute').length, 0)
  await view.press({ text: '確認，開始合併' })
  assert.equal(calls(host, 'hub.execute').length, 1)
  await view.unmount()
})

test('乾淨來源明示略過提交，不要求訊息或送出提交操作', async () => {
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests,
    'hub.inspect': { ...snapshot, files: [], workingDiff: '' },
    'hub.preview': (action) => { previews.push(action); return { token: 'clean', title: '預覽', summary: '略過提交', detail: '' } }
  } })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  assert.ok(view.find({ text: '沒有未提交的變更。' }))
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  await view.press({ text: '下一步：確認' })
  assert.deepEqual(previews, [{ kind: 'finish', workspaceId: workspaces[0].id,
    targetWorkspaceId: workspaces[1].id, message: '', remove: true, strategy: 'merge', squash: false }])
  await view.unmount()
})

test('收尾部分成功逐步呈現，不顯示全流程成功並切至回傳目標', async () => {
  const { host } = fixtureHost({ status: 'needs_attention', workspaceId: workspaces[1].id,
    message: '已合併，但來源工作樹仍保留。', steps: [
      { id: 'commit', label: '提交', status: 'done', detail: '已建立 abc123' },
      { id: 'merge', label: '合併', status: 'done', detail: '已合回 main' },
      { id: 'open', label: '開啟', status: 'done', detail: '已開啟 main' },
      { id: 'cleanup', label: '清理', status: 'failed', detail: '來源出現新的變更' }
    ] })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.press({ text: '下一步：確認' })
  await view.press({ text: '確認，開始合併' })
  assert.ok(view.find({ label: '還沒全部完成' }))
  assert.equal(view.find({ label: '完成了' }), null)
  assert.ok(view.find({ text: '已建立 abc123' }))
  assert.ok(view.find({ text: '來源出現新的變更' }))
  await view.press({ text: '開啟「main」資料夾' })
  assert.deepEqual((calls(host, 'hub.open')[0].params as { input: unknown }).input, { workspaceId: workspaces[1].id })
  assert.equal(view.findAll({ type: 'Callout' }).some((entry) => entry.props.tone === 'success'), false)
  await inspect(view)
  assert.equal(view.find({ label: '還沒全部完成' }), null)
  await view.unmount()
})

test('快速建立預填 main 且預設不啟動 Agent，執行後不重複開啟', async () => {
  const { host, previews } = fixtureHost({ status: 'completed', message: '已建立並開啟工作樹。' })
  const view = await mount(panel, { host })
  await view.press({ text: '開始新工作' })
  assert.equal(view.find({ label: '起點分支' }), null)
  assert.equal(view.find({ label: '建立後啟動 AI 助手' }), null)
  assert.ok(view.find({ text: '從 main 開始' }))
  await view.toggle({ label: '調整起點與 AI 助手' })
  assert.equal(view.valueOf({ label: '起點分支' }), 'main')
  assert.equal(view.valueOf({ label: '建立後啟動 AI 助手' }), 'none')
  assert.equal(view.find({ label: '請 AI 做什麼' }), null)
  await view.type({ label: '工作名稱' }, 'feature/payments')
  await view.press({ text: '建立並開啟工作' })
  assert.deepEqual(previews, [{ kind: 'create', workspaceId: workspaces[0].id,
    name: 'feature/payments', base: 'main', agent: '', prompt: '' }])
  assert.equal(view.find({ text: '確認執行' }), null)
  assert.equal(calls(host, 'hub.execute').length, 1)
  assert.deepEqual((calls(host, 'hub.execute')[0].params as { input: unknown }).input, { token: 'preview-token' })
  assert.ok(view.find({ text: /已建立並開啟工作樹/ }))
  assert.equal(calls(host, 'hub.open').length, 0)
  await view.unmount()
})

test('建立從預覽到執行皆凍結輸入，重複點擊只送出一組 RPC 並保留部分結果', async () => {
  const preview = deferred<{ token: string; title: string; summary: string; detail: string }>()
  const previewStarted = deferred<void>()
  const execution = deferred<Execution>()
  const executionStarted = deferred<void>()
  const host = mockHost({ requests: { ...requests,
    'hub.preview': () => { previewStarted.resolve(); return preview.promise },
    'hub.execute': () => { executionStarted.resolve(); return execution.promise }
  } })
  const view = await mount(panel, { host })
  await view.press({ text: '開始新工作' })
  await view.toggle({ label: '調整起點與 AI 助手' })
  await view.type({ label: '工作名稱' }, 'feature/new')
  const creating = view.press({ text: '建立並開啟工作' })
  await previewStarted.promise
  const rapidDuplicate = view.press({ text: '建立並開啟工作' })
  const rapidBack = view.press({ text: '返回工作清單' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(view.find({ label: '工作名稱' })?.disabled, true)
  assert.equal(view.find({ label: '建立後啟動 AI 助手' })?.disabled, true)
  assert.equal(view.find({ label: '專案' })?.disabled, true)
  assert.equal(calls(host, 'hub.execute').length, 0)
  await assert.rejects(view.press({ text: '建立並開啟工作' }), /disabled/)
  preview.resolve({ token: 'create-once', title: '建立', summary: '建立並開啟工作', detail: '' })
  await executionStarted.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(view.find({ text: '建立並開啟工作' })?.disabled, true)
  await assert.rejects(view.press({ text: '建立並開啟工作' }), /disabled/)
  execution.resolve({ status: 'needs_attention', message: '工作樹已建立，但未開啟。',
    steps: [{ id: 'open', label: '開啟工作樹', status: 'failed', detail: 'Orca 開啟失敗，工作樹已保留。' }] })
  await Promise.all([creating, rapidDuplicate, rapidBack])
  assert.equal(calls(host, 'hub.preview').length, 1)
  assert.equal(calls(host, 'hub.execute').length, 1)
  assert.equal(calls(host, 'hub.open').length, 0)
  assert.deepEqual((calls(host, 'hub.execute')[0].params as { input: unknown }).input, { token: 'create-once' })
  assert.ok(view.find({ text: 'Orca 開啟失敗，工作樹已保留。' }))
  assert.equal(view.findAll({ type: 'Callout' }).some((entry) => entry.props.tone === 'success'), false)
  assert.equal(view.find({ text: '確認執行' }), null)
  await view.unmount()
})

test('建立預覽失敗時不執行，恢復表單並顯示錯誤', async () => {
  const host = mockHost({ requests: { ...requests,
    'hub.preview': () => { throw new Error('分支名稱已存在。') }
  } })
  const view = await mount(panel, { host })
  await view.press({ text: '開始新工作' })
  await view.type({ label: '工作名稱' }, 'feature/existing')
  await view.toggle({ label: '調整起點與 AI 助手' })
  await view.select({ label: '建立後啟動 AI 助手' }, 'codex')
  await view.type({ label: '請 AI 做什麼' }, '保留這段任務說明')
  await view.press({ text: '建立並開啟工作' })
  assert.equal(calls(host, 'hub.preview').length, 1)
  assert.equal(calls(host, 'hub.execute').length, 0)
  assert.ok(view.find({ text: /分支名稱已存在/ }))
  assert.equal(view.find({ text: '建立並開啟工作' })?.disabled, false)
  assert.equal(view.valueOf({ label: '工作名稱' }), 'feature/existing')
  assert.equal(view.valueOf({ label: '建立後啟動 AI 助手' }), 'codex')
  assert.equal(view.valueOf({ label: '請 AI 做什麼' }), '保留這段任務說明')
  assert.equal(view.find({ text: '確認執行' }), null)
  await view.unmount()
})

test('建立基準仍為必填，來源不存在時無法提交', async () => {
  const { host, previews } = fixtureHost()
  const view = await mount(panel, { host })
  await view.press({ text: '開始新工作' })
  await view.type({ label: '工作名稱' }, 'feature/payments')
  await view.toggle({ label: '調整起點與 AI 助手' })
  await view.type({ label: '起點分支' }, '   ', { replace: true })
  assert.equal(view.find({ text: '建立並開啟工作' })?.disabled, true)
  assert.deepEqual(previews, [])
  await view.unmount()
  const emptyHost = mockHost({ requests: {
    'hub.list': { workspaces: [], warnings: [] },
    'hub.dashboard': { workspaces: [], warnings: [], repoId: '', summaries: [] }
  } })
  const empty = await mount(panel, { host: emptyHost })
  assert.equal(empty.find({ text: '下一步：確認' }), null)
  assert.equal(calls(emptyHost, 'hub.inspect').length, 0)
  assert.equal(calls(emptyHost, 'hub.preview').length, 0)
  await empty.unmount()
})

test('專案切換會清除來源、預覽與提交訊息，不沿用跨專案目標', async () => {
  const { host } = fixtureHost()
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.press({ text: '下一步：確認' })
  await view.select({ label: '專案' }, 'docs')
  assert.equal(view.find({ text: '確認，開始合併' }), null)
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  assert.equal(view.find({ testId: `inspect:${workspaces[0].id}` }), null)
  assert.ok(view.find({ testId: `inspect:${workspaces[2].id}` }))
  assert.equal(calls(host, 'hub.execute').length, 0)
  await view.unmount()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('跨專案較慢的 dashboard 回覆不能覆蓋較新的選擇', async () => {
  const slow = deferred<ReturnType<typeof dashboardFor>>()
  const started = deferred<void>()
  let delayed = false
  const host = mockHost({ requests: { ...requests,
    'hub.dashboard': ({ repoId }) => {
      if (repoId === 'docs') { delayed = true; started.resolve(); return slow.promise }
      return dashboardFor(repoId)
    }
  } })
  const view = await mount(panel, { host })
  const oldSelection = view.select({ label: '專案' }, 'docs')
  await started.promise
  const latest = view.select({ label: '專案' }, 'repo')
  slow.resolve(dashboardFor('docs'))
  await Promise.all([oldSelection, latest])
  assert.equal(delayed, true)
  assert.equal(view.valueOf({ label: '專案' }), 'repo')
  assert.equal(view.find({ testId: `inspect:${workspaces[2].id}` }), null)
  await view.unmount()
})

test('較慢的工作樹 Diff 不會覆蓋新選取的來源', async () => {
  const slow = deferred<typeof snapshot>()
  const started = deferred<void>()
  const host = mockHost({ requests: { ...requests,
    'hub.inspect': ({ workspaceId }) => {
      if (workspaceId === workspaces[1].id) { started.resolve(); return slow.promise }
      return snapshot
    }
  } })
  const view = await mount(panel, { host })
  const oldSelection = inspect(view, workspaces[1].id)
  await started.promise
  const latest = inspect(view)
  slow.resolve({ ...snapshot, branch: 'OLD_MAIN' })
  await Promise.all([oldSelection, latest])
  await view.toggle({ label: 'Git 差異與逐檔提交' })
  assert.equal(view.find({ text: 'OLD_MAIN' }), null)
  assert.ok(view.find({ text: 'feature/login' }))
  await view.unmount()
})

test('較慢的收尾預覽不能回到新選取的工作樹', async () => {
  const slow = deferred<{ token: string; title: string; summary: string; detail: string }>()
  const started = deferred<void>()
  const host = mockHost({ requests: { ...requests,
    'hub.preview': () => { started.resolve(); return slow.promise }
  } })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  const oldPreview = view.press({ text: '下一步：確認' })
  await started.promise
  const latest = inspect(view, workspaces[1].id)
  slow.resolve({ token: 'old', title: '舊預覽', summary: '不應顯示', detail: '' })
  await Promise.all([oldPreview, latest])
  assert.equal(view.find({ text: '確認，開始合併' }), null)
  assert.ok(view.find({ label: '查看變更：main' }))
  assert.equal(calls(host, 'hub.execute').length, 0)
  await view.unmount()
})

test('重新整理失敗後不沿用舊的來源狀態或乾淨摘要', async () => {
  let reads = 0
  const host = mockHost({ requests: { ...requests,
    'hub.dashboard': () => {
      if (reads++ > 0) throw new Error('狀態查詢失敗')
      return dashboardFor()
    }
  } })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.press({ label: '重新整理' })
  assert.ok(view.find({ text: /狀態查詢失敗/ }))
  assert.equal(view.find({ text: '下一步：確認' })?.disabled, true)
  assert.equal(calls(host, 'hub.preview').length, 0)
  await view.press({ text: '返回工作清單' })
  assert.ok(view.find({ text: '暫時無法讀取變更' }))
  assert.equal(view.find({ text: '沒有未提交的變更' }), null)
  await view.unmount()
})

test('摘要載入期間搜尋不會取消查詢', async () => {
  const many = manyWorkspaces()
  const slow = deferred<ReturnType<typeof dashboardFor>>()
  const started = deferred<void>()
  let reads = 0
  const host = mockHost({ requests: { ...requests, 'hub.list': many.list,
    'hub.dashboard': () => {
      if (reads++ > 0) { started.resolve(); return slow.promise }
      return many.dashboard
    }
  } })
  const view = await mount(panel, { host })
  const refreshing = view.press({ label: '重新整理' })
  await started.promise
  const searching = view.type({ label: '搜尋工作' }, 'extra-1')
  slow.resolve(many.dashboard)
  await Promise.all([refreshing, searching])
  assert.ok(view.find({ text: /2 個檔案未提交/ }))
  assert.equal(view.find({ testId: `inspect:${workspaces[1].id}` }), null)
  await view.unmount()
})

test('檢視內仍能選檔暫存，未確認不寫入，欄位變更會使預覽失效', async () => {
  const { host, previews } = fixtureHost()
  const view = await mount(panel, { host })
  await inspectGit(view)
  await view.toggle({ label: 'src/login.ts' })
  await view.press({ text: '預覽暫存選取檔案' })
  assert.deepEqual(previews, [{ kind: 'stage', workspaceId: workspaces[0].id,
    paths: ['src/login.ts'], fingerprint: snapshot.fingerprint }])
  assert.equal(calls(host, 'hub.execute').length, 0)
  assert.ok(view.find({ text: '確認執行' }))
  assert.equal(view.find({ label: '提交訊息' }), null)
  await view.press({ text: '返回修改' })
  if (!view.find({ label: '提交訊息' })) await view.toggle({ label: 'Git 差異與逐檔提交' })
  await view.type({ label: '提交訊息' }, 'feat: changed')
  assert.equal(view.find({ text: '確認執行' }), null)
  await view.unmount()
})

test('GitHub 位於工作樹詳情，保留 UNKNOWN 且只提供合併連結', async () => {
  const { host } = fixtureHost()
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'GitHub PR' }), null)
  await inspect(view)
  await view.toggle({ label: 'GitHub PR' })
  await view.press({ text: '#7 登入功能' })
  assert.ok(view.find({ text: '審查決策：UNKNOWN' }))
  assert.ok(view.find({ text: 'CI：UNKNOWN（尚無檢查結果）' }))
  assert.equal(view.find({ text: '在 GitHub 審查與合併' })?.props.href, prDetail.pr.url)
  assert.equal(calls(host, 'hub.execute').length, 0)
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('AI 草稿與 Draft PR 仍可從次要詳情到達', async () => {
  const { host, previews } = fixtureHost()
  const view = await mount(panel, { host })
  await inspectGit(view)
  await view.toggle({ label: 'AI 提交訊息草稿' })
  await view.select({ label: 'AI 草稿 Agent' }, 'claude')
  await view.press({ text: '預覽委派 AI 草稿' })
  assert.deepEqual(previews[0], { kind: 'ai-message', workspaceId: workspaces[0].id, agent: 'claude' })
  await view.press({ text: '返回修改' })
  if (!view.find({ label: '提交訊息' })) await view.toggle({ label: 'Git 差異與逐檔提交' })
  if (!view.find({ text: '匯入 AI 草稿' })) await view.toggle({ label: 'AI 提交訊息草稿' })
  await view.press({ text: '匯入 AI 草稿' })
  assert.equal(view.valueOf({ label: '提交訊息' }), 'feat: 補上登入驗證')
  await view.toggle({ label: 'GitHub PR' })
  await view.toggle({ label: '建立 Draft PR' })
  await view.type({ label: '目標分支' }, 'main')
  await view.type({ label: 'PR 標題' }, '登入驗證')
  await view.type({ label: 'PR 說明' }, '新增測試')
  await view.press({ text: '預覽建立 Draft PR' })
  assert.deepEqual(previews[1], { kind: 'draft', workspaceId: workspaces[0].id,
    targetBranch: 'main', title: '登入驗證', description: '新增測試' })
  await view.unmount()
})

test('摘要讀取失敗明示無法讀取，不會誤標沒有變更', async () => {
  const dashboard = dashboardFor()
  const host = mockHost({ requests: { ...requests, 'hub.dashboard': { ...dashboard,
    summaries: dashboard.summaries.map((summary) => ({ ...summary, error: '無法讀取 Git', changedFiles: 0 }))
  } } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '暫時無法讀取變更' }))
  assert.equal(view.find({ text: '沒有未提交的變更' }), null)
  await view.unmount()
})

test('執行中的第二次點擊不會重複送出 token', async () => {
  const execution = deferred<Execution>()
  const started = deferred<void>()
  const host = mockHost({ requests: { ...requests,
    'hub.preview': { token: 'once', title: '預覽', summary: '提交', detail: 'diff' },
    'hub.execute': () => { started.resolve(); return execution.promise }
  } })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.press({ text: '下一步：確認' })
  const running = view.press({ text: '確認，開始合併' })
  await started.promise
  // 執行中確認按鈕換成進度說明，沒有東西可以再按一次（等面板重繪後檢查）。
  for (let round = 0; round < 50 && view.find({ text: '確認，開始合併' }); round++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(view.find({ text: '確認，開始合併' }), null)
  execution.resolve({ message: '操作完成。', status: 'completed' })
  await running
  assert.equal(calls(host, 'hub.execute').length, 1)
  await view.unmount()
})

test('Worker 拒絕時顯示錯誤，不保留可重試的確認', async () => {
  const host = mockHost({ requests: { ...requests,
    'hub.preview': { token: 'token', title: '預覽', summary: '提交', detail: 'diff' },
    'hub.execute': () => { throw new Error('預覽已過期，請重新整理。') }
  } })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.press({ text: '下一步：確認' })
  await view.press({ text: '確認，開始合併' })
  assert.ok(view.find({ text: /預覽已過期/ }))
  assert.equal(view.find({ text: '確認，開始合併' }), null)
  assert.equal(calls(host, 'hub.execute').length, 1)
  await view.unmount()
})

test('開始新工作只顯示建立表單，中文名稱可送出且成功後清空下一次草稿', async () => {
  const { host, previews } = fixtureHost({ status: 'completed', message: '已建立並開啟工作樹。' })
  const view = await mount(panel, { host })
  await view.press({ text: '開始新工作' })
  assert.equal(view.find({ label: '搜尋工作' }), null)
  assert.equal(view.find({ testId: `open:${workspaces[0].id}` }), null)
  assert.equal(view.find({ label: '起點分支' }), null)
  assert.equal(view.find({ label: '建立後啟動 AI 助手' }), null)
  assert.equal(view.find({ text: '建立並開啟工作' })?.disabled, true)
  await view.type({ label: '工作名稱' }, '修正登入畫面')
  await view.toggle({ label: '調整起點與 AI 助手' })
  await view.select({ label: '建立後啟動 AI 助手' }, 'claude')
  await view.type({ label: '請 AI 做什麼' }, '修正錯誤訊息')
  await view.press({ text: '建立並開啟工作' })
  assert.deepEqual(previews, [{ kind: 'create', workspaceId: workspaces[0].id,
    name: '修正登入畫面', base: 'main', agent: 'claude', prompt: '修正錯誤訊息' }])
  assert.equal(calls(host, 'hub.execute').length, 1)
  await view.press({ text: '開始新工作' })
  assert.equal(view.valueOf({ label: '工作名稱' }), '')
  if (!view.find({ label: '建立後啟動 AI 助手' })) await view.toggle({ label: '調整起點與 AI 助手' })
  assert.equal(view.valueOf({ label: '建立後啟動 AI 助手' }), 'none')
  await view.select({ label: '建立後啟動 AI 助手' }, 'claude')
  assert.equal(view.valueOf({ label: '請 AI 做什麼' }), '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('搜尋沒有結果時可清除並找回原本的工作', async () => {
  const many = manyWorkspaces()
  const host = mockHost({ requests: { ...requests, 'hub.list': many.list, 'hub.dashboard': many.dashboard } })
  const view = await mount(panel, { host })
  await view.type({ label: '搜尋工作' }, '不存在的工作')
  assert.ok(view.find({ label: '找不到這個工作' }))
  assert.equal(view.find({ testId: 'open:repo::/fixture/extra-0' }), null)
  await view.press({ text: '清除搜尋' })
  assert.equal(view.valueOf({ label: '搜尋工作' }), '')
  assert.ok(view.find({ testId: 'open:repo::/fixture/extra-0' }))
  assert.equal(calls(host, 'hub.execute').length, 0)
  await view.unmount()
})

test('合併確認頁可返回修改並保留合併方式、目標與保留資料夾選項', async () => {
  const target = { ...workspaces[1], id: 'repo::/fixture/release', path: '/fixture/release',
    branch: 'release', displayName: 'release', isMainWorktree: false, isDefaultBranch: false }
  const all = [...workspaces, target]
  const previews: HubAction[] = []
  const host = mockHost({ requests: { ...requests,
    'hub.list': { workspaces: all, warnings: [] },
    'hub.dashboard': { ...dashboardFor(), workspaces: all },
    'hub.preview': (action) => {
      previews.push(action)
      return { token: `preview-${previews.length}`, title: '預覽', summary: '確認後才合併', detail: '' }
    }, 'hub.execute': { status: 'completed', message: '已合併' }
  } })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.select({ label: '合併到' }, target.id)
  await view.select({ label: '合併方式' }, 'rebase')
  await view.toggle({ label: '合成 1 個提交（Squash）' })
  await view.toggle({ label: '完成後移除資料夾' })
  await view.press({ text: '下一步：確認' })
  assert.equal(view.find({ label: '合併到' }), null)
  assert.equal(view.find({ label: '合併方式' }), null)
  assert.equal(view.find({ label: '4. 這次完成了什麼' }), null)
  assert.equal(view.find({ label: '完成後移除資料夾' }), null)
  assert.ok(view.find({ text: 'feature/login → release' }))
  assert.equal(view.find({ text: '提交訊息：完成 feature/login（自動產生）' }), null)
  await view.toggle({ label: '執行步驟與提交訊息' })
  assert.ok(view.find({ text: '提交訊息：完成 feature/login（自動產生）' }))
  assert.equal(calls(host, 'hub.execute').length, 0)
  await view.press({ text: '返回修改' })
  assert.equal(view.find({ text: '確認，開始合併' }), null)
  assert.equal(view.valueOf({ label: '合併到' }), target.id)
  assert.equal(view.valueOf({ label: '合併方式' }), 'rebase')
  assert.equal(view.valueOf({ label: '合成 1 個提交（Squash）' }), true)
  assert.equal(view.valueOf({ label: '完成後移除資料夾' }), false)
  await view.select({ label: '合併到' }, workspaces[1].id)
  await view.press({ text: '下一步：確認' })
  assert.deepEqual(previews, [
    { kind: 'finish', workspaceId: workspaces[0].id, targetWorkspaceId: target.id, message: '完成 feature/login', remove: false, strategy: 'rebase', squash: true },
    { kind: 'finish', workspaceId: workspaces[0].id, targetWorkspaceId: workspaces[1].id, message: '完成 feature/login', remove: false, strategy: 'rebase', squash: true }
  ])
  await view.press({ text: '確認，開始合併' })
  assert.deepEqual((calls(host, 'hub.execute')[0].params as { input: unknown }).input, { token: 'preview-2' })
  await view.unmount()
})

test('沒有同專案合併位置時說明恢復方式，不能產生預覽', async () => {
  const onlySource = [workspaces[0], workspaces[2]]
  const host = mockHost({ requests: { ...requests,
    'hub.list': { workspaces: onlySource, warnings: [] },
    'hub.dashboard': { ...dashboardFor(), workspaces: onlySource, defaultTargetId: undefined }
  } })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  assert.equal(view.find({ label: '合併到' }), null)
  assert.ok(view.find({ label: '還沒有可以合併的分支' }))
  assert.ok(view.find({ text: /請先在 Orca 開啟同專案的另一個工作資料夾/ }))
  assert.equal(view.find({ text: '下一步：確認' })?.disabled, true)
  assert.equal(calls(host, 'hub.preview').length, 0)
  await view.unmount()
})

test('部分完成區分尚未執行與略過，查看結果開啟回傳來源而不重送操作', async () => {
  const { host } = fixtureHost({ status: 'needs_attention', workspaceId: workspaces[0].id,
    message: '合併已停止。', steps: [
      { id: 'commit', label: '沿用提交', status: 'skipped', detail: '沒有新變更' },
      { id: 'merge', label: '合併', status: 'failed', detail: '有衝突' },
      { id: 'open', label: '開啟', status: 'skipped', detail: '尚未執行' },
      { id: 'cleanup', label: '清理', status: 'skipped', detail: '尚未執行' }
    ] })
  const view = await mount(panel, { host })
  await view.press({ testId: `finish:${workspaces[0].id}` })
  await view.press({ text: '下一步：確認' })
  await view.press({ text: '確認，開始合併' })
  assert.equal(view.findAll({ type: 'Badge', text: '尚未執行' }).length, 2)
  assert.equal(view.findAll({ type: 'Badge', text: '略過' }).length, 1)
  assert.equal(view.find({ label: '完成了' }), null)
  await view.press({ text: '開啟「登入功能」資料夾' })
  assert.deepEqual((calls(host, 'hub.open')[0].params as { input: unknown }).input, { workspaceId: workspaces[0].id })
  assert.equal(calls(host, 'hub.execute').length, 1)
  await view.press({ text: '隱藏結果' })
  assert.equal(view.find({ label: '還沒全部完成' }), null)
  await view.unmount()
})

test('沒有專案提供加入指引，只有主要分支時提供開始工作的指引', async () => {
  const emptyHost = mockHost({ requests: {
    'hub.list': { workspaces: [], warnings: [] },
    'hub.dashboard': { workspaces: [], warnings: [], repoId: '', summaries: [] }
  } })
  const empty = await mount(panel, { host: emptyHost })
  assert.ok(empty.find({ label: '先加入一個專案' }))
  assert.equal(empty.find({ text: '開始新工作' }), null)
  await empty.unmount()
  const onlyMain = [workspaces[1]]
  const host = mockHost({ requests: { ...requests,
    'hub.list': { workspaces: onlyMain, warnings: [] },
    'hub.dashboard': { ...dashboardFor(), workspaces: onlyMain }
  } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '還沒有進行中的工作。點「開始新工作」建立第一個。' }))
  assert.equal(view.find({ text: '完成這個工作' }), null)
  await view.press({ text: '開始新工作' })
  assert.ok(view.find({ text: '從 main 開始' }))
  await view.unmount()
})
