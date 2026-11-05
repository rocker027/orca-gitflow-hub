import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, rmdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { GitHubIdentity, Run, Workspace } from './contracts'
import type { Execution, HubAction } from './protocol'
import type { FinishContext } from './finish-workflow'

export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}
export interface Operation {
  action: HubAction
  workspace: Workspace
  fingerprint: string
  createdAt: number
  state: 'prepared' | 'running' | 'succeeded' | 'failed'
  identity?: GitHubIdentity
  baseSha?: string
  outcome?: Execution
  finish?: FinishContext
  /** 使用者確認要傳給 AI 的變更內容；執行時只送這份。 */
  summary?: string
}
export const previewLifetimeMs = 10 * 60 * 1000
export const stateKey = (id: string) => createHash('sha256').update(id).digest('hex')

export class Operations {
  private readonly busy = new Set<string>()
  constructor(private readonly storage: Storage, private readonly run: Run) {}
  async prepare(operation: Omit<Operation, 'createdAt' | 'state'>): Promise<string> {
    const token = randomUUID()
    await this.storage.set(`operation.${token}`, { ...operation, createdAt: Date.now(), state: 'prepared' })
    return token
  }
  async execute(token: string, perform: (operation: Operation) => Promise<Execution>): Promise<Execution> {
    if (!/^[a-f0-9-]{36}$/.test(token) || this.busy.has(token)) throw new Error('這個預覽不存在或正在執行。')
    this.busy.add(token)
    try { return await this.executeOnce(token, perform) } finally { this.busy.delete(token) }
  }
  private async executeOnce(token: string, perform: (operation: Operation) => Promise<Execution>): Promise<Execution> {
    const operation = await this.storage.get(`operation.${token}`) as Operation | undefined
    if (!operation) throw new Error('找不到操作預覽，請重新預覽。')
    if (operation.state === 'succeeded' && operation.outcome) return operation.outcome
    if (operation.state !== 'prepared') throw new Error('前次操作結果可能未知。請重新整理並核對實際狀態，勿重送。')
    if (Date.now() - operation.createdAt > previewLifetimeMs || operation.createdAt > Date.now()) throw new Error('預覽已過期，請重新預覽。')
    await this.storage.set(`operation.${token}`, { ...operation, state: 'running' })
    try {
      const outcome = await perform(operation)
      await this.storage.set(`operation.${token}`, { ...operation, state: 'succeeded', outcome })
      return outcome
    } catch (error) {
      await this.storage.set(`operation.${token}`, { ...operation, state: 'failed' })
      throw error
    }
  }
  async withLock<T>(workspace: Workspace, perform: () => Promise<T>): Promise<T> {
    const common = (await this.run('git', ['rev-parse', '--git-common-dir'], { cwd: workspace.path })).trim()
    const directory = await realpath(isAbsolute(common) ? common : resolve(workspace.path, common))
    const lock = resolve(directory, 'gitflow-hub.lock')
    try { await mkdir(lock) } catch { throw new Error('此儲存庫有未完成的 Hub 操作。請先核對狀態與 GitFlow Hub 鎖。') }
    try { return await perform() } finally { await rmdir(lock) }
  }
}
