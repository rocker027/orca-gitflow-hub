import {
  Badge, Button, Callout, Card, Checkbox, Code, Collapsible, EmptyState, Heading,
  Input, Link, read, Row, Select, Spinner, Stack, Text, Textarea, type PanelContext
} from 'orca'
import type { Workspace } from './contracts'
import {
  branchName, canFinish, createAndOpen, edit, executePreview, finishTargets, importAiMessage, inspectWorkspace,
  invalidatePreview, loadPr, loadPrs, openWorkspace, previewFinish, projectWorkspaces,
  refresh, requestPreview, returnToList, safeWebUrl, selectedWorkspace, selectProject, selectWorkspace,
  setupState, state, toggleGithub
} from './panel-state'

const AGENTS = [
  { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }, { value: 'omp', label: 'OMP' }
]

function AgentField() {
  return <Select label="AI 草稿 Agent" value={read(state.agent)} options={AGENTS}
    disabled={read(state.busy)} onChange={(value) => edit(state.agent, value)} />
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const summary = read(state.dashboard)?.summaries.find((entry) => entry.workspaceId === workspace.id)
  const branch = summary?.branch.replace(/^refs\/heads\//, '') || branchName(workspace)
  const disabled = read(state.executing)
  return <Card key={`workspace:${workspace.id}`}>
    <Stack gap="xs">
      <Row justify="between" wrap>
        <Text weight="semibold">{branch}</Text>
        <Row gap="xs" wrap>
          {workspace.id === read(state.workspaceId) && <Badge tone="accent">已選取</Badge>}
          {workspace.isActive && <Badge>目前</Badge>}
          {workspace.isMainWorktree && <Badge>主要</Badge>}
          {workspace.isDefaultBranch && <Badge>預設分支</Badge>}
        </Row>
      </Row>
      <Row gap="sm" wrap>
        <Text size="sm" tone={summary?.error ? 'warning' : 'neutral'}>
          {!summary || summary.error ? '變更：UNKNOWN' : summary.changedFiles ? `${summary.changedFiles} 個變更` : '乾淨'}
        </Text>
        <Text muted size="sm">{`領先 ${summary?.ahead ?? '?'} · 落後 ${summary?.behind ?? '?'}`}</Text>
      </Row>
      <Text muted size="xs" truncate>{summary?.error || summary?.lastMessage || '尚無提交摘要'}</Text>
      <Row gap="xs" wrap>
        <Button key={`inspect:${workspace.id}`} size="sm" variant="ghost" disabled={disabled}
          onPress={() => selectWorkspace(workspace.id)}>檢視</Button>
        <Button key={`open:${workspace.id}`} size="sm" variant="ghost" disabled={disabled || read(state.busy)}
          onPress={() => openWorkspace(workspace.id)}>在 Orca 開啟</Button>
        <Button key={`finish:${workspace.id}`} size="sm" variant="outline" disabled={disabled || !canFinish(workspace)}
          onPress={() => selectWorkspace(workspace.id, 'finish')}>收尾</Button>
      </Row>
    </Stack>
  </Card>
}

function WorkspaceList() {
  const query = read(state.search).trim().toLocaleLowerCase()
  const rows = projectWorkspaces().filter((workspace) =>
    `${branchName(workspace)} ${workspace.displayName}`.toLocaleLowerCase().includes(query))
  return <Stack gap="sm">
    {rows.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}
    {!read(state.busy) && rows.length === 0 && <EmptyState
      title={query ? '沒有符合搜尋的工作樹' : '此專案沒有工作樹'} />}
  </Stack>
}

function CreateWorkspace() {
  const workspace = selectedWorkspace() ?? projectWorkspaces()[0]
  const disabled = read(state.busy) || !workspace
  return <Collapsible title="新增工作樹" open={read(state.createOpen)} onChange={(open) => edit(state.createOpen, open)}>
    <Stack gap="sm">
      <Input label="新分支名稱" value={read(state.name)} disabled={disabled} maxLength={100}
        placeholder="例如 feature/login" onChange={(value) => edit(state.name, value)} />
      <Input label="基準分支（必填）" value={read(state.base)} disabled={disabled}
        onChange={(value) => edit(state.base, value)} />
      <Select label="建立後啟動 Agent" value={read(state.createAgent) || 'none'} disabled={disabled}
        options={[{ value: 'none', label: '不啟動 Agent' }, ...AGENTS]}
        onChange={(value) => edit(state.createAgent, value === 'none' ? '' : value)} />
      {read(state.createAgent) && <Textarea label="開發任務" value={read(state.prompt)} disabled={disabled} rows={3}
        onChange={(value) => edit(state.prompt, value)} />}
      <Button disabled={disabled || !read(state.name).trim() || !read(state.base).trim()}
        onPress={createAndOpen}>建立並開啟</Button>
    </Stack>
  </Collapsible>
}

function FinishWorkspace() {
  const workspace = selectedWorkspace()
  if (!read(state.finishOpen) || !workspace) return null
  const snapshot = read(state.snapshot)
  const targets = finishTargets()
  const hasChanges = Boolean(snapshot?.files.length)
  const disabled = read(state.busy) || !snapshot || !canFinish(workspace) || !targets.length
    || (hasChanges && !read(state.finishMessage).trim())
  return <Card title={`收尾：${branchName(workspace)}`}>
    <Stack gap="sm">
      <Text>提交全部變更 → 合回目標分支 → 開啟目標 → 清理工作樹</Text>
      {targets.length > 0 && <Select label="合回目標工作樹" value={read(state.finishTargetId)} disabled={read(state.busy)}
        options={targets.map((target) => ({ value: target.id, label: branchName(target) }))}
        onChange={(value) => edit(state.finishTargetId, value)} />}
      {!targets.length && <Callout tone="warning">需要另一個同專案工作樹作為合併目標。</Callout>}
      {!snapshot && <Text muted>尚未取得來源狀態，無法預覽收尾。</Text>}
      {snapshot && <Stack gap="xs">
        <Text weight="medium">{hasChanges ? `將提交全部 ${snapshot.files.length} 個變更檔案` : '沒有未提交的變更，會略過提交。'}</Text>
        {snapshot.files.map((file) => <Text key={file.path} size="sm">{`${file.index}${file.working} ${file.path}`}</Text>)}
        {hasChanges && <Textarea label="收尾提交訊息" value={read(state.finishMessage)} disabled={read(state.busy)} rows={3}
          onChange={(value) => edit(state.finishMessage, value)} />}
      </Stack>}
      <Checkbox label="完成後清理來源工作樹" description="只在確認已合併且可以安全清理時移除，保留本機分支。"
        checked={read(state.removeAfterFinish)} disabled={read(state.busy)}
        onChange={(checked) => edit(state.removeAfterFinish, checked)} />
      <Button disabled={disabled} onPress={previewFinish}>預覽收尾</Button>
    </Stack>
  </Card>
}

function GitFiles() {
  const snapshot = read(state.snapshot)
  const paths = read(state.selectedPaths)
  if (!snapshot) return <EmptyState title="尚未取得 Git 狀態" />
  return <Stack gap="sm">
    <Row justify="between"><Text>{snapshot.branch || '游離 HEAD'}</Text><Badge>{snapshot.files.length} 個變更</Badge></Row>
    <Code>{snapshot.head || '尚無提交'}</Code>
    {snapshot.files.map((file) => <Checkbox key={file.path} label={file.path}
      description={`${file.index}${file.working}${file.originalPath ? ` ← ${file.originalPath}` : ''}`}
      checked={paths.includes(file.path)} disabled={read(state.busy)} onChange={(checked) => {
        edit(state.selectedPaths, checked ? [...paths, file.path] : paths.filter((path) => path !== file.path))
      }} />)}
    {snapshot.files.length === 0 && <Text muted>工作目錄沒有變更。</Text>}
    <Row gap="sm" wrap>
      <Button disabled={read(state.busy) || paths.length === 0} onPress={() => requestPreview({
        kind: 'stage', workspaceId: read(state.workspaceId), paths, fingerprint: snapshot.fingerprint
      })}>預覽暫存選取檔案</Button>
      <Button variant="ghost" disabled={read(state.busy)} onPress={inspectWorkspace}>重新讀取 Git</Button>
    </Row>
    <Collapsible title="工作目錄差異"><Code block>{snapshot.workingDiff || '沒有工作目錄差異。未追蹤檔案尚未出現在 Git Diff。'}</Code></Collapsible>
    <Collapsible title="已暫存差異"><Code block>{snapshot.stagedDiff || '尚未暫存任何差異。'}</Code></Collapsible>
  </Stack>
}

function Git() {
  const disabled = read(state.busy) || !read(state.workspaceId)
  return <Stack gap="md">
    <GitFiles />
    <Card title="提交">
      <Stack gap="sm">
        <Textarea label="提交訊息" value={read(state.message)} disabled={disabled} rows={4}
          onChange={(value) => edit(state.message, value)} />
        <Text muted size="xs">提交包含所有已暫存檔案。預覽會列出內容，並依專案設定執行 Git hooks。</Text>
        <Button disabled={disabled || !read(state.message).trim()} onPress={() => requestPreview({
          kind: 'commit', workspaceId: read(state.workspaceId), message: read(state.message)
        })}>預覽提交</Button>
        <Collapsible title="AI 提交訊息草稿">
          <Stack gap="sm">
            <AgentField />
            <Text size="sm">由選定 Agent 產生草稿。完成後匯入，檢查訊息再提交。</Text>
            <Row gap="sm" wrap>
              <Button variant="outline" disabled={disabled} onPress={() => requestPreview({
                kind: 'ai-message', workspaceId: read(state.workspaceId), agent: read(state.agent)
              })}>預覽委派 AI 草稿</Button>
              <Button variant="ghost" disabled={disabled} onPress={importAiMessage}>匯入 AI 草稿</Button>
            </Row>
          </Stack>
        </Collapsible>
      </Stack>
    </Card>
  </Stack>
}

function PrDetail() {
  const detail = read(state.pr)
  if (!detail) return null
  const { pr } = detail
  const url = safeWebUrl(pr.url)
  const reviewDecision = {
    approved: '已核准', changes_requested: '要求修改', review_required: '仍需審查', unknown: 'UNKNOWN'
  }[detail.reviewDecision]
  return <Card title={`#${pr.number} ${pr.title}`}>
    <Stack gap="sm">
      <Text>{`${pr.headBranch} → ${pr.baseBranch}`}</Text>
      <Row gap="xs" wrap><Badge>{pr.state}</Badge>{pr.draft && <Badge tone="warning">草稿</Badge>}</Row>
      <Text muted size="xs">來源提交</Text><Code>{pr.headSha}</Code>
      <Text muted size="xs">目標提交</Text><Code>{pr.baseSha}</Code>
      <Text>{detail.checks.length ? `CI：${detail.checks.length} 項檢查` : 'CI：UNKNOWN（尚無檢查結果）'}</Text>
      <Text>{`審查決策：${reviewDecision}`}</Text>
      <Text>{`合併狀態：${detail.mergeStateStatus || 'UNKNOWN'}`}</Text>
      <Text>{`衝突檢查：${pr.mergeable === null ? 'UNKNOWN' : pr.mergeable ? '無衝突' : '有衝突'}`}</Text>
      <Text muted size="xs">狀態供參考。合併資格與最終操作由 GitHub 判定。</Text>
      {detail.warnings.map((warning, i) => <Callout key={i} tone="warning">{warning}</Callout>)}
      <Collapsible title={`CI 檢查（${detail.checks.length}）`}>
        <Stack gap="sm">
          {detail.checks.length === 0 && <Text muted>尚無可顯示的檢查。</Text>}
          {detail.checks.map((check, i) => <Card key={i} title={check.name}>
            <Text>{`狀態：${check.status} · 結果：${check.conclusion ?? 'UNKNOWN'}`}</Text>
            <Code>{check.sha}</Code>
            {check.sha !== pr.headSha && <Badge tone="warning">版本不同，需重新查詢</Badge>}
            {safeWebUrl(check.url ?? '') && <Link href={safeWebUrl(check.url ?? '')}>查看檢查結果</Link>}
          </Card>)}
        </Stack>
      </Collapsible>
      <Collapsible title={`審查紀錄（${detail.reviews.length}）`}>
        <Stack gap="sm">
          {detail.reviews.length === 0 && <Text muted>目前沒有可顯示的審查紀錄。</Text>}
          {detail.reviews.map((review, i) => <Card key={i} title={review.author}>
            <Text>{review.state}</Text><Code>{review.commitSha}</Code>
            {review.commitSha !== pr.headSha && <Badge tone="warning">審查的是其他提交</Badge>}
          </Card>)}
        </Stack>
      </Collapsible>
      <Collapsible title={`留言（${detail.comments.length}）`}>
        <Stack gap="sm">
          {detail.comments.length === 0 && <Text muted>目前沒有可顯示的留言。</Text>}
          {detail.comments.map((comment) => <Card key={comment.id} title={comment.author}><Text>{comment.body}</Text></Card>)}
        </Stack>
      </Collapsible>
      {url && <Link href={url}>在 GitHub 審查與合併</Link>}
    </Stack>
  </Card>
}

function GitHub() {
  const disabled = read(state.busy) || !read(state.workspaceId)
  const prs = read(state.prs)
  return <Stack gap="md">
    <Row gap="sm" wrap>
      <Button disabled={disabled} variant="outline" onPress={() => requestPreview({ kind: 'push', workspaceId: read(state.workspaceId) })}>預覽 Push</Button>
      <Button disabled={disabled} variant="ghost" onPress={loadPrs}>重新讀取 PR</Button>
    </Row>
    <Collapsible title="建立 Draft PR">
      <Stack gap="sm">
        <Input label="目標分支" value={read(state.targetBranch)} disabled={disabled} placeholder="例如 main"
          onChange={(value) => edit(state.targetBranch, value)} />
        <Input label="PR 標題" value={read(state.prTitle)} disabled={disabled}
          onChange={(value) => edit(state.prTitle, value)} />
        <Textarea label="PR 說明" value={read(state.prDescription)} disabled={disabled} rows={5}
          onChange={(value) => edit(state.prDescription, value)} />
        <Text muted size="xs">先 Push，再建立 Draft PR。現有 PR 會優先復用。</Text>
        <Button disabled={disabled || !read(state.targetBranch).trim() || !read(state.prTitle).trim()}
          onPress={() => requestPreview({ kind: 'draft', workspaceId: read(state.workspaceId),
            targetBranch: read(state.targetBranch), title: read(state.prTitle), description: read(state.prDescription) })}>預覽建立 Draft PR</Button>
      </Stack>
    </Collapsible>
    {prs === null && <Text muted>尚未取得 PR。</Text>}
    {prs?.length === 0 && <EmptyState title="目前分支沒有 PR" />}
    {prs?.map((pr) => <Button key={pr.number} variant="outline" disabled={disabled} onPress={() => loadPr(pr.number)}>
      {`#${pr.number} ${pr.title}`}
    </Button>)}
    <PrDetail />
  </Stack>
}

function WorkspaceDetails() {
  const workspace = selectedWorkspace()
  if (!read(state.detailsOpen) || !workspace) return null
  return <Card title={`檢視：${branchName(workspace)}`}>
    <Stack gap="sm">
      <Collapsible title="工作樹識別">
        <Text size="xs">{workspace.path}</Text><Code>{workspace.id}</Code>
      </Collapsible>
      <Collapsible title="Git 差異與逐檔提交"><Git /></Collapsible>
      <Collapsible title="GitHub PR" open={read(state.githubOpen)} onChange={toggleGithub}><GitHub /></Collapsible>
      <Collapsible title="只清理工作樹">
        <Stack gap="sm">
          <Input label="確認已合併至分支" value={read(state.base)} disabled={read(state.busy)}
            onChange={(value) => edit(state.base, value)} />
          <Text size="xs" muted>已在其他流程合併時，可單獨清理。仍會確認變更與 Agent 狀態。</Text>
          <Button variant="outline" tone="danger" disabled={read(state.busy) || !canFinish(workspace) || !read(state.base).trim()}
            onPress={() => requestPreview({ kind: 'cleanup', workspaceId: workspace.id, base: read(state.base) })}>預覽清理工作樹</Button>
        </Stack>
      </Collapsible>
    </Stack>
  </Card>
}

function PreviewCard() {
  const preview = read(state.preview)
  if (!preview) return null
  const source = selectedWorkspace()
  const target = finishTargets().find((workspace) => workspace.id === read(state.finishTargetId))
  return <Card title={preview.title}>
    <Stack gap="sm">
      {read(state.finishOpen) && source && target && <Text weight="semibold">{`${branchName(source)} → ${branchName(target)}`}</Text>}
      <Callout tone="warning" title="確認完整操作">{preview.summary}</Callout>
      {preview.steps?.map((step, index) => <Text key={index}>{`${index + 1}. ${step}`}</Text>)}
      <Collapsible title="預覽細節" defaultOpen={!read(state.finishOpen)}><Code block>{preview.detail}</Code></Collapsible>
      <Row gap="sm">
        <Button disabled={read(state.busy)} onPress={executePreview}>確認執行</Button>
        <Button disabled={read(state.busy)} variant="ghost" onPress={invalidatePreview}>取消預覽</Button>
      </Row>
    </Stack>
  </Card>
}

function ExecutionResult() {
  const execution = read(state.execution)
  if (!execution) return null
  const partial = execution.status === 'needs_attention' || execution.steps?.some((step) => step.status === 'failed')
  const url = safeWebUrl(execution.url ?? '')
  return <Card title={partial ? '操作尚未完成' : '操作完成'}>
    <Stack gap="sm">
      <Callout tone={partial ? 'warning' : 'success'}>{execution.message}</Callout>
      {execution.steps?.map((step) => <Stack key={step.id} gap="xs">
        <Row gap="xs"><Badge tone={step.status === 'failed' ? 'warning' : 'neutral'}>
          {step.status === 'done' ? '完成' : step.status === 'skipped' ? '略過' : '未完成'}
        </Badge><Text weight="medium">{step.label}</Text></Row>
        <Text size="sm">{step.detail}</Text>
      </Stack>)}
      {partial && <Text size="sm">請核對各步結果，再依目前狀態處理未完成項目。</Text>}
      {url && <Link href={url}>開啟操作結果</Link>}
    </Stack>
  </Card>
}

export function setup(ctx: PanelContext): void { setupState(ctx) }

export default function Panel() {
  const list = read(state.list)
  const focused = read(state.finishOpen) || read(state.detailsOpen)
  const repositories = [...new Map(list.workspaces.map((workspace) => [workspace.repoId,
    { value: workspace.repoId, label: workspace.repoName || workspace.repoId }])).values()]
  return <Stack gap="md">
    <Row justify="between">
      {focused ? <Button variant="ghost" disabled={read(state.executing)} onPress={returnToList}>返回清單</Button>
        : <Heading>工作樹</Heading>}
      <Button icon="refresh" variant="ghost" size="sm" disabled={read(state.busy)}
        onPress={() => { if (!read(state.busy) && !read(state.executing)) return refresh() }}>重新整理</Button>
    </Row>
    {repositories.length > 0 && <Select label="專案" value={read(state.repoId)} options={repositories}
      disabled={read(state.executing)} onChange={selectProject} />}
    {!focused && <Input label="搜尋工作樹" type="search" value={read(state.search)} placeholder="分支或工作樹名稱"
      disabled={read(state.executing)} onChange={(value) => edit(state.search, value)} />}
    {read(state.busy) && <Spinner label={read(state.executing) ? '正在執行確認的操作' : '正在讀取工作樹'} />}
    {read(state.error) && <Callout tone="danger" title="操作未完成">{read(state.error)}</Callout>}
    {read(state.notice) && <Text>{read(state.notice)}</Text>}
    {list.warnings.map((warning, index) => <Callout key={index} tone="warning">{warning}</Callout>)}
    <ExecutionResult />
    <PreviewCard />
    <FinishWorkspace />
    <WorkspaceDetails />
    {!focused && <CreateWorkspace />}
    {!focused && <WorkspaceList />}
    {!read(state.busy) && list.workspaces.length === 0 && <Text muted>請先在 Orca 加入 Git 專案，再重新整理。</Text>}
  </Stack>
}
