import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub } from '../src/hub'
import {stateKey} from '../src/operations'
import type { GitSnapshot, Workspace } from '../src/contracts'
import type { GitService } from '../src/services/git'
import type { GitHubService } from '../src/services/github'
import type { OrcaService } from '../src/services/orca'

async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const path=await mkdtemp(join(tmpdir(),'gitflow-hub-'));t.after(()=>rm(path,{recursive:true,force:true}))
  const workspace:Workspace={id:'r::'+path,repoId:'r',path,branch:'feature/a',head:'a'.repeat(40),displayName:'a',hostId:'local',isMainWorktree:false}
  let snapshot:GitSnapshot={head:workspace.head,branch:workspace.branch,fingerprint:'v1',files:[{path:'a.txt',index:' ',working:'M'}],stagedDiff:'',workingDiff:'changed'}
  const values=new Map<string,unknown>();let stages=0;let posts=0;let links=0
  const git={snapshot:async()=>snapshot,stage:async()=>{stages++;return snapshot},previewCommit:async()=>({head:snapshot.head,fingerprint:snapshot.fingerprint,message:'Draft',files:['a.txt'],diff:'diff text'})} as unknown as GitService
  const identity={host:'example.test',owner:'a',repo:'b',projectPath:'a/b',remoteUrl:'git@example.test:a/b.git',webUrl:'https://example.test/a/b'}
  const github={identity:async()=>identity,createDraft:async()=>{posts++;return {number:1,url:identity.webUrl+'/pull/1'}}} as unknown as GitHubService
  const orca={list:async()=>({workspaces:[workspace],warnings:[]}),resolve:async(id:string)=>{if(id!==workspace.id)throw new Error('拒絕工作區');return workspace},link:async()=>{links++;throw new Error('離線')},launch:async()=> 'agent-handle'} as unknown as OrcaService
  const hub=new Hub(async()=>path,{get:async key=>values.get(key),set:async(key,value)=>{values.set(key,structuredClone(value))}},async()=>({opened:true}),{git,github,orca})
  return {hub,workspace,values,setFingerprint:(value:string)=>{snapshot={...snapshot,fingerprint:value}},calls:()=>({stages,posts,links})}
}
test('Hub 入口到暫存必經 preview，stale拒絕且不執行服務',async t=>{
  const f=await fixture(t)
  const input={kind:'stage',workspaceId:f.workspace.id,paths:['a.txt'],fingerprint:'v1'}
  const preview=await f.hub.preview(input);assert.equal(f.calls().stages,0)
  f.setFingerprint('v2')
  await assert.rejects(f.hub.execute(preview.token),/失效/)
  assert.equal(f.calls().stages,0)
  await assert.rejects(f.hub.execute(preview.token),/未知/)
})
test('成功暫存token重送不重複，任意workspace/path拒絕',async t=>{
  const f=await fixture(t)
  const preview=await f.hub.preview({kind:'stage',workspaceId:f.workspace.id,paths:['a.txt'],fingerprint:'v1'})
  await f.hub.execute(preview.token);await f.hub.execute(preview.token)
  assert.equal(f.calls().stages,1)
  await assert.rejects(f.hub.inspect('other'),/工作區/)
  await assert.rejects(f.hub.preview({kind:'stage',workspaceId:f.workspace.id,paths:['../secret'],fingerprint:'v1'}),/清單/)
})
test('PR建立後關聯失敗仍保存PR結果，重送token不再建立',async t=>{
  const f=await fixture(t)
  const preview=await f.hub.preview({kind:'draft',workspaceId:f.workspace.id,targetBranch:'main',title:'Title',description:'Body'})
  const outcome=await f.hub.execute(preview.token)
  assert.match(outcome.message,/關聯失敗/);assert.match(outcome.url!,/pull\/1$/)
  await f.hub.execute(preview.token)
  assert.deepEqual(f.calls(),{stages:0,posts:1,links:1})
})

test('AI 草稿只從本次檔案匯入，空檔、過期與symlink拒絕',async t=>{
  const f=await fixture(t)
  const preview=await f.hub.preview({kind:'ai-message',workspaceId:f.workspace.id,agent:'codex'})
  await f.hub.execute(preview.token)
  const draft=f.values.get(`message.${stateKey(f.workspace.id)}`) as {path:string}
  await assert.rejects(f.hub.aiResult(f.workspace.id),/尚未寫入/)
  await writeFile(draft.path,'feat: 完成測試')
  assert.equal((await f.hub.aiResult(f.workspace.id)).message,'feat: 完成測試')
  f.setFingerprint('v2');await assert.rejects(f.hub.aiResult(f.workspace.id),/改變/)
  f.setFingerprint('v1');await writeFile(draft.path,'a'.repeat(8001))
  await assert.rejects(f.hub.aiResult(f.workspace.id),/大小/)
  await unlink(draft.path);await symlink('/etc/hosts',draft.path)
  await assert.rejects(f.hub.aiResult(f.workspace.id))
})
