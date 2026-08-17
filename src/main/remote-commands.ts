/**
 * 统一远程命令处理器:QQ / Telegram / Webhook 等通道共享的命令执行核心。
 *
 * - handleText(channel, userId, text):入口,负责指令分发与对话模式。
 * - 对话模式:进入工作区后,非指令消息自动发往该工作区会话,「退出」结束;
 *   上下文按 `${channel}:${userId}` 隔离。
 * - handleInteractionFrame(frame):审批/提问等交互帧的处理(应答走 /api/respond)。
 *   审批「允许/拒绝」、选择题「选 N」;待办在下次消息回复末尾附带提示,
 *   Telegram 等支持主动推送的通道会即时推送(经 setPush 注入)。
 * - 未识别指令:回复完整指令集(含可直接复制的示例)。
 */

import type { HarnessManager } from './harness'
import type { ServerRequest } from './client'
import type { ConfigStore } from './config'
import { parseCommand, parseTaskOptions, type QQCommand } from './qq-commands'

/** 单条回复长度上限(超长由通道分段)。 */
export const MAX_REPLY_LENGTH = 1500

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 对话模式上下文。 */
interface ChatContext {
  sessionId: string
  label: string
}

/** 会话归属:哪个通道的哪个用户发起了该会话(用于审批/提问的定向通知)。 */
interface SessionOwner {
  channel: string
  userId: string
  /** 主动推送目标(群消息=群,私聊=用户);缺失时按 userId 回退。 */
  pushTarget?: { scope: string; targetId: string }
  /** 会话类型:task=任务(完成/失败汇报),chat=对话(不推送回合结束汇报)。 */
  kind: 'task' | 'chat'
}

/** 待审批项。 */
interface PendingApproval {
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  reason?: string
}

/** 待回答的提问批次(选择题)。 */
interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: AskUserQuestionItem[]
  answers: Map<string, { selected: string[]; custom?: string }>
}

/** 提问条目的 wire 结构(与 harness dsh-user-questions 对齐)。 */
export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** 流式输出回调(QQ 私聊对话的打字机效果;回合文本增量实时下发)。 */
export interface ChatStreamSink {
  onDelta(channel: string, userId: string, delta: string, target?: { scope: string; targetId: string }): void
  onEnd(channel: string, userId: string, target?: { scope: string; targetId: string }): void
}

/** 主动推送函数(由宿主注入;失败时靠回复附加提示兜底)。 */export type PushFn = (
  channel: string,
  userId: string,
  text: string,
  meta?: {
    kind: 'approval'
    sessionId: string
    approvalId: string
  } | {
    kind: 'question'
    sessionId: string
    /** 单选单问题批次:可渲染选项按钮的问题。 */
    question: { id: string; question: string; options: string[] }
  },
  /** 推送目标(群=群 id;私聊=用户 openid);缺失时通道按 userId 回退。 */
  target?: { scope: string; targetId: string },
) => void

export class RemoteCommandProcessor {
  private chatContexts = new Map<string, ChatContext>()
  private sessionOwners = new Map<string, SessionOwner>()
  private pendingApprovals = new Map<string, PendingApproval>()
  private pendingQuestions = new Map<string, PendingQuestion>()
  private push: PushFn | null = null
  /** 开启「默认对话模式」的通道:非指令消息自动进入纯对话(无需先发「进入」)。 */
  private autoChatChannels = new Set<string>()
  /** 开启「主动汇报」的通道:机器人发起的任务完成/失败时主动推送。 */
  private reportChannels = new Set<string>()
  /** 会话最近一次汇报时间(去重:同一会话的完成/失败在窗口内只报一次)。 */
  private lastTurnReports = new Map<string, { done: number; fail: number }>()
  /** 对话会话等待回复推送:发送消息后注册,回合结束把 agent 回复推给发起者。 */
  private chatReplies = new Map<string, { channel: string; userId: string; pushTarget?: { scope: string; targetId: string }; ts: number }>()
  /** 流式输出通道(QQ 私聊打字机效果);缺失时回合计束后整段推送。 */
  private chatStream: ChatStreamSink | null = null
  /** 非流式通道的回合文本缓冲(整段推送用)。 */
  private chatReplyBuffer = new Map<string, string>()

  /** 注入流式输出实现(仅支持主动流式的通道,如 QQ 私聊)。 */
  setChatStream(sink: ChatStreamSink): void {
    this.chatStream = sink
  }

  constructor(private harness: HarnessManager, private config?: ConfigStore) {
    // 恢复持久化的对话会话(重启后继续同一对话)。
    if (config !== undefined) {
      for (const [key, entry] of Object.entries(config.get().chatSessions ?? {})) {
        this.chatContexts.set(key, { sessionId: entry.sessionId, label: entry.label })
      }
    }
  }

  /** 注入主动推送实现(QQ / Telegram 等支持主动消息的通道)。 */
  setPush(push: PushFn): void {
    this.push = push
  }

  /** 对话会话持久化:创建/退出对话时同步到配置,重启后恢复同一会话。 */
  private persistChat(key: string): void {
    if (this.config === undefined) return
    const ctx = this.chatContexts.get(key)
    if (ctx === undefined) {
      const next = { ...this.config.get().chatSessions }
      delete next[key]
      this.config.update('chatSessions', next)
      return
    }
    this.config.update('chatSessions', { ...this.config.get().chatSessions, [key]: { sessionId: ctx.sessionId, label: ctx.label } })
  }

  /** 注入模式提示词:工作=助手,对话=朋友(桌面端可自定义;空则不注入)。 */
  private withModePrompt(mode: 'task' | 'chat', text: string): string {
    const prompt = this.config?.get().bot[mode === 'task' ? 'taskPrompt' : 'chatPrompt']?.trim() ?? ''
    if (prompt === '') return text
    return `[模式设定]\n${prompt}\n\n[消息]\n${text}`
  }

  /** 开关某通道的默认对话模式。 */
  setAutoChat(channel: string, enabled: boolean): void {
    if (enabled) this.autoChatChannels.add(channel)
    else this.autoChatChannels.delete(channel)
  }

  /** 开关某通道的主动汇报(任务完成/失败时推送)。 */
  setReport(channel: string, enabled: boolean): void {
    if (enabled) this.reportChannels.add(channel)
    else this.reportChannels.delete(channel)
  }

  /**
   * 应答审批(供机器人通道按钮/指令直接调用)。
   * 校验发起者身份与(可选的)审批 id;返回给用户的应答结果文本。
   */
  async respondApproval(
    channel: string,
    userId: string,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<string> {
    const pending = this.findPendingApproval({ channel, userId }, sessionId, approvalId)
    if (pending === null) {
      return '该审批已处理或已过期。'
    }
    const client = this.harness.client()
    try {
      const receipt = await client.respond(pending.rpcId, {
        ok: true,
        value: {
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          outcome,
        },
      })
      if (!receipt.accepted) {
        return `应答未被接受:${receipt.reason ?? '未知原因'}(可能已超时处理)`
      }
      this.pendingApprovals.delete(`${pending.sessionId}:${pending.approvalId}`)
      return outcome === 'allowed-once'
        ? `✓ 已允许:${pending.toolName}${pending.reason !== undefined ? `(${pending.reason.slice(0, 60)})` : ''}`
        : `✗ 已拒绝:${pending.toolName}`
    } catch (error) {
      return `应答失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 统一入口:处理一条来自某通道用户的文本消息,返回回复文本。 */
  async handleText(
    channel: string,
    userId: string,
    text: string,
    /** 推送目标(群消息=群;私聊可不传,按 userId 回退)。 */
    pushTarget?: { scope: string; targetId: string },
  ): Promise<string> {
    const content = text.trim()
    const key = `${channel}:${userId}`
    let reply: string
    if (content === '') {
      reply = ''
    } else {
      const command = parseCommand(content)
      if (command.kind === 'unknown') {
        const ctx = this.chatContexts.get(key)
        if (ctx !== undefined) {
          reply = await this.cmdChatMessage(key, content, pushTarget)
        } else if (this.autoChatChannels.has(channel)) {
          // 默认对话模式:非指令消息自动进入纯对话并发送。
          const entered = await this.cmdEnter(key, '', pushTarget)
          const autoCtx = this.chatContexts.get(key)
          reply = autoCtx !== undefined
            ? `${entered}\n\n${await this.cmdChatMessage(key, content, pushTarget)}`
            : entered
        } else {
          reply = this.fullHelp()
        }
      } else {
        reply = await this.executeCommand(command, key, pushTarget)
      }
    }
    const suffix = this.pendingSuffix(channel, userId)
    if (suffix === '') return reply
    return reply === '' ? suffix : `${reply}\n\n${suffix}`
  }

  /** 完整指令集(未知指令时也回复这份),每条指令带可直接复制的示例。 */
  fullHelp(): string {
    return [
      'DSH Remote 机器人指令集',
      '━━━━━━━━━━━━━━━━',
      '',
      '📋 查询类',
      '状态 — 电脑与任务总览',
      '  例:状态',
      '会话 — 最近 5 个会话',
      '  例:会话',
      '工作区 — 工作区列表',
      '  例:工作区',
      '模型 — 可用模型列表',
      '  例:模型',
      '模型 <名称> — 切换当前对话的模型',
      '  例:模型 deepseek-v4',
      '',
      '🚀 任务类(一次性任务)',
      '任务 <描述> — 默认工作区执行',
      '  例:任务 分析这个仓库的架构',
      '  例:任务 写一个 README 并提交',
      '任务 @<工作区名> <描述> — 指定工作区',
      '  例:任务 @qqbot 修复登录 bug',
      '任务 目录:<路径> <描述> — 指定目录',
      '  例:任务 目录:D:/work/proj 编译并运行测试',
      '',
      '💬 对话模式(连续对话)',
      '进入 — 纯对话(不绑定工作区/目录,一般不动文件)',
      '  例:进入',
      '进入 <工作区名/目录> — 在该工作区对话',
      '  例:进入 qqbot',
      '  例:进入 D:/work/proj',
      '进入后直接发消息即可,无需任何确认;agent 回复会自动推给你:',
      '  例:帮我看看项目里有哪些 TODO',
      '退出 — 结束对话模式',
      '  例:退出',
      '',
      '🔘 按钮操作(任务启动后自动附带,点一下即可)',
      '⏹ 停止 — 停止任务',
      '📋 进展 — 查看任务实时进展',
      '📖 打开 — 查看会话内容',
      '审批/提问推送也带按钮:✅ 允许 / ❌ 拒绝 / 选项按钮,点一下即应答',
      '',
      '📌 会话管理',
      '进展 <会话id> — 任务实时进展',
      '  例:进展 session-xxxxxxxx',
      '停止 <会话id> — 停止任务',
      '  例:停止 session-xxxxxxxx',
      '打开 <会话id> — 查看会话内容',
      '  例:打开 session-xxxxxxxx',
      '',
      '✅ 审批与提问(agent 需要你决定时)',
      '允许 — 允许当前待审批操作',
      '  例:允许(多个待审批时:允许 <会话id>)',
      '拒绝 — 拒绝当前待审批操作',
      '  例:拒绝',
      '选 <编号> — 回答选择题(多选:选 1 3)',
      '  例:选 2',
      '  例:选 1 3',
      '  例:选 自定义:先备份再删除',
      '多问题批次:#<题号> 选 <编号>',
      '  例:#2 选 1',
      '',
      '💡 模式提示词:任务=专业助手,对话=朋友(桌面端可自定义,留空不注入)',
      '💡 典型流程:先「工作区」看列表 → 「进入 qqbot」→ 连续对话 → 「退出」',
    ].join('\n')
  }

  private async executeCommand(
    command: QQCommand,
    key: string,
    pushTarget?: { scope: string; targetId: string },
  ): Promise<string> {
    switch (command.kind) {
      case 'help':
        return this.fullHelp()
      case 'status':
        return this.cmdStatus()
      case 'sessions':
        return this.cmdSessions()
      case 'workspaces':
        return this.cmdWorkspaces()
      case 'models':
        return this.cmdModels()
      case 'model':
        return this.cmdModelSwitch(key, command.query)
      case 'cancel':
        return this.cmdCancel(command.sessionId)
      case 'open':
        return this.cmdOpen(command.sessionId)
      case 'progress':
        return this.cmdProgress(command.sessionId)
      case 'run':
        return this.cmdRun(key, command.description, pushTarget)
      case 'enter':
        return this.cmdEnter(key, command.target, pushTarget)
      case 'exit':
        return this.cmdExit(key)
      case 'allow':
        return this.cmdAllow(key, command.sessionId, 'allowed-once')
      case 'reject':
        return this.cmdAllow(key, command.sessionId, 'rejected')
      case 'select':
        return this.cmdSelect(key, command.text)
      default:
        return this.fullHelp()
    }
  }

  private async cmdStatus(): Promise<string> {
    const client = this.harness.client()
    try {
      const host = await client.rpc<{ version?: string; cwd?: string; attachedSessions?: number }>('host.describe')
      const list = await client.rpc<{ items: Array<{ running?: boolean; blank?: boolean; title?: string | null; sessionId: string }> }>('session.list', {}, 20000)
      const total = (list.items ?? []).length
      const running = (list.items ?? []).filter((s) => s.running === true)
      const lines = [
        `harness: v${host.version ?? '?'}`,
        `工作目录: ${host.cwd ?? '?'}`,
        `会话: ${total} 个,运行中 ${running.length} 个`,
      ]
      if (running.length > 0) {
        lines.push('运行中:')
        for (const item of running.slice(0, 5)) {
          lines.push(`  ▶ ${(item.title ?? item.sessionId).slice(0, 30)}\n    ${item.sessionId}`)
        }
      }
      return lines.join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdSessions(key?: string): Promise<string> {
    const client = this.harness.client()
    try {
      // 对话模式中:「会话」列出当前工作区的会话供选择(返回工作区一级)。
      if (key !== undefined) {
        const ctx = this.chatContexts.get(key)
        if (ctx !== undefined && !ctx.label.startsWith('(纯对话')) {
          const ws = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string; sessions?: Array<{ sessionId: string; title?: string | null; blank?: boolean }> }> }>('workspace.list', {}, 20000)
          const found = (ws.items ?? []).find((w) => w.title === ctx.label || w.path === ctx.label || w.workspaceId === ctx.label)
          if (found !== undefined) {
            const sessions = (found.sessions ?? []).filter((s) => !s.blank)
            if (sessions.length === 0) return '该工作区暂无会话,发「进入 ' + ctx.label + ' 新」新建。'
            const lines = [`工作区「${ctx.label}」的会话(当前在 ${sessions.findIndex((s) => s.sessionId === ctx.sessionId) + 1 || 1} 号):`]
            sessions.slice(0, 8).forEach((s, i) => {
              lines.push(`  ${i + 1}. ${(s.title ?? s.sessionId).slice(0, 40)}${s.sessionId === ctx.sessionId ? ' ← 当前' : ''}`)
            })
            lines.push(`回复「进入 ${ctx.label} <编号>」切换会话`)
            return lines.join('\n')
          }
        }
      }
      const [list, ws] = await Promise.all([
        client.rpc<{ items: Array<{ sessionId: string; title?: string | null; running?: boolean; blank?: boolean }> }>('session.list', {}, 20000),
        client.rpc<{ archivedSessionIds?: string[] }>('workspace.list', {}, 20000),
      ])
      const archived = new Set(ws.archivedSessionIds ?? [])
      // 隐藏:未发生的空会话(blank)与已归档会话。
      const items = (list.items ?? [])
        .filter((s) => !s.blank && !archived.has(s.sessionId))
        .slice(0, 5)
      if (items.length === 0) return '暂无会话'
      return items.map((s) =>
        `${s.running ? '▶' : ' '} ${(s.title ?? s.sessionId).slice(0, 30)}\n  ${s.sessionId}`,
      ).join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdWorkspaces(): Promise<string> {
    const client = this.harness.client()
    try {
      const data = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string; sessionIds?: string[] }> }>('workspace.list')
      const items = data.items ?? []
      if (items.length === 0) return '暂无工作区'
      return items.slice(0, 8).map((w) =>
        `${w.title ?? w.path}\n  ${w.path ?? ''} (${(w.sessionIds ?? []).length} 会话)`,
      ).join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 切换模型:在当前对话/最近会话上执行 session.selectModel。
   * 例:模型 deepseek-v4 / 模型 gpt-5.6
   */
  private async cmdModelSwitch(key: string, query: string): Promise<string> {
    if (query === '') return '用法:模型 <模型名/前缀>(如:模型 deepseek-v4)'
    const ctx = this.chatContexts.get(key)
    if (ctx === undefined) return '当前不在对话模式,先发「进入」再切换模型(或直接发「模型」查看列表)'
    const client = this.harness.client()
    try {
      const catalog = await client.rpc<{ groups: Array<{ id: string; name?: string; models: Array<{ id: string; name?: string }> }> }>('llm.models')
      const groups = catalog.groups ?? []
      let matches: Array<{ provider: string; model: string }> = []
      for (const g of groups) {
        for (const m of g.models ?? []) {
          if (m.id.toLowerCase().includes(query.toLowerCase()) || (m.name ?? '').toLowerCase().includes(query.toLowerCase())) {
            matches.push({ provider: g.id, model: m.id })
          }
        }
      }
      if (matches.length === 0) return `未找到模型「${query}」,发「模型」查看可用列表`
      if (matches.length > 1) {
        return `「${query}」匹配多个模型,请精确一点:\n${matches.slice(0, 6).map((x) => `  ${x.provider}/${x.model}`).join('\n')}`
      }
      const target = matches[0]
      await client.rpc('session.selectModel', {
        sessionId: ctx.sessionId,
        provider: target.provider,
        model: target.model,
      })
      return `✓ 已切换到 ${target.provider}/${target.model}(会话 ${ctx.sessionId.slice(0, 20)}…)`
    } catch (error) {
      return `切换失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdModels(): Promise<string> {
    const client = this.harness.client()
    try {
      const data = await client.rpc<{ groups: Array<{ id: string; name?: string; models: Array<{ id: string; name?: string }> }> }>('llm.models')
      const groups = data.groups ?? []
      if (groups.length === 0) return '未配置模型(请在 Web UI 设置 → Models 中添加)'
      return groups.map((g) =>
        `${g.name ?? g.id}:\n  ${g.models.map((m) => m.name ?? m.id).join('、')}`,
      ).join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 任务操作按钮(停止/进展/打开),由机器人通道按钮点击调用。
   * 校验发起者身份;返回给点击者的结果文本。
   */
  async handleButtonAction(channel: string, userId: string, sessionId: string, action: 'stop' | 'progress' | 'open'): Promise<string> {
    const owner = this.sessionOwners.get(sessionId)
    if (owner === undefined || owner.channel !== channel || owner.userId !== userId) {
      return '该会话不是由你发起,无权操作。'
    }
    if (action === 'stop') return this.cmdCancel(sessionId)
    if (action === 'progress') return this.cmdProgress(sessionId)
    return this.cmdOpen(sessionId)
  }

  private async cmdCancel(sessionId: string): Promise<string> {
    if (!/^session-/.test(sessionId)) return '请提供完整的会话 id(以 session- 开头)'
    try {
      await this.harness.client().rpc('session.cancel', { sessionId })
      return `已请求停止 ${sessionId}`
    } catch (error) {
      return `停止失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdOpen(sessionId: string): Promise<string> {
    if (!/^session-/.test(sessionId)) return '请提供完整的会话 id(以 session- 开头)'
    const client = this.harness.client()
    try {
      const data = await client.rpc<{ events: Array<{ event?: { type?: string; data?: { message?: { content?: unknown } } } }> }>('session.history', { sessionId, maxMessages: 2 }, 30000)
      const events = data.events ?? []
      const assistantTexts: string[] = []
      const userTexts: string[] = []
      for (const entry of events) {
        const type = entry.event?.type
        const content = entry.event?.data?.message?.content
        if (type === 'assistant/message' && Array.isArray(content)) {
          const text = content.map((b) => (b as { text?: string }).text ?? '').join('')
          if (text.trim() !== '') assistantTexts.push(text)
        } else if (type === 'user/message' && Array.isArray(content)) {
          const text = content.map((b) => (b as { text?: string }).text ?? '').join('')
          if (text.trim() !== '') userTexts.push(text)
        }
      }
      const lines: string[] = [`会话 ${sessionId}`]
      if (userTexts.length > 0) lines.push(`问:${userTexts[userTexts.length - 1].slice(0, 120)}`)
      if (assistantTexts.length > 0) lines.push(`答:${assistantTexts[assistantTexts.length - 1].slice(0, 300)}`)
      else lines.push('(尚无回复)')
      return lines.join('\n')
    } catch (error) {
      return `读取失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 任务进展:会话状态 + 工具调用统计 + 最近输出摘要。 */
  private async cmdProgress(sessionId: string): Promise<string> {
    if (!/^session-/.test(sessionId)) return '请提供完整的会话 id(以 session- 开头)'
    const client = this.harness.client()
    try {
      const [list, data] = await Promise.all([
        client.rpc<{ items: Array<{ sessionId: string; running?: boolean; title?: string | null }> }>('session.list', {}, 20000),
        client.rpc<{ events: Array<{ event?: { type?: string; seq?: number; data?: { message?: { content?: unknown }; name?: unknown; error?: unknown } } }> }>('session.history', { sessionId, maxMessages: 6 }, 30000),
      ])
      const meta = (list.items ?? []).find((s) => s.sessionId === sessionId)
      const events = data.events ?? []
      const toolCalls = events.filter((e) => e.event?.type === 'tool/call').length
      const toolFails = events.filter((e) => e.event?.type === 'tool/result' && e.event.data?.error !== undefined).length
      const assistantTexts: string[] = []
      for (const entry of events) {
        if (entry.event?.type === 'assistant/message' && Array.isArray(entry.event.data?.message?.content)) {
          const text = (entry.event.data.message.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')
          if (text.trim() !== '') assistantTexts.push(text)
        }
      }
      const lastText = assistantTexts.length > 0
        ? assistantTexts[assistantTexts.length - 1].replace(/\s+/g, ' ').slice(0, 200)
        : '(暂无输出)'
      const status = meta?.running ? '▶ 运行中' : '⏸ 空闲/已结束'
      const title = meta?.title ?? '(无标题)'
      const lines = [
        `会话 ${sessionId.slice(0, 20)}…`,
        `${status} | ${title.slice(0, 30)}`,
        `最近 6 条消息内:工具调用 ${toolCalls} 次${toolFails > 0 ? `,失败 ${toolFails} 次` : ''}`,
        `最新输出: ${lastText}`,
      ]
      return lines.join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdRun(
    key: string,
    description: string,
    pushTarget?: { scope: string; targetId: string },
  ): Promise<string> {
    if (description === '') return '任务描述不能为空,示例:任务 分析这个仓库的架构'
    const client = this.harness.client()
    const parsed = parseTaskOptions(description)
    const taskText = parsed.description
    if (taskText === '') return '任务描述不能为空'
    try {
      let workspaceId: string | null = null
      let cwd = parsed.cwd
      // 任务未指定工作区/目录时,回退到 QQ 配置的默认工作区/目录(仅 QQ 通道提供该配置)。
      if (workspaceId === null && cwd === null) {
        const fallback = this.defaultTarget ?? ''
        if (fallback !== '') {
          if (/[\\/]/.test(fallback)) {
            cwd = fallback
          } else {
            const workspaces = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string }> }>('workspace.list')
            const found = (workspaces.items ?? []).find((w) => w.title === fallback || w.workspaceId === fallback || w.path === fallback)
            if (found === undefined) {
              return `默认工作区「${fallback}」不存在,发送「工作区」查看列表`
            }
            workspaceId = found.workspaceId
          }
        }
      }
      if (parsed.workspaceName !== null) {
        const workspaces = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string }> }>('workspace.list')
        const found = (workspaces.items ?? []).find((w) => w.title === parsed.workspaceName || w.path === parsed.workspaceName)
        if (found === undefined) {
          return `未找到工作区「${parsed.workspaceName}」,发送「工作区」查看列表`
        }
        workspaceId = found.workspaceId
      }
      const payload: Record<string, unknown> = {}
      if (workspaceId !== null) payload.workspaceId = workspaceId
      else if (cwd !== null) payload.cwd = cwd
      const created = await client.rpc<{ sessionId: string }>('session.create', payload)
      this.sessionOwners.set(created.sessionId, { ...this.ownerFromKey(key), pushTarget, kind: 'task' })
      await client.rpc('session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: this.withModePrompt('task', taskText) }],
      })
      return `任务已启动 ✓\n会话: ${created.sessionId}\n描述: ${taskText.slice(0, 80)}\n发送「进展 ${created.sessionId}」查看进展`
    } catch (error) {
      return `启动失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 通道级默认工作区/目录(QQ 配置;其他通道留空)。 */
  defaultTarget = ''

  /**
   * 进入对话模式:
   * - target 为空 = 纯对话(不绑定工作区,朋友模式)
   * - target = 工作区名 [编号]:进入该工作区(助手模式);工作区有多个会话时
   *   列出会话供选择(回复「进入 <工作区> <编号>」);「会话」可随时返回选择。
   */
  private async cmdEnter(
    key: string,
    target: string,
    pushTarget?: { scope: string; targetId: string },
  ): Promise<string> {
    const client = this.harness.client()
    try {
      let workspaceId: string | null = null
      let cwd: string | null = null
      let label = target
      let sessionIndex = -1
      if (target === '') {
        label = '(纯对话,不绑定工作区)'
      } else {
        // 支持「工作区名 编号」选择已有会话。
        const parts = target.trim().split(/\s+/)
        const last = parts[parts.length - 1]
        if (/^\d+$/.test(last)) {
          sessionIndex = Number(last) - 1
          target = parts.slice(0, -1).join(' ')
          label = target
        }
        if (/[\\/]/.test(target)) {
          cwd = target
        } else {
          const workspaces = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string; sessions?: Array<{ sessionId: string; title?: string | null; blank?: boolean }> }> }>('workspace.list')
          const found = (workspaces.items ?? []).find((w) => w.title === target || w.workspaceId === target || w.path === target)
          if (found === undefined) {
            return `未找到工作区「${target}」,发送「工作区」查看列表(或直接「进入」开始纯对话)`
          }
          workspaceId = found.workspaceId
          cwd = found.path ?? null
          // 工作区有会话:列出供选择(除非用户已指定编号)。
          const sessions = (found.sessions ?? []).filter((s) => !s.blank)
          if (sessionIndex < 0 && sessions.length > 0) {
            const lines = [`工作区「${target}」已有 ${sessions.length} 个会话,选择进入:`]
            sessions.slice(0, 8).forEach((s, i) => {
              lines.push(`  ${i + 1}. ${(s.title ?? s.sessionId).slice(0, 40)}`)
            })
            lines.push(`回复「进入 ${target} <编号>」选择;或「进入 ${target} 新」新建会话`)
            return lines.join('\n')
          }
          if (sessionIndex >= 0 && sessions[sessionIndex] !== undefined) {
            // 选择已有会话:直接切换,不新建。
            const chosen = sessions[sessionIndex]
            this.sessionOwners.set(chosen.sessionId, { ...this.ownerFromKey(key), pushTarget, kind: 'task' })
            this.chatContexts.set(key, { sessionId: chosen.sessionId, label: target })
            this.persistChat(key)
            return [
              `已进入工作区「${target}」会话 ${sessionIndex + 1} ✓`,
              `会话: ${chosen.sessionId}`,
              '现在直接发消息即可对话;「会话」返回工作区选择,「退出」结束对话模式。',
            ].join('\n')
          }
        }
      }
      const payload: Record<string, unknown> = {}
      if (workspaceId !== null) payload.workspaceId = workspaceId
      else if (cwd !== null) payload.cwd = cwd
      const created = await client.rpc<{ sessionId: string }>('session.create', payload)
      // 工作区 = 助手模式;纯对话 = 朋友模式。
      const kind = target === '' ? 'chat' : 'task'
      this.sessionOwners.set(created.sessionId, { ...this.ownerFromKey(key), pushTarget, kind })
      this.chatContexts.set(key, { sessionId: created.sessionId, label })
      this.persistChat(key)
      const lines = target === ''
        ? [
            '已进入对话模式 ✓(纯对话,不绑定工作区)',
            `会话: ${created.sessionId}`,
            '现在直接发消息即可对话(无需指令前缀),发送「退出」结束对话模式。',
            '提示:纯对话会话未绑定工作区,agent 一般不动文件;若它仍请求文件操作,可用「拒绝」拦截。',
          ]
        : [
            `已进入工作区「${target}」对话模式 ✓`,
            `会话: ${created.sessionId}`,
            '现在直接发消息即可对话;「会话」返回工作区选择,「退出」结束对话模式。',
          ]
      return lines.join('\n')
    } catch (error) {
      return `进入失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private cmdExit(key: string): string {
    const ctx = this.chatContexts.get(key)
    if (ctx === undefined) return '当前不在对话模式。'
    this.chatContexts.delete(key)
    this.persistChat(key)
    const hint = this.autoChatChannels.has(key.split(':')[0])
      ? '开启默认对话模式时,发任意消息将自动进入纯对话。'
      : ''
    return `已退出「${ctx.label}」对话模式。会话 ${ctx.sessionId} 保留在后台。${hint}`.trim()
  }

  private async cmdChatMessage(key: string, text: string, pushTarget?: { scope: string; targetId: string }): Promise<string> {
    const ctx = this.chatContexts.get(key)
    if (ctx === undefined) return this.fullHelp()
    const client = this.harness.client()
    try {
      let owner = this.sessionOwners.get(ctx.sessionId)
      // 工作区会话 = 助手模式提示词;纯对话 = 朋友模式提示词。
      const mode = owner !== undefined && owner.kind === 'task' ? 'task' : 'chat'
      await client.rpc('session.prompt', {
        sessionId: ctx.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: this.withModePrompt(mode, text) }],
      })
      // 注册回复推送:回合结束后把 agent 的回复主动推给发起者(对话体验)。
      // 重启后恢复的对话会话可能没有归属记录,这里补登记。
      if (owner === undefined) {
        owner = { ...this.ownerFromKey(key), kind: 'chat' }
        this.sessionOwners.set(ctx.sessionId, owner)
      } else if (pushTarget !== undefined && owner.pushTarget === undefined) {
        // 补全推送目标(如会话从群创建、当前消息来自私聊)。
        owner.pushTarget = pushTarget
      }
      if (owner.kind === 'chat') {
        this.chatReplies.set(ctx.sessionId, {
          channel: owner.channel,
          userId: owner.userId,
          pushTarget: owner.pushTarget,
          ts: Date.now(),
        })
      }
      // 对话模式静默:不回复"已发送"确认(避免噪音;真实回复回合结束自动推送)。
      return ''
    } catch (error) {
      return `发送失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 处理 harness 交互帧(审批 / 提问)。
   * 由宿主从事件流桥接调用;应答统一走 /api/respond,与 PWA 手机端同一路径。
   */
  handleInteractionFrame(frame: ServerRequest): void {
    if (frame.type !== 'server-request') return
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    switch (frame.method) {
      case 'approval/requested': {
        const sessionId = String(payload.sessionId ?? '')
        const approvalId = String(payload.approvalId ?? '')
        if (sessionId === '' || approvalId === '') return
        const pending: PendingApproval = {
          rpcId: frame.rpcId,
          sessionId,
          approvalId,
          toolName: String(payload.toolName ?? '?'),
          reason: payload.reason !== undefined ? String(payload.reason) : undefined,
        }
        this.pendingApprovals.set(`${sessionId}:${approvalId}`, pending)
        this.notifyOwner(sessionId, this.formatApproval(pending), {
          kind: 'approval',
          sessionId,
          approvalId,
        })
        break
      }
      case 'approval/resolved': {
        const sessionId = String(payload.sessionId ?? '')
        const approvalId = String(payload.approvalId ?? '')
        if (sessionId !== '') this.pendingApprovals.delete(`${sessionId}:${approvalId}`)
        break
      }
      case 'question/requested': {
        const sessionId = String(payload.sessionId ?? '')
        const questions = Array.isArray(payload.questions) ? (payload.questions as AskUserQuestionItem[]) : []
        if (sessionId === '' || questions.length === 0) return
        this.pendingQuestions.set(sessionId, {
          rpcId: frame.rpcId,
          sessionId,
          questions,
          answers: new Map(),
        })
        this.notifyOwner(sessionId, this.formatQuestion(sessionId, questions, 0), this.questionMeta(sessionId, questions))
        break
      }
      case 'question/resolved': {
        const sessionId = String(payload.sessionId ?? '')
        if (sessionId !== '') this.pendingQuestions.delete(sessionId)
        break
      }
      case 'session/event': {
        // 主动汇报:机器人发起的任务完成/失败时推送通知(通道需开启汇报开关)。
        this.handleSessionEvent(payload)
        break
      }
      default:
        break
    }
  }

  /** 会话事件:任务汇报 + 对话回复(流式/整段)。 */
  private handleSessionEvent(payload: Record<string, unknown>): void {
    const sessionId = String(payload.sessionId ?? '')
    const owner = this.sessionOwners.get(sessionId)
    if (owner === undefined || !isRecord(payload.event)) return
    if (owner.kind === 'chat') {
      this.handleChatEvent(sessionId, owner, payload.event)
      return
    }
    if (payload.event.type !== 'turn/end') return
    if (!this.reportChannels.has(owner.channel)) return
    const data = isRecord(payload.event.data) ? payload.event.data : {}
    const reason = isRecord(data.reason) ? data.reason : {}
    const detail = reason.error ?? reason.failure
    const message = typeof detail === 'object' && detail !== null && typeof (detail as { message?: unknown }).message === 'string'
      ? (detail as { message: string }).message
      : typeof reason.message === 'string'
        ? reason.message
        : ''
    const failed = reason.kind === 'error'
    // 去重:同一会话的完成/失败汇报 5 分钟内只推一次(多轮任务不重复刷屏)。
    const now = Date.now()
    const record = this.lastTurnReports.get(sessionId) ?? { done: 0, fail: 0 }
    const last = failed ? record.fail : record.done
    if (now - last < 5 * 60 * 1000) return
    if (failed) record.fail = now
    else record.done = now
    this.lastTurnReports.set(sessionId, record)
    const text = failed
      ? `❌ 任务失败(会话 ${sessionId})${message !== '' ? `\n${message.slice(0, 200)}` : ''}\n发送「打开 ${sessionId}」查看详情`
      : `✅ 任务完成(会话 ${sessionId})\n发送「打开 ${sessionId}」查看结果`
    if (this.push !== null) this.push(owner.channel, owner.userId, text, undefined, owner.pushTarget)
  }

  /** 对话回合事件:chunk 增量实时流出(QQ 私聊流式)或缓冲;turn/end 收尾。 */
  private handleChatEvent(sessionId: string, owner: SessionOwner, ev: Record<string, unknown>): void {
    const pending = this.chatReplies.get(sessionId)
    if (pending === undefined) return
    const streamable = this.chatStream !== null && owner.channel === 'qq' && owner.pushTarget?.scope === 'c2c'
    if (ev.type === 'assistant/chunk') {
      const chunk = isRecord(ev.data) && isRecord(ev.data.chunk) ? ev.data.chunk : null
      if (chunk !== null && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        if (streamable) this.chatStream!.onDelta(owner.channel, pending.userId, chunk.text, owner.pushTarget)
        else this.chatReplyBuffer.set(sessionId, (this.chatReplyBuffer.get(sessionId) ?? '') + chunk.text)
      }
      return
    }
    if (ev.type === 'turn/end') {
      if (streamable) {
        this.chatStream!.onEnd(owner.channel, pending.userId, owner.pushTarget)
        this.chatReplies.delete(sessionId)
        return
      }
      this.pushChatReply(sessionId)
    }
  }

  /** 对话回合结束:推送给发起者(非流式通道);优先用回合缓冲,兜底拉历史。 */
  private pushChatReply(sessionId: string): void {
    const pending = this.chatReplies.get(sessionId)
    if (pending === undefined || this.push === null) return
    this.chatReplies.delete(sessionId)
    // 5 分钟内有效;超时视为用户已离开,不再推送。
    if (Date.now() - pending.ts > 5 * 60 * 1000) return
    const buffered = this.chatReplyBuffer.get(sessionId) ?? ''
    this.chatReplyBuffer.delete(sessionId)
    if (buffered.trim() !== '') {
      this.push(pending.channel, pending.userId, `💬 ${buffered.slice(0, 1500)}`, undefined, pending.pushTarget)
      return
    }
    const client = this.harness.client()
    void client.rpc<{ events: Array<{ event?: { type?: string; data?: { message?: { content?: unknown } } } }> }>(
      'session.history', { sessionId, maxMessages: 2 }, 30000,
    ).then((data) => {
      const events = data.events ?? []
      let reply = ''
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i].event
        if (ev?.type === 'assistant/message' && Array.isArray(ev.data?.message?.content)) {
          const text = (ev.data.message.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')
          if (text.trim() !== '') { reply = text; break }
        }
      }
      // 拉不到内容就不打扰用户(可发「进展」或手机端查看)。
      if (reply === '') return
      this.push!(pending.channel, pending.userId, `💬 ${reply.slice(0, 1500)}`, undefined, pending.pushTarget)
    }).catch(() => {
      // 拉取失败:静默,用户可发「进展」查看。
    })
  }

  /** 允许/拒绝审批(指令入口):outcome 为 'allowed-once' | 'rejected'。 */
  private async cmdAllow(key: string, sessionId: string, outcome: 'allowed-once' | 'rejected'): Promise<string> {
    const owner = this.ownerFromKey(key)
    const pending = this.findPendingApproval(owner, sessionId, '')
    if (pending === null) {
      return sessionId !== ''
        ? `会话 ${sessionId} 没有待审批项(可能已处理或不是由你发起)`
        : '当前没有待审批项。收到审批通知后回复「允许」或「拒绝」即可。'
    }
    return this.respondApproval(owner.channel, owner.userId, pending.sessionId, pending.approvalId, outcome)
  }

  /** 回答选择题:「选 2」「选 1 3」「选 自定义:xx」「#2 选 1」。 */
  private async cmdSelect(key: string, text: string): Promise<string> {
    const owner = this.ownerFromKey(key)
    const pending = this.findPendingQuestion(owner)
    if (pending === null) {
      return '当前没有待回答的提问。收到提问通知后按「选 <编号>」回答。'
    }
    const parts = text.trim().split(/\s+/)
    let index = 0
    let questionIdx = 0
    const hashMatch = /^#(\d+)$/.exec(parts[0] ?? '')
    if (hashMatch !== null) {
      questionIdx = Number(hashMatch[1]) - 1
      index = 1
    } else if (pending.questions.length === 1) {
      questionIdx = 0
    }
    const question = pending.questions[questionIdx]
    if (question === undefined) {
      return `题号无效,共 ${pending.questions.length} 题(格式:#1 选 2)`
    }
    const selected: string[] = []
    let custom: string | undefined
    for (const token of parts.slice(index)) {
      const customMatch = /^自定义:(.*)$/.exec(token)
      if (customMatch !== null) {
        custom = customMatch[1]
        continue
      }
      const num = Number(token)
      if (!Number.isInteger(num) || num < 1) {
        return `无法识别「${token}」。格式:选 <编号>(如:选 2;多选:选 1 3;自定义:选 自定义:先备份)`
      }
      const option = question.options?.[num - 1]
      if (option === undefined) {
        return `编号 ${num} 超出选项范围(共 ${question.options?.length ?? 0} 项)`
      }
      selected.push(option.label)
    }
    if (selected.length === 0 && custom === undefined) {
      return '请给出选项编号或自定义内容,如:「选 2」「选 自定义:先备份」'
    }
    if (custom !== undefined && !question.multiSelect && selected.length > 0) {
      // 单选时 custom 覆盖 selected(与 harness 语义一致)。
      pending.answers.set(question.id, { selected: [], custom })
    } else {
      const existing = pending.answers.get(question.id)
      pending.answers.set(question.id, {
        selected: existing !== undefined && question.multiSelect ? [...existing.selected, ...selected] : selected,
        custom,
      })
    }
    const answeredCount = pending.questions.filter((q) => pending.answers.has(q.id)).length
    if (answeredCount < pending.questions.length) {
      const answered = [...pending.answers.keys()]
      const remaining = pending.questions
        .map((q, i) => ({ q, i }))
        .filter(({ q }) => !answered.includes(q.id))
        .map(({ q, i }) => `#${i + 1} ${q.question.slice(0, 40)}`)
        .join(';')
      return `已记录回答 ${answeredCount}/${pending.questions.length}。剩余:${remaining}`
    }
    // 全部答完:提交。
    const answers = pending.questions.map((q) => {
      const a = pending.answers.get(q.id)
      return a !== undefined ? { id: q.id, selected: a.selected, custom: a.custom } : { id: q.id, selected: [] }
    })
    const client = this.harness.client()
    try {
      const receipt = await client.respond(pending.rpcId, {
        ok: true,
        value: { sessionId: pending.sessionId, answer: { answers } },
      })
      this.pendingQuestions.delete(pending.sessionId)
      if (!receipt.accepted) {
        return `回答未被接受:${receipt.reason ?? '未知原因'}`
      }
      return `✓ 已回答 ${answers.length} 个问题,已提交给 agent`
    } catch (error) {
      return `提交失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 按钮回答选择题(单选单问题批次,由机器人通道按钮点击调用)。
   * 校验发起者身份;提交后返回给用户的结果文本。
   */
  async respondQuestion(
    channel: string,
    userId: string,
    sessionId: string,
    questionId: string,
    optionIndex: number,
  ): Promise<string> {
    const pending = this.findPendingQuestion({ channel, userId }, sessionId)
    if (pending === null) return '该提问已处理或已过期。'
    const question = pending.questions.find((q) => q.id === questionId)
    if (question === undefined) return '找不到该问题。'
    if (question.multiSelect === true || question.options === undefined) return '该问题不支持按钮回答,请用「选 N」回复。'
    const option = question.options[optionIndex]
    if (option === undefined) return '选项编号无效。'
    const answers = pending.questions.map((q) =>
      q.id === questionId ? { id: q.id, selected: [option.label] } : { id: q.id, selected: [] },
    )
    const client = this.harness.client()
    try {
      const receipt = await client.respond(pending.rpcId, {
        ok: true,
        value: { sessionId: pending.sessionId, answer: { answers } },
      })
      this.pendingQuestions.delete(pending.sessionId)
      if (!receipt.accepted) {
        return `回答未被接受:${receipt.reason ?? '未知原因'}`
      }
      return `✓ 已选择:${option.label}`
    } catch (error) {
      return `提交失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  // ---- 内部 ----

  /** 从 `${channel}:${userId}` 拆出归属(通道名不含冒号,userId 为 openid/数字)。 */
  private ownerFromKey(key: string): Pick<SessionOwner, 'channel' | 'userId'> {
    const sep = key.indexOf(':')
    return sep < 0
      ? { channel: key, userId: '' }
      : { channel: key.slice(0, sep), userId: key.slice(sep + 1) }
  }

  /** 查该用户可应答的待审批项;sessionId/approvalId 非空时精确匹配。 */
  private findPendingApproval(owner: Pick<SessionOwner, 'channel' | 'userId'>, sessionId: string, approvalId: string): PendingApproval | null {
    for (const pending of this.pendingApprovals.values()) {
      if (sessionId !== '' && pending.sessionId !== sessionId) continue
      if (approvalId !== '' && pending.approvalId !== approvalId) continue
      const o = this.sessionOwners.get(pending.sessionId)
      if (o !== undefined && o.channel === owner.channel && o.userId === owner.userId) return pending
    }
    return null
  }

  /** 查该用户最近的待回答提问。 */
  private findPendingQuestion(owner: Pick<SessionOwner, 'channel' | 'userId'>, sessionId?: string): PendingQuestion | null {
    for (const pending of this.pendingQuestions.values()) {
      if (sessionId !== undefined && sessionId !== '' && pending.sessionId !== sessionId) continue
      const o = this.sessionOwners.get(pending.sessionId)
      if (o !== undefined && o.channel === owner.channel && o.userId === owner.userId) return pending
    }
    return null
  }

  /** 交互帧到来时通知会话发起者(仅支持主动推送的通道;其余靠回复提示)。 */
  private notifyOwner(
    sessionId: string,
    text: string,
    meta?: { kind: 'approval'; sessionId: string; approvalId: string } | { kind: 'question'; sessionId: string; question: { id: string; question: string; options: string[] } },
  ): void {
    if (this.push === null) return
    const owner = this.sessionOwners.get(sessionId)
    if (owner !== undefined) this.push(owner.channel, owner.userId, text, meta, owner.pushTarget)
  }

  /** 单选单问题批次 → 生成可渲染选项按钮的 meta(多选/多题保持文本指令)。 */
  private questionMeta(sessionId: string, questions: AskUserQuestionItem[]): { kind: 'question'; sessionId: string; question: { id: string; question: string; options: string[] } } | undefined {
    if (questions.length !== 1) return undefined
    const q = questions[0]
    if (q.multiSelect === true || q.options === undefined || q.options.length === 0 || q.options.length > 5) return undefined
    return {
      kind: 'question',
      sessionId,
      question: { id: q.id, question: q.question, options: q.options.map((o) => o.label) },
    }
  }

  /** 审批通知文本。 */
  private formatApproval(pending: PendingApproval): string {
    const lines = [
      `⚠️ 需要审批(会话 ${pending.sessionId})`,
      `工具:${pending.toolName}`,
    ]
    if (pending.reason !== undefined && pending.reason !== '') lines.push(`原因:${pending.reason.slice(0, 120)}`)
    lines.push('回复:「允许」或「拒绝」')
    return lines.join('\n')
  }

  /** 提问通知文本(选择题)。 */
  private formatQuestion(sessionId: string, questions: AskUserQuestionItem[], answeredCount: number): string {
    const lines: string[] = [`❓ 需要你回答(会话 ${sessionId})`]
    questions.forEach((q, i) => {
      const multi = q.multiSelect === true ? ' (多选)' : ''
      lines.push(`#${i + 1} ${q.question}${multi}`)
      if (q.detail !== undefined && q.detail !== '') lines.push(`  ${q.detail.slice(0, 80)}`)
      if (q.options !== undefined && q.options.length > 0) {
        q.options.forEach((opt, j) => {
          const desc = opt.description !== undefined && opt.description !== '' ? ` — ${opt.description.slice(0, 40)}` : ''
          lines.push(`  (${j + 1}) ${opt.label}${desc}`)
        })
      } else {
        lines.push('  (无选项,请用自定义回答)')
      }
    })
    if (questions.length > 1) {
      lines.push(`回复格式:#<题号> 选 <编号>,如「#1 选 2」;已答 ${answeredCount}/${questions.length}`)
    } else {
      lines.push('回复格式:选 <编号>;自定义:「选 自定义:你的回答」')
    }
    return lines.join('\n')
  }

  /** 该用户未决的审批/提问提示(附加在下次回复末尾;QQ 被动模式的主要通知途径)。 */
  private pendingSuffix(channel: string, userId: string): string {
    const lines: string[] = []
    for (const pending of this.pendingApprovals.values()) {
      const o = this.sessionOwners.get(pending.sessionId)
      if (o === undefined || o.channel !== channel || o.userId !== userId) continue
      const reason = pending.reason !== undefined && pending.reason !== '' ? `(${pending.reason.slice(0, 50)})` : ''
      lines.push(`⚠️ 待审批:${pending.toolName}${reason} 会话 ${pending.sessionId} — 回复「允许」或「拒绝」`)
    }
    for (const pending of this.pendingQuestions.values()) {
      const o = this.sessionOwners.get(pending.sessionId)
      if (o === undefined || o.channel !== channel || o.userId !== userId) continue
      lines.push(`❓ 待回答:${pending.questions.length} 个问题(会话 ${pending.sessionId}) — 回复「选 1」或「#1 选 2」`)
    }
    return lines.join('\n')
  }
}
