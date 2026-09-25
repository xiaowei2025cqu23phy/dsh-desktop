/**
 * 渲染进程全局类型声明(纯类型,无运行时代码)。
 */

interface HarnessStatus {
  state: 'idle' | 'probing' | 'external' | 'running' | 'starting' | 'stopping' | 'stopped' | 'error'
  baseUrl: string
  error: string | null
  managed: boolean
  pid: number | null
}

/** 实例能力探测结果:区分官方版与本地魔改版,列出可用 RPC 特性。 */
interface InstanceCapabilitiesView {
  reachable: boolean
  source: 'official' | 'fork' | 'unknown'
  probes: Array<{ method: string; label: string; ok: boolean | null; note?: string }>
  checkedAt: number
}

interface ModelOptionView {
  id: string
  name?: string
  models: Array<{ id: string; name?: string }>
}

interface ModelsListResult {
  providers: Array<{ provider: string; displayName?: string; active?: boolean }>
  groups: ModelOptionView[]
  failures: Array<{ provider: string; message: string }>
  selected: { provider: string; model: string; reasoningEffort?: string } | null
}

interface ScreensaverConfigView {
  enabled: boolean
  idleMinutes: number
}

interface ServerRequestFrame {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

interface WallpaperSpecView {
  path: string | null
  position: { x: number; y: number }
}

interface AppearanceConfigView {
  window: WallpaperSpecView
  phone: WallpaperSpecView
  screensaver: WallpaperSpecView
  mask: number
}

interface RemoteConfigView {
  enabled: boolean
  port: number
  bindHost: string
  https: boolean
  paused: boolean
  pauseOnLock: boolean
  blacklistedDevices: Array<{ id: string; label: string; address: string; blockedAt: number }>
  token: string
  expiresAt: number | null
  presetWorkspaceRoots: string[]
  /**
   * 已连接(已知)设备:带 x-dsh-device 的客户端首次连接即自动登记,桌面端据此暂停/拉黑。
   * 授权只由令牌决定;`approvedAt` 是配置里的历史字段名,现表示首次登记时间。
   */
  approvedDevices: Array<{ id: string; label: string; address: string; approvedAt: number; lastSeenAt: number; paused?: boolean }>
}

interface QQConfigView {
  enabled: boolean
  appId: string
  appSecret: string
  allowedUserIds: string
  acknowledgedFriendSetting: boolean
  defaultTarget: string
  autoChat: boolean
  report: boolean
}

interface QQDiagView {
  configured: boolean
  connected: boolean
  readyAt: number | null
  /** 门禁未就绪:尚未确认平台侧已关闭「允许被添加为好友」,机器人不启动。 */
  locked: boolean
  /** 白名单是否已配置;false = 留空不限制。 */
  restricted: boolean
  lastError: { at: number; action: string; detail: string; hint: string } | null
  deniedUsers: Array<{ id: string; at: number }>
}

interface TelegramDiagView {
  configured: boolean
  started: boolean
  locked: boolean
  bindUntilAt: number | null
  bindOffer: number | null
  lastError: { at: number; action: string; detail: string } | null
  lastIncomingAt: number | null
  deniedChats: Array<{ id: number; at: number }>
}

interface OnboardProgressView {
  status: 'pending' | 'completed' | 'expired' | 'error'
  qrDataUrl: string | null
  appId?: string
  appSecret?: string
  userOpenid?: string
  error?: string
}

interface TelegramConfigView {
  enabled: boolean
  token: string
  allowedUserIds: string
  autoChat: boolean
  report: boolean
}

interface BotPromptConfigView {
  taskPrompt: string
  chatPrompt: string
}

/** 单个预算周期(今日 / 本月)的判定结果。 */
interface BudgetScopeStatusView {
  limit: number
  spent: number
  ratio: number
  warn: boolean
  exceeded: boolean
  /** 周期键(本地日期 YYYY-MM-DD / 本地月份 YYYY-MM)。 */
  period: string
}

interface BudgetStatusView {
  daily: BudgetScopeStatusView | null
  monthly: BudgetScopeStatusView | null
  exceeded: boolean
  /** onExceed = block 且已超限:新的任务启动被拒绝。 */
  blocked: boolean
  /** 给用户的说明文本(未超限时为空)。 */
  message: string
}

/** 会话停止结果:成功/失败都要回显。 */
interface SessionStopResultView {
  ok: boolean
  message: string
}

interface UsageReportView {
  todaySessions: number
  totalSessions: number
  todayTurns: number
  totalTurns: number
  todayLlmMs: number
  totalLlmMs: number
  tokens: { input: number; output: number; cache: number; total: number }
  byModel: Array<{ provider: string; model: string; input: number; output: number; cache: number; calls: number }>
  cost: { input: number; output: number; cache: number; total: number }
  prices: { inputPerM: number; outputPerM: number; cachePerM: number; multiplier: number }
  todayList: Array<{ title: string; turns: number }>
  /** 预算判定(未设预算时为 null)。 */
  budget: BudgetStatusView | null
}

interface DesktopApi {
  bot: {
    getConfig(): Promise<BotPromptConfigView>
    setConfig(patch: { taskPrompt?: string; chatPrompt?: string }): Promise<BotPromptConfigView>
    help(): Promise<string>
  }
  notifications: {
    getConfig(): Promise<{ enabled: boolean; approval: boolean; question: boolean; taskDone: boolean; taskFail: boolean; update: boolean; quietHoursEnabled: boolean; quietStart: number; quietEnd: number; urgentBypassQuiet: boolean }>
    setConfig(patch: object): Promise<unknown>
  }
  usage: {
    getConfig(): Promise<{ multiplier: number; inputPricePerM: number; outputPricePerM: number; cachePricePerM: number; dailyBudget: number; monthlyBudget: number; onExceed: 'notify' | 'block' }>
    setConfig(patch: { multiplier?: number; dailyBudget?: number; monthlyBudget?: number; onExceed?: 'notify' | 'block' }): Promise<{ multiplier: number; inputPricePerM: number; outputPricePerM: number; cachePricePerM: number; dailyBudget: number; monthlyBudget: number; onExceed: 'notify' | 'block' }>
    report(): Promise<UsageReportView | null>
  }
  interactions: {
    list(): Promise<Array<{ kind: 'approval' | 'question'; sessionId: string; approvalId?: string; questionId?: string; options?: string[]; title: string; detail: string; createdAt: number }>>
    respondApproval(sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<string>
    respondQuestion(sessionId: string, questionId: string, optionIndex: number): Promise<string>
  }
  tasks: {
    history(): Promise<Array<{ id: string; description: string; sessionId: string | null; status: string; attempts: number; error?: string; createdAt: number; updatedAt: number }>>
    /** 清空任务历史(config.taskHistory)。 */
    clearHistory(): Promise<{ ok: boolean; removed: number }>
  }
  queue: {
    list(): Promise<Array<{ id: string; description: string; sessionId: string | null; status: string; attempts: number; maxAttempts: number; nextAttemptAt: number | null; error?: string; workspace: string | null; source: string; createdAt: number; updatedAt: number }>>
    cancel(id: string): Promise<string>
    retry(id: string): Promise<string>
    /** 删除终态队列条目;排队/运行中会失败并给出原因。 */
    delete(id: string): Promise<{ ok: boolean; message?: string }>
    clearFinished(): Promise<{ ok: boolean; removed: number }>
  }
  activity: {
    list(): Promise<Array<{ id: string; type: string; source: string; workspace: string | null; sessionId: string | null; status: string; title: string; lastEvent: string; createdAt: number; updatedAt: number }>>
    /** 停止该会话(session.cancel);返回结果供界面提示,失败不静默。 */
    stop(sessionId: string): Promise<SessionStopResultView>
    /** 停止当前所有运行中的会话。 */
    stopAll(): Promise<SessionStopResultView>
    /** 删除单条已结束的活动记录。 */
    delete(id: string): Promise<{ ok: boolean }>
    /** 清掉所有已结束的活动记录;运行中/等待中的保留。 */
    clearFinished(): Promise<{ ok: boolean; removed: number }>
  }
  workspace: {
    health(): Promise<Array<{ workspaceId: string | null; title: string; path: string; exists: boolean; readable: boolean; writable: boolean; freeBytes: number | null; sessions: number | null }>>
    changes(path: string, diff?: boolean): Promise<{ path: string; status?: string; summary?: string; diff?: string; truncated?: boolean; unavailable?: boolean; message?: string }>
    openFolder(path: string): Promise<string>
  }
  audit: {
    list(): Promise<Array<{ id: string; time: number; type: string; sessionId?: string; activityId?: string; detail: string }>>
    clear(): Promise<unknown>
    export(): Promise<string | null>
  }
  memory: {
    list(): Promise<Record<string, { enabled: boolean; summary: string; conventions: string; commands: string; notes: string; updatedAt: number }>>
    get(path: string): Promise<{ enabled: boolean; summary: string; conventions: string; commands: string; notes: string; updatedAt: number }>
    set(path: string, memory: { enabled: boolean; summary: string; conventions: string; commands: string; notes: string }): Promise<unknown>
    clear(path: string): Promise<boolean>
    suggest(path: string): Promise<{ summary: string; commands: string; conventions: string }>
  }
  config: {
    backup(): Promise<string>
    exportSafe(): Promise<string | null>
    importSafe(): Promise<unknown | null>
  }
  diagnostics: {
    collect(): Promise<Record<string, unknown>>
    export(): Promise<string | null>
  }
  harness: {
    getStatus(): Promise<HarnessStatus>
    launchToken(): Promise<string | null>
    capabilities(): Promise<InstanceCapabilitiesView>
    getConfig(): Promise<unknown>
    setConfig(patch: object): Promise<HarnessStatus>
    restart(): Promise<void>
    stop(): Promise<void>
    getLogs(): Promise<string[]>
    openWebUi(): Promise<void>
  }
  preview: {
    getStatus(): Promise<HarnessStatus | null>
    capabilities(): Promise<InstanceCapabilitiesView | null>
    getConfig(): Promise<unknown>
    setConfig(patch: object): Promise<HarnessStatus | null>
    start(): Promise<void>
    stop(): Promise<void>
    restart(): Promise<void>
    getLogs(): Promise<string[]>
    openWebUi(): Promise<void>
  }
  models: {
    list(): Promise<ModelsListResult>
    setDefault(provider: string, model: string): Promise<void>
    addProvider(spec: unknown): Promise<void>
    removeProvider(id: string): Promise<void>
    discover(baseURL: string, api: string, apiKey: string): Promise<Array<{ id: string; name?: string }>>
  }
  screensaver: {
    getConfig(): Promise<ScreensaverConfigView>
    setConfig(patch: object): Promise<ScreensaverConfigView>
    activate(): Promise<void>
    registerSystem(): Promise<{ ok: boolean; message: string }>
    unregisterSystem(): Promise<{ ok: boolean; message: string }>
    systemRegistered(): Promise<boolean>
  }
  remote: {
    getConfig(): Promise<RemoteConfigView>
    setConfig(patch: object): Promise<RemoteConfigView>
    lanAddresses(): Promise<string[]>
    /** 实际监听状态:listenHost 为 null 表示未监听;lastError 给出失败/回退原因。 */
    state(): Promise<{ enabled: boolean; paused: boolean; bindHost: string; listenHost: string | null; lastError: string | null }>
    httpsCertInfo(): Promise<{ enabled: boolean; fingerprint: string | null; hosts: string[] }>
    pairUrl(): Promise<string>
    qrDataUrl(): Promise<string | null>
    qrDataUrls(): Promise<Array<{ address: string; url: string; dataUrl: string | null }>>
    approvedDevices(): Promise<RemoteConfigView['approvedDevices']>
    revokeDevice(id: string): Promise<void>
    setPaused(paused: boolean): Promise<void>
    pauseDevice(id: string): Promise<void>
    resumeDevice(id: string): Promise<void>
    blacklistDevice(id: string): Promise<void>
    unblacklistDevice(id: string): Promise<void>
    blacklistedDevices(): Promise<Array<{ id: string; label: string; address: string; blockedAt: number }>>
  }
  dialog: {
    pickDirectories(): Promise<string[]>
    pickFile(): Promise<string | null>
  }
  qq: {
    getConfig(): Promise<QQConfigView>
    setConfig(patch: object): Promise<QQConfigView>
    status(): Promise<boolean>
    diag(): Promise<QQDiagView>
    onboardStart(): Promise<OnboardProgressView>
    onboardStatus(): Promise<OnboardProgressView | null>
    onboardCancel(): Promise<void>
  }
  telegram: {
    getConfig(): Promise<TelegramConfigView>
    setConfig(patch: object): Promise<TelegramConfigView>
    status(): Promise<boolean>
    diag(): Promise<TelegramDiagView>
    bindStart(): Promise<{ ok: boolean; message: string }>
    bindCancel(): Promise<{ ok: boolean; message: string }>
  }
  appearance: {
    getConfig(): Promise<AppearanceConfigView>
    pickSource(kind: 'window' | 'phone' | 'screensaver'): Promise<{ path: string } | null>
    saveWallpaper(
      kind: 'window' | 'phone' | 'screensaver',
      dataUrl: string,
      position: { x: number; y: number },
    ): Promise<WallpaperSpecView>
    clear(kind: 'window' | 'phone' | 'screensaver'): Promise<WallpaperSpecView>
    setMask(mask: number): Promise<AppearanceConfigView>
    wallpaperData(kind: 'window' | 'phone' | 'screensaver'): Promise<{
      dataUrl: string | null
      position: { x: number; y: number }
    }>
    listPacks(): Promise<Array<{ id: string; files: Record<string, string> }>>
    applyPack(id: string): Promise<AppearanceConfigView>
  }
  app: {
    info(): Promise<{ version: string; commit: string; builtAt: number }>
    recoveryNotice(): Promise<string | null>
    openSettingsFolder(): Promise<{ opened: true }>
    openDataFolder(): Promise<{ opened: boolean; path: string; error: string }>
    exportLogs(): Promise<{ ok: boolean; target: string; copied: string[]; error?: string } | null>
  }
  onboarding: {
    get(): Promise<boolean>
    complete(): Promise<boolean>
  }
  updater: {
    getInfo(): Promise<{ current: string; latest: string | null; url: string | null; checkedAt: number; hasUpdate: boolean }>
    check(): Promise<{ current: string; latest: string | null; url: string | null; checkedAt: number; hasUpdate: boolean }>
    getConfig(): Promise<{ autoCheck: boolean }>
    setConfig(patch: { autoCheck?: boolean }): Promise<{ autoCheck: boolean }>
    openRelease(): Promise<void>
  }
}

interface SharedHelpers {
  escapeHtml(text: string): string
  formatTime(date: Date): string
  isRecord(value: unknown): value is Record<string, unknown>
  textFromBlocks(blocks: unknown): string
  extractAnyText(value: unknown, depth?: number): string
  toast(message: string, kind?: 'info' | 'error' | 'ok'): void
}

/** Electron <webview> 元素的极简结构类型(渲染进程不引入 Electron 类型)。 */
interface WebviewElement extends HTMLElement {
  src: string
  reload(): void
  getURL(): string
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void
}

interface Window {
  dshDesktop: DesktopApi
  DSHShared: SharedHelpers
  /** 屏保窗口专用最小桥(src/screensaver-preload.ts),仅屏保页可见。 */
  dshScreen: {
    wallpaper(): Promise<{ dataUrl: string | null; position?: { x: number; y: number } }>
    appearance(): Promise<{ mask: number }>
    exit(): Promise<void>
  }
}
