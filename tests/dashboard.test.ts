import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hub } from '../src/hub'
import type { Workspace } from '../src/contracts'
import type { OverviewService } from '../src/services/overview'
import type { GitService } from '../src/services/git'
import type { GitHubService } from '../src/services/github'
import type { OrcaService } from '../src/services/orca'

function fixture() {
  const ws=(repo:string,branch:string,main=false):Workspace=>({id:`${repo}::/${repo}/${branch}`,repoId:repo,repoName:repo,path:`/${repo}/${branch}`,branch,head:'a'.repeat(40),displayName:branch,hostId:'local',isMainWorktree:main})
  const workspaces=[ws('first','main',true),ws('active','main',true),{...ws('active','feature'),isActive:true}]
  const calls:string[]=[]
  const overview={summary:async(workspace:Workspace)=>{calls.push(workspace.id);return {workspaceId:workspace.id,branch:workspace.branch,head:workspace.head,changedFiles:0,ahead:0,behind:0,lastMessage:'commit'}}} as unknown as OverviewService
  const orca={list:async()=>({workspaces,warnings:[]})} as unknown as OrcaService
  const hub=new Hub(async()=>{throw new Error('不得呼叫其他CLI')},{get:async()=>undefined,set:async()=>undefined},async()=>({opened:true}),{git:{} as GitService,github:{} as GitHubService,orca,overview})
  return {hub,workspaces,calls}
}

test('清單預設目前專案，只查此專案摘要而非所有工作樹Diff',async()=>{
  const f=fixture();const result=await f.hub.dashboard({})
  assert.equal(result.repoId,'active');assert.equal(result.activeWorkspaceId,f.workspaces[2].id)
  assert.equal(result.defaultTargetId,f.workspaces[1].id)
  assert.equal(result.workspaces.length,3);assert.deepEqual(f.calls,f.workspaces.slice(1).map(ws=>ws.id))
})
test('指定專案與未知專案有明確結果，不回退到其他專案操作',async()=>{
  const f=fixture();const result=await f.hub.dashboard({repoId:'first'})
  assert.equal(result.repoId,'first');assert.deepEqual(f.calls,[f.workspaces[0].id])
  await assert.rejects(f.hub.dashboard({repoId:'missing'}),/專案/)
  await assert.rejects(f.hub.dashboard({repoId:'active',cwd:'/etc'}),/篩選/)
})
test('空工作區清單保留空態，不猜測本機路徑',async()=>{
  const f=fixture();f.workspaces.length=0
  const result=await f.hub.dashboard({})
  assert.equal(result.repoId,'');assert.equal(result.summaries.length,0);assert.equal(f.calls.length,0)
})
