/**
 * mux 事件中枢:单一 WebSocket/SSE 连接订阅 harness 会话事件,广播给所有订阅者
 * (屏保窗口、远程手机客户端等)。断线自动重连,订阅者无需感知传输细节。
 *
 * 除转发外只多做一件事:为**还没有活动行的会话**派生活动记录。活动的另一个写入者是
 * RemoteCommandProcessor.recordTask,只有机器人/队列/webhook 任务会走那里;用户在内嵌
 * harness 页面里直接发起的会话(最常见的用法)一条 activity 都没有,结果是徽标显示
 * `▶ 0` 而 agent 正在干活,桌面端也没有停止入口。事件流里数据是现成的,故在此派生。
 *
 * 收敛规则(状态必须能从「运行中」走到终点,否则徽标永远卡住):
 * - turn/start、user/message、assistant/chunk、tool/call → running(working)
 * - approval/requested、question/requested → waiting;对应 resolved → running
 * - **turn/end 是唯一的终点信号**:reason.kind='aborted'(取消)→ cancelled,
 *   'error'(或 TRANSPORT 中断)→ failed,其余 → completed。
 */

import { activeConfigStore, type ActivityRecord, type ConfigStore } from './config'
import type { HarnessManager } from './harness'
import type { ServerRequest } from './client'
import { evictOldest, isRecord, turnEndFailure } from './remote-util'

export type MuxSubscriber = (frame: ServerRequest) => void

/** 派生活动的 id 前缀:与 recordTask 写的 `activity-task-*` 区分(显式行优先,只更新状态)。 */
const DERIVED_ID_PREFIX = 'activity-live-'

/** 单会话派生活动的进程内状态:只在字段真变化时落库(事件流很密,不能每个 token 都写 SQLite)。 */
interface DerivedState {
  activityId: string
  /** true = 该行由 recordTask 显式写入,标题/工作区/最近事件都归它自己维护,这里只同步状态。 */
  explicit: boolean
  status: ActivityRecord['status']
  title: string
  lastEvent: string
}

export class EventHub {
  private stopMux: (() => void) | null = null
  private subscribers = new Set<MuxSubscriber>()
  private connected = false
  /** 会话 → 派生活动行。 */
  private derived = new Map<string, DerivedState>()
  /** 构造时显式注入的配置仓库(缺省时用进程内当前实例)。 */
  private readonly injected: ConfigStore | null

  constructor(private harness: HarnessManager, config?: ConfigStore) {
    this.injected = config ?? null
    // 上次运行遗留的派生活动不会再有 turn/end 收尾,启动即收摊,避免徽标永远停在「运行中」。
    this.settleStaleRows()
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
      // 先派生活动再广播:订阅者(含机器人汇报)看到的是同一份状态;派生失败不影响转发。
      try {
        this.deriveActivity(frame)
      } catch (error) {
        console.warn('[events] 派生活动失败:', error instanceof Error ? error.message : String(error))
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
    this.derived.clear()
  }

  /** 活动表所在配置仓库:优先构造时注入的,否则取进程内当前实例。 */
  private store(): ConfigStore | null {
    return this.injected ?? activeConfigStore()
  }

  /** 应用启动时,把上一次运行遗留的派生行收摊(它们不会再收到 turn/end)。显式行不在此处处理。 */
  private settleStaleRows(): void {
    const store = this.store()
    if (store === null) return
    const now = Date.now()
    for (const item of store.activities()) {
      if (!item.id.startsWith(DERIVED_ID_PREFIX)) continue
      if (item.status !== 'running' && item.status !== 'waiting' && item.status !== 'queued') continue
      store.upsertActivity({ ...item, status: 'failed', lastEvent: '桌面端已重启,该会话不再受跟踪', updatedAt: now })
    }
  }

  /** 会话事件 / 审批帧 → 派生活动。 */
  private deriveActivity(frame: ServerRequest): void {
    const payload = isRecord(frame.payload) ? frame.payload : null
    if (payload === null) return
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return
    // 子代理会话若在帧里带了来源标记,不单独派生活动,否则并行子代理会把徽标刷成 N。
    // (harness 不保证帧里带这些字段,带了才过滤;它们仍是各自会话,不影响取消。)
    if (payload.origin === 'subagent') return
    if (typeof payload.parentSessionId === 'string' && payload.parentSessionId !== '') return
    if (frame.method !== 'session/event') {
      // 审批/提问:等待人工处理也是一种「运行中」,否则徽标显示 0 而任务其实卡住了。
      if (frame.method === 'approval/requested') {
        this.patchActivity(sessionId, { status: 'waiting', lastEvent: `等待审批:${str(payload.toolName) || '工具调用'}` })
      } else if (frame.method === 'question/requested') {
        this.patchActivity(sessionId, { status: 'waiting', lastEvent: '等待回答提问' })
      } else {
        // 已处理 ≠ 一定在跑:没有行的会话不在此处新建(否则空转的会话会留下一条永远「运行中」)。
        this.patchActivity(sessionId, { status: 'running', lastEvent: '审批/提问已处理,继续执行' }, false)
      }
      return
    }
    if (!isRecord(payload.event)) return
    const event = payload.event
    const type = typeof event.type === 'string' ? event.type : ''
    const data = isRecord(event.data) ? event.data : {}
    switch (type) {
      case 'turn/start':
        this.patchActivity(sessionId, { status: 'running', lastEvent: '回合开始' })
        return
      case 'user/message':
        this.patchActivity(sessionId, { status: 'running', lastEvent: '收到新消息,开始处理' })
        return
      case 'assistant/chunk':
      case 'assistant/message':
        // 模型输出:状态保持运行中即可,不写「最近事件」——增量事件太密,写库会变成负担。
        this.patchActivity(sessionId, { status: 'running' })
        return
      case 'tool/call':
        this.patchActivity(sessionId, { status: 'running', lastEvent: `工具:${str(data.name) || '调用'}` })
        return
      case 'session/title': {
        // harness 自己生成的会话标题(与内嵌页侧边栏一致),比会话 id 可读;改名可能发生在空转会话上,
        // 因此只更新已有行,不新建(create=false)。空标题直接忽略,别把可读标题擦掉。
        const title = str(data.title).trim()
        if (title === '') return
        this.patchActivity(sessionId, { title: title.slice(0, 120) }, false)
        return
      }
      case 'turn/end': {
        const kind = isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : ''
        if (kind === 'aborted') {
          // 用户「停止」走 session.cancel,harness 以 reason.kind='aborted' 收尾。
          this.patchActivity(sessionId, { status: 'cancelled', lastEvent: '已停止' })
          return
        }
        const failure = turnEndFailure(event)
        if (failure !== null) {
          this.patchActivity(sessionId, { status: 'failed', lastEvent: (failure.message || '回合失败').slice(0, 200) })
          return
        }
        this.patchActivity(sessionId, { status: 'completed', lastEvent: kind === '' || kind === 'completed' ? '已完成' : `已结束(${kind})` })
        return
      }
      default:
        return
    }
  }

  /**
   * 写入派生活动。
   *
   * 同会话已有显式行(recordTask 写的)时**只更新状态**,标题 / 工作区 / 最近事件仍归它维护,
   * 两边不互相覆盖;没有任何行时才用 `activity-live-<会话id>` 建派生行。
   *
   * @param create 该事件能否代表「会话正在活动」。false 时只更新已有行,不新建
   *   (改名、审批已处理这类事件本身不说明会话在跑,凭空建行会留下永远「运行中」的记录)。
   */
  private patchActivity(
    sessionId: string,
    patch: { status?: ActivityRecord['status']; title?: string; lastEvent?: string },
    create = true,
  ): void {
    const store = this.store()
    if (store === null) return
    let state = this.derived.get(sessionId)
    if (state === undefined) {
      // 首次见到该会话:只查一次已有活动行(显式行优先;上次运行留下的派生行沿用同一 id)。
      const existing = store.activities().find((item) => item.sessionId === sessionId)
      if (existing === undefined && !create) return
      state = existing === undefined
        ? {
            activityId: `${DERIVED_ID_PREFIX}${sessionId}`,
            explicit: false,
            status: 'running',
            title: `会话 ${sessionId.slice(0, 12)}`,
            lastEvent: '会话进行中',
          }
        : {
            activityId: existing.id,
            explicit: !existing.id.startsWith(DERIVED_ID_PREFIX),
            status: existing.status,
            title: existing.title,
            lastEvent: existing.lastEvent,
          }
      this.derived.set(sessionId, state)
      evictOldest(this.derived, 300)
    }
    // 显式行只同步状态;派生行的标题/最近事件由事件流维护。
    const status = patch.status ?? state.status
    const title = state.explicit ? state.title : patch.title ?? state.title
    const lastEvent = state.explicit ? state.lastEvent : patch.lastEvent ?? state.lastEvent
    if (status === state.status && title === state.title && lastEvent === state.lastEvent) return
    state.status = status
    state.title = title
    state.lastEvent = lastEvent
    const now = Date.now()
    const current = store.activities().find((item) => item.id === state.activityId)
    const row: ActivityRecord = current ?? {
      id: state.activityId,
      type: 'task',
      source: 'web',
      workspace: null,
      sessionId,
      status,
      title,
      lastEvent,
      createdAt: now,
      updatedAt: now,
    }
    // 每次写库先取最新行:recordTask 可能刚更新过标题/工作区,不能拿旧副本覆盖回去。
    store.upsertActivity(state.explicit
      ? { ...row, status, updatedAt: now }
      : { ...row, status, title, lastEvent, updatedAt: now })
  }
}

/** 帧字段取值:非字符串一律按空串处理(帧来自外部 harness,字段类型不可信)。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
