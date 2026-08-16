/**
 * mux 事件中枢:单一 WebSocket/SSE 连接订阅 harness 会话事件,广播给所有订阅者
 * (屏保窗口、远程手机客户端等)。断线自动重连,订阅者无需感知传输细节。
 */

import type { HarnessManager } from './harness'
import type { ServerRequest } from './client'

export type MuxSubscriber = (frame: ServerRequest) => void

export class EventHub {
  private stopMux: (() => void) | null = null
  private subscribers = new Set<MuxSubscriber>()
  private connected = false

  constructor(private harness: HarnessManager) {
    this.harness.on('status', (status: { state: string }) => {
      if (status.state === 'running' || status.state === 'external') {
        this.attach()
      }
    })
  }

  /** 订阅会话事件流,返回退订函数。 */
  subscribe(callback: MuxSubscriber): () => void {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private attach(): void {
    if (this.stopMux !== null) return
    this.stopMux = this.harness.client().openMux((frame) => {
      // 转发会话事件 + 审批/提问帧(否则手机端等不到审批请求,任务会卡住)。
      if (frame.method !== 'session/event' &&
          frame.method !== 'approval/requested' && frame.method !== 'approval/resolved' &&
          frame.method !== 'question/requested' && frame.method !== 'question/resolved') {
        return
      }
      for (const callback of this.subscribers) {
        try {
          callback(frame)
        } catch {
          // 单个订阅者异常不影响其他订阅者。
        }
      }
    }, (ok) => {
      this.connected = ok
      if (!ok) {
        // 事件流断开:外部 harness 可能已被关闭,触发桌面端自动接管。
        this.harness.recheck()
      }
    })
  }

  dispose(): void {
    this.stopMux?.()
    this.stopMux = null
    this.subscribers.clear()
  }
}
