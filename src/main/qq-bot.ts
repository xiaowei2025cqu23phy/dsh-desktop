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
import { parseCommand, parseTaskOptions, type QQCommand } from './qq-commands'

/** 单条 QQ 消息长度上限(保守取平台限制以下)。 */
const MAX_MESSAGE_LENGTH = 1500

/** 对话模式上下文:进入工作区后,非指令消息自动发往该会话。 */
interface ChatContext {
  sessionId: string
  label: string
}

export class QQBotAdapter {
  private bot: { on: (event: string, listener: (...args: unknown[]) => void) => void;
    start: () => Promise<void>; stop: () => void; sendText: (target: unknown, text: string) => Promise<unknown> } | null = null
  private started = false
  /** 按 QQ 发送者维护的对话模式上下文。 */
  private chatContexts = new Map<string, ChatContext>()

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

  /** 完整指令集(未知指令时也回复这份),每条指令带可直接复制的示例。 */
  private fullHelp(): string {
    return [
      'DSH Remote QQ 机器人指令集',
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
      '进入 <工作区名/目录> — 开始对话',
      '  例:进入 qqbot',
      '  例:进入 D:/work/proj',
      '进入后直接发消息,自动在该工作区连续对话:',
      '  例:帮我看看项目里有哪些 TODO',
      '  例:把刚才那个 bug 修了',
      '退出 — 结束对话模式',
      '  例:退出',
      '',
      '📌 会话管理',
      '进展 <会话id> — 任务实时进展',
      '  例:进展 session-xxxxxxxx',
      '停止 <会话id> — 停止任务',
      '  例:停止 session-xxxxxxxx',
      '打开 <会话id> — 查看会话内容',
      '  例:打开 session-xxxxxxxx',
      '',
      '💡 典型流程:先「工作区」看列表 → 「进入 qqbot」→ 连续对话 → 「退出」',
    ].join('\n')
  }

  private async handleMessage(msg: unknown): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    const record = msg as { content?: unknown; replyTarget?: unknown; author?: unknown }
    if (typeof record.content !== 'string') return
    const content = record.content.trim()
    if (content === '') return
    const userId = this.senderId(record)
    let reply: string
    const command = parseCommand(content)
    if (command.kind === 'unknown') {
      // 对话模式:非指令消息直接发给当前工作区会话。
      const ctx = this.chatContexts.get(userId)
      if (ctx !== undefined) {
        reply = await this.cmdChatMessage(userId, content)
      } else {
        // 未识别指令 → 回复完整指令集。
        reply = this.fullHelp()
      }
    } else {
      reply = await this.executeCommand(command, userId)
    }
    await this.reply(bot, record.replyTarget, reply)
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

  private async executeCommand(command: QQCommand, userId: string): Promise<string> {
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
      case 'cancel':
        return this.cmdCancel(command.sessionId)
      case 'open':
        return this.cmdOpen(command.sessionId)
      case 'progress':
        return this.cmdProgress(command.sessionId)
      case 'run':
        return this.cmdRun(command.description)
      case 'enter':
        return this.cmdEnter(userId, command.target)
      case 'exit':
        return this.cmdExit(userId)
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

  /** 任务进展:会话状态 + 工具调用统计 + 最近输出摘要。 */
  private async cmdProgress(sessionId: string): Promise<string> {
    if (!/^session-/.test(sessionId)) return '请提供完整的会话 id(以 session- 开头)'
    const client = this.harness.client()
    try {
      const [list, data] = await Promise.all([
        client.rpc<{ items: Array<{ sessionId: string; running?: boolean; title?: string | null }> }>('session.list', {}, 20000),
        client.rpc<{ events: Array<{ event?: { type?: string; seq?: number; data?: { content?: unknown; name?: unknown; error?: unknown } } }> }>('session.history', { sessionId, maxMessages: 6 }, 30000),
      ])
      const meta = (list.items ?? []).find((s) => s.sessionId === sessionId)
      const events = data.events ?? []
      const toolCalls = events.filter((e) => e.event?.type === 'tool/call').length
      const toolFails = events.filter((e) => e.event?.type === 'tool/result' && e.event.data?.error !== undefined).length
      const assistantTexts: string[] = []
      for (const entry of events) {
        if (entry.event?.type === 'assistant/message' && Array.isArray(entry.event.data?.content)) {
          const text = (entry.event.data.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')
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

  /** 进入工作区对话模式:解析目标(路径或工作区名),创建会话并记住上下文。 */
  private async cmdEnter(userId: string, target: string): Promise<string> {
    if (target === '') return '请指定工作区,例如:进入 qqbot(目录路径也可以)'
    const client = this.harness.client()
    try {
      let workspaceId: string | null = null
      let cwd: string | null = null
      if (/[\\/]/.test(target)) {
        cwd = target
      } else {
        const workspaces = await client.rpc<{ items: Array<{ workspaceId: string; title?: string; path?: string }> }>('workspace.list')
        const found = (workspaces.items ?? []).find((w) => w.title === target || w.workspaceId === target || w.path === target)
        if (found === undefined) {
          return `未找到工作区「${target}」,发送「工作区」查看列表`
        }
        workspaceId = found.workspaceId
        cwd = found.path ?? null
      }
      const payload: Record<string, unknown> = {}
      if (workspaceId !== null) payload.workspaceId = workspaceId
      else if (cwd !== null) payload.cwd = cwd
      const created = await client.rpc<{ sessionId: string }>('session.create', payload)
      this.chatContexts.set(userId, { sessionId: created.sessionId, label: target })
      return [
        `已进入工作区「${target}」对话模式 ✓`,
        `会话: ${created.sessionId}`,
        '现在直接发消息即可对话(无需指令前缀),发送「退出」结束对话模式。',
      ].join('\n')
    } catch (error) {
      return `进入失败:${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 退出对话模式。 */
  private cmdExit(userId: string): string {
    const ctx = this.chatContexts.get(userId)
    if (ctx === undefined) return '当前不在对话模式。'
    this.chatContexts.delete(userId)
    return `已退出工作区「${ctx.label}」对话模式。会话 ${ctx.sessionId} 保留在后台,可发「打开 ${ctx.sessionId}」继续查看。`
  }

  /** 对话模式消息:发送到当前工作区会话。 */
  private async cmdChatMessage(userId: string, text: string): Promise<string> {
    const ctx = this.chatContexts.get(userId)
    if (ctx === undefined) return this.fullHelp()
    const client = this.harness.client()
    try {
      await client.rpc('session.prompt', {
        sessionId: ctx.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
      return `✓ 已发送到「${ctx.label}」(会话 ${ctx.sessionId})\n发「进展 ${ctx.sessionId}」查看进度,「退出」结束对话。`
    } catch (error) {
      return `发送失败:${error instanceof Error ? error.message : String(error)}`
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
