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
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { parseCommand, parseTaskOptions, type QQCommand } from './qq-commands'

/** 单条回复长度上限(超长由通道分段)。 */
export const MAX_REPLY_LENGTH = 1500

/** 现场播报间隔:摘要式节奏,避开 QQ 主动消息频控与刷屏。 */
const LIVE_VIEW_INTERVAL_MS = 25_000

function fmtDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds} 秒` : `${minutes} 分 ${seconds % 60} 秒`
}

/** 归一化用户标识:按钮事件给裸 openid,消息侧可能带 t: 前缀(回复目标回退),比较时统一。 */
function normUserId(id: string): string {
  return id.startsWith('t:') ? id.slice(2) : id
}

/** 相对时间描述(会话列表用)。 */
function fmtAgo(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return '刚刚'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

interface HistoryEventLike {
  event?: { type?: string; data?: { message?: { content?: unknown }; chunk?: unknown } }
}

/**
 * 从会话历史事件提取「最终交付文本」:text-delta chunk 流优先(即模型真正输出的内容),
 * assistant/message 兜底(推理型模型会把思考过程记成 message,不能直接当回复展示)。
 */
function deliveredText(events: HistoryEventLike[], cap: number): string {
  let messageText = ''
  let chunkBuf = ''
  for (const entry of events) {
    const ev = entry?.event
    if (ev === undefined) continue
    const data = isRecord(ev.data) ? ev.data : {}
    if (ev.type === 'assistant/message' && isRecord(data.message) && Array.isArray(data.message.content)) {
      const text = (data.message.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')
      if (text.trim() !== '') messageText = text
    } else if (ev.type === 'assistant/chunk' && isRecord(data.chunk)) {
      const chunk = data.chunk
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        chunkBuf += chunk.text
        if (chunkBuf.length > cap * 8) chunkBuf = chunkBuf.slice(-cap * 8)
      }
    }
  }
  const chunkTail = chunkBuf.replace(/\s+/g, ' ').trim()
  if (chunkTail !== '') return chunkTail.slice(-cap)
  return messageText.replace(/\s+/g, ' ').trim().slice(0, cap)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** turn/end 失败信息:提取错误消息与 TRANSPORT 中断标记;非失败回合返回 null。 */
function turnEndFailure(ev: Record<string, unknown>): { message: string; isTransport: boolean; failed: boolean } | null {
  const data = isRecord(ev.data) ? ev.data : {}
  const reason = isRecord(data.reason) ? data.reason : {}
  const detail = reason.error ?? reason.failure
  const message = typeof detail === 'object' && detail !== null && typeof (detail as { message?: unknown }).message === 'string'
    ? (detail as { message: string }).message
    : typeof reason.message === 'string'
      ? reason.message
      : ''
  const failed = reason.kind === 'error'
  const isTransport = failed && (reason.code === 'TRANSPORT' || (message !== '' && message.includes('finish_reason')))
  return failed ? { message, isTransport, failed } : null
}

/** 对话模式上下文。 */
interface ChatContext {
  sessionId: string
  label: string
  /** 进入的工作区/目录(任务/对话沿用);纯对话 = null。 */
  workspace: string | null
}

/** 群聊首条消息的安全提醒(仅限对话、禁止命令、警惕机器人添加者)。 */
const GROUP_SAFETY_NOTICE =
  '⚠️ 安全提醒:本群与机器人仅限对话,不响应任何命令;涉及任务与文件操作请私聊机器人。\n机器人由电脑主人添加——请勿将不可信的机器人拉入本群,否则对方可能远程操控这台电脑。'

/** 会话归属:哪个通道的哪个用户发起了该会话(用于审批/提问的定向通知)。 */
interface SessionOwner {
  channel: string
  userId: string
  /** 主动推送目标(群消息=群,私聊=用户;msgId 存在时按「回复该消息」发送);缺失时按 userId 回退。 */
  pushTarget?: { scope: string; targetId: string; msgId?: string }
  /** 会话类型:task=任务(完成/失败汇报),chat=对话(不推送回合结束汇报)。 */
  kind: 'task' | 'chat'
}

/** 任务会话「现场播报」:摘要式定时推送 agent 的最新文本与工具动作(QQ 无法真流式)。 */
interface LiveView {
  /** 最近一次工具动作(名称 + 参数摘要)。 */
  tool: string
  /** 最近一条完整的助手文本(assistant/message 定稿)。 */
  text: string
  /** 当前回合未定稿的增量文本(chunk 累积)。 */
  chunkBuf: string
  /** 自上次播报后有新内容(有内容变化才推送,避免刷屏)。 */
  changed: boolean
  /** 用户开关:发「静音」关闭,「播报」开启。 */
  broadcast: boolean
  startedAt: number
  timer: ReturnType<typeof setInterval> | null
}

/** 待审批项。 */
interface PendingApproval {
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  reason?: string
  createdAt: number
}

/** 待回答的提问批次(选择题)。 */
interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: AskUserQuestionItem[]
  answers: Map<string, { selected: string[]; custom?: string }>
  createdAt: number
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
  onDelta(channel: string, userId: string, delta: string, target?: { scope: string; targetId: string; msgId?: string }): void
  onEnd(channel: string, userId: string, target?: { scope: string; targetId: string; msgId?: string }): void
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
  /** 推送目标(群=群 id;私聊=用户 openid;msgId 存在时按「回复该消息」发送);缺失时通道按 userId 回退。 */
  target?: { scope: string; targetId: string; msgId?: string },
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
  /** 任务会话的最近描述(TRANSPORT 中断自动重试用)。 */
  private taskDescriptions = new Map<string, string>()
  /** 已自动重试过 TRANSPORT 的会话(每个会话最多重试一次)。 */
  private retriedTransports = new Set<string>()
  /** 会话 Token 累计:每个 usage 在到达时归入当时的模型，本次运行内精确分组。 */
  private tokenUsage = new Map<string, Map<string, { provider: string; model: string; input: number; output: number; cache: number; calls: number }>>()
  /** 会话当前模型(来自 request/header 事件;用于把后续 usage 归入正确模型)。 */
  private sessionModels = new Map<string, { provider: string; model: string }>()
  /** 对话会话等待回复推送:发送消息后注册,回合结束把 agent 回复推给发起者。 */
  private chatReplies = new Map<string, { channel: string; userId: string; pushTarget?: { scope: string; targetId: string }; ts: number }>()
  /** 对话会话的最近一次提示内容(TRANSPORT 流中断时重放;每会话最多重试一次)。 */
  private chatPrompts = new Map<string, { parts: Array<{ type: string; text?: string; mediaType?: string; data?: string }>; ts: number }>()
  /** 流式输出通道(QQ 私聊打字机效果);缺失时回合计束后整段推送。 */
  private chatStream: ChatStreamSink | null = null
  /** 非流式通道的回合文本缓冲(整段推送用)。 */
  private chatReplyBuffer = new Map<string, string>()
  /** 会话的现场播报状态(QQ/Telegram 可见 agent 过程)。 */
  private liveViews = new Map<string, LiveView>()
  /** 无工作区任务的"默认任务会话"(按 channel:userId 复用;「任务 新:」另起)。 */
  private defaultTaskSessions = new Map<string, string>()
  /** 已提示过安全提醒的群(进程内去重)。 */
  private groupNoticed = new Set<string>()

  /** 对话上下文键:私聊按用户,群聊按群(一个群共用一个对话,与私聊隔开)。 */
  private contextKey(channel: string, userId: string, pushTarget?: { scope: string; targetId: string }): string {
    if (pushTarget !== undefined && pushTarget.scope === 'group') return `${channel}:g:${pushTarget.targetId}`
    return `${channel}:${userId}`
  }

  /** 注入流式输出实现(仅支持主动流式的通道,如 QQ 私聊)。 */
  setChatStream(sink: ChatStreamSink): void {
    this.chatStream = sink
  }

  constructor(private harness: HarnessManager, private config?: ConfigStore) {
    // 恢复持久化的对话会话(重启后继续同一对话)。
    if (config !== undefined) {
      for (const [key, entry] of Object.entries(config.get().chatSessions ?? {})) {
        this.chatContexts.set(key, { sessionId: entry.sessionId, label: entry.label, workspace: null })
      }
    }
  }

  /** 注入主动推送实现(QQ / Telegram 等支持主动消息的通道)。 */
  setPush(push: PushFn): void {
    this.push = push
  }

  /** 当前待处理审批/提问的脱敏摘要,供桌面端与 PWA 统一展示。 */
  pendingInteractions(): Array<{ kind: 'approval' | 'question'; sessionId: string; approvalId?: string; questionId?: string; options?: string[]; title: string; detail: string; createdAt: number }> {
    const approvals = [...this.pendingApprovals.values()].map((item) => ({
      kind: 'approval' as const,
      sessionId: item.sessionId,
      approvalId: item.approvalId,
      title: `审批:${item.toolName}`,
      detail: item.reason?.slice(0, 240) ?? '等待确认工具调用',
      createdAt: item.createdAt,
    }))
    const questions = [...this.pendingQuestions.values()].map((item) => ({
      kind: 'question' as const,
      sessionId: item.sessionId,
      questionId: item.questions[0]?.id,
      options: item.questions[0]?.options?.map((option) => option.label),
      title: `提问:${item.questions[0]?.question.slice(0, 80) ?? '等待回答'}`,
      detail: item.questions.map((q) => q.question).join('；').slice(0, 240),
      createdAt: item.createdAt,
    }))
    return [...approvals, ...questions].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 桌面端直接应答待审批项,不依赖 QQ/Telegram 用户归属。 */
  async respondApprovalDesktop(sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<string> {
    const pending = this.pendingApprovals.get(`${sessionId}:${approvalId}`)
    if (pending === undefined) return '该审批已处理或已过期。'
    try {
      const receipt = await this.harness.client().respond(pending.rpcId, { ok: true, value: { sessionId, approvalId, outcome } })
      if (!receipt.accepted) return `应答未被接受:${receipt.reason ?? '未知原因'}`
      this.pendingApprovals.delete(`${sessionId}:${approvalId}`)
      return outcome === 'allowed-once' ? `✓ 已允许:${pending.toolName}` : `✗ 已拒绝:${pending.toolName}`
    } catch (error) {
      return `应答失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 桌面端直接回答单选问题。 */
  async respondQuestionDesktop(sessionId: string, questionId: string, optionIndex: number): Promise<string> {
    const pending = this.pendingQuestions.get(sessionId)
    const question = pending?.questions.find((item) => item.id === questionId)
    const option = question?.options?.[optionIndex]
    if (pending === undefined || question === undefined || option === undefined) return '该提问已处理或选项已失效。'
    try {
      const receipt = await this.harness.client().respond(pending.rpcId, { ok: true, value: { sessionId, answer: { answers: pending.questions.map((item) => item.id === questionId ? { id: item.id, selected: [option.label] } : { id: item.id, selected: [] }) } } })
      if (!receipt.accepted) return `回答未被接受:${receipt.reason ?? '未知原因'}`
      this.pendingQuestions.delete(sessionId)
      return `✓ 已选择:${option.label}`
    } catch (error) {
      return `回答失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 持久化默认纯对话线程(chatSessions 只存默认对话,工作区模式是临时态不入库)。 */
  private persistChat(key: string): void {
    if (this.config === undefined) return
    const ctx = this.chatContexts.get(key)
    if (ctx === undefined || ctx.workspace !== null) return
    this.config.update('chatSessions', { ...this.config.get().chatSessions, [key]: { sessionId: ctx.sessionId, label: ctx.label } })
  }

  /** 查默认对话线程(配置持久化;跨重启/跨工作区切换保持同一会话)。 */
  private defaultChatSession(key: string): string {
    if (this.config === undefined) return ''
    const entry = this.config.get().chatSessions?.[key]
    return entry?.sessionId ?? ''
  }

  private appendAudit(entry: { time: number; type: string; sessionId?: string; activityId?: string; detail: string }): void {
    const target = this.config as (ConfigStore & { appendAudit?: ConfigStore['appendAudit'] }) | undefined
    if (typeof target?.appendAudit === 'function') target.appendAudit(entry)
  }

  private recordTask(patch: { description?: string; sessionId?: string | null; workspace?: string | null; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error?: string }): void {
    if (this.config === undefined) return
    const now = Date.now()
    const history = this.config.get().taskHistory ?? []
    const index = patch.sessionId === undefined ? -1 : history.findIndex((item) => item.sessionId === patch.sessionId)
    const previous = index >= 0 ? history[index] : undefined
    const next = {
      id: previous?.id ?? `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
      description: patch.description ?? previous?.description ?? '',
      sessionId: patch.sessionId === undefined ? previous?.sessionId ?? null : patch.sessionId,
      status: patch.status,
      attempts: (previous?.attempts ?? 0) + (patch.status === 'running' && previous?.status !== 'running' ? 1 : 0),
      ...(patch.error === undefined ? {} : { error: patch.error.slice(0, 500) }),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    const nextHistory = index >= 0 ? history.map((item, i) => i === index ? next : item) : [next, ...history]
    this.config.update('taskHistory', nextHistory.slice(0, 100))
    const activityId = `activity-${next.id}`
    const activityConfig = this.config as ConfigStore & { activities?: ConfigStore['activities']; upsertActivity?: ConfigStore['upsertActivity'] }
    if (typeof activityConfig.activities === 'function' && typeof activityConfig.upsertActivity === 'function') {
      const existingActivity = activityConfig.activities().find((item) => item.id === activityId)
      const owner = next.sessionId === null ? undefined : this.sessionOwners.get(next.sessionId)
      activityConfig.upsertActivity({
        id: activityId,
        type: 'task',
        source: owner?.channel === 'qq' || owner?.channel === 'telegram' ? owner.channel : 'system',
        workspace: patch.workspace === undefined ? existingActivity?.workspace ?? null : patch.workspace,
        sessionId: next.sessionId,
        status: next.status,
        title: next.description.slice(0, 120) || '未命名任务',
        lastEvent: next.error ?? (next.status === 'running' ? '任务已启动' : `任务状态:${next.status}`),
        createdAt: existingActivity?.createdAt ?? next.createdAt,
        updatedAt: now,
      })
    }
    this.appendAudit({ time: now, type: `task.${next.status}`, sessionId: next.sessionId ?? undefined, activityId, detail: next.error ?? next.description.slice(0, 240) })
  }

  /** 任务启动入队(队列同步独立于汇报开关与推送去重)。 */
  private enqueueTaskRun(description: string, sessionId: string, workspace: string | null): void {
    const now = Date.now()
    this.syncQueueFromTask(
      { id: `task-${now}-${Math.random().toString(36).slice(2, 8)}`, description, sessionId, status: 'running', attempts: 1 },
      { description, sessionId, workspace, status: 'running' },
      now,
    )
  }

  /** 有任务运行中时,新任务进入排队等待(串行执行)。 */
  private enqueueQueuedTask(key: string, description: string, pushTarget: { scope: string; targetId: string } | undefined, workspace: string | null): void {
    const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue']; upsertTaskQueueEntry?: ConfigStore['upsertTaskQueueEntry'] }
    if (typeof target?.taskQueue !== 'function' || typeof target?.upsertTaskQueueEntry !== 'function') return
    const now = Date.now()
    const owner = this.ownerFromKey(key)
    target.upsertTaskQueueEntry({
      id: `queue-${now}-${Math.random().toString(36).slice(2, 8)}`,
      description,
      sessionId: null,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: null,
      workspace,
      source: owner.channel === 'qq' || owner.channel === 'telegram' ? owner.channel : 'system',
      channel: owner.channel,
      userId: owner.userId,
      pushTarget: pushTarget ?? null,
      createdAt: now,
      updatedAt: now,
    })
    this.appendAudit({ time: now, type: 'task.queued', detail: `任务排队:${description.slice(0, 120)}` })
  }

  /** 当前无运行任务时,启动最早的排队任务(串行执行器)。 */
  private draining = false
  private async drainQueue(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue']; upsertTaskQueueEntry?: ConfigStore['upsertTaskQueueEntry'] }
      if (typeof target?.taskQueue !== 'function' || typeof target?.upsertTaskQueueEntry !== 'function') return
      const entries = target.taskQueue()
      if (entries.some((item) => item.status === 'running')) return
      const next = entries.find((item) => item.status === 'queued')
      if (next === undefined) return
      const client = this.harness.client()
      try {
        if (next.sessionId === null) {
          // 排队任务(尚未创建会话):无工作区的复用"默认任务会话",其余新建工作区/目录会话。
          const key = `${next.channel}:${next.userId}`
          let createdId = ''
          if (next.workspace === null) {
            createdId = this.defaultTaskSessions.get(key) ?? ''
            if (createdId === '') {
              const created = await client.rpc<{ sessionId: string }>('session.create', {})
              createdId = created.sessionId
              this.defaultTaskSessions.set(key, createdId)
            }
          } else {
            const payload: Record<string, unknown> = {}
            if (/[\\/]/.test(next.workspace)) payload.cwd = next.workspace
            else payload.workspaceId = next.workspace
            const created = await client.rpc<{ sessionId: string }>('session.create', payload)
            createdId = created.sessionId
          }
          this.sessionOwners.set(createdId, { ...this.ownerFromKey(key), pushTarget: next.pushTarget ?? undefined, kind: 'task' })
          this.taskDescriptions.set(createdId, next.description)
          if (next.pushTarget !== null && next.pushTarget !== undefined) this.startLiveView(createdId, false)
          this.recordTask({ description: next.description, sessionId: createdId, workspace: next.workspace, status: 'running' })
          target.upsertTaskQueueEntry({ ...next, sessionId: createdId, status: 'running', attempts: 1, updatedAt: Date.now() })
          await client.rpc('session.prompt', {
            sessionId: createdId,
            mode: 'queue',
            content: [{ type: 'text', text: this.withModePrompt('task', this.withWorkspaceMemory(next.workspace !== null && /[\\/]/.test(next.workspace) ? next.workspace : null, next.description)) }],
          })
        } else {
          // 已有会话(重试转排队):直接重新执行。
          target.upsertTaskQueueEntry({ ...next, status: 'running', nextAttemptAt: null, updatedAt: Date.now() })
          await client.rpc('session.prompt', {
            sessionId: next.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: this.withModePrompt('task', this.withWorkspaceMemory(next.workspace !== null && /[\\/]/.test(next.workspace) ? next.workspace : null, next.description)) }],
          })
        }
        if (this.push !== null && next.pushTarget !== undefined && next.pushTarget !== null) {
          this.push(next.channel, next.userId, `▶️ 排队任务已开始执行:${next.description.slice(0, 60)}`, undefined, next.pushTarget)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        target.upsertTaskQueueEntry({ ...next, status: 'failed', error: message.slice(0, 500), attempts: next.attempts + 1, nextAttemptAt: Date.now() + 30_000, updatedAt: Date.now() })
        if (this.push !== null && next.pushTarget !== undefined && next.pushTarget !== null) {
          this.push(next.channel, next.userId, `❌ 排队任务启动失败:${message.slice(0, 120)}`, undefined, next.pushTarget)
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** 任务记录变化时同步调度队列(首次运行入队;完成/失败更新状态与退避时间)。 */
  private syncQueueFromTask(
    next: { id: string; description: string; sessionId: string | null; status: string; attempts: number; error?: string },
    patch: { description?: string; sessionId?: string | null; workspace?: string | null; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error?: string },
    now: number,
  ): void {
    const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue']; upsertTaskQueueEntry?: ConfigStore['upsertTaskQueueEntry'] }
    if (typeof target?.taskQueue !== 'function' || typeof target?.upsertTaskQueueEntry !== 'function') return
    const existing = next.sessionId === null ? undefined : target.taskQueue().find((item) => item.sessionId === next.sessionId)
    if (existing === undefined) {
      // 首次记录:任务启动即入队。
      const owner = next.sessionId === null ? undefined : this.sessionOwners.get(next.sessionId)
      target.upsertTaskQueueEntry({
        id: `queue-${next.id}`,
        description: next.description,
        sessionId: next.sessionId,
        status: patch.status === 'failed' || patch.status === 'cancelled' || patch.status === 'completed' ? patch.status : 'running',
        attempts: patch.status === 'failed' || patch.status === 'cancelled' ? 0 : 1,
        maxAttempts: 3,
        nextAttemptAt: null,
        ...(patch.error === undefined ? {} : { error: patch.error.slice(0, 500) }),
        workspace: patch.workspace === undefined ? null : patch.workspace,
        source: owner?.channel === 'qq' || owner?.channel === 'telegram' ? owner.channel : 'system',
        channel: owner?.channel ?? 'system',
        userId: owner?.userId ?? '',
        pushTarget: owner?.pushTarget ?? null,
        createdAt: now,
        updatedAt: now,
      })
      return
    }
    if (next.status === 'completed') {
      target.upsertTaskQueueEntry({ ...existing, status: 'completed', nextAttemptAt: null, updatedAt: now })
      return
    }
    if (next.status === 'cancelled') {
      target.upsertTaskQueueEntry({ ...existing, status: 'cancelled', nextAttemptAt: null, updatedAt: now })
      return
    }
    if (next.status === 'failed') {
      const attempts = existing.attempts + 1
      // 最多自动重试 maxAttempts 次(第 1~maxAttempts 次失败后各自退避一次;超过后不再自动重试)。
      const exhausted = attempts > existing.maxAttempts
      // 指数退避:第 1 次失败后 30s,第 2 次 60s,第 3 次 120s。
      const nextAttemptAt = exhausted ? null : now + 30_000 * 2 ** (attempts - 2)
      target.upsertTaskQueueEntry({
        ...existing,
        status: 'failed',
        attempts,
        nextAttemptAt,
        ...(patch.error === undefined ? {} : { error: patch.error.slice(0, 500) }),
        updatedAt: now,
      })
      return
    }
    // running(自动/手动重试后恢复执行)。
    target.upsertTaskQueueEntry({ ...existing, status: 'running', nextAttemptAt: null, updatedAt: now })
  }

  private withWorkspaceMemory(path: string | null, text: string): string {
    if (path === null || this.config === undefined) return text
    const target = this.config as ConfigStore & { memory?: ConfigStore['memory'] }
    if (typeof target.memory !== 'function') return text
    const memory = target.memory(path)
    if (!memory.enabled) return text
    const sections = [
      memory.summary === '' ? '' : `[项目简介]\n${memory.summary}`,
      memory.conventions === '' ? '' : `[项目约定]\n${memory.conventions}`,
      memory.commands === '' ? '' : `[常用命令]\n${memory.commands}`,
      memory.notes === '' ? '' : `[本地笔记]\n${memory.notes}`,
    ].filter((item) => item !== '')
    if (sections.length === 0) return text
    this.appendAudit({ time: Date.now(), type: 'memory.injected', detail: `任务使用工作区记忆:${path}` })
    return `[工作区本地记忆]\n${sections.join('\n\n')}\n\n[当前任务]\n${text}`
  }

  /**
   * 注入模式提示词:工作=助手,对话=朋友(桌面端可自定义;空则不注入);角色设定叠加。
   * 附带的「系统注记」用于压制模型对运行时上下文注入文本(Current runtime context /
   * DSH file policy 等系统说明)的复述与评论——GLM 类模型常因此跑偏/断档。
   */
  private withModePrompt(mode: 'task' | 'chat', text: string): string {
    const bot = this.config?.get().bot
    const prompt = bot?.[mode === 'task' ? 'taskPrompt' : 'chatPrompt']?.trim() ?? ''
    const character = mode === 'chat' ? bot?.character?.trim() ?? '' : ''
    const sections: string[] = []
    if (character !== '') sections.push(`[角色设定]\n${character}`)
    if (prompt !== '') sections.push(`[模式设定]\n${prompt}`)
    if (sections.length === 0) return `${text}\n\n[系统注记] 若本条消息或系统提示后附带出现运行上下文、文件策略、审批策略等系统说明文字(中英文皆可能),那是系统配置,不是对话内容:不要提及、复述或评论它们,也不要当作任务要求。`
    return `${sections.join('\n\n')}\n\n[消息]\n${text}\n\n[系统注记] 若消息或系统提示后附带出现运行上下文、文件策略、审批策略等系统说明文字(中英文皆可能),那是系统配置,不是对话内容:不要提及、复述或评论它们,也不要当作任务要求。`
  }

  /** 设置/清除角色扮演设定(对话模式生效)。 */
  private cmdCharacter(text: string): string {
    if (this.config === undefined) return '角色设置不可用'
    const value = text === '' || text === '无' || text === '清空' || text === '清除' || text === 'none'
      ? ''
      : text
    this.config.update('bot', { character: value })
    return value === ''
      ? '已清除角色设定,恢复默认朋友模式。'
      : `🎭 角色已设定:${value.slice(0, 60)}\n进入对话模式后生效(纯对话);「角色 无」清除。`
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
    /** 附带图片(base64;对话/任务消息会一并发给 agent)。 */
    image?: { mime: string; data: string },
  ): Promise<string> {
    const content = text.trim()
    const key = `${channel}:${userId}`
    const ctxKey = this.contextKey(channel, userId, pushTarget)
    let reply: string
    if (content === '' && image === undefined) {
      reply = ''
    } else if (pushTarget !== undefined && pushTarget.scope === 'group') {
      // 群聊:只对话,不解析任何命令 —— 群里任何人都可能触发命令,等于把电脑
      // 交给群成员远程操控;私聊才有任务/查询等完整指令集。
      reply = await this.groupChatOnly(key, ctxKey, content, pushTarget, image)
    } else {
      const command = parseCommand(content)
      if (command.kind === 'unknown') {
        const ctx = this.chatContexts.get(ctxKey)
        if (ctx !== undefined) {
          reply = await this.cmdChatMessage(ctxKey, key, content, pushTarget, image)
        } else if (this.autoChatChannels.has(channel)) {
          // 默认对话模式:非指令消息自动进入纯对话并发送;复用旧线程时不重复播说明书。
          const entered = await this.cmdEnter(ctxKey, key, '', pushTarget)
          const autoCtx = this.chatContexts.get(ctxKey)
          const reused = autoCtx !== undefined && entered.startsWith('已在对话模式')
          reply = autoCtx !== undefined
            ? `${reused ? '' : `${entered}\n\n`}${await this.cmdChatMessage(ctxKey, key, content, pushTarget, image)}`.trim()
            : entered
        } else if (image !== undefined && this.autoChatChannels.has(channel) === false) {
          // 纯图片消息:自动进入纯对话后发送(图片理解)。
          const entered = await this.cmdEnter(ctxKey, key, '', pushTarget)
          const autoCtx = this.chatContexts.get(ctxKey)
          const reused = autoCtx !== undefined && entered.startsWith('已在对话模式')
          reply = autoCtx !== undefined
            ? `${reused ? '' : `${entered}\n\n`}${await this.cmdChatMessage(ctxKey, key, content, pushTarget, image)}`.trim()
            : entered
        } else {
          reply = this.fullHelp()
        }
      } else {
        reply = await this.executeCommand(command, key, ctxKey, pushTarget)
      }
    }
    const suffix = this.pendingSuffix(channel, userId)
    if (suffix === '') return reply
    return reply === '' ? suffix : `${reply}\n\n${suffix}`
  }

  /** 群聊模式:只对话。首次进入某个群时附带安全提醒;纯对话会话复用优先。 */
  private async groupChatOnly(
    key: string,
    ctxKey: string,
    content: string,
    pushTarget: { scope: string; targetId: string },
    image?: { mime: string; data: string },
  ): Promise<string> {
    let notice = ''
    if (!this.chatContexts.has(ctxKey)) {
      if (!this.groupNoticed.has(ctxKey)) {
        this.groupNoticed.add(ctxKey)
        notice = `${GROUP_SAFETY_NOTICE}\n\n`
      }
      await this.cmdEnter(ctxKey, key, '', pushTarget)
    }
    const sent = await this.cmdChatMessage(ctxKey, key, content, pushTarget, image)
    return notice + sent
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
      '用量 — 今日会话/回合/模型耗时统计',
      '  例:用量',
      '会话 — 最近 5 个会话',
      '  例:会话',
      '工作区 — 工作区列表',
      '  例:工作区',
      '模型 — 可用模型列表',
      '  例:模型',
      '模型 <名称> — 切换当前对话的模型',
      '  例:模型 deepseek-v4',
      '',
      '🚀 任务类(一次性任务,仅限私聊)',
      '任务 <描述> — 默认工作区执行',
      '  例:任务 分析这个仓库的架构',
      '  例:任务 写一个 README 并提交',
      '任务 @<工作区名> <描述> — 指定工作区',
      '  例:任务 @qqbot 修复登录 bug',
      '任务 目录:<路径> <描述> — 指定目录',
      '  例:任务 目录:D:/work/proj 编译并运行测试',
      '',
      '💬 对话模式',
      '直接发消息 = 默认对话(朋友模式,不碰文件)',
      '  例:早上好呀 / 帮我看看这件事怎么想',
      '默认对话只保留一条线程:随便穿插任务/工作区都不会另开;发「新对话」可重开一段',
      '退出 — 结束当前对话(下次发消息自动回到默认对话)',
      '  例:退出',
      '进入 <工作区名> — 列出该工作区的会话(带摘要与状态)供选择',
      '  例:进入 qqbot',
      '进入 <工作区名> <编号> — 直接继续该工作区的指定会话(查任务进度/接着聊)',
      '  例:进入 qqbot 2',
      '进入 <工作区名> 新 — 在该工作区新建会话',
      '  例:进入 qqbot 新',
      '进入 <目录路径> — 把任意目录当工作区聊',
      '  例:进入 D:/work/proj',
      '进入 — 回到默认对话',
      '  例:进入',
      '新对话 — 另开一段默认对话(旧线程保留在历史里)',
      '  例:新对话',
      '',
      '🔘 按钮操作(任务启动/审批/提问推送附带,点一下即可)',
      '⏹ 停止 / 📋 进展 / 📖 打开',
      '✅ 允许 / ❌ 拒绝 / 选项按钮:点一下即应答',
      '',
      '📌 会话与任务管理',
      '会话 — 最近会话列表(标题+状态+时间+摘要)',
      '  例:会话',
      '进展 <会话id> — 任务实时进展(状态/工具/最新输出)',
      '  例:进展 session-xxxxxxxx',
      '打开 <会话id> — 查看会话内容',
      '  例:打开 session-xxxxxxxx',
      '停止 <会话id> — 停止任务',
      '  例:停止 session-xxxxxxxx',
      '导出 <会话id> — 导出会话为 Markdown(存到桌面端 exports/)',
      '  例:导出 session-xxxxxxxx',
      '播报 / 静音 — 任务过程现场播报开关(默认静默,需要时开启)',
      '  例:播报',
      '  例:静音',
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
      '⏰ 定时任务(仅私聊)',
      '定时 <表达式> <描述> — 到点自动执行(助手模式)',
      '  例:定时 10分钟 检查更新',
      '  例:定时 每天9:00 写日报',
      '定时列表 — 查看已添加的定时任务',
      '取消定时 <编号> — 取消指定定时任务',
      '',
      '📂 目录浏览(限工作区与预设根目录内)',
      '目录 <路径> — 列出目录内容',
      '  例:目录 D:/work/proj',
      '文件 <路径> — 查看文件内容(64KB 以内)',
      '  例:文件 D:/work/proj/README.md',
      '',
      '💡 推送原则:机器人只在 进入/查询/审批/任务完成或失败 时主动推送;想看任务过程发「播报」或「进展 <id>」',
      '💡 群聊安全:群里只聊天、不响应任何命令(防止他人远程操控电脑);完整功能请私聊机器人',
      '💡 典型流程:直接发消息聊 → 「进入 qqbot」看会话列表挑一个 → 「任务 @qqbot 帮我…」',
    ].join('\n')
  }

  private async executeCommand(
    command: QQCommand,
    key: string,
    ctxKey: string,
    pushTarget?: { scope: string; targetId: string },
  ): Promise<string> {
    switch (command.kind) {
      case 'help':
        return this.fullHelp()
      case 'status':
        return this.cmdStatus()
      case 'sessions':
        return this.cmdSessions(ctxKey)
      case 'workspaces':
        return this.cmdWorkspaces()
      case 'models':
        return this.cmdModels()
      case 'model':
        return this.cmdModelSwitch(ctxKey, command.query)
      case 'sched':
        if (command.action === 'add') {
          const denied = this.taskScopeGuard(pushTarget)
          if (denied !== null) return denied
          return this.cmdSchedAdd(key, command.delay, command.description, pushTarget)
        }
        if (command.action === 'list') return this.cmdSchedList()
        return this.cmdSchedRemove(command.index)
      case 'ls':
        return this.cmdLs(command.path)
      case 'cat':
        return this.cmdCat(command.path)
      case 'export':
        return this.cmdExport(command.sessionId)
      case 'usage':
        return this.cmdUsage()
      case 'character':
        return this.cmdCharacter(command.text)
      case 'cancel':
        return this.cmdCancel(command.sessionId)
      case 'open':
        return this.cmdOpen(command.sessionId)
      case 'progress':
        return this.cmdProgress(command.sessionId)
      case 'broadcast': {
        const owner = this.ownerFromKey(key)
        return this.cmdBroadcast(owner.channel, owner.userId, command.sessionId, command.on)
      }
      case 'run': {
        const denied = this.taskScopeGuard(pushTarget)
        if (denied !== null) return denied
        return this.cmdRun(key, ctxKey, command.description, pushTarget)
      }
      case 'retry': {
        const denied = this.taskScopeGuard(pushTarget)
        if (denied !== null) return denied
        return this.cmdRetry(key, ctxKey, command.taskId, pushTarget)
      }
      case 'enter':
        return this.cmdEnter(ctxKey, key, command.target, pushTarget)
      case 'exit':
        return this.cmdExit(ctxKey)
      case 'newchat': {
        // 强制开启一个全新的默认对话(重开线程)。
        this.chatContexts.delete(ctxKey)
        if (this.config !== undefined) {
          const next = { ...this.config.get().chatSessions }
          delete next[ctxKey]
          this.config.update('chatSessions', next)
        }
        return this.cmdEnter(ctxKey, key, '', pushTarget)
      }
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
      // 对话模式中:「会话」列出当前工作区的会话供选择(编号与「进入 ws N」一致)。
      if (key !== undefined) {
        const ctx = this.chatContexts.get(key)
        if (ctx !== undefined && !ctx.label.startsWith('(纯对话')) {
          const wsData = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string; sessionIds?: string[] }>; archivedSessionIds?: string[] }>('workspace.list', {}, 20000)
          const found = (wsData.items ?? []).find((w) => w.title === ctx.label || w.path === ctx.label || w.workspaceId === ctx.label)
          if (found !== undefined) {
            const sessions = await this.sessionsOfWorkspace(client, found, new Set(wsData.archivedSessionIds ?? []))
            if (sessions.length === 0) return '该工作区暂无会话,发「进入 ' + ctx.label + ' 新」新建。'
            const currentIndex = sessions.findIndex((s) => s.sessionId === ctx.sessionId)
            const lines = [`工作区「${ctx.label}」的会话(共 ${sessions.length} 个${currentIndex >= 0 ? `,当前在第 ${currentIndex + 1} 个` : ''}):`]
            sessions.slice(0, 8).forEach((s, i) => {
              const mark = s.running ? '▶' : '⏸'
              lines.push(`  ${i + 1}. ${mark} ${(s.title ?? '新会话').slice(0, 32)}${s.sessionId === ctx.sessionId ? ' ← 当前' : ''}`)
            })
            if (sessions.length > 8) lines.push(`  …还有 ${sessions.length - 8} 个`)
            lines.push(`回复「进入 ${ctx.label} <编号>」切换`)
            return lines.join('\n')
          }
        }
      }
      const [list, ws] = await Promise.all([
        client.rpc<{ items: Array<{ sessionId: string; title?: string | null; running?: boolean; blank?: boolean; origin?: string; updatedAt?: number }> }>('session.list', {}, 20000),
        client.rpc<{ archivedSessionIds?: string[] }>('workspace.list', {}, 20000),
      ])
      const archived = new Set(ws.archivedSessionIds ?? [])
      // 隐藏:未发生的空会话(blank)、子代理(origin)与已归档会话;取最近 6 个。
      const items = (list.items ?? [])
        .filter((s) => !s.blank && !archived.has(s.sessionId) && !(typeof s.origin === 'string' && s.origin !== ''))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 6)
      if (items.length === 0) return '暂无会话'
      // 每个会话抓最近回复当摘要(并行,最多 6 次轻量查询;失败跳过不影响列表)。
      const previews = await Promise.all(items.map(async (s) => {
        try {
          const hist = await client.rpc<{ events: HistoryEventLike[] }>(
            'session.history', { sessionId: s.sessionId, maxMessages: 4 }, 12000,
          )
          return deliveredText(hist.events ?? [], 70)
        } catch {
          return ''
        }
      }))
      const lines = ['📋 最近会话']
      items.forEach((s, i) => {
        const title = (s.title ?? '新会话').slice(0, 26)
        const ago = s.updatedAt === undefined ? '' : `(${fmtAgo(s.updatedAt)})`
        const summary = previews[i] === '' ? '(暂无消息)' : previews[i]
        lines.push(`${i + 1}. ${s.running ? '▶' : '⏸'} ${title} ${ago}`)
        lines.push(`   💬 ${summary}`)
        lines.push(`   ${s.sessionId.slice(0, 24)}…`)
      })
      lines.push('回复「打开 <会话id>」查看完整内容')
      return lines.join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdWorkspaces(): Promise<string> {
    const client = this.harness.client()
    try {
      const [data, list] = await Promise.all([
        client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string; sessionIds?: string[] }>; archivedSessionIds?: string[] }>('workspace.list'),
        client.rpc<{ items: Array<{ sessionId: string; cwd?: string; blank?: boolean; origin?: string; running?: boolean }> }>('session.list', {}, 20000),
      ])
      const items = data.items ?? []
      if (items.length === 0) return '暂无工作区'
      const archived = new Set(data.archivedSessionIds ?? [])
      const sessions = (list.items ?? []).filter((s) => !s.blank && !archived.has(s.sessionId) && !(typeof s.origin === 'string' && s.origin !== ''))
      // 每个工作区的会话数/运行数按 cwd/注册 id 归属统计(与「进入」一致,避免显示不全)。
      const countOf = (w: { workspaceId: string; path?: string; sessionIds?: string[] }): { total: number; running: number } => {
        const p = (w.path ?? '').replace(/\\/g, '/').toLowerCase()
        const ids = new Set(w.sessionIds ?? [])
        let total = 0
        let running = 0
        for (const s of sessions) {
          const c = (s.cwd ?? '').replace(/\\/g, '/').toLowerCase()
          const hit = ids.has(s.sessionId) || (p !== '' && (c === p || c.startsWith(`${p}/`)))
          if (!hit) continue
          total += 1
          if (s.running) running += 1
        }
        return { total, running }
      }
      const rows = items.slice(0, 16).map((w) => {
        const { total, running } = countOf(w)
        const run = running > 0 ? `,${running} 运行中` : ''
        const name = w.title !== undefined && w.title !== ''
          ? w.title
          : ((w.path ?? '').split(/[\\/]/).filter((p) => p !== '').pop() ?? '未命名工作区')
        return `${name}(${total} 会话${run})`
      })
      if (items.length > 16) rows.push(`…等共 ${items.length} 个工作区`)
      rows.push('发「进入 <工作区名>」查看并进入其会话')
      return rows.join('\n')
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
    if (owner === undefined || owner.channel !== channel || normUserId(owner.userId) !== normUserId(userId)) {
      return '该会话不是由你发起,无权操作。'
    }
    if (action === 'stop') return this.cmdCancel(sessionId)
    if (action === 'progress') return this.cmdProgress(sessionId)
    return this.cmdOpen(sessionId)
  }

  // ---- 目录浏览(安全:仅限已注册工作区与预设根目录内) ----

  /** 路径白名单校验:目标必须在某个已注册工作区或预设根目录之下。 */
  private async allowPath(target: string): Promise<{ ok: boolean; message: string }> {
    if (target === '') return { ok: false, message: '用法:目录 <路径> 或 文件 <路径>' }
    const normalized = resolve(target)
    const client = this.harness.client()
    try {
      const ws = await client.rpc<{ items: Array<{ path?: string }> }>('workspace.list', {}, 20000)
      const roots = [...(ws.items ?? []).map((w) => w.path).filter((p): p is string => typeof p === 'string')]
      if (this.config !== undefined) {
        roots.push(...(this.config.get().remote.presetWorkspaceRoots ?? []))
      }
      for (const root of roots) {
        const r = resolve(root)
        if (normalized === r || normalized.startsWith(r + sep)) return { ok: true, message: '' }
      }
      return { ok: false, message: '路径不在任何工作区或预设根目录内,已拒绝访问' }
    } catch (error) {
      return { ok: false, message: `校验失败:${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async cmdLs(path: string): Promise<string> {
    const check = await this.allowPath(path)
    if (!check.ok) return check.message
    try {
      const entries = readdirSync(path, { withFileTypes: true }).slice(0, 40)
      if (entries.length === 0) return `(目录为空) ${path}`
      const lines = [`📂 ${path}`]
      for (const entry of entries) {
        let label = entry.name
        if (entry.isDirectory()) label += '/'
        lines.push(`  ${label}`)
      }
      if (entries.length === 40) lines.push('  …(仅显示前 40 项)')
      return lines.join('\n')
    } catch (error) {
      return `读取失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdCat(path: string): Promise<string> {
    const check = await this.allowPath(path)
    if (!check.ok) return check.message
    try {
      if (!statSync(path).isFile()) return '不是文件,发「目录 <路径>」查看目录'
      const size = statSync(path).size
      if (size > 64 * 1024) return `文件过大(${Math.round(size / 1024)}KB),仅支持 64KB 以内`
      const text = readFileSync(path, 'utf8')
      return `📄 ${path}\n${text.slice(0, 1500)}`
    } catch (error) {
      return `读取失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  // ---- 会话导出 ----

  private exportDir: string | null = null

  /** 注入导出文件目录(桌面端 userData/exports)。 */
  setExportDir(dir: string): void {
    this.exportDir = dir
  }

  /** 生成会话 markdown(PWA 下载与命令端共用)。 */
  async exportSession(sessionId: string): Promise<{ markdown: string; count: number }> {
    const client = this.harness.client()
    const data = await client.rpc<{ events: Array<{ event?: { type?: string; data?: { message?: { content?: unknown } } } }> }>(
      'session.history', { sessionId, maxMessages: 200 }, 30000,
    )
    const lines: string[] = [`# 会话 ${sessionId}`]
    let count = 0
    for (const entry of data.events ?? []) {
      const ev = entry.event
      if (ev === undefined) continue
      const content = ev.data?.message?.content
      if (ev.type === 'user/message' && Array.isArray(content)) {
        const text = content.map((b) => (b as { text?: string }).text ?? '').join('').trim()
        if (text !== '') { lines.push(`\n## 👤 用户\n\n${text}`); count++ }
      } else if (ev.type === 'assistant/message' && Array.isArray(content)) {
        const text = content.map((b) => (b as { text?: string }).text ?? '').join('').trim()
        if (text !== '') { lines.push(`\n## 🤖 AI\n\n${text}`); count++ }
      }
    }
    return { markdown: lines.join('\n'), count }
  }

  private async cmdExport(sessionId: string): Promise<string> {
    if (!/^session-/.test(sessionId)) return '用法:导出 <会话id>'
    try {
      const { markdown, count } = await this.exportSession(sessionId)
      if (count === 0) return '该会话没有可导出的文本消息。'
      let path = '(未配置导出目录)'
      if (this.exportDir !== null) {
        const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
        const { join } = require('node:path') as typeof import('node:path')
        mkdirSync(this.exportDir, { recursive: true })
        path = join(this.exportDir, `session-${sessionId.slice(8, 16)}-${Date.now()}.md`)
        writeFileSync(path, markdown, 'utf8')
      }
      const preview = markdown.split('\n').filter((l) => !l.startsWith('#') && l.trim() !== '').slice(0, 6).join('\n')
      return `📄 已导出会话 ${sessionId}\n共 ${count} 条消息\n文件:${path}\n\n${preview.slice(0, 400)}`
    } catch (error) {
      return `导出失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  // ---- 用量统计 ----

  /** 从历史事件中按每次请求的模型累计今日 usage;仅扫描最近事件，避免长会话阻塞统计。 */
  private async sessionUsageByModel(sessionId: string, since: number): Promise<Array<{ provider: string; model: string; input: number; output: number; cache: number; calls: number }>> {
    try {
      const client = this.harness.client()
      const h = await client.rpc<{ events: Array<Record<string, unknown>> }>(
        'session.history', { sessionId, maxMessages: 20 }, 4000,
      )
      const byModel = new Map<string, { provider: string; model: string; input: number; output: number; cache: number; calls: number }>()
      let current: { provider: string; model: string } | null = null
      let currentIsToday = false
      for (const entry of h.events ?? []) {
        const ev = isRecord(entry.event) ? entry.event : entry
        const time = typeof ev.time === 'number' ? ev.time : 0
        const data = isRecord(ev.data) ? ev.data : ev
        const header = isRecord(data.header) ? data.header : isRecord(ev.header) ? ev.header : undefined
        const config = isRecord(header) ? header.config : undefined
        if (ev.type === 'request/header' && isRecord(config) &&
            typeof config.provider === 'string' && typeof config.model === 'string') {
          current = { provider: config.provider, model: config.model }
          currentIsToday = time >= since
          if (currentIsToday) {
            const key = `${current.provider}/${current.model}`
            const entry = byModel.get(key) ?? { ...current, input: 0, output: 0, cache: 0, calls: 0 }
            entry.calls += 1
            byModel.set(key, entry)
          }
          this.sessionModels.set(sessionId, current)
          continue
        }
        const chunk = isRecord(data.chunk) ? data.chunk : undefined
        const usage = ev.type === 'assistant/chunk' && isRecord(chunk) && chunk.type === 'usage' && isRecord(chunk.usage)
          ? chunk.usage
          : undefined
        if (usage !== undefined && current !== null && currentIsToday && time >= since) {
          const key = `${current.provider}/${current.model}`
          const entry = byModel.get(key) ?? { ...current, input: 0, output: 0, cache: 0, calls: 0 }
          entry.input += typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
          entry.output += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
          entry.cache += typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
          byModel.set(key, entry)
        }
      }
      return [...byModel.values()]
    } catch {
      // 历史不可用时由实时累计数据兜底。
      return []
    }
  }

  /** 用量与费用估算(结构化;命令端与 PWA 共用)。 */
  async usageReport(): Promise<{
    todaySessions: number
    totalSessions: number
    todayTurns: number
    totalTurns: number
    todayLlmMs: number
    totalLlmMs: number
    tokens: { input: number; output: number; cache: number; total: number }
    byModel: Array<{ provider: string; model: string; input: number; output: number; cache: number; calls: number }>
    cost: { input: number; output: number; cache: number; total: number }
    prices: { inputPerM: number; outputPerM: number; cachePerM: number; multiplier: number }
    todayList: Array<{ title: string; turns: number }>
  }> {
    const client = this.harness.client()
    const list = await client.rpc<{ items: Array<{ sessionId: string; updatedAt?: number; title?: string | null; projections?: { values?: { sessionStats?: { turns?: number; llmMs?: number } } } }> }>('session.list', {}, 20000)
    const items = list.items ?? []
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const today = items.filter((s) => (s.updatedAt ?? 0) >= todayStart)
    const all = items.filter((s) => (s.updatedAt ?? 0) > 0)
    const sumTurns = (arr: Array<{ projections?: { values?: { sessionStats?: { turns?: number } } } }>) =>
      arr.reduce((acc, s) => acc + (s.projections?.values?.sessionStats?.turns ?? 0), 0)
    const sumLlms = (arr: Array<{ projections?: { values?: { sessionStats?: { llmMs?: number } } } }>) =>
      arr.reduce((acc, s) => acc + (s.projections?.values?.sessionStats?.llmMs ?? 0), 0)
    // 实时 usage 在到达时已按当时模型拆分；不再把整个会话归到最后一次模型。
    const todayIds = new Set(today.map((s) => s.sessionId))
    let inTok = 0, outTok = 0, cacheTok = 0
    const byModel = new Map<string, { provider: string; model: string; input: number; output: number; cache: number; calls: number }>()
    for (const [sessionId, models] of this.tokenUsage) {
      if (!todayIds.has(sessionId)) continue
      for (const [key, rec] of models) {
        inTok += rec.input
        outTok += rec.output
        cacheTok += rec.cache
        const entry = byModel.get(key) ?? { provider: rec.provider, model: rec.model, input: 0, output: 0, cache: 0, calls: 0 }
        entry.input += rec.input
        entry.output += rec.output
        entry.cache += rec.cache
        entry.calls += rec.calls
        byModel.set(key, entry)
      }
    }
    // 重启前的会话只读取最近 20 个历史消息；无法快速恢复的历史不会阻塞报表。
    const historicalSessions = today.filter((s) => !this.tokenUsage.has(s.sessionId)).slice(0, 12)
    const historical = await Promise.all(historicalSessions.map((s) => this.sessionUsageByModel(s.sessionId, todayStart)))
    for (const models of historical) {
      for (const item of models) {
        inTok += item.input
        outTok += item.output
        cacheTok += item.cache
        const key = `${item.provider}/${item.model}`
        const entry = byModel.get(key) ?? { provider: item.provider, model: item.model, input: 0, output: 0, cache: 0, calls: 0 }
        entry.input += item.input
        entry.output += item.output
        entry.cache += item.cache
        entry.calls += item.calls
        byModel.set(key, entry)
      }
    }
    // 费用估算:Token × 官方单价 × 倍率。
    const usage = this.config?.get().usage
    const prices = usage === undefined
      ? { inputPerM: 2, outputPerM: 8, cachePerM: 0.5, multiplier: 1 }
      : { inputPerM: usage.inputPricePerM, outputPerM: usage.outputPricePerM, cachePerM: usage.cachePricePerM, multiplier: usage.multiplier }
    const calc = (tokens: number, pricePerM: number): number => tokens / 1e6 * pricePerM * prices.multiplier
    const cost = {
      input: calc(inTok, prices.inputPerM),
      output: calc(outTok, prices.outputPerM),
      cache: calc(cacheTok, prices.cachePerM),
      total: 0,
    }
    cost.total = cost.input + cost.output + cost.cache
    return {
      todaySessions: today.length,
      totalSessions: all.length,
      todayTurns: sumTurns(today),
      totalTurns: sumTurns(all),
      todayLlmMs: sumLlms(today),
      totalLlmMs: sumLlms(all),
      tokens: { input: inTok, output: outTok, cache: cacheTok, total: inTok + outTok + cacheTok },
      byModel: [...byModel.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output)),
      cost,
      prices,
      todayList: today.slice(0, 5).map((s) => ({
        title: (s.title ?? s.sessionId.slice(0, 12)).slice(0, 30),
        turns: s.projections?.values?.sessionStats?.turns ?? 0,
      })),
    }
  }

  /** 用量统计命令:今日会话/回合/耗时/Token/费用,按模型分组。 */
  private async cmdUsage(): Promise<string> {
    try {
      const r = await this.usageReport()
      const fmt = (ms: number) => ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${Math.round(ms / 1000)} 秒`
      const lines = [
        '📊 用量统计',
        `今日会话:${r.todaySessions} 个(总 ${r.totalSessions} 个)`,
        `今日回合:${r.todayTurns} 次(累计 ${r.totalTurns} 次)`,
        `今日模型耗时:${fmt(r.todayLlmMs)}(累计 ${fmt(r.totalLlmMs)})`,
      ]
      if (r.tokens.total > 0) {
        lines.push(`今日 Token:${(r.tokens.total / 1000).toFixed(1)}K(输入 ${(r.tokens.input / 1000).toFixed(1)}K / 输出 ${(r.tokens.output / 1000).toFixed(1)}K / 缓存 ${(r.tokens.cache / 1000).toFixed(1)}K)`)
        lines.push(`💰 费用估算:¥${r.cost.total.toFixed(3)}(倍率 ${r.prices.multiplier},官方价:输入 ¥${r.prices.inputPerM}/M / 输出 ¥${r.prices.outputPerM}/M / 缓存 ¥${r.prices.cachePerM}/M)`)
        if (r.byModel.length > 0) {
          lines.push('', '按模型(今日):')
          r.byModel.slice(0, 6).forEach((m) => {
            lines.push(`  ${m.provider}/${m.model}:${((m.input + m.output) / 1000).toFixed(1)}K Token,${m.calls} 次调用`)
          })
        }
      }
      if (r.todaySessions > 0) {
        lines.push('', '今日会话:')
        r.todayList.forEach((s) => {
          lines.push(`  ${s.title}(${s.turns} 回合)`)
        })
      }
      return lines.join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  // ---- 定时任务 ----

  /** 定时任务列表(供命令与 PWA 查看)。 */
  listScheduled(): Array<{ id: string; channel: string; description: string; when: string; nextAt: number }> {
    return (this.config?.get().scheduledTasks ?? []).map((t) => {
      const when = t.delay.kind === 'once' ? `一次性 ${Math.round(t.delay.delayMs / 60000)} 分钟后` : `每天 ${String(t.delay.hours).padStart(2, '0')}:${String(t.delay.minutes).padStart(2, '0')}`
      return { id: t.id, channel: t.channel, description: t.description, when, nextAt: t.nextAt }
    })
  }

  /** 添加定时任务(命令与 PWA 共用)。 */
  addScheduled(
    channel: string,
    userId: string,
    delay: { kind: 'once'; delayMs: number } | { kind: 'daily'; hours: number; minutes: number },
    description: string,
    pushTarget?: { scope: string; targetId: string },
  ): string {
    const tasks = this.config?.get().scheduledTasks ?? []
    const task = {
      id: `sched-${Date.now()}`,
      channel,
      userId,
      pushTarget,
      description,
      delay,
      nextAt: this.nextFireTime(delay, Date.now()),
    }
    this.saveTasks([...tasks, task])
    const when = delay.kind === 'once'
      ? `${Math.round(delay.delayMs / 60000)} 分钟后`
      : `每天 ${String(delay.hours).padStart(2, '0')}:${String(delay.minutes).padStart(2, '0')}`
    return `⏰ 定时任务已添加:${when} 执行「${description.slice(0, 50)}」`
  }

  /** 取消定时任务(命令与 PWA 共用);返回是否成功。 */
  removeScheduled(index: number): boolean {
    const tasks = this.config?.get().scheduledTasks ?? []
    if (index < 0 || index >= tasks.length) return false
    this.saveTasks(tasks.filter((_, i) => i !== index))
    return true
  }

  private async cmdSchedList(): Promise<string> {
    const tasks = this.config?.get().scheduledTasks ?? []
    if (tasks.length === 0) return '暂无定时任务。添加:定时 <表达式> <描述>(如:定时 10分钟 检查更新 / 定时 每天9:00 写日报)'
    return tasks.map((t, i) => {
      const when = t.delay.kind === 'once' ? `一次性 ${Math.round(t.delay.delayMs / 60000)} 分钟后` : `每天 ${String(t.delay.hours).padStart(2, '0')}:${String(t.delay.minutes).padStart(2, '0')}`
      return `${i + 1}. ${when} — ${t.description.slice(0, 40)}`
    }).join('\n')
  }

  private async cmdSchedRemove(index: number): Promise<string> {
    return this.removeScheduled(index) ? '已取消定时任务' : '编号无效,发「定时列表」查看'
  }

  private async cmdSchedAdd(
    key: string,
    delay: { kind: 'once'; delayMs: number } | { kind: 'daily'; hours: number; minutes: number },
    description: string,
    pushTarget?: { scope: string; targetId: string },
  ): Promise<string> {
    if (description === '') return '用法:定时 <表达式> <描述>(如:定时 10分钟 检查更新;定时 每天9:00 写日报)'
    const owner = this.ownerFromKey(key)
    const added = this.addScheduled(owner.channel, owner.userId, delay, description, pushTarget)
    return `${added}\n发「定时列表」查看,「取消定时 <编号>」取消`
  }

  private saveTasks(tasks: Array<{ id: string; channel: string; userId: string; pushTarget?: { scope: string; targetId: string } | null; description: string; delay: { kind: 'once'; delayMs: number } | { kind: 'daily'; hours: number; minutes: number }; nextAt: number }>): void {
    this.config?.update('scheduledTasks', tasks)
  }

  /** 计算下次触发时间。 */
  private nextFireTime(delay: { kind: 'once'; delayMs: number } | { kind: 'daily'; hours: number; minutes: number }, from: number): number {
    if (delay.kind === 'once') return from + delay.delayMs
    const next = new Date(from)
    next.setHours(delay.hours, delay.minutes, 0, 0)
    if (next.getTime() <= from) next.setDate(next.getDate() + 1)
    return next.getTime()
  }

  /** 定时器 tick(宿主每 30 秒调用):触发到期任务。 */
  async tickScheduled(): Promise<void> {
    const tasks = this.config?.get().scheduledTasks ?? []
    if (tasks.length === 0) return
    const now = Date.now()
    const due = tasks.filter((t) => t.nextAt <= now)
    if (due.length === 0) return
    const remaining = tasks.filter((t) => t.nextAt > now)
    for (const task of due) {
      // 触发通知 + 执行任务(助手模式;完成汇报走既有机制)。
      if (this.push !== null) {
        this.push(task.channel, task.userId, `⏰ 定时任务已触发:${task.description.slice(0, 60)}`, undefined, task.pushTarget ?? undefined)
      }
      const key = `${task.channel}:${task.userId}`
      // 定时任务按「添加时的身份」执行(无实时对话上下文,工作区走默认配置)。
      await this.cmdRun(key, key, task.description, task.pushTarget ?? undefined).catch(() => '')
      if (task.delay.kind === 'daily') {
        remaining.push({ ...task, nextAt: this.nextFireTime(task.delay, now) })
      }
    }
    this.saveTasks(remaining)
  }

  /** 每 30 秒 tick:到期失败的队列项按指数退避自动重试 + 启动排队任务。 */
  async tickQueue(): Promise<void> {
    const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue'] }
    if (typeof target?.taskQueue !== 'function') return
    const now = Date.now()
    const due = target.taskQueue().filter((item) => item.status === 'failed' && item.nextAttemptAt !== null && item.nextAttemptAt <= now)
    for (const entry of due) {
      const result = await this.retryQueueEntry(entry.id).catch(() => '')
      if (result !== '' && this.push !== null) {
        const owner = entry.sessionId === null ? undefined : this.sessionOwners.get(entry.sessionId)
        if (owner !== undefined && owner.pushTarget !== undefined) {
          this.push(owner.channel, owner.userId, `🔄 任务自动重试:${entry.description.slice(0, 60)}\n${result}`, undefined, owner.pushTarget)
        }
      }
    }
    await this.drainQueue()
  }

  /** 应用启动后恢复队列:上次运行中(被退出中断)的项标记为失败,等待手动重试。 */
  recoverQueue(): void {
    const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue']; upsertTaskQueueEntry?: ConfigStore['upsertTaskQueueEntry'] }
    if (typeof target?.taskQueue !== 'function' || typeof target?.upsertTaskQueueEntry !== 'function') return
    const now = Date.now()
    for (const entry of target.taskQueue()) {
      if (entry.status === 'running') {
        target.upsertTaskQueueEntry({ ...entry, status: 'failed', nextAttemptAt: null, error: '应用退出导致任务中断', updatedAt: now })
      }
    }
  }

  /** 队列列表(桌面端与 PWA 展示)。 */
  queueList(): Array<{ id: string; description: string; sessionId: string | null; status: string; attempts: number; maxAttempts: number; nextAttemptAt: number | null; error?: string; workspace: string | null; source: string; createdAt: number; updatedAt: number }> {
    const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue'] }
    return typeof target?.taskQueue === 'function' ? target.taskQueue() : []
  }

  /** 取消队列项:标记取消并停止对应会话。 */
  async cancelQueueEntry(id: string): Promise<string> {
    const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue']; upsertTaskQueueEntry?: ConfigStore['upsertTaskQueueEntry'] }
    if (typeof target?.taskQueue !== 'function' || typeof target?.upsertTaskQueueEntry !== 'function') return '队列不可用'
    const entry = target.taskQueue().find((item) => item.id === id)
    if (entry === undefined) return '未找到该队列项。'
    if (entry.sessionId !== null) {
      await this.harness.client().rpc('session.cancel', { sessionId: entry.sessionId }).catch(() => {})
    }
    target.upsertTaskQueueEntry({ ...entry, status: 'cancelled', nextAttemptAt: null, updatedAt: Date.now() })
    void this.drainQueue().catch(() => {})
    return `已取消:${entry.description.slice(0, 60)}`
  }

  /** 立即重试队列项(手动或自动)。 */
  async retryQueueEntry(id: string): Promise<string> {
    const target = this.config as ConfigStore & { taskQueue?: ConfigStore['taskQueue']; upsertTaskQueueEntry?: ConfigStore['upsertTaskQueueEntry'] }
    if (typeof target?.taskQueue !== 'function' || typeof target?.upsertTaskQueueEntry !== 'function') return '队列不可用'
    const entry = target.taskQueue().find((item) => item.id === id)
    if (entry === undefined) return '未找到该队列项。'
    if (entry.status !== 'failed' && entry.status !== 'cancelled') return '只有失败或已取消的任务可以重试。'
    if (entry.sessionId === null) return '该队列项没有关联会话,无法重试。'
    if (entry.attempts >= entry.maxAttempts && entry.status === 'failed') return `已达到最大重试次数(${entry.maxAttempts}),不再自动重试。`
    // 串行执行:已有任务运行中时,重试也进入排队。
    if (target.taskQueue().some((item) => item.status === 'running' && item.id !== id)) {
      target.upsertTaskQueueEntry({ ...entry, status: 'queued', nextAttemptAt: null, updatedAt: Date.now() })
      return '已有任务在运行,重试已排队,将串行执行。'
    }
    target.upsertTaskQueueEntry({ ...entry, status: 'running', nextAttemptAt: null, updatedAt: Date.now() })
    try {
      await this.harness.client().rpc('session.prompt', {
        sessionId: entry.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: this.withModePrompt('task', this.withWorkspaceMemory(entry.workspace, entry.description)) }],
      })
      this.appendAudit({ time: Date.now(), type: 'task.retried', sessionId: entry.sessionId ?? undefined, activityId: `activity-${entry.id.replace(/^queue-/, '')}`, detail: `重试任务:${entry.description.slice(0, 120)}` })
      return `已重新执行:${entry.description.slice(0, 60)}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      target.upsertTaskQueueEntry({ ...entry, status: 'failed', error: message.slice(0, 500), nextAttemptAt: null, updatedAt: Date.now() })
      return `重试失败:${message}`
    }
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
      const data = await client.rpc<HistoryEventLike & { events?: HistoryEventLike[] }>('session.history', { sessionId, maxMessages: 2 }, 30000)
      const events = data.events ?? []
      const userTexts: string[] = []
      for (const entry of events) {
        const type = entry.event?.type
        const content = entry.event?.data?.message?.content
        if (type === 'user/message' && Array.isArray(content)) {
          const text = content.map((b) => (b as { text?: string }).text ?? '').join('')
          if (text.trim() !== '') userTexts.push(text)
        }
      }
      const lines: string[] = [`会话 ${sessionId}`]
      if (userTexts.length > 0) lines.push(`问:${userTexts[userTexts.length - 1].slice(0, 120)}`)
      const answer = deliveredText(events, 600)
      if (answer !== '') lines.push(`答:${answer}`)
      else lines.push('(尚无回复)')
      return lines.join('\n')
    } catch (error) {
      return `读取失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  // ---- 现场播报(任务过程可见性) ----

  /** 任务会话启动时开启现场播报(仅支持主动推送的通道会话;群聊默认静音防刷屏)。 */
  private startLiveView(sessionId: string, enabledByDefault: boolean): void {
    if (this.liveViews.has(sessionId)) return
    const live: LiveView = { tool: '', text: '', chunkBuf: '', changed: false, broadcast: enabledByDefault, startedAt: Date.now(), timer: null }
    this.liveViews.set(sessionId, live)
    live.timer = setInterval(() => this.tickLiveView(sessionId), LIVE_VIEW_INTERVAL_MS)
  }

  /** 回合结束(含失败/TRANSPORT 重试)时停止播报;后续新回合懒重建。 */
  private stopLiveView(sessionId: string): void {
    const live = this.liveViews.get(sessionId)
    if (live === undefined) return
    if (live.timer !== null) clearInterval(live.timer)
    this.liveViews.delete(sessionId)
  }

  /** 播报 tick:有新内容且未静音时推一条合并摘要;无人认领/超长运行自动收摊。 */
  private tickLiveView(sessionId: string): void {
    const live = this.liveViews.get(sessionId)
    if (live === undefined) return
    if (Date.now() - live.startedAt > 45 * 60 * 1000) {
      this.stopLiveView(sessionId)
      return
    }
    if (!live.changed || !live.broadcast || this.push === null) return
    const owner = this.sessionOwners.get(sessionId)
    if (owner === undefined || owner.pushTarget === undefined) {
      this.stopLiveView(sessionId)
      return
    }
    const lines = [`📡 现场播报 · 已运行 ${fmtDuration(Date.now() - live.startedAt)}`]
    if (live.tool !== '') lines.push(`🔧 ${live.tool}`)
    // 交付文本以 chunk 流为准(chunk 才是实际回复;assistant/message 可能只是推理)。
    const showText = live.chunkBuf.replace(/\s+/g, ' ').trim() !== ''
      ? live.chunkBuf.replace(/\s+/g, ' ').trim().slice(-400)
      : live.text
    if (showText !== '') lines.push(`💬 ${showText}`)
    this.push(owner.channel, owner.userId, lines.join('\n'), undefined, owner.pushTarget)
    live.changed = false
  }

  /** 任务会话事件 → 播报素材:工具动作、助手文本(chunk 累积 + 整段定稿);turn/end 停止。 */
  private accumulateLive(sessionId: string, ev: Record<string, unknown>): void {
    if (ev.type === 'turn/end') {
      this.stopLiveView(sessionId)
      return
    }
    let live = this.liveViews.get(sessionId)
    if (live === undefined) {
      // 新回合懒重建(TRANSPORT 重试 / 排队任务重跑 / 助手模式工作回合)。
      if (this.push === null) return
      live = { tool: '', text: '', chunkBuf: '', changed: false, broadcast: false, startedAt: Date.now(), timer: null }
      this.liveViews.set(sessionId, live)
    }
    if (live.timer === null) {
      live.timer = setInterval(() => this.tickLiveView(sessionId), LIVE_VIEW_INTERVAL_MS)
    }
    const data = isRecord(ev.data) ? ev.data : {}
    if (ev.type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : '工具'
      const args = typeof data.arguments === 'string' ? data.arguments : ''
      const brief = args.replace(/\s+/g, ' ').trim().slice(0, 60)
      live.tool = brief === '' ? name : `${name} ${brief}`
      live.changed = true
      return
    }
    if (ev.type === 'tool/result') {
      if (data.error !== undefined && live.tool !== '' && !live.tool.startsWith('❌')) {
        live.tool = `❌ ${live.tool} → 失败`
        live.changed = true
      }
      return
    }
    if (ev.type === 'assistant/chunk') {
      const chunk = isRecord(data.chunk) ? data.chunk : null
      if (chunk !== null && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        live.chunkBuf += chunk.text
        if (live.chunkBuf.length > 2000) live.chunkBuf = live.chunkBuf.slice(-2000)
        live.changed = true
      }
      return
    }
    if (ev.type === 'assistant/message') {
      const message = isRecord(data.message) ? data.message : {}
      const parts = Array.isArray(message.content) ? message.content : []
      const text = parts.map((b) => isRecord(b) && typeof b.text === 'string' ? b.text : '').join('')
      // 推理型模型的 message 可能是思考过程;只有无 chunk 流(非流式后端)才当交付文本。
      if (live.chunkBuf === '' && text.trim() !== '') {
        live.text = text.replace(/\s+/g, ' ').trim().slice(0, 500)
        live.changed = true
      }
    }
  }

  /** 播报开关:播报 [会话id] / 静音 [会话id](作用于该用户运行中的任务会话)。 */
  private cmdBroadcast(channel: string, userId: string, sessionId: string, on: boolean): string {
    let count = 0
    for (const [sid, live] of this.liveViews) {
      if (sessionId !== '' && sid !== sessionId) continue
      const owner = this.sessionOwners.get(sid)
      if (owner === undefined || owner.channel !== channel || normUserId(owner.userId) !== normUserId(userId)) continue
      live.broadcast = on
      if (on) live.changed = true
      count += 1
    }
    if (count === 0) {
      return on
        ? '没有正在运行的任务可开启播报(默认静默,任务运行中发「播报」开启 25 秒现场进展)'
        : '当前没有正在运行的任务,无需静音'
    }
    return on
      ? `🔊 已开启现场播报(${count} 个运行中的会话,每 25 秒合并推送最新进展;发「静音」关闭)`
      : `🔇 已静音(${count} 个运行中的会话),恢复默认静默`
  }

  /** 任务/定时等「工作指令」仅限私聊:群聊拒绝,防刷屏与身份混淆。 */
  private taskScopeGuard(pushTarget?: { scope: string; targetId: string }): string | null {
    return pushTarget !== undefined && pushTarget.scope === 'group'
      ? '任务/定时等工作指令仅支持私聊:请私聊机器人使用(防群聊刷屏与身份混淆);群内对话/查询不受影响。'
      : null
  }

  /** 任务进展:阶段(思考/工具/输出/完成)+ 统计 + 最近动作与输出 + 产物提示。 */
  private async cmdProgress(sessionId: string): Promise<string> {
    if (!/^session-/.test(sessionId)) return '请提供完整的会话 id(以 session- 开头)'
    const client = this.harness.client()
    try {
      const [list, data] = await Promise.all([
        client.rpc<{ items: Array<{ sessionId: string; running?: boolean; title?: string | null }> }>('session.list', {}, 20000),
        client.rpc<{ events: Array<{ event?: { type?: string; seq?: number; data?: { message?: { content?: unknown }; name?: unknown; arguments?: unknown; error?: unknown; reason?: unknown } } }> }>('session.history', { sessionId, maxMessages: 8 }, 30000),
      ])
      const meta = (list.items ?? []).find((s) => s.sessionId === sessionId)
      const events = data.events ?? []
      const running = meta?.running === true
      const toolCalls = events.filter((e) => e.event?.type === 'tool/call').length
      const toolFails = events.filter((e) => e.event?.type === 'tool/result' && e.event.data?.error !== undefined).length
      const live = this.liveViews.get(sessionId)
      const liveTool = live !== undefined && live.tool !== '' ? live.tool : ''
      // 阶段判定:运行中按最近动向(工具/输出/思考)细分;已结束按 turn/end reason 定性。
      let phase = ''
      let failed = false
      const endEv = [...events].reverse().find((e) => e.event?.type === 'turn/end')
      if (endEv !== undefined && !running) {
        const reason = endEv.event?.data?.reason
        failed = isRecord(reason) && reason.kind === 'error'
        phase = failed ? '❌ 已失败' : '✅ 已完成'
      } else if (running && liveTool !== '') {
        phase = `🔧 正在调用工具:${liveTool.slice(0, 130)}`
      } else if (running) {
        const tailTypes = events.slice(-4).map((e) => e.event?.type)
        const outputting = tailTypes.some((t) => t === 'assistant/chunk' || t === 'assistant/message')
        phase = outputting ? '💬 正在输出…' : '🤔 思考中…'
      } else {
        phase = '⏸ 空闲'
      }
      // 产物提示:最近一次成功的"写/执行类"工具调用。
      let product = ''
      const WRITEISH = /write|edit|save|create|mkdir|patch|apply|bash|exec|run|mv|cp|tar|npm|pnpm|git/i
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]?.event
        if (ev?.type === 'tool/result' && ev.data?.error === undefined) {
          const call = events[i - 1]?.event
          if (call?.type === 'tool/call' && typeof call.data?.name === 'string' && WRITEISH.test(call.data.name)) {
            const args = typeof call.data.arguments === 'string' ? call.data.arguments.replace(/\s+/g, ' ').trim().slice(0, 90) : ''
            product = `📦 最近完成:${call.data.name}${args !== '' ? ` ${args}` : ''}`
            break
          }
        }
      }
      const lastText = deliveredText(events, 200) || '(暂无输出)'
      const liveText = live !== undefined && live.text !== '' ? live.text : ''
      const lines = [
        `会话 ${sessionId.slice(0, 20)}…`,
        phase,
        `工具调用 ${toolCalls} 次${toolFails > 0 ? `,失败 ${toolFails} 次` : ''}`,
        ...(liveTool !== '' && !phase.includes('正在调用') ? [`最近工具:${liveTool.slice(0, 120)}`] : []),
        ...(product !== '' ? [product] : []),
        `最新输出: ${liveText !== '' ? liveText.slice(0, 300) : lastText}`,
        live !== undefined ? `播报:${live.broadcast ? '开(发「静音」关闭)' : '关(发「播报」开启)'}` : '',
      ].filter((line) => line !== '')
      return lines.join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdRetry(key: string, ctxKey: string, taskId: string, pushTarget?: { scope: string; targetId: string }): Promise<string> {
    // 优先命中调度队列(失败/取消项可立即重试,保留退避状态)。
    const queueEntry = this.queueList().find((item) => item.id === taskId || item.sessionId === taskId)
    if (queueEntry !== undefined) {
      if (queueEntry.status !== 'failed' && queueEntry.status !== 'cancelled') return '该任务未失败或未取消,无需重试。'
      return this.retryQueueEntry(queueEntry.id)
    }
    if (this.config === undefined) return '任务记录不可用'
    const task = (this.config.get().taskHistory ?? []).find((item) => item.id === taskId || item.sessionId === taskId)
    if (task === undefined) return `未找到任务「${taskId}」,可从桌面端任务记录查看 ID`
    if (task.status !== 'failed' && task.status !== 'cancelled') return '只有失败或已取消的任务可以重试。'
    return this.cmdRun(key, ctxKey, task.description, pushTarget)
  }

  private async cmdRun(
    key: string,
    ctxKey: string,
    description: string,
    pushTarget?: { scope: string; targetId: string },
  ): Promise<string> {
    if (description === '') return '任务描述不能为空,示例:任务 分析这个仓库的架构'
    const client = this.harness.client()
    const parsed = parseTaskOptions(description)
    // 「任务 新:描述」= 强制另起一个新任务会话(默认任务会话是复用的)。
    const forceNewSession = /^新:/.test(parsed.description)
    const taskText = forceNewSession ? parsed.description.replace(/^新:\s*/, '') : parsed.description
    if (taskText === '') return '任务描述不能为空'
    try {
      let workspaceId: string | null = null
      let cwd = parsed.cwd
      // 任务未指定工作区/目录时,优先沿用当前对话上下文的工作区(进入过工作区再发任务,
      // 任务就落在那个工作区);否则回退到 QQ 配置的默认工作区/目录。
      if (workspaceId === null && cwd === null) {
        const ctx = this.chatContexts.get(ctxKey)
        if (ctx !== undefined && ctx.workspace !== null && ctx.workspace !== '') {
          if (/[\\/]/.test(ctx.workspace)) cwd = ctx.workspace
          else workspaceId = ctx.workspace
        }
      }
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
      // 串行执行:已有任务运行中时,新任务入队等待。
      if (this.queueList().some((item) => item.status === 'running')) {
        this.enqueueQueuedTask(key, taskText, pushTarget, cwd ?? workspaceId)
        return '已有任务在运行,新任务已排队,将串行执行。\n可在桌面端「工作台 → 任务队列」查看或取消。'
      }
      // 无工作区的任务合并到"默认任务会话"(每用户一条,复用;「任务 新:」另起)。
      // 会话保持独立可避免历史列表被一次性任务刷屏,也让任务有持续上下文。
      let sessionId: string
      const broadcastNote = pushTarget === undefined
        ? ''
        : '\n💡 推送原则:机器人只在 进入/查询/审批/完成/失败 时推送;想看任务过程发「播报」开启现场进展,或「进展 <会话id>」随时查看'
      if (workspaceId === null && cwd === null) {
        const existing = this.defaultTaskSessions.get(key)
        if (existing !== undefined && !forceNewSession) {
          sessionId = existing
        } else {
          const created = await client.rpc<{ sessionId: string }>('session.create', {})
          sessionId = created.sessionId
          if (!forceNewSession) this.defaultTaskSessions.set(key, sessionId)
        }
      } else {
        const payload: Record<string, unknown> = {}
        if (workspaceId !== null) payload.workspaceId = workspaceId
        else if (cwd !== null) payload.cwd = cwd
        const created = await client.rpc<{ sessionId: string }>('session.create', payload)
        sessionId = created.sessionId
      }
      if (!this.sessionOwners.has(sessionId)) {
        this.sessionOwners.set(sessionId, { ...this.ownerFromKey(key), pushTarget, kind: 'task' })
      } else {
        const owner = this.sessionOwners.get(sessionId)!
        if (pushTarget !== undefined) owner.pushTarget = pushTarget
      }
      this.taskDescriptions.set(sessionId, taskText)
      if (pushTarget !== undefined) this.startLiveView(sessionId, false)
      this.recordTask({ description: taskText, sessionId, workspace: cwd ?? workspaceId, status: 'running' })
      this.enqueueTaskRun(taskText, sessionId, cwd ?? workspaceId)
      await client.rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: this.withModePrompt('task', this.withWorkspaceMemory(cwd, taskText)) }],
      })
      const mergedPath = workspaceId === null && cwd === null
      const extra = mergedPath
        ? `${broadcastNote}\n(无工作区任务自动归入本默认任务会话并复用;发「任务 新:描述」可另起一段)`.trim()
        : broadcastNote
      return `任务已启动 ✓\n会话: ${sessionId}\n描述: ${taskText.slice(0, 80)}${extra}\n发送「进展 ${sessionId}」查看详情`
    } catch (error) {
      return `启动失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 通道级默认工作区/目录(QQ 配置;其他通道留空)。 */
  defaultTarget = ''

  /**
   * 进入对话模式:
   * - target 为空 = 默认纯对话(朋友模式):同一用户只保留一条默认线程(配置持久化),
   *   已存在则复用,只有「新对话」才重开;任务/工作区等穿插不会打断它。
   * - target = 工作区名/目录 [编号|新]:进入该工作区(助手模式);不带编号且已有会话时
   *   先列出会话摘要供选择(「进入 <工作区> <编号>」继续,「进入 <工作区> 新」新建)。
   * ctxKey 定位对话上下文(私聊/群各自独立),key 是发起者身份(会话归属)。
   */
  private async cmdEnter(
    ctxKey: string,
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
      let forceNew = false
      if (target === '') {
        label = '(纯对话,不绑定工作区)'
        // 默认线程:内存中已激活 → 复用;配置里有 → 恢复;否则新建。
        const existing = this.chatContexts.get(ctxKey)
        if (existing !== undefined) {
          return [
            `已在对话模式 ✓(会话 ${existing.sessionId},继续原对话)`,
            '现在直接发消息即可对话,发送「退出」结束对话模式。',
          ].join('\n')
        }
        const saved = this.defaultChatSession(ctxKey)
        if (saved !== '') {
          this.chatContexts.set(ctxKey, { sessionId: saved, label, workspace: null })
          return [
            `已在对话模式 ✓(会话 ${saved},继续原对话)`,
            '现在直接发消息即可对话;发「新对话」可另开一段。',
          ].join('\n')
        }
      } else {
        // 支持「工作区名 编号」选择已有会话;「工作区名 新」强制新建。
        const parts = target.trim().split(/\s+/)
        const last = parts[parts.length - 1]
        if (/^\d+$/.test(last)) {
          sessionIndex = Number(last) - 1
          target = parts.slice(0, -1).join(' ')
          label = target
        } else if (last === '新' || last === 'new' || last === '新建') {
          forceNew = true
          target = parts.slice(0, -1).join(' ')
          label = target
        }
        if (/[\\/]/.test(target)) {
          cwd = target
        } else {
          const wsData = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string; sessionIds?: string[] }>; archivedSessionIds?: string[] }>('workspace.list')
          const found = (wsData.items ?? []).find((w) => w.title === target || w.workspaceId === target || w.path === target)
          if (found === undefined) {
            return `未找到工作区「${target}」,发送「工作区」查看列表(或直接「进入」开始纯对话)`
          }
          workspaceId = found.workspaceId
          cwd = found.path ?? null
          // 同一上下文已在该工作区:直接复用,不新建。
          const existing = this.chatContexts.get(ctxKey)
          if (!forceNew && existing !== undefined && sessionIndex < 0 && existing.workspace === (cwd ?? workspaceId)) {
            return `已在该工作区「${target}」对话中 ✓(会话 ${existing.sessionId})\n直接发消息即可;「会话」切换,「退出」结束。`
          }
          // 归属判定:workspace.list 的 sessionIds ∪ cwd 落在工作区路径下的会话(排除空会话/已归档)。
          const sessions = await this.sessionsOfWorkspace(client, found, new Set(wsData.archivedSessionIds ?? []))
          if (!forceNew && sessionIndex < 0 && sessions.length > 0) {
            return await this.workspaceSessionPicker(client, target, sessions)
          }
          if (sessionIndex >= 0 && sessions[sessionIndex] !== undefined) {
            // 选择已有会话:直接切换,不新建。
            const chosen = sessions[sessionIndex]
            this.sessionOwners.set(chosen.sessionId, { ...this.ownerFromKey(key), pushTarget, kind: 'task' })
            this.chatContexts.set(ctxKey, { sessionId: chosen.sessionId, label: target, workspace: cwd ?? workspaceId })
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
      this.chatContexts.set(ctxKey, { sessionId: created.sessionId, label, workspace: cwd ?? workspaceId })
      this.persistChat(ctxKey)
      const lines = target === ''
        ? [
            '已进入对话模式 ✓(纯对话,不绑定工作区)',
            `会话: ${created.sessionId}`,
            '本会话将作为你的默认对话保留(「新对话」可另开);发任意消息即可聊天。',
          ]
        : [
            `已进入工作区「${target}」对话模式 ✓(新建会话)`,
            `会话: ${created.sessionId}`,
            '现在直接发消息即可对话;「会话」返回工作区选择,「退出」结束对话模式。',
          ]
      return lines.join('\n')
    } catch (error) {
      return `进入失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 工作区会话归属:workspace.list 的 sessionIds ∪ cwd 位于工作区路径下的会话;
   * 排除空会话(blank)、子代理(origin)与已归档;运行中优先,再按最近更新排序。
   * 说明:harness 的 workspace.list.items[].sessions 恒为空数组,不能作为数据源。
   */
  private async sessionsOfWorkspace(
    client: { rpc: <T>(method: string, payload: unknown, timeoutMs?: number) => Promise<T> },
    workspace: { workspaceId: string; path?: string; sessionIds?: string[] },
    archived: Set<string>,
  ): Promise<Array<{ sessionId: string; title?: string | null; running?: boolean; updatedAt?: number }>> {
    let items: Array<{ sessionId: string; cwd?: string; blank?: boolean; origin?: string; running?: boolean; updatedAt?: number; title?: string | null }> = []
    try {
      const list = await client.rpc<{ items: Array<{ sessionId: string; cwd?: string; blank?: boolean; origin?: string; running?: boolean; updatedAt?: number; title?: string | null }> }>('session.list', {}, 20000)
      items = list.items ?? []
    } catch {
      return []
    }
    const pathKey = (workspace.path ?? '').replace(/\\/g, '/').toLowerCase()
    const ids = new Set(workspace.sessionIds ?? [])
    return items.filter((s) => {
      if (s.blank === true || archived.has(s.sessionId)) return false
      if (typeof s.origin === 'string' && s.origin !== '') return false
      if (ids.has(s.sessionId)) return true
      const c = (s.cwd ?? '').replace(/\\/g, '/').toLowerCase()
      return pathKey !== '' && (c === pathKey || c.startsWith(`${pathKey}/`))
    }).sort((a, b) =>
      ((b.running === true ? 1 : 0) - (a.running === true ? 1 : 0)) ||
      ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)) ||
      (a.sessionId < b.sessionId ? -1 : 1),
    )
  }

  /** 工作区会话选择器:带摘要的编号列表(摘要抓取失败时降级为标题;列表即选择索引,顺序与「进入 ws N」一致)。 */
  private async workspaceSessionPicker(
    client: { rpc: <T>(method: string, payload: unknown, timeoutMs?: number) => Promise<T> },
    target: string,
    sessions: Array<{ sessionId: string; title?: string | null; running?: boolean; updatedAt?: number }>,
  ): Promise<string> {
    try {
      const pick = sessions.slice(0, 6)
      const previews = await Promise.all(pick.map(async (s) => {
        try {
          const hist = await client.rpc<{ events: HistoryEventLike[] }>('session.history', { sessionId: s.sessionId, maxMessages: 3 }, 10000)
          return deliveredText(hist.events ?? [], 64)
        } catch {
          return ''
        }
      }))
      const lines = [`📁 工作区「${target}」的会话(${sessions.length}):`]
      pick.forEach((s, i) => {
        const mark = s.running ? '▶' : '⏸'
        const ago = typeof s.updatedAt === 'number' ? `(${fmtAgo(s.updatedAt)})` : ''
        const title = (s.title ?? '新会话').slice(0, 24)
        lines.push(`${i + 1}. ${mark} ${title} ${ago}`)
        if (previews[i] !== '') lines.push(`   💬 ${previews[i]}`)
      })
      if (sessions.length > pick.length) lines.push(`   …还有 ${sessions.length - pick.length} 个(按最近更新排序)`)
      lines.push(`回复「进入 ${target} <编号>」继续对应会话;「进入 ${target} 新」新建`)
      return lines.join('\n')
    } catch (error) {
      return `读取工作区会话失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private cmdExit(ctxKey: string): string {
    const ctx = this.chatContexts.get(ctxKey)
    if (ctx === undefined) return '当前不在对话模式。'
    const isPureChat = ctx.label.startsWith('(纯对话')
    this.chatContexts.delete(ctxKey)
    if (isPureChat) {
      // 默认线程持久化在配置里:退出只离开"激活态",下次消息自动回到同一会话。
      return `已退出对话模式。默认对话 ${ctx.sessionId.slice(0, 20)}… 保留;下次发消息自动回到本对话(发「新对话」另开一段)。`
    }
    return `已退出工作区「${ctx.label}」对话模式。会话 ${ctx.sessionId.slice(0, 20)}… 保留;普通消息会回到你的默认对话(发「进入 <工作区名>」再次进入)。`
  }

  private async cmdChatMessage(
    ctxKey: string,
    key: string,
    text: string,
    pushTarget?: { scope: string; targetId: string },
    image?: { mime: string; data: string },
  ): Promise<string> {
    const ctx = this.chatContexts.get(ctxKey)
    if (ctx === undefined) return this.fullHelp()
    const client = this.harness.client()
    try {
      let owner = this.sessionOwners.get(ctx.sessionId)
      // 工作区会话 = 助手模式提示词;纯对话 = 朋友模式提示词。
      const mode = owner !== undefined && owner.kind === 'task' ? 'task' : 'chat'
      const parts: Array<{ type: string; text?: string; mediaType?: string; data?: string }> = []
      if (text !== '') parts.push({ type: 'text', text: this.withModePrompt(mode, text) })
      if (image !== undefined) parts.push({ type: 'image', mediaType: image.mime, data: image.data })
      await client.rpc('session.prompt', {
        sessionId: ctx.sessionId,
        mode: 'queue',
        content: parts,
      })
      // 记录提示内容:TRANSPORT 流中断时自动重试(重放)用。
      this.chatPrompts.set(ctx.sessionId, { parts, ts: Date.now() })
      if (this.chatPrompts.size > 64) {
        const oldest = this.chatPrompts.keys().next().value as string | undefined
        if (oldest !== undefined) this.chatPrompts.delete(oldest)
      }
      // 注册回复推送:回合结束后把 agent 的回复主动推给发起者(对话体验)。
      // 重启后恢复的对话会话可能没有归属记录,这里补登记。
      if (owner === undefined) {
        owner = { ...this.ownerFromKey(key), pushTarget, kind: 'chat' }
        this.sessionOwners.set(ctx.sessionId, owner)
      } else {
        // 每次消息都刷新推送目标:QQ 群/私聊回复的 msg_id 会过期,必须用最近一条。
        if (pushTarget !== undefined) owner.pushTarget = pushTarget
        else if (owner.pushTarget === undefined) owner.pushTarget = pushTarget
      }
      // 纯对话与工作区助手对话都注册回复推送;队列任务不注册(走任务完成汇报)。
      const isQueueTask = this.taskDescriptions.has(ctx.sessionId)
      if (!isQueueTask) {
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
          createdAt: Date.now(),
        }
        this.pendingApprovals.set(`${sessionId}:${approvalId}`, pending)
        this.appendAudit({ time: pending.createdAt, type: 'approval.requested', sessionId, detail: `${pending.toolName}${pending.reason === undefined ? '' : `:${pending.reason.slice(0, 180)}`}` })
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
        if (sessionId !== '') {
          this.pendingApprovals.delete(`${sessionId}:${approvalId}`)
          this.appendAudit({ time: Date.now(), type: 'approval.resolved', sessionId, detail: `审批已处理:${approvalId}` })
        }
        break
      }
      case 'question/requested': {
        const sessionId = String(payload.sessionId ?? '')
        const questions = Array.isArray(payload.questions) ? (payload.questions as AskUserQuestionItem[]) : []
        if (sessionId === '' || questions.length === 0) return
        const createdAt = Date.now()
        this.pendingQuestions.set(sessionId, {
          rpcId: frame.rpcId,
          sessionId,
          questions,
          answers: new Map(),
          createdAt,
        })
        this.appendAudit({ time: createdAt, type: 'question.requested', sessionId, detail: questions.map((item) => item.question).join('；').slice(0, 240) })
        this.notifyOwner(sessionId, this.formatQuestion(sessionId, questions, 0), this.questionMeta(sessionId, questions))
        break
      }
      case 'question/resolved': {
        const sessionId = String(payload.sessionId ?? '')
        if (sessionId !== '') {
          this.pendingQuestions.delete(sessionId)
          this.appendAudit({ time: Date.now(), type: 'question.resolved', sessionId, detail: '提问已回答' })
        }
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

  /** 会话事件:任务汇报 + 对话回复(流式/整段)+ Token 累计 + 模型记录。 */
  private handleSessionEvent(payload: Record<string, unknown>): void {
    const sessionId = String(payload.sessionId ?? '')
    const owner = this.sessionOwners.get(sessionId)
    if (!isRecord(payload.event)) return
    // 模型记录(request/header 事件携带本次请求的 provider/model,用于按模型统计)。
    if (payload.event.type === 'request/header' && isRecord(payload.event.data) && isRecord(payload.event.data.header)) {
      const config = payload.event.data.header.config
      if (isRecord(config) && typeof config.provider === 'string' && typeof config.model === 'string') {
        const model = { provider: config.provider, model: config.model }
        this.sessionModels.set(sessionId, model)
        const models = this.tokenUsage.get(sessionId) ?? new Map()
        const key = `${model.provider}/${model.model}`
        const usage = models.get(key) ?? { ...model, input: 0, output: 0, cache: 0, calls: 0 }
        usage.calls += 1
        models.set(key, usage)
        this.tokenUsage.set(sessionId, models)
      }
    }
    // Token 累计:usage 到达时归入当前 request/header 的模型桶。
    if (payload.event.type === 'assistant/chunk' && isRecord(payload.event.data) && isRecord(payload.event.data.chunk)) {
      const chunk = payload.event.data.chunk
      if (chunk.type === 'usage' && isRecord(chunk.usage)) {
        const u = chunk.usage
        const model = this.sessionModels.get(sessionId) ?? { provider: '未知', model: '未知' }
        const models = this.tokenUsage.get(sessionId) ?? new Map()
        const key = `${model.provider}/${model.model}`
        const usage = models.get(key) ?? { ...model, input: 0, output: 0, cache: 0, calls: 0 }
        usage.input += typeof u.inputTokens === 'number' ? u.inputTokens : 0
        usage.output += typeof u.outputTokens === 'number' ? u.outputTokens : 0
        usage.cache += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        models.set(key, usage)
        this.tokenUsage.set(sessionId, models)
      }
    }
    if (owner === undefined) return
    // 纯对话(kind chat)与「工作区助手对话」(kind task 但非队列任务)统一按聊天回合处理:
    // chunk 流式/整段缓冲,回合结束推送回复;队列任务走任务汇报与队列同步。
    const isQueueTask = this.taskDescriptions.has(sessionId)
    if (owner.kind === 'chat' || !isQueueTask) {
      if (!this.handleChatTransport(sessionId, owner, payload.event)) {
        this.handleChatEvent(sessionId, owner, payload.event)
      }
      return
    }
    // 队列任务:现场播报素材(工具动作 + 助手文本);回合结束自动停止。
    if (owner.pushTarget !== undefined) this.accumulateLive(sessionId, payload.event)
    if (payload.event.type !== 'turn/end') return
    const failure = turnEndFailure(payload.event)
    const failed = failure !== null
    const message = failure?.message ?? ''
    const isTransport = failure?.isTransport ?? false
    // TRANSPORT 中断(模型流错误,如中转站读取超时/流式通道不稳):同会话自动重试一次。
    if (isTransport && !this.retriedTransports.has(sessionId)) {
      this.retriedTransports.add(sessionId)
      const description = this.taskDescriptions.get(sessionId)
      if (description !== undefined && this.push !== null) {
        this.push(owner.channel, owner.userId, '⚠️ 任务因模型流中断,正在自动重试一次…(仍失败常见于中转站:上游读取超时/流式不稳/风控截断)', undefined, owner.pushTarget)
        void this.harness.client().rpc('session.prompt', {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: this.withModePrompt('task', description) }],
        }).catch(() => {})
        return
      }
    }
    // 队列状态同步:成功完成也必须落库并放行队列(否则队列会一直卡「运行中」,后续任务全部积压)。
    const queueDescription = this.taskDescriptions.get(sessionId)
    if (queueDescription !== undefined) {
      const queueNow = Date.now()
      const prevHistory = (this.config?.get().taskHistory ?? []).find((item) => item.sessionId === sessionId)
      this.syncQueueFromTask(
        {
          id: prevHistory?.id ?? `task-${queueNow}-${Math.random().toString(36).slice(2, 8)}`,
          description: queueDescription,
          sessionId,
          status: failed ? 'failed' : 'completed',
          attempts: prevHistory?.attempts ?? 1,
          ...(failed && message !== '' ? { error: message } : {}),
        },
        { sessionId, status: failed ? 'failed' : 'completed', ...(failed && message !== '' ? { error: message } : {}) },
        queueNow,
      )
    }
    if (!this.reportChannels.has(owner.channel)) {
      void this.drainQueue().catch(() => {})
      return
    }
    // 去重:同一会话同一描述任务的完成/失败汇报 5 分钟内只推一次
    // (默认任务会话会被多个不同任务复用,去重键必须带描述,否则后一个任务的 ✅ 会被吞)。
    const now = Date.now()
    const reportKey = `${sessionId}|${(queueDescription ?? '').slice(0, 60)}`
    const record = this.lastTurnReports.get(reportKey) ?? { done: 0, fail: 0 }
    const last = failed ? record.fail : record.done
    if (now - last < 5 * 60 * 1000) return
    if (failed) record.fail = now
    else record.done = now
    this.lastTurnReports.set(reportKey, record)
    if (this.lastTurnReports.size > 300) {
      const oldest = this.lastTurnReports.keys().next().value as string | undefined
      if (oldest !== undefined) this.lastTurnReports.delete(oldest)
    }
    this.recordTask({ sessionId, status: failed ? 'failed' : 'completed', ...(failed && message !== '' ? { error: message } : {}) })
    const text = failed
      ? `❌ 任务失败(会话 ${sessionId})${message !== '' ? `\n${message.slice(0, 200)}` : ''}` +
        (isTransport
          ? '\n🔧 常见于第三方中转站:上游读取超时/流式通道不稳/风控截断。排查顺序:调大 read_timeout(≥120s)→ 关闭流式测试 → 降低 max_tokens → 简化输入对比(详见 FAQ)'
          : '') +
        `\n发送「打开 ${sessionId}」查看详情`
      : `✅ 任务完成(会话 ${sessionId})\n发送「打开 ${sessionId}」查看结果`
    if (this.push !== null) this.push(owner.channel, owner.userId, text, undefined, owner.pushTarget)
    // 任务结束:启动下一个排队任务(串行执行)。
    void this.drainQueue().catch(() => {})
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

  /** 对话回合的 TRANSPORT 流中断:定稿旧流 → 重放上次提示词(每会话最多一次)。
   *  返回 true 表示已重试,调用方跳过本次收尾(避免旧流追加/重复推送)。 */
  private handleChatTransport(sessionId: string, owner: SessionOwner, ev: Record<string, unknown>): boolean {
    const failure = turnEndFailure(ev)
    if (failure === null || !failure.isTransport) return false
    if (this.retriedTransports.has(sessionId)) return false
    const prompt = this.chatPrompts.get(sessionId)
    if (prompt === undefined) return false
    this.retriedTransports.add(sessionId)
    // 定稿旧流:已显示的部分不再追加,重试产生新流(QQ 侧为新消息)。
    const pending = this.chatReplies.get(sessionId)
    if (pending !== undefined && this.chatStream !== null) {
      this.chatStream.onEnd(owner.channel, pending.userId, owner.pushTarget)
    }
    this.chatReplyBuffer.delete(sessionId)
    this.chatReplies.set(sessionId, {
      channel: owner.channel,
      userId: owner.userId,
      pushTarget: owner.pushTarget,
      ts: Date.now(),
    })
    if (this.push !== null) {
      this.push(owner.channel, owner.userId, '⚠️ 模型流中断,正在自动重试一次…(仍失败常见于中转站:上游读取超时/流式不稳/风控截断)', undefined, owner.pushTarget)
    }
    this.appendAudit({ time: Date.now(), type: 'chat.retry', sessionId, detail: '模型流中断,自动重试一次' })
    void this.harness.client().rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: prompt.parts,
    }).catch(() => {
      this.appendAudit({ time: Date.now(), type: 'chat.retry-failed', sessionId, detail: 'TRANSPORT 重试重放失败' })
    })
    return true
  }

  /** 对话回合结束:推送给发起者(非流式通道);优先用回合缓冲,兜底拉历史。
   *  时效窗口 20 分钟:对话上下文里的回复永远有意义,避免模型想久了静默丢失。 */
  private pushChatReply(sessionId: string): void {
    const pending = this.chatReplies.get(sessionId)
    if (pending === undefined || this.push === null) return
    this.chatReplies.delete(sessionId)
    if (Date.now() - pending.ts > 20 * 60 * 1000) return
    const buffered = this.chatReplyBuffer.get(sessionId) ?? ''
    this.chatReplyBuffer.delete(sessionId)
    if (buffered.trim() !== '') {
      this.push(pending.channel, pending.userId, buffered.trim().slice(0, 1500), undefined, pending.pushTarget)
      return
    }
    const client = this.harness.client()
    void client.rpc<{ events: HistoryEventLike[] }>(
      'session.history', { sessionId, maxMessages: 2 }, 30000,
    ).then((data) => {
      const events = data.events ?? []
      const reply = deliveredText(events, 1500)
      // 拉不到内容就不打扰用户(可发「进展」或手机端查看)。
      if (reply === '') return
      this.push!(pending.channel, pending.userId, reply, undefined, pending.pushTarget)
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
      if (o !== undefined && o.channel === owner.channel && normUserId(o.userId) === normUserId(owner.userId)) return pending
    }
    return null
  }

  /** 查该用户最近的待回答提问。 */
  private findPendingQuestion(owner: Pick<SessionOwner, 'channel' | 'userId'>, sessionId?: string): PendingQuestion | null {
    for (const pending of this.pendingQuestions.values()) {
      if (sessionId !== undefined && sessionId !== '' && pending.sessionId !== sessionId) continue
      const o = this.sessionOwners.get(pending.sessionId)
      if (o !== undefined && o.channel === owner.channel && normUserId(o.userId) === normUserId(owner.userId)) return pending
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
