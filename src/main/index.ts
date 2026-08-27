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
import { DesktopNotifications } from './notifications'
import { collectDiagnostics } from './diagnostics'
import { QQBotAdapter } from './qq-bot'
import { RemoteCommandProcessor } from './remote-commands'
import { ScreensaverController } from './screensaver'
import { TelegramBotAdapter } from './telegram-bot'
import { UpdateChecker } from './updater'
import { AppTray } from './tray'
import { registerIpc } from './ipc'
import { createMainWindow } from './windows'
import { healProviderSettings, settingsPath } from './settings-heal'
import { previewHarnessConfig } from './config'

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
  let previewHarness: HarnessManager
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
    // 启动即补全模型 provider 缺省配置(只补缺失,不覆盖显式值),避免手动修配置。
    const heal = healProviderSettings(settingsPath(config.get().harness.dshHome))
    for (const message of heal.messages) console.log('[settings-heal]', message)
    harness = new HarnessManager(config.get().harness)
    // 预览实例(实验版 harness):独立端口/DSH_HOME,改动 UI 或引擎时先预览再切主实例。
    previewHarness = new HarnessManager(previewHarnessConfig(config.get().preview))
    if (config.get().preview.enabled) void previewHarness.start()
    const models = new ModelManager(() => harness.client())
    screensaver = new ScreensaverController(config, harness)
    const appearance = new AppearanceManager(config)
    const notifications = new DesktopNotifications(config)
    // mux 事件中枢:由 EventHub 管理,订阅者包括屏保窗口与远程客户端。
    const events = new EventHub(harness)
    events.subscribe((frame) => screensaver.forwardFrame(frame))
    // 统一远程命令核心(QQ / Telegram / Webhook 共用)。
    const commands = new RemoteCommandProcessor(harness, config)
    let telegramBot: TelegramBotAdapter | null = null
    let qqBot: QQBotAdapter | null = null
    // 审批/提问等交互帧转发给命令核心(应答走 /api/respond,与 PWA 同一路径)。
    events.subscribe((frame) => {
      commands.handleInteractionFrame(frame)
      const payload = frame.payload !== null && typeof frame.payload === 'object' ? frame.payload as Record<string, unknown> : {}
      if (frame.method === 'approval/requested') notifications.show('approval', '需要审批', `会话 ${String(payload.sessionId ?? '').slice(0, 16)} 等待工具审批`)
      if (frame.method === 'question/requested') notifications.show('question', '需要回答', `会话 ${String(payload.sessionId ?? '').slice(0, 16)} 等待你的选择`)
    })
    // 主动推送:Telegram 与 QQ(交互后 48h 窗口)都能即时通知审批/提问。
    commands.setPush((channel, userId, text, meta, target) => {
      if (text.startsWith('✅') || text.startsWith('❌')) notifications.show(text.startsWith('✅') ? 'taskDone' : 'taskFail', text.startsWith('✅') ? '任务完成' : '任务失败', text)
      if (channel === 'telegram' && telegramBot !== null) void telegramBot.sendMessage(Number(userId), text)
      else if (channel === 'qq' && qqBot !== null) void qqBot.sendToUser(userId, text, meta, target)
    })
    // QQ 私聊对话流式输出(打字机效果)。
    commands.setChatStream({
      onDelta: (channel, userId, delta, target) => {
        if (channel === 'qq' && qqBot !== null) qqBot.onChatDelta(channel, userId, delta, target)
      },
      onEnd: (channel, userId, target) => {
        if (channel === 'qq' && qqBot !== null) qqBot.onChatEnd(channel, userId, target)
      },
    })
    const gateway = new RemoteGateway(config, harness, events, commands)
    // 新设备请求远程访问:桌面通知 + 通知点击聚焦主窗口并拉起审批。
    gateway.onPendingDevice = (device) => {
      notifications.show('approval', '📱 新设备请求远程访问', `${device.label} (${device.address})\n点击查看并批准,或稍后在设置中处理`)
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
      if (win !== undefined && !win.isDestroyed()) {
        win.webContents.send('remote:device-pending', device)
      }
    }
    commands.setExportDir(join(app.getPath('userData'), 'exports'))
    qqBot = new QQBotAdapter(config, commands)
    telegramBot = new TelegramBotAdapter(config, commands)
    const updater = new UpdateChecker()
    registerIpc({ config, harness, preview: previewHarness, models, screensaver, appearance, gateway, qqBot, telegramBot, updater, commands,
      diagnostics: () => collectDiagnostics({ config, harness, gateway, qqBot, telegramBot }) })

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

    // 正常模式:主窗口 + 托盘 + 空闲检测 + 远程网关 + QQ/Telegram 机器人。
    gateway.start()
    void qqBot.start()
    void telegramBot.start()
    mainWindow = createMainWindow(join(__dirname, '..', 'preload.js'), config)
    mainWindow.on('closed', () => { mainWindow = null })

    screensaver.start()
    tray = new AppTray({
      harness,
      screensaver,
      showMainWindow: () => {
        if (mainWindow === null) {
          mainWindow = createMainWindow(join(__dirname, '..', 'preload.js'), config)
          mainWindow.on('closed', () => { mainWindow = null })
        } else if (mainWindow.isDestroyed()) {
          mainWindow = createMainWindow(join(__dirname, '..', 'preload.js'), config)
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
        previewHarness.stop()
        app.quit()
      },
    })
    tray.create()

    await harness.start()
    // 恢复任务队列:上次运行中被退出中断的项标记失败,等待手动重试。
    commands.recoverQueue()

    // 启动后延迟自动检查更新(设置面板可关闭);有新版本时托盘刷新提示。
    if (config.get().updater.autoCheck) {
      setTimeout(() => {
        void updater.check().then(() => tray?.refresh())
      }, 20000)
    }

    // 定时任务调度 + 失败队列自动重试(每 30 秒检查一次)。
    setInterval(() => {
      void commands.tickScheduled().catch((error) => {
        console.error('[sched] 定时任务执行失败:', error)
      })
      void commands.tickQueue().catch((error) => {
        console.error('[queue] 队列重试执行失败:', error)
      })
    }, 30000)

    let quitCleanupDone = false
    app.on('before-quit', (event) => {
      console.log('[main] before-quit')
      if (quitCleanupDone) return
      event.preventDefault()
      quitting = true
      void (async () => {
        if (config.get().harness.stopOnQuit) await harness.stop()
        if (config.get().preview.stopOnQuit) await previewHarness.stop()
        screensaver.dispose()
        tray?.dispose()
        events.dispose()
        gateway.stop()
        config.close()
        await qqBot?.stop()
        telegramBot?.stop()
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
