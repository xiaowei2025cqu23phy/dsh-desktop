/**
 * QQ 机器人通道:通过 @tencent-connect/qqbot-nodejs 接入 QQ 开放平台,
 * 把私聊消息转发给统一命令处理器(RemoteCommandProcessor)。
 *
 * 发送策略:SDK sendText 在 target 无 msgId 时走主动推送接口
 * (/v2/users/{openid}/messages 不带 msg_id),因此用户与机器人交互后
 * 可主动推送审批/提问通知;长回复自动分段。命令集见 remote-commands.ts。
 */

import { app, net } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ConfigStore, QQBotConfig } from './config'
import { ACTION_BUTTON_PREFIX, APPROVE_BUTTON_PREFIX, findEventGroupOpenid, findEventUserId, parseActionButtonData, parseApprovalButtonData, parseQuestionButtonData, QUESTION_BUTTON_PREFIX } from './qq-commands'
import { startOnboard, type OnboardProgress } from './qq-onboard'
import type { RemoteCommandProcessor } from './remote-commands'

/** 单条 QQ 消息长度上限(平台限制约 5000 字符,保守取 3800 减少长回复碎片)。 */
const MAX_MESSAGE_LENGTH = 3800

/** 流式帧节流窗口:replace 模式每帧重发全文,间隔太短会让长回复的网络/平台压力翻倍;600ms 兼顾平滑与开销。 */
const STREAM_FLUSH_INTERVAL_MS = 600

/** 单条流式消息体上限:超过即收尾本条,余文以新消息续发(防止长回复每帧携带超大正文拖慢对话)。 */
const STREAM_BODY_LIMIT = 3800

/** 一次流式会话(一条回复)的状态。 */
interface StreamSessionState {
  streamMsgId: string
  index: number
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  msgSeq: number
  msgId: string
  lastSentText: string
  lastFlushAt: number
  flushPromise: Promise<void> | null
  closed: boolean
}

/** 推送目标(带 msgId 时 SDK 按「回复该消息」发送)。 */
interface PushTarget {
  scope: string
  targetId: string
  /** 源消息 id:流式回复与被动回复需要;主动推送可省略。 */
  msgId?: string
}

/** 主动推送窗口:用户交互后 48 小时内可推送。 */
const PUSH_WINDOW_MS = 48 * 60 * 60 * 1000

/** QQ 通道自检信息(「状态」指令与桌面端诊断展示)。 */
export interface QQDiagState {
  /** 是否已启用且凭据完整。 */
  configured: boolean
  /** 是否已连接(QQ 长连接 ready)。 */
  connected: boolean
  /** 连接就绪时间(ms);从未连上为 null。 */
  readyAt: number | null
  /** 最近一次失败(发送成功后清除);null = 最近无失败。 */
  lastError: { at: number; action: string; detail: string; hint: string } | null
}

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
  /** 群 openid → 该群最近一条用户消息的 msg_id(群 bot 只能"回复式"发消息)。 */
  private groupLatestMsg = new Map<string, string>()
  /** 流式对话会话(userId → 状态;QQ 私聊打字机效果)。closed=true 表示旧回合已收尾,增量需另起会话。 */
  private streamSessions = new Map<string, { streamMsgId: string; index: number; buffer: string; timer: ReturnType<typeof setTimeout> | null; msgSeq: number; msgId: string; lastSentText: string; lastFlushAt: number; flushPromise: Promise<void> | null; closed: boolean }>()
  /** 扫码登录流程状态。 */
  private onboardAbort: AbortController | null = null
  private onboardProgress: OnboardProgress | null = null
  /** QQ 连接就绪时间(ready 事件后;null = 本次运行从未连上)。 */
  private readyAt: number | null = null
  /** 最近一次失败(发送成功后清除);供「状态」自检一眼定位。 */
  private lastError: { at: number; action: string; detail: string; hint: string } | null = null

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

  /** 通道自检信息(「状态」指令、桌面端设置页与诊断导出共用)。 */
  diag(): QQDiagState {
    const config = this.getConfig()
    return {
      configured: config.enabled && config.appId.trim() !== '' && config.appSecret.trim() !== '',
      connected: this.started,
      readyAt: this.readyAt,
      lastError: this.lastError,
    }
  }

  /** 记录一次失败(自检用;动作名 + 分类提示)。 */
  private noteError(action: string, error: unknown): void {
    const classified = classifyQQError(error)
    this.lastError = { at: Date.now(), action, detail: classified.detail, hint: classified.hint }
  }

  /** 发送成功后清除最近失败标记。 */
  private clearError(): void {
    this.lastError = null
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
    this.started = false
    this.readyAt = null
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
        this.readyAt = Date.now()
        this.clearError()
        console.log('[qq-bot] QQ 机器人已连接')
      })
      bot.on('message', (_ctx, msg) => {
        void this.handleMessage(msg).catch((error) => {
          console.error('[qq-bot] 消息处理失败:', error)
          this.noteError('消息处理失败', error)
        })
      })
      bot.on('interaction', (_ctx, event) => {
        void this.handleInteraction(event).catch((error) => {
          console.error('[qq-bot] 按钮点击处理失败:', error)
          this.noteError('按钮处理失败', error)
        })
      })
      await bot.start()
    } catch (error) {
      console.error('[qq-bot] 启动失败:', error)
      this.bot = null
      this.started = false
      this.noteError('启动失败', error)
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
    this.readyAt = null
    this.userTargets.clear()
    // welcomed 持久化保留:重启/重连后不再重复欢迎同一用户/群。
  }

  // ---- 内部 ----

  // ---- 流式对话输出(QQ 私聊打字机) ----

  /**
   * 回合文本增量:累积缓存,按节流窗口(400ms)冲刷到 stream_messages。
   * replace 模式一帧替换一次内容,时间节流让打字机效果平滑,不会每增量一帧「几个字一蹦」。
   */
  onChatDelta(channel: string, userId: string, delta: string, target?: { scope: string; targetId: string; msgId?: string }): void {
    if (channel !== 'qq' || target === undefined || target.scope !== 'c2c') return
    const bot = this.bot
    if (bot === null) return
    let session = this.streamSessions.get(userId)
    if (session === undefined || session.closed) {
      // 旧回合已收尾(正常结束或中断重试):另起一条新流(新 msgSeq)。
      session = { streamMsgId: '', index: 0, buffer: '', timer: null, msgSeq: nextMsgSeq(), msgId: target.msgId ?? '', lastSentText: '', lastFlushAt: 0, flushPromise: null, closed: false }
      this.streamSessions.set(userId, session)
    }
    session.buffer += delta
    this.scheduleFlush(bot, userId, target, session, false)
  }

  /** 按节流窗口排期一次冲刷:窗口未到挂定时器,已到立即发。 */
  private scheduleFlush(
    bot: QQBotLike,
    userId: string,
    target: { scope: string; targetId: string; msgId?: string },
    session: StreamSessionState,
    done: boolean,
  ): void {
    if (session.closed || session.timer !== null || session.flushPromise !== null) return
    // 正文超长:立即收尾本条(整段发出),后续增量另起新流续写——避免每帧重传超大 replace 正文。
    if (!done && session.buffer.length >= STREAM_BODY_LIMIT) {
      session.closed = true
      void this.flushStream(bot, userId, target, session, true).finally(() => {
        if (this.streamSessions.get(userId) === session) this.streamSessions.delete(userId)
      })
      return
    }
    const elapsed = Date.now() - session.lastFlushAt
    if (elapsed >= STREAM_FLUSH_INTERVAL_MS) {
      void this.flushStream(bot, userId, target, session, done)
    } else {
      const s = session
      s.timer = setTimeout(() => {
        s.timer = null
        void this.flushStream(bot, userId, target, s, done)
      }, STREAM_FLUSH_INTERVAL_MS - elapsed)
    }
  }

  /**
   * 回合结束:发送最终内容分片(input_state=10,内容即最终全文)。
   * 等待在途普通帧完成后再发完成帧(避免 done 帧被跳过导致消息停在「生成中」)。
   */
  onChatEnd(channel: string, userId: string, target?: { scope: string; targetId: string; msgId?: string }): void {
    if (channel !== 'qq' || target === undefined || target.scope !== 'c2c') return
    const bot = this.bot
    if (bot === null) return
    const session = this.streamSessions.get(userId)
    if (session === undefined || session.closed) return
    // 立即标记关闭:中断重试场景下新回合的增量会另起新流,不会被拼进本流。
    session.closed = true
    if (session.timer !== null) {
      clearTimeout(session.timer)
      session.timer = null
    }
    void (async () => {
      if (session.flushPromise !== null) await session.flushPromise.catch(() => {})
      // 失败兜底(流已删)或已被新流替换:不再发完成帧。
      if (this.streamSessions.get(userId) !== session) return
      await this.flushStream(bot, userId, target, session, true)
      if (this.streamSessions.get(userId) === session) this.streamSessions.delete(userId)
    })()
  }

  /**
   * 冲刷一帧流式内容(官方 /stream_messages 协议)。
   *
   * 协议要点(参考 SDK StreamSession 与生产实现):
   * - msg_seq 整条流固定,index 每次实际请求前递增(网络错误后新请求用连续 index);
   * - msg_id/event_id 是源用户消息 id,缺失时 QQ 会把每帧当独立消息(旧 bug 的「发两遍」根源);
   * - 限流(HTTP 429 / QQ err_code 50002)换 index 指数退避重试;
   * - 失败兜底只补发未显示的后缀,避免整段重复。
   */
  private flushStream(
    bot: QQBotLike,
    userId: string,
    target: { scope: string; targetId: string; msgId?: string },
    session: StreamSessionState,
    done: boolean,
  ): Promise<void> {
    // 在途帧未完成时返回其 promise,让完成帧等待。
    if (session.flushPromise !== null) return session.flushPromise
    const promise = this.doFlush(bot, userId, target, session, done)
    session.flushPromise = promise
    void promise.finally(() => {
      if (session.flushPromise === promise) session.flushPromise = null
      // 在途期间积累的增量:补一帧(先清空在途标记再调度,否则节流器会跳过)。
      if (!done && !session.closed && session.buffer !== '' && session.timer === null && this.streamSessions.has(userId)) {
        this.scheduleFlush(bot, userId, target, session, false)
      }
    })
    return promise
  }

  private async doFlush(
    bot: QQBotLike,
    userId: string,
    target: { scope: string; targetId: string; msgId?: string },
    session: StreamSessionState,
    done: boolean,
  ): Promise<void> {
    const config = this.getConfig()
    const creds = { appId: config.appId.trim(), clientSecret: config.appSecret.trim() }
    const sendFrame = async (): Promise<unknown> => {
      const body: Record<string, unknown> = {
        input_mode: 'replace',
        input_state: done ? 10 : 1,
        // 官方流式接口只接受 markdown;text 会被拒绝导致每帧都失败重发,是「发多遍」的根源。
        content_type: 'markdown',
        content_raw: session.buffer,
        event_id: session.msgId,
        msg_id: session.msgId,
        msg_seq: session.msgSeq,
        index: session.index,
      }
      session.index += 1
      if (session.streamMsgId !== '') body.stream_msg_id = session.streamMsgId
      return bot.messageApi.sendC2CStreamMessage(creds, target.targetId, body)
    }
    try {
      let response: unknown
      let attempt = 0
      for (;;) {
        try {
          response = await sendFrame()
          break
        } catch (error) {
          if (attempt < 3 && isStreamRateLimit(error)) {
            attempt += 1
            await sleep(1000 * 2 ** (attempt - 1))
            continue
          }
          throw error
        }
      }
      const resp = response as { id?: unknown; stream_msg_id?: unknown }
      // 服务端返回的流 ID 在响应 body 的 id 字段(参考 SDK StreamSession 实现)。
      const streamId = typeof resp.id === 'string' ? resp.id : resp.stream_msg_id
      if (typeof streamId === 'string') session.streamMsgId = streamId
      session.lastSentText = session.buffer
      session.lastFlushAt = Date.now()
      if (done) session.buffer = ''
    } catch (error) {
      console.error('[qq-bot] 流式发送失败:', error)
      this.noteError('流式发送失败', error)
      // 只删自己:中断重试期间可能已创建新会话。
      if (this.streamSessions.get(userId) === session) this.streamSessions.delete(userId)
      // 兜底:只补发尚未显示的后缀(已显示前缀保留在流式消息里),既避免整段重复又防止截断。
      const tail = session.buffer.slice(session.lastSentText.length)
      for (let index = 0; index < tail.length; index += MAX_MESSAGE_LENGTH) {
        await bot.sendText(target, tail.slice(index, index + MAX_MESSAGE_LENGTH)).catch(() => {})
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
      // 超窗:QQ 只允许在交互后 48h 内主动推送;记录下来,「状态」里可见。
      this.userTargets.delete(userId)
      this.noteError('主动推送跳过', new Error('该用户已超过 48 小时主动推送窗口'))
      return
    }
    await this.pushText(bot, entry.target, text, meta)
  }

  /** 分段发送(群走回复式 sendGroup;私聊直发)。 */
  private async pushSegment(bot: QQBotLike, target: PushTarget, text: string): Promise<void> {
    if (target.scope === 'group') {
      await this.sendGroup(bot, target.targetId, text)
    } else {
      await bot.sendText(target, text)
    }
  }

  /** 键盘消息(审批/提问按钮;群也走回复式)。 */
  private async pushKeyboard(bot: QQBotLike, target: PushTarget, keyboard: unknown): Promise<void> {
    if (target.scope === 'group') {
      await this.sendGroup(bot, target.targetId, '⚡ 请选择', keyboard)
    } else {
      await bot.sendMarkdown(target, '⚡ 请选择', { keyboard })
    }
  }

  /** 推送正文 + 可选键盘(审批/提问)。 */
  private async pushBody(
    bot: QQBotLike,
    target: PushTarget,
    text: string,
    meta?: { kind: 'approval'; sessionId: string; approvalId: string } | { kind: 'question'; sessionId: string; question: { id: string; question: string; options: string[] } },
  ): Promise<void> {
    if (meta !== undefined && meta.kind === 'approval') {
      await this.pushSegment(bot, target, text.slice(0, MAX_MESSAGE_LENGTH))
      await this.pushKeyboard(bot, target, buildApprovalKeyboard(meta.sessionId, meta.approvalId))
    } else if (meta !== undefined && meta.kind === 'question') {
      await this.pushSegment(bot, target, text.slice(0, MAX_MESSAGE_LENGTH))
      await this.pushKeyboard(bot, target, buildQuestionKeyboard(meta.sessionId, meta.question))
    } else {
      for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
        await this.pushSegment(bot, target, text.slice(index, index + MAX_MESSAGE_LENGTH))
      }
    }
  }

  /** 尝试推送;成功返回 true,失败(权限/超窗/网络)返回 false。 */
  private async tryPush(
    bot: QQBotLike,
    target: PushTarget,
    text: string,
    meta?: { kind: 'approval'; sessionId: string; approvalId: string } | { kind: 'question'; sessionId: string; question: { id: string; question: string; options: string[] } },
  ): Promise<boolean> {
    try {
      await this.pushBody(bot, target, text, meta)
      this.clearError()
      return true
    } catch (error) {
      console.error('[qq-bot] 主动推送失败(尝试回退):', error)
      this.noteError('主动推送失败', error)
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
      await this.pushBody(bot, target, text, meta)
      this.clearError()
    } catch (error) {
      console.error('[qq-bot] 主动推送失败(靠下次回复提醒兜底):', error)
      this.noteError('主动推送失败', error)
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
    // 按钮点击者身份:QQ INTERACTION_CREATE 的 user_openid/group_openid 在事件顶层
    // (部分 SDK 形态放 data 内,双路径兼容);缺失时退回该用户的私聊登记。
    const rawRecord = raw as Record<string, unknown>
    const topUserOpenid = typeof rawRecord.user_openid === 'string' ? rawRecord.user_openid : ''
    const topGroupOpenid = typeof rawRecord.group_openid === 'string' ? rawRecord.group_openid : ''
    let userId = topUserOpenid !== '' ? topUserOpenid : findEventUserId(raw.data)
    if (userId === '') {
      for (const [k, v] of this.userTargets) {
        if (v.target.scope === 'c2c') { userId = k; break }
      }
    }
    console.log(`[qq-bot] interaction identity: topUser=${topUserOpenid} topGroup=${topGroupOpenid} userTargets=${this.userTargets.size}`)
    let result: string
    if (approval !== null) {
      result = await this.processor.respondApproval('qq', userId, approval.sessionId, approval.approvalId, approval.decision)
    } else if (question !== null) {
      result = await this.processor.respondQuestion('qq', userId, question.sessionId, question.questionId, question.optionIndex)
    } else {
      result = await this.processor.handleButtonAction('qq', userId, action!.sessionId, action!.action)
    }
    await bot.acknowledgeInteraction(interactionId, 0, {}).catch(() => {})
    // 应答结果回发:群按钮点击回发群里(回复式,带最新群消息 id),私聊点击回发私聊。
    const groupOpenid = topGroupOpenid !== '' ? topGroupOpenid : findEventGroupOpenid(raw.data)
    if (groupOpenid !== '') {
      await this.sendGroup(bot, groupOpenid, result).catch((e) => {
        console.error('[qq-bot] group 回发失败:', e)
        this.noteError('群按钮回发失败', e)
      })
      return
    }
    if (userId !== '') {
      await bot.sendText({ scope: 'c2c', targetId: userId }, result).catch((e) => {
        console.error('[qq-bot] c2c 回发失败:', e)
        this.noteError('按钮回发失败', e)
      })
      return
    }
    const entry = this.userTargets.get(userId)
    if (entry !== undefined) {
      await bot.sendText(entry.target, result).catch((e) => {
        console.error('[qq-bot] 登记目标回发失败:', e)
        this.noteError('按钮回发失败', e)
      })
    }
  }

  private async handleMessage(msg: unknown): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    const record = msg as { content?: unknown; replyTarget?: unknown; author?: unknown; attachments?: unknown }
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    const userId = this.senderId(record)
    this.registerPushTarget(userId, record.replyTarget)
    const pushTarget = this.pushTargetOf(record.replyTarget)
    // 记录该群最近一条用户消息的 msg_id:群 bot 只能「回复式」发消息,回复永远用最新的。
    if (pushTarget !== undefined && pushTarget.scope === 'group') {
      const target = record.replyTarget as { msgId?: unknown } | null
      if (target !== null && typeof target === 'object' && typeof target.msgId === 'string' && target.msgId !== '') {
        this.groupLatestMsg.set(pushTarget.targetId, target.msgId)
        if (this.groupLatestMsg.size > 64) {
          const oldest = this.groupLatestMsg.keys().next().value as string | undefined
          if (oldest !== undefined) this.groupLatestMsg.delete(oldest)
        }
      }
    }
    // 图片消息(QQ C2C 图片 content 为 JSON {type:'image', data:url};也兼容 attachments)。
    const image = await this.extractImage(record)
    if (content === '' && image === undefined) return
    const reply = await this.processor.handleText('qq', userId, content, pushTarget, image)
    await this.reply(bot, record.replyTarget, reply)
    // 任务启动回复附带操作按钮(停止/进展/打开),像 PWA 一样一键操作。
    const sessionMatch = /任务已启动 ✓\n会话: (session-[0-9a-f-]+)/.exec(reply)
    if (sessionMatch !== null) {
      const target = pushTarget ?? this.userTargets.get(userId)?.target
      if (target !== undefined) {
        if (target.scope === 'group') {
          await this.sendGroup(bot, target.targetId, '⚡ 任务已启动,选择操作', buildActionKeyboard(sessionMatch[1])).catch(() => {})
        } else {
          await bot.sendMarkdown(target, '⚡ 任务已启动,选择操作', { keyboard: buildActionKeyboard(sessionMatch[1]) }).catch(() => {})
        }
      }
    }
  }

  /** 从消息中提取图片:content JSON(image url)或 attachments;下载为 base64。 */
  private async extractImage(record: { content?: unknown; attachments?: unknown }): Promise<{ mime: string; data: string } | undefined> {
    let url = ''
    if (typeof record.content === 'string') {
      try {
        const parsed = JSON.parse(record.content) as { type?: unknown; data?: unknown }
        if (parsed.type === 'image' && typeof parsed.data === 'string' && /^https?:\/\//.test(parsed.data)) {
          url = parsed.data
        }
      } catch {
        // 非 JSON 文本消息,忽略。
      }
    }
    if (url === '' && Array.isArray(record.attachments)) {
      const img = record.attachments.find((a) => typeof a === 'object' && a !== null &&
        ((a as { type?: unknown }).type === 'image' || /^https?:\/\//.test(String((a as { url?: unknown }).url ?? ''))))
      if (img !== null && img !== undefined) {
        url = String((img as { url?: unknown }).url ?? (img as { data?: unknown }).data ?? '')
      }
    }
    if (url === '') return undefined
    try {
      // 图片在 QQ CDN 上,主进程全局 fetch 不走系统代理会失败,改用 net.fetch。
      const response = await net.fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) return undefined
      const buf = Buffer.from(await response.arrayBuffer())
      if (buf.length > 10 * 1024 * 1024) return undefined
      const type = response.headers.get('content-type') ?? ''
      const mime = /^image\/(jpeg|png|webp|gif)$/.test(type) ? type : 'image/jpeg'
      return { mime, data: buf.toString('base64') }
    } catch (error) {
      console.error('[qq-bot] 图片下载失败:', error)
      return undefined
    }
  }

  /** 从 replyTarget 提取主动推送目标(群=群 id,私聊=用户 openid)。
   *  群消息不带 msg_id:群 bot 多数没有「群内主动发言」权限,只能回复用户消息;
   *  发送时统一补「该群最近一条用户消息」的 msg_id(见 sendGroup),永不过期。 */
  private pushTargetOf(replyTarget: unknown): { scope: string; targetId: string; msgId?: string } | undefined {
    if (replyTarget === null || typeof replyTarget !== 'object') return undefined
    const target = replyTarget as { scope?: unknown; targetId?: unknown; msgId?: unknown }
    if (typeof target.scope !== 'string' || typeof target.targetId !== 'string') return undefined
    const result: { scope: string; targetId: string; msgId?: string } = { scope: target.scope, targetId: target.targetId }
    if (target.scope !== 'group' && typeof target.msgId === 'string' && target.msgId !== '') result.msgId = target.msgId
    return result
  }

  /** 群消息发送:优先「回复最近一条用户消息」(msg_id 最新,永不过期);无记录时直发兜底。 */
  private async sendGroup(bot: QQBotLike, groupId: string, text: string, keyboard?: unknown): Promise<void> {
    const latest = this.groupLatestMsg.get(groupId)
    const targets: Array<{ scope: string; targetId: string; msgId?: string }> = latest !== undefined
      ? [{ scope: 'group', targetId: groupId, msgId: latest }]
      : [{ scope: 'group', targetId: groupId }]
    let lastError: unknown = new Error('no group target')
    for (const target of targets) {
      try {
        if (keyboard !== undefined) await bot.sendMarkdown(target, text, { keyboard })
        else await bot.sendText(target, text)
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
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

  /** 从消息对象提取发送者标识:私聊=裸 openid,群=author 成员 id(缺失时按 g:群id 共享);两者与按钮事件隔离。 */
  private senderId(record: { author?: unknown; replyTarget?: unknown }): string {
    const author = record.author
    if (author !== null && typeof author === 'object') {
      const id = (author as { id?: unknown }).id
      if (typeof id === 'string' && id !== '') return id
    }
    const target = record.replyTarget
    if (target !== null && typeof target === 'object') {
      const t = target as { scope?: unknown; targetId?: unknown }
      if (typeof t.scope === 'string' && typeof t.targetId === 'string' && t.targetId !== '') {
        // 群消息没有成员 author 时,整个群共用一个对话身份(命令在群里已禁用,不影响安全)。
        return t.scope === 'group' ? `g:${t.targetId}` : t.targetId
      }
    }
    return 'anonymous'
  }

  private async reply(
    bot: { sendText: (target: unknown, text: string) => Promise<unknown> },
    target: unknown,
    text: string,
  ): Promise<void> {
    if (target === undefined || text === '') return
    // 群消息回复:一律走 sendGroup(回复最近一条用户消息,msg_id 永不过期);
    // 私聊用 SDK 的 replyTarget(带本条消息 msg_id,回复式)。
    const t = target as { scope?: unknown; targetId?: unknown } | null
    const isGroup = t !== null && typeof t === 'object' && t.scope === 'group' && typeof t.targetId === 'string'
    // 长文本分段发送。
    for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
      const segment = text.slice(index, index + MAX_MESSAGE_LENGTH)
      if (isGroup) {
        await this.sendGroup(bot as QQBotLike, (t as { targetId: string }).targetId, segment)
      } else {
        await bot.sendText(target, segment)
      }
    }
    this.clearError()
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

/** 流式会话的消息序列号:一条回复(一次流)内固定,单调递增避免与既有流碰撞。 */
let msgSeqCounter = 1
function nextMsgSeq(): number {
  msgSeqCounter = (msgSeqCounter % 65535) + 1
  return msgSeqCounter
}

/** 是否为 QQ 限流错误(HTTP 429 / err_code 50002):流式帧可换连续 index 后重试。 */
function isStreamRateLimit(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes('rate limit')) return true
  const code = (error as { code?: unknown }).code ?? (error as { err_code?: unknown }).err_code
  return code === 429 || code === 50002
}

/** QQ 错误分类:提取平台错误码并给出可操作提示(状态自检用)。 */
function classifyQQError(error: unknown): { detail: string; hint: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code ?? (error as { err_code?: unknown }).err_code
  const codes = typeof code === 'string' || typeof code === 'number' ? String(code) : ''
  const text = `${codes !== '' ? `[${codes}] ` : ''}${raw}`.slice(0, 240)
  const joined = `${codes} ${raw}`
  if (joined.includes('40034105')) {
    return { detail: text, hint: '机器人缺少「主动消息」权限:QQ 开放平台 → 开发设置 → 开通主动消息;或对方已超过 48 小时交互窗口' }
  }
  if (joined.includes('40034005')) {
    return { detail: text, hint: '回复窗口过期:让对方再发一条消息,机器人只能回复或在其交互后 48 小时内推送' }
  }
  if (joined.includes('50002') || /rate limit/i.test(joined)) {
    return { detail: text, hint: '触发频控:稍等片刻再试(机器人不要发太快/太频繁)' }
  }
  if (raw === '') return { detail: '未知错误', hint: '' }
  return { detail: text, hint: '' }
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
