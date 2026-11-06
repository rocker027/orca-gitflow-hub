import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { cancelAll, createRunner } from '../src/services/process'

const executables = { git: process.execPath, orca: process.execPath, gh: process.execPath, claude: process.execPath }

test('命令參數以原字串傳入且不經 shell 展開', async () => {
  const run = createRunner(executables)
  const value = '$(echo leaked); `whoami` && literal'
  assert.equal(await run('git', ['-e', 'process.stdout.write(process.argv[1])', value]), value)
})

test('文字由 stdin 傳送並保留換行', async () => {
  const run = createRunner(executables)
  const input = '標題\n\n內容\n'
  assert.equal(await run('git', ['-e', 'process.stdin.pipe(process.stdout)'], {input}), input)
})

test('繼承的 Git 與 askpass 控制變數不影響子程序', async () => {
  const run = createRunner(executables, {env: {...process.env, GIT_DIR: '/secret', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.status', GIT_CONFIG_VALUE_0: '!echo hijack', SSH_ASKPASS: '/secret', KEEP_ME: 'yes', GH_TOKEN: 'fixture-auth'}})
  const observed = JSON.parse(await run('git', ['-e', 'process.stdout.write(JSON.stringify(process.env))']))
  assert.equal(observed.GIT_DIR, undefined)
  assert.equal(observed.GIT_CONFIG_COUNT, undefined)
  assert.equal(observed.SSH_ASKPASS, undefined)
  assert.equal(observed.KEEP_ME, 'yes')
  assert.equal(observed.GIT_TERMINAL_PROMPT, '0')
  assert.equal(observed.GIT_PAGER, 'cat')
  assert.equal(observed.GH_TOKEN, 'fixture-auth')
  assert.equal(observed.GH_PROMPT_DISABLED, '1')
  assert.equal(observed.GH_NO_UPDATE_NOTIFIER, '1')
})

test('失敗不回傳可能帶憑證的 stderr', async () => {
  const run = createRunner(executables)
  await assert.rejects(run('gh', ['-e', 'process.stderr.write("token=SECRET");process.exit(3)']), (error: Error) => {
    assert.match(error.message, /gh/)
    assert.doesNotMatch(error.message, /SECRET/)
    return true
  })
})

test('程序超時、取消、輸出過大與不存在的 CLI 都明確拒絕', async () => {
  const run = createRunner(executables, {maxBuffer: 512, timeoutMs: 40})
  await assert.rejects(run('git', ['-e', 'setTimeout(()=>{},10000)']), /逾時/)
  await assert.rejects(run('git', ['-e', 'process.stdout.write("a".repeat(2048))'], {timeoutMs: 1000}), /上限/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(run('git', ['-e', 'process.stdout.write("ok")'], {signal: controller.signal}), /取消/)
  const missing = createRunner({...executables, gh: '/not-installed/gh'})
  await assert.rejects(missing('gh', ['--version']), /找不到/)
})

test('NUL 或未知工具不得進入程序執行', async () => {
  const run = createRunner(executables)
  await assert.rejects(run('git', ['hello\0world']), /參數/)
  await assert.rejects(run('sh' as 'git', []), /工具/)
})


test('Worker 停止時取消所有自建程序，含忽略 SIGTERM 的程序', async () => {
  const run = createRunner(executables, {timeoutMs: 5000})
  const pending = [run('git', ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)']),
    run('orca', ['-e', 'setInterval(()=>{},1000)'])]
  setTimeout(cancelAll, 80)
  const settled = await Promise.allSettled(pending)
  assert.equal(settled.length, 2)
  for (const outcome of settled) {
    assert.equal(outcome.status, 'rejected')
    if (outcome.status === 'rejected') assert.match(String(outcome.reason), /取消/)
  }
})


function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function descendantIdentity(marker: string): Promise<{ child: number; parent: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return JSON.parse(await readFile(marker, 'utf8')) } catch { await delay(10) }
  }
  throw new Error('子程序 fixture 未就緒')
}

test('父程序退出且子孫關閉 stdio 時，取消仍等群組強制終止後才回報', {skip: process.platform === 'win32'}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gitflow-descendant-'))
  const marker = join(folder, 'ready.json')
  const descendant = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],JSON.stringify({child:process.pid,parent:process.ppid}));setInterval(()=>{},1000)'
  const parent = 'require("node:child_process").spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{stdio:"ignore"});setInterval(()=>{},1000)'
  const controller = new AbortController()
  const run = createRunner(executables, {timeoutMs: 5000})
  const pending = run('git', ['-e', parent, descendant, marker], {signal: controller.signal})
  const outcome = pending.then(() => null, error => error as Error)
  let identity: {child: number; parent: number} | undefined
  try {
    identity = await descendantIdentity(marker)
    const started = performance.now()
    controller.abort()
    const error = await outcome
    const elapsed = performance.now() - started
    assert.match(error?.message ?? '', /取消/)
    assert.ok(elapsed >= 200, `在 ${Math.round(elapsed)}ms 就回報；子孫仍存活=${isAlive(identity.child)}`)
    for (let attempt = 0; attempt < 100 && isAlive(identity.child); attempt += 1) await delay(10)
    assert.equal(isAlive(identity.child), false, '取消後子孫程序不可殘留')
  } finally {
    controller.abort()
    if (identity) {
      try { process.kill(-identity.parent, 'SIGKILL') } catch {}
      try { process.kill(identity.child, 'SIGKILL') } catch {}
    }
    await outcome
    await rm(folder, {recursive: true, force: true})
  }
})

// P1：只新增 claude 這一個工具，參數同樣以原字串傳入，不經 shell。
test('claude 只以允許清單中的工具身分執行，其他工具仍拒絕', async () => {
  const run = createRunner(executables)
  assert.equal(await run('claude', ['-e', 'process.stdout.write(process.argv[1])', '$(whoami)']), '$(whoami)')
  for (const tool of ['codex', 'sh', 'node', 'bash']) await assert.rejects(run(tool as 'claude', []), /工具/)
})

// P-USER：macOS 的 claude 依 USER 讀取鑰匙圈中的登入資料；Orca Worker 的環境可能沒有 USER，缺少時要補上目前使用者。
test('環境缺少 USER／LOGNAME 時補上目前使用者，已有值時保留', async () => {
  const { userInfo } = await import('node:os')
  const bare = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
  const observed = JSON.parse(await createRunner(executables, { env: bare })('claude', ['-e', 'process.stdout.write(JSON.stringify(process.env))']))
  assert.equal(observed.USER, userInfo().username)
  assert.equal(observed.LOGNAME, userInfo().username)
  const kept = JSON.parse(await createRunner(executables, { env: { ...bare, USER: 'someone', LOGNAME: 'someone' } })('claude', ['-e', 'process.stdout.write(JSON.stringify(process.env))']))
  assert.equal(kept.USER, 'someone')
  assert.equal(kept.LOGNAME, 'someone')
})
