/**
 * dsh-desktop 入口。
 *
 * 启动参数:
 * - `/s` 或 `--screensaver`:以系统屏保模式启动(Windows 屏保拉起方式),直接进入全屏。
 * - 无参数:正常模式(主窗口 + 托盘 + 空闲检测)。
 */

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { AppearanceManager } from './appearance'
import { ConfigStore } from './config'
import { EventHub } from './event-hub'
import { RemoteGateway } from './gateway'
import { HarnessManager } from './harness'
import { ModelManager } from './models'
import { QQBotAdapter } from './qq-bot'
import { ScreensaverController } from './screensaver'
import { AppTray } from './tray'
import { registerIpc } from './ipc'
import { createMainWindow } from './windows'

const SCREENSAVER_ARGS = ['/s', '-s', '--screensaver']
const isScreensaverLaunch = (): boolean =>
  process.argv.some((arg) => SCREENSAVER_ARGS.includes(arg.toLowerCase()))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例在运行:把屏保请求转发给它,然后退出。
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let tray: AppTray | null = null
  let screensaver: ScreensaverController
  let harness: HarnessManager
  let quitting = false
  app.on('second-instance', (_event, argv) => {
    console.log('[main] second-instance argv:', JSON.stringify(argv))
    const wantsScreensaver = argv.some((arg) => SCREENSAVER_ARGS.includes(arg.toLowerCase()))
    console.log('[main] wantsScreensaver:', wantsScreensaver)
    if (wantsScreensaver) {
      // Windows 系统屏保拉起:受退出冷却约束,防止"退出后又立刻被拉起"循环。
      void screensaver.activate('system').catch((error) => console.error('[screensaver] 激活失败:', error))
    } else if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const config = new ConfigStore()
    harness = new HarnessManager(config.get().harness)
    const models = new ModelManager(() => harness.client())
    screensaver = new ScreensaverController(config, harness)
    const appearance = new AppearanceManager(config)
    // mux 事件中枢:由 EventHub 管理,订阅者包括屏保窗口与远程客户端。
    const events = new EventHub(harness)
    events.subscribe((frame) => screensaver.forwardFrame(frame))
    const gateway = new RemoteGateway(config, harness, events)
    const qqBot = new QQBotAdapter(config, harness)
    registerIpc({ config, harness, models, screensaver, appearance, gateway, qqBot })

    if (isScreensaverLaunch()) {
      // 系统屏保模式:只启动屏保窗口,不创建主窗口与托盘。
      screensaver.start()
      await harness.start()
      try {
        await screensaver.activate('system')
      } catch (error) {
        console.error('[screensaver] 屏保模式启动失败:', error)
        app.quit()
      }
      app.on('before-quit', () => {
        harness.stop()
        screensaver.dispose()
      })
      return
    }

    // 正常模式:主窗口 + 托盘 + 空闲检测 + 远程网关 + QQ 机器人。
    gateway.start()
    void qqBot.start()
    mainWindow = createMainWindow(join(__dirname, '..', 'preload.js'))
    mainWindow.on('closed', () => { mainWindow = null })

    screensaver.start()
    tray = new AppTray({
      harness,
      screensaver,
      showMainWindow: () => {
        if (mainWindow === null) {
          mainWindow = createMainWindow(join(__dirname, '..', 'preload.js'))
          mainWindow.on('closed', () => { mainWindow = null })
        } else if (mainWindow.isDestroyed()) {
          mainWindow = createMainWindow(join(__dirname, '..', 'preload.js'))
          mainWindow.on('closed', () => { mainWindow = null })
        }
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      },
      openWebUi: () => {
        void shell.openExternal(harness.baseUrl())
      },
      quit: () => {
        quitting = true
        harness.stop()
        app.quit()
      },
    })
    tray.create()

    await harness.start()

    let quitCleanupDone = false
    app.on('before-quit', (event) => {
      console.log('[main] before-quit')
      if (quitCleanupDone) return
      event.preventDefault()
      quitting = true
      void (async () => {
        if (config.get().harness.stopOnQuit) await harness.stop()
        screensaver.dispose()
        tray?.dispose()
        events.dispose()
        gateway.stop()
        await qqBot.stop()
        quitCleanupDone = true
        app.quit()
      })()
    })

    // 窗口全关时保持托盘常驻(除非正在退出)。
    app.on('window-all-closed', () => {
      console.log('[main] window-all-closed (quitting=', quitting, ')')
      if (!quitting) {
        // 保持后台运行。
      } else {
        app.quit()
      }
    })
    app.on('will-quit', () => {
      console.log('[main] will-quit')
    })
  })
}
