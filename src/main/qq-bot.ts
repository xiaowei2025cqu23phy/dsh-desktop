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

export class QQBotAdapter {
  private bot: { on: (event: string, listener: (...args: unknown[]) => void) => void;
    start: () => Promise<void>; stop: () => void; sendText: (target: unknown, text: string) => Promise<unknown> } | null = null
  private started = false
  /** userId(openid)→ 主动推送目标(登记自最近一次交互)。 */
  private userTargets = new Map<string, { target: PushTarget; ts: number }>()

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
    void this.restart()
    return next
  }

  isStarted(): boolean {
    return this.started
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async start(): Promise<void> {
    if (this.started) return
    const config = this.getConfig()
    this.processor.defaultTarget = config.defaultTarget ?? ''
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
      const sdk = createRequire(__filename)(sdkEntry) as { QQBot: new (options: unknown) => {
        on: (event: string, listener: (...args: unknown[]) => void) => void
        start: () => Promise<void>
        stop: () => void
        sendText: (target: unknown, text: string) => Promise<unknown>
      } }
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
  }

  // ---- 内部 ----

  /** 主动推送一条消息给最近交互过的用户(审批/提问通知;超窗或失败静默降级)。 */
  async sendToUser(userId: string, text: string): Promise<void> {
    const bot = this.bot
    const entry = this.userTargets.get(userId)
    if (bot === null || entry === undefined || text === '') return
    const fresh = Date.now() - entry.ts <= PUSH_WINDOW_MS
    if (!fresh) {
      this.userTargets.delete(userId)
      return
    }
    for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
      try {
        await bot.sendText(entry.target, text.slice(index, index + MAX_MESSAGE_LENGTH))
      } catch (error) {
        console.error('[qq-bot] 主动推送失败(靠下次回复提醒兜底):', error)
        return
      }
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
    const reply = await this.processor.handleText('qq', userId, content)
    await this.reply(bot, record.replyTarget, reply)
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
