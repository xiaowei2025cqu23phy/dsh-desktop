/**
 * 外观管理:主窗口壁纸与屏保壁纸的选择/保存。
 *
 * 选择的图片复制到 userData/wallpapers/ 下,避免原始文件被移动/删除后失效;
 * 渲染进程通过 file:// URL 加载(图片仅作背景,无读取风险)。
 */

import { app, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AppearanceConfig, ConfigStore, WallpaperSpec } from './config'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']

export type WallpaperKind = 'window' | 'phone' | 'screensaver'

const KIND_FIELD: Record<WallpaperKind, 'window' | 'phone' | 'screensaver'> = {
  window: 'window',
  phone: 'phone',
  screensaver: 'screensaver',
}

const KIND_LABEL: Record<WallpaperKind, string> = {
  window: '主窗口',
  phone: '手机端',
  screensaver: '屏保',
}

export class AppearanceManager {
  constructor(private config: ConfigStore) {}

  getConfig(): AppearanceConfig {
    return this.config.get().appearance
  }

  /** 打开文件选择器,把选中的源图复制到 userData/wallpapers,供渲染进程裁剪预览。取消返回 null。 */
  async pickSource(kind: WallpaperKind): Promise<{ path: string } | null> {
    const result = await dialog.showOpenDialog({
      title: `选择${KIND_LABEL[kind]}壁纸`,
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const source = result.filePaths[0]
    const ext = extname(source).toLowerCase()
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      throw new Error(`不支持的图片格式:${ext}(支持 png/jpg/jpeg/gif/webp/bmp)`)
    }
    const dir = join(app.getPath('userData'), 'wallpapers')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `source-${kind}-${Date.now()}${ext}`)
    copyFileSync(source, target)
    return { path: target }
  }

  /** 保存裁剪后的成品壁纸(data URL + cover 布设偏移)。 */
  async saveWallpaper(kind: WallpaperKind, dataUrl: string, position: { x: number; y: number }): Promise<WallpaperSpec> {
    const mime = /^data:([a-z0-9/+-]+);base64,/i.exec(dataUrl)?.[1] ?? 'image/png'
    const extMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/bmp': '.bmp',
    }
    const ext = extMap[mime] ?? '.png'
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const dir = join(app.getPath('userData'), 'wallpapers')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${kind}-${Date.now()}${ext}`)
    writeFileSync(target, Buffer.from(base64, 'base64'))
    const spec: WallpaperSpec = { path: target, position: { x: clamp01(position.x), y: clamp01(position.y) } }
    this.config.update('appearance', { [KIND_FIELD[kind]]: spec })
    return spec
  }

  /** 清除指定壁纸。 */
  clear(kind: WallpaperKind): WallpaperSpec {
    const spec: WallpaperSpec = { path: null, position: { x: 0.5, y: 0.5 } }
    this.config.update('appearance', { [KIND_FIELD[kind]]: spec })
    return spec
  }

  /** 设置遮罩强度(0~0.9)。 */
  setMask(mask: number): AppearanceConfig {
    return this.config.update('appearance', { mask: Math.max(0, Math.min(0.9, mask)) })
  }

  /** 壁纸文件是否仍存在(被手动删除时回退默认)。 */
  wallpaperUsable(path: string | null): string | null {
    if (path === null) return null
    if (existsSync(path)) return path
    return null
  }

  // ---- 内置壁纸包 ----

  /** 内置壁纸包根目录(开发 = 项目 assets;打包 = app.asar 内,asar 支持读目录)。 */
  private packsRoot(): string {
    return join(app.getAppPath(), 'assets', 'wallpapers')
  }

  /** 列出壁纸包:内置包(assets/wallpapers)+ 用户本地包(userData/wallpapers 下 pack-*)。 */
  listPacks(): Array<{ id: string; files: Record<string, string> }> {
    const packs: Array<{ id: string; files: Record<string, string> }> = []
    const collect = (root: string, isUserPack: boolean): void => {
      if (!existsSync(root)) return
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        if (!statSync(dir).isDirectory()) continue
        if (isUserPack && !name.startsWith('pack-')) continue
        const files: Record<string, string> = {}
        for (const surface of ['window', 'phone', 'screensaver'] as const) {
          const file = join(dir, `${surface}.png`)
          if (existsSync(file)) files[surface] = file
        }
        if (Object.keys(files).length > 0) packs.push({ id: name, files })
      }
    }
    collect(this.packsRoot(), false)
    collect(join(app.getPath('userData'), 'wallpapers'), true)
    return packs
  }

  /**
   * 应用壁纸包到三端:源文件在 asar 内时复制到用户数据目录(asar 内文件无法
   * 被渲染进程 file:// 加载);已在用户目录的包直接引用。
   */
  applyPack(id: string): AppearanceConfig {
    const pack = this.listPacks().find((p) => p.id === id)
    if (pack === undefined) throw new Error(`壁纸包不存在:${id}`)
    const dir = join(app.getPath('userData'), 'wallpapers')
    mkdirSync(dir, { recursive: true })
    const userDataRoot = dir
    const spec: Partial<AppearanceConfig> = { mask: 0.55 }
    for (const surface of ['window', 'phone', 'screensaver'] as const) {
      const source = pack.files[surface]
      if (source === undefined) continue
      let target = source
      if (!source.startsWith(userDataRoot)) {
        target = join(dir, `pack-${id}-${surface}.png`)
        copyFileSync(source, target)
      }
      spec[surface] = { path: target, position: { x: 0.5, y: 0.5 } }
    }
    return this.config.update('appearance', spec as Partial<AppearanceConfig>)
  }
}

export function wallpaperUrl(path: string | null): string | null {
  if (path === null) return null
  return `file:///${path.replace(/\\/g, '/')}`
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5))
}
