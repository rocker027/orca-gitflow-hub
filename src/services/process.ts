import { spawn, type ChildProcess } from 'node:child_process'
import type { Run } from '../contracts'

export type Executables = Record<'git' | 'orca' | 'gh', string>
export interface RunnerOptions { maxBuffer?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv }
const MAX_BUFFER = 2 * 1024 * 1024
const active = new Map<ChildProcess, () => void>()

/** 只取消本 Worker 建立的程序，POSIX 同時結束其 hooks 子程序群組。 */
export function cancelAll(): void {
  for (const cancel of active.values()) cancel()
}

function environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('GIT_') && !['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].includes(key)))
  return {...inherited, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat',
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1'}
}

function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve()
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { /* 程序已結束時不覆寫原本的失敗原因。 */ }
  }
  kill('SIGTERM')
  // 即使父程序與 stdio 已退出，也必須保留 timer 結束同群組的子孫。
  return new Promise(resolve => setTimeout(() => { kill('SIGKILL'); resolve() }, 250))
}

function validate(tool: string, args: readonly string[], options: Parameters<Run>[2]): void {
  if (!['git', 'orca', 'gh'].includes(tool)) throw new Error('不支援的工具。')
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      args.reduce((length, arg) => length + Buffer.byteLength(arg), 0) > MAX_BUFFER ||
      options?.cwd?.includes('\0') || (options?.input && Buffer.byteLength(options.input) > MAX_BUFFER)) {
    throw new Error('命令參數不合法或超過長度上限。')
  }
  if (options?.signal?.aborted) throw new Error(`${tool} 已取消。`)
}

/** argv 與 stdin 分開傳送；未將 CLI 的原始 stderr 暴露到面板。 */
export function createRunner(executables: Executables, defaults: RunnerOptions = {}): Run {
  const binaries = {...executables}
  const env = environment(defaults.env ?? process.env)
  return async (tool, args, options = {}) => {
    validate(tool, args, options)
    const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? 30_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
      throw new Error('命令逾時設定不合法。')
    }
    return execute(binaries[tool], tool, args, options, env, timeoutMs, defaults.maxBuffer ?? MAX_BUFFER)
  }
}

function collectOutput(child: ChildProcess, maxBuffer: number, stop: (message: string) => void, tool: string): Buffer[] {
  let size = 0
  const chunks: Buffer[] = []
  const collect = (chunk: Buffer, keep: boolean) => {
    size += chunk.length
    if (size > maxBuffer) stop(`${tool} 輸出超過上限，請縮小變更範圍。`)
    else if (keep) chunks.push(chunk)
  }
  child.stdout!.on('data', chunk => collect(chunk, true))
  child.stderr!.on('data', chunk => collect(chunk, false))
  return chunks
}

function startupError(tool: string, error: NodeJS.ErrnoException): string {
  return error.code === 'ENOENT' ? `找不到 ${tool}，請先安裝並確認 PATH。` : `${tool} 無法啟動。`
}

function execute(binary: string, tool: string, args: readonly string[], options: NonNullable<Parameters<Run>[2]>,
  env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {cwd: options.cwd, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']})
    let failure: string | undefined
    let termination: Promise<void> | undefined
    const stop = (message: string) => {
      failure ??= message
      termination ??= terminate(child)
    }
    const abort = () => stop(`${tool} 已取消；若為寫入操作，請先核對結果。`)
    active.set(child, abort)
    const timer = setTimeout(() => stop(`${tool} 執行逾時；若為寫入操作，請先核對結果。`), timeoutMs)
    options.signal?.addEventListener('abort', abort, {once: true})
    const output = collectOutput(child, maxBuffer, stop, tool)
    child.on('error', (error: NodeJS.ErrnoException) => stop(startupError(tool, error)))
    child.stdin.on('error', () => stop(`${tool} 無法傳送輸入。`))
    child.once('close', async code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (code !== 0) stop(`${tool} 執行失敗（結束碼 ${code ?? '未知'}）；請核對工具設定與操作結果。`)
      await termination
      active.delete(child)
      if (failure) reject(new Error(failure))
      else resolve(Buffer.concat(output).toString('utf8'))
    })
    child.stdin.end(options.input ?? '')
    if (options.signal?.aborted) abort()
  })
}

const orcaBinary = process.env.ORCA_CLI_COMMAND ||
  (process.platform === 'darwin' ? '/Applications/Orca.app/Contents/Resources/bin/orca' : 'orca-ide')
export const run = createRunner({git: 'git', orca: orcaBinary, gh: 'gh'})
