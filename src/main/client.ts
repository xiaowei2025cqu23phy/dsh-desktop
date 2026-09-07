/**
 * DeepSeek Harness HTTP RPC 客户端(最小协议实现)。
 *
 * 协议要点(与 deepseek-harness `dsh-host-apiproxy` 对齐):
 * - 一元调用:POST /api/<method>,body = { type:'client-request', rpcId, method, payload },
 *   响应 = { type:'server-response', rpcId, result:{ ok, value | error } }。
 * - 事件流:GET /api/events.mux,SSE 帧 data: { type:'server-request', rpcId, method, payload },
 *   其中 method 即帧类型(session/event 等),payload 即帧体。
 * - 回环地址(Host 头为 127.0.0.1 等)直接通过浏览器信任栅栏,无需令牌。
 */

import { randomUUID } from 'node:crypto'

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export interface RpcError {
  code: string
  message: string
  details: unknown
}

export interface ServerResponse {
  type: 'server-response'
  rpcId: string
  result: RpcResult<unknown>
}

export interface ServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HarnessError'
  }
}

export function isHarnessError(error: unknown): error is HarnessError {
  return error instanceof HarnessError
}

/** Mux 流回调;返回 false 表示消费方要求断开。 */
export type MuxFrameHandler = (frame: ServerRequest) => boolean | void

/** /api/respond 的应答回执(服务端是否接受该应答)。 */
export interface RpcReceipt {
  accepted: boolean
  reason?: string
}

/** 端点协议协商状态(HarnessManager 共享:多个 client 实例必须同一协议)。 */
export type RpcProtocol = 'slash' | 'dot' | null

/** 可变的协议盒:多个 HarnessClient 实例共享一次协商结果。 */
export interface RpcProtocolBox {
  value: RpcProtocol
}

export class HarnessClient {
  /** 每次登录(`?token=` 换 cookie)后的会话 cookie(不含属性部分)。 */
  private cookie: string | null = null
  /** 单飞登录互斥。 */
  private loginFlight: Promise<string | null> | null = null
  /** 最近一次 probe 的失败信息(null = 成功或从未探测)。 */
  private probeFailure: { code: string; message: string } | null = null
  /** 官方 0.1.2-rc.1+ 各方法的 typert 参数壳(按 wire 方法名;缺省 _request)。 */
  private static readonly SLASH_ENVELOPE: Record<string, '_request' | 'request' | 'spread'> = {
    'session/modelCatalog': 'spread',
    'llm/listProviders': 'spread',
    'llm/listConfigurableProviders': 'spread',
    'llm/discoverModels': 'spread',
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
    'settings/describe': 'request',
    'settings/update': 'request',
    'settings/mutate': 'request',
    'settings/replace': 'request',
    'credentials/set': 'request',
    'credentials/describe': 'request',
    'credentials/unset': 'request',
  }

  constructor(
    readonly baseUrl: string,
    private readonly launchToken: () => string | null = () => null,
    /** 端点命名协议共享盒(官方 0.1.2-rc.1+ 斜杠 / 旧版点)。 */
    private readonly protocolBox: RpcProtocolBox = { value: null },
  ) {}

  /**
   * 端点命名协议:官方 0.1.2-rc.1+ 用 `namespace/method`(斜杠,如
   * `session/list`);旧版与自建 fork 用 `namespace.method`(点,如
   * `session.list`)。probe 时对两个候选依次协商。
   */
  get protocol(): RpcProtocol {
    return this.protocolBox.value
  }

  /** 把调用端点名映射到当前协议的 wire 形式(路径与 body.method 都用它)。 */
  private wire(method: string): string {
    return this.protocolBox.value === 'dot' ? method : method.replace('.', '/')
  }

  /**
   * 按协议与目标方法包装调用 payload。官方 0.1.2-rc.1+ 的 typert 签名因方法而异:
   * 会话/设置类多为 `request`,列表类为 `_request`,llm/模型目录类直接展开参数。
   */
  private wirePayload(payload: unknown): unknown {
    if (this.protocolBox.value !== 'slash') return payload
    const envelope = HarnessClient.SLASH_ENVELOPE[this.lastWireMethod] ?? '_request'
    if (envelope === 'spread') return { args: (payload ?? {}) as object }
    if (envelope === 'request') return { args: { request: payload } }
    return { args: { _request: payload } }
  }

  /** 最近一次 wire 方法名(rpcRaw 里设置,供 wirePayload 选择参数壳)。 */
  private lastWireMethod = ''

  /**
   * 官方 0.1.2-rc.1+ 鉴权:GET `/ ?token=`(redirect manual)换取持久签名 cookie,
   * 后续请求凭 cookie 放行。旧版服务(无鉴权,GET / 直接 200)同样安全:无
   * Set-Cookie 即视为无需登录,空 cookie 无害。
   * @returns 会话 cookie(无鉴权服务返回 null)。
   */
  async login(): Promise<string | null> {
    if (this.cookie !== null) return this.cookie
    const token = this.launchToken()
    if (token === null) return null
    if (this.loginFlight !== null) return this.loginFlight
    this.loginFlight = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/?token=${encodeURIComponent(token)}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
        })
        const setCookie = response.headers.get('set-cookie')
        if (setCookie !== null) {
          this.cookie = setCookie.split(';')[0] ?? null
        }
        return this.cookie
      } catch {
        return null
      } finally {
        this.loginFlight = null
      }
    })()
    return this.loginFlight
  }

  /** 统一请求头:JSON 内容 + 已登录 cookie。 */
  private headers(): Record<string, string> {
    const result: Record<string, string> = { 'content-type': 'application/json' }
    if (this.cookie !== null) result.cookie = this.cookie
    return result
  }

  /** 401 时尝试一次重新鉴权(服务重启换 token 后 cookie 过期);成功则回 true。 */
  private async reauthOnUnauthorized(): Promise<boolean> {
    if (this.cookie === null && this.launchToken() === null) return false
    this.cookie = null
    await this.login()
    return this.cookie !== null
  }

  /** 应答服务端请求(审批 / 提问等 server-request 帧)。
   * result 需携带原帧的 rpcId 对应的 value,原样透传给 harness 的 /api/respond。
   */
  async respond(rpcId: string, result: { ok: true; value: unknown }, timeoutMs = 15000): Promise<RpcReceipt> {
    const response = await fetch(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new HarnessError('http-' + String(response.status), `HTTP ${response.status} on /api/respond`)
    }
    return await response.json() as RpcReceipt
  }

  /**
   * 探测目标地址是否为可用的 dsh harness,并协商端点命名协议与 payload
   * 形状。先试官方 0.1.2-rc.1+ 的斜杠端点(`session/list` + `{args}` 包装),
   * 再试旧版/自建 fork 的点端点(`session.list` + 裸 payload);第一个成功者
   * 被固定为后续所有调用的协议。官方网关对"端点存在但参数形状不符"返回
   * 业务错误码而非 404——这种响应同样确认协议(参数形状不影响探测)。
   */
  async probe(timeoutMs = 12000): Promise<boolean> {
    // 协议已协商过:只探测当前协议对应的端点,避免每次重启探测都重试
    // 两个候选(会话多时 session.list 较重,反复探测会拖慢 waitReady)。
    if (this.protocolBox.value !== null) {
      const [wireName, payload] = this.protocolBox.value === 'slash'
        ? ['session/list', { args: { _request: {} } } as unknown]
        : ['session.list', {}]
      try {
        await this.rpcRaw(wireName, payload, timeoutMs)
        return true
      } catch (error) {
        this.probeFailure = error instanceof HarnessError
          ? { code: error.code, message: error.message }
          : { code: 'unknown', message: String(error) }
        return false
      }
    }
    for (const [candidate, isSlash] of [['session/list', true], ['session.list', false]] as const) {
      try {
        await this.rpcRaw(candidate, isSlash ? { args: { _request: {} } } : {}, timeoutMs)
        this.protocolBox.value = isSlash ? 'slash' : 'dot'
        return true
      } catch (error) {
        if (isSlash && error instanceof HarnessError &&
          (error.code === 'gateway/arguments-invalid' || error.code === 'gateway/internal')) {
          // 端点存在(参数形状无关紧要):官方协议确认。
          this.protocolBox.value = 'slash'
          return true
        }
        this.probeFailure = error instanceof HarnessError
          ? { code: error.code, message: error.message }
          : { code: 'unknown', message: String(error) }
      }
    }
    return false
  }

  /** 最近一次 probe 的失败详情(null = 成功或从未探测);401 表示需要 launch token。 */
  lastProbeFailure(): { code: string; message: string } | null {
    return this.probeFailure
  }

  /** 一元 RPC 调用,返回业务值;失败抛 HarnessError。 */
  async rpc<T>(method: string, payload: unknown = {}, timeoutMs = 30000): Promise<T> {
    const wireMethod = this.wire(method)
    // 官方 0.1.2-rc.1+ 没有旧版的一些方法:提供别名/降级,避免整条链路抛 404。
    if (this.protocolBox.value === 'slash') {
      if (method === 'host.describe') {
        try {
          this.lastWireMethod = 'host/describe'
          return await this.rpcRaw<T>('host/describe', this.wirePayload(payload), timeoutMs)
        } catch (error) {
          if (error instanceof HarnessError && error.code === 'http-404') {
            return { version: '', cwd: '', canOpenPath: false } as T
          }
          throw error
        }
      }
      if (method === 'session.history') {
        // 官方没有等价分页语义:先降级为空历史,渲染端不崩溃。
        return { events: [] } as T
      }
      if (method === 'workspace.list') {
        // 官方没有 workspace/list:由会话的 cwd 合成工作区列表。
        this.lastWireMethod = 'session/list'
        const raw = await this.rpcRaw<{ items?: Array<{ cwd?: string }> }>('session/list', this.wirePayload({}), timeoutMs)
        const byPath = new Map<string, string>()
        for (const item of raw.items ?? []) {
          if (typeof item.cwd === 'string' && item.cwd !== '' && !byPath.has(item.cwd)) {
            byPath.set(item.cwd, item.cwd.split(/[\\/]/).filter(Boolean).pop() ?? item.cwd)
          }
        }
        const items = [...byPath.entries()].map(([path, title]) => ({ workspaceId: path, title, path }))
        return { items } as T
      }
    }
    this.lastWireMethod = wireMethod
    return this.rpcRaw<T>(wireMethod, this.wirePayload(payload), timeoutMs)
  }

  /** 一元 RPC wire 传输:按已给定(协商好的)端点名发请求并解析响应。 */
  private async rpcRaw<T>(wireMethod: string, payload: unknown = {}, timeoutMs = 30000): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/${wireMethod}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: wireMethod,
        payload,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401 && await this.reauthOnUnauthorized()) {
      return await this.rpcRaw<T>(wireMethod, payload, timeoutMs)
    }
    if (!response.ok) {
      throw new HarnessError('http-' + String(response.status), `HTTP ${response.status} on /api/${wireMethod}`)
    }
    const message = await response.json() as ServerResponse
    if (message.type !== 'server-response' || message.rpcId === undefined) {
      throw new HarnessError('bad-response', '服务端返回了无法识别的响应')
    }
    if (message.result.ok) return message.result.value as T
    const error = message.result.error
    throw new HarnessError(error.code, error.message)
  }

  /**
   * 订阅 mux 事件流(自动重连,带指数退避)。
   *
   * 传输协商:不同 harness 版本对 /api/events.mux 的实现不同 —— 旧版只接受
   * WebSocket upgrade(HTTP 请求返回 426),新版额外提供 SSE。优先 WebSocket,
   * 连接失败时回退 SSE;重连沿用上次成功的传输。
   *
   * @param onFrame - 每帧回调;返回 false 时主动断开且不重连。
   * @param onStatus - 连接状态变化回调。
   * @returns 手动停止函数。
   */
  openMux(onFrame: MuxFrameHandler, onStatus?: (connected: boolean, error?: string) => void): () => void {
    let stopped = false
    let aborted = false
    const abort = new AbortController()
    const muxUrl = `${this.baseUrl}/api/events.mux`
    const wsUrl = muxUrl.replace(/^http/, 'ws')
    let transport: 'ws' | 'sse' | null = null

    const run = async (): Promise<void> => {
      let delayMs = 500
      while (!stopped && !aborted) {
        const useWs = transport === 'ws' || (transport === null && await wsSupported(muxUrl, abort.signal))
        try {
          onStatus?.(true)
          if (useWs) {
            transport = 'ws'
            await this.pumpWebSocket(wsUrl, abort.signal, onFrame, () => { stopped = true })
          } else {
            transport = 'sse'
            await this.pumpSse(muxUrl, abort.signal, onFrame, () => { stopped = true })
          }
          if (stopped) break
          throw new Error('mux 流已结束')
        } catch (error) {
          if (stopped || aborted) break
          const message = error instanceof Error ? error.message : String(error)
          onStatus?.(false, message)
          await sleep(delayMs)
          delayMs = Math.min(delayMs * 2, 15000)
        }
      }
    }

    void run()

    return () => {
      stopped = true
      aborted = true
      abort.abort()
    }
  }

  /** WebSocket 通道:逐帧 JSON 解析;连接意外关闭视为流结束(由外层重连)。 */
  private pumpWebSocket(
    url: string,
    signal: AbortSignal,
    onFrame: MuxFrameHandler,
    onStop: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket | null = null
      try {
        socket = new WebSocket(url)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      socket.onmessage = (event: MessageEvent) => {
        try {
          const frame = JSON.parse(String(event.data)) as ServerRequest
          if (frame.type !== 'server-request') return
          if (onFrame(frame) === false) {
            onStop()
            socket?.close()
          }
        } catch {
          // 非 JSON 帧忽略。
        }
      }
      socket.onerror = () => {
        // onclose 随后触发,统一走 close 分支。
      }
      socket.onclose = (event: CloseEvent) => {
        if (signal.aborted) {
          resolve()
          return
        }
        if (event.code === 1005 || event.code === 1000) {
          // 正常关闭(含服务端主动结束)。
          resolve()
          return
        }
        reject(new Error(`WebSocket 关闭(code=${event.code})`))
      }
      signal.addEventListener('abort', () => {
        socket?.close()
      })
    })
  }

  /** SSE 通道:解析 `data: <json>` 帧;426 或非 200 抛错由外层决定回退。 */
  private async pumpSse(
    url: string,
    signal: AbortSignal,
    onFrame: MuxFrameHandler,
    onStop: () => void,
  ): Promise<void> {
    const response = await fetch(url, {
      signal,
      headers: { accept: 'text/event-stream', ...this.headers() },
    })
    if (!response.ok || !response.body) {
      throw new Error(`mux 流 HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split: number
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = block.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
        if (data === '') continue
        let frame: ServerRequest
        try {
          frame = JSON.parse(data) as ServerRequest
        } catch {
          continue
        }
        if (frame.type !== 'server-request') continue
        if (onFrame(frame) === false) {
          onStop()
          return
        }
      }
    }
  }
}

/** 探测 WebSocket 通道是否可用(HTTP 请求返回 426 说明只接受 upgrade)。 */
async function wsSupported(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { signal, headers: { accept: 'text/event-stream' } })
    if (response.status === 426) return true
    void response.body?.cancel()
    if (response.status === 401) return false
    return !response.ok
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
