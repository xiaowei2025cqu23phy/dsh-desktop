/**
 * Telegram 机器人通道:通过 Bot API 长轮询接收私聊消息,
 * 转发给统一命令处理器(RemoteCommandProcessor)。
 *
 * 零依赖(仅用全局 fetch);支持主动推送(任务完成通知等,后续可扩展)。
 * 配置:enabled、token(BotFather 获取)、allowedUserIds(逗号分隔,空=允许所有)。
 */

import type { ConfigStore } from './config'
import type { RemoteCommandProcessor } from './remote-commands'

export interface TelegramConfig {
  enabled: boolean
  token: string
  /** 允许使用的用户 ID(逗号分隔;空 = 允许所有)。 */
  allowedUserIds: string
}

export class TelegramBotAdapter {
  private started = false
  private stopPolling = false
  private offset = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private config: ConfigStore,
    private processor: RemoteCommandProcessor,
  ) {}

  getConfig(): TelegramConfig {
    return this.config.get().telegram
  }

  setConfig(patch: Partial<TelegramConfig>): TelegramConfig {
    const next = this.config.update('telegram', patch)
    void this.restart()
    return next
  }

  isStarted(): boolean {
    return this.started
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  async start(): Promise<void> {
    if (this.started) return
    const config = this.getConfig()
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

  /** 主动推送一条消息给指定用户(可用于任务完成通知)。 */
  async sendMessage(chatId: string | number, text: string): Promise<void> {
    const config = this.getConfig()
    if (!this.started || config.token.trim() === '') return
    for (let index = 0; index < text.length; index += 1500) {
      const url = `https://api.telegram.org/bot${config.token.trim()}/sendMessage`
      const body = { chat_id: Number(chatId), text: text.slice(index, index + 1500) }
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        console.error('[telegram] 推送失败:', error)
        return
      }
    }
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
      const response = await fetch(url)
      if (!response.ok) {
        const text = await response.text()
        if (/unauthorized|token/i.test(text)) {
          console.error('[telegram] 令牌无效:', text.slice(0, 200))
          this.started = false
          return
        }
        throw new Error(`HTTP ${response.status}`)
      }
      const data = await response.json() as {
        ok: boolean
        result: Array<{
          update_id: number
          message?: {
            chat: { id: number }
            from?: { id: number }
            text?: string
          }
        }>
      }
      if (data.ok) {
        for (const update of data.result) {
          this.offset = Math.max(this.offset, update.update_id + 1)
          const message = update.message
          if (message === undefined) continue
          if (!this.allowed(message.chat.id)) continue
          if (typeof message.text !== 'string' || message.text.trim() === '') continue
          const fromId = message.from?.id ?? message.chat.id
          void this.processor.handleText('telegram', String(fromId), message.text)
            .then((reply) => this.sendMessage(message.chat.id, reply))
            .catch((error) => {
              console.error('[telegram] 命令处理失败:', error)
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
}
