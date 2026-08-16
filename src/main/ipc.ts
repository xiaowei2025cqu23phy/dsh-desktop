/**
 * IPC 装配:把 harness / models / screensaver 的能力暴露给渲染进程。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import type { AppearanceManager } from './appearance'
import type { ConfigStore } from './config'
import type { RemoteGateway } from './gateway'
import type { HarnessManager } from './harness'
import type { ModelManager } from './models'
import type { QQBotAdapter } from './qq-bot'
import type { ScreensaverController } from './screensaver'

export interface IpcDeps {
  config: ConfigStore
  harness: HarnessManager
  models: ModelManager
  screensaver: ScreensaverController
  appearance: AppearanceManager
  gateway?: RemoteGateway
  qqBot?: QQBotAdapter
}

export function registerIpc(deps: IpcDeps): void {
  // ---- harness ----
  ipcMain.handle('harness:getStatus', () => deps.harness.status())
  ipcMain.handle('harness:getConfig', () => deps.config.get().harness)
  ipcMain.handle('harness:setConfig', (_event, patch: object) => {
    const next = deps.config.update('harness', patch)
    deps.harness.updateConfig(next)
    return deps.harness.status()
  })
  ipcMain.handle('harness:restart', () => deps.harness.restart())
  ipcMain.handle('harness:stop', () => deps.harness.stop())
  ipcMain.handle('harness:getLogs', () => deps.harness.logs.slice(-200))
  ipcMain.handle('harness:openWebUi', () => {
    void shell.openExternal(deps.harness.baseUrl())
  })

  // ---- models ----
  ipcMain.handle('models:list', async () => {
    const [providers, models, selected] = await Promise.all([
      deps.models.providers(),
      deps.models.models(),
      deps.models.defaultSelection(),
    ])
    return { providers, groups: models.groups, failures: models.failures, selected }
  })
  ipcMain.handle('models:setDefault', (_event, provider: string, model: string) =>
    deps.models.setDefault(provider, model))
  ipcMain.handle('models:addProvider', (_event, spec: unknown) =>
    deps.models.addCustomProvider(spec as Parameters<ModelManager['addCustomProvider']>[0]))
  ipcMain.handle('models:removeProvider', (_event, id: string) => deps.models.removeProvider(id))
  ipcMain.handle('models:discover', (_event, baseURL: string, api: string, apiKey: string) =>
    deps.models.discoverModels(baseURL, api, apiKey))

  // ---- 远程网关 ----
  if (deps.gateway !== undefined) {
    const gateway = deps.gateway
    ipcMain.handle('remote:getConfig', () => gateway.getConfig())
    ipcMain.handle('remote:setConfig', (_event, patch: object) => {
      const next = gateway.setConfig(patch)
      gateway.restart()
      return next
    })
    ipcMain.handle('remote:lanAddresses', () => gateway.lanAddresses())
    ipcMain.handle('remote:pairUrl', () => gateway.pairUrl())
    ipcMain.handle('remote:qrDataUrl', () => gateway.qrDataUrl())
  }

  // ---- QQ 机器人 ----
  if (deps.qqBot !== undefined) {
    const qqBot = deps.qqBot
    ipcMain.handle('qq:getConfig', () => qqBot.getConfig())
    ipcMain.handle('qq:setConfig', (_event, patch: object) => qqBot.setConfig(patch))
    ipcMain.handle('qq:status', () => qqBot.isStarted())
  }

  // ---- 外观 ----
  ipcMain.handle('appearance:getConfig', () => deps.appearance.getConfig())
  ipcMain.handle('appearance:pickAndSet', async (_event, kind: string) => {
    if (kind !== 'window' && kind !== 'screensaver') throw new Error('未知的壁纸类型')
    return deps.appearance.pickAndSet(kind)
  })
  ipcMain.handle('appearance:clear', (_event, kind: string) => {
    if (kind !== 'window' && kind !== 'screensaver') throw new Error('未知的壁纸类型')
    return deps.appearance.clear(kind)
  })
  ipcMain.handle('appearance:setMask', (_event, mask: number) => deps.appearance.setMask(mask))

  // ---- 应用 ----
  ipcMain.handle('app:openSettingsFolder', async () => {
    const result = await deps.harness.client().rpc<{ opened: true }>('settings.openDocument')
    return result
  })
  ipcMain.handle('app:quit', () => {
    deps.harness.stop()
    setTimeout(() => process.exit(0), 500)
  })
  ipcMain.handle('app:getWindowCount', () => BrowserWindow.getAllWindows().length)
}
