/**
 * 应用配置持久化(userData/config.json)。
 * 配置项:harness 托管、AI 屏保、窗口尺寸。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync } from 'node:fs'
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
  /**
   * 官方 0.1.2-rc.1+ 的 launch token:连接**外部已运行实例**时,该服务启动
   * 输出里的 `?token=` 值(托管启动时桌面端自动捕获,留空即可)。
   */
  launchToken: string | null
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
    launchToken: null,
  }
}

export interface ScreensaverConfig {
  /** 空闲检测开启。 */
  enabled: boolean
  /** 空闲多少分钟后进入屏保。 */
  idleMinutes: number
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
  /** 监听地址:0.0.0.0 = 全部网卡(默认);或具体局域网 IP = 只暴露该网卡。 */
  bindHost: string
  /** 用 HTTPS(自签证书)提供远程访问:手机信任证书后才能注册 PWA 离线外壳。 */
  https: boolean
  /** 桌面端一键暂停:临时断开所有远程连接(保留令牌与设备,恢复后原样可用)。 */
  paused: boolean
  /** 锁屏/睡眠时自动暂停远程访问(解锁后需桌面端手动恢复)。 */
  pauseOnLock: boolean
  /** 被桌面端拉黑的设备:令牌正确也拒绝(识别依赖客户端自报的设备标识)。 */
  blacklistedDevices: Array<{ id: string; label: string; address: string; blockedAt: number }>
  /** Bearer 令牌(首次启用时自动生成)。 */
  token: string
  /** 远程访问过期时间;null 表示不自动过期(不建议长期启用)。 */
  expiresAt: number | null
  /** 已连接过的远程设备(paused = 桌面端已暂停该设备;blacklistedDevices 为拉黑名单)。 */
  approvedDevices: Array<{ id: string; label: string; address: string; approvedAt: number; lastSeenAt: number; paused?: boolean }>
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
   * 允许的用户 openid(逗号分隔)。**留空 = 不限制**(放行所有能发消息给机器人的人)。
   *
   * QQ 开放平台的 openid 识别需要企业主体,个人主体拿不到自己的 openid,若留空即锁死
   * 则机器人对普通用户永远不可用。因此留空时的访问控制落在平台侧——必须关闭机器人的
   * 「允许被添加为好友」,见 acknowledgedFriendSetting。
   * 已配置 = 只放行名单内的 openid,其余静默忽略并记入审计/自检。
   */
  allowedUserIds: string
  /**
   * 是否已确认在 QQ 开放平台关闭了机器人的「允许被添加为好友」。
   *
   * 这是 QQ 通道对普通用户(个人主体)唯一可用的访问控制:只有电脑主人能把机器人
   * 加入好友/群,陌生人无法主动私聊。未确认时机器人不启动服务,桌面端首次启用 QQ
   * 时会强制确认一次。
   */
  acknowledgedFriendSetting: boolean
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
  /**
   * 每日预算上限(元,与上面的单价同口径;**0 = 不限额**,默认不限额,不锁住现有用户)。
   * 按**本地日期**跨天重置(不是固定 86400 秒累加);达到 80% 提醒一次,超限按 onExceed 处理。
   */
  dailyBudget: number
  /** 每月预算上限(元;0 = 不限额),按**本地月份**跨月重置。 */
  monthlyBudget: number
  /** 超限动作:notify = 只提醒;block = 提醒并拒绝新的任务启动(机器人 / 队列 / 定时)。 */
  onExceed: 'notify' | 'block'
}

export interface ActivityRecord {
  id: string
  type: 'task' | 'chat' | 'scheduled' | 'screensaver' | 'workflow'
  /**
   * 来源:desktop = 桌面端发起的任务;pwa = 手机 PWA;qq / telegram = 机器人通道;
   * system = 无归属任务;**web = 内嵌 Web UI / 手机网页里直接发起的会话**——这类会话不经过
   * 命令处理器,活动行由事件中枢(见 event-hub.ts)派生,事件流区分不出内嵌页与手机页,
   * 故合并为一种来源。
   */
  source: 'desktop' | 'pwa' | 'qq' | 'telegram' | 'system' | 'web'
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
  /** 首启引导状态(完成后再启动不再显示欢迎引导)。 */
  onboarding: { done: boolean }
}

const DEFAULTS: AppConfig = {
  harness: {
    mode: 'auto',
    url: 'http://127.0.0.1:3080',
    port: 3080,
    // 必须用 next 渠道:@latest(0.1.5-rc.3)的会话格式迁移包只到 v2→v3,
    // 读不了 v4 格式的会话 —— 而较新的 harness(含官方版桌面端自带的 0.1.7 系)
    // 会把会话写成 v4。用 latest 的表现是"最近若干会话在所有端都看不见",
    // 且发生在 harness 层,与本项目各客户端无关。详见 docs/COMPATIBILITY.md。
    command: 'npx --yes @deepseek-ai/dsh@next web --port {port} --no-open',
    autoStart: true,
    restartOnCrash: true,
    stopOnQuit: true,
    dshHome: null,
    // 默认工作目录:独立目录,避免 agent 把产物写进应用安装目录或主目录。
    cwd: join(homedir(), 'dsh-workspace'),
    launchToken: null,
  },
  preview: {
    enabled: false,
    url: 'http://127.0.0.1:3081',
    port: 3081,
    // 同上:预览实例也用 next,避免它与主实例写的会话互不可见。
    command: 'npx --yes @deepseek-ai/dsh@next web --port {port} --no-open',
    dshHome: join(homedir(), '.dsh-preview'),
    cwd: join(homedir(), 'dsh-preview-workspace'),
    restartOnCrash: true,
    stopOnQuit: true,
  },
  screensaver: {
    enabled: false,
    idleMinutes: 5,
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
    bindHost: '0.0.0.0',
    https: false,
    paused: false,
    pauseOnLock: true,
    blacklistedDevices: [],
    token: '',
    expiresAt: null,
    approvedDevices: [],
    presetWorkspaceRoots: [],
  },
  qq: {
    enabled: false,
    appId: '',
    appSecret: '',
    allowedUserIds: '',
    acknowledgedFriendSetting: false,
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
    taskPrompt: '',
    chatPrompt: '你现在是用户的朋友。请用轻松、亲切、口语化的语气聊天,像朋友一样自然,不要过于正式。',
    character: '',
  },
  usage: {
    multiplier: 1,
    inputPricePerM: 2,
    outputPricePerM: 8,
    cachePricePerM: 0.5,
    // 默认不限额:预算闸门只对显式设置了上限的用户生效(见 remote-commands 的预算评估)。
    dailyBudget: 0,
    monthlyBudget: 0,
    onExceed: 'notify',
  },
  taskHistory: [],
  notifications: { enabled: true, approval: true, question: true, taskDone: true, taskFail: true, update: true, quietHoursEnabled: false, quietStart: 22, quietEnd: 8, urgentBypassQuiet: true },
  taskQueue: [],
  activities: [],
  workspaceMemories: {},
  auditLog: [],
  onboarding: { done: false },
}

/**
 * 进程内当前配置仓库。
 *
 * 不持有配置的转发层(如 EventHub)需要读写活动表,而它们的构造点在入口文件里、只拿到
 * harness;这里由 ConfigStore 在构造时登记自己,让这类层按需取用,不必为了一个引用去改
 * 入口的装配顺序。同一进程只会创建一个 ConfigStore(入口 whenReady 里一次)。
 */
let activeStore: ConfigStore | null = null

/** 当前进程的配置仓库(尚未创建时返回 null)。 */
export function activeConfigStore(): ConfigStore | null {
  return activeStore
}

export class ConfigStore {
  private config: AppConfig
  private readonly path: string
  private readonly db: LocalDb
  /** 本次启动是否发生了配置恢复(损坏隔离 / 备份回退),供界面提示用户。 */
  private recoveryNotice: string | null = null

  constructor() {
    this.path = join(app.getPath('userData'), 'config.json')
    this.config = this.load()
    this.db = new LocalDb(app.getPath('userData'))
    // 登记为进程内当前实例(见上方 activeConfigStore 的说明)。入口现在会显式把
    // config 注入 EventHub,这条是给"只拿到 harness 的转发层"兜底用的;漏掉赋值会让
    // activeConfigStore() 恒为 null,派生活动静默不落库。
    activeStore = this
    // 本地库损坏被隔离重建时,把两处提示合并——用户需要知道"历史记录被重置了、原文件在哪"。
    const dbRecovered = this.db.recoveredFrom()
    if (dbRecovered !== null) {
      const dbNotice = `本地数据库损坏,已隔离到 ${dbRecovered} 并重建(活动记录、审计与任务队列历史已重置)。`
      this.recoveryNotice = this.recoveryNotice === null ? dbNotice : `${this.recoveryNotice}\n${dbNotice}`
    }
    this.migrateLegacyData()
  }

  /** 配置恢复提示(无恢复时返回 null)。界面据此告知用户文件已隔离、旧文件在哪。 */
  takeRecoveryNotice(): string | null {
    const notice = this.recoveryNotice
    this.recoveryNotice = null
    return notice
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

  /**
   * 读取配置。
   *
   * 解析失败时**不静默回默认值**——那会让用户在毫不知情的情况下丢掉远程令牌、已批准
   * 设备、定时任务与工作区记忆,而下一次 save() 就把默认值固化。改为:把损坏文件改名
   * 隔离,优先用上一次成功保存的 `config.json.bak` 恢复,并把经过记入 recoveryNotice。
   */
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
      // 兼容新增的 QQ 平台侧确认标记:老配置文件没有该字段时,已启用 QQ 的视为已确认
      // (此前启用必须自行配置白名单,属已做过的显式决策),未启用的留 false —— 等其首次
      // 启用时走强制确认引导。老配置写回后该字段即固化,不再走本分支。
      if (!('acknowledgedFriendSetting' in (raw.qq ?? {}))) {
        config.qq.acknowledgedFriendSetting = raw.qq?.enabled === true
      }
      // 兼容损坏的数组分区(旧 bug 把数组存成 {0:...} 对象)。
      if (config.scheduledTasks !== null && typeof config.scheduledTasks === 'object' && !Array.isArray(config.scheduledTasks)) {
        config.scheduledTasks = Object.values(config.scheduledTasks as Record<string, never>)
      }
      if (!Array.isArray(config.remote.approvedDevices)) config.remote.approvedDevices = []
      if (!Array.isArray(config.remote.blacklistedDevices)) config.remote.blacklistedDevices = []
      if (!Array.isArray(config.taskHistory)) config.taskHistory = []
      if (!Array.isArray(config.taskQueue)) config.taskQueue = []
      if (!Array.isArray(config.activities)) config.activities = []
      if (!Array.isArray(config.auditLog)) config.auditLog = []
      if (config.workspaceMemories === null || typeof config.workspaceMemories !== 'object' || Array.isArray(config.workspaceMemories)) config.workspaceMemories = {}
      return config
    } catch (error) {
      console.error('[config] 配置文件解析失败:', String(error))
      return this.recoverFromBrokenConfig()
    }
  }

  /** 隔离损坏的 config.json,并尽量从 .bak 恢复;两者都不可用时才回默认值。 */
  private recoverFromBrokenConfig(): AppConfig {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const broken = `${this.path}.corrupt-${stamp}`
    try {
      copyFileSync(this.path, broken)
    } catch {
      // 复制失败不影响后续流程,仅少一份现场。
    }
    const backupPath = `${this.path}.bak`
    if (existsSync(backupPath)) {
      try {
        const raw = JSON.parse(readFileSync(backupPath, 'utf8').replace(/^\uFEFF/, '')) as Partial<AppConfig>
        this.recoveryNotice =
          `配置文件损坏,已隔离到 ${broken},并从上一次备份恢复设置。` +
          '若发现设置不对,可关闭应用后用备份文件覆盖 config.json。'
        console.warn('[config]', this.recoveryNotice)
        return this.merge(DEFAULTS, raw)
      } catch {
        // 备份同样损坏:继续走默认值分支。
      }
    }
    this.recoveryNotice =
      `配置文件损坏,已隔离到 ${broken},当前使用默认设置(远程令牌、已连接设备、定时任务等需要重新配置)。`
    console.warn('[config]', this.recoveryNotice)
    return structuredClone(DEFAULTS)
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
    // harness.launchToken 同样是凭据(等价于本机 agent 控制权),导出时必须一并清空。
    safe.harness.launchToken = null
    writeFileSync(target, JSON.stringify(safe, null, 2), 'utf8')
  }

  /**
   * 从备份恢复非敏感配置,保留本机现有凭据。
   *
   * 只接受本应用导出的配置形状:未知顶层键直接忽略——否则误选一份诊断报告
   * (dsh-diagnostics.json)会把它的 schemaVersion/logs 等字段永久写进 config.json。
   */
  importSafe(source: string): AppConfig {
    const parsed: unknown = JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, ''))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('文件内容不是配置对象(应为「导出脱敏配置」生成的 JSON)')
    }
    // 仅保留 DEFAULTS 里已知的顶层键,过滤 null(避免用 null 覆盖整个分区)。
    const raw: Record<string, unknown> = {}
    for (const key of Object.keys(DEFAULTS)) {
      const value = (parsed as Record<string, unknown>)[key]
      if (value !== undefined && value !== null) raw[key] = value
    }
    if (Object.keys(raw).length === 0) {
      throw new Error('文件中没有可用的配置分区,已取消导入')
    }
    const currentSecrets = {
      remoteToken: this.config.remote.token,
      qqSecret: this.config.qq.appSecret,
      telegramToken: this.config.telegram.token,
      launchToken: this.config.harness.launchToken,
    }
    const next = this.merge(this.config, raw as Partial<AppConfig>)
    next.remote.token = currentSecrets.remoteToken
    next.qq.appSecret = currentSecrets.qqSecret
    next.telegram.token = currentSecrets.telegramToken
    next.harness.launchToken = currentSecrets.launchToken
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

  /** 删除单条活动记录。 */
  deleteActivity(id: string): void {
    this.db.deleteActivity(id)
  }

  /** 清掉已结束的活动记录,返回删除条数。 */
  clearFinishedActivities(): number {
    return this.db.clearFinishedActivities()
  }

  /** 清掉已结束的队列记录,返回删除条数。 */
  clearFinishedQueue(): number {
    return this.db.clearFinishedQueue()
  }

  /** 删除一条队列记录(仅终态),返回是否删除成功。 */
  deleteQueueEntry(id: string): boolean {
    return this.db.deleteQueueEntry(id)
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

  /**
   * 保存配置。
   *
   * 先写临时文件再 rename 覆盖:writeFileSync 直接写目标会先截断,一旦中途失败
   * (磁盘满、进程被强杀)就留下半截 JSON,下次启动即判为损坏。rename 在同一卷上
   * 是原子的,因此目标文件要么是旧的完整内容、要么是新的完整内容。
   * 覆盖前把上一版留作 `config.json.bak`,供损坏时回退。
   */
  private save(): void {
    const tmp = `${this.path}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const text = JSON.stringify(this.config, null, 2)
      writeFileSync(tmp, text, 'utf8')
      if (existsSync(this.path)) {
        try {
          copyFileSync(this.path, `${this.path}.bak`)
        } catch {
          // 备份失败不阻断保存。
        }
      }
      renameSync(tmp, this.path)
    } catch (error) {
      console.error('[config] 保存失败:', error)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 清理失败无影响。
      }
    }
  }

  /** 应用退出时关闭 SQLite 连接。 */
  close(): void {
    this.db.close()
  }
}
