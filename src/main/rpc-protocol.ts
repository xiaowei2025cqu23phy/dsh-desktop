/**
 * DeepSeek Harness RPC 协议适配层(纯函数,无 Electron/harness 依赖,可独立单测)。
 *
 * 输入(协议, 方法名, 参数),输出 wire 端点名与 wire 载荷。把协议经验值集中于此,
 * 便于录制回放测试覆盖;官方发版变更协议时只需改这一处。
 */

/** 端点命名协议(与 HarnessManager 共享:多个 client 实例必须同一协议)。 */
export type RpcProtocol = 'slash' | 'dot' | null

/** typert 参数壳类型。 */
export type WireEnvelope = '_request' | 'request' | 'spread' | 'nsRequest'

/** 官方 0.1.2-rc.1+ 各方法的 typert 参数壳(按 wire 方法名;缺省 _request)。 */
export const SLASH_ENVELOPE: Record<string, WireEnvelope> = {
  'session/modelCatalog': 'spread',
  'llm/listProviders': 'spread',
  'llm/listConfigurableProviders': 'spread',
  'llm/discoverModels': 'nsRequest',
  'session/create': 'request',
  'session/rename': 'request',
  'session/selectModel': 'request',
  'session/page': 'request',
  'session/prompt': 'request',
  'session/updateQueue': 'request',
  'session/cancel': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
  'workspace/delete': 'request',
  'workspace/archiveSession': 'request',
  'settings/describe': 'spread',
  'settings/update': 'spread',
  'settings/mutate': 'spread',
  'settings/replace': 'spread',
  'credentials/set': 'spread',
  'credentials/describe': 'spread',
  'credentials/unset': 'spread',
  // 目录类方法:官方 UI 实测均为展开参数(spread),旧版点端点默认 _request 不适用。
  'agentPresets/list': 'spread',
  'dynamicCordisRunner/inventory': 'spread',
  'dynamicCordisRunner/syncInspectManifest': 'spread',
  'commands/list': 'spread',
  'subagents/list': 'spread',
  'skills/list': 'request',
}

/**
 * 把调用端点名映射到当前协议的 wire 形式(路径与 body.method 都用它)。
 * 官方 0.1.2-rc.1+ 用斜杠(`session/list`),旧版/自建 fork 用点(`session.list`)。
 */
export function toWireMethod(protocol: RpcProtocol, method: string): string {
  return protocol === 'dot' ? method : method.replace('.', '/')
}

/**
 * 按协议与目标方法包装调用 payload。
 * 官方 0.1.2-rc.1+ 的 typert 签名因方法而异:会话/设置类多为 `request`,
 * 列表类为 `_request`,llm/模型目录类直接展开参数。
 */
export function toWirePayload(protocol: RpcProtocol, method: string, payload: unknown): unknown {
  if (protocol !== 'slash') return payload
  const envelope = SLASH_ENVELOPE[method] ?? '_request'
  if (envelope === 'nsRequest') {
    const record = (payload ?? {}) as Record<string, unknown>
    const { settingsNs, ...rest } = record
    return { args: { settingsNs: settingsNs ?? 'llm-pi-ai', request: rest } }
  }
  if (envelope === 'spread') return { args: (payload ?? {}) as object }
  if (envelope === 'request') return { args: { request: payload } }
  return { args: { _request: payload } }
}
