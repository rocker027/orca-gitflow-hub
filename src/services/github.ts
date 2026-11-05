import type { GitHubIdentity, PullRequest, PrDetails, Run } from '../contracts'

export interface DraftRequest {
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
  expectedHead: string
  expectedIdentity?: GitHubIdentity
}

const PAGE_SIZE = 100
const MAX_PAGES = 10
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
type JsonObject = Record<string, unknown>
type Repository = { id: number; identity: GitHubIdentity }
type Page = { entries: unknown[]; metadata?: JsonObject }
const repoPath = (identity: GitHubIdentity) => `repos/${identity.owner}/${identity.repo}`

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub 回覆格式不完整。')
  return value as JsonObject
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') &&
    !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') &&
    value !== '@' && value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
}

function sameIdentity(first: GitHubIdentity, second: GitHubIdentity): boolean {
  return first.host === second.host && first.projectPath.toLowerCase() === second.projectPath.toLowerCase()
}

function sameUrl(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase()
}

function parseRemote(remoteUrl: string): GitHubIdentity {
  if (!remoteUrl || /[\s\x00-\x1f\x7f\\%]/.test(remoteUrl)) throw new Error('遠端 remote 網址格式不支援。')
  let host: string
  let pathname: string
  if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('ssh://')) {
    let parsed: URL
    try { parsed = new URL(remoteUrl) } catch { throw new Error('遠端 remote 網址無效。') }
    if (parsed.search || parsed.hash || parsed.password || (parsed.protocol === 'https:' && parsed.username) ||
      (parsed.protocol === 'ssh:' && parsed.username !== 'git')) {
      throw new Error('遠端 remote 不可包含憑證、查詢或 fragment。')
    }
    host = parsed.protocol === 'https:' ? parsed.host : parsed.hostname
    // 檢查原始路徑，避免 URL parser 消除 ../ 後接受越界輸入。
    pathname = remoteUrl.slice(remoteUrl.indexOf('://') + 3).replace(/^[^/]+\//, '')
  } else {
    const match = /^([a-zA-Z0-9._-]+)@([^:]+):(.+)$/.exec(remoteUrl)
    if (!match || match[1] !== 'git') throw new Error('遠端 remote 僅支援 HTTPS 與 git 使用者的 SSH／SCP。')
    host = match[2]
    pathname = match[3]
  }
  host = host.toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?$/.test(host) || host.split(':')[0].split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw new Error('遠端 remote Host 格式不支援。')
  }
  if (host !== 'github.com') throw new Error('MVP 僅支援 github.com，其他遠端 Host 尚未開放。')
  const projectPath = pathname.replace(/\.git$/, '')
  const segments = projectPath.split('/')
  if (segments.length !== 2 || segments.some(part => !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(part))) {
    throw new Error('遠端 remote 必須有有效的 owner/repository。')
  }
  return { host, owner: segments[0], repo: segments[1], projectPath, remoteUrl, webUrl: `https://${host}/${projectPath}` }
}

function validatePr(value: unknown, repository: Repository): PullRequest {
  const pr = object(value)
  const head = object(pr.head)
  const base = object(pr.base)
  if (!positiveId(pr.id) || !positiveId(pr.number) || typeof pr.title !== 'string' || typeof pr.draft !== 'boolean' ||
    !['open', 'closed'].includes(String(pr.state)) || !validBranch(head.ref) || !validBranch(base.ref) ||
    typeof head.sha !== 'string' || !SHA.test(head.sha) || typeof base.sha !== 'string' || !SHA.test(base.sha)) {
    throw new Error('GitHub PR 回覆格式不完整。')
  }
  for (const raw of [head.repo, base.repo]) {
    const repo = object(raw)
    if (repo.id !== repository.id || typeof repo.full_name !== 'string' || repo.full_name.toLowerCase() !== repository.identity.projectPath.toLowerCase()) {
      throw new Error('MVP 僅支援同 repository PR，不支援 fork。')
    }
  }
  if (!sameUrl(pr.html_url, `${repository.identity.webUrl}/pull/${pr.number}`)) throw new Error('GitHub PR 網址與 repository 身分不符。')
  if (pr.mergeable !== null && pr.mergeable !== undefined && typeof pr.mergeable !== 'boolean') throw new Error('GitHub mergeable 格式不完整。')
  return { id: pr.id, number: pr.number, title: pr.title, url: pr.html_url as string, state: pr.state as 'open' | 'closed',
    draft: pr.draft, headSha: head.sha, baseSha: base.sha, headBranch: head.ref, baseBranch: base.ref,
    repoId: repository.id, mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null }
}

/** 以固定 GitHub repository 與版本讀取交付資訊，唯一遠端寫入為建立 Draft PR。 */
export class GitHubService {
  constructor(private readonly run: Run) {}

  async identity(cwd: string): Promise<GitHubIdentity> {
    const fetchUrl = await this.git(cwd, ['remote', 'get-url', '--all', 'origin'])
    const pushUrl = await this.git(cwd, ['remote', 'get-url', '--push', '--all', 'origin'])
    const identity = parseRemote(fetchUrl.trimEnd())
    if (!sameIdentity(identity, parseRemote(pushUrl.trimEnd()))) throw new Error('fetch 與 push 遠端身分不同，請先修正 origin。')
    return identity
  }

  async list(cwd: string, sourceBranch: string): Promise<PullRequest[]> {
    if (!validBranch(sourceBranch)) throw new Error('來源分支無效。')
    const repository = await this.repository(cwd, await this.identity(cwd))
    return this.listForRepository(cwd, repository, sourceBranch)
  }

  async details(cwd: string, number: number): Promise<PrDetails> {
    if (!positiveId(number)) throw new Error('PR number 編號無效。')
    const identity = await this.identity(cwd)
    const repository = await this.repository(cwd, identity)
    const pr = validatePr(await this.api(cwd, identity, `${repoPath(identity)}/pulls/${number}`), repository)
    if (pr.number !== number) throw new Error('GitHub 回覆的 PR 編號不符。')
    const details: PrDetails = { identity, pr, comments: [], reviews: [], checks: [], reviewDecision: 'unknown',
      mergeStateStatus: 'UNKNOWN', warnings: ['狀態僅供參考，請在 GitHub 確認合併條件。'] }
    await this.readComments(cwd, details)
    await this.readReviews(cwd, details)
    await this.readChecks(cwd, details)
    await this.readStatuses(cwd, details)
    await this.readDecision(cwd, details)
    return details
  }

  async createDraft(cwd: string, request: DraftRequest): Promise<PullRequest> {
    this.validateDraft(request)
    const identity = await this.identity(cwd)
    if (request.expectedIdentity && (!sameIdentity(identity, request.expectedIdentity) || identity.remoteUrl !== request.expectedIdentity.remoteUrl)) {
      throw new Error('遠端身分已不同於預覽，請重新預覽。')
    }
    await this.checkHead(cwd, request)
    const repository = await this.repository(cwd, identity)
    const existing = this.matchExisting(await this.listForRepository(cwd, repository, request.sourceBranch), request)
    if (existing) return existing
    const currentIdentity = await this.identity(cwd)
    if (!sameIdentity(identity, currentIdentity) || identity.remoteUrl !== currentIdentity.remoteUrl) throw new Error('遠端身分在建立前改變。')
    await this.checkHead(cwd, request)
    const body = { head: request.sourceBranch, base: request.targetBranch, title: request.title, body: request.description, draft: true }
    try {
      const pr = validatePr(await this.api(cwd, identity, `${repoPath(identity)}/pulls`, body), repository)
      if (!pr.draft || pr.headBranch !== request.sourceBranch || pr.baseBranch !== request.targetBranch || pr.headSha !== request.expectedHead) {
        throw new Error('建立回覆不符預期。')
      }
      return pr
    } catch { return this.recoverCreated(cwd, repository, request) }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try { return await this.run('git', args, { cwd, timeoutMs: 30_000 }) }
    catch { throw new Error('Git 遠端資訊讀取失敗，請檢查目前工作區。') }
  }

  private async api(cwd: string, identity: GitHubIdentity, endpoint: string, body?: JsonObject): Promise<unknown> {
    if (identity.host !== 'github.com') throw new Error('GitHub Host 身分不支援。')
    const args = ['api', '--hostname', 'github.com', '--method', body ? 'POST' : 'GET', endpoint, '--header', 'Accept: application/vnd.github+json']
    if (body) args.push('--input', '-')
    try {
      return JSON.parse(await this.run('gh', args, { cwd, timeoutMs: 30_000, ...(body ? { input: JSON.stringify(body) } : {}) }))
    } catch { throw new Error('GitHub 請求失敗或回覆非 JSON，請檢查 gh 安裝、登入與權限。') }
  }

  private async repository(cwd: string, identity: GitHubIdentity): Promise<Repository> {
    const repository = object(await this.api(cwd, identity, repoPath(identity)))
    if (!positiveId(repository.id) || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== identity.projectPath.toLowerCase() ||
      !sameUrl(repository.html_url, identity.webUrl)) throw new Error('GitHub 回覆的 repository 身分與遠端不符。')
    return { id: repository.id, identity }
  }

  private async pages(cwd: string, identity: GitHubIdentity, endpoint: string, field?: 'check_runs' | 'statuses'): Promise<Page> {
    let entries: unknown[] = []
    let metadata: JsonObject | undefined
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = await this.api(cwd, identity, `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`)
      const envelope = field ? object(raw) : undefined
      const batch = field ? envelope?.[field] : raw
      if (!Array.isArray(batch) || batch.length > PAGE_SIZE) throw new Error('GitHub 分頁回覆格式不完整。')
      if (envelope) {
        if (!Number.isSafeInteger(envelope.total_count) || Number(envelope.total_count) < 0 || Number(envelope.total_count) > PAGE_SIZE * MAX_PAGES) throw new Error('GitHub 分頁超出上限或資料不完整。')
        if (metadata && ['total_count', 'sha', 'state'].some(key => metadata?.[key] !== envelope[key])) throw new Error('GitHub 分頁版本變動，請重新讀取。')
        metadata ??= envelope
      }
      entries = [...entries, ...batch]
      if (metadata && entries.length === metadata.total_count) return { entries, metadata }
      if (batch.length < PAGE_SIZE) {
        if (metadata && entries.length !== metadata.total_count) throw new Error('GitHub 分頁資料不完整。')
        return { entries, metadata }
      }
    }
    throw new Error('GitHub 分頁超出上限，無法取得完整資料。')
  }

  private async listForRepository(cwd: string, repository: Repository, branch: string): Promise<PullRequest[]> {
    const identity = repository.identity
    const page = await this.pages(cwd, identity, `${repoPath(identity)}/pulls?state=open&head=${encodeURIComponent(`${identity.owner}:${branch}`)}`)
    return page.entries.map(entry => {
      const pr = validatePr(entry, repository)
      if (pr.headBranch !== branch || pr.state !== 'open') throw new Error('GitHub PR 清單與來源分支不符。')
      return pr
    })
  }

  private validateDraft(request: DraftRequest): void {
    if (!validBranch(request.sourceBranch) || !validBranch(request.targetBranch) || request.sourceBranch === request.targetBranch) throw new Error('PR 來源與目標分支無效。')
    if (typeof request.expectedHead !== 'string' || !SHA.test(request.expectedHead)) throw new Error('預期 SHA 版本無效。')
    if (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 240 || /[\x00-\x1f\x7f]/.test(request.title)) throw new Error('PR 標題不可空白或包含控制字元。')
    if (typeof request.description !== 'string' || request.description.length > 65_536 || request.description.includes('\0')) throw new Error('PR 描述格式或長度無效。')
  }

  private async checkHead(cwd: string, request: DraftRequest): Promise<void> {
    if ((await this.git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim() !== request.expectedHead) throw new Error('本機 HEAD 版本已改變，請重新預覽。')
    if ((await this.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() !== request.sourceBranch) throw new Error('本機分支已改變，請重新預覽。')
    const ref = `refs/heads/${request.sourceBranch}`
    if ((await this.git(cwd, ['ls-remote', '--exit-code', 'origin', ref])).trimEnd() !== `${request.expectedHead}\t${ref}`) {
      throw new Error('遠端 SHA 版本不符，請先推送並重新預覽。')
    }
  }

  private matchExisting(entries: PullRequest[], request: DraftRequest): PullRequest | undefined {
    const matching = entries.filter(pr => pr.baseBranch === request.targetBranch)
    if (matching.length > 1) throw new Error('存在多個相同分支的 PR，請在 GitHub 確認。')
    if (matching[0] && matching[0].headSha !== request.expectedHead) throw new Error('既有 PR 的 SHA 版本不同，請重新整理。')
    return matching[0]
  }

  private async recoverCreated(cwd: string, repository: Repository, request: DraftRequest): Promise<PullRequest> {
    // POST 失敗可能已在伺服器生效，只讀取確認，不重送寫入。
    try {
      const existing = this.matchExisting(await this.listForRepository(cwd, repository, request.sourceBranch), request)
      if (existing) return existing
    } catch { /* 讀取失敗不代表 PR 不存在。 */ }
    throw new Error('PR 建立結果未知（UNKNOWN），請先在 GitHub 查明結果，不要重複建立。')
  }

  private async readComments(cwd: string, details: PrDetails): Promise<void> {
    try {
      const page = await this.pages(cwd, details.identity, `${repoPath(details.identity)}/issues/${details.pr.number}/comments`)
      details.comments = page.entries.map(value => {
        const comment = object(value)
        const user = object(comment.user)
        if (!positiveId(comment.id) || typeof comment.body !== 'string' || typeof user.login !== 'string') throw new Error('留言格式不完整。')
        return { id: comment.id, body: comment.body, author: user.login }
      })
    } catch { details.warnings.push('無法完整讀取 PR 留言，請至 GitHub 查看。') }
  }

  private async readReviews(cwd: string, details: PrDetails): Promise<void> {
    try {
      const page = await this.pages(cwd, details.identity, `${repoPath(details.identity)}/pulls/${details.pr.number}/reviews`)
      details.reviews = page.entries.map(value => {
        const review = object(value)
        const user = object(review.user)
        if (typeof user.login !== 'string' || typeof review.state !== 'string' || typeof review.commit_id !== 'string' || !SHA.test(review.commit_id)) throw new Error('審查資料不完整。')
        return { author: user.login, state: review.state, commitSha: review.commit_id }
      })
    } catch { details.warnings.push('無法完整讀取 PR 審查紀錄，審查狀態未知。') }
  }

  private async readChecks(cwd: string, details: PrDetails): Promise<void> {
    try {
      const page = await this.pages(cwd, details.identity, `${repoPath(details.identity)}/commits/${details.pr.headSha}/check-runs?filter=latest`, 'check_runs')
      const checks = page.entries.map(value => {
        const check = object(value)
        if (check.head_sha !== details.pr.headSha || typeof check.name !== 'string' || typeof check.status !== 'string' ||
          (check.conclusion !== null && typeof check.conclusion !== 'string')) throw new Error('Checks SHA 或格式不符。')
        return { name: check.name, status: check.status, conclusion: check.conclusion as string | null, sha: details.pr.headSha }
      })
      details.checks.push(...checks)
      if (!checks.length) details.warnings.push('目前 HEAD 沒有 Check runs，CI Checks 狀態未知。')
    } catch { details.warnings.push('無法完整讀取目前 HEAD 的 Checks，狀態未知。') }
  }

  private async readStatuses(cwd: string, details: PrDetails): Promise<void> {
    const unknown = { name: 'Combined commit status', status: 'unknown', conclusion: null, sha: details.pr.headSha }
    try {
      const page = await this.pages(cwd, details.identity, `${repoPath(details.identity)}/commits/${details.pr.headSha}/status`, 'statuses')
      if (page.metadata?.sha !== details.pr.headSha || !['success', 'pending', 'failure', 'error'].includes(String(page.metadata?.state))) throw new Error('Status SHA 或格式不符。')
      if (!page.entries.length) {
        details.checks.push(unknown)
        details.warnings.push('目前 HEAD 沒有 Commit statuses，彙總狀態未知。')
        return
      }
      const checks = page.entries.map(value => {
        const status = object(value)
        if (typeof status.context !== 'string' || !['success', 'pending', 'failure', 'error'].includes(String(status.state))) throw new Error('Status 格式不符。')
        return { name: status.context, status: String(status.state), conclusion: this.statusConclusion(String(status.state)), sha: details.pr.headSha }
      })
      const state = String(page.metadata.state)
      details.checks.push(...checks, { name: unknown.name, status: state, conclusion: this.statusConclusion(state), sha: details.pr.headSha })
    } catch {
      details.checks.push(unknown)
      details.warnings.push('無法完整讀取目前 HEAD 的 Commit statuses，彙總狀態未知。')
    }
  }

  private statusConclusion(status: string): string | null {
    return status === 'success' ? 'success' : status === 'pending' ? null : 'failure'
  }

  private async readDecision(cwd: string, details: PrDetails): Promise<void> {
    try {
      const output = await this.run('gh', ['pr', 'view', String(details.pr.number), '--repo', `${details.identity.host}/${details.identity.projectPath}`,
        '--json', 'reviewDecision,mergeStateStatus,headRefOid'], { cwd, timeoutMs: 30_000 })
      const decision = object(JSON.parse(output))
      if (decision.headRefOid !== details.pr.headSha) {
        details.warnings.push('PR HEAD SHA 在讀取期間改變，核准與合併狀態未知，請重新整理。')
        return
      }
      const mapping: Record<string, PrDetails['reviewDecision']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' }
      details.reviewDecision = mapping[String(decision.reviewDecision)] ?? 'unknown'
      if (typeof decision.mergeStateStatus === 'string' && decision.mergeStateStatus) details.mergeStateStatus = decision.mergeStateStatus
      if (details.reviewDecision === 'unknown') details.warnings.push('GitHub 未提供可判讀的 reviewDecision，核准狀態未知。')
    } catch { details.warnings.push('無法讀取 GitHub 核准與合併狀態，保留 UNKNOWN。') }
  }
}
