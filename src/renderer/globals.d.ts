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
}

interface QQConfigView {
  enabled: boolean
  appId: string
  appSecret: string
  defaultTarget: string
}

interface TelegramConfigView {
  enabled: boolean
  token: string
  allowedUserIds: string
}

interface DesktopApi {
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
  }
  qq: {
    getConfig(): Promise<QQConfigView>
    setConfig(patch: object): Promise<QQConfigView>
    status(): Promise<boolean>
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
