import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Operations, previewLifetimeMs, type Storage } from '../src/operations'
import type { Workspace } from '../src/contracts'
const workspace: Workspace = {id:'a',repoId:'r',path:'/tmp',branch:'feature/a',head:'a',displayName:'a',hostId:'local',isMainWorktree:false}
function setup() {
  const values = new Map<string, unknown>()
  const storage: Storage = {get:async key => values.get(key),set:async (key,value) => {values.set(key,structuredClone(value))}}
  const operations = new Operations(storage, async () => '')
  return {values,operations}
}
test('預覽之後才執行，重送成功 token 不重複寫入', async () => {
  const {operations} = setup(); let calls=0
  const token=await operations.prepare({workspace,action:{kind:'push',workspaceId:'a'},fingerprint:'f'})
  assert.equal(calls,0)
  const perform=async()=>{calls++;return {message:'ok'}}
  await operations.execute(token,perform);await operations.execute(token,perform)
  assert.equal(calls,1)
})
test('重啟後 running/failed token 不重做，過期預覽拒絕',async()=>{
  const {values,operations}=setup()
  const token=await operations.prepare({workspace,action:{kind:'push',workspaceId:'a'},fingerprint:'f'})
  const initial=values.get(`operation.${token}`) as object
  for(const state of ['running','failed']){
    values.set(`operation.${token}`,{...initial,state})
    await assert.rejects(operations.execute(token,async()=>({message:'wrong'})),/未知/)
  }
  values.set(`operation.${token}`,{...initial,createdAt:Date.now()-previewLifetimeMs-1})
  await assert.rejects(operations.execute(token,async()=>({message:'wrong'})),/過期/)
})
test('並行 execute 同token只執行一次，錯誤不當成功',async()=>{
  const {operations}=setup()
  const token=await operations.prepare({workspace,action:{kind:'push',workspaceId:'a'},fingerprint:'f'})
  let release!:()=>void
  const first=operations.execute(token,async()=>{await new Promise<void>(r=>release=r);throw new Error('失敗')})
  await new Promise(r=>setImmediate(r))
  await assert.rejects(operations.execute(token,async()=>({message:'wrong'})),/正在執行/)
  release();await assert.rejects(first,/失敗/)
  await assert.rejects(operations.execute(token,async()=>({message:'wrong'})),/未知/)
})

test('同一 Git common dir 不允許兩個 Hub 並行寫入',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises')
  const {tmpdir}=await import('node:os')
  const {join}=await import('node:path')
  const common=await mkdtemp(join(tmpdir(),'gitflow-lock-'))
  t.after(()=>rm(common,{recursive:true,force:true}))
  const storage:Storage={get:async()=>undefined,set:async()=>undefined}
  const first=new Operations(storage,async()=>common)
  const second=new Operations(storage,async()=>common)
  let release!:()=>void
  let entered!:()=>void
  const ready=new Promise<void>(r=>entered=r)
  const running=first.withLock(workspace,async()=>{entered();await new Promise<void>(r=>release=r)})
  await ready
  await assert.rejects(second.withLock(workspace,async()=>{}),/未完成/)
  release();await running
  await second.withLock(workspace,async()=>{})
})
