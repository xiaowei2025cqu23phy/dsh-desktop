/**
 * QQ 机器人指令解析:纯函数,无 Electron/harness 依赖,可独立单测。
 */

export type QQCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'sessions' }
  | { kind: 'workspaces' }
  | { kind: 'models' }
  | { kind: 'model'; query: string }
  | { kind: 'cancel'; sessionId: string }
  | { kind: 'open'; sessionId: string }
  | { kind: 'progress'; sessionId: string }
  | { kind: 'run'; description: string }
  | { kind: 'retry'; taskId: string }
  | { kind: 'enter'; target: string }
  | { kind: 'exit' }
  | { kind: 'allow'; sessionId: string }
  | { kind: 'reject'; sessionId: string }
  | { kind: 'select'; text: string }
  | { kind: 'sched'; action: 'add'; delay: SchedDelay; description: string }
  | { kind: 'sched'; action: 'list' }
  | { kind: 'sched'; action: 'remove'; index: number }
  | { kind: 'ls'; path: string }
  | { kind: 'cat'; path: string }
  | { kind: 'export'; sessionId: string }
  | { kind: 'restore'; sessionId: string }
  | { kind: 'usage' }
  | { kind: 'character'; text: string }
  | { kind: 'broadcast'; sessionId: string; on: boolean }
  | { kind: 'newchat' }
  | { kind: 'unknown'; text: string }

/** 定时任务的调度表达(解析结果)。 */
export type SchedDelay =
  | { kind: 'once'; delayMs: number }
  | { kind: 'daily'; hours: number; minutes: number }

/**
 * 解析定时表达式:
 * - `10分钟` / `10m` / `2小时` / `1天` → 一次性延迟
 * - `每天9:00` → 每日循环
 */
export function parseSchedDelay(expr: string): SchedDelay | null {
  const text = expr.trim().toLowerCase()
  const once = /^(\d+)\s*(分钟|分|min|m|小时|时|h|天|d)$/.exec(text)
  if (once !== null) {
    const n = Number(once[1])
    const unit = once[2]
    const ms = unit === '分钟' || unit === '分' || unit === 'min' || unit === 'm'
      ? n * 60 * 1000
      : unit === '小时' || unit === '时' || unit === 'h'
        ? n * 60 * 60 * 1000
        : n * 24 * 60 * 60 * 1000
    if (ms > 0) return { kind: 'once', delayMs: ms }
    return null
  }
  const daily = /^每天\s*(\d{1,2}):(\d{2})$/.exec(text)
  if (daily !== null) {
    const hours = Number(daily[1])
    const minutes = Number(daily[2])
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { kind: 'daily', hours, minutes }
    }
  }
  return null
}

export function parseCommand(content: string): QQCommand {
  const lower = content.trim().toLowerCase()
  if (lower === '帮助' || lower === 'help' || lower === '/help' || lower === '?') {
    return { kind: 'help' }
  }
  if (lower === '状态' || lower === 'status') return { kind: 'status' }
  if (lower === '会话' || lower === 'sessions') return { kind: 'sessions' }
  if (lower === '工作区' || lower === 'workspaces') return { kind: 'workspaces' }
  if (lower === '用量' || lower === 'usage' || lower === '统计') return { kind: 'usage' }
  if (lower === '模型' || lower === 'models') return { kind: 'models' }
  if (lower === '退出' || lower === '结束' || lower === 'exit' || lower === '退出对话') {
    return { kind: 'exit' }
  }
  const parts = content.trim().split(/\s+/)
  // 新对话/新会话:强制重开纯对话(默认对话锁定时的「重开」入口)。
  if (parts[0] === '新对话' || parts[0] === '新会话' || parts[0] === 'new') {
    return { kind: 'newchat' }
  }
  // 角色扮演:角色 <设定> / 角色 无(清除)
  if (parts[0] === '角色' || parts[0] === '扮演' || parts[0] === 'character') {
    return { kind: 'character', text: content.trim().slice(parts[0].length).trim() }
  }
  if (parts[0] === '重试' || parts[0] === 'retry') {
    return { kind: 'retry', taskId: parts[1] ?? '' }
  }
  // 现场播报开关:播报 [会话id] / 静音 [会话id]
  if (parts[0] === '播报' || parts[0] === '开启播报' || parts[0] === '现场' || parts[0] === 'broadcast') {
    return { kind: 'broadcast', sessionId: parts[1] ?? '', on: true }
  }
  if (parts[0] === '静音' || parts[0] === '关闭播报' || parts[0] === 'mute') {
    return { kind: 'broadcast', sessionId: parts[1] ?? '', on: false }
  }
  if (parts[0] === '停止' || parts[0] === 'cancel') {
    return { kind: 'cancel', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '打开' || parts[0] === 'open') {
    return { kind: 'open', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '进展' || parts[0] === 'progress' || parts[0] === '进度') {
    return { kind: 'progress', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '进入' || parts[0] === 'enter' || parts[0] === '进入工作区') {
    return { kind: 'enter', target: content.trim().slice(parts[0].length).trim() }
  }
  if (parts[0] === '任务' || parts[0] === 'run' || parts[0] === '执行') {
    return { kind: 'run', description: content.trim().slice(parts[0].length).trim() }
  }
  // 模型切换:模型 <模型名/前缀>(需在对话/会话上下文中)
  if (parts[0] === '模型' || parts[0] === 'model' || parts[0] === '切换模型') {
    return { kind: 'model', query: content.trim().slice(parts[0].length).trim() }
  }
  // 定时任务:定时 <表达式> <描述> / 定时列表 / 取消定时 <编号>
  const schedText = content.trim()
  if (schedText === '定时列表' || schedText === '定时 列表' || schedText === 'schedule list') {
    return { kind: 'sched', action: 'list' }
  }
  if (parts[0] === '取消定时' || parts[0] === '删除定时') {
    const idx = Number(parts[1])
    if (Number.isInteger(idx) && idx >= 1) return { kind: 'sched', action: 'remove', index: idx - 1 }
    return { kind: 'unknown', text: content.trim() }
  }
  if (parts[0] === '定时' || parts[0] === 'schedule' || parts[0] === '定时任务') {
    const rest = content.trim().slice(parts[0].length).trim()
    if (rest === '' || rest === '列表' || rest === 'list') return { kind: 'sched', action: 'list' }
    const cancelMatch = /^(取消|删除|remove)\s+(\d+)$/.exec(rest)
    if (cancelMatch !== null) return { kind: 'sched', action: 'remove', index: Number(cancelMatch[2]) - 1 }
    const exprMatch = /^(\S+)\s+([\s\S]+)$/.exec(rest)
    if (exprMatch !== null) {
      const delay = parseSchedDelay(exprMatch[1])
      if (delay !== null) return { kind: 'sched', action: 'add', delay, description: exprMatch[2].trim() }
      return { kind: 'unknown', text: content.trim() }
    }
    return { kind: 'unknown', text: content.trim() }
  }
  if (parts[0] === '允许' || parts[0] === '同意' || parts[0] === '批准' || parts[0] === 'approve' || parts[0] === 'allow') {
    return { kind: 'allow', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '拒绝' || parts[0] === 'reject' || parts[0] === 'deny') {
    return { kind: 'reject', sessionId: parts[1] ?? '' }
  }
  if (parts[0] === '选' || parts[0] === '选择' || parts[0] === 'select') {
    return { kind: 'select', text: content.trim().slice(parts[0].length).trim() }
  }
  // 多问题批次指定题号:#2 选 1 → 保留题号给 cmdSelect 解析
  const numberedSelect = /^#(\d+)\s+(选|选择|select)\s*(.*)$/.exec(content.trim())
  if (numberedSelect !== null) {
    return { kind: 'select', text: `#${numberedSelect[1]} ${numberedSelect[3].trim()}`.trim() }
  }
  // 目录浏览:目录 <路径> / 文件 <路径>
  if (parts[0] === '目录' || parts[0] === 'ls' || parts[0] === '列目录') {
    return { kind: 'ls', path: content.trim().slice(parts[0].length).trim() }
  }
  if (parts[0] === '文件' || parts[0] === 'cat' || parts[0] === '查看文件') {
    return { kind: 'cat', path: content.trim().slice(parts[0].length).trim() }
  }
  // 会话导出:导出 <会话id>
  if (parts[0] === '导出' || parts[0] === 'export') {
    return { kind: 'export', sessionId: parts[1] ?? '' }
  }
  // 恢复归档会话:恢复 <会话id>(归档 = 仅隐藏,可随时恢复)
  if (parts[0] === '恢复' || parts[0] === 'restore' || parts[0] === '取消归档') {
    return { kind: 'restore', sessionId: parts[1] ?? '' }
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

/** 审批按钮 data 前缀(键盘按钮点击后随 INTERACTION_CREATE 回传)。 */
export const APPROVE_BUTTON_PREFIX = 'dsh-approve|'

/** 提问(选择题)按钮 data 前缀。 */
export const QUESTION_BUTTON_PREFIX = 'dsh-question|'

/** 任务操作按钮 data 前缀(停止/进展/打开)。 */
export const ACTION_BUTTON_PREFIX = 'dsh-action|'

/** 任务操作按钮点击的解析结果。 */
export interface ActionButtonData {
  action: 'stop' | 'progress' | 'open'
  sessionId: string
}

/**
 * 在 INTERACTION_CREATE 的 data 里递归查找任务操作按钮 data 并解析。
 * 格式:dsh-action|<stop|progress|open>|<sessionId>
 */
export function parseActionButtonData(data: unknown): ActionButtonData | null {
  if (typeof data === 'string') {
    if (!data.startsWith(ACTION_BUTTON_PREFIX)) return null
    const parts = data.split('|')
    if (parts.length !== 3 || parts[0] !== 'dsh-action') return null
    const action = parts[1]
    if (action !== 'stop' && action !== 'progress' && action !== 'open') return null
    return { action, sessionId: parts[2] }
  }
  if (data === null || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (record.resolved !== null && typeof record.resolved === 'object') {
    const resolved = record.resolved as Record<string, unknown>
    if (typeof resolved.button_data === 'string') {
      const parsed = parseActionButtonData(resolved.button_data)
      if (parsed !== null) return parsed
    }
  }
  for (const value of Object.values(record)) {
    const found = parseActionButtonData(value)
    if (found !== null) return found
  }
  return null
}

/** 提问键盘按钮点击的解析结果。 */
export interface QuestionButtonData {
  sessionId: string
  questionId: string
  optionIndex: number
}

/**
 * 在 INTERACTION_CREATE 的 data 里递归查找提问按钮 data 并解析。
 * 格式:dsh-question|<sessionId>|<questionId>|<optionIndex>
 */
export function parseQuestionButtonData(data: unknown): QuestionButtonData | null {
  if (typeof data === 'string') {
    if (!data.startsWith(QUESTION_BUTTON_PREFIX)) return null
    const parts = data.split('|')
    if (parts.length !== 4 || parts[0] !== 'dsh-question') return null
    const optionIndex = Number(parts[3])
    if (!Number.isInteger(optionIndex) || optionIndex < 0) return null
    return { sessionId: parts[1], questionId: parts[2], optionIndex }
  }
  if (data === null || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (record.resolved !== null && typeof record.resolved === 'object') {
    const resolved = record.resolved as Record<string, unknown>
    if (typeof resolved.button_data === 'string') {
      const parsed = parseQuestionButtonData(resolved.button_data)
      if (parsed !== null) return parsed
    }
  }
  for (const value of Object.values(record)) {
    const found = parseQuestionButtonData(value)
    if (found !== null) return found
  }
  return null
}

/** 审批键盘按钮点击的解析结果。 */
export interface ApprovalButtonData {
  sessionId: string
  approvalId: string
  decision: 'allowed-once' | 'rejected'
}

/**
 * 在 INTERACTION_CREATE 的 data 里递归查找审批按钮 data 并解析。
 * 常见路径为 data.resolved.button_data;未知结构返回 null。
 */
export function parseApprovalButtonData(data: unknown): ApprovalButtonData | null {
  if (typeof data === 'string') {
    if (!data.startsWith(APPROVE_BUTTON_PREFIX)) return null
    const parts = data.split('|')
    if (parts.length !== 4 || parts[0] !== 'dsh-approve') return null
    const decision = parts[3]
    if (decision !== 'allowed-once' && decision !== 'rejected') return null
    return { sessionId: parts[1], approvalId: parts[2], decision }
  }
  if (data === null || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (record.resolved !== null && typeof record.resolved === 'object') {
    const resolved = record.resolved as Record<string, unknown>
    if (typeof resolved.button_data === 'string') {
      const parsed = parseApprovalButtonData(resolved.button_data)
      if (parsed !== null) return parsed
    }
  }
  for (const value of Object.values(record)) {
    const found = parseApprovalButtonData(value)
    if (found !== null) return found
  }
  return null
}

/** 在 INTERACTION_CREATE 的 data 里递归查找点击者 openid(data.resolved.user_id)。 */
export function findEventUserId(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  if (record.resolved !== null && typeof record.resolved === 'object') {
    const userId = (record.resolved as Record<string, unknown>).user_id
    if (typeof userId === 'string') return userId
  }
  for (const value of Object.values(record)) {
    const found = findEventUserId(value)
    if (found !== '') return found
  }
  return ''
}

/** 在 INTERACTION_CREATE 的 data 里递归查找群 openid(group_openid;群按钮点击回发用)。 */
export function findEventGroupOpenid(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  if (typeof record.group_openid === 'string') return record.group_openid
  for (const value of Object.values(record)) {
    const found = findEventGroupOpenid(value)
    if (found !== '') return found
  }
  return ''
}
