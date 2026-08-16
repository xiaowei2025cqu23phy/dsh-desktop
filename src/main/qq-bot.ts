/**
 * QQ 机器人适配器:通过 @tencent-connect/qqbot-nodejs 接入 QQ 开放平台机器人,
 * 在 QQ 私聊中远程控制电脑上的 harness。
 *
 * 命令(私聊消息,支持纯文本):
 *   帮助 / help          指令列表
 *   状态 / status        harness 状态 + 运行中会话
 *   会话 / sessions      最近 5 个会话
 *   任务 <描述>          创建会话并执行任务(可附加 @<工作区名> 或 目录:<路径>)
 *   停止 <会话id>        停止指定会话
 *   模型 / models        可用模型目录
 *   打开 <会话id>        会话最近内容摘要
 *
 * 配置留空(未填 appId/appSecret)时自动禁用;QQ 官方机器人为被动回复模式,
 * 只能在用户发消息后回复(无法主动推送)。
 */

import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ConfigStore, QQBotConfig } from './config'
import type { HarnessManager } from './harness'
import { parseCommand, parseTaskOptions } from './qq-commands'

/** 单条 QQ 消息长度上限(保守取平台限制以下)。 */
const MAX_MESSAGE_LENGTH = 1500

export class QQBotAdapter {
  private bot: { on: (event: string, listener: (...args: unknown[]) => void) => void;
    start: () => Promise<void>; stop: () => void; sendText: (target: unknown, text: string) => Promise<unknown> } | null = null
  private started = false

  constructor(
    private config: ConfigStore,
    private harness: HarnessManager,
  ) {}

  getConfig(): QQBotConfig {
    return this.config.get().qq
  }

  setConfig(patch: Partial<QQBotConfig>): QQBotConfig {
    const next = this.config.update('qq', patch)
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
  }

  // ---- 内部 ----

  private async handleMessage(msg: unknown): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    const record = msg as { content?: unknown; replyTarget?: unknown }
    if (typeof record.content !== 'string') return
    const content = record.content.trim()
    if (content === '') return
    const reply = await this.executeCommand(content)
    await this.reply(bot, record.replyTarget, reply)
  }

  private async executeCommand(content: string): Promise<string> {
    const command = parseCommand(content)
    switch (command.kind) {
      case 'help':
        return [
          'DSH Remote QQ 机器人指令:',
          '· 状态 — harness 与运行中会话',
          '· 会话 — 最近 5 个会话',
          '· 工作区 — 工作区列表',
          '· 任务 <描述> — 执行任务(可加 @工作区名 或 目录:<路径>)',
          '· 停止 <会话id> — 停止会话',
          '· 打开 <会话id> — 查看会话最近内容',
          '· 模型 — 可用模型列表',
          '示例:任务 分析一下这个仓库的架构',
        ].join('\n')
      case 'status':
        return this.cmdStatus()
      case 'sessions':
        return this.cmdSessions()
      case 'workspaces':
        return this.cmdWorkspaces()
      case 'models':
        return this.cmdModels()
      case 'cancel':
        return this.cmdCancel(command.sessionId)
      case 'open':
        return this.cmdOpen(command.sessionId)
      case 'run':
        return this.cmdRun(command.description)
      default:
        return '未识别的指令,发送「帮助」查看可用指令。'
    }
  }

  private async cmdStatus(): Promise<string> {
    const client = this.harness.client()
    try {
      const host = await client.rpc<{ version?: string; cwd?: string; attachedSessions?: number }>('host.describe')
      const list = await client.rpc<{ items: Array<{ running?: boolean; blank?: boolean }> }>('session.list', {}, 20000)
      const total = (list.items ?? []).length
      const running = (list.items ?? []).filter((s) => s.running === true).length
      return [
        `harness: v${host.version ?? '?'}`,
        `工作目录: ${host.cwd ?? '?'}`,
        `会话: ${total} 个,运行中 ${running} 个`,
        `已附加: ${host.attachedSessions ?? '?'}`,
      ].join('\n')
    } catch (error) {
      return `查询失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async cmdSessions(): Promise<string> {
    const client = this.harness.client()
    try {
      const list = await client.rpc<{ items: Array<{ sessionId: string; title?: string | null; running?: boolean; blank?: boolean }> }>('session.list', {}, 20000)
      const items = (list.items ?? []).slice(0, 5)
      if (items.length === 0) return '暂无会话'
      return items.map((s) =>
        `${s.running ? '▶' : ' '} ${(s.title ?? s.sessionId).slice(0, 30)}${s.blank ? ' (空)' : ''}\n  ${s.sessionId}`,
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
      const data = await client.rpc<{ events: Array<{ event?: { type?: string; data?: { content?: unknown } } }> }>('session.history', { sessionId, maxMessages: 2 }, 30000)
      const events = data.events ?? []
      const assistantTexts: string[] = []
      const userTexts: string[] = []
      for (const entry of events) {
        const type = entry.event?.type
        const content = entry.event?.data?.content
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

  private async cmdRun(description: string): Promise<string> {
    if (description === '') return '任务描述不能为空,示例:任务 分析这个仓库的架构'
    const client = this.harness.client()
    const parsed = parseTaskOptions(description)
    const taskText = parsed.description
    if (taskText === '') return '任务描述不能为空'
    try {
      let workspaceId: string | null = null
      let cwd = parsed.cwd
      // 任务未指定工作区/目录时,回退到配置的默认工作区/目录。
      if (workspaceId === null && cwd === null) {
        const fallback = this.getConfig().defaultTarget.trim()
        if (fallback !== '') {
          if (/[\\/]/.test(fallback)) {
            cwd = fallback
          } else {
            const workspaces = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string }> }>('workspace.list')
            const found = (workspaces.items ?? []).find((w) => w.title === fallback || w.workspaceId === fallback || w.path === fallback)
            if (found === undefined) {
              return `默认工作区「${fallback}」不存在,发送「工作区」查看列表,或在设置中修改 QQ 默认工作区`
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
      await client.rpc('session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: taskText }],
      })
      return `任务已启动 ✓\n会话: ${created.sessionId}\n描述: ${taskText.slice(0, 80)}\n发送「打开 ${created.sessionId}」查看进展`
    } catch (error) {
      return `启动失败:${error instanceof Error ? error.message : String(error)}`
    }
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
