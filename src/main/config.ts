/**
 * 应用配置持久化(userData/config.json)。
 * 配置项:harness 托管、AI 屏保、窗口尺寸。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface HarnessConfig {
  /** auto: 先探测已运行实例,没有则托管启动;external: 只连接外部地址;managed: 始终自己启动。 */
  mode: 'auto' | 'external' | 'managed'
  /** external 模式下的服务地址。 */
  url: string
  /** managed/auto 模式下监听的端口。 */
  port: number
  /** 托管启动命令模板,{port} 会被替换为实际端口。 */
  command: string
  /** 应用启动时自动启动托管服务。 */
  autoStart: boolean
  /** 托管进程意外退出后自动重启。 */
  restartOnCrash: boolean
  /** 退出应用时关闭托管服务。 */
  stopOnQuit: boolean
  /** 可选的 DSH_HOME 环境变量覆盖。 */
  dshHome: string | null
}

export interface ScreensaverConfig {
  /** 空闲检测开启。 */
  enabled: boolean
  /** 空闲多少分钟后进入 AI 屏保。 */
  idleMinutes: number
  /** 进入屏保时自动启动一个 agent 任务(默认关闭:空闲只显示环境画面,不烧资源)。 */
  autoTask: boolean
  /** 自动任务提示词。 */
  taskPrompt: string
  /** 任务工作目录(空则使用 harness 默认)。 */
  taskCwd: string | null
  /** 任务最长运行分钟数,超时自动停止(防止 agent 失控循环烧 CPU)。 */
  taskMaxMinutes: number
  /** 退出屏保后保留任务继续在后台运行。 */
  keepSessionAfterExit: boolean
  /** 注册系统屏保前备份的原注册表值,取消注册时恢复。内部字段,不暴露给 UI。 */
  systemScreensaverBackup: Record<string, string> | null
}

export interface AppearanceConfig {
  /** 主窗口壁纸(裁剪后的图片 + cover 布设偏移)。 */
  window: WallpaperSpec
  /** 手机端 PWA 壁纸。 */
  phone: WallpaperSpec
  /** 屏保壁纸。 */
  screensaver: WallpaperSpec
  /** 壁纸遮罩强度 0~0.9(保证文字可读)。 */
  mask: number
}

export interface WallpaperSpec {
  /** 壁纸文件路径(裁剪后的成品,null = 默认深色)。 */
  path: string | null
  /** cover 模式下布设偏移(0~1,0.5 = 居中)。 */
  position: { x: number; y: number }
}

export interface RemoteConfig {
  /** 局域网远程网关开关。 */
  enabled: boolean
  /** 网关监听端口。 */
  port: number
  /** Bearer 令牌(首次启用时自动生成)。 */
  token: string
}

export interface QQBotConfig {
  /** QQ 机器人开关(需在 QQ 开放平台注册并填入 appId/appSecret)。 */
  enabled: boolean
  /** QQ 开放平台机器人 AppID。 */
  appId: string
  /** QQ 开放平台机器人 AppSecret。 */
  appSecret: string
}

export interface AppConfig {
  harness: HarnessConfig
  screensaver: ScreensaverConfig
  appearance: AppearanceConfig
  remote: RemoteConfig
  qq: QQBotConfig
  window: { width: number; height: number }
}

const DEFAULTS: AppConfig = {
  harness: {
    mode: 'auto',
    url: 'http://127.0.0.1:3080',
    port: 3080,
    command: 'npx --yes @deepseek-ai/dsh web --port {port}',
    autoStart: true,
    restartOnCrash: true,
    stopOnQuit: true,
    dshHome: null,
  },
  screensaver: {
    enabled: false,
    idleMinutes: 5,
    autoTask: false,
    taskPrompt:
      '你是运行在 AI 屏保中的 DeepSeek Harness 智能体。请自主完成一项有价值的任务,例如:浏览今天的科技新闻并整理要点、构思一段创意文字、分析当前工作区代码给出改进建议。完成后用简洁的中文总结你做了什么。',
    taskCwd: null,
    taskMaxMinutes: 10,
    keepSessionAfterExit: true,
    systemScreensaverBackup: null,
  },
  appearance: {
    window: { path: null, position: { x: 0.5, y: 0.5 } },
    phone: { path: null, position: { x: 0.5, y: 0.5 } },
    screensaver: { path: null, position: { x: 0.5, y: 0.5 } },
    mask: 0.55,
  },
  remote: {
    enabled: false,
    port: 3082,
    token: '',
  },
  qq: {
    enabled: false,
    appId: '',
    appSecret: '',
  },
  window: { width: 1280, height: 800 },
}

export class ConfigStore {
  private config: AppConfig
  private readonly path: string

  constructor() {
    this.path = join(app.getPath('userData'), 'config.json')
    this.config = this.load()
  }

  private load(): AppConfig {
    try {
      if (!existsSync(this.path)) return structuredClone(DEFAULTS)
      // 剥离 UTF-8 BOM:PowerShell/部分编辑器保存的 JSON 可能带 BOM,JSON.parse 不接受。
      const text = readFileSync(this.path, 'utf8').replace(/^\uFEFF/, '')
      const raw = JSON.parse(text) as Partial<AppConfig>
      const config = this.merge(DEFAULTS, raw)
      // 兼容旧版本扁平字段(windowWallpaper/screensaverWallpaper → 新结构)。
      const legacy = (raw.appearance ?? {}) as {
        windowWallpaper?: string | null
        screensaverWallpaper?: string | null
      }
      if (config.appearance.window.path === null && typeof legacy.windowWallpaper === 'string') {
        config.appearance.window.path = legacy.windowWallpaper
      }
      if (config.appearance.screensaver.path === null && typeof legacy.screensaverWallpaper === 'string') {
        config.appearance.screensaver.path = legacy.screensaverWallpaper
      }
      return config
    } catch (error) {
      console.error('[config] 配置文件解析失败,使用默认值:', String(error))
      return structuredClone(DEFAULTS)
    }
  }

  private merge<T>(base: T, patch: Partial<T>): T {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === undefined) continue
      const baseValue = (base as Record<string, unknown>)[key]
      if (baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue) &&
          value !== null && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = this.merge(baseValue, value)
      } else {
        out[key] = value
      }
    }
    return out as T
  }

  get(): AppConfig {
    return this.config
  }

  /** 合并指定分区后持久化。 */
  update<K extends keyof AppConfig>(section: K, patch: Partial<AppConfig[K]>): AppConfig[K] {
    this.config[section] = this.merge(this.config[section], patch)
    this.save()
    return this.config[section]
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.config, null, 2), 'utf8')
    } catch (error) {
      console.error('[config] 保存失败:', error)
    }
  }
}
