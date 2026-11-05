import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PullRequest, Run } from '../src/contracts'
import { GitHubService, type DraftRequest } from '../src/services/github'

const HEAD = 'a'.repeat(40)
const OLD_HEAD = 'b'.repeat(40)
const CWD = '/fixture/worktree'
const HOST = 'github.com'
const PROJECT = 'team/repo'
const REMOTE = `git@${HOST}:${PROJECT}.git`
const REQUEST: DraftRequest = {
  sourceBranch: 'feature/login', targetBranch: 'main', title: '實作登入',
  description: '完整描述\n第二行含 $(whoami) 與 `literal`', expectedHead: HEAD,
}
const PR: PullRequest = {
  id: 41, number: 7, title: REQUEST.title, url: `https://${HOST}/${PROJECT}/pull/7`, state: 'open',
  draft: true, headSha: HEAD, baseSha: OLD_HEAD, headBranch: REQUEST.sourceBranch, baseBranch: 'main', repoId: 12, mergeable: null,
}
function rawPr(pr: PullRequest = PR) {
  return { id: pr.id, number: pr.number, title: pr.title, html_url: pr.url, state: pr.state, draft: pr.draft, mergeable: pr.mergeable,
    head: { ref: pr.headBranch, sha: pr.headSha, repo: { id: pr.repoId, full_name: PROJECT } },
    base: { ref: pr.baseBranch, sha: pr.baseSha, repo: { id: pr.repoId, full_name: PROJECT } } }
}

function fixture() {
  const calls: { tool: string; args: readonly string[]; options?: Parameters<Run>[2] }[] = []
  const state = {
    remote: REMOTE, pushRemote: REMOTE, head: HEAD, branch: REQUEST.sourceBranch, remoteHead: HEAD,
    repository: { id: 12, full_name: PROJECT, html_url: `https://${HOST}/${PROJECT}` },
    listed: [] as ReturnType<typeof rawPr>[], pages: undefined as undefined | ReturnType<typeof rawPr>[][],
    pr: rawPr(), postCount: 0, postError: false, createdAfterError: false, apiError: false, malformedList: false,
    commentsError: false, reviewsError: false, checksError: false, statusesError: false, decisionError: false,
    decision: { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', headRefOid: HEAD },
    comments: [{ id: 51, body: '請修正', user: { login: 'reviewer' } }],
    reviews: [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', commit_id: HEAD }],
    checks: [] as { id: number; name: string; status: string; conclusion: string | null; head_sha: string; html_url?: string }[],
    statuses: { sha: HEAD, state: 'pending', total_count: 0, statuses: [] as { context: string; state: string; target_url?: string }[] },
  }
  const run: Run = async (tool, args, options) => {
    calls.push({ tool, args: [...args], options })
    if (tool === 'git') {
      if (args.includes('get-url')) return args.includes('--push') ? state.pushRemote : state.remote
      if (args[0] === 'rev-parse') return state.head
      if (args[0] === 'symbolic-ref') return state.branch
      if (args[0] === 'check-ref-format') return ''
      if (args[0] === 'ls-remote') return `${state.remoteHead}\trefs/heads/${state.branch}\n`
      throw new Error(`Unexpected git invocation: ${args[0]}`)
    }
    assert.equal(tool, 'gh')
    assert.equal(options?.cwd, CWD)
    if (args[0] === 'pr') {
      assert.equal(args[1], 'view')
      assert.equal(args[args.indexOf('--repo') + 1], `${HOST}/${PROJECT}`)
      if (state.decisionError) throw new Error('403 ghp-should-never-appear')
      return JSON.stringify(state.decision)
    }
    assert.equal(args[0], 'api')
    assert.equal(args[args.indexOf('--hostname') + 1], HOST)
    if (state.apiError) throw new Error('stderr contains secret ghp-should-never-appear')
    const endpoint = args.find(arg => arg.startsWith('repos/'))
    assert.ok(endpoint, 'API 必須明確指定 repository')
    const url = new URL(endpoint, 'https://fixture.invalid/')
    assert.ok(url.pathname.startsWith(`/repos/${PROJECT}`))
    const methodIndex = args.findIndex(arg => arg === '--method' || arg === '-X')
    const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1]
    if (method === 'POST') {
      state.postCount++
      assert.equal(url.pathname, `/repos/${PROJECT}/pulls`)
      assert.equal(args[args.indexOf('--input') + 1], '-')
      assert.deepEqual(JSON.parse(options?.input ?? '{}'), {
        head: REQUEST.sourceBranch, base: REQUEST.targetBranch, title: REQUEST.title, body: REQUEST.description, draft: true,
      })
      if (state.postError) throw new Error('timeout ghp-should-never-appear')
      return JSON.stringify(state.pr)
    }
    assert.equal(method, 'GET')
    if (/\/check-runs$/.test(url.pathname)) {
      assert.ok(url.pathname.includes(`/commits/${HEAD}/`))
      if (state.checksError) throw new Error('403 ghp-should-never-appear')
      const page = Number(url.searchParams.get('page') ?? 1)
      return JSON.stringify({ total_count: state.checks.length, check_runs: state.checks.slice((page - 1) * 100, page * 100) })
    }
    if (/\/status$/.test(url.pathname)) {
      assert.ok(url.pathname.includes(`/commits/${HEAD}/`))
      if (state.statusesError) throw new Error('403 ghp-should-never-appear')
      const page = Number(url.searchParams.get('page') ?? 1)
      return JSON.stringify({ ...state.statuses, statuses: state.statuses.statuses.slice((page - 1) * 100, page * 100) })
    }
    if (/\/comments$/.test(url.pathname)) {
      assert.equal(url.pathname, `/repos/${PROJECT}/issues/7/comments`)
      if (state.commentsError) throw new Error('403 ghp-should-never-appear')
      return JSON.stringify(state.comments)
    }
    if (/\/reviews$/.test(url.pathname)) {
      if (state.reviewsError) throw new Error('403 ghp-should-never-appear')
      return JSON.stringify(state.reviews)
    }
    if (/\/pulls\/\d+$/.test(url.pathname)) return JSON.stringify(state.pr)
    if (/\/pulls$/.test(url.pathname)) {
      assert.equal(url.searchParams.get('state'), 'open')
      assert.equal(url.searchParams.get('head'), `team:${REQUEST.sourceBranch}`)
      if (state.malformedList) return 'not-json ghp-should-never-appear'
      if (state.postCount && state.createdAfterError) return JSON.stringify([state.pr])
      const page = Number(url.searchParams.get('page') ?? 1)
      return JSON.stringify(state.pages ? state.pages[page - 1] ?? [] : state.listed)
    }
    return JSON.stringify(state.repository)
  }
  return { state, calls, service: new GitHubService(run) }
}

for (const remote of [REMOTE, `https://${HOST}/${PROJECT}.git`, `ssh://git@${HOST}/${PROJECT}.git`]) {
  test(`解析合法 remote 與 GitHub 身分：${remote}`, async () => {
    const { service, state } = fixture()
    state.remote = remote
    assert.deepEqual(await service.identity(CWD), {
      host: HOST, owner: 'team', repo: 'repo', projectPath: PROJECT, remoteUrl: remote, webUrl: `https://${HOST}/${PROJECT}`,
    })
  })
}

test('未授權的企業或任意 Host 在呼叫 gh 前拒絕', async () => {
  const { service, state, calls } = fixture()
  state.remote = state.pushRemote = 'git@github.enterprise.test:team/repo.git'
  await assert.rejects(service.identity(CWD), /github\.com|Host|遠端/)
  assert.equal(calls.filter(call => call.tool === 'gh').length, 0)
})

for (const remote of [
  'file:///tmp/repo', '/tmp/repo', '-evil', `http://${HOST}/${PROJECT}.git`, `https://user:secret@${HOST}/${PROJECT}.git`,
  `https://${HOST}/team/../repo.git`, `https://${HOST}/${PROJECT}.git?token=secret`, `git@${HOST}:../repo.git`,
  `git@${HOST}:team/repo.git\nextra`, `https://${HOST}/repo.git`, `https://${HOST}/team/subgroup/repo.git`,
  `ssh://ghp-secret@${HOST}/${PROJECT}.git`, `ghp-secret@${HOST}:${PROJECT}.git`,
]) {
  test(`拒絕不支援或模糊的 remote：${remote}`, async () => {
    const { service, state, calls } = fixture()
    state.remote = remote
    await assert.rejects(service.identity(CWD), /remote|遠端|網址|身分/i)
    assert.equal(calls.filter(call => call.tool === 'gh').length, 0)
  })
}

test('PR 查詢固定 Host/repository 並映射 API 欄位，mergeable null 保持未知', async () => {
  const { service, state } = fixture()
  state.listed = [rawPr()]
  assert.deepEqual(await service.list(CWD, REQUEST.sourceBranch), [PR])
})

test('identity 核對全部展開 fetch/push URL，拒絕多個或不同目的地', async () => {
  for (const pushRemote of [`${REMOTE}\ngit@${HOST}:other/repo.git`, 'git@wrong.example:team/repo.git']) {
    const { service, state, calls } = fixture()
    state.pushRemote = pushRemote
    await assert.rejects(service.identity(CWD), /遠端|身分|remote/i)
    assert.ok(calls.filter(call => call.tool === 'git' && call.args.includes('get-url')).every(call => call.args.includes('--all')))
  }
})

test('PR 清單完整讀取分頁', async () => {
  const { service, state } = fixture()
  const first = Array.from({ length: 100 }, (_, i) => rawPr({ ...PR, id: i + 1, number: i + 1, url: `https://${HOST}/${PROJECT}/pull/${i + 1}` }))
  state.pages = [first, [rawPr({ ...PR, id: 101, number: 101, url: `https://${HOST}/${PROJECT}/pull/101` })]]
  assert.equal((await service.list(CWD, REQUEST.sourceBranch)).length, 101)
})

test('PR 分頁超過上限時明確失敗，不回傳截斷清單', async () => {
  const { service, state, calls } = fixture()
  state.listed = Array.from({ length: 100 }, () => rawPr())
  await assert.rejects(service.list(CWD, REQUEST.sourceBranch), /分頁|上限|完整/)
  assert.ok(calls.length < 25)
})

test('fork PR 不可當作同 repository', async () => {
  const { service, state } = fixture()
  const fork = rawPr()
  fork.head.repo.id = 99
  state.listed = [fork]
  await assert.rejects(service.list(CWD, REQUEST.sourceBranch), /fork|同.*repository|同專案/i)
})

test('API 回覆不同 repository 身分時停止', async () => {
  const { service, state } = fixture()
  state.repository.full_name = 'other/repo'
  await assert.rejects(service.list(CWD, REQUEST.sourceBranch), /repository|身分/)
})

test('PR 網址不可跨 Host 傳到前端', async () => {
  const { service, state } = fixture()
  state.listed = [rawPr({ ...PR, url: 'https://attacker.example/steal' })]
  await assert.rejects(service.list(CWD, REQUEST.sourceBranch), /網址|身分|Host/)
})

test('API 非 JSON 與 stderr 不得洩漏秘密', async () => {
  const { service, state } = fixture()
  state.malformedList = true
  await assert.rejects(service.list(CWD, REQUEST.sourceBranch), error => !String(error).includes('ghp-'))
  state.apiError = true
  await assert.rejects(service.list(CWD, REQUEST.sourceBranch), error => !String(error).includes('ghp-'))
})

test('合法流程只建立一次 Draft PR，JSON stdin 保留描述且不 Push', async () => {
  const { service, state, calls } = fixture()
  assert.deepEqual(await service.createDraft(CWD, REQUEST), PR)
  assert.equal(state.postCount, 1)
  assert.equal(calls.some(call => call.tool === 'git' && call.args[0] === 'push'), false)
})

test('同 source/target 的 PR 直接復用，不重複建立', async () => {
  const { service, state } = fixture()
  state.listed = [rawPr()]
  assert.deepEqual(await service.createDraft(CWD, REQUEST), PR)
  assert.equal(state.postCount, 0)
})

for (const field of ['head', 'remoteHead', 'branch', 'pushRemote'] as const) {
  test(`建立前 ${field} 漂移拒絕且不 POST`, async () => {
    const { service, state } = fixture()
    state[field] = field === 'branch' ? 'other-branch' : field === 'pushRemote' ? 'git@wrong.example:team/repo.git' : OLD_HEAD
    await assert.rejects(service.createDraft(CWD, REQUEST), /版本|分支|遠端|身分|SHA/)
    assert.equal(state.postCount, 0)
  })
}

test('不合法 branch 或 SHA 不進入網路呼叫', async () => {
  for (const request of [{ ...REQUEST, sourceBranch: '-bad' }, { ...REQUEST, targetBranch: 'main\n--evil' }, { ...REQUEST, expectedHead: 'HEAD' }]) {
    const { service, calls } = fixture()
    await assert.rejects(service.createDraft(CWD, request), /分支|SHA|版本/)
    assert.equal(calls.filter(call => call.tool === 'gh').length, 0)
  }
})

test('預覽後 Host 或同源 remote URL 變動均須重新預覽', async () => {
  for (const host of ['old.example', HOST]) {
    const { service, calls } = fixture()
    await assert.rejects(service.createDraft(CWD, { ...REQUEST, expectedIdentity: {
      host, owner: 'team', repo: 'repo', projectPath: PROJECT, remoteUrl: `https://${host}/${PROJECT}.git`, webUrl: `https://${host}/${PROJECT}`,
    } }), /身分|遠端|預覽/)
    assert.equal(calls.filter(call => call.tool === 'gh').length, 0)
  }
})

test('POST timeout 後查到 PR 可復用，不重送 POST', async () => {
  const { service, state } = fixture()
  state.postError = true
  state.createdAfterError = true
  assert.deepEqual(await service.createDraft(CWD, REQUEST), PR)
  assert.equal(state.postCount, 1)
})

test('POST timeout 後查不到 PR 回報未知，不重送或洩漏秘密', async () => {
  const { service, state } = fixture()
  state.postError = true
  await assert.rejects(service.createDraft(CWD, REQUEST), error => /未知|UNKNOWN/.test(String(error)) && !String(error).includes('ghp-'))
  assert.equal(state.postCount, 1)
})

test('PR 詳細資料保留留言、review SHA 與 review_required；沒有 CI 保持未知', async () => {
  const { service } = fixture()
  const details = await service.details(CWD, 7)
  assert.equal(details.reviewDecision, 'review_required')
  assert.equal(details.mergeStateStatus, 'BLOCKED')
  assert.equal(details.pr.mergeable, null)
  assert.deepEqual(details.comments, [{ id: 51, body: '請修正', author: 'reviewer' }])
  assert.deepEqual(details.reviews, [{ author: 'reviewer', state: 'CHANGES_REQUESTED', commitSha: HEAD }])
  assert.ok(details.checks.every(check => check.conclusion !== 'success'))
  assert.ok(details.warnings.length > 0)
})

test('check-runs 與 combined statuses 各自依 PR HEAD 顯示，不合成可合併', async () => {
  const { service, state } = fixture()
  state.checks = [{ id: 3, name: 'unit', status: 'completed', conclusion: 'success', head_sha: HEAD }]
  state.statuses = { sha: HEAD, state: 'failure', total_count: 1, statuses: [{ context: 'security', state: 'failure' }] }
  const details = await service.details(CWD, 7)
  assert.ok(details.checks.some(check => check.name === 'unit' && check.conclusion === 'success'))
  assert.ok(details.checks.some(check => /combined|合併狀態|彙總/i.test(check.name) && check.conclusion === 'failure'))
  assert.ok(details.checks.every(check => check.sha === HEAD))
  assert.equal(details.pr.mergeable, null)
})

test('checks 超過一頁會完整讀取', async () => {
  const { service, state } = fixture()
  state.checks = Array.from({ length: 101 }, (_, id) => ({ id: id + 1, name: `check-${id}`, status: 'completed', conclusion: 'success', head_sha: HEAD }))
  assert.equal((await service.details(CWD, 7)).checks.filter(check => check.name.startsWith('check-')).length, 101)
})

test('status 缺席即使回傳 success 也不可當成功', async () => {
  const { service, state } = fixture()
  state.statuses.state = 'success'
  const details = await service.details(CWD, 7)
  assert.ok(details.checks.every(check => check.conclusion !== 'success'))
  assert.ok(details.warnings.length > 0)
})

test('錯誤 SHA 的 checks/statuses 不會當成目前 HEAD 證據', async () => {
  const { service, state } = fixture()
  state.checks = [{ id: 3, name: 'wrong-head', status: 'completed', conclusion: 'success', head_sha: OLD_HEAD }]
  state.statuses = { sha: OLD_HEAD, state: 'success', total_count: 1, statuses: [{ context: 'old', state: 'success' }] }
  const details = await service.details(CWD, 7)
  assert.ok(details.checks.every(check => check.conclusion !== 'success'))
  assert.ok(details.warnings.length >= 2)
})

test('gh pr view 的 HEAD 漂移時不套用核准結果', async () => {
  const { service, state } = fixture()
  state.decision = { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', headRefOid: OLD_HEAD }
  const details = await service.details(CWD, 7)
  assert.equal(details.reviewDecision, 'unknown')
  assert.equal(details.mergeStateStatus, 'UNKNOWN')
  assert.ok(details.warnings.some(warning => /SHA|版本|HEAD/.test(warning)))
})

test('PR 附屬資料無權限時顯示 unknown/警告且不洩漏秘密', async () => {
  const { service, state } = fixture()
  state.commentsError = state.reviewsError = state.checksError = state.statusesError = state.decisionError = true
  const details = await service.details(CWD, 7)
  assert.equal(details.reviewDecision, 'unknown')
  assert.equal(details.mergeStateStatus, 'UNKNOWN')
  assert.deepEqual(details.comments, [])
  assert.deepEqual(details.reviews, [])
  assert.ok(details.checks.every(check => check.conclusion !== 'success'))
  assert.ok(details.warnings.length >= 5)
  assert.ok(!JSON.stringify(details).includes('ghp-'))
})

test('無效 PR number 在呼叫 GitHub 前拒絕', async () => {
  const { service, calls } = fixture()
  await assert.rejects(service.details(CWD, -1), /number|編號/i)
  assert.equal(calls.filter(call => call.tool === 'gh').length, 0)
})

test('真實 Git 展開 insteadOf 並拒絕異源 pushurl，不連外網', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitflow-github-'))
  const execute = promisify(execFile)
  const git = async (...args: string[]) => (await execute('git', args, { cwd: directory })).stdout
  const run: Run = async (tool, args, options) => {
    assert.equal(tool, 'git')
    assert.equal(options?.cwd, directory)
    return git(...args)
  }
  try {
    await git('init')
    await git('config', '--local', 'remote.origin.url', `test-alias:${PROJECT}.git`)
    await git('config', '--local', `url.git@${HOST}:.insteadOf`, 'test-alias:')
    const service = new GitHubService(run)
    assert.equal((await service.identity(directory)).remoteUrl, REMOTE)
    await git('config', '--local', 'remote.origin.pushurl', 'git@wrong.example:team/repo.git')
    await assert.rejects(service.identity(directory), /身分|遠端/)
    await git('config', '--local', '--add', 'remote.origin.url', 'git@another.example:team/repo.git')
    await assert.rejects(service.identity(directory), /remote|遠端/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
