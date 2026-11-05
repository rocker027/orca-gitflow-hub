import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ChangedFile, CommitPreview, GitSnapshot, Run } from '../contracts'

const MAX_FILES = 2_000
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--binary']

function lines(value: string): string[] {
  return value.split('\n').filter(Boolean)
}

function parseStatus(status: string): ChangedFile[] {
  const records = status.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') throw new Error('Git status 格式無法辨識')
    const file: ChangedFile = { path: record.slice(3), index: record[0], working: record[1] }
    if (/[RC]/.test(file.index + file.working)) {
      const originalPath = records[++i]
      if (!originalPath) throw new Error('Git rename 資料不完整')
      files.push({ ...file, originalPath })
    } else files.push(file)
  }
  if (files.length > MAX_FILES) throw new Error('變更檔案過多，請先縮小工作範圍')
  return files
}

function isConflict(file: ChangedFile): boolean {
  return file.index === 'U' || file.working === 'U' || ['AA', 'DD'].includes(file.index + file.working)
}

function stagedFiles(files: ChangedFile[]): ChangedFile[] {
  return files.filter((file) => file.index !== ' ' && file.index !== '?')
}

function validatePath(path: string): void {
  if (!path || path.includes('\0') || isAbsolute(path) || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('檔案路徑必須位於工作區內')
  }
}

async function verifyFilePath(cwd: string, path: string, allowSymlink: boolean): Promise<void> {
  validatePath(path)
  const parts = path.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const candidate = join(cwd, ...parts.slice(0, i))
    try {
      const stat = await lstat(candidate)
      if (stat.isSymbolicLink() && (!allowSymlink || i < parts.length)) throw new Error('不支援 symlink 連結檔案操作')
      if (i < parts.length && !stat.isDirectory()) throw new Error('檔案父路徑不是目錄')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function untrackedContent(cwd: string, files: ChangedFile[]): Promise<string> {
  const digest = createHash('sha256')
  let size = 0
  for (const file of files.filter((entry) => entry.index === '?')) {
    await verifyFilePath(cwd, file.path, true)
    const path = join(cwd, file.path)
    const stat = await lstat(path)
    digest.update(JSON.stringify([file.path, stat.mode]))
    if (stat.isSymbolicLink()) { digest.update(await readlink(path)); continue }
    if (!stat.isFile()) throw new Error('未追蹤項目不是一般檔案')
    size += stat.size
    if (size > MAX_UNTRACKED_BYTES) throw new Error('未追蹤內容超過 32 MiB，請先整理工作區')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { digest.update(await handle.readFile()) } finally { await handle.close() }
  }
  return digest.digest('hex')
}

function validateMessage(message: string): void {
  if (typeof message !== 'string' || !message.trim() || message.includes('\0') || message.length > 16_384) {
    throw new Error('提交訊息必須為非空文字，且不可超過 16 KiB')
  }
}

function sensitivePath(path: string): boolean {
  const basename = path.split('/').at(-1) ?? ''
  if (/^\.env(?:\.|$)/i.test(basename) && !/^\.env\.(example|sample|template)$/i.test(basename)) return true
  return /^(id_(rsa|dsa|ecdsa|ed25519)|credentials|credentials\.json|\.npmrc|\.pypirc)$/i.test(basename)
    || /\.(pem|p12|pfx|key|keystore|jks)$/i.test(basename)
}

function checkSecretContent(path: string, content: string): void {
  if (sensitivePath(path)) throw new Error(`敏感檔案不可透過 Hub 提交：${path}`)
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content)
    || /(?:AKIA|ASIA)[A-Z0-9]{16}/.test(content)
    || /glpat-[A-Za-z0-9_-]{20,}/.test(content)) throw new Error(`偵測到疑似機密或私鑰：${path}`)
}

/** 本機 Git 狀態與明確寫入操作；工作區授權與操作 token 由 Hub 負責。 */
export class GitService {
  constructor(private readonly run: Run) {}

  private git(cwd: string, args: readonly string[], input?: string): Promise<string> {
    return this.run('git', ['--no-pager', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd, input })
  }

  private async root(cwd: string): Promise<void> {
    if (!isAbsolute(cwd) || cwd.includes('\0')) throw new Error('工作區必須是絕對根目錄')
    const actual = await realpath(cwd)
    const top = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '')
    if (await realpath(top) !== actual) throw new Error('只允許 Git 工作區根目錄')
    if ((await this.git(cwd, ['rev-parse', '--is-bare-repository'])).trim() !== 'false') throw new Error('不支援 bare repository')
  }

  private async head(cwd: string): Promise<string> {
    return (await this.git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()
  }

  private async branch(cwd: string): Promise<string> {
    const branch = (await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return branch === 'HEAD' ? '' : branch
  }

  private async hiddenChangeReasons(cwd: string): Promise<string[]> {
    const reasons = new Set<string>()
    const sparse = (await this.git(cwd, ['config', '--bool', '--default=false', '--get', 'core.sparseCheckout'])).trim()
    if (sparse !== 'true' && sparse !== 'false') throw new Error('無法確認 sparse checkout 設定')
    if (sparse === 'true') reasons.add('已啟用 sparse checkout，無法確認全部工作樹內容')
    const entries = (await this.git(cwd, ['ls-files', '-v', '-z'])).split('\0').filter(Boolean)
    for (const entry of entries) {
      if (!/^[A-Za-z?] /.test(entry)) throw new Error('無法辨識 Git index 旗標')
      const tag = entry[0]
      if (tag === 'S' || tag === 's') reasons.add('含 skip-worktree 旗標，可能隱藏未提交內容')
      if (/^[a-z]$/.test(tag)) reasons.add('含 assume-unchanged 旗標，可能隱藏未提交內容')
    }
    return [...reasons]
  }

  /** 收尾不得把 index 隱藏旗標或 sparse checkout 當作乾淨工作樹。 */
  async assertCompleteWorktree(cwd: string): Promise<void> {
    const reasons = await this.hiddenChangeReasons(cwd)
    if (reasons.length) throw new Error(`工作樹無法安全收尾：${reasons.join('；')}`)
  }

  async snapshot(cwd: string): Promise<GitSnapshot> {
    await this.root(cwd)
    const head = await this.head(cwd)
    const branch = await this.branch(cwd)
    const status = await this.git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const files = parseStatus(status)
    for (const file of files) await verifyFilePath(cwd, file.path, true)
    const index = await this.git(cwd, ['ls-files', '--stage', '-z'])
    const stagedDiff = await this.git(cwd, ['diff', '--cached', ...DIFF_ARGS])
    const workingDiff = await this.git(cwd, ['diff', ...DIFF_ARGS])
    const untracked = await untrackedContent(cwd, files)
    if (head !== await this.head(cwd)) throw new Error('讀取期間 HEAD 已變更，請重新整理')
    const fingerprint = createHash('sha256').update(JSON.stringify({ head, branch, status, index, stagedDiff, workingDiff, untracked })).digest('hex')
    return { head, branch, fingerprint, files, stagedDiff, workingDiff }
  }

  async stage(cwd: string, paths: string[], expectedFingerprint: string): Promise<GitSnapshot> {
    const snapshot = await this.snapshot(cwd)
    if (snapshot.fingerprint !== expectedFingerprint) throw new Error('工作區已變更，暫存預覽已過期')
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES || new Set(paths).size !== paths.length) throw new Error('請選擇不重複的變更檔案')
    const known = new Set(snapshot.files.map((file) => file.path))
    for (const path of paths) {
      if (typeof path !== 'string' || !known.has(path)) throw new Error('只能暫存目前清單中的變更檔案')
      await verifyFilePath(cwd, path, false)
    }
    if (snapshot.files.some(isConflict)) throw new Error('工作區有衝突，請先解決衝突')
    // 已暫存刪除不再存在於 index；重送該路徑會讓 git add 失敗。
    const pending = paths.filter((path) => snapshot.files.some((file) => file.path === path && (file.index !== 'D' || file.working !== ' ')))
    if (pending.length) await this.git(cwd, ['--literal-pathspecs', 'add', '--', ...pending])
    return this.snapshot(cwd)
  }

  private async checkSecrets(cwd: string, files: ChangedFile[]): Promise<void> {
    for (const file of files.filter((entry) => entry.index !== 'D')) {
      await verifyFilePath(cwd, file.path, false)
      const entry = await this.git(cwd, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', file.path])
      if (entry.startsWith('120000 ') || entry.startsWith('160000 ')) throw new Error('不支援 symlink 或 submodule 提交')
      const content = await this.git(cwd, ['cat-file', 'blob', `:${file.path}`])
      checkSecretContent(file.path, content)
    }
  }

  /** 在不暫存的情況下檢查全部待提交內容，供整個工作樹收尾使用。 */
  async previewAllChanges(cwd: string, message: string): Promise<GitSnapshot> {
    await this.assertCompleteWorktree(cwd)
    const snapshot = await this.snapshot(cwd)
    if (!snapshot.branch) throw new Error('detached HEAD 不提供提交')
    if (snapshot.files.some(isConflict)) throw new Error('工作區有未解決的衝突')
    if (snapshot.files.length) validateMessage(message)
    for (const file of snapshot.files) {
      await verifyFilePath(cwd, file.path, false)
      const entry = await this.git(cwd, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', file.path])
      if (entry.startsWith('120000 ') || entry.startsWith('160000 ')) throw new Error('不支援 symlink 或 submodule 提交')
      try {
        const stat = await lstat(join(cwd, file.path))
        if (!stat.isFile()) throw new Error('待提交項目不是一般檔案')
        if (stat.size > MAX_UNTRACKED_BYTES) throw new Error('待提交檔案超過 32 MiB，請先整理工作區')
        const handle = await open(join(cwd, file.path), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { checkSecretContent(file.path, await handle.readFile('utf8')) } finally { await handle.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return snapshot
  }

  async previewCommit(cwd: string, message: string): Promise<CommitPreview> {
    validateMessage(message)
    const snapshot = await this.snapshot(cwd)
    if (!snapshot.branch) throw new Error('detached HEAD 不提供提交')
    if (snapshot.files.some(isConflict)) throw new Error('工作區有未解決的衝突')
    const files = stagedFiles(snapshot.files)
    if (!files.length) throw new Error('沒有已暫存的 staged 變更')
    await this.checkSecrets(cwd, files)
    return { fingerprint: snapshot.fingerprint, head: snapshot.head, message, files: files.map((file) => file.path), diff: snapshot.stagedDiff }
  }

  async commit(cwd: string, preview: CommitPreview): Promise<{ head: string }> {
    const current = await this.previewCommit(cwd, preview.message)
    if (current.head !== preview.head || current.fingerprint !== preview.fingerprint
      || current.diff !== preview.diff || JSON.stringify(current.files) !== JSON.stringify(preview.files)) throw new Error('提交預覽已過期，Git 內容已變更')
    // 保留原有 hooks；Git 不接受由面板任意提供的旗標。
    await this.git(cwd, ['commit', '--file=-'], preview.message)
    return { head: await this.head(cwd) }
  }

  private async worktreeReasons(cwd: string): Promise<string[]> {
    const records = (await this.git(cwd, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').filter(Boolean)
    const path = await realpath(cwd)
    const matching = records.find((record) => record.split('\0').includes(`worktree ${path}`))
    const reasons: string[] = []
    if (!matching) reasons.push('無法確認工作區登錄')
    if (records[0]?.split('\0').includes(`worktree ${path}`)) reasons.push('主要工作區不可清理')
    if (matching?.split('\0').some((line) => /^locked(?: |$)/.test(line))) reasons.push('工作區已鎖定')
    return reasons
  }

  async cleanupCheck(cwd: string, baseRef: string): Promise<{ safe: boolean; reasons: string[] }> {
    await this.root(cwd)
    if (!baseRef || baseRef.startsWith('-') || /[\0\r\n]/.test(baseRef)) throw new Error('基準分支無效')
    const reasons = await this.worktreeReasons(cwd)
    reasons.push(...await this.hiddenChangeReasons(cwd))
    if (!(await this.branch(cwd))) reasons.push('detached HEAD 不可自動清理')
    const status = await this.git(cwd, ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'])
    if (status) reasons.push('包含未保存變更、未追蹤或忽略檔案')
    const index = await this.git(cwd, ['ls-files', '--stage', '-z'])
    if (index.split('\0').some((entry) => entry.startsWith('160000 '))) reasons.push('含 submodule，需人工清理')
    const gitDir = (await this.git(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
      try { await lstat(join(gitDir, marker)); reasons.push('有進行中的 Git 操作') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    try {
      const base = (await this.git(cwd, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).trim()
      await this.git(cwd, ['merge-base', '--is-ancestor', 'HEAD', base])
    } catch { reasons.push('無法證明目前提交已合併至基準分支') }
    return { safe: reasons.length === 0, reasons: [...new Set(reasons)] }
  }

  async push(cwd: string, expectedHead: string, expectedRemoteUrl?: string): Promise<void> {
    await this.root(cwd)
    const head = await this.head(cwd)
    if (head !== expectedHead) throw new Error('HEAD 已變更，Push 預覽已過期')
    const branch = await this.branch(cwd)
    if (!branch || /^(main|master)$/i.test(branch)) throw new Error('不可 Push 主要分支或 detached HEAD')
    await this.git(cwd, ['check-ref-format', '--branch', branch])
    const fetchUrls = lines(await this.git(cwd, ['remote', 'get-url', '--all', 'origin']))
    const pushUrls = lines(await this.git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']))
    if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]
      || (expectedRemoteUrl !== undefined && expectedRemoteUrl !== fetchUrls[0])) throw new Error('origin 或 pushurl 已變更／不同來源，請人工確認遠端')
    await this.git(cwd, ['push', '--porcelain', 'origin', `${head}:refs/heads/${branch}`])
  }
}
