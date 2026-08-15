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

export class HarnessClient {
  constructor(readonly baseUrl: string) {}

  /** 探测目标地址是否为可用的 dsh harness。 */
  async probe(timeoutMs = 3000): Promise<boolean> {
    try {
      const result = await this.rpc('session.list', {}, timeoutMs)
      return result !== null
    } catch {
      return false
    }
  }

  /** 一元 RPC 调用,返回业务值;失败抛 HarnessError。 */
  async rpc<T>(method: string, payload: unknown = {}, timeoutMs = 30000): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new HarnessError('http-' + String(response.status), `HTTP ${response.status} on /api/${method}`)
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
        const useWs = transport === 'ws' || (transport === null && await wsSupported(wsUrl, abort.signal))
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
      headers: { accept: 'text/event-stream' },
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
    return !response.ok
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
