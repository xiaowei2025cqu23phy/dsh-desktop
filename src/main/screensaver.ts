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
  /** 最近一次激活时间:进入宽限期内不因空闲检测退出(避免点击按钮后立刻被踢出)。 */
  private activatedAt = 0
  /** 最近一次退出时间:空闲自动激活的冷却(防止"点击关闭后立刻又弹出")。 */
  private lastDeactivatedAt = 0
  /** 本次激活的来源(manual/idle),决定安全网是否生效。 */
  private activationOrigin: 'manual' | 'idle' | 'system' = 'manual'

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
    this.clearTaskTimer()
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

  /**
   * 进入 AI 屏保。
   * @param origin - manual:用户主动(按钮、托盘);system:Windows 系统屏保 /s 拉起;
   *   idle:空闲检测自动触发。
   *   只有 manual 不受冷却约束(用户明确意愿);system/idle 距上次退出 5 分钟内拒绝,
   *   防止"退出后立刻又被系统/空闲检测拉起"的循环弹出。
   *   idle 起源还启用"空闲回落安全网"(机器空闲时才激活,用户活动即退出);
   *   manual 激活时机器往往并不空闲,安全网会误杀屏保,因此不启用。
   */
  async activate(origin: 'manual' | 'idle' | 'system' = 'manual'): Promise<void> {
    if (this.active) return
    if (origin !== 'manual' && Date.now() - this.lastDeactivatedAt < 300000) {
      console.log('[screensaver] 退出冷却中(5 分钟),跳过自动激活 origin=', origin)
      return
    }
    this.activationOrigin = origin
    // 确保 harness 可用(托管模式自动拉起,并等待就绪)。
    const status = this.harness.status()
    if (status.state === 'idle' || status.state === 'stopped' || status.state === 'error') {
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
    this.activatedAt = Date.now()
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
    win.on('leave-full-screen', () => this.deactivate('leave-fullscreen'))
    // 主进程输入兜底:任何真实键盘/鼠标输入都退出 —— 不依赖渲染进程 JS 状态,
    // 即使页面崩溃也能关闭。宽限 2 秒避免窗口打开瞬间的合成事件误触发。
    // 排除 mouseMove:鼠标抖动/合成移动不应触发退出。
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' || input.type === 'mouseDown' || input.type === 'mouseWheel') {
        if (Date.now() - this.activatedAt > 2000) {
          this.deactivate('input')
        }
      }
    })
    const debugKeep = process.argv.includes('--ss-debug')
    await win.loadFile(join(__dirname, '..', 'renderer', 'screensaver.html'), debugKeep ? { query: { keep: '1' } } : undefined)
    console.log('[screensaver] 窗口已加载,active=', this.active)
  }

  /** 退出 AI 屏保(任务默认保留在后台继续运行)。 */
  deactivate(reason = 'manual'): void {
    if (!this.active && this.window === null) return
    console.log(`[screensaver] 退出(reason=${reason})`)
    this.active = false
    this.lastSessionId = this.sessionId
    this.sessionId = null
    this.lastDeactivatedAt = Date.now()
    const win = this.window
    this.window = null
    if (win !== null && !win.isDestroyed()) win.destroy()
  }

  /**
   * 屏保渲染进程就绪后调用:决定观看哪个会话。
   * - autoTask 关闭:返回 null(纯环境屏保)。
   * - keepSessionAfterExit 且存在上次会话:继续观看(可能仍在运行,也可能已完成)。
   * - 否则:取消上次会话(尽力),创建新会话并发送任务提示词。
   *
   * 新任务带超时护栏:超过 taskMaxMinutes 仍未结束自动停止,防止失控循环烧 CPU。
   */
  async startTask(): Promise<{ sessionId: string; resumed: boolean } | null> {
    const config = this.config.get().screensaver
    if (!config.autoTask || config.taskPrompt.trim() === '') return null
    const client = this.harness.client()
    this.clearTaskTimer()
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
    // 标题标记,便于在 Web UI 的会话列表中识别和清理。
    try {
      await client.rpc('session.rename', { sessionId, title: `AI 屏保任务 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` })
    } catch {
      // 标题失败不影响任务。
    }
    await client.rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: config.taskPrompt.trim() }],
    })
    if (config.taskMaxMinutes > 0) {
      this.taskTimer = setTimeout(() => {
        if (this.sessionId !== null) {
          console.log(`[screensaver] 任务超过 ${config.taskMaxMinutes} 分钟未完成,自动停止`)
          void this.cancelTask()
        }
      }, config.taskMaxMinutes * 60 * 1000)
      this.taskTimer.unref?.()
    }
    return { sessionId, resumed: false }
  }

  private taskTimer: ReturnType<typeof setTimeout> | null = null

  private clearTaskTimer(): void {
    if (this.taskTimer !== null) {
      clearTimeout(this.taskTimer)
      this.taskTimer = null
    }
  }

  /** 读取会话历史(供"继续上次任务"时回放)。 */
  async history(sessionId: string, maxMessages = 40): Promise<unknown[]> {
    const result = await this.harness.client().rpc<{ events: unknown[] }>('session.history', {
      sessionId,
      maxMessages,
    })
    return result.events ?? []
  }

  /** 取消屏保任务(用户主动点击"停止"或超时护栏触发)。 */
  async cancelTask(): Promise<void> {
    this.clearTaskTimer()
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

  /** 注册为 Windows 系统屏保(HKCU,无需管理员)。非 Windows 返回不支持。注册前备份原设置,取消时恢复。 */
  async registerSystemScreensaver(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { ok: false, message: '仅 Windows 支持注册系统屏保' }
    }
    const cfg = this.config.get().screensaver
    const command = this.systemScreensaverCommand()
    const timeout = Math.max(60, Math.round(cfg.idleMinutes * 60))
    try {
      // 备份用户原有屏保设置,取消注册时恢复。
      const backup = await queryDesktopRegistry()
      this.config.update('screensaver', { systemScreensaverBackup: backup })
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'SCRNSAVE.EXE', '/t', 'REG_SZ', '/d', command, '/f'])
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '1', '/f'])
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveTimeOut', '/t', 'REG_SZ', '/d', String(timeout), '/f'])
      return { ok: true, message: `已注册为系统屏保(超时 ${timeout} 秒)。\n${command}` }
    } catch (error) {
      return { ok: false, message: `注册失败:${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 取消系统屏保注册(恢复注册前的原设置)。 */
  async unregisterSystemScreensaver(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { ok: false, message: '仅 Windows 支持系统屏保注册' }
    }
    try {
      const backup = this.config.get().screensaver.systemScreensaverBackup
      if (backup !== null && Object.keys(backup).length > 0) {
        for (const [name, value] of Object.entries(backup)) {
          await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'])
        }
      } else {
        await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'SCRNSAVE.EXE', '/t', 'REG_SZ', '/d', '', '/f'])
        await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '0', '/f'])
      }
      this.config.update('screensaver', { systemScreensaverBackup: null })
      return { ok: true, message: '已取消系统屏保注册(已恢复原设置)' }
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
    // 屏保激活期间:空闲起源的安全网 —— 空闲时间回落(用户回来)立即退出,
    // 渲染进程事件失效时的兜底。进入宽限期(3 秒)内不退出;--ss-debug 时禁用。
    // manual 起源不启用:手动进入时机器通常并不空闲,安全网会误杀屏保。
    if (this.active) {
      const debugKeep = process.argv.includes('--ss-debug')
      if (!debugKeep && this.activationOrigin === 'idle' &&
          Date.now() - this.activatedAt > 3000 &&
          powerMonitor.getSystemIdleTime() < ACTIVITY_GRACE_SECONDS) {
        this.deactivate('idle-reset')
      }
      return
    }
    const cfg = this.config.get().screensaver
    if (!cfg.enabled || this.locked) return
    if (this.window !== null && !this.window.isDestroyed()) return
    // 退出冷却由 activate() 统一处理(system/idle 起源 5 分钟内拒绝)。
    const idleSeconds = powerMonitor.getSystemIdleTime()
    if (idleSeconds >= cfg.idleMinutes * 60) {
      try {
        await this.activate('idle')
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

/** 读取屏保相关注册表值(缺失的值为空字符串)。 */
async function queryDesktopRegistry(): Promise<Record<string, string>> {
  const names = ['SCRNSAVE.EXE', 'ScreenSaveActive', 'ScreenSaveTimeOut']
  const values: Record<string, string> = {}
  for (const name of names) {
    values[name] = await new Promise<string>((resolve) => {
      execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', name], { windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve('')
            return
          }
          const match = /REG_SZ\s+(.*)$/m.exec(stdout)
          resolve(match === null ? '' : match[1].trim())
        })
    })
  }
  return values
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 供外部创建屏保会话 id(如需要预分配)。 */
export function newSessionId(): string {
  return randomUUID()
}
