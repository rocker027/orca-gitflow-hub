import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub } from '../src/hub'
import type { GitSnapshot, Workspace } from '../src/contracts'
import type { GitService } from '../src/services/git'
import type { GitHubService } from '../src/services/github'
import type { OrcaService } from '../src/services/orca'
import type { FinishGitService, FinishPlan } from '../src/services/finish'

async function fixture(t:{after(fn:()=>Promise<void>):void}) {
  const root=await mkdtemp(join(tmpdir(),'gitflow-finish-hub-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const workspace=(name:string,main=false):Workspace=>({id:`repo::${root}/${name}`,repoId:'repo',path:join(root,name),branch:name,head:(main?'b':'a').repeat(40),displayName:name,hostId:'local',isMainWorktree:main})
  const source=workspace('feature');const target=workspace('main',true)
  await mkdir(source.path);await mkdir(target.path)
  const snapshot=(ws:Workspace):GitSnapshot=>({branch:ws.branch,head:ws.head,fingerprint:ws.branch,files:ws===source?[{path:'a.txt',index:' ',working:'M'}]:[],stagedDiff:'',workingDiff:''})
  const snapshots=new Map([[source.path,snapshot(source)],[target.path,snapshot(target)]])
  const workspaces=new Map([[source.id,source],[target.id,target]])
  const calls:string[]=[];const faults=new Set<string>();const values=new Map<string,unknown>()
  const hit=(name:string)=>{calls.push(name);if(faults.has(name))throw new Error(`${name}失敗，寫入結果待核對`)}
  const git={snapshot:async(path:string)=>structuredClone(snapshots.get(path)!),cleanupCheck:async()=>({safe:!faults.has('dirty-cleanup'),reasons:['有變更']})} as unknown as GitService
  const orca={
    list:async()=>({workspaces:[...workspaces.values()],warnings:[]}),
    resolve:async(id:string)=>{const ws=workspaces.get(id);if(!ws)throw new Error('工作區已移除');return structuredClone(ws)},
    assertIdle:async(ws:Workspace)=>{hit(`idle:${ws.branch}`)},
    remove:async(ws:Workspace)=>{hit('cleanup');workspaces.delete(ws.id);await rm(ws.path,{recursive:true})}
  } as unknown as OrcaService
  const finish={
    prepare:async()=>{hit('prepare');return {source:structuredClone(snapshots.get(source.path)),target:structuredClone(snapshots.get(target.path)),files:['a.txt'],ahead:1,behind:0,needsCommit:true,mergeMode:'fast_forward'} as FinishPlan},
    commit:async()=>{hit('commit');snapshots.set(source.path,{...snapshots.get(source.path)!,head:'c'.repeat(40),fingerprint:'committed',files:[]});return 'c'.repeat(40)},
    merge:async()=>{hit('merge');snapshots.set(target.path,{...snapshots.get(target.path)!,head:'d'.repeat(40),fingerprint:'merged'});return 'd'.repeat(40)}
  } as unknown as FinishGitService
  const hub=new Hub(async()=>root,{get:async key=>values.get(key),set:async(key,value)=>{values.set(key,structuredClone(value))}},async()=>{hit('open');return {opened:true}}, {git,orca,github:{} as GitHubService,finish})
  const action={kind:'finish',workspaceId:source.id,targetWorkspaceId:target.id,message:'完成任務',remove:true}
  return {hub,action,calls,faults,source,target,workspaces,snapshots}
}

test('一次收尾預覽串接提交、合併、切換與清理，重送token不再寫入',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action)
  assert.equal(preview.steps?.length,4);assert.equal(f.calls.includes('commit'),false)
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'completed');assert.equal(result.workspaceId,f.target.id)
  assert.deepEqual(result.steps?.map(x=>x.status),['done','done','done','done'])
  assert.deepEqual(f.calls.filter(x=>['commit','merge','open','cleanup'].includes(x)),['commit','merge','open','cleanup'])
  await f.hub.execute(preview.token);assert.equal(f.calls.filter(x=>x==='commit').length,1)
})

test('主要工作樹、同一來源目標與跨repo在提交前拒絕',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.hub.preview({...f.action,workspaceId:f.target.id}),/主要|相同/)
  await assert.rejects(f.hub.preview({...f.action,targetWorkspaceId:f.source.id}),/相同/)
  f.workspaces.set(f.target.id,{...f.target,repoId:'other'})
  await assert.rejects(f.hub.preview(f.action),/儲存庫|repo/)
  assert.equal(f.calls.includes('commit'),false)
})

test('預設分支即使位於 linked worktree 也不可收尾或清理',async t=>{
  const f=await fixture(t)
  f.workspaces.set(f.source.id,{...f.source,isDefaultBranch:true})
  await assert.rejects(f.hub.preview(f.action),/預設分支/)
  await assert.rejects(f.hub.preview({kind:'cleanup',workspaceId:f.source.id,base:'main'}),/預設分支/)
  assert.equal(f.calls.includes('commit'),false);assert.equal(f.calls.includes('cleanup'),false)
})

test('來源或目標活動中時預覽拒絕，執行前再檢查',async t=>{
  const f=await fixture(t);f.faults.add('idle:main')
  await assert.rejects(f.hub.preview(f.action),/失敗/)
  f.faults.clear();const preview=await f.hub.preview(f.action);f.faults.add('idle:feature')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.equal(f.calls.includes('commit'),false)
})

test('提交失敗可能已寫入，保留現場而不嘗試合併清理',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('commit')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.match(result.message,/待核對|停止/)
  assert.equal(f.calls.includes('merge'),false);assert.equal(f.calls.includes('cleanup'),false)
})

test('提交成功但合併失敗，結果保留提交證據且不自動清理',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('merge')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.equal(result.steps?.[0].status,'done')
  assert.equal(result.steps?.[1].status,'failed');assert.equal(f.calls.includes('cleanup'),false)
  await f.hub.execute(preview.token);assert.equal(f.calls.filter(x=>x==='commit').length,1)
})

test('合併成功但清理失敗，顯示已合回待清理而不是全部失敗',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('cleanup')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.match(result.message,/已合回/)
  assert.equal(result.steps?.[1].status,'done');assert.equal(result.steps?.at(-1)?.status,'failed')
})

test('選擇保留工作樹時仍完成合併與切換，但不移除',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview({...f.action,remove:false})
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'completed');assert.equal(f.calls.includes('cleanup'),false)
  assert.equal(result.steps?.at(-1)?.status,'skipped')
})

test('清理前若工作樹又出現修改，保留工作樹並揭露部分完成',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('dirty-cleanup')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.equal(f.calls.includes('cleanup'),false)
  assert.match(result.message,/已合回/)
})
