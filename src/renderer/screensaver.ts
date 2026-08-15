/**
 * AI 屏保页面:实时渲染 agent 的思考、文本与工具调用。
 * 经典脚本(无 import/export),整体包在 IIFE 中。任何键/鼠标活动退出全屏。
 */

(() => {

function $id(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing element #${id}`)
  return el
}

const S = window.DSHShared
const API = window.dshDesktop

interface StreamMessage {
  kind: 'user' | 'assistant' | 'tool' | 'system'
  root: HTMLElement
  body: HTMLElement
  think: HTMLElement | null
  text: string
  thinking: string
  toolName: string
  toolState: HTMLElement | null
  toolArgs: HTMLElement | null
  streaming: boolean
}

const state: {
  sessionId: string | null
  resumed: boolean
  status: 'connecting' | 'starting' | 'running' | 'idle' | 'error'
  lastSeq: number
  messages: StreamMessage[]
  title: string
  model: string
} = {
  sessionId: null,
  resumed: false,
  status: 'connecting',
  lastSeq: 0,
  messages: [],
  title: 'AI 屏保',
  model: '',
}

// ---- 渲染原语 ----

function streamEl(): HTMLElement { return $id('ss-stream') }

function autoScroll(): void {
  const el = streamEl()
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
  if (nearBottom) el.scrollTop = el.scrollHeight
}

function setStatus(text: string, kind: 'normal' | 'running' | 'idle' | 'error' = 'normal'): void {
  const el = $id('ss-status')
  el.textContent = text
  el.className = `ss-status ${kind}`
}

function setTitle(text: string): void {
  state.title = text
  $id('ss-title').textContent = text
}

function setModel(text: string): void {
  state.model = text
  $id('ss-model').textContent = text === '' ? '' : `模型:${text}`
}

function addMessage(kind: StreamMessage['kind']): StreamMessage {
  const stream = streamEl()
  $id('ss-ambient').style.display = 'none'
  const root = document.createElement('div')
  root.className = `msg msg-${kind}`

  const avatar = document.createElement('div')
  avatar.className = 'msg-avatar'
  avatar.textContent = kind === 'user' ? '你' : kind === 'tool' ? '⚙' : '◈'

  const body = document.createElement('div')
  body.className = 'msg-body'

  const message: StreamMessage = {
    kind,
    root,
    body,
    think: null,
    text: '',
    thinking: '',
    toolName: '',
    toolState: null,
    toolArgs: null,
    streaming: false,
  }

  if (kind === 'tool') {
    root.appendChild(avatar)
    const inner = document.createElement('div')
    inner.className = 'tool-inner'
    const head = document.createElement('div')
    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = '工具'
    const toolState = document.createElement('span')
    toolState.className = 'tool-state'
    head.appendChild(name)
    head.appendChild(toolState)
    const toolArgs = document.createElement('div')
    toolArgs.className = 'tool-args'
    inner.appendChild(head)
    inner.appendChild(toolArgs)
    body.appendChild(inner)
    message.toolState = toolState
    message.toolArgs = toolArgs
  } else {
    root.appendChild(avatar)
    root.appendChild(body)
  }
  stream.appendChild(root)
  autoScroll()
  return message
}

function lastAssistant(): StreamMessage | null {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index]
    if (message.kind === 'assistant') return message
  }
  return null
}

function renderText(message: StreamMessage): void {
  if (message.kind === 'tool') {
    if (message.toolArgs !== null) {
      message.toolArgs.textContent = message.text
    }
    return
  }
  let html = ''
  if (message.thinking !== '') {
    html += `<div class="msg-think">${S.escapeHtml(message.thinking)}</div>`
  }
  html += S.escapeHtml(message.text)
  message.body.innerHTML = html
  message.body.classList.toggle('cursor-blink', message.streaming)
}

// ---- 事件折叠 ----

function handleSessionEvent(event: { type?: unknown; seq?: unknown; data?: unknown }): void {
  if (typeof event.type !== 'string') return
  if (typeof event.seq === 'number') {
    if (event.seq <= state.lastSeq) return
    state.lastSeq = event.seq
  }
  const data = S.isRecord(event.data) ? event.data : {}
  switch (event.type) {
    case 'turn/start':
      state.status = 'running'
      setStatus('运行中…', 'running')
      break
    case 'turn/end':
      state.status = 'idle'
      setStatus('空闲(本轮完成)', 'idle')
      break
    case 'user/message': {
      const text = S.textFromBlocks(data.content)
      if (text.trim() === '') break
      const message = addMessage('user')
      message.text = text
      message.body.textContent = text
      state.messages.push(message)
      break
    }
    case 'assistant/chunk': {
      const chunk = S.isRecord(data.chunk) ? data.chunk : {}
      let message = lastAssistant()
      const delta = typeof chunk.text === 'string' ? chunk.text : ''
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        if (message === null || message.kind !== 'assistant') {
          message = addMessage('assistant')
          message.streaming = true
          state.messages.push(message)
        }
        if (chunk.type === 'text-delta') {
          message.text += delta
        } else {
          message.thinking += delta
        }
        renderText(message)
        autoScroll()
      } else if (chunk.type === 'tool-call-delta') {
        const toolName = typeof chunk.name === 'string' ? chunk.name : message?.toolName ?? '工具'
        const deltaArgs = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        if (message === null || message.kind !== 'tool' || message.toolName !== toolName) {
          message = addMessage('tool')
          message.toolName = toolName
          message.streaming = true
          if (message.toolState !== null) {
            message.toolState.textContent = '调用中…'
            message.toolState.className = 'tool-state'
          }
          state.messages.push(message)
        }
        message.text += deltaArgs
        if (message.toolArgs !== null) message.toolArgs.textContent = message.text
        if (message.toolState !== null && message.toolState.textContent === '') {
          message.toolState.textContent = '调用中…'
        }
        autoScroll()
      } else if (chunk.type === 'block-end') {
        if (message !== null) {
          message.streaming = false
          renderText(message)
        }
      } else if (chunk.type === 'finish') {
        if (message !== null) {
          message.streaming = false
          renderText(message)
        }
        state.status = 'idle'
        setStatus('空闲(本轮完成)', 'idle')
      }
      break
    }
    case 'assistant/message': {
      let message = lastAssistant()
      const content = S.isRecord(data.message) ? data.message.content : undefined
      const fullText = S.textFromBlocks(content)
      if (message === null || message.kind !== 'assistant') {
        message = addMessage('assistant')
        state.messages.push(message)
      }
      message.streaming = false
      if (fullText !== '') {
        message.text = fullText
        renderText(message)
      }
      autoScroll()
      break
    }
    case 'tool/call': {
      const toolName = typeof data.name === 'string' ? data.name : '工具'
      const message = addMessage('tool')
      message.toolName = toolName
      message.text = typeof data.arguments === 'string' ? prettyJson(data.arguments) : ''
      if (message.toolState !== null) {
        message.toolState.textContent = '调用中…'
        message.toolState.className = 'tool-state'
      }
      if (message.toolArgs !== null) message.toolArgs.textContent = message.text
      message.root.querySelector('.tool-name')!.textContent = toolName
      state.messages.push(message)
      break
    }
    case 'tool/result': {
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const message = state.messages[index]
        if (message.kind === 'tool' && message.toolState !== null && message.toolState.textContent === '调用中…') {
          const failed = data.error !== undefined
          message.toolState.textContent = failed ? '失败' : '完成'
          message.toolState.className = failed ? 'tool-state fail' : 'tool-state done'
          message.streaming = false
          break
        }
      }
      break
    }
    case 'session/title': {
      if (typeof data.title === 'string' && data.title.trim() !== '') {
        setTitle(data.title.trim())
      }
      break
    }
    case 'request/header': {
      const config = S.isRecord(data.header) ? data.header.config : undefined
      if (S.isRecord(config)) {
        const provider = typeof config.provider === 'string' ? config.provider : ''
        const model = typeof config.model === 'string' ? config.model : ''
        if (provider !== '' && model !== '') setModel(`${provider} / ${model}`)
      }
      break
    }
    case 'stream/error': {
      state.status = 'error'
      setStatus('事件流错误', 'error')
      break
    }
    default:
      break
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** 折叠一条历史记录(history 页条目 {event, view?} 或裸 SessionEvent)。 */
function handleHistoryEntry(entry: unknown): void {
  if (!S.isRecord(entry)) return
  const event = S.isRecord(entry.event) ? entry.event : entry
  handleSessionEvent(event)
}

// ---- 启动流程 ----

async function boot(): Promise<void> {
  // 调试钩子:--ss-debug 启动时通过 ?keep=1 保持窗口打开(验证用)。
  if (new URLSearchParams(window.location.search).get('keep') === '1') {
    ;(window as unknown as { __SS_KEEP_OPEN__?: boolean }).__SS_KEEP_OPEN__ = true
  }
  bindExitEvents()
  setStatus('连接中…')
  setInterval(() => {
    const now = new Date()
    $id('ss-clock').textContent = S.formatTime(now)
    $id('ss-ambient-clock').textContent =
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }, 1000)

  // 实时事件流(主进程已按 sessionId 过滤,这里再做 seq 去重)。
  // sessionId 确定前先缓冲:startTask 完成前的窗口期里,其他会话的事件不能串入画面。
  const pendingFrames: ServerRequestFrame[] = []
  let sessionKnown = false
  const unsubscribe = API.screensaver.onEvent((frame) => {
    if (frame.method !== 'session/event') return
    if (!sessionKnown) {
      pendingFrames.push(frame)
      if (pendingFrames.length > 500) pendingFrames.shift()
      return
    }
    const payload = S.isRecord(frame.payload) ? frame.payload : {}
    if (state.sessionId !== null && payload.sessionId !== state.sessionId) return
    handleSessionEvent(S.isRecord(payload.event) ? payload.event : {})
  })

  const status = await API.harness.getStatus().catch(() => null)
  if (status !== null) {
    $id('ss-url').textContent = status.baseUrl
  }

  const task = await API.screensaver.startTask().catch((error: unknown) => {
    state.status = 'error'
    setStatus('任务启动失败', 'error')
    S.toast(`任务启动失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    return null
  })
  sessionKnown = true

  if (task === null) {
    // 纯环境屏保:不渲染任何会话事件。
    unsubscribe()
    setStatus('待机', 'idle')
    return
  }

  state.sessionId = task.sessionId
  state.resumed = task.resumed
  API.screensaver.reportSessionId(task.sessionId)
  setStatus(task.resumed ? '继续上次任务…' : '任务启动中…')
  if (task.resumed) {
    setTitle('继续上次任务')
    try {
      const history = await API.screensaver.history(task.sessionId, 60)
      for (const entry of history) handleHistoryEntry(entry)
    } catch {
      // 历史不可用不影响实时流。
    }
  } else {
    setTitle('AI 任务进行中')
  }
  // 回放缓冲中属于本会话的帧(按 seq 去重由 handleSessionEvent 负责)。
  for (const frame of pendingFrames) {
    const payload = S.isRecord(frame.payload) ? frame.payload : {}
    if (payload.sessionId === state.sessionId) {
      handleSessionEvent(S.isRecord(payload.event) ? payload.event : {})
    }
  }
  pendingFrames.length = 0
  setStatus('运行中…', 'running')
}

// ---- 退出 ----

let exitArmedAt = 0

function bindExitEvents(): void {
  exitArmedAt = Date.now() + 1500
  const exit = (): void => {
    if (Date.now() < exitArmedAt) return
    // 调试/演示钩子:window.__SS_KEEP_OPEN__ = true 时保持打开。
    const keepOpen = (window as unknown as { __SS_KEEP_OPEN__?: boolean }).__SS_KEEP_OPEN__ === true
    if (keepOpen) return
    void API.screensaver.deactivate()
  }
  window.addEventListener('keydown', exit, { passive: true })
  window.addEventListener('mousemove', exit, { passive: true })
  window.addEventListener('mousedown', exit, { passive: true })
  window.addEventListener('wheel', exit, { passive: true })
}
boot()

})()
