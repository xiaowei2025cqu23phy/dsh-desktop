/**
 * IPC 装配:把 harness / models / screensaver 的能力暴露给渲染进程。
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AppearanceManager } from './appearance'
import { probeCapabilities } from './capabilities'
import { previewHarnessConfig, type ConfigStore, type PreviewConfig, type UsageConfig } from './config'
import type { RemoteGateway } from './gateway'
import type { HarnessManager } from './harness'
import type { ModelManager } from './models'
import { isSameOrUnder } from './path-policy'
import type { QQBotAdapter } from './qq-bot'
import type { RemoteCommandProcessor } from './remote-commands'
import type { ScreensaverController } from './screensaver'
import type { TelegramBotAdapter } from './telegram-bot'
import type { UpdateChecker } from './updater'

export interface IpcDeps {
  config: ConfigStore
  harness: HarnessManager
  preview?: HarnessManager
  models: ModelManager
  screensaver: ScreensaverController
  appearance: AppearanceManager
  gateway?: RemoteGateway
  qqBot?: QQBotAdapter
  telegramBot?: TelegramBotAdapter
  updater?: UpdateChecker
  commands?: RemoteCommandProcessor
  diagnostics?: () => Record<string, unknown>
}

export function registerIpc(deps: IpcDeps): void {
  const harnessReady = (): boolean => {
    const state = deps.harness.status().state
    return state === 'running' || state === 'external'
  }
  // ---- harness ----
  ipcMain.handle('harness:getStatus', () => deps.harness.status())
  ipcMain.handle('harness:launchToken', () => deps.harness.getLaunchToken())
  ipcMain.handle('harness:capabilities', () => probeCapabilities(deps.harness))
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

  // ---- 预览实例(实验版 harness,独立端口) ----
  ipcMain.handle('preview:getStatus', () => deps.preview?.status() ?? null)
  ipcMain.handle('preview:capabilities', () => deps.preview === undefined ? null : probeCapabilities(deps.preview))
  ipcMain.handle('preview:getConfig', () => deps.config.get().preview)
  ipcMain.handle('preview:setConfig', (_event, patch: object) => {
    const next = deps.config.update('preview', patch) as PreviewConfig
    const manager = deps.preview
    if (manager === undefined) return null
    manager.updateConfig(previewHarnessConfig(next))
    if (next.enabled) void manager.start()
    else void manager.stop()
    return manager.status()
  })
  ipcMain.handle('preview:start', () => { void deps.preview?.start() })
  ipcMain.handle('preview:stop', () => deps.preview?.stop())
  ipcMain.handle('preview:restart', () => deps.preview?.restart())
  ipcMain.handle('preview:getLogs', () => deps.preview?.logs.slice(-200) ?? [])
  ipcMain.handle('preview:openWebUi', () => {
    const manager = deps.preview
    if (manager !== undefined) void shell.openExternal(manager.baseUrl())
  })

  // ---- models ----
  ipcMain.handle('models:list', async () => {
    if (!harnessReady()) {
      // harness 未就绪(启动期)返回空壳,避免渲染进程轮询抛错刷日志。
      return { providers: [], groups: [], failures: [], selected: null }
    }
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
    ipcMain.handle('remote:httpsCertInfo', () => gateway.httpsCertInfo())
    ipcMain.handle('remote:pairUrl', () => gateway.pairUrl())
    ipcMain.handle('remote:qrDataUrl', () => gateway.qrDataUrl())
    ipcMain.handle('remote:qrDataUrls', () => gateway.qrDataUrls())
  ipcMain.handle('remote:approvedDevices', () => gateway.approvedDevices())
  ipcMain.handle('remote:revokeDevice', (_event, id: string) => gateway.revokeDevice(id))
  ipcMain.handle('remote:setPaused', (_event, paused: boolean) => gateway.setPaused(paused))
  ipcMain.handle('remote:pauseDevice', (_event, id: string) => gateway.pauseDevice(id))
  ipcMain.handle('remote:resumeDevice', (_event, id: string) => gateway.resumeDevice(id))
  ipcMain.handle('remote:blacklistDevice', (_event, id: string) => gateway.blacklistDevice(id))
  ipcMain.handle('remote:unblacklistDevice', (_event, id: string) => gateway.unblacklistDevice(id))
  ipcMain.handle('remote:blacklistedDevices', () => gateway.blacklistedDevices())
    // 用系统文件资源管理器挑选预设工作区根目录(多选)。
    ipcMain.handle('dialog:pickDirectories', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: '选择预设工作区根目录',
        buttonLabel: '添加',
        properties: ['openDirectory', 'multiSelections'],
      }
      const result = win === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options)
      return result.canceled ? [] : result.filePaths
    })
    // 挑选单个可执行文件(如本地 harness 的 run-local.cmd / 启动脚本)。
    ipcMain.handle('dialog:pickFile', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: '选择 harness 启动脚本(.cmd / .bat / .js / .mjs)',
        buttonLabel: '选择',
        properties: ['openFile'],
        filters: [
          { name: '启动脚本', extensions: ['cmd', 'bat', 'js', 'mjs', 'cjs', 'exe'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      }
      const result = win === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })
  }

  // ---- QQ 机器人 ----
  if (deps.qqBot !== undefined) {
    const qqBot = deps.qqBot
    ipcMain.handle('qq:getConfig', () => qqBot.getConfig())
    ipcMain.handle('qq:setConfig', (_event, patch: object) => qqBot.setConfig(patch))
    ipcMain.handle('qq:status', () => qqBot.isStarted())
    ipcMain.handle('qq:diag', () => qqBot.diag())
    ipcMain.handle('qq:onboardStart', () => qqBot.onboardStart())
    ipcMain.handle('qq:onboardStatus', () => qqBot.onboardStatus())
    ipcMain.handle('qq:onboardCancel', () => qqBot.onboardCancel())
  }

  // ---- Telegram 机器人 ----
  if (deps.telegramBot !== undefined) {
    const telegramBot = deps.telegramBot
    ipcMain.handle('telegram:getConfig', () => telegramBot.getConfig())
    ipcMain.handle('telegram:setConfig', (_event, patch: object) => telegramBot.setConfig(patch))
    ipcMain.handle('telegram:status', () => telegramBot.isStarted())
    ipcMain.handle('telegram:diag', () => telegramBot.diag())
    ipcMain.handle('telegram:bindStart', () => telegramBot.bindStart())
    ipcMain.handle('telegram:bindCancel', () => telegramBot.bindCancel())
  }

  // ---- 机器人提示词(工作=助手 / 对话=朋友,桌面端自定义) ----
  ipcMain.handle('bot:getConfig', () => deps.config.get().bot)
  ipcMain.handle('bot:setConfig', (_event, patch: { taskPrompt?: string; chatPrompt?: string }) => {
    deps.config.update('bot', patch)
    return deps.config.get().bot
  })
  // ---- 用量费用配置(倍率 / 每日·每月预算;默认官方价、默认不限额) ----
  ipcMain.handle('usage:getConfig', () => deps.config.get().usage)
  ipcMain.handle('usage:setConfig', (_event, patch: Record<string, unknown>) => {
    deps.config.update('usage', sanitizeUsagePatch(patch))
    return deps.config.get().usage
  })
  ipcMain.handle('notifications:getConfig', () => deps.config.get().notifications)
  ipcMain.handle('notifications:setConfig', (_event, patch: object) => deps.config.update('notifications', patch))
  // ---- 用量报告(QQ/PWA/桌面端共用同一统计) ----
  ipcMain.handle('usage:report', () => {
    if (!harnessReady()) return null
    return deps.commands?.usageReport() ?? null
  })
  ipcMain.handle('interactions:list', () => deps.commands?.pendingInteractions() ?? [])
  ipcMain.handle('interactions:respondApproval', (_event, sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected') => deps.commands?.respondApprovalDesktop(sessionId, approvalId, outcome) ?? '不可用')
  ipcMain.handle('interactions:respondQuestion', (_event, sessionId: string, questionId: string, optionIndex: number) => deps.commands?.respondQuestionDesktop(sessionId, questionId, optionIndex) ?? '不可用')
  ipcMain.handle('tasks:history', () => deps.config.get().taskHistory ?? [])
  ipcMain.handle('queue:list', () => deps.commands?.queueList() ?? [])
  ipcMain.handle('queue:cancel', (_event, id: string) => deps.commands?.cancelQueueEntry(id) ?? '队列不可用')
  ipcMain.handle('queue:retry', (_event, id: string) => deps.commands?.retryQueueEntry(id) ?? '队列不可用')
  ipcMain.handle('activity:list', () => deps.config.activities())
  // 活动中心「停止」/「全部停止」:走 session.cancel,成功与失败都回一个结果对象供界面提示。
  ipcMain.handle('activity:stop', (_event, sessionId: string) =>
    deps.commands?.stopSession(sessionId) ?? { ok: false, message: '操作不可用' })
  ipcMain.handle('activity:stopAll', () =>
    deps.commands?.stopAllSessions() ?? { ok: false, message: '操作不可用' })
  // 清理入口:活动/队列/任务历史堆积会让人找不到当前在跑的东西。
  // 一律只清「已结束」的条目 —— 运行中/等待中的记录被删掉,用户就再没有入口看到并停止它。
  ipcMain.handle('activity:delete', (_event, id: string) => {
    deps.config.deleteActivity(id)
    return { ok: true }
  })
  ipcMain.handle('activity:clearFinished', () => ({ ok: true, removed: deps.config.clearFinishedActivities() }))
  ipcMain.handle('queue:delete', (_event, id: string) => {
    const removed = deps.config.deleteQueueEntry(id)
    return removed ? { ok: true } : { ok: false, message: '该条目正在排队或运行中,请先取消再删除' }
  })
  ipcMain.handle('queue:clearFinished', () => ({ ok: true, removed: deps.config.clearFinishedQueue() }))
  ipcMain.handle('tasks:clearHistory', () => {
    const removed = (deps.config.get().taskHistory ?? []).length
    deps.config.update('taskHistory', [])
    return { ok: true, removed }
  })
  ipcMain.handle('workspace:health', () => {
    if (!harnessReady()) return Promise.resolve([])
    return deps.gateway?.healthReport() ?? Promise.resolve([])
  })
  ipcMain.handle('workspace:changes', (_event, path: string, diff = false) => deps.gateway?.changesReport(path, diff) ?? { path, status: '', unavailable: true })
  ipcMain.handle('workspace:openFolder', async (_event, path: string) => {
    const { shell } = await import('electron')
    const { existsSync, statSync } = await import('node:fs')
    if (typeof path !== 'string' || path.trim() === '' || !existsSync(path) || !statSync(path).isDirectory()) return '路径无效'
    const error = await shell.openPath(path)
    return error === '' ? 'ok' : error
  })
  ipcMain.handle('audit:list', () => deps.config.auditList())
  ipcMain.handle('audit:clear', () => deps.config.clearAudit())
  ipcMain.handle('audit:export', async () => {
    const result = await dialog.showSaveDialog({ title: '导出本地审计记录', defaultPath: 'dsh-audit.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || result.filePath === undefined) return null
    const { writeFileSync } = await import('node:fs')
    writeFileSync(result.filePath, JSON.stringify(deps.config.auditList(), null, 2), 'utf8')
    return result.filePath
  })
  ipcMain.handle('memory:list', () => deps.config.get().workspaceMemories ?? {})
  ipcMain.handle('memory:get', (_event, path: string) => deps.config.memory(path))
  ipcMain.handle('memory:set', (_event, path: string, memory: { enabled: boolean; summary: string; conventions: string; commands: string; notes: string }) => {
    deps.config.setMemory(path, { ...memory, updatedAt: Date.now() })
    deps.config.appendAudit({ time: Date.now(), type: 'memory.updated', detail: `更新工作区记忆:${path}` })
    return deps.config.memory(path)
  })
  ipcMain.handle('memory:clear', (_event, path: string) => {
    deps.config.clearMemory(path)
    deps.config.appendAudit({ time: Date.now(), type: 'memory.cleared', detail: `清空工作区记忆:${path}` })
    return true
  })
  ipcMain.handle('memory:suggest', async (_event, path: string) => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const suggest: { summary: string; commands: string; conventions: string } = { summary: '', commands: '', conventions: '' }
    // README → 简介草稿(跳过标题/图片/链接行,取前 3 行正文)。
    for (const name of ['README.md', 'README', 'readme.md', 'readme']) {
      const file = join(path, name)
      if (existsSync(file)) {
        try {
          const text = readFileSync(file, 'utf8').slice(0, 8192)
          const lines = text.split('\n').map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('![') && !line.startsWith('[') && !line.startsWith('---'))
          suggest.summary = lines.slice(0, 3).join('\n').slice(0, 300)
        } catch {
          /* 读取失败时跳过 README。 */
        }
        break
      }
    }
    // package.json → 常用命令草稿 + 技术栈。
    const pkgFile = join(path, 'package.json')
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        const scripts = pkg.scripts ?? {}
        const lines: string[] = []
        for (const name of ['build', 'test', 'dev', 'lint', 'start']) {
          if (typeof scripts[name] === 'string') lines.push(`${name}: ${scripts[name]}`)
        }
        suggest.commands = lines.join('\n').slice(0, 300)
        if (suggest.summary === '') {
          const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 10).join(', ')
          if (deps !== '') suggest.summary = `技术栈: ${deps}`
        }
      } catch {
        /* package.json 解析失败时跳过。 */
      }
    }
    // 新增(P3-3):从该工作区的近期会话归纳候选——首条消息补简介、工具调用补常用命令,
    // 让记忆「更主动」,不只依赖 README/package.json。
    try {
      const client = deps.harness.client()
      const list = await client.rpc<{ items: Array<{ sessionId: string; cwd?: string; updatedAt?: number; blank?: boolean; origin?: string }> }>('session.list', {}, 20000)
      const recent = (list.items ?? [])
        .filter((s) => !s.blank && !(typeof s.origin === 'string' && s.origin !== '') &&
          typeof s.cwd === 'string' && isSameOrUnder(s.cwd, path))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 3)
      const firstMessages: string[] = []
      const toolCommands: string[] = []
      for (const s of recent) {
        try {
          const hist = await client.rpc<{ events: Array<Record<string, unknown>> }>('session.history', { sessionId: s.sessionId, maxMessages: 8 }, 15000)
          for (const entry of hist.events ?? []) {
            const raw = entry !== null && typeof entry === 'object' ? entry : {}
            const inner = raw.event
            const ev = (inner !== null && typeof inner === 'object' ? inner : raw) as Record<string, unknown>
            const data = (ev.data !== null && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>
            if (ev.type === 'user/message') {
              const message = (data.message !== null && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>
              const content = message.content
              if (Array.isArray(content)) {
                const text = content.map((b) => (b !== null && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('').trim()
                if (text !== '') firstMessages.push(text.slice(0, 120))
              }
            } else if (ev.type === 'tool/call' && typeof ev.name === 'string') {
              const name = (ev.name as string).toLowerCase()
              if (/bash|exec|shell|sh|npm|pnpm|yarn|node|tsc|python|pip|git|cargo|\bgo\b/i.test(name)) {
                const args = typeof ev.arguments === 'string' ? ev.arguments : ''
                const brief = args.replace(/\s+/g, ' ').trim().slice(0, 80)
                if (brief !== '') toolCommands.push(`${name} ${brief}`)
              }
            }
          }
        } catch {
          /* 单个会话历史读取失败跳过,不影响其它候选。 */
        }
      }
      if (suggest.summary === '' && firstMessages.length > 0) suggest.summary = `近期会话:${firstMessages[0]}`
      const extra = [...new Set(toolCommands)].slice(0, 6).join('\n')
      if (extra !== '') {
        suggest.commands = suggest.commands === '' ? extra : `${suggest.commands}\n${extra}`
      }
    } catch {
      /* 会话扫描失败(harness 未就绪等)不影响基础草稿。 */
    }
    return suggest
  })
  ipcMain.handle('diagnostics:collect', () => deps.diagnostics?.() ?? { error: '诊断不可用' })
  ipcMain.handle('diagnostics:export', async () => {
    const result = await dialog.showSaveDialog({ title: '导出脱敏诊断报告', defaultPath: 'dsh-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || result.filePath === undefined) return null
    const { writeFileSync } = await import('node:fs')
    writeFileSync(result.filePath, JSON.stringify(deps.diagnostics?.() ?? {}, null, 2), 'utf8')
    return result.filePath
  })
  ipcMain.handle('config:backup', () => deps.config.backup())
  ipcMain.handle('config:exportSafe', async () => {
    const result = await dialog.showSaveDialog({ title: '导出脱敏配置', defaultPath: 'dsh-config-safe.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || result.filePath === undefined) return null
    deps.config.exportSafe(result.filePath)
    return result.filePath
  })
  ipcMain.handle('config:importSafe', async () => {
    const result = await dialog.showOpenDialog({ title: '导入脱敏配置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || result.filePaths[0] === undefined) return null
    return deps.config.importSafe(result.filePaths[0])
  })
  // ---- 机器人指令集(桌面端可查看) ----
  ipcMain.handle('bot:help', () => deps.commands?.fullHelp() ?? '(指令集不可用)')

  // ---- 首启引导 ----
  ipcMain.handle('onboarding:get', () => deps.config.get().onboarding?.done === true)
  ipcMain.handle('onboarding:complete', () => {
    deps.config.update('onboarding', { done: true })
    return true
  })

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
    ipcMain.handle('updater:getConfig', () => deps.config.get().updater)
    ipcMain.handle('updater:setConfig', (_event, patch: { autoCheck?: boolean }) => {
      deps.config.update('updater', patch)
      return deps.config.get().updater
    })
    ipcMain.handle('updater:openRelease', async () => {
      const info = updater.getInfo()
      if (info.url !== null) await shell.openExternal(info.url)
    })
  }

  // ---- 应用 ----
  // 配置恢复提示:损坏隔离 / 备份回退后告知用户,避免"设置莫名重置"无解释。
  ipcMain.handle('app:recoveryNotice', () => deps.config.takeRecoveryNotice())

  ipcMain.handle('app:info', () => {
    try {
      const stamp = join(__dirname, 'build-info.json')
      if (existsSync(stamp)) {
        return JSON.parse(readFileSync(stamp, 'utf8')) as { version: string; commit: string; builtAt: number }
      }
    } catch {
      // 回退到 package.json。
    }
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }
      return { version: pkg.version ?? '', commit: '', builtAt: 0 }
    } catch {
      return { version: '', commit: '', builtAt: 0 }
    }
  })
  // 打开 settings.yaml:走 harness 自身的能力(它知道 DSH_HOME 在哪)。
  ipcMain.handle('app:openSettingsFolder', async () => {
    const result = await deps.harness.client().rpc<{ opened: true }>('settings.openDocument')
    return result
  })
  // 应用自己的数据目录(config.json / local.db / desktop.log / 壁纸 / 证书)。
  // 单独一个入口的意义:harness 挂掉时上面那个必然失败,而"harness 挂了"恰恰是最需要
  // 看日志的时刻。这条不依赖 harness。
  ipcMain.handle('app:openDataFolder', async () => {
    const dir = app.getPath('userData')
    const error = await shell.openPath(dir)
    return { opened: error === '' ? true : false, path: dir, error }
  })
  // 导出日志:把轮转后的两份 desktop.log 复制到用户选定位置,便于发给他人排查。
  ipcMain.handle('app:exportLogs', async () => {
    const dir = app.getPath('userData')
    const result = await dialog.showOpenDialog({ title: '选择日志导出到的文件夹', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths[0] === undefined) return null
    const target = join(result.filePaths[0], `dsh-logs-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    try {
      mkdirSync(target, { recursive: true })
      const copied: string[] = []
      for (const name of ['desktop.log', 'desktop.log.1']) {
        const from = join(dir, name)
        if (existsSync(from)) {
          copyFileSync(from, join(target, name))
          copied.push(name)
        }
      }
      return { ok: true, target, copied }
    } catch (error) {
      return { ok: false, target, copied: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function isWallpaperKind(kind: string): kind is 'window' | 'phone' | 'screensaver' {
  return kind === 'window' || kind === 'phone' || kind === 'screensaver'
}

/**
 * 用量配置补丁白名单:只接受已知字段并归一化。
 *
 * 预算是钱的口径,不能把渲染进程送来的任意值合并进配置——负数/NaN 会让闸门永远判不出超限,
 * 未知的 onExceed 会让行为不可预期。未知字段直接丢弃,负预算按 0(= 不限额)处理。
 */
function sanitizeUsagePatch(patch: Record<string, unknown>): Partial<UsageConfig> {
  const next: Partial<UsageConfig> = {}
  const positive = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  const multiplier = positive(patch.multiplier)
  if (multiplier !== undefined) next.multiplier = multiplier
  for (const key of ['dailyBudget', 'monthlyBudget'] as const) {
    const value = patch[key]
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = Math.max(0, value)
  }
  if (patch.onExceed === 'notify' || patch.onExceed === 'block') next.onExceed = patch.onExceed
  return next
}
