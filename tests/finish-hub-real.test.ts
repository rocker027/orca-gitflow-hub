import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, rm, writeFile, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub } from '../src/hub'
import { GitService } from '../src/services/git'
import { GitHubService } from '../src/services/github'
import { run } from '../src/services/process'
import type { Workspace } from '../src/contracts'
import type { OrcaService } from '../src/services/orca'

const exec=promisify(execFile)
async function git(cwd:string,...args:string[]):Promise<string> {
  return (await exec('git',args,{cwd,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim()
}
async function fixture(t:{after(fn:()=>Promise<void>):void}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'gitflow-real-finish-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const main=join(root,'main');const feature=join(root,'feature');await mkdir(main)
  await git(main,'init','-b','main');await git(main,'config','user.name','Fixture');await git(main,'config','user.email','fixture@example.invalid')
  await git(main,'config','commit.gpgsign','false');await writeFile(join(main,'shared.txt'),'initial\n')
  await git(main,'add','shared.txt');await git(main,'commit','-m','initial');await git(main,'worktree','add','-b','feature',feature)
  const ws=(path:string,main:boolean):Workspace=>({id:`repo::${path}`,repoId:'repo',path,branch:main?'main':'feature',head:'',displayName:main?'main':'feature',hostId:'local',isMainWorktree:main})
  const source=ws(feature,false);const target=ws(main,true);const workspaces=new Map([[source.id,source],[target.id,target]])
  let removals=0
  const orca={list:async()=>({workspaces:[...workspaces.values()],warnings:[]}),resolve:async(id:string)=>{const value=workspaces.get(id);if(!value)throw new Error('工作樹不存在');return value},assertIdle:async()=>undefined,
    remove:async(value:Workspace)=>{await git(main,'worktree','remove',value.path);workspaces.delete(value.id);removals++}} as unknown as OrcaService
  const storage=new Map<string,unknown>()
  const hub=new Hub(run,{get:async key=>storage.get(key),set:async(key,value)=>{storage.set(key,structuredClone(value))}},async()=>({opened:true}),{git:new GitService(run),github:new GitHubService(run),orca})
  return {hub,source,target,main,feature,removals:()=>removals,action:{kind:'finish',workspaceId:source.id,targetWorkspaceId:target.id,message:'完成測試功能',remove:true}}
}

test('真實Git從Hub預覽一路提交合併清理，自己的repo鎖不會阻擋收尾',async t=>{
  const f=await fixture(t);await writeFile(join(f.feature,'new.txt'),'new feature\n')
  const preview=await f.hub.preview(f.action)
  assert.equal(await git(f.main,'rev-list','--count','HEAD'),'1')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'completed',JSON.stringify(result))
  assert.equal(await readFile(join(f.main,'new.txt'),'utf8'),'new feature\n')
  assert.equal(await git(f.main,'rev-list','--count','HEAD'),'2')
  await assert.rejects(stat(f.feature),{code:'ENOENT'})
  assert.equal(await git(f.main,'branch','--list','feature'),'feature')
  await f.hub.execute(preview.token);assert.equal(f.removals(),1)
})
test('真實Git衝突時來源提交已保存，目標內容不動且工作樹保留',async t=>{
  const f=await fixture(t)
  await writeFile(join(f.main,'shared.txt'),'target version\n');await git(f.main,'commit','-am','target change')
  const before=await git(f.main,'rev-parse','HEAD')
  await writeFile(join(f.feature,'shared.txt'),'feature version\n')
  const preview=await f.hub.preview(f.action);const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.equal(result.steps?.[0].status,'done')
  assert.equal(result.steps?.[1].status,'failed');assert.equal(f.removals(),0)
  assert.equal(await git(f.main,'rev-parse','HEAD'),before)
  assert.equal(await readFile(join(f.main,'shared.txt'),'utf8'),'target version\n')
  assert.equal(await git(f.feature,'status','--porcelain'),'')
  assert.equal(await git(f.feature,'rev-list','--count','HEAD'),'2')
})
