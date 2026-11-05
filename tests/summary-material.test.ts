import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Run } from '../src/contracts'
import { GitService } from '../src/services/git'

const run: Run = async (tool, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(tool, [...args], { cwd: options.cwd, shell: false })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', reject)
  child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)))
  child.stdin.end(options.input)
})

async function fixture(): Promise<{ root: string; cwd: string; service: GitService; git: (...args: string[]) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'gitflow-git-'))
  const cwd = join(root, 'repo')
  await mkdir(cwd)
  const git = (...args: string[]) => run('git', args, { cwd })
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(cwd, 'base.txt'), 'initial\n')
  await git('add', '--', 'base.txt')
  await git('commit', '-m', 'initial')
  await git('checkout', '-b', 'feature/test')
  return { root, cwd, service: new GitService(run), git }
}

// 這個檔案的測試資料不可出現字面上的私鑰或金鑰：Hub 的提交機密檢查會掃描已修改檔案的全文，
// 一旦命中，這個分支就無法從面板完成合併。需要時在執行時組出字串。
const PEM_HEADER = '-----BEGIN ' + 'PRIVATE KEY-----'
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP'

// M1：送給 AI 的內容只包含這次未提交的變更，包含 staged、unstaged 與未追蹤的文字檔。
test('M1 AI 說明素材包含 staged、unstaged 與未追蹤文字內容，指紋與 snapshot 一致', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'base.txt'), 'initial\nstaged line\n')
    await f.git('add', '--', 'base.txt')
    await writeFile(join(f.cwd, 'base.txt'), 'initial\nstaged line\nworking line\n')
    await writeFile(join(f.cwd, 'new.txt'), 'brand new content\n')
    await writeFile(join(f.cwd, 'image.bin'), Buffer.from([0, 1, 2, 3]))
    const material = await f.service.summaryMaterial(f.cwd)
    assert.match(material.text, /\+staged line/)
    assert.match(material.text, /\+working line/)
    assert.match(material.text, /new\.txt/)
    assert.match(material.text, /brand new content/)
    assert.match(material.text, /image\.bin/)
    assert.equal(material.text.includes('\0'), false, '二進位內容不得送出')
    assert.deepEqual([...material.files].sort(), ['base.txt', 'image.bin', 'new.txt'])
    assert.equal(material.truncated, false)
    assert.equal(material.fingerprint, (await f.service.snapshot(f.cwd)).fingerprint)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

// M2：機密不能送出，包括敏感檔名、私鑰內容，以及刪除行裡的金鑰。
test('M2 AI 說明素材拒絕敏感檔、私鑰與 Diff 刪除行中的金鑰', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, '.env'), 'TOKEN=abc')
    await assert.rejects(f.service.summaryMaterial(f.cwd), /機密|敏感/)
    await rm(join(f.cwd, '.env'))
    await writeFile(join(f.cwd, 'key.txt'), `${PEM_HEADER}\ncontent`)
    await assert.rejects(f.service.summaryMaterial(f.cwd), /機密|私鑰|敏感/)
    await rm(join(f.cwd, 'key.txt'))
    await writeFile(join(f.cwd, 'config.txt'), `key=${AWS_KEY}\n`)
    await f.git('add', '--', 'config.txt')
    await f.git('commit', '-m', 'add config')
    await writeFile(join(f.cwd, 'config.txt'), 'key=from-env\n')
    await assert.rejects(f.service.summaryMaterial(f.cwd), /機密|私鑰|敏感/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('M3 AI 說明素材沒有變更時拒絕，過大時截斷並標示', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.service.summaryMaterial(f.cwd), /沒有未提交/)
    await writeFile(join(f.cwd, 'big.txt'), `${'大量內容\n'.repeat(40_000)}`)
    await f.git('add', '--', 'big.txt')
    const material = await f.service.summaryMaterial(f.cwd)
    assert.equal(material.truncated, true)
    assert.ok(material.text.length <= 100_000, String(material.text.length))
    assert.match(material.text, /已截斷/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

// M4：刪除或改名的敏感檔，原內容會出現在 Diff 的刪除行；檔案已不存在也要依名稱擋下。
test('M4 AI 說明素材拒絕已刪除、改名或新增後又刪除的敏感檔', async () => {
  const secret = 'DATABASE_URL=postgres://admin:hunter2@db/prod\n'
  const scenarios: { name: string; setup: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> }[] = [
    { name: '已暫存刪除', setup: async (f) => { await f.git('rm', '-q', '--', '.env') } },
    { name: '未暫存刪除', setup: async (f) => { await rm(join(f.cwd, '.env')) } },
    { name: '改名', setup: async (f) => { await f.git('mv', '.env', 'config.txt'); await writeFile(join(f.cwd, 'config.txt'), 'X=1\n') } },
    { name: '刪除 .npmrc', setup: async (f) => { await rm(join(f.cwd, '.npmrc')) } }
  ]
  for (const scenario of scenarios) {
    const f = await fixture()
    try {
      await writeFile(join(f.cwd, '.env'), secret)
      await writeFile(join(f.cwd, '.npmrc'), '//registry.npmjs.org/:_authToken=abc\n')
      await f.git('add', '--', '.env', '.npmrc')
      await f.git('commit', '-q', '-m', 'oops')
      await scenario.setup(f)
      await assert.rejects(f.service.summaryMaterial(f.cwd), /敏感|機密/, scenario.name)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, '.env.local'), secret)
    await f.git('add', '--', '.env.local')
    await rm(join(f.cwd, '.env.local'))
    await assert.rejects(f.service.summaryMaterial(f.cwd), /敏感|機密/, '新增後又刪除（AD）')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

// M5：送給 AI 前多擋幾種常見金鑰格式與憑證檔；只用在 AI 流程，不改變提交流程。
test('M5 AI 說明素材另外擋下常見雲端與服務金鑰，提交流程維持原行為', async () => {
  const tokens = ['ghp_' + 'a'.repeat(36), 'github_pat_' + 'b'.repeat(40), 'sk-ant-api03-' + 'c'.repeat(30),
    'sk_live_' + 'd'.repeat(24), 'xoxb-' + '1'.repeat(12) + '-abcdef', 'AIza' + 'e'.repeat(35), 'npm_' + 'f'.repeat(36)]
  for (const token of tokens) {
    const f = await fixture()
    try {
      await writeFile(join(f.cwd, 'README.md'), `token: ${token}\n`)
      await assert.rejects(f.service.summaryMaterial(f.cwd), /機密/, token.slice(0, 12))
      await f.service.previewAllChanges(f.cwd, '提交流程不受影響')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
  for (const name of ['.netrc', '.git-credentials', 'prod.tfvars', 'kubeconfig']) {
    const f = await fixture()
    try {
      await writeFile(join(f.cwd, name), 'machine example.com login a password b\n')
      await assert.rejects(f.service.summaryMaterial(f.cwd), /敏感|機密/, name)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
})
