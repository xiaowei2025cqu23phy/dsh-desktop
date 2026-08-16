/**
 * QQ 机器人指令解析:纯函数,无 Electron/harness 依赖,可独立单测。
 */

export type QQCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'sessions' }
  | { kind: 'workspaces' }
  | { kind: 'models' }
  | { kind: 'cancel'; sessionId: string }
  | { kind: 'open'; sessionId: string }
  | { kind: 'progress'; sessionId: string }
  | { kind: 'run'; description: string }
  | { kind: 'unknown'; text: string }

export function parseCommand(content: string): QQCommand {
  const lower = content.trim().toLowerCase()
  if (lower === '帮助' || lower === 'help' || lower === '/help' || lower === '?') {
    return { kind: 'help' }
  }
  if (lower === '状态' || lower === 'status') return { kind: 'status' }
  if (lower === '会话' || lower === 'sessions') return { kind: 'sessions' }
  if (lower === '工作区' || lower === 'workspaces') return { kind: 'workspaces' }
  if (lower === '模型' || lower === 'models') return { kind: 'models' }
  const parts = content.trim().split(/\s+/)
  if (parts[0] === '停止' || parts[0] === 'cancel') {
    return { kind: 'cancel', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '打开' || parts[0] === 'open') {
    return { kind: 'open', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '进展' || parts[0] === 'progress' || parts[0] === '进度') {
    return { kind: 'progress', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '任务' || parts[0] === 'run' || parts[0] === '执行') {
    return { kind: 'run', description: content.trim().slice(parts[0].length).trim() }
  }
  return { kind: 'unknown', text: content.trim() }
}

/** 解析任务描述中的可选参数:@工作区名 或 目录:<路径>。返回清理后的描述与参数。 */
export function parseTaskOptions(description: string): { description: string; cwd: string | null; workspaceName: string | null } {
  let text = description
  let cwd: string | null = null
  let workspaceName: string | null = null
  const dirMatch = /目录:(\S+)/.exec(text)
  if (dirMatch !== null) {
    cwd = dirMatch[1]
    text = text.replace(dirMatch[0], '').trim()
  }
  const wsMatch = /@(\S+)/.exec(text)
  if (wsMatch !== null) {
    workspaceName = wsMatch[1]
    text = text.replace(wsMatch[0], '').trim()
  }
  return { description: text, cwd, workspaceName }
}
