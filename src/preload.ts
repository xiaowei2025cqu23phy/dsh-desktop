/**
 * Preload:通过 contextBridge 暴露类型安全的桌面端 API。
 * 同时服务于主窗口(index.html)与屏保窗口(screensaver.html)。
 */

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  harness: {
    getStatus: () => ipcRenderer.invoke('harness:getStatus'),
    getConfig: () => ipcRenderer.invoke('harness:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('harness:setConfig', patch),
    restart: () => ipcRenderer.invoke('harness:restart'),
    stop: () => ipcRenderer.invoke('harness:stop'),
    getLogs: () => ipcRenderer.invoke('harness:getLogs'),
    openWebUi: () => ipcRenderer.invoke('harness:openWebUi'),
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    setDefault: (provider: string, model: string) => ipcRenderer.invoke('models:setDefault', provider, model),
    addProvider: (spec: unknown) => ipcRenderer.invoke('models:addProvider', spec),
    removeProvider: (id: string) => ipcRenderer.invoke('models:removeProvider', id),
    discover: (baseURL: string, api: string, apiKey: string) =>
      ipcRenderer.invoke('models:discover', baseURL, api, apiKey),
  },
  screensaver: {
    getConfig: () => ipcRenderer.invoke('screensaver:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('screensaver:setConfig', patch),
    activate: () => ipcRenderer.invoke('screensaver:activate'),
    deactivate: () => ipcRenderer.invoke('screensaver:deactivate'),
    isActive: () => ipcRenderer.invoke('screensaver:isActive'),
    startTask: () => ipcRenderer.invoke('screensaver:startTask'),
    cancelTask: () => ipcRenderer.invoke('screensaver:cancelTask'),
    history: (sessionId: string, maxMessages?: number) =>
      ipcRenderer.invoke('screensaver:history', sessionId, maxMessages),
    registerSystem: () => ipcRenderer.invoke('screensaver:registerSystem'),
    unregisterSystem: () => ipcRenderer.invoke('screensaver:unregisterSystem'),
    systemRegistered: () => ipcRenderer.invoke('screensaver:systemRegistered'),
    attach: () => ipcRenderer.invoke('screensaver:attach'),
    reportSessionId: (sessionId: string) => ipcRenderer.send('screensaver:session-id', sessionId),
    onEvent: (callback: (frame: unknown) => void) => {
      const listener = (_event: unknown, frame: unknown): void => callback(frame)
      ipcRenderer.on('screensaver:event', listener)
      return () => { ipcRenderer.removeListener('screensaver:event', listener) }
    },
  },
  remote: {
    getConfig: () => ipcRenderer.invoke('remote:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('remote:setConfig', patch),
    lanAddresses: () => ipcRenderer.invoke('remote:lanAddresses'),
    pairUrl: () => ipcRenderer.invoke('remote:pairUrl'),
    qrDataUrl: () => ipcRenderer.invoke('remote:qrDataUrl'),
  },
  qq: {
    getConfig: () => ipcRenderer.invoke('qq:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('qq:setConfig', patch),
    status: () => ipcRenderer.invoke('qq:status'),
  },
  telegram: {
    getConfig: () => ipcRenderer.invoke('telegram:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('telegram:setConfig', patch),
    status: () => ipcRenderer.invoke('telegram:status'),
  },
  appearance: {
    getConfig: () => ipcRenderer.invoke('appearance:getConfig'),
    pickSource: (kind: 'window' | 'phone' | 'screensaver') => ipcRenderer.invoke('appearance:pickSource', kind),
    saveWallpaper: (kind: 'window' | 'phone' | 'screensaver', dataUrl: string, position: { x: number; y: number }) =>
      ipcRenderer.invoke('appearance:saveWallpaper', kind, dataUrl, position),
    clear: (kind: 'window' | 'phone' | 'screensaver') => ipcRenderer.invoke('appearance:clear', kind),
    setMask: (mask: number) => ipcRenderer.invoke('appearance:setMask', mask),
    wallpaperData: (kind: 'window' | 'phone' | 'screensaver') =>
      ipcRenderer.invoke('appearance:wallpaperData', kind),
    listPacks: () => ipcRenderer.invoke('appearance:listPacks'),
    applyPack: (id: string) => ipcRenderer.invoke('appearance:applyPack', id),
  },
  app: {
    openSettingsFolder: () => ipcRenderer.invoke('app:openSettingsFolder'),
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  updater: {
    getInfo: () => ipcRenderer.invoke('updater:getInfo'),
    check: () => ipcRenderer.invoke('updater:check'),
    openRelease: () => ipcRenderer.invoke('updater:openRelease'),
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DesktopApi = typeof api
