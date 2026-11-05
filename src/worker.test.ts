import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('Worker 拒絕無效面板請求且不執行 CLI', async () => {
  const host=mockHost()
  const worker=await mountWorker(main,{host})
  await assert.rejects(worker.request('hub.preview', null as never), /有效/)
  await assert.rejects(worker.request('hub.execute', {token:'invalid'}), /預覽/)
  await assert.rejects(worker.request('hub.inspect', {} as never), /工作區/)
  await assert.rejects(worker.request('hub.pr', {workspaceId:'x',number:-1}), /PR/)
  assert.deepEqual(host.refusals,[])
  await worker.deactivate()
})
