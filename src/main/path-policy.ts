/**
 * 路径白名单策略(纯函数:只用 node:path / node:fs,不依赖 Electron,可离线单测)。
 *
 * 远程网关(手机 PWA 浏览文件)、聊天命令(目录/文件/进入工作区)、桌面端记忆候选
 * 共用同一套「目标是否位于某个允许根之下」的判定,保证各处放行口径一致:
 * - 符号链接:两侧都解析真实路径(realpath),工作区内指向外部的链接不被放行;
 * - 大小写:仅 win32 折叠(Linux/macOS 大小写敏感);
 * - 前缀:必须命中 `/` 边界或完全相等,`/a/app` 与 `/a/app2` 是两个目录。
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** win32 文件系统大小写不敏感;Linux/macOS 大小写敏感。 */
const CASE_INSENSITIVE_FS = process.platform === 'win32'

/**
 * 路径归一化:统一分隔符为 `/`,win32 上折叠大小写。
 *
 * 归一化后的字符串仅用于比较,不用于文件系统访问(win32 上 `\` 与 `/` 等价,
 * 折叠大小写不改变实际指向;Linux/macOS 保留原大小写,`A` 与 `a` 是两个文件)。
 */
export function normPath(p: string): string {
  const unified = p.replace(/\\/g, '/')
  return CASE_INSENSITIVE_FS ? unified.toLowerCase() : unified
}

/** 去掉结尾多余分隔符,保留 `/` 与 `C:/` 这类根形式(根 `C:/` 退化成 `C:` 会让 `C:/x` 失去前缀)。 */
function trimTrailingSep(p: string): string {
  let out = p
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out.length === 2 && out.endsWith(':') ? `${out}/` : out
}

/**
 * 边界安全的前缀判定:`child` 是否就是 `root`,或位于 `root` 之下。
 *
 * 两侧先做 {@link normPath}(分隔符/大小写),再要求完全相等或以 `root + '/'` 开头,
 * 因此 `/a/app2` 不会被 `/a/app` 误判为子路径;结尾分隔符与分隔符混用都不影响结果。
 * `root` 为空时恒为 false(空根不构成白名单)。
 *
 * 只做字符串层面的归一化,不做 `resolve`/`realpath`:涉及 `..`、相对路径或符号链接的
 * 判定请走 {@link isPathAllowed}(它会先归位再比较)。
 */
export function isSameOrUnder(child: string, root: string): boolean {
  const c = normPath(child)
  const r = trimTrailingSep(normPath(root))
  if (r === '') return false
  if (c === r) return true
  return c.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * 解析真实路径(符号链接、`..`、相对路径都归位);空路径或不可达时返回 `null`。
 *
 * 供「目标必须存在」的调用方区分「越权」与「不存在」两种拒绝原因。
 */
export function realpathOrNull(p: string): string | null {
  if (p === '') return null
  try {
    return realpathSync(resolve(p))
  } catch {
    return null
  }
}

/**
 * `realpathSync(resolve(p))` 的容错版本:解析失败时回退到 `resolve(p)`。
 *
 * 网络盘/挂载点可能暂时不可用,此时按字面路径比较,避免把可达的允许根判成越权。
 */
export function realOrResolve(p: string): string {
  return realpathOrNull(p) ?? resolve(p)
}

/** {@link isPathAllowed} 的可选项。 */
export interface PathPolicyOptions {
  /**
   * 是否解析符号链接(默认 `true`)。设为 `false` 时两侧只做 `resolve()`,
   * 用于调用方已自行解析、或仅比对纯字符串路径(会话 cwd 等)的场景。
   */
  realpath?: boolean
}

/**
 * `target` 是否位于 `roots` 之一(含根本身)之下。
 *
 * @param target 待判定路径;为空即拒绝。
 * @param roots 允许根列表(调用方已从 workspace.list / 预设根计算得到);空列表即拒绝。
 * @param options.realpath 见 {@link PathPolicyOptions.realpath}。
 * @returns 命中任一允许根返回 true。
 */
export function isPathAllowed(
  target: string,
  roots: readonly string[],
  options: PathPolicyOptions = {},
): boolean {
  if (target === '') return false
  const pick = options.realpath === false ? resolve : realOrResolve
  const key = pick(target)
  return roots.some((root) => root !== '' && isSameOrUnder(key, pick(root)))
}
