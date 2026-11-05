import type { OrcaWorkerApi } from 'orca/worker'
import type { JsonValue } from 'orca/host'
import { Hub } from './hub'
import { record } from './actions'
import { run, cancelAll } from './services/process'
import './protocol'

export default function activate(orca: OrcaWorkerApi): void {
  const hub = new Hub(run, {
    get: key => orca.storage.get(key),
    set: (key,value) => orca.storage.set(key,value as JsonValue)
  }, id => orca.host.call('workspace.open', {workspaceId:id}))
  orca.panels.handle('hub.list', () => hub.list())
  orca.panels.handle('hub.dashboard', input => hub.dashboard(input))
  orca.panels.handle('hub.inspect', input => hub.inspect(record(input).workspaceId))
  orca.panels.handle('hub.preview', input => hub.preview(input))
  orca.panels.handle('hub.execute', input => hub.execute(record(input).token))
  orca.panels.handle('hub.open', input => hub.open(record(input).workspaceId))
  orca.panels.handle('hub.prs', input => hub.prs(record(input).workspaceId))
  orca.panels.handle('hub.pr', input => hub.pr(record(input).workspaceId,record(input).number))
  orca.panels.handle('hub.ai-result', input => hub.aiResult(record(input).workspaceId))
}
export function deactivate(): void { cancelAll() }
