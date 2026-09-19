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
  /** 是否有可用新版本(由主进程用 compareVersions 判定,渲染层直接读取,避免各自实现字符串比较)。 */
  hasUpdate: boolean
}

const REPO = 'xiaowei2025cqu23phy/dsh-desktop'
const CHECK_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export class UpdateChecker {
  private lastInfo: { current: string; latest: string | null; url: string | null; checkedAt: number } = { current: app.getVersion(), latest: null, url: null, checkedAt: 0 }

  getInfo(): UpdateInfo {
    return { ...this.lastInfo, hasUpdate: this.hasUpdate() }
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
        return this.getInfo()
      }
      const data = await response.json() as { tag_name?: unknown; html_url?: unknown }
      const latest = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null
      const url = typeof data.html_url === 'string' ? data.html_url : null
      this.lastInfo = { current, latest, url, checkedAt: Date.now() }
      return this.getInfo()
    } catch (error) {
      console.error('[updater] 检查更新失败:', error instanceof Error ? error.message : String(error))
      this.lastInfo = { current, latest: null, url: null, checkedAt: Date.now() }
      return this.getInfo()
    }
  }
}

/**
 * 简单语义化版本比较:major.minor.patch[-预发布];a > b 返回正数。
 * 处理预发布后缀:核心版本相同时,带预发布后缀的版本视为更低(0.6.1-rc.1 < 0.6.1)。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (raw: string): { parts: number[]; pre: string } => {
    const clean = raw.replace(/^v/, '').trim()
    const dash = clean.indexOf('-')
    const core = dash < 0 ? clean : clean.slice(0, dash)
    const pre = dash < 0 ? '' : clean.slice(dash + 1)
    const parts = core.split('.').map((n) => parseInt(n, 10) || 0)
    return { parts, pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  // 核心版本相同:正式版 > 预发布版;预发布之间按字典序。
  if (pa.pre === '' && pb.pre !== '') return 1
  if (pa.pre !== '' && pb.pre === '') return -1
  if (pa.pre !== pb.pre) return pa.pre < pb.pre ? -1 : 1
  return 0
}
