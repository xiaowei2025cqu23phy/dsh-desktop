/**
 * PWA 端共享状态与 HTTP 层。
 *
 * 为什么把 state 放在这里:拆分前 state 定义在 app.ts 顶部的 IIFE 里,215 处引用散落
 * 全文。把对象本身放进模块并 export,各模块 import 到的是**同一个对象引用**,字段读写
 * 与拆分前完全一致(从不整体重新赋值,所以不存在"改了引用别人看不到"的问题)。
 *
 * 三个 fetch 封装的共同点:都带 Bearer 令牌与设备标识头。设备标识是桌面端「按设备
 * 暂停/拉黑」的锚点,因此每个请求都要带——不要在新加的请求里漏掉。
 */

export const state = {
  server: '',
  token: '',
  connected: false,
  sessionId: null as string | null,
  lastSeq: 0,
  msgLog: [] as Array<{ kind: string; text: string; images?: unknown[] }>,
  es: null as EventSource | null,
  workspaces: [] as Array<{ workspaceId: string; path: string; title?: string; sessions?: unknown[] }>,
  presetRoots: [] as Array<{ path: string; name?: string }>,
  currentWsId: null as string | null,
  currentWsPath: null as string | null,
  currentWsRoot: null as string | null,
  running: false,
  stickBottom: true,
  tempCache: localStorage.getItem('dsh-temp-cache') === '1',
  approvals: {} as Record<string, Array<{ rpcId: string; sessionId: string; approvalId: string; toolName: string; reason?: string }>>,
  approvalCards: {} as Record<string, HTMLElement>,
  questions: {} as Record<string, { rpcId: string; sessionId: string; questions: unknown[] }>,
  questionCards: {} as Record<string, HTMLElement>,
  fsPath: '',
  fsParent: '',
  fsPreviewText: '',
  defaultModel: null as { provider: string; model: string } | null,
  deviceId: (function (): string {
    const stored = localStorage.getItem('dsh-device-id')
    if (stored !== null && stored !== '') return stored
    // crypto.randomUUID 仅在安全上下文(HTTPS/localhost)可用;局域网 HTTP 需降级。
    const id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem('dsh-device-id', id)
    return id
  })(),
  sidebarOpen: false,
}

/** 统一的请求头:令牌 + 设备标识(设备标识是桌面端暂停/拉黑的锚点)。 */
function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer ' + state.token,
    'x-dsh-device': state.deviceId,
    'x-dsh-device-label': navigator.userAgent.slice(0, 60),
  }
}

export function apiRpc(method: string, payload?: unknown): Promise<any> {
  return fetch(state.server + '/api/rpc', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ method: method, payload: payload || {} }),
  }).then(function (res) {
    // 401 = 令牌无效/已重新生成,或电脑端已暂停、关闭、到期自动关闭了远程访问。
    if (res.status === 401) throw new Error('令牌无效或远程访问已关闭')
    return res.json()
  }).then(function (data) {
    if (!data.ok) {
      const err: Error & { code?: unknown } = new Error((data.error && data.error.message) || 'RPC 失败')
      err.code = data.error && data.error.code
      throw err
    }
    return data.value
  })
}

/** 应答服务端请求(审批 / 提问),与桌面端机器人通道同一路径。返回 {accepted, reason?}。 */
export function apiRespond(rpcId: string, result: unknown): Promise<any> {
  return fetch(state.server + '/api/respond', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ type: 'client-response', rpcId: rpcId, result: result }),
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  })
}

/** 控制动作(白名单,桌面端执行;用于预设工作区目录等)。 */
export function apiAction(action: string, extra?: Record<string, unknown>): Promise<any> {
  return fetch(state.server + '/api/action', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(Object.assign({ action: action }, extra || {})),
  }).then(function (res) {
    return res.json()
  }).then(function (data) {
    if (!data.ok) throw new Error(data.error || 'action failed')
    return data
  })
}
