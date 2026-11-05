import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Run, Workspace, WorkspaceSummary } from '../contracts'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
class OverviewError extends Error {}
interface Revision { path: string; commonDirectory: string; head: string }
const stripLineEnding = (value: string): string => value.replace(/\r?\n$/, '')

function countChanges(status: string): number {
  if (!status) return 0
  if (!status.endsWith('\0')) throw new OverviewError('Git 狀態資料不完整，請重新整理。')
  const records = status.slice(0, -1).split('\0')
  let count = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4 || !/^[ MADRCUT?!]{2} /.test(record) || record.startsWith('  ')) {
      throw new OverviewError('Git 狀態資料格式無法辨識，請重新整理。')
    }
    if (/[RC]/.test(record.slice(0, 2)) && !records[++index]) {
      throw new OverviewError('Git 重新命名資料不完整，請重新整理。')
    }
    count += 1
  }
  return count
}

function unknown(workspaceId: string, error: unknown): WorkspaceSummary {
  return {workspaceId, branch: '', head: '', changedFiles: -1, ahead: null, behind: null, lastMessage: '',
    error: error instanceof OverviewError ? error.message : '無法讀取工作區狀態，請確認 Git 與工作區路徑後重新整理。'}
}

/** 只讀取列表所需的 Git metadata；完整內容驗證由寫入操作的預覽負責。 */
export class OverviewService {
  constructor(private readonly run: Run) {}

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const response = await this.run('git', ['--no-pager', '-c', 'core.fsmonitor=false', '--no-optional-locks', ...args], {cwd})
    if (typeof response !== 'string' || Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
      throw new OverviewError('Git 狀態資料超過上限，無法顯示摘要。')
    }
    return response
  }

  private async head(cwd: string): Promise<string> {
    const head = (await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    if (!SHA.test(head)) throw new OverviewError('Git HEAD 無法辨識，請重新整理。')
    return head
  }

  private async revision(workspace: Workspace): Promise<Revision> {
    if (workspace.hostId !== 'local' || !isAbsolute(workspace.path)) {
      throw new OverviewError('只支援本機 Git 工作區。')
    }
    const path = await realpath(workspace.path)
    if (path !== resolvePath(workspace.path)) throw new OverviewError('工作區路徑含符號連結，請改用實體路徑。')
    const top = stripLineEnding(await this.git(path, ['rev-parse', '--show-toplevel']))
    if (top !== path) throw new OverviewError('工作區路徑不是 Git 根目錄。')
    const common = stripLineEnding(await this.git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    if (!isAbsolute(common)) throw new OverviewError('Git 共用目錄無法辨識。')
    return {path, commonDirectory: await realpath(common), head: await this.head(path)}
  }

  private async counts(source: Revision, target?: Revision): Promise<{ahead: number | null; behind: number | null}> {
    if (!target) return {ahead: null, behind: null}
    if (source.commonDirectory !== target.commonDirectory) throw new OverviewError('比較目標不屬於相同的 Git repository。')
    if (source.path === target.path) return {ahead: 0, behind: 0}
    const counts = (await this.git(source.path, ['rev-list', '--left-right', '--count', `${source.head}...${target.head}`])).trim()
    if (!/^\d+\s+\d+$/.test(counts)) throw new OverviewError('提交差異計數無法辨識。')
    const [ahead, behind] = counts.split(/\s+/).map(Number)
    if (![ahead, behind].every(Number.isSafeInteger)) throw new OverviewError('提交差異計數超過上限。')
    return {ahead, behind}
  }

  private async verifyHeads(source: Revision, target?: Revision): Promise<void> {
    const [sourceHead, targetHead] = await Promise.all([this.head(source.path), target ? this.head(target.path) : null])
    if (sourceHead !== source.head || (target && targetHead !== target.head)) {
      throw new OverviewError('工作區 HEAD 已變更，摘要已過期，請重新整理。')
    }
  }

  async summary(workspace: Workspace, target?: Workspace): Promise<WorkspaceSummary> {
    try {
      const [source, destination] = await Promise.all([this.revision(workspace), target ? this.revision(target) : undefined])
      const counts = await this.counts(source, destination)
      const [status, branch, message] = await Promise.all([
        this.git(source.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames']),
        this.git(source.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
        this.git(source.path, ['log', '-1', '--format=%s', source.head, '--']),
      ])
      const changedFiles = countChanges(status)
      const branchName = stripLineEnding(branch)
      if (!branchName || /[\0\r\n]/.test(branchName)) throw new OverviewError('Git 分支資料無法辨識。')
      await this.verifyHeads(source, destination)
      return {workspaceId: workspace.id, branch: branchName === 'HEAD' ? '' : branchName, head: source.head,
        changedFiles, ...counts, lastMessage: stripLineEnding(message)}
    } catch (error) { return unknown(workspace.id, error) }
  }
}
