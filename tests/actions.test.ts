import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAction } from '../src/actions'

test('拒絕任意命令、未知操作與無效資料', () => {
  for (const value of [null, [], {kind:'exec',command:'rm -rf'}, {kind:'push',workspaceId:9}, {kind:'push',workspaceId:'abc',cwd:'/tmp'}]) {
    assert.throws(() => parseAction(value))
  }
})
test('拒絕控制字元、空選取與非法 Agent', () => {
  for (const value of [
    {kind:'push',workspaceId:'a\0b'},
    {kind:'stage',workspaceId:'a',paths:[],fingerprint:'abc'},
    {kind:'ai-message',workspaceId:'a',agent:'sh'},
    {kind:'create',workspaceId:'a',name:'../oops',base:'main',agent:'',prompt:''}
  ]) assert.throws(() => parseAction(value))
})
test('合法提交訊息保留換行與 shell 符號，不當命令處理', () => {
  assert.deepEqual(parseAction({kind:'commit',workspaceId:'a',message:'fix: $HOME\n\n`literal`'}), {kind:'commit',workspaceId:'a',message:'fix: $HOME\n\n`literal`'})
})

test('收尾只接受明確目標、合併方式與布林選項，乾淨來源可不填提交訊息', () => {
  const action = {kind:'finish',workspaceId:'source',targetWorkspaceId:'target',message:'',remove:true,strategy:'merge',squash:false}
  assert.deepEqual(parseAction(action), action)
  assert.deepEqual(parseAction({...action,strategy:'rebase',squash:true}), {...action,strategy:'rebase',squash:true})
  for (const change of [{remove:'yes'}, {targetWorkspaceId:''}, {command:'git merge'}, {message:9},
    {strategy:'squash'}, {strategy:'merge --squash'}, {strategy:undefined}, {squash:'true'}, {squash:undefined}, {mode:'force'}]) {
    assert.throws(() => parseAction({...action,...change}))
  }
})

test('建立接受慣用分支路徑，拒絕路徑穿越與非法分支元件', () => {
  const action={kind:'create',workspaceId:'source',name:'feature/login',base:'main',agent:'',prompt:''}
  assert.deepEqual(parseAction(action),action)
  for (const name of ['feature/../main','feature//login','feature/.hidden','feature/a.lock','feature/a.','-bad']) {
    assert.throws(()=>parseAction({...action,name}))
  }
})

// A1：AI 說明只接受工作區 ID；不能指定 Agent、命令或其他參數。
test('AI 完成說明只接受工作區，拒絕 Agent、命令與額外欄位', () => {
  assert.deepEqual(parseAction({kind:'finish-summary',workspaceId:'a'}), {kind:'finish-summary',workspaceId:'a'})
  for (const value of [
    {kind:'finish-summary',workspaceId:'a',agent:'codex'},
    {kind:'finish-summary',workspaceId:'a',command:'claude --dangerously-skip-permissions'},
    {kind:'finish-summary',workspaceId:'a',targetWorkspaceId:'b'},
    {kind:'finish-summary'}
  ]) assert.throws(() => parseAction(value))
})
