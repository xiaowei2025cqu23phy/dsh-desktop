/**
 * 自动更新检查:查询 GitHub Releases 最新版本,与当前版本比较。
 * 提示 + 打开下载页;不静默下载安装(用户确认后跳转 Release 页面)。
 */

import { app } from 'electron'

export interface UpdateInfo {
  current: string
  latest: string | null
  url: string | null
  checkedAt: number
}

const REPO = 'xiaowei2025cqu23phy/dsh-desktop'
const CHECK_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export class UpdateChecker {
  private lastInfo: UpdateInfo = { current: app.getVersion(), latest: null, url: null, checkedAt: 0 }

  getInfo(): UpdateInfo {
    return this.lastInfo
  }

  /** 是否有可用新版本。 */
  hasUpdate(): boolean {
    return this.lastInfo.latest !== null && compareVersions(this.lastInfo.latest, this.lastInfo.current) > 0
  }

  /** 检查最新版本(失败返回 null latest,不抛错)。 */
  async check(): Promise<UpdateInfo> {
    const current = app.getVersion()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const response = await fetch(CHECK_URL, {
        headers: { 'user-agent': 'dsh-desktop-updater', accept: 'application/vnd.github+json' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!response.ok) {
        this.lastInfo = { current, latest: null, url: null, checkedAt: Date.now() }
        return this.lastInfo
      }
      const data = await response.json() as { tag_name?: unknown; html_url?: unknown }
      const latest = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null
      const url = typeof data.html_url === 'string' ? data.html_url : null
      this.lastInfo = { current, latest, url, checkedAt: Date.now() }
      return this.lastInfo
    } catch (error) {
      console.error('[updater] 检查更新失败:', error instanceof Error ? error.message : String(error))
      this.lastInfo = { current, latest: null, url: null, checkedAt: Date.now() }
      return this.lastInfo
    }
  }
}

/** 简单语义化版本比较:major.minor.patch;a > b 返回正数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
