/**
 * 屏保窗口专用 preload。
 *
 * 屏保是纯展示页(壁纸 + 时钟),不需要主窗口那 100 多个 IPC 方法。单独一份最小桥
 * 的意义:渲染进程再被注入什么,拿到的也只是这三个通道,而不是整个 dshDesktop。
 *
 * 壁纸与遮罩直接复用主窗口已有的 appearance 通道,避免第二份实现走样。
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshScreen', {
  /** 屏保壁纸(data URL + cover 布点);未设置时 dataUrl 为 null。 */
  wallpaper: () => ipcRenderer.invoke('appearance:wallpaperData', 'screensaver'),
  /** 外观配置(取遮罩强度)。 */
  appearance: () => ipcRenderer.invoke('appearance:getConfig'),
  /** 退出屏保。 */
  exit: () => ipcRenderer.invoke('screensaver:deactivate'),
})
