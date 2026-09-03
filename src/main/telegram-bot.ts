/**
 * Telegram 机器人通道:通过 Bot API 长轮询接收消息,
 * 转发给统一命令处理器(RemoteCommandProcessor)。
 *
 * 零依赖(仅用 Electron net.fetch,自动跟随系统代理);支持主动推送(任务完成通知等)。
 * 配置:enabled、token(BotFather 获取)、allowedUserIds(逗号分隔)。
 *
 * ⚠️ 安全边界(强制):Telegram 私聊 = 完整指令集 = 远程操控这台电脑,因此
 * allowedUserIds 留空时机器人处于【锁定】状态,不服务任何聊天、不执行任何命令。
 * 首次使用走「绑定窗口」:桌面端点「绑定我的 ID」→ 机器人在 90 秒内只做一件事——
 * 把你发来的第一条消息的 ID 回传桌面端;由桌面端主人确认后写入白名单才真正启用。
 * 群聊消息一律忽略(不聊天、不执行、不回复),只认桌面端主人配置的私聊 ID。
 */

import { net } from 'electron'
import type { ConfigStore } from './config'
import type { RemoteCommandProcessor } from './remote-commands'

export interface TelegramConfig {
  enabled: boolean
  token: string
  /** 允许的用户 ID(逗号分隔;留空 = 锁定,不服务任何聊天)。 */
  allowedUserIds: string
  /** 默认对话模式:非指令消息自动进入纯对话(无需先发「进入」)。 */
  autoChat: boolean
  /** 主动汇报:机器人发起的任务完成/失败时主动推送通知。 */
  report: boolean
}

/** Telegram 通道自检信息(「状态」指令与桌面端诊断展示)。 */
export interface TelegramDiagState {
  /** 是否已启用且填了 token。 */
  configured: boolean
  /** 是否正在长轮询(令牌有效、已解锁且轮询循环存活)。 */
  started: boolean
  /** 锁定中:已配置 token 但「允许的用户 ID」为空,不服务任何人。 */
  locked: boolean
  /** 绑定窗口截止时间(ms);null = 未在绑定。 */
  bindUntilAt: number | null
  /** 绑定窗口内收到的第一个聊天 ID(等待桌面端主人确认);null = 还没收到。 */
  bindOffer: number | null
  /** 最近一次失败(成功后清除);null = 最近无失败。 */
  lastError: { at: number; action: string; detail: string } | null
  /** 最近一次收到消息的时间(ms);从未收到为 null。 */
  lastIncomingAt: number | null
  /** 最近被拒绝的聊天(未授权;桌面端设置里可看到,方便把本人 ID 加入白名单)。 */
  deniedChats: Array<{ id: number; at: number }>
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id?: number
    chat?: { id?: number; type?: string }
    from?: { id?: number }
    text?: string
    caption?: string
    photo?: Array<{ file_id: string; file_size?: number }>
  }
}

/** 绑定窗口时长:给桌面端主人足够时间在 Telegram 里发一条消息。 */
const BIND_WINDOW_MS = 90 * 1000
const MAX_DENIED = 8

export class TelegramBotAdapter {
  private started = false
  private stopPolling = false
  private offset = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private bindUntilAt: number | null = null
  private bindOffer: number | null = null
  private lastError: { at: number; action: string; detail: string } | null = null
  private lastIncomingAt: number | null = null
  private deniedChats: Array<{ id: number; at: number }> = []

  constructor(
    private config: ConfigStore,
    private processor: RemoteCommandProcessor,
  ) {}

  getConfig(): TelegramConfig {
    return this.config.get().telegram
  }

  setConfig(patch: Partial<TelegramConfig>): TelegramConfig {
    const next = this.config.update('telegram', patch)
    this.processor.setAutoChat('telegram', next.autoChat === true)
    this.processor.setReport('telegram', next.report === true)
    if (patch.allowedUserIds !== undefined && (patch.allowedUserIds ?? '').trim() !== '') {
      // 白名单生效即关闭绑定窗口(主人已确认)。
      this.bindOffer = null
      this.bindUntilAt = null
    }
    void this.restart()
    return next
  }

  isStarted(): boolean {
    return this.started
  }

  /** 通道自检信息(「状态」指令、桌面端设置页与诊断导出共用)。 */
  diag(): TelegramDiagState {
    const config = this.getConfig()
    const unlocked = (config.allowedUserIds ?? '').trim() !== ''
    return {
      configured: config.enabled && config.token.trim() !== '',
      started: this.started,
      locked: config.enabled && config.token.trim() !== '' && !unlocked,
      bindUntilAt: this.bindUntilAt,
      bindOffer: this.bindOffer,
      lastError: this.lastError,
      lastIncomingAt: this.lastIncomingAt,
      deniedChats: [...this.deniedChats],
    }
  }

  /** 开始「绑定我的 ID」窗口:90 秒内收到的第一条私聊消息的 ID 回传桌面端。 */
  bindStart(): { ok: boolean; message: string } {
    const config = this.getConfig()
    if (!config.enabled || config.token.trim() === '') {
      return { ok: false, message: '请先启用并填入 Bot Token' }
    }
    if ((config.allowedUserIds ?? '').trim() !== '') {
      return { ok: false, message: '已配置允许的用户 ID,无需绑定' }
    }
    this.bindOffer = null
    this.bindUntilAt = Date.now() + BIND_WINDOW_MS
    if (!this.started) void this.start()
    return { ok: true, message: '绑定窗口已开启(90 秒):现在用你的 Telegram 打开这个机器人,随便发一条消息(如 /start)' }
  }

  /** 取消绑定窗口(机器人回到锁定状态,不服务任何人)。 */
  bindCancel(): { ok: boolean; message: string } {
    this.bindOffer = null
    this.bindUntilAt = null
    void this.restart()
    return { ok: true, message: '已取消绑定(机器人保持锁定)' }
  }

  /** 记录一次失败(自检用)。 */
  private noteError(action: string, error: unknown): void {
    this.lastError = { at: Date.now(), action, detail: (error instanceof Error ? error.message : String(error)).slice(0, 240) }
  }

  private clearError(): void {
    this.lastError = null
  }

  private rememberDenied(chatId: number): void {
    this.deniedChats = [...this.deniedChats.filter((item) => item.id !== chatId), { id: chatId, at: Date.now() }].slice(-MAX_DENIED)
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  /** 是否应运行轮询:启用且有 token,且(已填白名单 或 处于绑定窗口)。 */
  private shouldRun(): boolean {
    const config = this.getConfig()
    if (!config.enabled || config.token.trim() === '') return false
    if ((config.allowedUserIds ?? '').trim() !== '') return true
    return this.bindUntilAt !== null && Date.now() < this.bindUntilAt
  }

  async start(): Promise<void> {
    if (this.started) return
    const config = this.getConfig()
    this.processor.setAutoChat('telegram', config.autoChat === true)
    this.processor.setReport('telegram', config.report === true)
    if (!config.enabled || config.token.trim() === '') {
      console.log('[telegram] 未配置或未启用,跳过')
      return
    }
    if ((config.allowedUserIds ?? '').trim() === '' && !(this.bindUntilAt !== null && Date.now() < this.bindUntilAt)) {
      // 安全门:没有主人 ID 白名单时保持锁定,不启动轮询(连消息都不接收)。
      console.log('[telegram] 安全锁定:未配置「允许的用户 ID」,机器人不服务任何聊天。请在桌面端设置中绑定你的 ID')
      this.started = false
      return
    }
    this.started = true
    this.stopPolling = false
    void this.poll()
    console.log('[telegram] Telegram 机器人已启动(长轮询)')
  }

  stop(): void {
    this.started = false
    this.stopPolling = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 主动推送一条消息给指定聊天(任务完成通知/审批提醒等)。 */
  async sendMessage(chatId: string | number, text: string): Promise<void> {
    const config = this.getConfig()
    if (!this.started || config.token.trim() === '') return
    for (let index = 0; index < text.length; index += 1500) {
      const url = `https://api.telegram.org/bot${config.token.trim()}/sendMessage`
      const body = { chat_id: Number(chatId), text: text.slice(index, index + 1500), disable_web_page_preview: true }
      try {
        const response = await net.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        })
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          throw new Error(`HTTP ${response.status}:${raw.slice(0, 200)}`)
        }
      } catch (error) {
        console.error('[telegram] 推送失败:', error)
        this.noteError('推送失败', error)
        return
      }
    }
    this.clearError()
  }

  // ---- 内部 ----

  private allowed(userId: number): boolean {
    const config = this.getConfig()
    const list = (config.allowedUserIds ?? '').trim()
    if (list === '') return false
    return list.split(',').map((s) => s.trim()).includes(String(userId))
  }

  private async poll(): Promise<void> {
    if (!this.started || this.stopPolling) return
    if (!this.shouldRun()) {
      // 锁定条件出现(如绑定窗口超时且白名单仍空):停止轮询并进入锁定态。
      this.started = false
      console.log('[telegram] 绑定窗口结束且未配置用户 ID,机器人回到锁定状态')
      return
    }
    const config = this.getConfig()
    const token = config.token.trim()
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${this.offset}`
      const response = await net.fetch(url, { signal: AbortSignal.timeout(40000) })
      if (!response.ok) {
        const text = await response.text()
        if (/unauthorized|token/i.test(text)) {
          console.error('[telegram] 令牌无效:', text.slice(0, 200))
          this.noteError('令牌无效', new Error(text.slice(0, 200)))
          this.started = false
          return
        }
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json() as { ok: boolean; result: TelegramUpdate[] }
      if (data.ok) {
        for (const update of data.result) {
          this.offset = Math.max(this.offset, update.update_id + 1)
          // 逐条异步处理(回复/推送可能较慢),不阻塞轮询循环。
          void this.handleUpdate(update).catch((error) => {
            console.error('[telegram] 更新处理失败:', error instanceof Error ? error.message : String(error))
          })
        }
      }
    } catch (error) {
      if (!this.stopPolling) {
        console.error('[telegram] 轮询错误(稍后重试):', error instanceof Error ? error.message : String(error))
      }
    }
    if (this.stopPolling || !this.shouldRun()) {
      this.started = false
      return
    }
    this.timer = setTimeout(() => void this.poll(), 1000)
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    const chat = message?.chat
    const chatId = typeof chat?.id === 'number' ? chat.id : 0
    if (chatId === 0) return
    const fromId = typeof message?.from?.id === 'number' ? message.from.id : chatId
    const text = (message?.text ?? message?.caption ?? '').trim()
    const hasPhoto = Array.isArray(message?.photo) && message.photo.length > 0
    this.lastIncomingAt = Date.now()
    // 群聊(含超级群)一律忽略:只认桌面端主人配置的私聊 ID,群里任何人都可能
    // 触发对话/蹭额度,还可能把本群内容写进会话历史。
    const isPrivate = chat?.type === undefined || chat.type === 'private'
    if (!isPrivate) return

    // 绑定窗口:只把第一条私聊消息的 ID 报给桌面端,不执行任何指令。
    if (this.bindUntilAt !== null && Date.now() < this.bindUntilAt) {
      if (this.bindOffer === null) {
        this.bindOffer = chatId
        console.log(`[telegram] 绑定窗口收到消息,ID=${chatId} 等待桌面端确认`)
        await this.sendMessage(chatId, '✅ 已收到你的消息,绑定请求已送达电脑桌面端。\n请在桌面端「设置 → Telegram 机器人」点「确认填入并启动」。').catch(() => {})
      }
      return
    }
    // 锁定期(白名单为空且不在绑定窗口):不应发生(轮询已停),防御性静默。
    if (!this.allowed(chatId)) {
      if ((this.getConfig().allowedUserIds ?? '').trim() !== '') {
        // 已解锁但该 ID 未授权:回复提示,并在桌面端记录(方便主人核对是不是自己)。
        this.rememberDenied(chatId)
        await this.sendMessage(chatId,
          '⚠️ 未授权:本机器人只允许桌面端主人配置的用户 ID。\n' +
          '若这是你自己的机器人:在电脑端「设置 → Telegram 机器人」把下面这个 ID 加入「允许的用户 ID」:\n' +
          `<code>${chatId}</code>`).catch(() => {})
      }
      return
    }
    if (text === '' && !hasPhoto) return

    // 图片(私聊授权用户):下载后随消息发给 agent 做图片理解。
    const image = hasPhoto ? await this.fetchPhoto(message) : undefined
    // 斜杠指令做轻量中英映射(BotFather 用户习惯 /help 等)。
    let sendText = text
    if (sendText !== '' && sendText.startsWith('/')) {
      const mapped = mapSlashCommand(sendText)
      if (mapped === null) {
        await this.sendMessage(chatId, '未知指令。\n发 /help 查看指令集,或直接发消息聊天(默认对话模式)。').catch(() => {})
        return
      }
      sendText = mapped
    }
    await this.processText(fromId, sendText, chatId, image)
  }

  private async processText(fromId: number, text: string, chatId: number, image?: { mime: string; data: string }): Promise<void> {
    try {
      const reply = await this.processor.handleText('telegram', String(fromId), text, undefined, image)
      if (reply !== '') await this.sendMessage(chatId, reply)
    } catch (error) {
      console.error('[telegram] 命令处理失败:', error)
      this.noteError('命令处理失败', error)
    }
  }

  /** 下载 Telegram 图片(photo 取最大尺寸),返回 base64 供 agent 理解。 */
  private async fetchPhoto(message: NonNullable<TelegramUpdate['message']>): Promise<{ mime: string; data: string } | undefined> {
    const photos = message.photo
    if (!Array.isArray(photos) || photos.length === 0) return undefined
    const token = this.getConfig().token.trim()
    if (token === '') return undefined
    const fileId = photos[photos.length - 1].file_id
    try {
      const metaRes = await net.fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(15000) })
      if (!metaRes.ok) return undefined
      const meta = await metaRes.json() as { ok?: boolean; result?: { file_path?: string } }
      const filePath = meta.result?.file_path
      if (typeof filePath !== 'string' || filePath === '') return undefined
      const fileRes = await net.fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30000) })
      if (!fileRes.ok) return undefined
      const buf = Buffer.from(await fileRes.arrayBuffer())
      if (buf.length > 10 * 1024 * 1024) return undefined
      const type = fileRes.headers.get('content-type') ?? ''
      const mime = /^image\/(jpeg|png|webp|gif)$/.test(type) ? type : 'image/jpeg'
      return { mime, data: buf.toString('base64') }
    } catch (error) {
      console.error('[telegram] 图片下载失败:', error)
      return undefined
    }
  }
}

/** BotFather 常见斜杠指令 → 中文指令映射;普通消息原样返回;未知斜杠指令返回 null。 */
function mapSlashCommand(text: string): string | null {
  if (!text.startsWith('/')) return text
  const space = text.search(/\s/)
  const token = (space < 0 ? text : text.slice(0, space)).toLowerCase().replace(/@[a-z0-9_]+$/i, '')
  const rest = space < 0 ? '' : text.slice(space).trim()
  const table: Record<string, string> = {
    '/start': '帮助',
    '/help': '帮助',
    '/status': '状态',
    '/usage': '用量',
    '/sessions': '会话',
    '/workspaces': '工作区',
    '/models': '模型',
    '/progress': '进展',
    '/export': '导出',
  }
  const mapped = table[token]
  if (mapped === undefined) return null
  return rest === '' ? mapped : `${mapped} ${rest}`
}
