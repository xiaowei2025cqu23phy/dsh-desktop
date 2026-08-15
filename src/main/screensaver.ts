/**
 * AI 屏保控制器。
 *
 * 两种触发方式:
 * 1. 内置空闲检测:主进程轮询 powerMonitor.getSystemIdleTime(),超过阈值后全屏显示
 *    agent 实时工作画面;检测到用户活动(空闲时间回落)立即退出全屏。
 * 2. Windows 系统屏保:注册表 SCRNSAVE.EXE 指向本应用,系统超时后用 `/s` 参数拉起,
 *    应用直接进入全屏屏保模式。
 *
 * 屏保页面通过 IPC 订阅 mux 事件流,实时渲染 agent 的思考、文本与工具调用。
 */

import { app, BrowserWindow, ipcMain, powerMonitor, screen } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { ConfigStore, ScreensaverConfig } from './config'
import type { HarnessManager } from './harness'
import type { ServerRequest } from './client'
import { randomUUID } from 'node:crypto'

const IDLE_POLL_MS = 3000
/** 空闲时间低于该秒数视为"用户已回来"。 */
const ACTIVITY_GRACE_SECONDS = 3

export class ScreensaverController {
  private window: BrowserWindow | null = null
  private active = false
  private locked = false
  /** 当前屏保正在观看的会话。 */
  private sessionId: string | null = null
  /** 上一次屏保的会话(跨激活保留,用于"继续上次任务")。 */
  private lastSessionId: string | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null
  /** 当前屏保会话最近事件序号,用于重连续传。 */
  private lastSeq = 0

  constructor(
    private config: ConfigStore,
    private harness: HarnessManager,
  ) {}

  getConfig(): ScreensaverConfig {
    return this.config.get().screensaver
  }

  setConfig(patch: Partial<ScreensaverConfig>): ScreensaverConfig {
    const next = this.config.update('screensaver', patch)
    return next
  }

  /** 由应用入口调用:开始空闲轮询并注册 IPC。 */
  start(): void {
    this.registerIpc()
    this.idleTimer = setInterval(() => void this.onIdleTick(), IDLE_POLL_MS)
    powerMonitor.on('lock-screen', () => {
      this.locked = true
      this.deactivate()
    })
    powerMonitor.on('unlock-screen', () => {
      this.locked = false
    })
    powerMonitor.on('resume', () => {
      // 从睡眠恢复:若空闲时间已回落(用户在场),退出屏保。
      if (this.active && powerMonitor.getSystemIdleTime() < ACTIVITY_GRACE_SECONDS) {
        this.deactivate()
      }
    })
  }

  dispose(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.deactivate()
  }

  isActive(): boolean {
    return this.active
  }

  /** mux 帧入口:由主进程的 mux 桥接调用,转发给屏保窗口。 */
  forwardFrame(frame: ServerRequest): void {
    if (!this.active || this.window === null || this.window.isDestroyed()) return
    const payload = frame.payload as { type?: string; sessionId?: string; event?: { seq?: number } } | null
    if (payload === null || typeof payload !== 'object') return
    if (payload.type === 'session/event') {
      if (this.sessionId !== null && payload.sessionId !== this.sessionId) return
      if (typeof payload.event?.seq === 'number') this.lastSeq = payload.event.seq
    }
    this.window.webContents.send('screensaver:event', frame)
  }

  /** 立即进入 AI 屏保。 */
  async activate(): Promise<void> {
    if (this.active) return
    // 确保 harness 可用(托管模式自动拉起,并等待就绪)。
    const status = this.harness.status()
    if (status.state === 'idle' || status.state === 'stopped') {
      if (this.config.get().harness.mode !== 'external') {
        await this.harness.restart()
      }
    }
    const deadline = Date.now() + 120000
    for (;;) {
      const current = this.harness.status()
      if (current.state === 'running' || current.state === 'external') break
      if (current.state === 'error') {
        throw new Error(`harness 不可用:${current.error ?? '未知错误'}`)
      }
      if (Date.now() > deadline) {
        throw new Error('harness 启动超时,请查看服务日志')
      }
      await sleep(500)
    }
    this.active = true
    this.sessionId = null
    this.lastSeq = 0
    const display = screen.getPrimaryDisplay()
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      frame: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      backgroundColor: '#05070d',
      alwaysOnTop: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.window = win
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setMenu(null)
    win.on('closed', () => {
      if (this.window === win) this.window = null
      this.active = false
    })
    win.on('leave-full-screen', () => this.deactivate())
    await win.loadFile(join(__dirname, '..', 'renderer', 'screensaver.html'))
  }

  /** 退出 AI 屏保(任务默认保留在后台继续运行)。 */
  deactivate(): void {
    if (!this.active && this.window === null) return
    this.active = false
    this.lastSessionId = this.sessionId
    this.sessionId = null
    const win = this.window
    this.window = null
    if (win !== null && !win.isDestroyed()) win.destroy()
  }

  /**
   * 屏保渲染进程就绪后调用:决定观看哪个会话。
   * - autoTask 关闭:返回 null(纯环境屏保)。
   * - keepSessionAfterExit 且存在上次会话:继续观看(可能仍在运行,也可能已完成)。
   * - 否则:取消上次会话(尽力),创建新会话并发送任务提示词。
   */
  async startTask(): Promise<{ sessionId: string; resumed: boolean } | null> {
    const config = this.config.get().screensaver
    if (!config.autoTask || config.taskPrompt.trim() === '') return null
    const client = this.harness.client()
    if (config.keepSessionAfterExit && this.lastSessionId !== null) {
      this.sessionId = this.lastSessionId
      this.lastSeq = 0
      return { sessionId: this.lastSessionId, resumed: true }
    }
    if (!config.keepSessionAfterExit && this.lastSessionId !== null) {
      const stale = this.lastSessionId
      this.lastSessionId = null
      try {
        await client.rpc('session.cancel', { sessionId: stale })
      } catch {
        // 会话可能已结束,忽略。
      }
    }
    const created = await client.rpc<{ sessionId: string }>('session.create', {
      ...(config.taskCwd && config.taskCwd.trim() !== '' ? { cwd: config.taskCwd.trim() } : {}),
    })
    const sessionId = created.sessionId
    this.sessionId = sessionId
    this.lastSessionId = sessionId
    this.lastSeq = 0
    await client.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: config.taskPrompt.trim() }],
    })
    return { sessionId, resumed: false }
  }

  /** 读取会话历史(供"继续上次任务"时回放)。 */
  async history(sessionId: string, maxMessages = 40): Promise<unknown[]> {
    const result = await this.harness.client().rpc<{ events: unknown[] }>('session.history', {
      sessionId,
      maxMessages,
    })
    return result.events ?? []
  }

  /** 取消屏保任务(用户主动点击"停止")。 */
  async cancelTask(): Promise<void> {
    if (this.sessionId === null) return
    const id = this.sessionId
    this.sessionId = null
    try {
      await this.harness.client().rpc('session.cancel', { sessionId: id })
    } catch {
      // 会话可能已结束,忽略。
    }
  }

  // ---- 系统屏保注册 ----

  /** 当前可执行文件作为 Windows 屏保的命令行(Windows 会追加 /s 参数拉起)。 */
  private systemScreensaverCommand(): string {
    if (app.isPackaged) return `"${process.execPath}"`
    // 开发模式:electron.exe + 应用目录。
    return `"${process.execPath}" "${app.getAppPath()}"`
  }

  /** 注册为 Windows 系统屏保(HKCU,无需管理员)。非 Windows 返回不支持。 */
  async registerSystemScreensaver(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { ok: false, message: '仅 Windows 支持注册系统屏保' }
    }
    const cfg = this.config.get().screensaver
    const command = this.systemScreensaverCommand()
    const timeout = Math.max(60, Math.round(cfg.idleMinutes * 60))
    try {
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'SCRNSAVE.EXE', '/t', 'REG_SZ', '/d', command, '/f'])
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '1', '/f'])
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveTimeOut', '/t', 'REG_SZ', '/d', String(timeout), '/f'])
      return { ok: true, message: `已注册为系统屏保(超时 ${timeout} 秒)。\n${command}` }
    } catch (error) {
      return { ok: false, message: `注册失败:${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 取消系统屏保注册。 */
  async unregisterSystemScreensaver(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { ok: false, message: '仅 Windows 支持系统屏保注册' }
    }
    try {
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'SCRNSAVE.EXE', '/t', 'REG_SZ', '/d', '', '/f'])
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '0', '/f'])
      return { ok: true, message: '已取消系统屏保注册' }
    } catch (error) {
      return { ok: false, message: `取消失败:${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 当前是否已注册为系统屏保。 */
  async systemScreensaverRegistered(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'SCRNSAVE.EXE'], { windowsHide: true },
          (error, stdout) => {
            if (error) { reject(error); return }
            resolve(stdout)
          })
      })
      return output.includes('REG_SZ') && !/REG_SZ\s+$/.test(output) &&
        !/SCRNSAVE\.EXE\s+REG_SZ\s+"?"?\s*$/.test(output) && output.trim().length > 0
    } catch {
      return false
    }
  }

  // ---- 内部 ----

  private registerIpc(): void {
    ipcMain.handle('screensaver:getConfig', () => this.getConfig())
    ipcMain.handle('screensaver:setConfig', (_event, patch: Partial<ScreensaverConfig>) => this.setConfig(patch))
    ipcMain.handle('screensaver:activate', () => this.activate())
    ipcMain.handle('screensaver:deactivate', () => { this.deactivate() })
    ipcMain.handle('screensaver:isActive', () => this.isActive())
    ipcMain.handle('screensaver:startTask', () => this.startTask())
    ipcMain.handle('screensaver:cancelTask', () => this.cancelTask())
    ipcMain.handle('screensaver:history', (_event, sessionId: string, maxMessages?: number) =>
      this.history(sessionId, maxMessages))
    ipcMain.handle('screensaver:registerSystem', () => this.registerSystemScreensaver())
    ipcMain.handle('screensaver:unregisterSystem', () => this.unregisterSystemScreensaver())
    ipcMain.handle('screensaver:systemRegistered', () => this.systemScreensaverRegistered())
    ipcMain.handle('screensaver:attach', () => {
      // 屏保窗口挂载时若有正在运行的会话,允许渲染端从历史续播。
      return { sessionId: this.sessionId, lastSeq: this.lastSeq }
    })
    ipcMain.on('screensaver:session-id', (_event, sessionId: string) => {
      // 渲染端主动上报它正在显示的会话(供转发过滤)。
      if (typeof sessionId === 'string') this.sessionId = sessionId
    })
  }

  private async onIdleTick(): Promise<void> {
    const cfg = this.config.get().screensaver
    if (!cfg.enabled || this.active || this.locked) return
    if (this.window !== null && !this.window.isDestroyed()) return
    const idleSeconds = powerMonitor.getSystemIdleTime()
    if (idleSeconds >= cfg.idleMinutes * 60) {
      try {
        await this.activate()
      } catch (error) {
        console.error('[screensaver] 激活失败:', error)
        // 避免失败后立刻重试风暴:3 分钟后重试。
        await sleep(180000)
      }
    }
  }
}

function runReg(action: 'add', args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg', [action, ...args], { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new Error(stdout.trim() || error.message))
        return
      }
      resolve()
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 供外部创建屏保会话 id(如需要预分配)。 */
export function newSessionId(): string {
  return randomUUID()
}
