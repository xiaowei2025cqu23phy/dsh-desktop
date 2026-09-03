/**
 * Harness 工作区注册表落盘操作。
 *
 * harness 只提供 workspace.archiveSession,没有 unarchive RPC;归档标记保存在
 * 注册表 JSON(storages/workspace.json 的 global.archivedSessionIds)里。
 * 恢复 = 从该数组移除 id。注册表的内存态在 harness 进程内,落盘后需服务重启
 * 才能反映到列表(桌面端托管实例空闲时会自动重启,见调用方)。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 实际 dsh home:配置了 DSH_HOME 用配置值,否则 ~/.dsh。 */
export function dshHomeOf(configured: string | null | undefined): string {
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh')
}

/** 工作区注册表文件路径。 */
export function workspaceRegistryPath(home: string): string {
  return join(home, 'storages', 'workspace.json')
}

/**
 * 把会话从归档集合移除(仅落盘)。
 * @param home - dsh home 目录(通常 ~/.dsh)。
 * @param sessionId - 要恢复的会话 id。
 * @throws 注册表缺失/结构异常/会话不在归档列表时抛错。
 */
export function unarchiveInRegistry(home: string, sessionId: string): void {
  const file = workspaceRegistryPath(home)
  if (!existsSync(file)) throw new Error('找不到工作区注册表文件(可能从未初始化)')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { global?: { archivedSessionIds?: string[] } }
  const list = parsed.global?.archivedSessionIds
  if (!Array.isArray(list)) throw new Error('工作区注册表结构异常(archivedSessionIds 缺失)')
  if (list.indexOf(sessionId) < 0) throw new Error('该会话不在归档列表(可能已恢复或不存在)')
  if (parsed.global !== undefined) parsed.global.archivedSessionIds = list.filter((id) => id !== sessionId)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8')
  renameSync(tmp, file)
}
