/**
 * 外观管理:主窗口壁纸与屏保壁纸的选择/保存。
 *
 * 选择的图片复制到 userData/wallpapers/ 下,避免原始文件被移动/删除后失效;
 * 渲染进程通过 file:// URL 加载(图片仅作背景,无读取风险)。
 */

import { app, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
}

export function wallpaperUrl(path: string | null): string | null {
  if (path === null) return null
  return `file:///${path.replace(/\\/g, '/')}`
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5))
}
