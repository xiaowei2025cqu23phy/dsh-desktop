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

interface ModelOptionView {
  id: string
  name?: string
  models: Array<{ id: string; name?: string }>
}

interface ModelsListResult {
  providers: unknown[]
  groups: ModelOptionView[]
  failures: Array<{ provider: string; message: string }>
  selected: { provider: string; model: string; reasoningEffort?: string } | null
}

interface ScreensaverConfigView {
  enabled: boolean
  idleMinutes: number
  autoTask: boolean
  taskPrompt: string
  taskCwd: string | null
  taskMaxMinutes: number
  keepSessionAfterExit: boolean
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
  token: string
  expiresAt: number | null
  presetWorkspaceRoots: string[]
  approvedDevices: Array<{ id: string; label: string; address: string; approvedAt: number; lastSeenAt: number }>
  pendingDevices: Array<{ id: string; label: string; address: string; requestedAt: number; lastSeenAt: number }>
}

interface QQConfigView {
  enabled: boolean
  appId: string
  appSecret: string
  defaultTarget: string
  autoChat: boolean
  report: boolean
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
}

interface DesktopApi {
  bot: {
    getConfig(): Promise<BotPromptConfigView>
    setConfig(patch: { taskPrompt?: string; chatPrompt?: string }): Promise<BotPromptConfigView>
    help(): Promise<string>
  }
  notifications: {
    getConfig(): Promise<{ enabled: boolean; approval: boolean; question: boolean; taskDone: boolean; taskFail: boolean; quietHoursEnabled: boolean; quietStart: number; quietEnd: number; urgentBypassQuiet: boolean }>
    setConfig(patch: object): Promise<unknown>
  }
  usage: {
    getConfig(): Promise<{ multiplier: number; inputPricePerM: number; outputPricePerM: number; cachePricePerM: number }>
    setConfig(patch: { multiplier?: number }): Promise<{ multiplier: number; inputPricePerM: number; outputPricePerM: number; cachePricePerM: number }>
    report(): Promise<UsageReportView | null>
  }
  interactions: {
    list(): Promise<Array<{ kind: 'approval' | 'question'; sessionId: string; approvalId?: string; questionId?: string; options?: string[]; title: string; detail: string; createdAt: number }>>
    respondApproval(sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<string>
    respondQuestion(sessionId: string, questionId: string, optionIndex: number): Promise<string>
  }
  tasks: {
    history(): Promise<Array<{ id: string; description: string; sessionId: string | null; status: string; attempts: number; error?: string; createdAt: number; updatedAt: number }>>
  }
  queue: {
    list(): Promise<Array<{ id: string; description: string; sessionId: string | null; status: string; attempts: number; maxAttempts: number; nextAttemptAt: number | null; error?: string; workspace: string | null; source: string; createdAt: number; updatedAt: number }>>
    cancel(id: string): Promise<string>
    retry(id: string): Promise<string>
  }
  activity: {
    list(): Promise<Array<{ id: string; type: string; source: string; workspace: string | null; sessionId: string | null; status: string; title: string; lastEvent: string; createdAt: number; updatedAt: number }>>
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
    getConfig(): Promise<unknown>
    setConfig(patch: object): Promise<HarnessStatus>
    restart(): Promise<void>
    stop(): Promise<void>
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
    deactivate(): Promise<void>
    isActive(): Promise<boolean>
    startTask(): Promise<{ sessionId: string; resumed: boolean } | null>
    cancelTask(): Promise<void>
    history(sessionId: string, maxMessages?: number): Promise<unknown[]>
    registerSystem(): Promise<{ ok: boolean; message: string }>
    unregisterSystem(): Promise<{ ok: boolean; message: string }>
    systemRegistered(): Promise<boolean>
    attach(): Promise<{ sessionId: string | null; lastSeq: number }>
    reportSessionId(sessionId: string): void
    onEvent(callback: (frame: ServerRequestFrame) => void): () => void
  }
  remote: {
    getConfig(): Promise<RemoteConfigView>
    setConfig(patch: object): Promise<RemoteConfigView>
    lanAddresses(): Promise<string[]>
    pairUrl(): Promise<string>
    qrDataUrl(): Promise<string | null>
    qrDataUrls(): Promise<Array<{ address: string; url: string; dataUrl: string | null }>>
    pendingDevices(): Promise<RemoteConfigView['pendingDevices']>
    approvedDevices(): Promise<RemoteConfigView['approvedDevices']>
    approveDevice(id: string): Promise<void>
    rejectDevice(id: string): Promise<void>
    revokeDevice(id: string): Promise<void>
    onDevicePending(callback: (device: { id: string; label: string; address: string }) => void): () => void
  }
  dialog: {
    pickDirectories(): Promise<string[]>
  }
  qq: {
    getConfig(): Promise<QQConfigView>
    setConfig(patch: object): Promise<QQConfigView>
    status(): Promise<boolean>
    onboardStart(): Promise<OnboardProgressView>
    onboardStatus(): Promise<OnboardProgressView | null>
    onboardCancel(): Promise<void>
  }
  telegram: {
    getConfig(): Promise<TelegramConfigView>
    setConfig(patch: object): Promise<TelegramConfigView>
    status(): Promise<boolean>
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
    openSettingsFolder(): Promise<{ opened: true }>
    quit(): Promise<void>
  }
  updater: {
    getInfo(): Promise<{ current: string; latest: string | null; url: string | null; checkedAt: number }>
    check(): Promise<{ current: string; latest: string | null; url: string | null; checkedAt: number }>
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
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void
}

interface Window {
  dshDesktop: DesktopApi
  DSHShared: SharedHelpers
}
