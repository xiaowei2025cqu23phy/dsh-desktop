/**
 * 外观管理:主窗口壁纸与屏保壁纸的选择/保存。
 *
 * 选择的图片复制到 userData/wallpapers/ 下,避免原始文件被移动/删除后失效;
 * 渲染进程通过 file:// URL 加载(图片仅作背景,无读取风险)。
 */

import { app, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AppearanceConfig, ConfigStore } from './config'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']

export type WallpaperKind = 'window' | 'screensaver'

export class AppearanceManager {
  constructor(private config: ConfigStore) {}

  getConfig(): AppearanceConfig {
    return this.config.get().appearance
  }

  /** 打开文件选择器,把选中的图片复制到 userData/wallpapers 并保存配置。取消返回 null。 */
  async pickAndSet(kind: WallpaperKind): Promise<{ path: string } | null> {
    const result = await dialog.showOpenDialog({
      title: kind === 'window' ? '选择主窗口壁纸' : '选择屏保壁纸',
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
    const target = this.copyIntoWallpapers(source, kind)
    this.config.update('appearance', { [kind === 'window' ? 'windowWallpaper' : 'screensaverWallpaper']: target })
    return { path: target }
  }

  /** 清除指定壁纸。 */
  clear(kind: WallpaperKind): AppearanceConfig {
    return this.config.update('appearance', { [kind === 'window' ? 'windowWallpaper' : 'screensaverWallpaper']: null })
  }

  /** 设置遮罩强度(0~0.9)。 */
  setMask(mask: number): AppearanceConfig {
    return this.config.update('appearance', { mask: Math.max(0, Math.min(0.9, mask)) })
  }

  private copyIntoWallpapers(source: string, kind: WallpaperKind): string {
    const dir = join(app.getPath('userData'), 'wallpapers')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${kind}-${Date.now()}${extname(source).toLowerCase()}`)
    copyFileSync(source, target)
    return target
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
