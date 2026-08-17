/**
 * QQ 机器人通道:通过 @tencent-connect/qqbot-nodejs 接入 QQ 开放平台,
 * 把私聊消息转发给统一命令处理器(RemoteCommandProcessor)。
 *
 * 发送策略:SDK sendText 在 target 无 msgId 时走主动推送接口
 * (/v2/users/{openid}/messages 不带 msg_id),因此用户与机器人交互后
 * 可主动推送审批/提问通知;长回复自动分段。命令集见 remote-commands.ts。
 */

import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ConfigStore, QQBotConfig } from './config'
import { ACTION_BUTTON_PREFIX, APPROVE_BUTTON_PREFIX, findEventGroupOpenid, findEventUserId, parseActionButtonData, parseApprovalButtonData, parseQuestionButtonData, QUESTION_BUTTON_PREFIX } from './qq-commands'
import { startOnboard, type OnboardProgress } from './qq-onboard'
import type { RemoteCommandProcessor } from './remote-commands'

/** 单条 QQ 消息长度上限(保守取平台限制以下)。 */
const MAX_MESSAGE_LENGTH = 1500

/** 主动推送目标(无 msgId)。 */
interface PushTarget {
  scope: string
  targetId: string
}

/** 主动推送窗口:用户交互后 48 小时内可推送。 */
const PUSH_WINDOW_MS = 48 * 60 * 60 * 1000

/** SDK 实例的最小类型(createRequire 加载 ESM 入口后可用)。 */
interface QQBotLike {
  on: (event: string, listener: (...args: unknown[]) => void) => void
  start: () => Promise<void>
  stop: () => void
  sendText: (target: unknown, text: string) => Promise<unknown>
  sendMarkdown: (target: unknown, content: string, opts?: { keyboard?: unknown }) => Promise<unknown>
  acknowledgeInteraction: (interactionId: string, code?: number, data?: unknown) => Promise<unknown>
  messageApi: {
    sendC2CStreamMessage: (creds: { appId: string; clientSecret: string }, openid: string, req: unknown) => Promise<unknown>
  }
}

export class QQBotAdapter {
  private bot: QQBotLike | null = null
  private started = false
  /** userId(openid)→ 主动推送目标(登记自最近一次交互)。 */
  private userTargets = new Map<string, { target: PushTarget; ts: number }>()
  /** 流式对话会话(userId → 状态;QQ 私聊打字机效果)。 */
  private streamSessions = new Map<string, { streamMsgId: string; index: number; buffer: string; timer: ReturnType<typeof setTimeout> | null; seq: number; flushing: boolean }>()
  /** 扫码登录流程状态。 */
  private onboardAbort: AbortController | null = null
  private onboardProgress: OnboardProgress | null = null

  constructor(
    private config: ConfigStore,
    private processor: RemoteCommandProcessor,
  ) {}

  getConfig(): QQBotConfig {
    return this.config.get().qq
  }

  setConfig(patch: Partial<QQBotConfig>): QQBotConfig {
    const next = this.config.update('qq', patch)
    this.processor.defaultTarget = next.defaultTarget ?? ''
    this.processor.setAutoChat('qq', next.autoChat === true)
    this.processor.setReport('qq', next.report === true)
    void this.restart()
    return next
  }

  isStarted(): boolean {
    return this.started
  }

  // ---- 扫码登录(onboard) ----

  /** 开始扫码绑定:返回二维码就绪后的进度(渲染层展示二维码并轮询状态)。 */
  async onboardStart(): Promise<OnboardProgress> {
    this.onboardAbort?.abort()
    this.onboardAbort = new AbortController()
    const signal = this.onboardAbort.signal
    this.onboardProgress = null
    void startOnboard(
      (qrDataUrl) => {
        this.onboardProgress = { status: 'pending', qrDataUrl }
      },
      (progress) => {
        this.onboardProgress = progress
        // 绑定成功:自动填入 AppID/AppSecret 并重启机器人。
        if (progress.status === 'completed' && progress.appId !== undefined && progress.appSecret !== undefined) {
          try {
            this.setConfig({ appId: progress.appId, appSecret: progress.appSecret })
          } catch (error) {
            console.error('[qq-bot] 应用扫码凭据失败:', error)
          }
        }
      },
      signal,
    ).catch((error) => {
      console.error('[qq-bot] 扫码流程异常:', error)
      this.onboardProgress = { status: 'error', qrDataUrl: null, error: error instanceof Error ? error.message : String(error) }
    })
    // 等待二维码就绪(最多 15 秒)。
    const deadline = Date.now() + 15000
    while (this.onboardProgress === null && Date.now() < deadline) {
      await sleep(200)
    }
    return this.onboardProgress ?? { status: 'error', qrDataUrl: null, error: '二维码生成超时' }
  }

  /** 当前扫码进度(渲染层轮询)。 */
  onboardStatus(): OnboardProgress | null {
    return this.onboardProgress
  }

  /** 取消扫码流程。 */
  onboardCancel(): void {
    this.onboardAbort?.abort()
    this.onboardAbort = null
    this.onboardProgress = null
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async start(): Promise<void> {
    if (this.started) return
    const config = this.getConfig()
    this.processor.defaultTarget = config.defaultTarget ?? ''
    this.processor.setAutoChat('qq', config.autoChat === true)
    this.processor.setReport('qq', config.report === true)
    if (!config.enabled || config.appId.trim() === '' || config.appSecret.trim() === '') {
      console.log('[qq-bot] 未配置或未启用,跳过')
      return
    }
    try {
      // SDK 为纯 ESM 且 exports 只声明 import 条件(CJS 包名解析报 ERR_PACKAGE_PATH_NOT_EXPORTED,
      // Electron CJS 主进程的动态 import 也会被转成 require)。因此绕过包名解析:
      // createRequire 直接加载 SDK 入口文件路径 —— Node 22 的 require(esm) 支持 ESM 文件,
      // 且对具体文件路径不查 exports。
      const sdkEntry = app.isPackaged
        ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js')
        : join(app.getAppPath(), 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js')
      const sdk = createRequire(__filename)(sdkEntry) as { QQBot: new (options: unknown) => QQBotLike }
      const bot = new sdk.QQBot({
        appId: config.appId.trim(),
        appSecret: config.appSecret.trim(),
        logger: console,
      })
      this.bot = bot
      // 上线以 SDK ready 事件为准(start() 可能等待更长握手,不阻塞应用启动)。
      bot.on('ready', () => {
        this.started = true
        console.log('[qq-bot] QQ 机器人已连接')
      })
      bot.on('message', (_ctx, msg) => {
        void this.handleMessage(msg).catch((error) => {
          console.error('[qq-bot] 消息处理失败:', error)
        })
      })
      bot.on('interaction', (_ctx, event) => {
        void this.handleInteraction(event).catch((error) => {
          console.error('[qq-bot] 按钮点击处理失败:', error)
        })
      })
      await bot.start()
    } catch (error) {
      console.error('[qq-bot] 启动失败:', error)
      this.bot = null
      this.started = false
    }
  }

  async stop(): Promise<void> {
    if (this.bot !== null) {
      try {
        this.bot.stop()
      } catch {
        // 忽略停止错误。
      }
      this.bot = null
    }
    this.started = false
    this.userTargets.clear()
    // welcomed 持久化保留:重启/重连后不再重复欢迎同一用户/群。
  }

  // ---- 内部 ----

  // ---- 流式对话输出(QQ 私聊打字机) ----

  /** 回合文本增量:累积并按节流冲刷到 stream_messages(is_wakeup 主动流式)。 */
  onChatDelta(channel: string, userId: string, delta: string, target?: { scope: string; targetId: string }): void {
    if (channel !== 'qq' || target === undefined || target.scope !== 'c2c') return
    const bot = this.bot
    if (bot === null) return
    let session = this.streamSessions.get(userId)
    if (session === undefined) {
      session = { streamMsgId: '', index: 0, buffer: '', timer: null, seq: 1, flushing: false }
      this.streamSessions.set(userId, session)
    }
    session.buffer += delta
    if (session.timer === null && session.buffer.length >= 12 && !session.flushing) {
      void this.flushStream(bot, userId, target, session, false)
    } else if (session.timer === null && !session.flushing) {
      const s = session
      s.timer = setTimeout(() => {
        s.timer = null
        void this.flushStream(bot, userId, target, s, false)
      }, 350)
    }
  }

  /** 回合结束:冲刷剩余内容并发送结束分片(input_state=10)。 */
  onChatEnd(channel: string, userId: string, target?: { scope: string; targetId: string }): void {
    if (channel !== 'qq' || target === undefined || target.scope !== 'c2c') return
    const bot = this.bot
    if (bot === null) return
    const session = this.streamSessions.get(userId)
    if (session === undefined) return
    if (session.timer !== null) {
      clearTimeout(session.timer)
      session.timer = null
    }
    void (async () => {
      if (session.buffer !== '') await this.flushStream(bot, userId, target, session, false)
      await this.flushStream(bot, userId, target, session, true)
      this.streamSessions.delete(userId)
    })()
  }

  private async flushStream(
    bot: QQBotLike,
    userId: string,
    target: { scope: string; targetId: string },
    session: { streamMsgId: string; index: number; buffer: string; timer: ReturnType<typeof setTimeout> | null; seq: number; flushing: boolean },
    done: boolean,
  ): Promise<void> {
    if (session.flushing) return
    session.flushing = true
    const config = this.getConfig()
    const creds = { appId: config.appId.trim(), clientSecret: config.appSecret.trim() }
    const body: Record<string, unknown> = {
      input_mode: 'replace',
      input_state: done ? 10 : 1,
      index: session.index,
      content_type: 'text',
      content_raw: session.buffer,
      is_wakeup: true,
      msg_seq: session.seq++,
    }
    if (session.streamMsgId !== '') body.stream_msg_id = session.streamMsgId
    try {
      const response = await bot.messageApi.sendC2CStreamMessage(creds, target.targetId, body) as { id?: unknown; stream_msg_id?: unknown }
      session.index += 1
      // 服务端返回的流 ID 在响应 body 的 id 字段(参考 SDK StreamSession 实现)。
      const streamId = typeof response.id === 'string' ? response.id : response.stream_msg_id
      if (typeof streamId === 'string') session.streamMsgId = streamId
      if (done) session.buffer = ''
    } catch (error) {
      console.error('[qq-bot] 流式发送失败(回合结束整段兜底):', error)
      this.streamSessions.delete(userId)
      // 兜底:整段文本用普通消息发送。
      if (session.buffer !== '') {
        await bot.sendText(target, session.buffer.slice(0, MAX_MESSAGE_LENGTH)).catch(() => {})
      }
    } finally {
      session.flushing = false
      // 冲刷期间又有增量:再调度一次(会话仍存在且缓冲足够长时)。
      if (!done && session.buffer !== '' && session.buffer.length >= 12 && session.timer === null && this.streamSessions.has(userId)) {
        void this.flushStream(bot, userId, target, session, false)
      }
    }
  }


  /** 主动推送(审批/提问带内联键盘按钮;超窗或失败静默降级,回复提醒兜底)。
   *  target 提供时直接推送到该目标;群场景优先推群(需机器人开通
   *  「群内主动发言」权限),失败时回退发起者私聊(c2c 登记存在时)。 */
  async sendToUser(
    userId: string,
    text: string,
    meta?: { kind: 'approval'; sessionId: string; approvalId: string } | { kind: 'question'; sessionId: string; question: { id: string; question: string; options: string[] } },
    target?: { scope: string; targetId: string },
  ): Promise<void> {
    const bot = this.bot
    if (bot === null || text === '') return
    if (target !== undefined) {
      if (target.scope === 'group') {
        const sent = await this.tryPush(bot, target, text, meta)
        if (!sent) {
          // 群主动消息被拒(如未开通群内主动发言权限):回退发起者私聊。
          const entry = this.userTargets.get(userId)
          if (entry !== undefined && entry.target.scope === 'c2c') {
            await this.pushText(bot, entry.target, text, meta)
          }
        }
      } else {
        await this.pushText(bot, target, text, meta)
      }
      return
    }
    const entry = this.userTargets.get(userId)
    if (entry === undefined) return
    const fresh = Date.now() - entry.ts <= PUSH_WINDOW_MS
    if (!fresh) {
      this.userTargets.delete(userId)
      return
    }
    await this.pushText(bot, entry.target, text, meta)
  }

  /** 尝试推送;成功返回 true,失败(权限/超窗/网络)返回 false。 */
  private async tryPush(
    bot: QQBotLike,
    target: PushTarget,
    text: string,
    meta?: { kind: 'approval'; sessionId: string; approvalId: string } | { kind: 'question'; sessionId: string; question: { id: string; question: string; options: string[] } },
  ): Promise<boolean> {
    try {
      if (meta !== undefined && meta.kind === 'approval') {
        // QQ markdown 消息需平台模板,未配置时内容不渲染(仅按钮显示)。
        // 因此拆两条:纯文本内容(可读)+ markdown 键盘消息(按钮)。
        await bot.sendText(target, text.slice(0, MAX_MESSAGE_LENGTH))
        await bot.sendMarkdown(target, '⚡ 请选择', { keyboard: buildApprovalKeyboard(meta.sessionId, meta.approvalId) })
      } else if (meta !== undefined && meta.kind === 'question') {
        await bot.sendText(target, text.slice(0, MAX_MESSAGE_LENGTH))
        await bot.sendMarkdown(target, '⚡ 请选择', { keyboard: buildQuestionKeyboard(meta.sessionId, meta.question) })
      } else {
        for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
          await bot.sendText(target, text.slice(index, index + MAX_MESSAGE_LENGTH))
        }
      }
      return true
    } catch (error) {
      console.error('[qq-bot] 主动推送失败(尝试回退):', error)
      return false
    }
  }

  private async pushText(
    bot: QQBotLike,
    target: PushTarget,
    text: string,
    meta?: { kind: 'approval'; sessionId: string; approvalId: string } | { kind: 'question'; sessionId: string; question: { id: string; question: string; options: string[] } },
  ): Promise<void> {
    try {
      if (meta !== undefined && meta.kind === 'approval') {
        await bot.sendText(target, text.slice(0, MAX_MESSAGE_LENGTH))
        await bot.sendMarkdown(target, '⚡ 请选择', { keyboard: buildApprovalKeyboard(meta.sessionId, meta.approvalId) })
      } else if (meta !== undefined && meta.kind === 'question') {
        await bot.sendText(target, text.slice(0, MAX_MESSAGE_LENGTH))
        await bot.sendMarkdown(target, '⚡ 请选择', { keyboard: buildQuestionKeyboard(meta.sessionId, meta.question) })
      } else {
        for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
          await bot.sendText(target, text.slice(index, index + MAX_MESSAGE_LENGTH))
        }
      }
    } catch (error) {
      console.error('[qq-bot] 主动推送失败(靠下次回复提醒兜底):', error)
    }
  }

  /** 审批按钮点击:解析 data → 应答审批 → ACK → 回发结果(群里点的回发群,私聊点的回发私聊)。 */
  private async handleInteraction(event: unknown): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    const raw = event as { id?: unknown; data?: unknown }
    const interactionId = typeof raw.id === 'string' ? raw.id : ''
    if (interactionId === '') return
    const approval = parseApprovalButtonData(raw.data)
    const question = parseQuestionButtonData(raw.data)
    const action = parseActionButtonData(raw.data)
    if (approval === null && question === null && action === null) {
      await bot.acknowledgeInteraction(interactionId, 1, {}).catch(() => {})
      return
    }
    // 按钮点击者身份:优先取事件里的 user openid;缺失时退回首个私聊登记。
    let userId = findEventUserId(raw.data)
    if (userId === '') {
      for (const [k, v] of this.userTargets) {
        if (v.target.scope === 'c2c') { userId = k; break }
      }
    }
    let result: string
    if (approval !== null) {
      result = await this.processor.respondApproval('qq', userId, approval.sessionId, approval.approvalId, approval.decision)
    } else if (question !== null) {
      result = await this.processor.respondQuestion('qq', userId, question.sessionId, question.questionId, question.optionIndex)
    } else {
      result = await this.processor.handleButtonAction('qq', userId, action!.sessionId, action!.action)
    }
    await bot.acknowledgeInteraction(interactionId, 0, {}).catch(() => {})
    // 应答结果回发:群按钮点击回发群里,私聊点击回发私聊;都定位不到时用登记回退。
    const groupOpenid = findEventGroupOpenid(raw.data)
    if (groupOpenid !== '') {
      await bot.sendText({ scope: 'group', targetId: groupOpenid }, result).catch(() => {})
      return
    }
    if (userId !== '') {
      await bot.sendText({ scope: 'c2c', targetId: userId }, result).catch(() => {})
      return
    }
    const entry = this.userTargets.get(userId)
    if (entry !== undefined) {
      await bot.sendText(entry.target, result).catch(() => {})
    }
  }

  private async handleMessage(msg: unknown): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    const record = msg as { content?: unknown; replyTarget?: unknown; author?: unknown }
    if (typeof record.content !== 'string') return
    const content = record.content.trim()
    if (content === '') return
    const userId = this.senderId(record)
    this.registerPushTarget(userId, record.replyTarget)
    const reply = await this.processor.handleText('qq', userId, content, this.pushTargetOf(record.replyTarget))
    await this.reply(bot, record.replyTarget, reply)
    // 任务启动回复附带操作按钮(停止/进展/打开),像 PWA 一样一键操作。
    const sessionMatch = /任务已启动 ✓\n会话: (session-[0-9a-f-]+)/.exec(reply)
    if (sessionMatch !== null) {
      const target = this.pushTargetOf(record.replyTarget) ?? this.userTargets.get(userId)?.target
      if (target !== undefined) {
        await bot.sendMarkdown(target, '⚡ 任务已启动,选择操作', { keyboard: buildActionKeyboard(sessionMatch[1]) }).catch(() => {})
      }
    }
  }

  /** 从 replyTarget 提取主动推送目标(群=群 id,私聊=用户 openid;去掉 msgId)。 */
  private pushTargetOf(replyTarget: unknown): { scope: string; targetId: string } | undefined {
    if (replyTarget === null || typeof replyTarget !== 'object') return undefined
    const target = replyTarget as { scope?: unknown; targetId?: unknown }
    if (typeof target.scope !== 'string' || typeof target.targetId !== 'string') return undefined
    return { scope: target.scope, targetId: target.targetId }
  }

  /** 登记主动推送目标(去掉 msgId;群消息按群登记,私聊按 openid 登记)。 */
  private registerPushTarget(userId: string, replyTarget: unknown): void {
    if (replyTarget === null || typeof replyTarget !== 'object') return
    const target = replyTarget as { scope?: unknown; targetId?: unknown }
    if (typeof target.scope !== 'string' || typeof target.targetId !== 'string') return
    const key = target.scope === 'c2c' ? userId : `g:${target.targetId}`
    this.userTargets.set(key, { target: { scope: target.scope, targetId: target.targetId }, ts: Date.now() })
    // 顺手清理超窗条目,避免无限增长。
    if (this.userTargets.size > 64) {
      const now = Date.now()
      for (const [k, v] of this.userTargets) {
        if (now - v.ts > PUSH_WINDOW_MS) this.userTargets.delete(k)
      }
    }
  }

  /** 从消息对象提取发送者标识(私聊取 openid;缺失时退回 replyTarget)。 */
  private senderId(record: { author?: unknown; replyTarget?: unknown }): string {
    const author = record.author
    if (author !== null && typeof author === 'object') {
      const id = (author as { id?: unknown }).id
      if (typeof id === 'string') return id
    }
    const target = record.replyTarget
    if (target !== null && typeof target === 'object') {
      const id = (target as { id?: unknown }).id
      if (typeof id === 'string') return `t:${id}`
    }
    return 'anonymous'
  }

  private async reply(
    bot: { sendText: (target: unknown, text: string) => Promise<unknown> },
    target: unknown,
    text: string,
  ): Promise<void> {
    if (target === undefined || text === '') return
    // 长文本分段发送。
    for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
      await bot.sendText(target, text.slice(index, index + MAX_MESSAGE_LENGTH))
    }
  }
}

/** 审批内联键盘(允许/拒绝;data 供 INTERACTION_CREATE 回传识别)。 */
function buildApprovalKeyboard(sessionId: string, approvalId: string): unknown {
  const button = (id: string, label: string, visited: string, style: number, decision: string): unknown => ({
    id,
    render_data: { label, visited_label: visited, style },
    action: {
      type: 1,
      data: `${APPROVE_BUTTON_PREFIX}${sessionId}|${approvalId}|${decision}`,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: 'dsh-approval',
  })
  return {
    content: {
      rows: [{
        buttons: [
          button('allow', '✅ 允许', '已允许', 1, 'allowed-once'),
          button('deny', '❌ 拒绝', '已拒绝', 0, 'rejected'),
        ],
      }],
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 提问(单选)内联键盘:每个选项一个按钮,data 供点击回传识别。 */
function buildQuestionKeyboard(sessionId: string, question: { id: string; question: string; options: string[] }): unknown {
  const buttons = question.options.map((label, index) => ({
    id: `opt-${index}`,
    render_data: { label: label.slice(0, 12), visited_label: `已选:${label.slice(0, 8)}`, style: 1 },
    action: {
      type: 1,
      data: `${QUESTION_BUTTON_PREFIX}${sessionId}|${question.id}|${index}`,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: 'dsh-question',
  }))
  return { content: { rows: [{ buttons }] } }
}

/** 任务操作内联键盘(停止/进展/打开)。 */
function buildActionKeyboard(sessionId: string): unknown {
  const btn = (id: string, label: string, visited: string, style: number, action: 'stop' | 'progress' | 'open'): unknown => ({
    id,
    render_data: { label, visited_label: visited, style },
    action: {
      type: 1,
      data: `${ACTION_BUTTON_PREFIX}${action}|${sessionId}`,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: 'dsh-action',
  })
  return {
    content: {
      rows: [{
        buttons: [
          btn('stop', '⏹ 停止', '已停止', 0, 'stop'),
          btn('progress', '📋 进展', '已查询', 1, 'progress'),
          btn('open', '📖 打开', '已打开', 1, 'open'),
        ],
      }],
    },
  }
}
