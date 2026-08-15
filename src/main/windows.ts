/**
 * 主窗口:原生控制条(状态、模型切换、屏保控制)+ 内嵌 harness Web UI(webview)。
 */

import { BrowserWindow } from 'electron'
import { join } from 'node:path'

export function createMainWindow(preloadPath: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  return win
}
