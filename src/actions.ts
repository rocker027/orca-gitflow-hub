import type { HubAction } from './protocol'

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('請提供有效的操作資料。')
  return value as Record<string, unknown>
}
export function textField(value: unknown, label: string, max = 500, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}格式不正確。`)
  }
  return value
}
export function workspaceId(value: unknown): string { return textField(value, '工作區', 4096) }
function agentId(value: unknown, empty = false): string {
  if (typeof value !== 'string' || !['codex', 'claude', 'omp', ...(empty ? [''] : [])].includes(value)) throw new Error('請選擇支援的 Agent。')
  return value
}
function ref(value: unknown): string {
  const name = textField(value, '分支', 180)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(name) || name.includes('..') || name.includes('//')) throw new Error('分支格式不正確。')
  return name
}
function fields(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(key => !['kind', 'workspaceId', ...allowed].includes(key))) throw new Error('操作包含不支援的欄位。')
}
export function parseAction(value: unknown): HubAction {
  const input = record(value)
  const id = workspaceId(input.workspaceId)
  switch (input.kind) {
    case 'create': {
      fields(input, ['name', 'base', 'agent', 'prompt'])
      const name = textField(input.name, '工作區名稱', 100)
      if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(name) || name.includes('..') ||
        name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('新分支名稱格式不正確。')
      return { kind: 'create', workspaceId: id, name, base: ref(input.base), agent: agentId(input.agent, true), prompt: textField(input.prompt, '提示詞', 12000, true) }
    }
    case 'stage': {
      fields(input, ['paths', 'fingerprint'])
      if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 500) throw new Error('請選擇 1 至 500 個檔案。')
      const paths = input.paths.map(path => textField(path, '檔案路徑', 4096))
      return { kind: 'stage', workspaceId: id, paths: [...new Set(paths)], fingerprint: textField(input.fingerprint, '版本', 128) }
    }
    case 'commit':
      fields(input, ['message'])
      return { kind: 'commit', workspaceId: id, message: textField(input.message, '提交訊息', 8000) }
    case 'draft':
      fields(input, ['targetBranch', 'title', 'description'])
      return { kind: 'draft', workspaceId: id, targetBranch: ref(input.targetBranch), title: textField(input.title, 'PR 標題', 240), description: textField(input.description, 'PR 描述', 20000, true) }
    case 'cleanup':
      fields(input, ['base'])
      return { kind: 'cleanup', workspaceId: id, base: ref(input.base) }
    case 'ai-message':
      fields(input, ['agent'])
      return { kind: 'ai-message', workspaceId: id, agent: agentId(input.agent) }
    case 'push':
      fields(input, [])
      return { kind: 'push', workspaceId: id }
    case 'finish':
      fields(input, ['targetWorkspaceId', 'message', 'remove'])
      if (typeof input.remove !== 'boolean') throw new Error('請明確選擇是否清理工作樹。')
      return { kind: 'finish', workspaceId: id, targetWorkspaceId: workspaceId(input.targetWorkspaceId),
        message: textField(input.message, '提交訊息', 8000, true), remove: input.remove }
    default: throw new Error('不支援這個操作。')
  }
}
