/**
 * 实例能力探测:连接某个 harness 实例,探测其支持的 RPC 特性,
 * 用于在桌面端区分「官方版」与「本地魔改版(fork)」并展示可用能力。
 *
 * 判别规则(实测):harness 对不存在的 RPC 返回 HTTP 404(error.code='http-404');
 * 方法存在但参数无效返回 bad-request。host.listEntries 是本地 fork 特有的
 * 文件浏览 RPC,官方版不存在 → 可作来源判别标志。
 */

import type { HarnessClient } from './client'
import { isHarnessError } from './client'
import type { HarnessManager } from './harness'

export interface InstanceCapabilities {
  /** 实例是否可达(host.describe 成功)。 */
  reachable: boolean
  /** 来源:fork = 含 host.listEntries 等魔改 RPC;official = 官方版;unknown = 无法判定。 */
  source: 'official' | 'fork' | 'unknown'
  probes: Array<{ method: string; label: string; ok: boolean | null; note?: string }>
  checkedAt: number
}

const PROBES = [
  { method: 'session.list', label: '会话列表' },
  { method: 'workspace.list', label: '工作区' },
  { method: 'llm.models', label: '模型目录' },
  { method: 'host.listEntries', label: '侧边栏文件浏览(魔改)' },
  { method: 'host.readTextFile', label: '文本/图片预览(魔改)' },
  { method: 'host.writeTextFile', label: '文件编辑(魔改)' },
  { method: 'host.writeFileBytes', label: '文件上传(魔改)' },
  { method: 'host.readFileRange', label: '文件下载(魔改)' },
  { method: 'host.readPdfFile', label: 'PDF 预览(魔改)' },
  { method: 'host.readMediaFile', label: '音视频预览(魔改)' },
  { method: 'host.renameEntry', label: '重命名/移动(魔改)' },
  { method: 'host.listZipEntries', label: 'zip/tar 归档浏览(魔改)' },
  { method: 'host.readZipEntry', label: '归档条目预览(魔改)' },
  { method: 'host.listTarEntries', label: 'tar.gz 浏览(魔改)' },
  { method: 'host.readTarEntry', label: 'tar 条目预览(魔改)' },
  { method: 'host.extractZipArchive', label: '归档解压(魔改)' },
]

/**
 * 判定 RPC 方法是否存在:
 * - 调用成功 → true;
 * - http-404 / "not found" → false(方法不存在);
 * - 其它业务错误(bad-request 等)→ true(已路由到方法,是参数问题);
 * - 网络/超时等 → null(未知)。
 */
async function methodOk(client: HarnessClient, method: string, timeoutMs: number): Promise<boolean | null> {
  try {
    await client.rpc(method, {}, timeoutMs)
    return true
  } catch (error) {
    if (isHarnessError(error)) {
      if (error.code === 'http-404' || /not.?found/i.test(error.message)) return false
      return true
    }
    return null
  }
}

export async function probeCapabilities(harness: HarnessManager, timeoutMs = 3000): Promise<InstanceCapabilities> {
  const client = harness.client()
  // 可达性判定复用主探测的协议协商(官方 0.1.2-rc.1+ 无 host/describe,'session/list'
  // 是双方都有的最小只读端点)。
  const reachable = await client.probe(Math.min(timeoutMs, 5000))
  // 实例不可达(未启动/停机中):直接返回,避免逐方法傻等超时。
  if (!reachable) {
    return { reachable: false, source: 'unknown', probes: [], checkedAt: Date.now() }
  }
  const settled = await Promise.allSettled(
    PROBES.map(async (probe) => ({ ...probe, ok: await methodOk(client, probe.method, timeoutMs) })),
  )
  const probes = settled.map((entry) => {
    if (entry.status === 'fulfilled') return entry.value
    return { method: '?', label: '探测失败', ok: null as boolean | null }
  })
  const marker = probes.find((probe) => probe.method === 'host.listEntries')
  const source = !reachable
    ? 'unknown'
    : marker?.ok === true
      ? 'fork'
      : marker?.ok === false
        ? 'official'
        : 'unknown'
  return { reachable, source, probes, checkedAt: Date.now() }
}
