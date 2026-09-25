/**
 * dsh-desktop 入口。
 *
 * 启动参数:
 * - `/s` 或 `--screensaver`:以系统屏保模式启动(Windows 屏保拉起方式),直接进入全屏。
 * - 无参数:正常模式(主窗口 + 托盘 + 空闲检测)。
 */

import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron'
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AppearanceManager } from './appearance'
import { ConfigStore, previewHarnessConfig } from './config'
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

// 开发模式(未打包,electron .)使用独立 userData:避免与打包版共享 config.json、
// 单实例锁与日志,防止「开发实例把正式版顶掉 / 正式版被开发实例占锁」这类互踢。
if (!app.isPackaged) {
  try {
    app.setPath('userData', join(app.getPath('appData'), 'DeepSeek Harness Desktop-dev'))
  } catch {
    // 设置失败则沿用默认,不影响启动。
  }
}

// 控制台镜像到 userData/desktop.log(打包版没有控制台,崩溃与诊断信息落盘可查)。
function mirrorConsoleToFile(): void {
  try {
    const path = join(app.getPath('userData'), 'desktop.log')
    const maxBytes = 2 * 1024 * 1024
    mkdirSync(dirname(path), { recursive: true })
    const rotate = (): void => {
      try {
        rmSync(`${path}.1`, { force: true })
        renameSync(path, `${path}.1`)
      } catch {
        // 旋转失败(占用等)则忽略,日志继续追加。
      }
    }
    try {
      if (statSync(path).size > maxBytes) rotate()
    } catch {
      // 文件尚不存在,无需旋转。
    }
    let stream = createWriteStream(path, { flags: 'a' })
    let writtenBytes = 0
    const stamp = (): string => new Date().toISOString()
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      const original = console[level].bind(console)
      console[level] = (...args: unknown[]) => {
        original(...args)
        const line = `[${stamp()}] [${level}] ${args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')}\n`
        writtenBytes += line.length
        if (writtenBytes > maxBytes) {
          writtenBytes = 0
          try { stream.end() } catch { /* 忽略 */ }
          rotate()
          stream = createWriteStream(path, { flags: 'a' })
        }
        stream.write(line)
      }
    }
  } catch {
    // 日志不可用不影响应用运行。
  }
}
mirrorConsoleToFile()

// 渲染进程/子进程崩溃记录(无 crashpad 时也能定位「一点就断联」类问题)。
app.on('render-process-gone', (_event, _webContents, details) => {
  console.error(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
})
app.on('child-process-gone', (_event, details) => {
  console.error(`[child-process-gone] type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
})

// 主进程未捕获异常/未处理 rejection:只记日志,不让进程直接死掉。
// 桌面端是常驻托盘应用,一次未捕获的 rejection 就退出会让用户以为"它自己关了";
// 记下来 + 保持运行,比静默崩溃更有用(启动期的致命错误由 reportFatalStartupError 负责)。
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason))
})

/**
 * 启动失败/未捕获异常的可见兜底:写日志 + 弹对话框给出可执行的下一步。
 *
 * 打包版没有控制台,不弹窗就等于"双击没反应"。对话框提供三个出路:打开数据目录
 * (看/删 config.json、local.db)、打开日志、退出。
 */
async function reportFatalStartupError(error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  console.error('[main] 致命启动错误:', message)
  try {
    const userData = app.getPath('userData')
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: 'DeepSeek Harness Desktop 启动失败',
      message: '应用启动时出错,无法继续。',
      detail: `${error instanceof Error ? error.message : String(error)}\n\n` +
        `数据目录:${userData}\n日志:${join(userData, 'desktop.log')}`,
      buttons: ['打开数据目录', '打开日志', '退出'],
      defaultId: 0,
      cancelId: 2,
    })
    if (choice.response === 0) await shell.openPath(userData)
    else if (choice.response === 1) await shell.openPath(join(userData, 'desktop.log'))
  } catch (dialogError) {
    console.error('[main] 错误对话框也失败了:', dialogError)
  }
  app.exit(1)
}

const SCREENSAVER_ARGS = ['/s', '-s', '--screensaver']
const isScreensaverLaunch = (): boolean =>
  process.argv.some((arg) => SCREENSAVER_ARGS.includes(arg.toLowerCase()))

/** 「状态」指令附带的通道健康行:QQ/Telegram 连接与最近失败原因(群聊"没反应"时自检用)。 */
function botHealthLines(qqBot: QQBotAdapter | null, telegramBot: TelegramBotAdapter | null): string[] {
  const lines: string[] = []
  const fmt = (ts: number): string => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
  const q = qqBot?.diag()
  if (q !== undefined) {
    if (!q.configured) {
      lines.push('🤖 QQ 机器人:未启用(设置 → QQ 机器人填入凭据)')
    } else if (q.locked) {
      lines.push('🤖 QQ 机器人:🔒 门禁未就绪(尚未确认 QQ 开放平台已关闭「允许被添加为好友」,不启动;设置页重新确认)')
    } else if (q.connected) {
      const scope = q.restricted ? '仅服务白名单用户' : '白名单留空:所有能发消息给机器人的人都会被服务'
      lines.push(`🤖 QQ 机器人:✓ 已连接${q.readyAt !== null ? `(${fmt(q.readyAt)})` : ''}(${scope})`)
    } else {
      lines.push('🤖 QQ 机器人:⚠️ 未连接(见下方最近失败;仍无头绪看服务日志)')
    }
    if (q.lastError !== null) {
      lines.push(`  ⚠️ 最近失败(${q.lastError.action}):${q.lastError.detail.slice(0, 120)}`)
      if (q.lastError.hint !== '') lines.push(`  💡 ${q.lastError.hint}`)
    }
    if (q.deniedUsers.length > 0) {
      const latest = q.deniedUsers[q.deniedUsers.length - 1]
      lines.push(`  🔒 最近被拒绝的 openid:${latest.id}(不在白名单)`)
    }
  }
  const t = telegramBot?.diag()
  if (t !== undefined) {
    if (!t.configured) {
      lines.push('✈️ Telegram 机器人:未启用(设置 → Telegram 机器人填入 Token)')
    } else if (t.locked) {
      lines.push('✈️ Telegram 机器人:🔒 锁定(未填「允许的用户 ID」,不服务任何聊天;设置页可一键绑定)')
    } else if (t.started) {
      lines.push('✈️ Telegram 机器人:✓ 运行中(仅服务白名单用户)')
    } else {
      lines.push('✈️ Telegram 机器人:⚠️ 未运行(令牌无效或已停止)')
    }
    if (t.lastError !== null) lines.push(`  ⚠️ 最近失败(${t.lastError.action}):${t.lastError.detail.slice(0, 120)}`)
    if (t.deniedChats.length > 0) {
      const latest = t.deniedChats[t.deniedChats.length - 1]
      lines.push(`  🔒 最近被拒绝的用户 ID:${latest.id}(不在白名单)`)
    }
  }
  return lines
}

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
      void screensaver.activate('system').catch((error) => {
        console.error('[screensaver] 激活失败:', error instanceof Error ? error.message : String(error))
      })
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
    screensaver = new ScreensaverController(config)
    const appearance = new AppearanceManager(config)
    const notifications = new DesktopNotifications(config)
    // mux 事件中枢:由 EventHub 管理,订阅者包括远程客户端与命令核心。
    const events = new EventHub(harness, config)
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
      if (channel === 'telegram' && telegramBot !== null) {
        // 群聊推送回群(处理器传 target),私聊按用户推送。
        const chatId = target !== undefined && target.scope === 'group' ? target.targetId : userId
        void telegramBot.sendMessage(Number(chatId), text)
      } else if (channel === 'qq' && qqBot !== null) void qqBot.sendToUser(userId, text, meta, target)
    })
    // 通道健康(QQ/Telegram 连接状态 + 最近失败原因)注入「状态」指令。
    commands.setBotHealth(() => botHealthLines(qqBot, telegramBot))
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
    // 网络地址变化(网卡接入/换网/DHCP 续租)后让 HTTPS 证书跟上,否则手机用新地址访问
    // 会因 SAN 不匹配 TLS 失败,而且 Service Worker 也注册不上。仅 HTTPS 开启时才有意义。
    // 已建立的连接需要重新握手,所以重签后要重启监听。
    const certFollow = setInterval(() => {
      try {
        if (gateway.revalidateHttpsCert()) gateway.restart()
      } catch (error) {
        console.warn('[main] 证书跟随检查失败:', error instanceof Error ? error.message : String(error))
      }
    }, 60_000)
    certFollow.unref?.()
    app.on('will-quit', () => clearInterval(certFollow))
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
      updater,
      // 托盘快捷开关:暂停/恢复远程访问(桌面端掌握连接控制权)。
      remoteControl: {
        paused: () => gateway.paused(),
        toggle: () => {
          gateway.togglePause()
          tray?.refresh()
        },
      },
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

    // 锁屏/睡眠自动暂停远程访问(解锁后需桌面端手动恢复)——控制权始终在桌面端。
    const autoPauseRemote = (reason: string): void => {
      const remote = config.get().remote
      if (!remote.enabled || remote.paused === true || remote.pauseOnLock === false) return
      gateway.setPaused(true)
      console.warn(`[main] 远程访问已自动暂停(原因:${reason})`)
      tray?.refresh()
    }
    powerMonitor.on('lock-screen', () => autoPauseRemote('屏幕锁定'))
    powerMonitor.on('suspend', () => autoPauseRemote('系统睡眠'))

    await harness.start()
    // 恢复任务队列:上次运行中被退出中断的项标记失败,等待手动重试。
    commands.recoverQueue()
    // 历史老会话补名:旧版本遗留的「新会话」按首条消息批量命名(限 15 个,避免拖慢启动)。
    setTimeout(() => {
      void commands.backfillSessionTitles().catch(() => {})
    }, 8000)

    // 启动后延迟自动检查更新(设置面板可关闭);有新版本时托盘刷新提示 + 桌面通知。
    if (config.get().updater.autoCheck) {
      setTimeout(() => {
        void updater.check().then((info) => {
          tray?.refresh()
          const url = info.url
          if (updater.hasUpdate() && url !== null) {
            notifications.show('update', `发现新版本 v${info.latest}`, '点击通知前往下载页(当前 v' + info.current + ')', () => {
              void shell.openExternal(url)
            })
          }
        })
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
  }).catch((error) => {
    // 启动链路兜底:此前这里没有 catch,任何早期抛出(如 userData 不可写、本地库无法
    // 建立)**没有窗口、没有对话框**,用户只能看到一行没人找得到的 desktop.log。
    void reportFatalStartupError(error)
  })
}
