import {
  Badge, Button, Callout, Card, Checkbox, Code, Collapsible, EmptyState, Heading,
  Input, Link, RadioGroup, read, Row, Select, Spinner, Stack, Text, Textarea, type PanelContext
} from 'orca'
import type { Workspace, WorkspaceSummary } from './contracts'
import type { FinishStrategy } from './protocol'
import {
  branchName, canFinish, cancelAdvice, createAndOpen, currentWorkspace, defaultTarget, edit, executePreview, finishBlocker,
  finishCommitMessage, finishTargets, importAiMessage, inspectWorkspace, invalidatePreview, loadPr, loadPrs, openWorkspace,
  finishWithRebase, previewAdvice, previewFinish, projectWorkspaces, refresh, requestPreview, returnToList, safeWebUrl, selectedWorkspace,
  selectProject, selectWorkspace, setupState, startWork, state, toggleGithub, writeAdvice
} from './panel-state'

const AGENTS = [
  { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }, { value: 'omp', label: 'OMP' }
]

function AgentField() {
  return <Select label="AI 草稿 Agent" value={read(state.agent)} options={AGENTS}
    disabled={read(state.busy)} onChange={(value) => edit(state.agent, value)} />
}

function summaryOf(workspace: Workspace): WorkspaceSummary | undefined {
  return read(state.dashboard)?.summaries.find((entry) => entry.workspaceId === workspace.id)
}

/** 一句話說明工作狀態：幾個檔案還沒提交、幾個提交還沒合併到主要分支。讀取失敗不當作乾淨。 */
function statusLine(workspace: Workspace): { text: string; warning: boolean } {
  const summary = summaryOf(workspace)
  if (!summary) return { text: read(state.busy) ? '正在讀取變更…' : '暫時無法讀取變更', warning: !read(state.busy) }
  if (summary.error) return { text: '暫時無法讀取變更', warning: true }
  const parts = [summary.changedFiles ? `${summary.changedFiles} 個檔案還沒提交` : '沒有未提交的變更']
  const target = defaultTarget()
  if (canFinish(workspace) && target && summary.ahead) parts.push(`${summary.ahead} 個提交還沒合併到 ${branchName(target)}`)
  return { text: parts.join(' · '), warning: false }
}

function WorkspaceTitle({ workspace }: { workspace: Workspace }) {
  const branch = summaryOf(workspace)?.branch.replace(/^refs\/heads\//, '') || branchName(workspace)
  const title = workspace.displayName || branch
  const status = statusLine(workspace)
  return <Stack gap="xs">
    <Text weight="semibold">{title}</Text>
    {title !== branch && <Text muted size="sm">{`分支：${branch}`}</Text>}
    <Text tone={status.warning ? 'warning' : 'neutral'}>{status.text}</Text>
  </Stack>
}

/** 首頁主角：Orca 目前開啟的工作。功能工作直接提供「完成這個工作」，主要分支則引導開始新工作。 */
function CurrentWork({ workspace }: { workspace: Workspace }) {
  const disabled = read(state.executing)
  if (!canFinish(workspace)) {
    return <Card title={`目前在主要分支：${branchName(workspace)}`}>
      <Stack gap="sm">
        <Text>主要分支用來接收完成的工作。要做新東西，請點「開始新工作」。</Text>
        <Row gap="sm" wrap>
          <Button key={`inspect:${workspace.id}`} variant="ghost" disabled={disabled}
            onPress={() => selectWorkspace(workspace.id)}>查看變更</Button>
        </Row>
      </Stack>
    </Card>
  }
  return <Card title="目前的工作">
    <Stack gap="sm">
      <WorkspaceTitle workspace={workspace} />
      <Row gap="sm" wrap>
        <Button key={`finish:${workspace.id}`} variant="solid" icon="check" disabled={disabled}
          onPress={() => selectWorkspace(workspace.id, 'finish')}>完成這個工作</Button>
        <Button key={`inspect:${workspace.id}`} variant="ghost" disabled={disabled}
          onPress={() => selectWorkspace(workspace.id)}>查看變更</Button>
      </Row>
    </Stack>
  </Card>
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const disabled = read(state.executing)
  const primary = !canFinish(workspace)
  return <Card key={`workspace:${workspace.id}`}>
    <Stack gap="sm">
      <WorkspaceTitle workspace={workspace} />
      {primary && <Text muted size="sm">主要分支，用來接收完成的工作。</Text>}
      <Row gap="sm" wrap>
        <Button key={`open:${workspace.id}`} variant="outline" disabled={disabled || read(state.busy)}
          onPress={() => openWorkspace(workspace.id)}>{primary ? '開啟主要分支' : '切換過去'}</Button>
        {!primary && <Button key={`finish:${workspace.id}`} variant="outline" disabled={disabled}
          onPress={() => selectWorkspace(workspace.id, 'finish')}>完成這個工作</Button>}
        <Button key={`inspect:${workspace.id}`} variant="ghost" disabled={disabled}
          onPress={() => selectWorkspace(workspace.id)}>查看變更</Button>
      </Row>
    </Stack>
  </Card>
}

/** 目前工作以外的清單：其他進行中的工作在前，主要分支在後。 */
function WorkspaceList() {
  const query = read(state.search).trim().toLocaleLowerCase()
  const current = currentWorkspace()
  const others = projectWorkspaces().filter((workspace) => workspace.id !== current?.id)
  const matches = others.filter((workspace) =>
    `${branchName(workspace)} ${workspace.displayName}`.toLocaleLowerCase().includes(query))
  const groups = [
    { title: current && canFinish(current) ? '其他進行中的工作' : '進行中的工作', rows: matches.filter(canFinish) },
    { title: '主要分支', rows: matches.filter((workspace) => !canFinish(workspace)) }
  ]
  return <Stack gap="md">
    {others.length > 5 && <Input label="搜尋工作" type="search" value={read(state.search)} placeholder="輸入工作名稱或分支名稱"
      disabled={read(state.executing)} onChange={(value) => edit(state.search, value)} />}
    {groups.filter((group) => group.rows.length).map((group) => <Stack key={group.title} gap="sm">
      <Heading level={2}>{group.title}</Heading>
      {group.rows.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}
    </Stack>)}
    {!read(state.busy) && query && matches.length === 0 && <EmptyState title="找不到這個工作"
      description="試試其他名稱，或清除搜尋查看全部工作。">
      <Button variant="outline" onPress={() => edit(state.search, '')}>清除搜尋</Button>
    </EmptyState>}
  </Stack>
}

function Home() {
  const workspaces = projectWorkspaces()
  const current = currentWorkspace()
  const working = Boolean(current && canFinish(current))
  if (!workspaces.length) {
    return read(state.busy) || read(state.error) ? null : <EmptyState
      title="先加入一個專案" description="請在 Orca 開啟已有 Git 提交的本機專案，再按「重新整理」。" />
  }
  return <Stack gap="md">
    {current && <CurrentWork workspace={current} />}
    <Button variant={working ? 'outline' : 'solid'} icon="add" disabled={read(state.busy) || !selectedWorkspace()}
      onPress={startWork}>開始新工作</Button>
    {!read(state.busy) && !selectedWorkspace() && <Text tone="warning" size="sm">請先重新整理專案狀態，再建立工作。</Text>}
    {!read(state.busy) && !workspaces.some(canFinish) && <Text muted>還沒有進行中的工作。點「開始新工作」建立第一個。</Text>}
    <WorkspaceList />
  </Stack>
}

function CreateWorkspace() {
  const workspace = selectedWorkspace()
  const disabled = read(state.busy) || !workspace
  return <Card title="開始新工作">
    <Stack gap="md">
      <Text>為這次工作建立獨立資料夾，與其他工作分開。</Text>
      <Stack gap="xs">
        <Input label="工作名稱" value={read(state.name)} disabled={disabled} maxLength={100}
          placeholder="例如：修正登入畫面" onChange={(value) => edit(state.name, value)} />
        <Text muted size="sm">會用作分支名稱。可用中文、英文、數字或連字號，不要加空格。</Text>
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
      {!read(state.name).trim() && <Text muted size="sm">先填工作名稱，就可以建立。</Text>}
      {!read(state.base).trim() && <Text tone="warning" size="sm">請展開「調整起點與 AI 助手」，填寫起點分支。</Text>}
      <Button variant="solid" disabled={disabled || !read(state.name).trim() || !read(state.base).trim()}
        onPress={createAndOpen}>建立並開啟工作</Button>
    </Stack>
  </Card>
}

/** 收尾頁只有三個決定，其餘選項預設收起。 */
function FinishWorkspace() {
  const workspace = selectedWorkspace()
  if (!read(state.finishOpen) || !workspace) return null
  const snapshot = read(state.snapshot)
  const targets = finishTargets()
  const target = targets.find((entry) => entry.id === read(state.finishTargetId))
  const into = target ? branchName(target) : '目標分支'
  const busy = read(state.busy)
  const blocker = finishBlocker()
  const changes = snapshot?.files.length ?? 0
  const strategy = read(state.finishStrategy)
  const squash = read(state.finishSquash)
  return <Card title={`完成工作：${branchName(workspace)}`}>
    <Stack gap="md">
      <Text>{!snapshot ? (busy ? '正在確認變更…' : '還沒讀到變更。')
        : changes ? `有 ${changes} 個檔案還沒提交，完成時會一起提交。` : '沒有未提交的變更，會合併現有的提交。'}</Text>
      <FinishFiles />
      {targets.length > 0 && <Select label="1. 合併到哪個分支" value={read(state.finishTargetId)} disabled={busy}
        options={targets.map((entry) => ({ value: entry.id,
          label: `${branchName(entry)}${!canFinish(entry) ? '（主要分支）' : ''}` }))}
        onChange={(value) => edit(state.finishTargetId, value)} />}
      {!targets.length && <Callout tone="warning" title="還沒有可以合併的分支">
        請先在 Orca 開啟同專案的另一個工作資料夾，再回來按「重新整理」。
      </Callout>}
      <RadioGroup label="2. 怎麼合併" value={strategy} disabled={busy}
        options={[
          { value: 'merge', label: '一般合併（Merge，推薦）', description: '保留原本的提交順序。雙方都有新進度時，新增一個合併提交。' },
          { value: 'rebase', label: '接到最後面（Rebase）', description: `把提交搬到 ${into} 最新進度的後面，讓紀錄排成一直線。` }
        ]}
        onChange={(value) => edit(state.finishStrategy, value as FinishStrategy)} />
      <RadioGroup label="3. 要不要把提交合成一個" value={squash ? 'squash' : 'keep'} disabled={busy}
        options={[
          { value: 'keep', label: '保留每個提交（推薦）', description: '保留每一步的提交紀錄。' },
          { value: 'squash', label: '合成一個提交（Squash）', description: '把這個工作的多個提交合成一個，訊息自動產生。' }
        ]}
        onChange={(value) => edit(state.finishSquash, value === 'squash')} />
      {(strategy === 'rebase' || squash) && <Text tone="warning" size="sm">整理提交時，提交編號可能改變。若同事也在用這個分支，請保留預設選項。</Text>}
      {squash && strategy === 'merge' && <Stack gap="xs">
        <Text size="sm">{`若 ${into} 已有新進度，可能多出 1 個合併提交。`}</Text>
        <Button variant="outline" size="sm" disabled={busy}
          onPress={finishWithRebase}>改用 Rebase，讓提交排成一直線</Button>
      </Stack>}
      {target && <Text weight="semibold">{`${branchName(workspace)} → ${into} · ${strategy === 'merge' ? 'Merge' : 'Rebase'} · ${squash ? '合成一個提交' : '保留每個提交'}`}</Text>}
      <Text size="sm">{read(state.removeAfterFinish)
        ? '完成後移除工作資料夾，分支保留。可在「其他選項」改成保留資料夾。'
        : '完成後保留工作資料夾與分支。'}</Text>
      <Collapsible title="其他選項" disabled={read(state.executing)}>
        <Stack gap="sm">
          <Checkbox label="完成後移除這個工作資料夾" description="合併完成並確認安全後才移除，分支仍會保留。"
            checked={read(state.removeAfterFinish)} disabled={busy}
            onChange={(checked) => edit(state.removeAfterFinish, checked)} />
          {target && <AdviceHelper into={into} />}
        </Stack>
      </Collapsible>
      <Text muted size="sm">{`下一步只做檢查。請先關閉這個工作與 ${into} 的終端機和 AI 助手。`}</Text>
      {blocker && <Text size="sm">{blocker}</Text>}
      <Button variant="solid" disabled={busy || Boolean(blocker)} onPress={previewFinish}>下一步：確認</Button>
    </Stack>
  </Card>
}

// 紅色留給真正的失敗；風險高用警告色，避免讓人以為已經出錯。
const ADVICE_TONES = { 低: 'success', 中: 'accent', 高: 'warning', 未知: 'neutral' } as const

/** 請 Claude 評估合併風險：先說明會傳送什麼並取得確認；建議只供參考，不改任何選項。 */
function AdviceHelper({ into }: { into: string }) {
  const preview = read(state.advicePreview)
  const advice = read(state.advice)
  if (read(state.adviceWriting) && read(state.busy)) {
    return <Text size="sm">Claude 正在評估合併風險，大約需要 10–60 秒，請稍候。</Text>
  }
  if (preview) {
    return <Callout tone="accent" title="要把變更傳給 Claude 評估嗎？">
      <Stack gap="sm">
        <Text size="sm">{`會把這個工作的變更、${into} 改過的檔名和你目前的選擇，傳給 Claude（Anthropic 的 AI 服務）。Claude 不能使用工具，也不會修改檔案。`}</Text>
        <Text size="sm">外掛只能擋下常見的密碼與金鑰格式。不確定裡面有沒有密碼或金鑰，就按「取消」。</Text>
        <Collapsible title="查看會傳送的內容"><Code block>{preview.detail}</Code></Collapsible>
        <Row gap="sm" wrap>
          <Button onPress={writeAdvice}>確認傳送給 Claude</Button>
          <Button variant="ghost" onPress={cancelAdvice}>取消</Button>
        </Row>
      </Stack>
    </Callout>
  }
  if (advice) {
    const title = advice.level === '未知' ? 'AI 合併建議：無法判斷風險' : `AI 合併建議：風險${advice.level}${advice.raised ? '（依 Git 檢查調高）' : ''}`
    const facts = `Git 檢查：${advice.facts.conflict ? '可能有衝突' : '可以自動合併'}（只看已提交的內容）；兩邊都改過：${advice.facts.overlap.length ? advice.facts.overlap.slice(0, 5).join('、') + (advice.facts.overlap.length > 5 ? ` 等 ${advice.facts.overlap.length} 個` : '') : '沒有'}`
    return <Callout tone={ADVICE_TONES[advice.level]} title={title}>
      <Stack gap="xs">
        {/* Text 不保留換行，逐行顯示讓條列分開。 */}
        {advice.text.split('\n').filter((line) => line.trim()).map((line, index) => <Text key={index}>{line}</Text>)}
        <Text size="sm">{facts}</Text>
        <Text size="sm">{`僅供參考，AI 可能判斷錯誤。按「下一步：確認」只會先顯示確認頁；真的有衝突時，外掛會停下來，不會改動 ${into}。`}</Text>
      </Stack>
    </Callout>
  }
  return <Button variant="outline" size="sm" disabled={read(state.busy) || read(state.executing)} onPress={previewAdvice}>（可選）請 AI 評估合併風險</Button>
}

function FinishFiles() {
  const files = read(state.snapshot)?.files ?? []
  if (!files.length) return null
  return <Collapsible title={`查看 ${files.length} 個還沒提交的檔案`}>
    <Stack gap="xs">
      <Text size="sm">包含已暫存、未暫存及新增檔案。若要分批提交，請返回「查看變更」。</Text>
      {files.map((file) => <Text key={file.path} size="sm">{file.path}</Text>)}
    </Stack>
  </Collapsible>
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
  const summary = read(state.dashboard)?.summaries.find((entry) => entry.workspaceId === workspace.id)
  const target = projectWorkspaces().find((entry) => entry.id === read(state.dashboard)?.defaultTargetId)
  const snapshot = read(state.snapshot)
  return <Card title={`查看變更：${branchName(workspace)}`}>
    <Stack gap="sm">
      <Text>{snapshot ? (snapshot.files.length ? `${snapshot.files.length} 個檔案尚未提交` : '沒有未提交的變更')
        : read(state.busy) ? '正在確認變更狀態…' : '無法讀取變更，請重新整理。'}</Text>
      {snapshot && snapshot.files.length > 0 && <Collapsible title="變更檔案" defaultOpen>
        <Stack gap="xs">{snapshot.files.map((file) => <Text key={file.path} size="sm">{file.path}</Text>)}</Stack>
      </Collapsible>}
      <Row gap="sm" wrap>
        <Button disabled={read(state.busy)} onPress={() => openWorkspace(workspace.id)}>繼續工作</Button>
        {canFinish(workspace) && <Button variant="outline" disabled={read(state.busy)}
          onPress={() => selectWorkspace(workspace.id, 'finish')}>完成並合併…</Button>}
      </Row>
      <Collapsible title="Git 差異與逐檔提交"><Git /></Collapsible>
      <Collapsible title="GitHub PR" open={read(state.githubOpen)} onChange={toggleGithub}><GitHub /></Collapsible>
      <Collapsible title="分支與技術資訊">
        <Stack gap="xs">
          <Text size="sm">{workspace.path}</Text><Code>{workspace.id}</Code>
          {target && <Text size="sm">{`與 ${branchName(target)} 比較：本分支多 ${summary?.ahead ?? '未知'} 個提交，少 ${summary?.behind ?? '未知'} 個提交。`}</Text>}
          {summary?.error && <Callout tone="warning">{summary.error}</Callout>}
          <Text size="sm">{`最後提交：${summary?.lastMessage || '尚未取得'}`}</Text>
        </Stack>
      </Collapsible>
      <Collapsible title="進階：只移除工作資料夾">
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

/** 收尾確認頁：先用一句話說結果，再列步驟與提醒；技術細節收在可展開區塊。 */
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
      <Text weight="medium">會依序做這些事：</Text>
      {preview.steps?.map((step, index) => <Text key={index}>{`${index + 1}. ${step}`}</Text>)}
      {finishCommitMessage() && <Text>{`提交訊息：${finishCommitMessage()}（自動產生）`}</Text>}
      <FinishFiles />
      <Collapsible title="技術細節"><Code block>{preview.detail}</Code></Collapsible>
      <Text muted size="sm">只更新這台電腦，不會上傳到 GitHub。</Text>
      {read(state.executing) ? <Text tone="accent" weight="medium">正在依序完成上面的步驟，通常只要幾秒鐘。請不要關閉 Orca。</Text>
        : <Row gap="sm" wrap>
          <Button variant="solid" disabled={read(state.busy)} onPress={executePreview}>確認，開始合併</Button>
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
      <Collapsible title="預覽細節" defaultOpen><Code block>{preview.detail}</Code></Collapsible>
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
      {execution.steps?.map((step) => <Stack key={step.id} gap="xs">
        <Row gap="xs"><Badge tone={step.status === 'failed' ? 'warning' : 'neutral'}>
          {step.status === 'done' ? '完成' : step.status === 'skipped' ? (step.detail === '尚未執行' ? '尚未執行' : '略過') : '未完成'}
        </Badge><Text weight="medium">{step.label}</Text></Row>
        {/* 失敗原因已寫在上方提示框時不再重複整段。 */}
        {!(step.status === 'failed' && execution.message.includes(step.detail)) && <Text size="sm">{step.detail}</Text>}
      </Stack>)}
      {partial && <Text size="sm">已完成的步驟會保留，不會自動復原。請照上面的說明處理；看不懂時先不要重試，找人協助。</Text>}
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
      <Button icon="refresh" variant="ghost" disabled={read(state.busy)}
        onPress={() => { if (!read(state.busy) && !read(state.executing)) return refresh() }}>重新整理</Button>
    </Row>
    {repositories.length > 1 && <Select label="專案" value={read(state.repoId)} options={repositories}
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
    {preview ? <PreviewCard /> : <Stack gap="md">
      {read(state.createOpen) && <CreateWorkspace />}
      <FinishWorkspace />
      <WorkspaceDetails />
    </Stack>}
    {!focused && <Home />}
  </Stack>
}
