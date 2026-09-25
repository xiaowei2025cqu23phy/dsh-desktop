/**
 * Preload:通过 contextBridge 暴露类型安全的桌面端 API。
 * 同时服务于主窗口(index.html)与屏保窗口(screensaver.html)。
 */

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  harness: {
    getStatus: () => ipcRenderer.invoke('harness:getStatus'),
    launchToken: () => ipcRenderer.invoke('harness:launchToken'),
    capabilities: () => ipcRenderer.invoke('harness:capabilities'),
    getConfig: () => ipcRenderer.invoke('harness:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('harness:setConfig', patch),
    restart: () => ipcRenderer.invoke('harness:restart'),
    stop: () => ipcRenderer.invoke('harness:stop'),
    getLogs: () => ipcRenderer.invoke('harness:getLogs'),
    openWebUi: () => ipcRenderer.invoke('harness:openWebUi'),
  },
  preview: {
    getStatus: () => ipcRenderer.invoke('preview:getStatus'),
    capabilities: () => ipcRenderer.invoke('preview:capabilities'),
    getConfig: () => ipcRenderer.invoke('preview:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('preview:setConfig', patch),
    start: () => ipcRenderer.invoke('preview:start'),
    stop: () => ipcRenderer.invoke('preview:stop'),
    restart: () => ipcRenderer.invoke('preview:restart'),
    getLogs: () => ipcRenderer.invoke('preview:getLogs'),
    openWebUi: () => ipcRenderer.invoke('preview:openWebUi'),
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
    // 退出屏保由屏保窗口自己的最小 preload(src/screensaver-preload.ts)负责;
    // 主窗口不需要这个通道,故不在这里暴露。
    registerSystem: () => ipcRenderer.invoke('screensaver:registerSystem'),
    unregisterSystem: () => ipcRenderer.invoke('screensaver:unregisterSystem'),
    systemRegistered: () => ipcRenderer.invoke('screensaver:systemRegistered'),
  },
  remote: {
    getConfig: () => ipcRenderer.invoke('remote:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('remote:setConfig', patch),
    lanAddresses: () => ipcRenderer.invoke('remote:lanAddresses'),
    // 实际监听状态(与配置里的 bindHost 区分):监听失败或地址回退时如实反映。
    state: () => ipcRenderer.invoke('remote:state'),
    httpsCertInfo: () => ipcRenderer.invoke('remote:httpsCertInfo'),
    pairUrl: () => ipcRenderer.invoke('remote:pairUrl'),
    qrDataUrl: () => ipcRenderer.invoke('remote:qrDataUrl'),
    qrDataUrls: () => ipcRenderer.invoke('remote:qrDataUrls'),
    // 已连接设备:桌面端只用来暂停/拉黑(令牌有效即访问权)。
    approvedDevices: () => ipcRenderer.invoke('remote:approvedDevices'),
    revokeDevice: (id: string) => ipcRenderer.invoke('remote:revokeDevice', id),
    setPaused: (paused: boolean) => ipcRenderer.invoke('remote:setPaused', paused),
    pauseDevice: (id: string) => ipcRenderer.invoke('remote:pauseDevice', id),
    resumeDevice: (id: string) => ipcRenderer.invoke('remote:resumeDevice', id),
    blacklistDevice: (id: string) => ipcRenderer.invoke('remote:blacklistDevice', id),
    unblacklistDevice: (id: string) => ipcRenderer.invoke('remote:unblacklistDevice', id),
    blacklistedDevices: () => ipcRenderer.invoke('remote:blacklistedDevices'),
  },
  dialog: {
    pickDirectories: () => ipcRenderer.invoke('dialog:pickDirectories'),
    pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  },
  qq: {
    getConfig: () => ipcRenderer.invoke('qq:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('qq:setConfig', patch),
    status: () => ipcRenderer.invoke('qq:status'),
    diag: () => ipcRenderer.invoke('qq:diag'),
    onboardStart: () => ipcRenderer.invoke('qq:onboardStart'),
    onboardStatus: () => ipcRenderer.invoke('qq:onboardStatus'),
    onboardCancel: () => ipcRenderer.invoke('qq:onboardCancel'),
  },
  telegram: {
    getConfig: () => ipcRenderer.invoke('telegram:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('telegram:setConfig', patch),
    status: () => ipcRenderer.invoke('telegram:status'),
    diag: () => ipcRenderer.invoke('telegram:diag'),
    bindStart: () => ipcRenderer.invoke('telegram:bindStart'),
    bindCancel: () => ipcRenderer.invoke('telegram:bindCancel'),
  },
  bot: {
    getConfig: () => ipcRenderer.invoke('bot:getConfig'),
    setConfig: (patch: { taskPrompt?: string; chatPrompt?: string }) => ipcRenderer.invoke('bot:setConfig', patch),
    help: () => ipcRenderer.invoke('bot:help'),
  },
  notifications: {
    getConfig: () => ipcRenderer.invoke('notifications:getConfig'),
    setConfig: (patch: object) => ipcRenderer.invoke('notifications:setConfig', patch),
  },
  usage: {
    getConfig: () => ipcRenderer.invoke('usage:getConfig'),
    setConfig: (patch: { multiplier?: number; dailyBudget?: number; monthlyBudget?: number; onExceed?: 'notify' | 'block' }) =>
      ipcRenderer.invoke('usage:setConfig', patch),
    report: () => ipcRenderer.invoke('usage:report'),
  },
  interactions: {
    list: () => ipcRenderer.invoke('interactions:list'),
    respondApproval: (sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected') => ipcRenderer.invoke('interactions:respondApproval', sessionId, approvalId, outcome),
    respondQuestion: (sessionId: string, questionId: string, optionIndex: number) => ipcRenderer.invoke('interactions:respondQuestion', sessionId, questionId, optionIndex),
  },
  tasks: {
    history: () => ipcRenderer.invoke('tasks:history'),
    clearHistory: () => ipcRenderer.invoke('tasks:clearHistory'),
  },
  queue: {
    list: () => ipcRenderer.invoke('queue:list'),
    cancel: (id: string) => ipcRenderer.invoke('queue:cancel', id),
    retry: (id: string) => ipcRenderer.invoke('queue:retry', id),
    // 清理:只允许删除终态条目,排队/运行中的要先取消。
    delete: (id: string) => ipcRenderer.invoke('queue:delete', id),
    clearFinished: () => ipcRenderer.invoke('queue:clearFinished'),
  },
  activity: {
    list: () => ipcRenderer.invoke('activity:list'),
    // 停止会话(session.cancel):返回 { ok, message },成功失败都反馈给用户。
    stop: (sessionId: string) => ipcRenderer.invoke('activity:stop', sessionId),
    stopAll: () => ipcRenderer.invoke('activity:stopAll'),
    // 清理:只删已结束的记录,运行中/等待中的保留(否则用户没有入口看到并停止它)。
    delete: (id: string) => ipcRenderer.invoke('activity:delete', id),
    clearFinished: () => ipcRenderer.invoke('activity:clearFinished'),
  },
  workspace: {
    health: () => ipcRenderer.invoke('workspace:health'),
    changes: (path: string, diff = false) => ipcRenderer.invoke('workspace:changes', path, diff),
    openFolder: (path: string) => ipcRenderer.invoke('workspace:openFolder', path),
  },
  audit: {
    list: () => ipcRenderer.invoke('audit:list'),
    clear: () => ipcRenderer.invoke('audit:clear'),
    export: () => ipcRenderer.invoke('audit:export'),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    get: (path: string) => ipcRenderer.invoke('memory:get', path),
    set: (path: string, memory: { enabled: boolean; summary: string; conventions: string; commands: string; notes: string }) => ipcRenderer.invoke('memory:set', path, memory),
    clear: (path: string) => ipcRenderer.invoke('memory:clear', path),
    suggest: (path: string) => ipcRenderer.invoke('memory:suggest', path),
  },
  diagnostics: {
    collect: () => ipcRenderer.invoke('diagnostics:collect'),
    export: () => ipcRenderer.invoke('diagnostics:export'),
  },
  config: {
    backup: () => ipcRenderer.invoke('config:backup'),
    exportSafe: () => ipcRenderer.invoke('config:exportSafe'),
    importSafe: () => ipcRenderer.invoke('config:importSafe'),
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
    info: () => ipcRenderer.invoke('app:info'),
    recoveryNotice: () => ipcRenderer.invoke('app:recoveryNotice'),
    openSettingsFolder: () => ipcRenderer.invoke('app:openSettingsFolder'),
    // 应用自己的数据目录与日志导出:不依赖 harness,harness 挂掉时仍可用。
    openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
    exportLogs: () => ipcRenderer.invoke('app:exportLogs'),
  },
  onboarding: {
    get: () => ipcRenderer.invoke('onboarding:get'),
    complete: () => ipcRenderer.invoke('onboarding:complete'),
  },
  updater: {
    getInfo: () => ipcRenderer.invoke('updater:getInfo'),
    check: () => ipcRenderer.invoke('updater:check'),
    getConfig: () => ipcRenderer.invoke('updater:getConfig'),
    setConfig: (patch: { autoCheck?: boolean }) => ipcRenderer.invoke('updater:setConfig', patch),
    openRelease: () => ipcRenderer.invoke('updater:openRelease'),
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DesktopApi = typeof api
