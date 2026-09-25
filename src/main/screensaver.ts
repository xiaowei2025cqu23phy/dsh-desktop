/**
 * 屏保控制器。
 *
 * 屏保是**纯展示**:壁纸 + 时钟,不启动任何 agent 任务。空闲检测与 Windows 系统屏保
 * 注册(SCRNSAVE.EXE)都保留,所以它仍然是"替换系统屏保"的那块屏;只是不再替你在
 * 无人看管时空跑任务——那类需求交给定时任务与机器人通道,它们各自有开关与配额。
 *
 * 两种触发方式:
 * 1. 内置空闲检测:轮询 powerMonitor.getSystemIdleTime(),超过阈值后全屏显示;
 *    检测到用户活动(空闲时间回落)立即退出。
 * 2. Windows 系统屏保:注册表 SCRNSAVE.EXE 指向本应用,系统超时后用 `/s` 拉起。
 */

import { app, BrowserWindow, ipcMain, powerMonitor, screen } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { ConfigStore, ScreensaverConfig } from './config'

const IDLE_POLL_MS = 3000
/** 空闲时间低于该秒数视为"用户已回来"。 */
const ACTIVITY_GRACE_SECONDS = 3
/** 退出后的自动激活冷却:防止"关掉又立刻弹出"。 */
const REACTIVATE_COOLDOWN_MS = 300_000

export class ScreensaverController {
  private window: BrowserWindow | null = null
  private active = false
  private locked = false
  private idleTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次激活时间:进入宽限期内不因空闲检测退出(避免点击按钮后立刻被踢出)。 */
  private activatedAt = 0
  /** 最近一次退出时间:空闲/系统起源的自动激活冷却。 */
  private lastDeactivatedAt = 0
  /** 激活流程进行中(防并发:3 秒轮询会同时触发多次 activate)。 */
  private activating = false
  /** 冷却期内跳过激活的日志节流时间(避免每 3 秒刷一行)。 */
  private lastCooldownLogAt = 0
  /** 本次激活的来源(manual/idle/system),决定空闲回落安全网是否生效。 */
  private activationOrigin: 'manual' | 'idle' | 'system' = 'manual'

  constructor(private config: ConfigStore) {}

  getConfig(): ScreensaverConfig {
    return this.config.get().screensaver
  }

  setConfig(patch: Partial<ScreensaverConfig>): ScreensaverConfig {
    const next = this.config.update('screensaver', patch)
    // 已注册为系统屏保时,超时值必须与注册表同步(否则改了「空闲分钟」不生效)。
    if (patch.idleMinutes !== undefined && typeof next.idleMinutes === 'number') {
      void this.syncSystemTimeout(next.idleMinutes)
    }
    return next
  }

  /** 已注册系统屏保时,把新的空闲分钟数写入注册表超时值(失败不影响本地配置)。 */
  private async syncSystemTimeout(idleMinutes: number): Promise<void> {
    if (process.platform !== 'win32') return
    try {
      if (!await this.systemScreensaverRegistered()) return
      const timeout = String(Math.max(60, Math.round(idleMinutes * 60)))
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveTimeOut', '/t', 'REG_SZ', '/d', timeout, '/f'])
    } catch {
      // 注册表写入失败不影响配置保存;用户可在「注册为系统屏保」里重试。
    }
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

  /**
   * 进入屏保。
   * @param origin - manual:用户主动(按钮、托盘);system:Windows 系统屏保 /s 拉起;
   *   idle:空闲检测自动触发。
   *   只有 manual 不受冷却约束(用户明确意愿);system/idle 距上次退出 5 分钟内拒绝,
   *   防止"退出后立刻又被系统/空闲检测拉起"的循环弹出。
   *   idle 起源还启用"空闲回落安全网"(机器空闲时才激活,用户活动即退出);
   *   manual 激活时机器往往并不空闲,安全网会误杀屏保,因此不启用。
   */
  async activate(origin: 'manual' | 'idle' | 'system' = 'manual'): Promise<void> {
    if (this.active || this.activating) return
    if (origin !== 'manual' && Date.now() - this.lastDeactivatedAt < REACTIVATE_COOLDOWN_MS) {
      // 冷却期内每 3 秒的 tick 都会走到这里:日志节流到每分钟最多一条。
      if (Date.now() - this.lastCooldownLogAt > 60000) {
        this.lastCooldownLogAt = Date.now()
        console.log('[screensaver] 退出冷却中(5 分钟),跳过自动激活 origin=', origin)
      }
      return
    }
    this.activationOrigin = origin
    this.activating = true
    try {
      this.active = true
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
          preload: join(__dirname, '..', 'screensaver-preload.js'),
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
        // 窗口被其它方式关掉(Alt+F4 等)也要记冷却,否则下一次空闲 tick 会立刻重开。
        this.lastDeactivatedAt = Date.now()
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
    } catch (error) {
      // 窗口创建/加载失败必须复位,否则 active 会永久为 true,空闲检测再也不激活。
      this.active = false
      const win = this.window
      this.window = null
      if (win !== null && !win.isDestroyed()) win.destroy()
      throw error
    } finally {
      this.activating = false
    }
  }

  /** 退出屏保。 */
  deactivate(reason = 'manual'): void {
    if (!this.active && this.window === null) return
    console.log(`[screensaver] 退出(reason=${reason})`)
    this.active = false
    this.lastDeactivatedAt = Date.now()
    const win = this.window
    this.window = null
    if (win !== null && !win.isDestroyed()) win.destroy()
  }

  // ---- 系统屏保注册 ----

  /** 当前可执行文件作为 Windows 屏保的命令行(Windows 会追加 /s 参数拉起)。 */
  private systemScreensaverCommand(): string {
    if (app.isPackaged) return `"${process.execPath}"`
    // 开发模式:electron.exe + 应用目录。
    return `"${process.execPath}" "${app.getAppPath()}"`
  }

  /**
   * 注册为 Windows 系统屏保(HKCU,无需管理员)。注册前备份原设置,取消时恢复。
   *
   * 已注册时**不重新读取注册表**:那时注册表里是本应用自己的命令,再备份一次会把
   * 它当成"用户原设置"存下来,取消注册后就永远恢复不回去了。
   */
  async registerSystemScreensaver(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { ok: false, message: '仅 Windows 支持注册系统屏保' }
    }
    const cfg = this.config.get().screensaver
    const command = this.systemScreensaverCommand()
    const timeout = Math.max(60, Math.round(cfg.idleMinutes * 60))
    try {
      const alreadyRegistered = await this.systemScreensaverRegistered()
      const existingBackup = cfg.systemScreensaverBackup
      const hasBackup = existingBackup !== null && Object.keys(existingBackup).length > 0
      if (!alreadyRegistered || !hasBackup) {
        // 备份用户原有屏保设置,取消注册时恢复。仅在未注册(注册表仍是用户原值时)才刷新备份。
        const backup = await queryDesktopRegistry()
        this.config.update('screensaver', { systemScreensaverBackup: backup })
      }
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'SCRNSAVE.EXE', '/t', 'REG_SZ', '/d', command, '/f'])
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '1', '/f'])
      await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveTimeOut', '/t', 'REG_SZ', '/d', String(timeout), '/f'])
      const suffix = alreadyRegistered ? '(已更新超时;原设置备份保持不变)' : ''
      return { ok: true, message: `已注册为系统屏保(超时 ${timeout} 秒)。${suffix}\n${command}` }
    } catch (error) {
      return { ok: false, message: `注册失败:${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * 取消系统屏保注册(恢复注册前的原设置)。
   *
   * 原本不存在的值用 `reg delete` 删掉,而不是写成空字符串——否则会在注册表里凭空
   * 留下 `SCRNSAVE.EXE=""` 这类条目。
   */
  async unregisterSystemScreensaver(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { ok: false, message: '仅 Windows 支持系统屏保注册' }
    }
    try {
      const backup = this.config.get().screensaver.systemScreensaverBackup
      if (backup !== null && Object.keys(backup).length > 0) {
        for (const [name, value] of Object.entries(backup)) {
          if (value === '') await deleteRegValue(name)
          else await runReg('add', ['HKCU\\Control Panel\\Desktop', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'])
        }
      } else {
        await deleteRegValue('SCRNSAVE.EXE')
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
      const match = /REG_SZ\s+(.*)$/m.exec(output)
      return match !== null && match[1].trim() !== ''
    } catch {
      return false
    }
  }

  // ---- 内部 ----

  private registerIpc(): void {
    ipcMain.handle('screensaver:getConfig', () => this.getConfig())
    ipcMain.handle('screensaver:setConfig', (_event, patch: Partial<ScreensaverConfig>) => this.setConfig(patch))
    ipcMain.handle('screensaver:activate', async () => {
      try {
        return await this.activate()
      } catch (error) {
        console.error('[screensaver] ipc activate failed:', error instanceof Error ? error.message : String(error))
        throw error
      }
    })
    ipcMain.handle('screensaver:deactivate', () => { this.deactivate() })
    ipcMain.handle('screensaver:registerSystem', () => this.registerSystemScreensaver())
    ipcMain.handle('screensaver:unregisterSystem', () => this.unregisterSystemScreensaver())
    ipcMain.handle('screensaver:systemRegistered', () => this.systemScreensaverRegistered())
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
        console.error('[screensaver] 激活失败:', error instanceof Error ? error.message : String(error))
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

/** 删除注册表值(值本就不存在时视为成功)。 */
function deleteRegValue(name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('reg', ['delete', 'HKCU\\Control Panel\\Desktop', '/v', name, '/f'], { windowsHide: true }, () => {
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
