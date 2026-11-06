import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Run } from '../src/contracts'
import { FinishGitService } from '../src/services/finish'
import { GitService } from '../src/services/git'

/** 測試用的真實 Git 執行器：隔離全域與系統設定，失敗時帶出 stderr 方便判讀。 */
export const run: Run = async (tool, args, options = {}) => new Promise((resolve, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const child = spawn(tool, [...args], {
    cwd: options.cwd, shell: false,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', reject)
  child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${stderr}\n${stdout}`)))
  child.stdin.end(options.input)
})

/** 建立主要工作樹 main 與功能工作樹 feature/test；可注入自訂 Run 模擬 Git 失敗。 */
export async function fixture(service: Run = run) {
  const root = await mkdtemp(join(tmpdir(), 'gitflow-finish-'))
  const target = join(root, 'main')
  const source = join(root, 'source')
  await mkdir(target)
  const git = (cwd: string, ...args: string[]) => run('git', args, { cwd })
  await git(target, 'init', '-b', 'main')
  await git(target, 'config', 'user.name', 'Fixture')
  await git(target, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(target, 'base.txt'), 'initial\n')
  await writeFile(join(target, '.gitignore'), 'ignored.txt\n')
  await git(target, 'add', '--', 'base.txt', '.gitignore')
  await git(target, 'commit', '-m', 'initial')
  await git(target, 'worktree', 'add', '-b', 'feature/test', source)
  return { root, source, target, git, service: new FinishGitService(service), snapshots: new GitService(service) }
}

export type Fixture = Awaited<ReturnType<typeof fixture>>

/** 寫入檔案並提交，回傳新提交 SHA。 */
export async function save(f: Fixture, cwd: string, file: string, value: string, message = `change ${file}`) {
  await writeFile(join(cwd, file), value)
  await f.git(cwd, '--literal-pathspecs', 'add', '--', file)
  await f.git(cwd, 'commit', '-m', message)
  return (await f.git(cwd, 'rev-parse', 'HEAD')).trim()
}
