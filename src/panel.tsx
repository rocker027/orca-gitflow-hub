import {
  Badge, Box, Button, Callout, Card, Checkbox, Code, Collapsible, EmptyState, env, Grid, Heading, IconButton, Image,
  Input, Link, List, ListItem, read, Row, Select, Separator, Spinner, Stack, Text, Textarea, type PanelContext
} from 'orca'
import type { Workspace, WorkspaceSummary } from './contracts'
import type { FinishStrategy } from './protocol'
import {
  branchName, canFinish, createAndOpen, currentWorkspace, defaultTarget, edit, executePreview, finishBlocker,
  finishCommitMessage, finishTargets, invalidatePreview, openWorkspace,
  finishWithRebase, previewFinish, projectWorkspaces, refresh, returnToList, safeWebUrl, selectedWorkspace,
  selectProject, selectWorkspace, setupState, startWork, state
} from './panel-state'

const AGENTS = [
  { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }, { value: 'omp', label: 'OMP' }
]

/** Orca 單一文字節點最多 16 KiB，收合內容也會驗證。只限制顯示，不改預覽或 Git 資料。 */
function LongCode({ text }: { text: string }) {
  const limit = 64_000
  const chunks: string[] = []
  let end = Math.min(text.length, limit)
  const highSurrogate = (index: number) => text.charCodeAt(index) >= 0xd800 && text.charCodeAt(index) <= 0xdbff
  if (end < text.length && highSurrogate(end - 1)) end--
  for (let start = 0; start < end;) {
    let next = Math.min(start + 8_000, end)
    if (next < end && highSurrogate(next - 1)) next--
    chunks.push(text.slice(start, next))
    start = next
  }
  return <Stack gap="xs">
    {text.length > end && <Text size="sm" tone="warning">
      內容較長，此處僅顯示部分內容，不影響實際合併。完整差異請在 Orca 版本控制查看。
    </Text>}
    {chunks.map((chunk, index) => <Code key={index} block>{chunk}</Code>)}
  </Stack>
}

function summaryOf(workspace: Workspace): WorkspaceSummary | undefined {
  return read(state.dashboard)?.summaries.find((entry) => entry.workspaceId === workspace.id)
}

/** 分開檔案與提交狀態，避免窄側欄把兩件事擠成一長句。讀取失敗不當作乾淨。 */
function WorkspaceStatus({ workspace }: { workspace: Workspace }) {
  const summary = summaryOf(workspace)
  if (!summary || summary.error) return <Text size="sm" tone={read(state.busy) && !summary?.error ? 'neutral' : 'warning'}>
    {read(state.busy) && !summary?.error ? '正在讀取變更…' : '暫時無法讀取變更'}
  </Text>
  const target = defaultTarget()
  return <Stack gap="xs">
    <Row gap="xs" wrap>
      {summary.changedFiles ? <Badge tone="warning">{`${summary.changedFiles} 個檔案未提交`}</Badge>
        : <Text size="sm" muted>沒有未提交的變更</Text>}
    </Row>
    {canFinish(workspace) && target && Boolean(summary.ahead) &&
      <Text size="sm" muted>{`${summary.ahead} 個提交待合併至 ${branchName(target)}`}</Text>}
  </Stack>
}

function WorkspaceTitle({ workspace, current = false }: { workspace: Workspace; current?: boolean }) {
  const branch = summaryOf(workspace)?.branch.replace(/^refs\/heads\//, '') || branchName(workspace)
  const title = workspace.displayName || branch
  return <Stack gap="xs">
    {current ? <Heading level={2}>{title}</Heading> : <Text weight="semibold">{title}</Text>}
    {title !== branch && <Text muted size="sm">{branch}</Text>}
  </Stack>
}

/** 首頁主角：Orca 目前開啟的工作。功能工作直接提供「完成這個工作」，主要分支則引導開始新工作。 */
function CurrentWork({ workspace }: { workspace: Workspace }) {
  const disabled = read(state.executing)
  const working = canFinish(workspace)
  return <Box key="current-work" background="muted" border radius="lg" padding="md">
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm" wrap>
        <Text size="sm" muted>{working ? '目前工作' : '目前在主要分支'}</Text>
        <Badge tone="accent">已開啟</Badge>
      </Row>
      <WorkspaceTitle workspace={workspace} current />
      <WorkspaceStatus workspace={workspace} />
      {!working && <Text size="sm" muted>主要分支用來接收完成的工作。</Text>}
      {working && <Stack align="stretch">
        <Button key={`finish:${workspace.id}`} variant="solid" icon="check" disabled={disabled}
          onPress={() => selectWorkspace(workspace.id, 'finish')}>完成這個工作</Button>
      </Stack>}
    </Stack>
  </Box>
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const disabled = read(state.executing)
  const primary = !canFinish(workspace)
  return <ListItem key={`workspace:${workspace.id}`}>
    <Box paddingY="sm" width="100%" minWidth={0} gap="sm">
      <WorkspaceTitle workspace={workspace} />
      <WorkspaceStatus workspace={workspace} />
      <Row gap="sm" wrap>
        <Button key={`open:${workspace.id}`} variant="outline" size="sm" icon="folder" disabled={disabled || read(state.busy)}
          onPress={() => openWorkspace(workspace.id)}>{primary ? '開啟分支' : '切換過去'}</Button>
        {!primary && <Button key={`finish:${workspace.id}`} variant="ghost" size="sm" icon="check" disabled={disabled}
          onPress={() => selectWorkspace(workspace.id, 'finish')}>完成工作</Button>}
      </Row>
    </Box>
  </ListItem>
}

/** 目前工作以外的清單：其他進行中的工作在前，主要分支在後。 */
function WorkspaceList() {
  const query = read(state.search).trim().toLocaleLowerCase()
  const current = currentWorkspace()
  const others = projectWorkspaces().filter((workspace) => workspace.id !== current?.id)
  const matches = others.filter((workspace) =>
    `${branchName(workspace)} ${workspace.displayName}`.toLocaleLowerCase().includes(query))
  const working = Boolean(current && canFinish(current))
  const tasks = matches.filter(canFinish)
  const primary = matches.filter((workspace) => !canFinish(workspace))
  const title = working ? '其他進行中的工作' : '進行中的工作'
  return <Stack gap="md">
    <Row justify="between" align="center" gap="sm" wrap>
      <Row gap="sm" align="center">
        <Text weight="semibold">{title}</Text>
        <Badge>{tasks.length}</Badge>
      </Row>
      <Button variant={working ? 'outline' : 'solid'} icon="add" size="sm" disabled={read(state.busy) || !selectedWorkspace()}
        onPress={startWork}>開始新工作</Button>
    </Row>
    {others.length > 5 && <Input label="搜尋工作" type="search" value={read(state.search)} placeholder="輸入工作名稱或分支名稱"
      disabled={read(state.executing)} onChange={(value) => edit(state.search, value)} />}
    {tasks.length > 0 && <List label={title}>{tasks.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}</List>}
    {!read(state.busy) && !query && !tasks.length && <Box paddingY="md">
      <Text muted size="sm">{working ? '沒有其他進行中的工作。' : '還沒有進行中的工作。點「開始新工作」建立第一個。'}</Text>
    </Box>}
    {primary.length > 0 && <Stack gap="sm">
      <Separator />
      <Text size="sm" muted>主要分支</Text>
      <List label="主要分支">{primary.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}</List>
    </Stack>}
    {!read(state.busy) && query && matches.length === 0 && <EmptyState title="找不到這個工作"
      description="試試其他名稱，或清除搜尋查看全部工作。">
      <Button variant="outline" onPress={() => edit(state.search, '')}>清除搜尋</Button>
    </EmptyState>}
  </Stack>
}

function Home() {
  const workspaces = projectWorkspaces()
  const current = currentWorkspace()
  if (!workspaces.length) {
    return read(state.busy) || read(state.error) ? null : <EmptyState
      title="先加入一個專案" description="請在 Orca 開啟已有 Git 提交的本機專案，再按「重新整理」。" />
  }
  return <Stack gap="lg">
    {current && <CurrentWork workspace={current} />}
    {!read(state.busy) && !selectedWorkspace() && <Text tone="warning" size="sm">請先重新整理專案狀態，再建立工作。</Text>}
    <WorkspaceList />
  </Stack>
}

function CreateWorkspace() {
  const workspace = selectedWorkspace()
  const disabled = read(state.busy) || !workspace
  return <Card title="開始新工作">
    <Stack gap="md">
      <Stack gap="xs">
        <Input label="工作名稱" value={read(state.name)} disabled={disabled} maxLength={100}
          placeholder="例如：修正登入畫面" onChange={(value) => edit(state.name, value)} />
        <Text muted size="sm">也會用作分支名稱，請勿加空格。</Text>
      </Stack>
      <Text>{`從 ${read(state.base) || '尚未選擇的分支'} 開始`}</Text>
      <Collapsible title="調整起點與 AI 助手" disabled={read(state.executing)}>
        <Stack gap="sm">
          <Input label="起點分支" value={read(state.base)} disabled={disabled}
            placeholder="例如 main" onChange={(value) => edit(state.base, value)} />
          <Select label="建立後啟動 AI 助手" value={read(state.createAgent) || 'none'} disabled={disabled}
            options={[{ value: 'none', label: '不啟動，稍後自行選擇' }, ...AGENTS]}
            onChange={(value) => edit(state.createAgent, value === 'none' ? '' : value)} />
          {read(state.createAgent) && <Textarea label="請 AI 做什麼" value={read(state.prompt)} disabled={disabled} rows={3}
            placeholder="描述希望完成的工作" onChange={(value) => edit(state.prompt, value)} />}
        </Stack>
      </Collapsible>
      {read(state.createAgent) && <Text size="sm">{`建立後會啟動 ${AGENTS.find((agent) => agent.value === read(state.createAgent))?.label}。`}</Text>}
      {!read(state.base).trim() && <Text tone="warning" size="sm">請展開「調整起點與 AI 助手」，填寫起點分支。</Text>}
      <Button variant="solid" disabled={disabled || !read(state.name).trim() || !read(state.base).trim()}
        onPress={createAndOpen}>建立並開啟工作</Button>
    </Stack>
  </Card>
}

/** 圖使用相同的分歧範例；透明圖資依宿主主題切換，不冒充目前專案的提交圖。 */
function FinishDiagram({ strategy }: { strategy: FinishStrategy }) {
  const squash = read(state.finishSquash)
  const dark = env.theme.colorScheme === 'dark'
  const alt = strategy === 'merge'
    ? (squash ? '目標 A、B、C 與來源合成提交 S，由合併提交 M 接起。'
      : '目標 A、B、C 與來源 1、2，由合併提交 M 接起；1、2 保持原樣。')
    : (squash ? '來源先合成再重播為 S′，接在目標 A、B、C 後面。'
      : '來源 1、2 重播成 1′、2′，接在目標 A、B、C 後面，提交編號改變。')
  return <Box maxWidth={360} width="100%">
    <Image src={`src/assets/finish-${strategy}${squash ? '-squash' : ''}${dark ? '-dark' : ''}.png`}
      size="full" fit="contain" alt={alt} />
  </Box>
}

/** ListItem 提供整張卡片的按鈕與鍵盤操作，卡片內只放靜態內容。 */
function FinishStrategyCard({ strategy }: { strategy: FinishStrategy }) {
  const selected = read(state.finishStrategy) === strategy
  const squash = read(state.finishSquash)
  const name = strategy === 'merge' ? 'Merge' : 'Rebase'
  return <List label={`${name} 收尾方式`}>
    <ListItem key={`finish-strategy:${strategy}`} current={selected} disabled={read(state.busy)}
      onPress={() => edit(state.finishStrategy, strategy)}>
      <Box border={selected ? 'accent' : true} background={selected ? 'muted' : 'none'} radius="lg" padding="md" width="100%">
        <Stack gap="md">
          <Row gap="sm" justify="between" wrap>
            <Text size="md" weight="semibold">{`${selected ? '◉' : '○'} ${name}`}</Text>
            {selected && <Badge tone="neutral">已選擇</Badge>}
          </Row>
          <Text>{strategy === 'merge'
            ? (squash ? '先把我的提交合成一個，再合回。' : '保留我的提交，把兩邊接起來。')
            : (squash ? '先合成一個提交，接到目標後再合回。' : '先把我的提交接到目標後面，再合回。')}</Text>
          <FinishDiagram strategy={strategy} />
          <Text size="sm" muted>{strategy === 'merge'
            ? (squash ? '來源提交會改寫；分歧時仍可能多一個合併提交 M。' : '不改寫既有提交；分歧時多一個合併提交 M。')
            : '重播會改變提交編號；之後由工具快轉目標，完成合回。'}</Text>
        </Stack>
      </Box>
    </ListItem>
  </List>
}

function FinishStrategies() {
  return <Stack gap="sm">
    <Text weight="semibold">用哪一種方式收尾？</Text>
    <Grid minItemWidth="lg" gap="sm">
      <FinishStrategyCard strategy="merge" />
      <FinishStrategyCard strategy="rebase" />
    </Grid>
  </Stack>
}

function FinishDestination({ workspace, targets }: { workspace: Workspace; targets: Workspace[] }) {
  return <Row gap="sm" align="center">
    <Box grow width={0} minWidth={0}>
      <Text muted size="sm">要收尾的 worktree</Text>
      <Text weight="semibold">{branchName(workspace)}</Text>
    </Box>
    <Box width={24} shrink={false} align="center"><Text>→</Text></Box>
    <Box grow width={0} minWidth={130}>
      <Text muted size="sm">合回哪個本機分支？</Text>
      {targets.length > 0 && <Select label="合併到" labelHidden value={read(state.finishTargetId)} disabled={read(state.busy)}
        options={targets.map((entry) => ({ value: entry.id,
          label: `${branchName(entry)}${!canFinish(entry) ? '（主要分支）' : ''}` }))}
        onChange={(value) => edit(state.finishTargetId, value)} />}
      {!targets.length && <Text size="sm" tone="warning">還沒有可以合併的分支</Text>}
    </Box>
  </Row>
}

function FinishNotices() {
  const workspace = selectedWorkspace()
  return <Stack gap="sm">
    {(read(state.finishStrategy) === 'rebase' || read(state.finishSquash)) &&
      <Callout tone="warning" title="這個工作的提交編號可能改變">
        若分支已分享，請先與協作者確認。不會自動 force push。
      </Callout>}
    {read(state.removeAfterFinish) && workspace && <Callout tone="warning" title="完成後移除這個工作資料夾">
      <Stack gap="xs"><Text size="sm">{workspace.path}</Text><Text size="sm">清理檢查通過才移除，本機分支會保留。</Text></Stack>
    </Callout>}
  </Stack>
}

/** 收尾只需選目標與策略；合成、清理按需展開，選取後的影響仍直接可見。 */
function FinishWorkspace() {
  const workspace = selectedWorkspace()
  if (!read(state.finishOpen) || !workspace) return null
  const snapshot = read(state.snapshot)
  const targets = finishTargets()
  const busy = read(state.busy)
  const blocker = finishBlocker()
  const strategy = read(state.finishStrategy)
  const squash = read(state.finishSquash)
  const method = strategy === 'merge' ? 'Merge' : 'Rebase'
  return <Stack gap="md">
    <Stack gap="sm">
      <Heading level={1}>完成這個 worktree</Heading>
      <Text muted>選擇怎麼把這個工作的成果合回去。</Text>
    </Stack>
    <FinishDestination workspace={workspace} targets={targets} />
    {!snapshot?.files.length && <Text muted size="sm">{!snapshot ? (busy ? '正在確認變更…' : '還沒讀到變更。')
      : '沒有未提交的變更。'}</Text>}
    <Separator />
    {!targets.length && <Callout tone="warning" title="還沒有可以合併的分支">
      請先在 Orca 開啟同專案的另一個工作資料夾，再回來按「重新整理」。
    </Callout>}
    <FinishStrategies />
    <FinishFiles />
    <Separator />
    <Collapsible key={`finish-options:${workspace.id}`} title="其他選項" disabled={read(state.executing)}>
      <Stack gap="sm">
        <Checkbox label="合成 1 個提交（Squash）" checked={squash} disabled={busy}
          description="這是額外選項，會先整理並改寫這個工作的提交。"
          onChange={(checked) => edit(state.finishSquash, checked)} />
        <Checkbox label="完成後移除資料夾" description="預設保留資料夾與分支。勾選後仍須通過清理檢查。"
          checked={read(state.removeAfterFinish)} disabled={busy}
          onChange={(checked) => edit(state.removeAfterFinish, checked)} />
      </Stack>
    </Collapsible>
    {squash && <Text size="sm">{`目前選擇：Squash + ${method}，會先把這個工作的提交合成一個。`}</Text>}
    {squash && strategy === 'merge' && <Stack gap="xs">
      <Text size="sm">目標有新進度時，可能再多 1 個合併提交。</Text>
      <Button variant="outline" size="sm" disabled={busy} onPress={finishWithRebase}>改用 Rebase</Button>
    </Stack>}
    <FinishNotices />
    <Stack gap="xs" align="stretch">
      {blocker && <Text size="sm">{blocker}</Text>}
      <Button variant="solid" disabled={busy || Boolean(blocker)} onPress={previewFinish}>{`預覽 ${method} 收尾`}</Button>
      <Text muted size="sm">先檢查，確認後才會合併。只更新本機，不 Push。</Text>
    </Stack>
  </Stack>
}

function FinishFiles() {
  const files = read(state.snapshot)?.files ?? []
  if (!files.length) return null
  return <Stack gap="xs">
    <Text weight="medium">{`會先提交全部 ${files.length} 個變更檔案`}</Text>
    <Text size="sm">包含已暫存、未暫存及新增檔案。若要分批提交，請先在 Orca 版本控制處理。</Text>
    <Collapsible title={`收尾時提交 ${files.length} 個檔案`}>
      <Stack gap="xs">{files.map((file) => <Text key={file.path} size="sm">{file.path}</Text>)}</Stack>
    </Collapsible>
  </Stack>
}

/** 確認頁保留結果與提醒，執行步驟及技術細節按需展開。 */
function FinishPreview() {
  const preview = read(state.preview)
  if (!preview) return null
  const source = selectedWorkspace()
  const target = finishTargets().find((workspace) => workspace.id === read(state.finishTargetId))
  return <Card title="最後確認">
    <Stack gap="sm">
      {source && target && <Text weight="semibold">{`${branchName(source)} → ${branchName(target)}`}</Text>}
      <Callout tone="accent" title="完成後會變成這樣">{preview.summary}</Callout>
      {preview.warnings?.map((warning, index) => <Callout key={index} tone={warning.tone ?? 'warning'} title={warning.title}>
        <Stack gap="sm">
          <Text>{warning.text}</Text>
          {warning.fix === 'rebase' && target && <Button variant="outline" size="sm" disabled={read(state.busy)}
            onPress={finishWithRebase}>{`改成讓 ${branchName(target)} 只多 1 個提交`}</Button>}
        </Stack>
      </Callout>)}
      <Collapsible title="執行步驟與提交訊息">
        <Stack gap="sm">
          {preview.steps?.map((step, index) => <Text key={index}>{`${index + 1}. ${step}`}</Text>)}
          {finishCommitMessage() && <Text>{`提交訊息：${finishCommitMessage()}（自動產生）`}</Text>}
        </Stack>
      </Collapsible>
      <FinishFiles />
      <FinishNotices />
      {!read(state.removeAfterFinish) && <Text size="sm">完成後保留工作資料夾與分支。</Text>}
      <Collapsible title="技術細節"><LongCode text={preview.detail} /></Collapsible>
      <Text muted size="sm">只更新本機，不上傳 GitHub。</Text>
      {read(state.executing) ? <Text tone="accent" weight="medium">正在合併，請勿關閉 Orca。</Text>
        : <Row gap="sm" wrap>
          <Button variant="solid" disabled={read(state.busy)} onPress={executePreview}>{`確認 ${read(state.finishStrategy) === 'merge' ? 'Merge' : 'Rebase'} 到 ${target ? branchName(target) : '目標分支'}`}</Button>
          <Button disabled={read(state.busy)} variant="ghost" onPress={invalidatePreview}>返回修改</Button>
        </Row>}
    </Stack>
  </Card>
}

function PreviewCard() {
  const preview = read(state.preview)
  if (!preview) return null
  if (read(state.finishOpen)) return <FinishPreview />
  return <Card title={preview.title}>
    <Stack gap="sm">
      <Callout tone="warning" title="確認後會執行以下操作">{preview.summary}</Callout>
      <Collapsible title="預覽細節" defaultOpen><LongCode text={preview.detail} /></Collapsible>
      {read(state.executing) ? <Text tone="accent" weight="medium">正在執行，請稍候。</Text>
        : <Row gap="sm" wrap>
          <Button disabled={read(state.busy)} onPress={executePreview}>確認執行</Button>
          <Button disabled={read(state.busy)} variant="ghost" onPress={invalidatePreview}>返回修改</Button>
        </Row>}
    </Stack>
  </Card>
}

function ExecutionResult() {
  const execution = read(state.execution)
  if (!execution) return null
  const partial = execution.status === 'needs_attention' || execution.steps?.some((step) => step.status === 'failed')
  const url = safeWebUrl(execution.url ?? '')
  const resultWorkspace = projectWorkspaces().find((workspace) => workspace.id === execution.workspaceId)
  const resultName = resultWorkspace?.displayName || (resultWorkspace ? branchName(resultWorkspace) : '工作')
  return <Card title={partial ? '還沒全部完成' : '完成了'}>
    <Stack gap="sm">
      <Callout tone={partial ? 'warning' : 'success'} title={partial ? '需要處理' : '已完成'}>{execution.message}</Callout>
      {Boolean(execution.steps?.length) && <Collapsible key={partial ? 'partial' : 'completed'} title="執行明細" defaultOpen={Boolean(partial)}>
        <Stack gap="sm">
          {execution.steps?.map((step) => <Stack key={step.id} gap="xs">
            <Row gap="xs"><Badge tone={step.status === 'failed' ? 'warning' : 'neutral'}>
              {step.status === 'done' ? '完成' : step.status === 'skipped' ? (step.detail === '尚未執行' ? '尚未執行' : '略過') : '未完成'}
            </Badge><Text weight="medium">{step.label}</Text></Row>
            {/* 失敗原因已寫在上方提示框時不再重複整段。 */}
            {!(step.status === 'failed' && execution.message.includes(step.detail)) && <Text size="sm">{step.detail}</Text>}
          </Stack>)}
        </Stack>
      </Collapsible>}
      {partial && <Text size="sm">已完成步驟不會自動復原。不確定時請先找人協助，別急著重試。</Text>}
      {execution.workspaceId && projectWorkspaces().some((workspace) => workspace.id === execution.workspaceId) &&
        <Button variant="ghost" disabled={read(state.busy)}
          onPress={() => openWorkspace(execution.workspaceId)}>{`開啟「${resultName}」資料夾`}</Button>}
      {url && <Link href={url}>開啟操作結果</Link>}
      <Button variant="ghost" disabled={read(state.busy)} onPress={() => edit(state.execution, null)}>隱藏結果</Button>
    </Stack>
  </Card>
}

export function setup(ctx: PanelContext): void { setupState(ctx) }

export default function Panel() {
  const list = read(state.list)
  const focused = read(state.finishOpen) || read(state.detailsOpen) || read(state.createOpen)
  const preview = read(state.preview)
  const repositories = [...new Map(list.workspaces.map((workspace) => [workspace.repoId,
    { value: workspace.repoId, label: workspace.repoName || workspace.repoId }])).values()]
  return <Stack gap="md">
    <Row justify="between" wrap>
      {focused ? <Button variant="ghost" disabled={read(state.executing)} onPress={returnToList}>返回工作清單</Button>
        : <Heading>工作管理</Heading>}
      <IconButton icon="refresh" label="重新整理" variant="ghost" disabled={read(state.busy)}
        onPress={() => { if (!read(state.busy) && !read(state.executing)) return refresh() }} />
    </Row>
    {repositories.length > 1 && <Select label="專案" labelHidden value={read(state.repoId)} options={repositories}
      disabled={read(state.executing)} onChange={selectProject} />}
    {read(state.busy) && <Spinner label={!read(state.executing) ? '正在讀取，請稍候…'
      : read(state.execution)?.status === 'completed' ? '已完成，正在更新畫面…'
      : read(state.execution) ? '正在更新畫面…' : '正在執行，請稍候…'} />}
    {read(state.error) && <Callout tone="danger" title="這一步沒有完成">
      <Stack gap="xs">
        <Text>{read(state.error)}</Text>
        <Text size="sm">若操作結果不明，請先重新整理並查看工作。確認目前狀態後，再決定是否重試。</Text>
      </Stack>
    </Callout>}
    {read(state.notice) && <Text>{read(state.notice)}</Text>}
    {list.warnings.map((warning, index) => <Callout key={index} tone="warning">{warning}</Callout>)}
    <ExecutionResult />
    {preview ? <PreviewCard /> : focused && <Stack gap="md">
      {read(state.createOpen) && <CreateWorkspace />}
      <FinishWorkspace />
    </Stack>}
    {!focused && <Home />}
  </Stack>
}
