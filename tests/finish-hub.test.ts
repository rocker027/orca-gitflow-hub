import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
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
  const git={snapshot:async(path:string)=>structuredClone(snapshots.get(path)!),hasIgnoredFiles:async()=>false,
    cleanupCheck:async()=>({safe:!faults.has('dirty-cleanup'),reasons:['有變更']})} as unknown as GitService
  const orca={
    list:async()=>({workspaces:[...workspaces.values()],warnings:[]}),
    resolve:async(id:string)=>{const ws=workspaces.get(id);if(!ws)throw new Error('工作區已移除');return structuredClone(ws)},
    assertIdle:async(ws:Workspace)=>{hit(`idle:${ws.branch}`)},
    activity:async(ws:Workspace)=>{hit(`activity:${ws.branch}`);return {agentsBusy:faults.has(`agents:${ws.branch}`),terminalsOpen:faults.has(`terminals:${ws.branch}`)}},
    remove:async(ws:Workspace)=>{hit('cleanup');workspaces.delete(ws.id);await rm(ws.path,{recursive:true})}
  } as unknown as OrcaService
  const finish={
    prepare:async(_s:string,_t:string,_m:string,options:{strategy:'merge'|'rebase';squash:boolean})=>{hit('prepare');return {source:structuredClone(snapshots.get(source.path)),target:structuredClone(snapshots.get(target.path)),files:['a.txt'],ahead:2,behind:1,needsCommit:true,
      strategy:options.strategy,squash:options.squash,squashCount:options.squash?3:0,pushedCount:1,mergeMode:options.strategy==='rebase'?'rebase':'merge_commit'} as FinishPlan},
    commit:async()=>{hit('commit');if(faults.has('terminals-after-commit'))faults.add('terminals:feature');snapshots.set(source.path,{...snapshots.get(source.path)!,head:'c'.repeat(40),fingerprint:'committed',files:[]});return 'c'.repeat(40)},
    squash:async(_p:string,plan:FinishPlan,head:string)=>{if(!plan.squash)return head;hit('squash');snapshots.set(source.path,{...snapshots.get(source.path)!,head:'e'.repeat(40),fingerprint:'squashed'});return 'e'.repeat(40)},
    rebase:async(_p:string,plan:FinishPlan,head:string)=>{if(plan.strategy!=='rebase')return head;hit('rebase');snapshots.set(source.path,{...snapshots.get(source.path)!,head:'f'.repeat(40),fingerprint:'rebased'});return 'f'.repeat(40)},
    merge:async()=>{hit('merge');if(faults.has('merge-activates-source'))faults.add('terminals:feature');if(faults.has('merge-unknown'))throw new Error('合併結果待核對（UNKNOWN），可能已修改目標，請保留工作樹：post-merge hook');snapshots.set(target.path,{...snapshots.get(target.path)!,head:'d'.repeat(40),fingerprint:'merged'});return 'd'.repeat(40)}
  } as unknown as FinishGitService
  const hub=new Hub(async()=>root,{get:async key=>values.get(key),set:async(key,value)=>{values.set(key,structuredClone(value))}},async()=>{
    hit('open')
    if(faults.has('open-activates-target')) faults.add('idle:main')
    return {opened:true}
  }, {git,orca,github:{} as GitHubService,finish})
  const action={kind:'finish',workspaceId:source.id,targetWorkspaceId:target.id,message:'完成任務',remove:true,strategy:'merge',squash:false}
  return {hub,action,calls,faults,source,target,workspaces,snapshots}
}

test('切換目標會自動開啟終端時，先清理再切換仍能完成收尾',async t=>{
  const f=await fixture(t);f.faults.add('open-activates-target')
  const preview=await f.hub.preview(f.action)
  const outcome=await f.hub.execute(preview.token)
  assert.equal(outcome.status,'completed',JSON.stringify(outcome))
  assert.deepEqual(f.calls.filter(call=>['commit','merge','cleanup','open'].includes(call)),['commit','merge','cleanup','open'])
  assert.deepEqual(outcome.steps?.map(step=>step.id),['commit','merge','cleanup','open'])
  await assert.rejects(stat(f.source.path),{code:'ENOENT'})
})

test('清理完成後切換失敗，明示工作資料夾已移除並指向已合併的目標',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('open')
  const outcome=await f.hub.execute(preview.token)
  assert.equal(outcome.status,'needs_attention');assert.equal(outcome.workspaceId,f.target.id)
  assert.deepEqual(outcome.steps?.map(step=>[step.id,step.status]),[['commit','done'],['merge','done'],['cleanup','done'],['open','failed']])
  assert.match(outcome.message,/已合併到 main[\s\S]*工作資料夾已移除[\s\S]*切換到 main/)
  assert.doesNotMatch(outcome.message,/工作樹保留|還沒合併|重新合併/)
  await assert.rejects(stat(f.source.path),{code:'ENOENT'})
})

test('清理失敗時保留來源，尚未切換目標',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('cleanup')
  const outcome=await f.hub.execute(preview.token)
  assert.equal(outcome.status,'needs_attention');assert.equal(outcome.workspaceId,f.target.id)
  assert.equal(outcome.steps?.find(step=>step.id==='cleanup')?.status,'failed')
  assert.equal(outcome.steps?.find(step=>step.id==='open')?.status,'skipped')
  assert.equal(f.calls.includes('open'),false)
  assert.ok(f.workspaces.has(f.source.id));assert.ok((await stat(f.source.path)).isDirectory())
})

test('一次收尾預覽串接提交、合併、清理與切換，重送token不再寫入',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action)
  assert.equal(preview.steps?.length,4);assert.equal(f.calls.includes('commit'),false)
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'completed');assert.equal(result.workspaceId,f.target.id)
  assert.deepEqual(result.steps?.map(x=>x.status),['done','done','done','done'])
  assert.deepEqual(f.calls.filter(x=>['commit','merge','cleanup','open'].includes(x)),['commit','merge','cleanup','open'])
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

const previewError=(f:Awaited<ReturnType<typeof fixture>>,action:object)=>f.hub.preview(action as typeof f.action).then(()=>null,(caught:unknown)=>caught as Error)

test('Merge 且保留資料夾時，來源終端開著仍可收尾，目標仍須閒置',async t=>{
  const f=await fixture(t);const action={...f.action,remove:false};f.faults.add('terminals:feature')
  const outcome=await f.hub.execute((await f.hub.preview(action)).token)
  assert.equal(outcome.status,'completed',JSON.stringify(outcome))
  assert.ok(f.calls.includes('activity:feature'));assert.equal(f.calls.includes('idle:feature'),false);assert.equal(f.calls.includes('cleanup'),false)
  f.faults.add('idle:main')
  await assert.rejects(f.hub.preview(action),/idle:main/)
})

test('來源有 AI 助手執行中時一律拒絕，且不提示改選',async t=>{
  const f=await fixture(t);f.faults.add('agents:feature')
  for (const option of [{remove:false},{remove:true},{remove:false,strategy:'rebase'}]) {
    const error=await previewError(f,{...f.action,...option})
    assert.match(String(error?.message),/還有 AI 助手在執行/);assert.doesNotMatch(String(error?.message),/取消勾選|改選/)
  }
  assert.equal(f.calls.includes('commit'),false)
})

test('要移除資料夾時來源終端開著會拒絕，並提示可改為保留資料夾',async t=>{
  const f=await fixture(t);f.faults.add('terminals:feature')
  const error=await previewError(f,f.action)
  assert.match(String(error?.message),/還開著終端機/);assert.match(String(error?.message),/取消勾選「完成後移除資料夾」/)
})

test('選 Rebase 時來源終端開著會拒絕，即使保留資料夾，並提示改選 Merge',async t=>{
  const f=await fixture(t);f.faults.add('terminals:feature')
  for (const remove of [false,true]) {
    const error=await previewError(f,{...f.action,remove,strategy:'rebase'})
    assert.match(String(error?.message),/還開著終端機/);assert.match(String(error?.message),/改選 Merge 並保留資料夾/)
    assert.doesNotMatch(String(error?.message),/取消勾選/)
  }
})

test('預覽後才開啟來源終端，執行時在提交前擋下並保留提示',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('terminals:feature')
  const outcome=await f.hub.execute(preview.token)
  assert.equal(outcome.status,'needs_attention');assert.equal(f.calls.includes('commit'),false)
  assert.match(outcome.message,/還開著終端機/);assert.match(outcome.message,/取消勾選/)
})

test('保留資料夾時預覽後才有 AI 助手執行，執行時在提交前擋下',async t=>{
  const f=await fixture(t);const action={...f.action,remove:false};const preview=await f.hub.preview(action);f.faults.add('agents:feature')
  const outcome=await f.hub.execute(preview.token)
  assert.equal(outcome.status,'needs_attention');assert.equal(f.calls.includes('commit'),false)
  assert.match(outcome.message,/還有 AI 助手在執行/);assert.doesNotMatch(outcome.message,/取消勾選|改選/)
})

test('提交後才開啟來源終端，合併前擋下且不再提示改選',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('terminals-after-commit')
  const outcome=await f.hub.execute(preview.token)
  assert.equal(outcome.status,'needs_attention');assert.equal(f.calls.includes('merge'),false)
  assert.match(outcome.message,/還開著終端機/);assert.doesNotMatch(outcome.message,/取消勾選|改選/)
})

test('合併後清理時來源終端被開啟，停止清理且不再提示改選',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('merge-activates-source')
  const outcome=await f.hub.execute(preview.token)
  assert.equal(outcome.status,'needs_attention')
  assert.equal(outcome.steps?.find(step=>step.id==='cleanup')?.status,'failed')
  assert.equal(f.calls.includes('cleanup'),false)
  assert.match(outcome.message,/還開著終端機/);assert.doesNotMatch(outcome.message,/取消勾選|改選/)
})

test('來源或目標活動中時預覽拒絕，執行前再檢查',async t=>{
  const f=await fixture(t);f.faults.add('idle:main')
  await assert.rejects(f.hub.preview(f.action),/失敗/)
  f.faults.clear();const preview=await f.hub.preview(f.action);f.faults.add('terminals:feature')
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
  assert.equal(result.status,'needs_attention');assert.match(result.message,/已合併到 main/)
  assert.equal(result.steps?.[1].status,'done');assert.equal(result.steps?.find(step=>step.id==='cleanup')?.status,'failed')
})

test('選擇保留工作樹時仍完成合併與切換，但不移除',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview({...f.action,remove:false})
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'completed');assert.equal(f.calls.includes('cleanup'),false)
  assert.equal(result.steps?.find(step=>step.id==='cleanup')?.status,'skipped')
  assert.equal(result.steps?.at(-1)?.id,'open');assert.equal(result.steps?.at(-1)?.status,'done')
})

test('清理前若工作樹又出現修改，保留工作樹並揭露部分完成',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action);f.faults.add('dirty-cleanup')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.equal(f.calls.includes('cleanup'),false)
  assert.match(result.message,/已合併到 main/)
})

test('選 rebase 加合成一個時，依序合成、搬移、合併，結果頁列出六個步驟',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview({...f.action,strategy:'rebase',squash:true})
  assert.equal(preview.steps?.length,6);assert.match(preview.steps?.[1]??'',/3 個提交合成 1 個/);assert.match(preview.steps?.[2]??'',/rebase/)
  assert.match(preview.summary,/main 會接上這個工作的 1 個提交/)
  assert.ok(preview.warnings?.some(w=>w.title==='提交編號會改變'));assert.ok(preview.warnings?.some(w=>/GitHub/.test(w.title)&&/之前上傳過/.test(w.text)))
  assert.match(preview.detail,/force push/)
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'completed');assert.match(result.message,/已合併到這台電腦的 main[\s\S]*還沒上傳到 GitHub/)
  assert.deepEqual(result.steps?.map(x=>x.id),['commit','squash','rebase','merge','cleanup','open'])
  assert.deepEqual(result.steps?.map(x=>x.status),['done','done','done','done','done','done'])
  assert.deepEqual(f.calls.filter(x=>['commit','squash','rebase','merge','cleanup','open'].includes(x)),['commit','squash','rebase','merge','cleanup','open'])
})

test('一般合併不列出合成與搬移步驟，也不提出改寫警告',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview(f.action)
  assert.deepEqual(preview.warnings,[]);assert.match(preview.summary,/1 個合併提交/)
  const result=await f.hub.execute(preview.token)
  assert.deepEqual(result.steps?.map(x=>x.id),['commit','merge','cleanup','open'])
  assert.equal(f.calls.includes('squash'),false);assert.equal(f.calls.includes('rebase'),false)
})

test('rebase 失敗時標記該步驟，合併與清理維持尚未執行，結果指回來源工作',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview({...f.action,strategy:'rebase'});f.faults.add('rebase')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.equal(result.workspaceId,f.source.id)
  assert.deepEqual(result.steps?.map(x=>[x.id,x.status]),[['commit','done'],['rebase','failed'],['merge','skipped'],['cleanup','skipped'],['open','skipped']])
  assert.equal(result.steps?.[2].detail,'尚未執行');assert.equal(f.calls.includes('merge'),false)
})

test('合成後合併失敗時說明提交已整理但尚未合併',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview({...f.action,squash:true});f.faults.add('merge')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention');assert.match(result.message,/提交已整理，還沒合併到 main/)
  assert.deepEqual(result.steps?.map(x=>[x.id,x.status]),[['commit','done'],['squash','done'],['merge','failed'],['cleanup','skipped'],['open','skipped']])
})

test('舊面板送出缺少合併方式的收尾操作時拒絕',async t=>{
  const f=await fixture(t);const {strategy:_strategy,...legacy}=f.action
  await assert.rejects(f.hub.preview(legacy),/合併方式/);assert.equal(f.calls.includes('prepare'),false)
})

test('合併前就停止時說明目標沒被改動、改動沒有遺失；合併步驟失敗時不做這個保證',async t=>{
  const early=await fixture(t);const preview=await early.hub.preview({...early.action,strategy:'rebase'});early.faults.add('rebase')
  const stopped=await early.hub.execute(preview.token)
  assert.match(stopped.message,/^收尾已停止。main 沒有被改動。你的改動都還在，沒有遺失。/)
  const late=await fixture(t);const second=await late.hub.preview(late.action);late.faults.add('merge')
  const failed=await late.hub.execute(second.token)
  assert.match(failed.message,/^還沒合併到 main。/);assert.doesNotMatch(failed.message,/沒有被改動/)
})

test('合成搭配一般合併且目標已前進時，確認頁提醒 main 會多出 2 個提交',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview({...f.action,squash:true})
  assert.ok(preview.warnings?.some(w=>w.title==='main 會多出 2 個提交（不是錯誤）'&&w.tone==='accent'&&w.fix==='rebase'&&/改用「接到最後面」/.test(w.text)))
})

test('合併步驟結果 UNKNOWN 時不宣稱還沒合併，也不說目標沒被改動',async t=>{
  const f=await fixture(t);const preview=await f.hub.preview({...f.action,squash:true});f.faults.add('merge-unknown')
  const result=await f.hub.execute(preview.token)
  assert.equal(result.status,'needs_attention')
  assert.match(result.message,/^這個工作的提交已整理，合併到 main 的結果待核對。合併結果待核對（UNKNOWN）/)
  assert.doesNotMatch(result.message,/還沒合併|沒有被改動|沒有遺失/)
  assert.equal(f.calls.includes('cleanup'),false)
})
