/**
 * Telegram 机器人通道:通过 Bot API 长轮询接收消息,
 * 转发给统一命令处理器(RemoteCommandProcessor)。
 *
 * 零依赖(仅用 Electron net.fetch,自动跟随系统代理);支持主动推送(任务完成通知等)。
 * 配置:enabled、token(BotFather 获取)、allowedUserIds(逗号分隔,空=允许所有)。
 *
 * 安全边界:私聊消息会执行完整指令集(等于远程控制电脑),因此默认要求
 * allowedUserIds 填写;群聊与 QQ 一致只聊天、不解析命令(防止群成员远程操控)。
 */

import { net } from 'electron'
import type { ConfigStore } from './config'
import type { RemoteCommandProcessor } from './remote-commands'

export interface TelegramConfig {
  enabled: boolean
  token: string
  /** 允许使用的用户 ID(逗号分隔;空 = 允许所有)。 */
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
  /** 是否正在长轮询(令牌有效且轮询循环存活)。 */
  started: boolean
  /** 最近一次失败(成功后清除);null = 最近无失败。 */
  lastError: { at: number; action: string; detail: string } | null
  /** 最近一次收到消息的时间(ms);从未收到为 null。 */
  lastIncomingAt: number | null
  /** 最近被拒绝的聊天(未授权;桌面端设置里可看到,方便把本人 ID 加入白名单)。 */
  deniedChats: Array<{ id: number; at: number; kind: 'user' | 'group' }>
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id?: number
    chat?: { id?: number; type?: string }
    from?: { id?: number }
    text?: string
  }
}

const MAX_DENIED = 8

export class TelegramBotAdapter {
  private started = false
  private stopPolling = false
  private offset = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastError: { at: number; action: string; detail: string } | null = null
  private lastIncomingAt: number | null = null
  private deniedChats: Array<{ id: number; at: number; kind: 'user' | 'group' }> = []

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
    void this.restart()
    return next
  }

  isStarted(): boolean {
    return this.started
  }

  /** 通道自检信息(「状态」指令、桌面端设置页与诊断导出共用)。 */
  diag(): TelegramDiagState {
    const config = this.getConfig()
    return {
      configured: config.enabled && config.token.trim() !== '',
      started: this.started,
      lastError: this.lastError,
      lastIncomingAt: this.lastIncomingAt,
      deniedChats: [...this.deniedChats],
    }
  }

  /** 记录一次失败(自检用)。 */
  private noteError(action: string, error: unknown): void {
    this.lastError = { at: Date.now(), action, detail: (error instanceof Error ? error.message : String(error)).slice(0, 240) }
  }

  private clearError(): void {
    this.lastError = null
  }

  private rememberDenied(chatId: number, kind: 'user' | 'group'): void {
    this.deniedChats = [...this.deniedChats.filter((item) => item.id !== chatId), { id: chatId, at: Date.now(), kind }].slice(-MAX_DENIED)
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
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
    if (config.allowedUserIds.trim() === '') return true
    return config.allowedUserIds.split(',').map((s) => s.trim()).includes(String(userId))
  }

  private async poll(): Promise<void> {
    if (!this.started || this.stopPolling) return
    const config = this.getConfig()
    const token = config.token.trim()
    if (!config.enabled || token === '') {
      this.started = false
      return
    }
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
    if (this.stopPolling) return
    this.timer = setTimeout(() => void this.poll(), 1000)
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    const chat = message?.chat
    const chatId = typeof chat?.id === 'number' ? chat.id : 0
    if (chatId === 0) return
    const fromId = typeof message?.from?.id === 'number' ? message.from.id : chatId
    const text = typeof message?.text === 'string' ? message.text.trim() : ''
    const isPrivate = chat?.type === undefined || chat.type === 'private'
    this.lastIncomingAt = Date.now()
    // 忽略非文本消息(图片/文件/语音等暂不支持)。
    if (text === '') return

    // 群聊(含超级群):只聊天、不解析命令 —— 群里任何人都可能触发命令,等于把电脑
    // 交给群成员远程操控。群消息按发送者是否被允许判断(群聊本身无命令,风险可控)。
    if (!isPrivate) {
      if (!this.allowed(fromId)) {
        this.rememberDenied(chatId, 'group')
        await this.sendMessage(chatId, '⚠️ 本机器人仅对受信任成员开放。\n如需使用,请让管理员在电脑端「设置 → Telegram 机器人 → 允许的用户 ID」中加入你的 ID。').catch(() => {})
        return
      }
      // 与 QQ 群一致的对话语义:处理器对群消息只走纯对话(含安全提醒)。
      const target: { scope: 'group'; targetId: string } = { scope: 'group', targetId: String(chatId) }
      await this.processText(fromId, text, target, chatId)
      return
    }

    if (!this.allowed(chatId)) {
      // 私聊 = 完整指令集(远程控制电脑),必须显式授权;顺手把 ID 报给桌面端用户方便加入白名单。
      this.rememberDenied(chatId, 'user')
      await this.sendMessage(chatId,
        '⚠️ 未授权:本机器人只允许指定用户使用。\n' +
        '请让管理员在电脑端「设置 → Telegram 机器人 → 允许的用户 ID」中加入:\n' +
        `<code>${chatId}</code>\n\n` +
        '(若这是你自己的机器人:在 Telegram 里向 @userinfobot 发送任意消息即可查到这个 ID)').catch(() => {})
      return
    }

    // 斜杠指令做轻量中英映射(BotFather 用户习惯 /help 等)。
    const mapped = mapSlashCommand(text)
    if (mapped === null) {
      await this.sendMessage(chatId, '未知指令。\n发 /help 查看指令集,或直接发消息聊天(默认对话模式)。').catch(() => {})
      return
    }
    await this.processText(fromId, mapped, undefined, chatId)
  }

  private async processText(fromId: number, text: string, target: { scope: 'group'; targetId: string } | undefined, chatId: number): Promise<void> {
    try {
      const reply = await this.processor.handleText('telegram', String(fromId), text, target)
      if (reply !== '') await this.sendMessage(chatId, reply)
    } catch (error) {
      console.error('[telegram] 命令处理失败:', error)
      this.noteError('命令处理失败', error)
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
