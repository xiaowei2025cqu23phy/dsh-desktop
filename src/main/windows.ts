/**
 * 主窗口:原生控制条(状态、模型切换、屏保控制)+ 内嵌 harness Web UI(webview)。
 */

import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { ConfigStore } from './config'

export function createMainWindow(preloadPath: string, config?: ConfigStore): BrowserWindow {
  const saved = config?.get().window ?? { width: 1280, height: 800 }
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness Desktop',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    icon: join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })
  win.setMenu(null)
  // 记忆窗口尺寸(防抖 500ms 落盘)。
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  const saveSize = (): void => {
    if (config === undefined || win.isDestroyed() || win.isFullScreen()) return
    const [width, height] = win.getSize()
    config.update('window', { width, height })
  }
  win.on('resize', () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(saveSize, 500)
  })
  win.on('close', () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer)
    saveSize()
  })
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  return win
}
