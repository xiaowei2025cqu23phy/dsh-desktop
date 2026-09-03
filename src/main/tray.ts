/**
 * 系统托盘:常驻后台,提供快速操作。
 */

import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import type { HarnessManager } from './harness'
import type { ScreensaverController } from './screensaver'
import type { UpdateChecker } from './updater'

export interface TrayDeps {
  harness: HarnessManager
  screensaver: ScreensaverController
  updater?: UpdateChecker
  /** 远程访问暂停开关(桌面端掌握连接控制权)。 */
  remoteControl?: { paused: () => boolean; toggle: () => void }
  showMainWindow: () => void
  openWebUi: () => void
  quit: () => void
}

export class AppTray {
  private tray: Tray | null = null

  constructor(private deps: TrayDeps) {
    this.deps.harness.on('status', () => this.refresh())
    this.deps.harness.on('log', () => this.refresh())
  }

  create(): void {
    const iconPath = join(__dirname, '..', '..', 'assets', 'tray.png')
    const icon = nativeImage.createFromPath(iconPath)
    const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    this.tray = tray
    tray.setToolTip('DeepSeek Harness Desktop')
    this.refresh()
  }

  refresh(): void {
    if (this.tray === null) return
    const status = this.deps.harness.status()
    const stateLabel: Record<string, string> = {
      idle: '未启动',
      probing: '探测中…',
      external: '已连接外部服务',
      running: '运行中',
      starting: '启动中…',
      stopping: '停止中…',
      stopped: '已停止',
      error: '错误',
    }
    const hasUpdate = this.deps.updater?.hasUpdate() === true
    const updateInfo = this.deps.updater?.getInfo()
    const remotePaused = this.deps.remoteControl?.paused() === true
    const menu = Menu.buildFromTemplate([
      { label: `DeepSeek Harness Desktop — ${stateLabel[status.state] ?? status.state}`, enabled: false },
      { label: `地址:${status.baseUrl}`, enabled: false },
      ...(remotePaused ? [{ label: '🔒 远程访问:已暂停', enabled: false }] : []),
      ...(hasUpdate && updateInfo !== undefined
        ? [
            { type: 'separator' as const },
            {
              label: `⬆ 发现新版本 v${updateInfo.latest}(当前 v${updateInfo.current})`,
              click: () => {
                if (updateInfo.url !== null) void shell.openExternal(updateInfo.url)
              },
            },
          ]
        : []),
      { type: 'separator' },
      { label: '显示主窗口', click: () => this.deps.showMainWindow() },
      { label: '打开 Web UI', click: () => this.deps.openWebUi() },
      ...(this.deps.remoteControl !== undefined
        ? [
            {
              label: remotePaused ? '▶ 恢复远程访问' : '⏸ 暂停远程访问(立即断开)',
              click: () => this.deps.remoteControl!.toggle(),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: this.deps.screensaver.isActive() ? '退出 AI 屏保' : '立即启动 AI 屏保',
        click: () => {
          if (this.deps.screensaver.isActive()) {
            this.deps.screensaver.deactivate()
          } else {
            void this.deps.screensaver.activate().catch((error) => {
              console.error('[tray] 启动屏保失败:', error)
            })
          }
        },
      },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked })
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => this.deps.quit() },
    ])
    this.tray.setContextMenu(menu)
    if (remotePaused) this.tray.setToolTip('DeepSeek Harness Desktop — 远程访问已暂停')
    else if (hasUpdate) this.tray.setToolTip(`DeepSeek Harness Desktop — 发现新版本 v${updateInfo?.latest}`)
    else this.tray.setToolTip('DeepSeek Harness Desktop')
  }

  dispose(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
