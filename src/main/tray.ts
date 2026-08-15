/**
 * 系统托盘:常驻后台,提供快速操作。
 */

import { Menu, Tray, app, nativeImage } from 'electron'
import { join } from 'node:path'
import type { HarnessManager } from './harness'
import type { ScreensaverController } from './screensaver'

export interface TrayDeps {
  harness: HarnessManager
  screensaver: ScreensaverController
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
    const menu = Menu.buildFromTemplate([
      { label: `DeepSeek Harness Desktop — ${stateLabel[status.state] ?? status.state}`, enabled: false },
      { label: `地址:${status.baseUrl}`, enabled: false },
      { type: 'separator' },
      { label: '显示主窗口', click: () => this.deps.showMainWindow() },
      { label: '打开 Web UI', click: () => this.deps.openWebUi() },
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
  }

  dispose(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
