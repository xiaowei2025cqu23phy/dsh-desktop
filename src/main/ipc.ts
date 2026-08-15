/**
 * IPC 装配:把 harness / models / screensaver 的能力暴露给渲染进程。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import type { ConfigStore } from './config'
import type { HarnessManager } from './harness'
import type { ModelManager } from './models'
import type { ScreensaverController } from './screensaver'

export interface IpcDeps {
  config: ConfigStore
  harness: HarnessManager
  models: ModelManager
  screensaver: ScreensaverController
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
