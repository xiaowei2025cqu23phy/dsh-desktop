/**
 * IPC 装配:把 harness / models / screensaver 的能力暴露给渲染进程。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { AppearanceManager } from './appearance'
import type { ConfigStore } from './config'
import type { RemoteGateway } from './gateway'
import type { HarnessManager } from './harness'
import type { ModelManager } from './models'
import type { QQBotAdapter } from './qq-bot'
import type { ScreensaverController } from './screensaver'
import type { TelegramBotAdapter } from './telegram-bot'
import type { UpdateChecker } from './updater'

export interface IpcDeps {
  config: ConfigStore
  harness: HarnessManager
  models: ModelManager
  screensaver: ScreensaverController
  appearance: AppearanceManager
  gateway?: RemoteGateway
  qqBot?: QQBotAdapter
  telegramBot?: TelegramBotAdapter
  updater?: UpdateChecker
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

  // ---- Telegram 机器人 ----
  if (deps.telegramBot !== undefined) {
    const telegramBot = deps.telegramBot
    ipcMain.handle('telegram:getConfig', () => telegramBot.getConfig())
    ipcMain.handle('telegram:setConfig', (_event, patch: object) => telegramBot.setConfig(patch))
    ipcMain.handle('telegram:status', () => telegramBot.isStarted())
  }

  // ---- 外观 ----
  ipcMain.handle('appearance:getConfig', () => deps.appearance.getConfig())
  ipcMain.handle('appearance:pickSource', async (_event, kind: string) => {
    if (!isWallpaperKind(kind)) throw new Error('未知的壁纸类型')
    return deps.appearance.pickSource(kind)
  })
  ipcMain.handle('appearance:saveWallpaper', async (_event, kind: string, dataUrl: string, position: { x: number; y: number }) => {
    if (!isWallpaperKind(kind)) throw new Error('未知的壁纸类型')
    return deps.appearance.saveWallpaper(kind, dataUrl, position)
  })
  ipcMain.handle('appearance:clear', (_event, kind: string) => {
    if (!isWallpaperKind(kind)) throw new Error('未知的壁纸类型')
    return deps.appearance.clear(kind)
  })
  ipcMain.handle('appearance:setMask', (_event, mask: number) => deps.appearance.setMask(mask))
  ipcMain.handle('appearance:listPacks', () => deps.appearance.listPacks())
  ipcMain.handle('appearance:applyPack', (_event, id: string) => deps.appearance.applyPack(id))
  // 指定端壁纸的 data URL + 布设偏移:供内嵌 harness Web UI 作为背景注入。
  ipcMain.handle('appearance:wallpaperData', (_event, kind: string) => {
    if (!isWallpaperKind(kind)) return { dataUrl: null, position: { x: 0.5, y: 0.5 } }
    const spec = deps.appearance.getConfig()[kind]
    const path = spec.path
    if (path === null || !existsSync(path)) return { dataUrl: null }
    const types: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    }
    const mime = types[extname(path).toLowerCase()]
    if (mime === undefined) return { dataUrl: null }
    const buffer = readFileSync(path)
    // 防御性上限 20MB;渲染端注入前会用 canvas 压缩,避免超大 data URL 拖慢内嵌页面。
    if (buffer.byteLength > 20 * 1024 * 1024) return { dataUrl: null }
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, position: spec.position }
  })

  // ---- 更新 ----
  if (deps.updater !== undefined) {
    const updater = deps.updater
    ipcMain.handle('updater:getInfo', () => updater.getInfo())
    ipcMain.handle('updater:check', () => updater.check())
    ipcMain.handle('updater:openRelease', async () => {
      const info = updater.getInfo()
      if (info.url !== null) await shell.openExternal(info.url)
    })
  }

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

function isWallpaperKind(kind: string): kind is 'window' | 'phone' | 'screensaver' {
  return kind === 'window' || kind === 'phone' || kind === 'screensaver'
}
