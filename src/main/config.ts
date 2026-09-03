/**
 * 应用配置持久化(userData/config.json)。
 * 配置项:harness 托管、AI 屏保、窗口尺寸。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LocalDb } from './db'

export interface HarnessConfig {
  /** auto: 先探测已运行实例,没有则托管启动;external: 只连接外部地址;managed: 始终自己启动。 */
  mode: 'auto' | 'external' | 'managed'
  /** external 模式下的服务地址。 */
  url: string
  /** managed/auto 模式下监听的端口。 */
  port: number
  /** 托管启动命令模板,{port} 会被替换为实际端口。 */
  command: string
  /** 应用启动时自动启动托管服务。 */
  autoStart: boolean
  /** 托管进程意外退出后自动重启。 */
  restartOnCrash: boolean
  /** 退出应用时关闭托管服务。 */
  stopOnQuit: boolean
  /** 可选的 DSH_HOME 环境变量覆盖。 */
  dshHome: string | null
  /** 托管进程的工作目录(agent 无工作区任务的默认落点);空 = 主目录下的 dsh-workspace。 */
  cwd: string | null
}

/** 预览实例(实验版 harness):与主实例并存,独立端口/DSH_HOME,webview 可切换查看。 */
export interface PreviewConfig {
  /** 启用预览实例(启动时自动拉起)。 */
  enabled: boolean
  /** 外部地址(external/auto 模式下探测用)。 */
  url: string
  /** 预览实例端口。 */
  port: number
  /** 启动命令模板({port} 占位);默认与主实例相同,改成本地构建路径即预览实验版。 */
  command: string
  /** 独立 DSH_HOME(建议与主实例分开,会话互不污染)。 */
  dshHome: string | null
  /** 预览实例工作目录(agent 产物落点)。 */
  cwd: string | null
  restartOnCrash: boolean
  stopOnQuit: boolean
}

/** 从预览配置派生 HarnessManager 需要的配置。 */
export function previewHarnessConfig(p: PreviewConfig): HarnessConfig {
  return {
    mode: 'auto',
    url: p.url,
    port: p.port,
    command: p.command,
    autoStart: p.enabled,
    restartOnCrash: p.restartOnCrash,
    stopOnQuit: p.stopOnQuit,
    dshHome: p.dshHome,
    cwd: p.cwd,
  }
}

export interface ScreensaverConfig {
  /** 空闲检测开启。 */
  enabled: boolean
  /** 空闲多少分钟后进入 AI 屏保。 */
  idleMinutes: number
  /** 进入屏保时自动启动一个 agent 任务(默认关闭:空闲只显示环境画面,不烧资源)。 */
  autoTask: boolean
  /** 自动任务提示词。 */
  taskPrompt: string
  /** 任务工作目录(空则使用 harness 默认)。 */
  taskCwd: string | null
  /** 任务最长运行分钟数,超时自动停止(防止 agent 失控循环烧 CPU)。 */
  taskMaxMinutes: number
  /** 退出屏保后保留任务继续在后台运行。 */
  keepSessionAfterExit: boolean
  /** 注册系统屏保前备份的原注册表值,取消注册时恢复。内部字段,不暴露给 UI。 */
  systemScreensaverBackup: Record<string, string> | null
}

export interface AppearanceConfig {
  /** 主窗口壁纸(裁剪后的图片 + cover 布设偏移)。 */
  window: WallpaperSpec
  /** 手机端 PWA 壁纸。 */
  phone: WallpaperSpec
  /** 屏保壁纸。 */
  screensaver: WallpaperSpec
  /** 壁纸遮罩强度 0~0.9(保证文字可读)。 */
  mask: number
}

export interface WallpaperSpec {
  /** 壁纸文件路径(裁剪后的成品,null = 默认深色)。 */
  path: string | null
  /** cover 模式下布设偏移(0~1,0.5 = 居中)。 */
  position: { x: number; y: number }
}

export interface RemoteConfig {
  /** 局域网远程网关开关。 */
  enabled: boolean
  /** 网关监听端口。 */
  port: number
  /** Bearer 令牌(首次启用时自动生成)。 */
  token: string
  /** 远程访问过期时间;null 表示不自动过期(不建议长期启用)。 */
  expiresAt: number | null
  /** 已获得桌面批准的远程设备。 */
  approvedDevices: Array<{ id: string; label: string; address: string; approvedAt: number; lastSeenAt: number }>
  /** 等待桌面批准的远程设备。 */
  pendingDevices: Array<{ id: string; label: string; address: string; requestedAt: number; lastSeenAt: number }>
  /**
   * 预设工作区根目录:手机端只能在这些目录下新建文件夹工作区并发布任务;
   * 已有工作区(含电脑端创建的)不受限,均可选择。
   */
  presetWorkspaceRoots: string[]
}

export interface QQBotConfig {
  /** QQ 机器人开关(需在 QQ 开放平台注册并填入 appId/appSecret)。 */
  enabled: boolean
  /** QQ 开放平台机器人 AppID。 */
  appId: string
  /** QQ 开放平台机器人 AppSecret。 */
  appSecret: string
  /**
   * QQ 任务默认工作区/目录:任务命令未指定 @工作区 或 目录: 时使用。
   * 填目录路径(含 / 或 \)按 cwd 处理,否则按工作区标题/ID 匹配。
   */
  defaultTarget: string
  /** 默认对话模式:非指令消息自动进入纯对话(无需先发「进入」)。 */
  autoChat: boolean
  /** 主动汇报:机器人发起的任务完成/失败时主动推送通知。 */
  report: boolean
}

export interface TelegramConfig {
  /** Telegram 机器人开关(需向 @BotFather 申请 token)。 */
  enabled: boolean
  /** BotFather 颁发的机器人 token。 */
  token: string
  /**
   * 允许的用户 ID(逗号分隔)。**留空 = 锁定**:机器人不服务任何聊天、不执行任何指令
   * (私聊等于远程操控电脑,只允许桌面端主人自己的 ID;首次使用走「绑定我的 ID」流程)。
   */
  allowedUserIds: string
  /** 默认对话模式:非指令消息自动进入纯对话(无需先发「进入」)。 */
  autoChat: boolean
  /** 主动汇报:机器人发起的任务完成/失败时主动推送通知。 */
  report: boolean
}

export interface UpdaterConfig {
  /** 启动后自动检查新版本。 */
  autoCheck: boolean
}

export interface BotPromptConfig {
  /** 工作模式(任务/指令)提示词:agent 以助手身份工作。空 = 不注入。 */
  taskPrompt: string
  /** 对话模式提示词:agent 以朋友身份聊天。空 = 不注入。 */
  chatPrompt: string
  /** 自定义角色设定(对话模式时叠加在 chatPrompt 前);空 = 不启用。 */
  character: string
}

export interface UsageConfig {
  /** 费用倍率(1 = 官方价;自定义中转站可按实际价格调整)。 */
  multiplier: number
  /** 输入单价 ¥/百万 token(默认 DeepSeek 官方价)。 */
  inputPricePerM: number
  /** 输出单价 ¥/百万 token(默认 DeepSeek 官方价)。 */
  outputPricePerM: number
  /** 缓存命中单价 ¥/百万 token(默认 DeepSeek 官方价)。 */
  cachePricePerM: number
}

export interface ActivityRecord {
  id: string
  type: 'task' | 'chat' | 'scheduled' | 'screensaver' | 'workflow'
  source: 'desktop' | 'pwa' | 'qq' | 'telegram' | 'system'
  workspace: string | null
  sessionId: string | null
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  title: string
  lastEvent: string
  createdAt: number
  updatedAt: number
}

export interface WorkspaceMemory {
  enabled: boolean
  summary: string
  conventions: string
  commands: string
  notes: string
  updatedAt: number
}

export interface AuditEntry {
  id: string
  time: number
  type: string
  sessionId?: string
  activityId?: string
  detail: string
}

export interface NotificationConfig {
  enabled: boolean
  approval: boolean
  question: boolean
  taskDone: boolean
  taskFail: boolean
  /** 发现新版本可用时提示。 */
  update: boolean
  quietHoursEnabled: boolean
  quietStart: number
  quietEnd: number
  urgentBypassQuiet: boolean
}

export interface TaskQueueEntry {
  id: string
  description: string
  sessionId: string | null
  status: 'queued' | 'running' | 'failed' | 'completed' | 'cancelled'
  attempts: number
  maxAttempts: number
  nextAttemptAt: number | null
  error?: string
  workspace: string | null
  source: string
  channel: string
  userId: string
  pushTarget?: { scope: string; targetId: string } | null
  createdAt: number
  updatedAt: number
}

export interface AppConfig {
  harness: HarnessConfig
  preview: PreviewConfig
  screensaver: ScreensaverConfig
  appearance: AppearanceConfig
  remote: RemoteConfig
  qq: QQBotConfig
  telegram: TelegramConfig
  updater: UpdaterConfig
  window: { width: number; height: number }
  /** 机器人对话模式持久化:channel:userId → 固定对话会话(重启后继续同一会话)。 */
  chatSessions: Record<string, { sessionId: string; label: string }>
  /** 无工作区任务的"默认任务会话"映射(channel:userId → 固定会话;重启后继续复用,不再另开)。 */
  defaultTaskSessions: Record<string, { sessionId: string }>
  /** 已自动命名过的对话会话(进程内去重;重启后保留,避免重复用新首句覆盖标题)。 */
  namedChatSessions: string[]
  bot: BotPromptConfig
  /** 定时任务(桌面端调度,重启保留)。 */
  scheduledTasks: Array<{
    id: string
    channel: string
    userId: string
    pushTarget?: { scope: string; targetId: string } | null
    description: string
    delay: { kind: 'once'; delayMs: number } | { kind: 'daily'; hours: number; minutes: number }
    nextAt: number
  }>
  /** 用量与费用估算配置。 */
  usage: UsageConfig
  /** 任务执行记录,用于队列状态/失败重试/历史展示。 */
  taskHistory: Array<{
    id: string
    description: string
    sessionId: string | null
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    attempts: number
    error?: string
    createdAt: number
    updatedAt: number
  }>
  notifications: NotificationConfig
  /** 任务调度队列(串行执行 + 失败指数退避重试,重启保留)。 */
  taskQueue: TaskQueueEntry[]
  /** 跨入口统一活动记录。 */
  activities: ActivityRecord[]
  /** 工作区路径到本地记忆的映射。 */
  workspaceMemories: Record<string, WorkspaceMemory>
  /** 本地审计时间线,不含模型请求正文。 */
  auditLog: AuditEntry[]
}

const DEFAULTS: AppConfig = {
  harness: {
    mode: 'auto',
    url: 'http://127.0.0.1:3080',
    port: 3080,
    command: 'npx --yes @deepseek-ai/dsh web --port {port}',
    autoStart: true,
    restartOnCrash: true,
    stopOnQuit: true,
    dshHome: null,
    // 默认工作目录:独立目录,避免 agent 把产物写进应用安装目录或主目录。
    cwd: join(homedir(), 'dsh-workspace'),
  },
  preview: {
    enabled: false,
    url: 'http://127.0.0.1:3081',
    port: 3081,
    command: 'npx --yes @deepseek-ai/dsh web --port {port}',
    dshHome: join(homedir(), '.dsh-preview'),
    cwd: join(homedir(), 'dsh-preview-workspace'),
    restartOnCrash: true,
    stopOnQuit: true,
  },
  screensaver: {
    enabled: false,
    idleMinutes: 5,
    autoTask: false,
    taskPrompt:
      '你是运行在 AI 屏保中的 DeepSeek Harness 智能体。请自主完成一项有价值的任务,例如:浏览今天的科技新闻并整理要点、构思一段创意文字、分析当前工作区代码给出改进建议。完成后用简洁的中文总结你做了什么。',
    taskCwd: null,
    taskMaxMinutes: 10,
    keepSessionAfterExit: true,
    systemScreensaverBackup: null,
  },
  appearance: {
    window: { path: null, position: { x: 0.5, y: 0.5 } },
    phone: { path: null, position: { x: 0.5, y: 0.5 } },
    screensaver: { path: null, position: { x: 0.5, y: 0.5 } },
    mask: 0.55,
  },
  remote: {
    enabled: false,
    port: 3082,
    token: '',
    expiresAt: null,
    approvedDevices: [],
    pendingDevices: [],
    presetWorkspaceRoots: [],
  },
  qq: {
    enabled: false,
    appId: '',
    appSecret: '',
    defaultTarget: '',
    autoChat: false,
    report: false,
  },
  telegram: {
    enabled: false,
    token: '',
    allowedUserIds: '',
    autoChat: false,
    report: false,
  },
  updater: {
    autoCheck: true,
  },
  window: { width: 1280, height: 800 },
  chatSessions: {},
  defaultTaskSessions: {},
  namedChatSessions: [],
  scheduledTasks: [],
  bot: {
    taskPrompt: '你是一个专业、高效的 AI 助手。执行任务时请条理清晰、直接给出可用的结果,必要时说明关键步骤。',
    chatPrompt: '你现在是用户的朋友。请用轻松、亲切、口语化的语气聊天,像朋友一样自然,不要过于正式。',
    character: '',
  },
  usage: {
    multiplier: 1,
    inputPricePerM: 2,
    outputPricePerM: 8,
    cachePricePerM: 0.5,
  },
  taskHistory: [],
  notifications: { enabled: true, approval: true, question: true, taskDone: true, taskFail: true, update: true, quietHoursEnabled: false, quietStart: 22, quietEnd: 8, urgentBypassQuiet: true },
  taskQueue: [],
  activities: [],
  workspaceMemories: {},
  auditLog: [],
}

export class ConfigStore {
  private config: AppConfig
  private readonly path: string
  private readonly db: LocalDb

  constructor() {
    this.path = join(app.getPath('userData'), 'config.json')
    this.config = this.load()
    this.db = new LocalDb(app.getPath('userData'))
    this.migrateLegacyData()
  }

  /** 首次启用 SQLite 时,把旧 JSON 中的活动/审计/队列一次性导入,之后数据源切换为 local.db。 */
  private migrateLegacyData(): void {
    if (this.config.activities.length === 0 && this.config.auditLog.length === 0 && this.config.taskQueue.length === 0) return
    this.db.migrateFromLegacy(this.config.activities, this.config.auditLog, this.config.taskQueue)
    if (this.db.activities().length > 0 || this.db.auditList().length > 0 || this.db.taskQueue().length > 0) {
      // 导入成功后清空 JSON 中的重复数据,避免双重维护。
      this.config.activities = []
      this.config.auditLog = []
      this.config.taskQueue = []
      this.save()
    }
  }

  private load(): AppConfig {
    try {
      if (!existsSync(this.path)) return structuredClone(DEFAULTS)
      // 剥离 UTF-8 BOM:PowerShell/部分编辑器保存的 JSON 可能带 BOM,JSON.parse 不接受。
      const text = readFileSync(this.path, 'utf8').replace(/^\uFEFF/, '')
      const raw = JSON.parse(text) as Partial<AppConfig>
      const config = this.merge(DEFAULTS, raw)
      // 兼容旧版本扁平字段(windowWallpaper/screensaverWallpaper → 新结构)。
      const legacy = (raw.appearance ?? {}) as {
        windowWallpaper?: string | null
        screensaverWallpaper?: string | null
      }
      if (config.appearance.window.path === null && typeof legacy.windowWallpaper === 'string') {
        config.appearance.window.path = legacy.windowWallpaper
      }
      if (config.appearance.screensaver.path === null && typeof legacy.screensaverWallpaper === 'string') {
        config.appearance.screensaver.path = legacy.screensaverWallpaper
      }
      // 兼容损坏的数组分区(旧 bug 把数组存成 {0:...} 对象)。
      if (config.scheduledTasks !== null && typeof config.scheduledTasks === 'object' && !Array.isArray(config.scheduledTasks)) {
        config.scheduledTasks = Object.values(config.scheduledTasks as Record<string, never>)
      }
      if (!Array.isArray(config.remote.approvedDevices)) config.remote.approvedDevices = []
      if (!Array.isArray(config.remote.pendingDevices)) config.remote.pendingDevices = []
      if (!Array.isArray(config.taskHistory)) config.taskHistory = []
      if (!Array.isArray(config.taskQueue)) config.taskQueue = []
      if (!Array.isArray(config.activities)) config.activities = []
      if (!Array.isArray(config.auditLog)) config.auditLog = []
      if (config.workspaceMemories === null || typeof config.workspaceMemories !== 'object' || Array.isArray(config.workspaceMemories)) config.workspaceMemories = {}
      return config
    } catch (error) {
      console.error('[config] 配置文件解析失败,使用默认值:', String(error))
      return structuredClone(DEFAULTS)
    }
  }

  private merge<T>(base: T, patch: Partial<T>): T {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === undefined) continue
      const baseValue = (base as Record<string, unknown>)[key]
      if (baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue) &&
          value !== null && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = this.merge(baseValue, value)
      } else {
        out[key] = value
      }
    }
    return out as T
  }

  get(): AppConfig {
    return this.config
  }

  /** 配置文件路径,仅用于本地备份与诊断元数据。 */
  filePath(): string {
    return this.path
  }

  /** 将不含凭据的配置快照写入指定文件。 */
  exportSafe(target: string): void {
    const safe = structuredClone(this.config)
    safe.remote.token = ''
    safe.qq.appSecret = ''
    safe.telegram.token = ''
    writeFileSync(target, JSON.stringify(safe, null, 2), 'utf8')
  }

  /** 从备份恢复非敏感配置,保留当前令牌和机器人凭据。 */
  importSafe(source: string): AppConfig {
    const raw = JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, '')) as Partial<AppConfig>
    const currentSecrets = { remoteToken: this.config.remote.token, qqSecret: this.config.qq.appSecret, telegramToken: this.config.telegram.token }
    const next = this.merge(this.config, raw)
    next.remote.token = currentSecrets.remoteToken
    next.qq.appSecret = currentSecrets.qqSecret
    next.telegram.token = currentSecrets.telegramToken
    this.config = next
    this.save()
    return this.config
  }

  /** 创建带时间戳的脱敏本地配置备份。 */
  backup(): string {
    const target = join(dirname(this.path), `config.backup-safe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    this.exportSafe(target)
    return target
  }

  /** 返回最近活动,供主窗口和 PWA 离线查看(SQLite)。 */
  activities(): ActivityRecord[] {
    return [...this.db.activities()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 更新或创建一条活动(SQLite)。 */
  upsertActivity(activity: ActivityRecord): void {
    this.db.upsertActivity(activity)
  }

  /** 添加本地审计摘要,不记录请求正文(SQLite)。 */
  appendAudit(entry: Omit<AuditEntry, 'id'>): void {
    this.db.appendAudit(entry)
  }

  /** 审计时间线列表(SQLite)。 */
  auditList(): AuditEntry[] {
    return this.db.auditList()
  }

  /** 清空审计时间线(SQLite)。 */
  clearAudit(): void {
    this.db.clearAudit()
  }

  /** 读取指定工作区的本地记忆。 */
  memory(path: string): WorkspaceMemory {
    return this.config.workspaceMemories[path] ?? { enabled: false, summary: '', conventions: '', commands: '', notes: '', updatedAt: 0 }
  }

  /** 保存指定工作区的本地记忆。 */
  setMemory(path: string, memory: WorkspaceMemory): void {
    this.config.workspaceMemories = { ...this.config.workspaceMemories, [path]: { ...memory, updatedAt: Date.now() } }
    this.save()
  }

  /** 删除指定工作区的本地记忆。 */
  clearMemory(path: string): void {
    const memories = { ...this.config.workspaceMemories }
    delete memories[path]
    this.config.workspaceMemories = memories
    this.save()
  }

  /** 任务调度队列(按创建时间排序,活跃项在前;SQLite)。 */
  taskQueue(): TaskQueueEntry[] {
    return this.db.taskQueue()
  }

  /** 更新或插入一条队列项。活跃项全保留;已结束项只留最近 100 条(SQLite)。 */
  upsertTaskQueueEntry(entry: TaskQueueEntry): void {
    this.db.upsertTaskQueueEntry(entry)
  }

  /** 合并指定分区后持久化。数组分区(如 scheduledTasks)整体替换。 */  update<K extends keyof AppConfig>(section: K, patch: Partial<AppConfig[K]>): AppConfig[K] {
    if (Array.isArray(patch)) {
      this.config[section] = patch as never
    } else {
      this.config[section] = this.merge(this.config[section], patch)
    }
    this.save()
    return this.config[section]
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.config, null, 2), 'utf8')
    } catch (error) {
      console.error('[config] 保存失败:', error)
    }
  }

  /** 应用退出时关闭 SQLite 连接。 */
  close(): void {
    this.db.close()
  }
}
