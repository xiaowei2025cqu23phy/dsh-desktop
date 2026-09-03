/**
 * DSH Remote PWA:DeepSeek Harness 手机遥控。
 * 布局参考 DeepSeek App:左侧抽屉(工作区 ⇄ 会话)+ 聊天主界面。
 */
(function () {
  'use strict'

  // 宽松类型起步:$ 返回 any,后续逐步收紧为按元素类型的泛型。
  var $ = function (id: string): any { return document.getElementById(id) }

  var state = {
    server: '',
    token: '',
    connected: false,
    sessionId: null,
    lastSeq: 0,
    msgLog: [],           // [{ kind: 'user'|'assistant'|'tool'|'system', text, images? }]
    es: null,
    workspaces: [],       // [{ workspaceId, path, title, sessions: [] }]
    presetRoots: [],      // [{ path, name }] 预设工作区根(可直接作为工作区)
    currentWsId: null,
    currentWsPath: null,
    currentWsRoot: null,  // 当前选中的预设根(作为工作区使用)
    running: false,
    stickBottom: true,     // 流式输出时吸底;用户上滑查看历史后暂停
    tempCache: localStorage.getItem('dsh-temp-cache') === '1',
    approvals: {},        // sessionId -> [{ rpcId, sessionId, approvalId, toolName, reason }]
    approvalCards: {},    // `${sessionId}:${approvalId}` -> DOM 元素
    questions: {},        // sessionId -> { rpcId, sessionId, questions }
    questionCards: {},    // sessionId -> DOM 元素
    fsPath: '',           // 文件夹浏览当前路径('' = 根列表)
    fsParent: '',          // 当前允许范围内的父目录('' = 返回根列表)
    fsPreviewText: '',     // 当前文件预览已加载的原文
    defaultModel: null,   // { provider, model } 桌面端预设模型(host.describe)
    deviceId: localStorage.getItem('dsh-device-id') || (function () {
      // crypto.randomUUID 仅在安全上下文(HTTPS/localhost)可用;局域网 HTTP 需降级。
      var id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
      localStorage.setItem('dsh-device-id', id)
      return id
    })(),
    sidebarOpen: false,   // 左侧抽屉开关状态
  }

  var S = {
    isRecord: function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v) },
    /** 从内容块提取文本与图片(排除思维链/推理块,对话里只显示答案)。 */
    blocksParts: function (blocks) {
      var text = ''
      var images = []
      if (Array.isArray(blocks)) {
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i]
          if (!S.isRecord(b)) continue
          // 推理/思维链块不显示(不占屏),仅保留文本与图片。
          if (b.type === 'reasoning' || b.type === 'thinking' || b.type === 'reasoning-text') continue
          var innerText = ''
          if (typeof b.text === 'string') innerText = b.text
          else if (typeof b.content === 'string') innerText = b.content
          else if (Array.isArray(b.content)) {
            var inner = S.blocksParts(b.content)
            innerText = inner.text
            for (var k = 0; k < inner.images.length; k++) images.push(inner.images[k])
          }
          if (innerText !== '') text += (text === '' ? '' : '\n') + innerText
          if (b.type === 'image') {
            if (S.isRecord(b.attachment) && typeof b.attachment.attachmentId === 'string') {
              images.push({
                attachmentId: b.attachment.attachmentId,
                mediaType: typeof b.attachment.mediaType === 'string' ? b.attachment.mediaType : 'image/png',
                name: typeof b.attachment.name === 'string' ? b.attachment.name : '',
              })
            } else if (typeof b.data === 'string' && b.data !== '') {
              images.push({ dataUrl: b.data.indexOf('data:') === 0 ? b.data : 'data:image/png;base64,' + b.data })
            }
          }
        }
      }
      return { text: text, images: images }
    },
    escapeHtml: function (t) {
      return String(t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    },
    toast: function (msg, kind) {
      var host = $('toast-host')
      var el = document.createElement('div')
      el.className = 'toast ' + (kind === 'error' ? 'toast-error' : kind === 'ok' ? 'toast-ok' : '')
      el.textContent = msg
      host.appendChild(el)
      setTimeout(function () {
        el.classList.add('toast-hide')
        setTimeout(function () { el.remove() }, 300)
      }, 3200)
    },
  }

  // ---- API ----
  function apiRpc(method: string, payload?: unknown): Promise<any> {
    return fetch(state.server + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId, 'x-dsh-device-label': navigator.userAgent.slice(0, 60) },
      body: JSON.stringify({ method: method, payload: payload || {} }),
    }).then(function (res) {
      if (res.status === 428) throw new Error('等待桌面端批准此设备')
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
  function apiRespond(rpcId, result) {
    return fetch(state.server + '/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId, 'x-dsh-device-label': navigator.userAgent.slice(0, 60) },
      body: JSON.stringify({ type: 'client-response', rpcId: rpcId, result: result }),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    })
  }

  /** 控制动作(白名单,桌面端执行;用于预设工作区目录等)。 */
  function apiAction(action: string, extra?: Record<string, unknown>): Promise<any> {
    return fetch(state.server + '/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId, 'x-dsh-device-label': navigator.userAgent.slice(0, 60) },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})),
    }).then(function (res) {
      return res.json()
    }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'action failed')
      return data
    })
  }

  // ---- 本机临时会话缓存 ----
  function cacheKey(sid) { return 'dsh-cache-' + sid }

  /** 缓存上限:只保留最近 N 条,避免 localStorage 越写越慢、越占越大。 */
  var CACHE_MAX_MSGS = 300
  var cacheTimer: ReturnType<typeof setTimeout> | null = null

  function loadCachedMessages(sid) {
    try {
      var raw = localStorage.getItem(cacheKey(sid))
      return raw ? JSON.parse(raw) : null
    } catch (e) { return null }
  }

  /** 防抖持久化:事件密集(流式输出)时合并写入,手机端明显更跟手。 */
  function persistCache() {
    if (!state.tempCache || state.sessionId === null) return
    if (cacheTimer !== null) return
    cacheTimer = setTimeout(function () {
      cacheTimer = null
      try {
        var log = state.msgLog
        if (log.length > CACHE_MAX_MSGS) log = log.slice(log.length - CACHE_MAX_MSGS)
        localStorage.setItem(cacheKey(state.sessionId), JSON.stringify(log))
      } catch (e) { /* 存储满/配额不足忽略 */ }
    }, 600)
  }

  /** 离开会话/卸载时立即落盘(不等防抖窗口)。 */
  function flushCacheNow() {
    if (cacheTimer !== null) {
      clearTimeout(cacheTimer)
      cacheTimer = null
    }
    if (!state.tempCache || state.sessionId === null) return
    try {
      var log = state.msgLog
      if (log.length > CACHE_MAX_MSGS) log = log.slice(log.length - CACHE_MAX_MSGS)
      localStorage.setItem(cacheKey(state.sessionId), JSON.stringify(log))
    } catch (e) { /* 忽略 */ }
  }

  function clearAllCache() {
    var keys = []
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i)
      if (k && k.indexOf('dsh-cache-') === 0) keys.push(k)
    }
    keys.forEach(function (k) { localStorage.removeItem(k) })
  }

  // ---- 消息渲染 ----
  function hideEmpty(hide) { $('chat-empty').classList.toggle('hidden', hide) }

  function clearChat() {
    state.msgLog = []
    state.lastSeq = 0
    $('chat-stream').querySelectorAll('.msg').forEach(function (el) { el.remove() })
    $('chat-stream').querySelectorAll('.interaction-card').forEach(function (el) { el.remove() })
    state.approvalCards = {}
    state.questionCards = {}
    $('btn-chat-export').classList.add('hidden')
    $('btn-chat-model').classList.add('hidden')
    hideEmpty(false)
  }

  /** 把图片(附件 id 或内嵌 dataURL)渲染进消息元素。 */
  function renderImagesInto(el, images, stream) {
    for (var i = 0; i < images.length; i++) {
      (function (img) {
        var box = document.createElement('div')
        box.className = 'msg-image'
        var im = document.createElement('img')
        im.alt = img.name || '图片'
        im.loading = 'lazy'
        im.decoding = 'async'
        if (img.dataUrl) {
          im.src = img.dataUrl
          box.appendChild(im)
          el.appendChild(box)
          scrollToBottom()
          return
        }
        if (!img.attachmentId) return
        apiRpc('session.attachment', { attachmentId: img.attachmentId }).then(function (res) {
          if (res && typeof res.data === 'string' && res.data !== '') {
            im.src = 'data:' + (img.mediaType || 'image/png') + ';base64,' + res.data
            box.appendChild(im)
          } else {
            box.textContent = '图片:' + (img.name || img.attachmentId) + '(空内容)'
          }
          el.appendChild(box)
          scrollToBottom()
        }).catch(function () {
          box.textContent = '图片:' + (img.name || img.attachmentId) + '(加载失败)'
          el.appendChild(box)
        })
      })(images[i])
    }
  }

  // ---- 滚动:吸底模式(用户上滑查看历史时不再强制拉回底部) ----
  function scrollToBottom(): void {
    if (!state.stickBottom) return
    var stream = $('chat-stream')
    stream.scrollTop = stream.scrollHeight
  }

  /** 用户滚到离底部 80px 内 = 恢复吸底;否则暂停吸底。 */
  function bindScrollStick(): void {
    var stream = $('chat-stream')
    stream.addEventListener('scroll', function () {
      state.stickBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80
    })
  }

  function appendMessage(kind, text, images) {
    var stream = $('chat-stream')
    hideEmpty(true)
    var el = document.createElement('div')
    el.className = 'msg msg-' + kind
    // 始终创建文本节点(即使为空):流式增量/收尾通过 _textNode 更新,
    // 不依赖 lastChild(图片节点会占据它)。
    var textNode = document.createTextNode(text)
    el.appendChild(textNode)
    ;(el as any)._textNode = textNode
    stream.appendChild(el)
    var entry: any = { kind: kind, text: text }
    if (images && images.length > 0) {
      entry.images = images
      renderImagesInto(el, images, stream)
    }
    state.msgLog.push(entry)
    scrollToBottom()
    return el
  }

  function appendTool(name, args, failed) {
    var stream = $('chat-stream')
    hideEmpty(true)
    var el = document.createElement('div')
    el.className = 'msg msg-tool'
    // 折叠态:一行标题+参数摘要,点击展开完整参数(不霸屏)。
    var argBrief = typeof args === 'string' && args.trim() !== '' ? ' ' + String(args).trim().replace(/\s+/g, ' ').slice(0, 70) : ''
    el.innerHTML = '<span class="tool-name">' + S.escapeHtml(name) + '</span>' +
      '<span class="tool-state">调用中…</span>' +
      '<span class="tool-arg">' + S.escapeHtml(argBrief) + '</span>' +
      '<pre class="tool-args" style="display:none">' + S.escapeHtml(String(args || '').slice(0, 4000)) + '</pre>'
    ;(el as any)._stateEl = el.querySelector('.tool-state')
    ;(el as any)._argsEl = el.querySelector('.tool-args')
    el.addEventListener('click', function () {
      var a = (el as any)._argsEl
      if (a) a.style.display = a.style.display === 'none' ? 'block' : 'none'
    })
    stream.appendChild(el)
    state.msgLog.push({ kind: 'tool', text: name + ' 调用中' })
    scrollToBottom()
    return el
  }

  function markLastTool(failed) {
    var els = $('chat-stream').querySelectorAll('.msg-tool')
    for (var i = els.length - 1; i >= 0; i--) {
      var el = els[i]
      if (el._stateEl && el._stateEl.textContent === '调用中…') {
        el._stateEl.textContent = failed ? '失败' : '完成'
        el._stateEl.className = 'tool-state ' + (failed ? 'fail' : 'done')
        if (state.msgLog[state.msgLog.length - 1] && state.msgLog[state.msgLog.length - 1].kind === 'tool') {
          state.msgLog[state.msgLog.length - 1].text = state.msgLog[state.msgLog.length - 1].text.replace('调用中', failed ? '失败' : '完成')
        }
        persistCache()
        return
      }
    }
  }

  function lastAssistantEl() {
    var els = $('chat-stream').querySelectorAll('.msg-assistant')
    return els.length > 0 ? els[els.length - 1] : null
  }

  function appendDelta(delta) {
    var last = state.msgLog[state.msgLog.length - 1]
    if (!last || last.kind !== 'assistant') {
      appendMessage('assistant', '', undefined)
      last = state.msgLog[state.msgLog.length - 1]
    }
    last.text += delta
    var el = lastAssistantEl()
    if (el) {
      ;(el as any)._textNode.textContent = last.text
      el.classList.add('cursor-blink')
    }
    scrollToBottom()
  }

  function replaceLastAssistant(full) {
    var last = state.msgLog[state.msgLog.length - 1]
    if (!last || last.kind !== 'assistant') {
      appendMessage('assistant', full, undefined)
      return
    }
    last.text = full
    var el = lastAssistantEl()
    if (el) {
      ;(el as any)._textNode.textContent = full
      el.classList.remove('cursor-blink')
    }
    persistCache()
    scrollToBottom()
  }

  function renderCachedMessage(m) {
    if (!m || typeof m.text !== 'string') return
    if (m.kind === 'tool') {
      var stream = $('chat-stream')
      hideEmpty(true)
      var el = document.createElement('div')
      el.className = 'msg msg-tool'
      el.textContent = m.text
      stream.appendChild(el)
      if (Array.isArray(m.images) && m.images.length > 0) renderImagesInto(el, m.images, stream)
      scrollToBottom()
      return
    }
    appendMessage(m.kind === 'user' ? 'user' : 'assistant', m.text,
      Array.isArray(m.images) ? m.images : undefined)
  }

  function setChatStatus(text, cls) {
    var el = $('chat-status')
    el.textContent = text
    el.className = 'chat-status' + (cls === 'running' ? ' running' : '')
    state.running = cls === 'running'
    $('btn-chat-stop').classList.toggle('hidden', !state.running)
    $('btn-chat-stop').disabled = false
    updateSteerButton()
  }

  /** 导出当前会话为 Markdown 并下载。 */
  function exportSession() {
    if (state.sessionId === null) return
    apiAction('session.export', { sessionId: state.sessionId }).then(function (data) {
      var blob = new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' })
      var url = URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = 'session-' + state.sessionId.slice(0, 12) + '.md'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      S.toast('已导出 ' + (data.count || 0) + ' 条消息', 'ok')
    }).catch(function (err) {
      S.toast('导出失败:' + err.message, 'error')
    })
  }

  /** 运行中显示「插入」按钮:可打断当前等待,插入新指令。 */
  function updateSteerButton() {
    $('btn-chat-steer').classList.toggle('hidden', !(state.running && state.sessionId !== null))
  }

  function setConnDot(on) {
    $('conn-dot').className = 'conn-dot ' + (on ? 'on' : 'off')
  }

  // ---- 事件流(一次性票:断线必须重新取票,否则审批/提问永远收不到) ----
  var esDelay = 1000
  var esAttempts = 0
  var reconnectTimer: ReturnType<typeof setTimeout> | null = null
  var eventsGeneration = 0
  var eventsWasDisconnected = false
  function scheduleEventsReconnect(generation) {
    if (generation !== eventsGeneration || reconnectTimer !== null) return
    setConnDot(false)
    esAttempts += 1
    if (esAttempts === 2) {
      // 远程访问启用 2 小时后会自动关闭,这是"连不上"最常见的原因;
      // 静默重试会让用户以为网络坏了,给一次明确提示。
      setChatStatus('连接中断,自动重连中…若长时间未恢复,请在电脑端「设置 → 远程访问」重新启用', 'err')
      S.toast('连接中断:若长时间未恢复,请在电脑端重新启用远程访问(启用 2 小时后会自动关闭)', 'error')
    }
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null
      connectEvents()
    }, esDelay)
    esDelay = Math.min(esDelay * 2, 15000)
  }
  function connectEvents() {
    var generation = ++eventsGeneration
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (state.es) {
      try { state.es.close() } catch (e) { /* 忽略 */ }
      state.es = null
    }
    fetch(state.server + '/api/events/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId, 'x-dsh-device-label': navigator.userAgent.slice(0, 60) },
      body: '{}',
    }).then(function (res) { return res.json() }).then(function (data) {
      if (generation !== eventsGeneration) return
      if (!data.ok || typeof data.ticket !== 'string') {
        scheduleEventsReconnect(generation)
        return
      }
      var es = new EventSource(state.server + '/api/events?ticket=' + encodeURIComponent(data.ticket))
      state.es = es
      es.onopen = function () {
        if (generation !== eventsGeneration) return
        setConnDot(true)
        esDelay = 1000
        esAttempts = 0
        if (eventsWasDisconnected && state.sessionId !== null) {
          // SSE has no replay cursor; reload the current session after a
          // successful reconnect so events missed during the outage are not
          // silently omitted from the phone transcript.
          openSession(state.sessionId, state.currentWsPath)
        }
        eventsWasDisconnected = false
      }
      es.onerror = function () {
        if (generation !== eventsGeneration) return
        eventsWasDisconnected = true
        try { es.close() } catch (e) { /* 忽略 */ }
        if (state.es === es) state.es = null
        scheduleEventsReconnect(generation)
      }
      es.onmessage = function (event) {
        if (generation !== eventsGeneration) return
        var frame
        try { frame = JSON.parse(event.data) } catch (e) { return }
        handleFrame(frame)
      }
    }).catch(function () {
      if (generation === eventsGeneration) {
        eventsWasDisconnected = true
        scheduleEventsReconnect(generation)
      }
    })
  }

  function handleFrame(frame) {
    if (!frame || !S.isRecord(frame)) return
    if (frame.method === 'approval/requested' || frame.method === 'approval/resolved') {
      handleApprovalFrame(frame)
      return
    }
    if (frame.method === 'question/requested' || frame.method === 'question/resolved') {
      handleQuestionFrame(frame)
      return
    }
    if (frame.method !== 'session/event') return
    var payload = frame.payload
    if (!S.isRecord(payload)) return
    if (state.sessionId !== null && payload.sessionId !== state.sessionId) return
    var event = payload.event
    if (!S.isRecord(event)) return
    if (typeof event.seq === 'number') {
      if (event.seq <= state.lastSeq) return
      state.lastSeq = event.seq
    }
    var data = S.isRecord(event.data) ? event.data : {}
    switch (event.type) {
      case 'turn/start':
        setChatStatus('运行中…', 'running')
        break
      case 'turn/end':
        setChatStatus('空闲', '')
        persistCache()
        break
      case 'user/message': {
        var parts = S.blocksParts(data.content)
        if (parts.text.trim() !== '' || parts.images.length > 0) appendMessage('user', parts.text, parts.images)
        persistCache()
        break
      }
      case 'assistant/chunk': {
        var chunk = S.isRecord(data.chunk) ? data.chunk : {}
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          appendDelta(chunk.text)
        } else if (chunk.type === 'finish') {
          setChatStatus('空闲', '')
        }
        break
      }
      case 'assistant/message': {
        var parts = S.blocksParts(S.isRecord(data.message) ? data.message.content : undefined)
        if (parts.text !== '') replaceLastAssistant(parts.text)
        if (parts.images.length > 0) {
          var aes: any = $('chat-stream').querySelectorAll('.msg-assistant')
          var targetEl = aes.length > 0 ? aes[aes.length - 1] : null
          if (targetEl) {
            renderImagesInto(targetEl, parts.images, $('chat-stream'))
            var lastA = state.msgLog[state.msgLog.length - 1]
            if (lastA && lastA.kind === 'assistant') lastA.images = (lastA.images || []).concat(parts.images)
          }
        }
        persistCache()
        break
      }
      case 'tool/call': {
        appendTool(data.name || '工具', typeof data.arguments === 'string' ? pretty(data.arguments) : '', false)
        break
      }
      case 'tool/result': {
        markLastTool(data.error !== undefined)
        var tp = S.blocksParts(S.isRecord(data.message) ? data.message.content : undefined)
        if (tp.images.length > 0) {
          var tools: any = $('chat-stream').querySelectorAll('.msg-tool')
          var toolEl = tools.length > 0 ? tools[tools.length - 1] : null
          if (toolEl) {
            renderImagesInto(toolEl, tp.images, $('chat-stream'))
            var lastT = state.msgLog[state.msgLog.length - 1]
            if (lastT && lastT.kind === 'tool') lastT.images = (lastT.images || []).concat(tp.images)
          }
        }
        persistCache()
        break
      }
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') {
          $('chat-title').textContent = data.title.trim()
        }
        break
      }
      default:
        break
    }
  }

  function pretty(raw) {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch (e) { return raw }
  }

  // ---- 审批 / 提问卡片 ----
  function handleApprovalFrame(frame) {
    var payload = S.isRecord(frame.payload) ? frame.payload : {}
    var sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return
    if (frame.method === 'approval/requested') {
      var item = {
        rpcId: frame.rpcId,
        sessionId: sessionId,
        approvalId: String(payload.approvalId || ''),
        toolName: String(payload.toolName || '工具'),
        reason: typeof payload.reason === 'string' ? payload.reason : '',
      }
      if (!Array.isArray(state.approvals[sessionId])) state.approvals[sessionId] = []
      state.approvals[sessionId].push(item)
      if (state.sessionId === sessionId) renderApprovalCard(item)
      else S.toast('会话 ' + sessionId + ' 需要审批', 'error')
    } else {
      var approvalId = String(payload.approvalId || '')
      var key = sessionId + ':' + approvalId
      var cardEl = state.approvalCards[key]
      if (cardEl) {
        cardEl.remove()
        delete state.approvalCards[key]
      }
      var list = state.approvals[sessionId]
      if (Array.isArray(list)) {
        state.approvals[sessionId] = list.filter(function (a) { return String(a.approvalId) !== approvalId })
      }
    }
  }

  function renderApprovalCard(item) {
    var stream = $('chat-stream')
    hideEmpty(true)
    var card = document.createElement('div')
    card.className = 'interaction-card approval-card'
    var html = '<div class="interaction-title">⚠️ 需要审批</div>' +
      '<div class="interaction-tool">工具:' + S.escapeHtml(item.toolName) + '</div>' +
      '<div class="interaction-reason">' + S.escapeHtml(item.reason || '') + '</div>' +
      '<div class="interaction-actions">' +
      '<button class="btn btn-allow">允许</button>' +
      '<button class="btn btn-deny">拒绝</button></div>'
    card.innerHTML = html
    card.querySelector('.btn-allow').addEventListener('click', function () {
      respondApproval(item, 'allowed-once', card)
    })
    card.querySelector('.btn-deny').addEventListener('click', function () {
      respondApproval(item, 'rejected', card)
    })
    stream.appendChild(card)
    state.approvalCards[item.sessionId + ':' + item.approvalId] = card
    scrollToBottom()
  }

  function respondApproval(item, outcome, card) {
    var buttons = card.querySelectorAll('button')
    buttons.forEach(function (b) { b.disabled = true })
    apiRespond(item.rpcId, {
      ok: true,
      value: { sessionId: item.sessionId, approvalId: item.approvalId, outcome: outcome },
    }).then(function (receipt) {
      if (!receipt || receipt.accepted !== true) {
        buttons.forEach(function (b) { b.disabled = false })
        S.toast('应答未被接受:' + ((receipt && receipt.reason) || '未知原因'), 'error')
        return
      }
      card.classList.add('done')
      card.innerHTML = outcome === 'allowed-once' ? '✓ 已允许' : '✗ 已拒绝'
      delete state.approvalCards[item.sessionId + ':' + item.approvalId]
      S.toast(outcome === 'allowed-once' ? '已允许' : '已拒绝', 'ok')
    }).catch(function (err) {
      buttons.forEach(function (b) { b.disabled = false })
      S.toast('应答失败:' + err.message, 'error')
    })
  }

  function handleQuestionFrame(frame) {
    var payload = S.isRecord(frame.payload) ? frame.payload : {}
    var sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return
    if (frame.method === 'question/requested') {
      if (!Array.isArray(payload.questions) || payload.questions.length === 0) return
      state.questions[sessionId] = { rpcId: frame.rpcId, sessionId: sessionId, questions: payload.questions }
      if (state.sessionId === sessionId) renderQuestionCard(state.questions[sessionId])
      else S.toast('会话 ' + sessionId + ' 需要你回答', 'error')
    } else {
      var cardEl = state.questionCards[sessionId]
      if (cardEl) {
        cardEl.remove()
        delete state.questionCards[sessionId]
      }
      delete state.questions[sessionId]
    }
  }

  function renderQuestionCard(pending) {
    var stream = $('chat-stream')
    hideEmpty(true)
    var card = document.createElement('div')
    card.className = 'interaction-card question-card'
    var html = '<div class="interaction-title">❓ 需要你回答</div>'
    pending.questions.forEach(function (q, i) {
      var multi = q.multiSelect ? ' <span class="q-multi">(多选)</span>' : ''
      html += '<div class="q-item">' +
        '<div class="q-text">' + (pending.questions.length > 1 ? '#' + (i + 1) + ' ' : '') + S.escapeHtml(q.question) + multi + '</div>' +
        (typeof q.detail === 'string' && q.detail !== '' ? '<div class="q-detail">' + S.escapeHtml(q.detail) + '</div>' : '')
      if (Array.isArray(q.options) && q.options.length > 0) {
        q.options.forEach(function (opt, j) {
          var desc = (opt && typeof opt.description === 'string' && opt.description !== '') ? '<span class="q-desc"> — ' + S.escapeHtml(opt.description) + '</span>' : ''
          html += '<label class="q-opt"><input type="' + (q.multiSelect ? 'checkbox' : 'radio') + '" name="q-' + i + '" value="' + j + '">' +
            S.escapeHtml(opt.label) + desc + '</label>'
        })
      } else {
        html += '<div class="q-none">(无选项,请在下方填写)</div>'
      }
      html += '</div>'
    })
    html += '<div class="q-custom-row"><input class="q-custom" placeholder="补充说明(可选)"></div>' +
      '<div class="interaction-actions"><button class="btn btn-submit">提交回答</button></div>'
    card.innerHTML = html
    card.querySelector('.btn-submit').addEventListener('click', function () { submitQuestion(pending, card) })
    stream.appendChild(card)
    state.questionCards[pending.sessionId] = card
    scrollToBottom()
  }

  function submitQuestion(pending, card) {
    var answers = pending.questions.map(function (q, i) {
      var inputs = card.querySelectorAll('input[name="q-' + i + '"]')
      var selected = []
      var hasOptions = inputs.length > 0
      if (hasOptions && q.multiSelect) {
        inputs.forEach(function (input) { if (input.checked) selected.push(q.options[Number(input.value)].label) })
      } else if (hasOptions) {
        for (var k = 0; k < inputs.length; k++) {
          if (inputs[k].checked) { selected.push(q.options[Number(inputs[k].value)].label); break }
        }
      }
      var customInput = card.querySelector('.q-custom')
      var custom = customInput && customInput.value.trim() !== '' ? customInput.value.trim() : undefined
      if (custom !== undefined && !q.multiSelect) return { id: q.id, selected: [], custom: custom }
      return { id: q.id, selected: selected, custom: custom }
    })
    for (var i = 0; i < answers.length; i++) {
      if (answers[i].selected.length === 0 && !answers[i].custom) {
        S.toast('请回答每个问题(未答的给「补充说明」)', 'error')
        return
      }
    }
    var button = card.querySelector('.btn-submit')
    button.disabled = true
    apiRespond(pending.rpcId, {
      ok: true,
      value: { sessionId: pending.sessionId, answer: { answers: answers } },
    }).then(function (receipt) {
      if (!receipt || receipt.accepted !== true) {
        button.disabled = false
        S.toast('回答未被接受:' + ((receipt && receipt.reason) || '未知原因'), 'error')
        return
      }
      card.classList.add('done')
      card.innerHTML = '✓ 已提交回答(' + answers.length + ' 个问题)'
      delete state.questionCards[pending.sessionId]
      delete state.questions[pending.sessionId]
      S.toast('已提交回答', 'ok')
    }).catch(function (err) {
      button.disabled = false
      S.toast('提交失败:' + err.message, 'error')
    })
  }

  /** 打开会话时重绘该会话未决的审批/提问卡片。 */
  function renderPendingCards(sessionId) {
    var approvals = state.approvals[sessionId]
    if (Array.isArray(approvals)) {
      approvals.forEach(function (item) { renderApprovalCard(item) })
    }
    var pending = state.questions[sessionId]
    if (pending) renderQuestionCard(pending)
  }

  // ---- 会话 ----
  function openSession(sessionId, cwd) {
    // 切换会话前,把上一个会话的缓存立即落盘(防抖窗口内的增量不丢、不串会话)。
    if (state.sessionId !== null && state.sessionId !== sessionId) flushCacheNow()
    state.sessionId = sessionId
    state.currentWsPath = cwd || state.currentWsPath
    state.currentWsId = findWorkspaceId(state.currentWsPath)
    state.currentWsRoot = null
    if (state.currentWsId === null) {
      for (var i = 0; i < state.presetRoots.length; i++) {
        if (state.presetRoots[i].path === state.currentWsPath) state.currentWsRoot = state.currentWsPath
      }
    }
    clearChat()
    $('btn-chat-model').classList.remove('hidden')
    $('chat-title').textContent = '会话'
    setChatStatus('加载中…', '')
    closeSidebar()
    markCurrentRow(sessionId)

    var cached = loadCachedMessages(sessionId)
    if (cached && cached.length > 0) {
      cached.forEach(renderCachedMessage)
      setChatStatus('已加载(本机缓存)', '')
    }

    // 历史加载带重试:桌面端服务重启/网关瞬时不可达时自动再试,避免一失败就停留在错误态。
    var loadHistory = function (attempt: number): void {
      apiRpc('session.history', { sessionId: sessionId, maxMessages: 40 }).then(function (data) {
        state.lastSeq = 0
        state.msgLog = []
        $('chat-stream').querySelectorAll('.msg').forEach(function (el) { el.remove() })
        hideEmpty(false)
        var events = data.events || []
        events.forEach(function (entry) {
          var ev = entry && S.isRecord(entry.event) ? entry.event : entry
          handleFrame({ method: 'session/event', payload: { sessionId: sessionId, event: ev } })
        })
        setChatStatus(state.msgLog.length > 0 ? '已加载' : '空会话', '')
        $('btn-chat-export').classList.remove('hidden')
        persistCache()
        // 恢复该会话未决的审批/提问卡片(切回会话时仍可应答)
        renderPendingCards(sessionId)
      }).catch(function (err) {
        // 诊断上报:把浏览器侧的真实错误送回桌面端审计(本地排查用,不打扰用户)。
        try {
          fetch(state.server + '/api/diag', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId },
            body: JSON.stringify({ error: String((err && err.message) || err), sessionId: sessionId }),
          }).catch(function () { })
        } catch (_e) { /* 上报失败忽略 */ }
        if (attempt < 2) {
          setChatStatus('加载中(重试)…', '')
          setTimeout(function () { loadHistory(attempt + 1) }, 2500)
          return
        }
        setChatStatus('加载失败:' + err.message, '')
        S.toast('加载历史失败:' + err.message, 'error')
      })
    }
    loadHistory(0)
  }

  function newSession() {
    var payload: Record<string, unknown> = {}
    if (state.currentWsId) payload.workspaceId = state.currentWsId
    else if (state.currentWsRoot) payload.cwd = state.currentWsRoot
    var permission = $('session-permission') ? $('session-permission').value : ''
    apiRpc('session.create', payload).then(function (created) {
      var sessionId = created.sessionId
      openSession(sessionId, state.currentWsPath)
      loadSidebar()
      if (permission === '') return
      // 权限预设是可用性增强:命令失败(旧版 harness 无 /permission)时
      // 会话仍已打开,只提示未生效,绝不让「建了会话却用不了」。
      executeCommand(sessionId, '/permission ' + permission).catch(function (err) {
        S.toast('权限未生效:' + err.message, 'error')
      })
    }).catch(function (err) {
      S.toast('新建会话失败:' + err.message, 'error')
    })
  }

  /** 新对话工作区选择:先选工作区/预设根,再创建对话(与 harness Web 一致)。 */
  function openNewsessSheet() {
    openSheet($('view-newsess'))
    var select = $('newsess-workspace') as HTMLSelectElement
    var status = $('newsess-status')
    status.textContent = '加载工作区…'
    select.innerHTML = ''
    Promise.all([
      apiRpc('workspace.list', {}).catch(function () { return { items: [] } }),
      apiAction('fs.list', { path: '' }).then(function (d) { return d.roots || [] }).catch(function () { return [] }),
    ]).then(function (results) {
      var workspaces = results[0].items || []
      var roots = results[1].filter(function (r) { return r.isPreset })
      var opt0 = document.createElement('option')
      opt0.value = ''
      opt0.textContent = '(默认目录)'
      select.appendChild(opt0)
      workspaces.forEach(function (ws) {
        var o = document.createElement('option')
        o.value = 'ws:' + ws.workspaceId
        o.setAttribute('data-path', ws.path)
        o.textContent = '📂 ' + (ws.title || ws.path)
        select.appendChild(o)
      })
      roots.forEach(function (root) {
        var o = document.createElement('option')
        o.value = 'root:' + root.path
        o.textContent = '📁 预设根:' + (root.name || root.path)
        select.appendChild(o)
      })
      var selected = ''
      if (state.currentWsId) selected = 'ws:' + state.currentWsId
      else if (state.currentWsRoot) selected = 'root:' + state.currentWsRoot
      if (selected !== '') select.value = selected
      status.textContent = (workspaces.length === 0 && roots.length === 0)
        ? '还没有工作区,先点下方「新建工作区」'
        : ''
    }).catch(function (err) {
      status.textContent = '加载失败:' + err.message
    })
  }

  /** 从新对话工作区选择结果创建会话。 */
  function createFromNewsess() {
    var select = $('newsess-workspace') as HTMLSelectElement
    var option = select.options[select.selectedIndex] as HTMLOptionElement | null
    var value = option ? option.value : ''
    state.currentWsId = null
    state.currentWsRoot = null
    state.currentWsPath = null
    if (value.indexOf('ws:') === 0) {
      var wsId = value.slice(3)
      state.currentWsId = wsId
      var path = option ? option.getAttribute('data-path') || '' : ''
      if (path !== '') state.currentWsPath = path
    } else if (value.indexOf('root:') === 0) {
      var rootPath = value.slice(5)
      state.currentWsRoot = rootPath
      state.currentWsPath = rootPath
    }
    closeSheet($('view-newsess'))
    newSession()
  }

  function sendMessage(mode) {
    var input = $('chat-input')
    var text = input.value.trim()
    mode = mode || selectedSendMode()
    if (text === '' || state.sessionId === null) {
      if (state.sessionId === null) S.toast('请先新建或选择一个会话', 'error')
      return
    }
    input.value = ''
    apiRpc('session.prompt', {
      sessionId: state.sessionId,
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text: text }],
    }).then(function () {
      setChatStatus(mode === 'steer' ? '已插入(打断当前等待)…' : '运行中…', 'running')
      if (mode === 'steer') appendMessage('user', text, undefined)
    }).catch(function (err) {
      S.toast('发送失败:' + err.message, 'error')
      input.value = text
    })
  }

  // ---- 侧边栏 ----
  function openSidebar() {
    state.sidebarOpen = true
    $('sidebar').classList.remove('hidden')
    $('sidebar-backdrop').classList.remove('hidden')
    loadSidebar()
  }

  function closeSidebar() {
    state.sidebarOpen = false
    $('sidebar').classList.add('hidden')
    $('sidebar-backdrop').classList.add('hidden')
  }

  function findWorkspaceId(path) {
    if (!path) return null
    for (var i = 0; i < state.workspaces.length; i++) {
      if (state.workspaces[i].path === path) return state.workspaces[i].workspaceId
    }
    return null
  }

  /** Normalize a path for grouping: strip trailing separators and, on
   *  Windows, fold the case (a session cwd and a workspace path can differ
   *  in case or trailing slash yet be the same directory). */
  function groupKey(path) {
    if (!path) return ''
    var p = String(path).replace(/[\\/]+$/, '')
    return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p
  }

  /** Make a clicked workspace the explicit target of the next new session. */
  function selectWorkspaceTarget(ws) {
    if (!ws || typeof ws.path !== 'string') return
    state.currentWsPath = ws.path
    state.currentWsId = typeof ws.workspaceId === 'string' ? ws.workspaceId : null
    state.currentWsRoot = state.currentWsId ? null : ws.path
  }

  /** Return the selected mode for the next ordinary composer submission. */
  function selectedSendMode() {
    var select = $('session-send-mode')
    return select && select.value === 'steer' ? 'steer' : 'queue'
  }

  /** Execute a slash command through the ordinary session prompt path. */
  function executeCommand(sessionId, line) {
    return apiRpc('session.prompt', {
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: line }],
    })
  }

  /** Set a preset root as the explicit cwd target for the next new session. */
  function selectPresetRootTarget(root) {
    if (!root || typeof root.path !== 'string') return
    state.currentWsPath = root.path
    state.currentWsId = null
    state.currentWsRoot = root.path
  }

  function loadSidebar() {
    var list = $('workspace-list')
    list.innerHTML = '<p class="empty">加载中…</p>'
    Promise.all([
      apiRpc('workspace.list', {}),
      apiRpc('session.list', {}),
      fetch(state.server + '/api/info?token=' + encodeURIComponent(state.token), { signal: AbortSignal.timeout(10000) }).then(function (r) { return r.json() }).catch(function () { return {} }),
      apiAction('fs.list', { path: '' }).then(function (d) { return d.roots || [] }).catch(function () { return [] }),
    ]).then(function (results) {
      var wsData = results[0]
      var sessData = results[1]
      var info = results[2] || {}
      var workspaces = wsData.items || []
      var presetRoots = results[3].filter(function (r) { return r.isPreset })
      state.presetRoots = presetRoots
      // 隐藏:子代理会话(origin)、未发生的空会话(blank)、已归档会话。
      var archivedIds = wsData.archivedSessionIds || []
      var archived = new Set(archivedIds)
      var sessions = (sessData.items || []).filter(function (s) {
        return !s.origin && !s.blank && !archived.has(s.sessionId)
      })
      // 已归档会话单独收进底部「已归档」分组,可一键恢复或打开查看。
      var archivedList = (sessData.items || []).filter(function (s) {
        return !s.origin && !s.blank && archived.has(s.sessionId)
      })
      archivedList.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      // 机器人通道的固定对话会话(QQ/Telegram 聊天)→ 置顶分组,手机直接看到。
      var botChatIds = new Set(info.chatSessionIds || [])
      var botChats = sessions.filter(function (s) { return botChatIds.has(s.sessionId) })
      // 未命名的机器人对话给出可读的占位名(否则满屏"新会话"分不清)。
      botChats.forEach(function (s) {
        if (!s.title) s.title = '机器人对话'
      })
      var rest = sessions.filter(function (s) { return !botChatIds.has(s.sessionId) })
      var byPath = {}
      workspaces.forEach(function (ws) {
        ws.sessions = []
        byPath[groupKey(ws.path)] = ws
      })
      presetRoots.forEach(function (root) { root.sessions = [] })
      var rootByPath = {}
      presetRoots.forEach(function (root) { rootByPath[groupKey(root.path)] = root })
      var unmatched = []
      rest.forEach(function (s) {
        var key = groupKey(s.cwd)
        if (key !== '') {
          // A session created in a preset root's descendant, or a cwd with a
          // differing case/trailing slash, still belongs to the matching
          // workspace; only true non-project sessions fall to "recent".
          var ws = byPath[key]
          if (ws) { ws.sessions.push(s); return }
          var root = rootByPath[key]
          if (root) { root.sessions.push(s); return }
          var inside = workspaces.find(function (w) { return key.indexOf(groupKey(w.path) + '\\') === 0 || key.indexOf(groupKey(w.path) + '/') === 0 })
          if (inside !== undefined) { inside.sessions.push(s); return }
          var insideRoot = presetRoots.find(function (r) { return key.indexOf(groupKey(r.path) + '\\') === 0 || key.indexOf(groupKey(r.path) + '/') === 0 })
          if (insideRoot !== undefined) { insideRoot.sessions.push(s); return }
        }
        unmatched.push(s)
      })
      state.workspaces = workspaces
      state.currentWsId = findWorkspaceId(state.currentWsPath) || state.currentWsId
      renderSidebar(unmatched, botChats, presetRoots, archivedList)
    }).catch(function (err) {
      list.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  function sessionTitle(s) {
    return (s.projections && s.projections.values && s.projections.values.title) || '新会话'
  }

  function renderSidebar(unmatched, botChats, presetRoots, archivedList) {
    var list = $('workspace-list')
    list.innerHTML = ''
    var frag = document.createDocumentFragment()
    // 机器人通道对话(QQ/Telegram 聊天)置顶,手机直接看到。
    if (botChats && botChats.length > 0) {
      frag.appendChild(wsGroupElement('🤖 机器人对话', null, botChats, true))
    }
    if (unmatched.length > 0) {
      frag.appendChild(wsGroupElement('最近', null, unmatched, true))
    }
    state.workspaces.forEach(function (ws, i) {
      frag.appendChild(wsGroupElement(ws.title || ws.path, ws, ws.sessions, unmatched.length === 0 && i === 0))
    })
    // 预设工作区根本身也可作为工作区(新建会话/任务直接落在根目录)。
    if (presetRoots && presetRoots.length > 0) {
      presetRoots.forEach(function (root, i) {
        frag.appendChild(presetRootGroupElement(root, unmatched.length === 0 && state.workspaces.length === 0 && i === 0))
      })
    }
    // 已归档会话:折叠分组,可恢复或打开查看(归档 = 只隐藏,日志仍在)。
    if (archivedList && archivedList.length > 0) {
      frag.appendChild(archivedGroupElement(archivedList))
    }
    if (state.workspaces.length === 0 && unmatched.length === 0 && (!presetRoots || presetRoots.length === 0) &&
        (!archivedList || archivedList.length === 0)) {
      var empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '还没有工作区,点上方「新建工作区」添加'
      frag.appendChild(empty)
    }
    list.appendChild(frag)
  }

  /** 底部「已归档」折叠分组:列出已归档会话,可一键恢复(或点开查看内容)。 */
  function archivedGroupElement(sessions) {
    var group = document.createElement('div')
    group.className = 'ws-group'
    var head = document.createElement('div')
    head.className = 'ws-item'
    var title = document.createElement('span')
    title.className = 'ws-name'
    title.textContent = '🗄 已归档'
    var count = document.createElement('span')
    count.className = 'ws-count'
    count.textContent = String(sessions.length)
    var arrow = document.createElement('span')
    arrow.className = 'ws-arrow'
    arrow.textContent = '›'
    head.appendChild(title)
    head.appendChild(count)
    head.appendChild(arrow)
    var body = document.createElement('div')
    body.className = 'ws-body'
    sessions.slice(0, 30).forEach(function (s) {
      var row = document.createElement('div')
      row.className = 'session-row'
      var t = document.createElement('span')
      t.className = 'session-title'
      t.textContent = sessionTitle(s)
      row.appendChild(t)
      var restore = document.createElement('button')
      restore.className = 'row-act'
      restore.textContent = '↩'
      restore.title = '恢复会话(重新显示在列表)'
      restore.addEventListener('click', function (event) {
        event.stopPropagation()
        restoreSession(s.sessionId)
      })
      row.appendChild(restore)
      row.addEventListener('click', function () { openSession(s.sessionId, s.cwd) })
      body.appendChild(row)
    })
    if (sessions.length > 30) {
      var more = document.createElement('p')
      more.className = 'empty'
      more.textContent = '…还有 ' + (sessions.length - 30) + ' 个(桌面端会话管理可查全部)'
      body.appendChild(more)
    }
    head.addEventListener('click', function () {
      var open = head.classList.toggle('open')
      body.classList.toggle('open', open)
    })
    group.appendChild(head)
    group.appendChild(body)
    return group
  }

  function sessionRowElement(s, cwd) {
    var row = document.createElement('div')
    row.className = 'session-row' + (s.sessionId === state.sessionId ? ' current' : '')
    ;(row as any)._sid = s.sessionId
    var t = document.createElement('span')
    t.className = 'session-title' + (s.blank ? ' blank' : '')
    t.textContent = sessionTitle(s)
    row.appendChild(t)
    if (s.running) {
      var b = document.createElement('span')
      b.className = 'session-badge'
      b.textContent = '运行中'
      row.appendChild(b)
    }
    var archive = document.createElement('button')
    archive.className = 'row-act'
    archive.textContent = '🗄'
    archive.title = '归档会话'
    archive.addEventListener('click', function (event) {
      event.stopPropagation()
      archiveSession(s.sessionId)
    })
    row.appendChild(archive)
    row.addEventListener('click', function () { openSession(s.sessionId, s.cwd || cwd) })
    return row
  }

  /** 预设工作区根组:根本身作为工作区使用(新建会话/浏览/移除)。 */
  function presetRootGroupElement(root, openDefault) {
    var group = document.createElement('div')
    group.className = 'ws-group'

    var head = document.createElement('div')
    head.className = 'ws-item' + (openDefault ? ' open' : '')
    var title = document.createElement('span')
    title.className = 'ws-name'
    title.textContent = '📁 ' + root.name
    var count = document.createElement('span')
    count.className = 'ws-count'
    count.textContent = String((root.sessions || []).length)
    var arrow = document.createElement('span')
    arrow.className = 'ws-arrow'
    arrow.textContent = '›'
    head.appendChild(title)
    head.appendChild(count)
    head.appendChild(arrow)
    var browse = document.createElement('button')
    browse.className = 'row-act'
    browse.textContent = '📂'
    browse.title = '浏览文件夹'
    browse.addEventListener('click', function (event) {
      event.stopPropagation()
      closeSidebar()
      openFsBrowser(root.path, null)
    })
    head.appendChild(browse)
    var del = document.createElement('button')
    del.className = 'row-act'
    del.textContent = '🔒'
    del.title = '移除预设根请在桌面端确认'
    del.disabled = true
    del.addEventListener('click', function (event) {
      event.stopPropagation()
      if (!window.confirm('移除预设根「' + root.path + '」？只移除注册,不会删除文件。')) return
      apiAction('fs.removeRoot', { path: root.path }).then(function () {
        S.toast('已移除预设根', 'ok')
        loadSidebar()
      }).catch(function (err) { S.toast('移除失败:' + err.message, 'error') })
    })
    head.appendChild(del)

    var body = document.createElement('div')
    body.className = 'ws-body' + (openDefault ? ' open' : '')
    ;(root.sessions || []).forEach(function (s) {
      body.appendChild(sessionRowElement(s, root.path))
    })
    if (!root.sessions || root.sessions.length === 0) {
      var empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '暂无会话'
      body.appendChild(empty)
    }
    var newBtn = document.createElement('button')
    newBtn.className = 'btn btn-block'
    newBtn.textContent = '＋ 在此新建会话'
    newBtn.title = '以该目录为工作目录新建会话'
    newBtn.addEventListener('click', function () {
      state.currentWsId = null
      state.currentWsRoot = root.path
      state.currentWsPath = root.path
      closeSidebar()
      newSession()
    })
    body.appendChild(newBtn)

    head.addEventListener('click', function () {
      selectPresetRootTarget(root)
      var open = head.classList.toggle('open')
      body.classList.toggle('open', open)
    })
    group.appendChild(head)
    group.appendChild(body)
    return group
  }

  function wsGroupElement(name, ws, sessions, openDefault) {
    var group = document.createElement('div')
    group.className = 'ws-group'

    var head = document.createElement('div')
    head.className = 'ws-item' + (openDefault ? ' open' : '')
    var title = document.createElement('span')
    title.className = 'ws-name'
    title.textContent = name
    var count = document.createElement('span')
    count.className = 'ws-count'
    count.textContent = String(sessions.length)
    var arrow = document.createElement('span')
    arrow.className = 'ws-arrow'
    arrow.textContent = '›'
    head.appendChild(title)
    head.appendChild(count)
    head.appendChild(arrow)
    if (ws) {
      var browse = document.createElement('button')
      browse.className = 'row-act'
      browse.textContent = '📂'
      browse.title = '浏览工作区文件夹'
      browse.addEventListener('click', function (event) {
        event.stopPropagation()
        closeSidebar()
        openFsBrowser(ws.path, null)
      })
      head.appendChild(browse)
      var del = document.createElement('button')
      del.className = 'row-act'
      del.textContent = '🗑'
      del.title = '删除工作区(仅移除注册,不删文件)'
      del.addEventListener('click', function (event) {
        event.stopPropagation()
        deleteWorkspace(ws)
      })
      head.appendChild(del)
    }

    var body = document.createElement('div')
    body.className = 'ws-body' + (openDefault ? ' open' : '')
    if (sessions.length === 0) {
      var empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '暂无会话'
      body.appendChild(empty)
    } else {
      sessions.forEach(function (s) {
        body.appendChild(sessionRowElement(s, ws ? ws.path : undefined))
      })
    }

    head.addEventListener('click', function () {
      selectWorkspaceTarget(ws)
      var open = head.classList.toggle('open')
      body.classList.toggle('open', open)
    })
    group.appendChild(head)
    group.appendChild(body)
    return group
  }

  function markCurrentRow(sessionId) {
    var rows = document.querySelectorAll('.session-row')
    rows.forEach(function (row) {
      row.classList.toggle('current', (row as any)._sid === sessionId)
    })
  }

  // ---- 新建工作区(仅限预设根目录) ----
  function openNewWsSheet() {
    var statusEl = $('newws-status')
    statusEl.textContent = '加载预设目录…'
    openSheet($('view-newws'))
    apiAction('workspace.subdirs').then(function (data) {
      var roots = data.roots || []
      if (roots.length === 0) {
        statusEl.textContent = '尚未配置预设工作区根目录:请在电脑端「设置 → 远程访问 → 预设工作区根目录」中添加'
      } else {
        statusEl.textContent = ''
      }
      renderPresetRoots(roots)
      var select = $('newws-root')
      select.innerHTML = ''
      roots.forEach(function (item) {
        var opt = document.createElement('option')
        opt.value = item.root
        opt.textContent = item.root
        select.appendChild(opt)
      })
    }).catch(function (err) {
      statusEl.textContent = '加载失败:' + err.message
    })
  }

  function renderPresetRoots(roots) {
    var host = $('newws-roots')
    host.innerHTML = ''
    roots.forEach(function (item) {
      var group = document.createElement('div')
      group.className = 'ws-group'
      var head = document.createElement('div')
      head.className = 'ws-item'
      var title = document.createElement('span')
      title.className = 'ws-name'
      title.textContent = item.root
      head.appendChild(title)
      var body = document.createElement('div')
      body.className = 'ws-body open'
      if (item.dirs.length === 0) {
        var empty = document.createElement('p')
        empty.className = 'empty'
        empty.textContent = '该目录下还没有子文件夹'
        body.appendChild(empty)
      } else {
        item.dirs.forEach(function (dir) {
          var row = document.createElement('div')
          row.className = 'session-row'
          var t = document.createElement('span')
          t.className = 'session-title'
          t.textContent = dir.name
          var b = document.createElement('span')
          b.className = 'session-badge'
          b.textContent = '使用'
          row.appendChild(t)
          row.appendChild(b)
          row.addEventListener('click', function () { useWorkspacePath(dir.path, dir.name) })
          body.appendChild(row)
        })
      }
      head.addEventListener('click', function () {
        var open = head.classList.toggle('open')
        body.classList.toggle('open', open)
      })
      group.appendChild(head)
      group.appendChild(body)
      host.appendChild(group)
    })
  }

  /** 把已有子目录注册为工作区(预设根目录下,远程端允许)。 */
  function useWorkspacePath(path, name) {
    var statusEl = $('newws-status')
    statusEl.textContent = '正在注册「' + name + '」…'
    apiRpc('workspace.create', { path: path }).then(function (created) {
      selectWorkspaceTarget({ workspaceId: created.workspaceId, path: path })
      S.toast('工作区已就绪:' + name, 'ok')
      statusEl.textContent = ''
      closeSheet($('view-newws'))
      loadSidebar()
      fillWorkspaceSelect(created.workspaceId)
      // 与 harness Web 一致:建好工作区后直接进入「新对话」选择。
      openNewsessSheet()
    }).catch(function (err) {
      statusEl.textContent = '注册失败:' + err.message
    })
  }

  /** 在预设根目录下新建文件夹并注册为工作区。 */
  function createNewWorkspace() {
    var root = $('newws-root').value
    var name = $('newws-name').value.trim()
    if (root === '') {
      S.toast('请先选择预设根目录', 'error')
      return
    }
    if (name === '' || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('..') >= 0) {
      S.toast('请输入合法的文件夹名(不含路径分隔符)', 'error')
      return
    }
    var statusEl = $('newws-status')
    statusEl.textContent = '正在创建「' + name + '」…'
    apiAction('workspace.createNew', { root: root, name: name }).then(function (created) {
      selectWorkspaceTarget({ workspaceId: created.workspaceId, path: created.path || root + '/' + name })
      S.toast('工作区已创建:' + name, 'ok')
      statusEl.textContent = ''
      $('newws-name').value = ''
      closeSheet($('view-newws'))
      loadSidebar()
      fillWorkspaceSelect(created.workspaceId)
      // 与 harness Web 一致:建好工作区后直接进入「新对话」选择。
      openNewsessSheet()
    }).catch(function (err) {
      statusEl.textContent = '创建失败:' + err.message
    })
  }

  /** 归档会话(隐藏出列表;日志保留,可在底部「已归档」随时恢复)。 */
  function archiveSession(sessionId) {
    if (!window.confirm('归档会话 ' + sessionId + '?\n(归档后从列表隐藏;可在侧边栏底部「已归档」一键恢复)')) return
    apiRpc('workspace.archiveSession', { sessionId: sessionId }).then(function () {
      S.toast('会话已归档', 'ok')
      if (state.sessionId === sessionId) {
        state.sessionId = null
        clearChat()
        setChatStatus('空闲', '')
      }
      loadSidebar()
    }).catch(function (err) {
      S.toast('归档失败:' + err.message, 'error')
    })
  }

  /** 恢复(取消归档)会话:从注册表移除后重新显示在对应列表。 */
  function restoreSession(sessionId) {
    apiRpc('workspace.unarchiveSession', { sessionId: sessionId }).then(function (result) {
      var note = result && result.note ? result.note : '会话已恢复'
      S.toast(note, 'ok')
      loadSidebar()
    }).catch(function (err) {
      S.toast('恢复失败:' + err.message, 'error')
    })
  }

  /** 删除工作区(仅移除注册,不删除磁盘文件;会话退回"最近"分组)。 */
  function deleteWorkspace(ws) {
    if (!window.confirm('删除工作区「' + (ws.title || ws.path) + '」?\n(仅移除注册,不删除磁盘文件)')) return
    apiRpc('workspace.delete', { workspaceId: ws.workspaceId }).then(function () {
      S.toast('工作区已删除', 'ok')
      loadSidebar()
      fillWorkspaceSelect()
    }).catch(function (err) {
      S.toast('删除失败:' + err.message, 'error')
    })
  }

  // ---- 任务 ----
  function fillWorkspaceSelect(selectedId?: string) {
    return apiRpc('workspace.list', {}).then(function (data) {
      var select = $('task-workspace')
      select.innerHTML = ''
      var items = data.items || []
      var opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '(默认目录)'
      select.appendChild(opt)
      items.forEach(function (item) {
        var o = document.createElement('option')
        o.value = item.workspaceId
        o.textContent = item.title || item.path
        if (selectedId && item.workspaceId === selectedId) o.selected = true
        select.appendChild(o)
      })
      // 预设工作区根本身也可作为工作区(任务落在根目录)。
      return apiAction('fs.list', { path: '' }).then(function (d) {
        (d.roots || []).filter(function (r) { return r.isPreset }).forEach(function (root) {
          var o = document.createElement('option')
          o.value = 'cwd:' + root.path
          o.textContent = '📁 预设根:' + root.name
          if (state.currentWsRoot === root.path) o.selected = true
          select.appendChild(o)
        })
      }).catch(function () { /* 预设根列表不可用时忽略 */ })
    })
  }

  function loadModels() {
    return Promise.all([
      apiRpc('llm.models', {}),
      apiRpc('host.describe', {}).catch(function () { return {} }),
    ]).then(function (results) {
      var data = results[0]
      var host = results[1] || {}
      state.defaultModel = (typeof host.provider === 'string' && typeof host.model === 'string')
        ? { provider: host.provider, model: host.model }
        : null
      var groups = data.groups || []
      var select = $('task-model')
      select.innerHTML = ''
      // 预设模型(桌面端设置的默认模型)置顶并默认选中。
      if (state.defaultModel) {
        var preset = document.createElement('option')
        preset.value = 'default'
        preset.textContent = '⭐ 预设模型(' + state.defaultModel.provider + ' / ' + state.defaultModel.model + ')'
        preset.selected = true
        select.appendChild(preset)
      }
      groups.forEach(function (group) {
        group.models.forEach(function (model) {
          var o = document.createElement('option')
          o.value = group.id + '|' + model.id
          o.textContent = (group.name || group.id) + ' / ' + (model.name || model.id)
          select.appendChild(o)
        })
      })
      if (select.options.length === 0) {
        var empty = document.createElement('option')
        empty.value = ''
        empty.textContent = '(未配置模型)'
        select.appendChild(empty)
      }
      return groups
    })
  }

  function runTask() {
    var prompt = $('task-prompt').value.trim()
    if (prompt === '') {
      S.toast('请填写任务描述', 'error')
      return
    }
    var workspaceValue = $('task-workspace').value
    var modelValue = $('task-model').value
    var statusEl = $('task-status')
    statusEl.textContent = '正在创建会话…'
    statusEl.className = 'conn-status'
    var payload: Record<string, unknown> = {}
    if (workspaceValue.indexOf('cwd:') === 0) payload.cwd = workspaceValue.slice(4)
    else if (workspaceValue !== '') payload.workspaceId = workspaceValue
    apiRpc('session.create', payload).then(function (created) {
      var sessionId = created.sessionId
      if (modelValue === 'default' && state.defaultModel) {
        // 预设模型:显式应用(与桌面端一致,不随 harness 默认漂移)。
        return apiRpc('session.selectModel', { sessionId: sessionId, provider: state.defaultModel.provider, model: state.defaultModel.model })
          .then(function () { return sessionId })
      }
      if (modelValue !== '') {
        var parts = modelValue.split('|')
        return apiRpc('session.selectModel', { sessionId: sessionId, provider: parts[0], model: parts[1] })
          .then(function () { return sessionId })
      }
      return sessionId
    }).then(function (sessionId) {
      return apiRpc('session.prompt', {
        sessionId: sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }).then(function () { return sessionId })
    }).then(function (sessionId) {
      statusEl.textContent = '任务已启动 ✓'
      statusEl.className = 'conn-status ok'
      closeSheet($('view-task'))
      openSession(sessionId, typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : undefined)
      loadSidebar()
    }).catch(function (err) {
      statusEl.textContent = '启动失败:' + err.message
      statusEl.className = 'conn-status err'
    })
  }

  // ---- 弹层 ----
  function openSheet(el) { el.classList.remove('hidden') }
  function closeSheet(el) { el.classList.add('hidden') }

  // ---- 手机壁纸选择 ----
  /** Upload a wallpaper image chosen from the phone's own gallery. */
  function uploadPhoneWallpaper() {
    var input = $('wallpaper-upload-input') as HTMLInputElement
    if (input === null || input.files === null || input.files.length === 0) return
    var file = input.files[0]
    var reader = new FileReader()
    reader.onload = function () {
      var dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (dataUrl === '') { S.toast('读取图片失败', 'error'); return }
      if (file.size > 12 * 1024 * 1024) { S.toast('图片过大(限 12MB)', 'error'); return }
      S.toast('上传壁纸中…', '')
      apiAction('appearance.uploadPhoneWallpaper', { data: dataUrl }).then(function () {
        S.toast('壁纸已设为手机背景', 'ok')
        loadWallpapers()
        applyWallpaper(state.server)
      }).catch(function (err) {
        S.toast('上传失败:' + err.message, 'error')
      })
    }
    reader.onerror = function () { S.toast('读取图片失败', 'error') }
    reader.readAsDataURL(file)
    input.value = ''
  }

  function loadWallpapers() {
    var host = $('set-wallpapers')
    fetch(state.server + '/api/wallpapers?token=' + encodeURIComponent(state.token), {
      signal: AbortSignal.timeout(10000),
    }).then(function (res) {
      return res.json()
    }).then(function (data) {
      if (!data.ok || !Array.isArray(data.items) || data.items.length === 0) {
        host.innerHTML = '<p class="empty">暂无可用壁纸</p>'
        return
      }
      host.innerHTML = ''
      data.items.forEach(function (item) {
        var cell = document.createElement('div')
        cell.className = 'wallpaper-cell' + (item.active ? ' active' : '')
        if (item.thumb) {
          var img = document.createElement('img')
          img.src = item.thumb
          img.alt = item.name
          img.loading = 'lazy'
          cell.appendChild(img)
        } else {
          var ph = document.createElement('div')
          ph.className = 'wallpaper-cell-ph'
          ph.textContent = '🖼'
          cell.appendChild(ph)
        }
        var name = document.createElement('span')
        name.textContent = item.name
        cell.appendChild(name)
        cell.addEventListener('click', function () {
          applyPhoneWallpaper(item, cell)
        })
        host.appendChild(cell)
      })
    }).catch(function () {
      host.innerHTML = '<p class="empty">壁纸加载失败</p>'
    })
  }

  function applyPhoneWallpaper(item, cell) {
    var request = item.id === 'default'
      ? apiAction('appearance.clearPhoneWallpaper')
      : apiAction('appearance.setPhoneWallpaper', { path: item.path })
    request.then(function () {
      S.toast('壁纸已切换:' + item.name, 'ok')
      document.querySelectorAll('.wallpaper-cell').forEach(function (c) { c.classList.remove('active') })
      cell.classList.add('active')
      // 重新拉取背景(带时间戳防缓存)。
      applyWallpaper(state.server)
    }).catch(function (err) {
      S.toast('切换失败:' + err.message, 'error')
    })
  }

  // ---- 定时任务 ----
  function loadScheduled() {
    var host = $('sched-list')
    fetch(state.server + '/api/tasks?token=' + encodeURIComponent(state.token), { signal: AbortSignal.timeout(10000) })
      .then(function (r) { return r.json() })
      .then(function (data) {
        var items = data.items || []
        if (items.length === 0) {
          host.innerHTML = '(暂无定时任务)'
          return
        }
        host.innerHTML = ''
        items.forEach(function (t, i) {
          var row = document.createElement('div')
          row.className = 'sched-row'
          var info = document.createElement('span')
          info.textContent = (i + 1) + '. ' + t.when + ' — ' + t.description
          var del = document.createElement('button')
          del.className = 'row-act'
          del.textContent = '✕'
          del.addEventListener('click', function () {
            apiAction('sched.remove', { index: i }).then(function () {
              S.toast('已取消定时任务', 'ok')
              loadScheduled()
            }).catch(function (err) { S.toast('取消失败:' + err.message, 'error') })
          })
          row.appendChild(info)
          row.appendChild(del)
          host.appendChild(row)
        })
      }).catch(function () {
        host.innerHTML = '(加载失败)'
      })
  }

  function addScheduled() {
    var expr = $('sched-expr').value.trim()
    var desc = $('sched-desc').value.trim()
    if (expr === '' || desc === '') {
      S.toast('请填写表达式和任务描述', 'error')
      return
    }
    apiAction('sched.add', { expr: expr, description: desc }).then(function (data) {
      S.toast(data.message || '已添加', 'ok')
      $('sched-expr').value = ''
      $('sched-desc').value = ''
      loadScheduled()
    }).catch(function (err) {
      S.toast('添加失败:' + err.message, 'error')
    })
  }

  // ---- 文件夹浏览(只读:工作区/预设根目录内) ----
  var fsPickMode = null   // null = 浏览;'addRoot' = 从浏览中挑选添加预设根

  function openFsBrowser(path, pickMode) {
    fsPickMode = pickMode || null
    state.fsPath = path || ''
    state.fsParent = ''
    openSheet($('view-fs'))
    loadFsList()
  }

  function closeFsBrowser() {
    closeSheet($('view-fs'))
    fsPickMode = null
  }

  function loadFsList() {
    var host = $('fs-list')
    host.innerHTML = '<p class="empty">加载中…</p>'
    renderFsCrumb()
    apiAction('fs.list', { path: state.fsPath }).then(function (data) {
      state.fsParent = typeof data.parent === 'string' ? data.parent : ''
      renderFsCrumb()
      if (Array.isArray(data.roots)) renderFsRoots(data.roots)
      else renderFsEntries(data)
    }).catch(function (err) {
      host.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  function renderFsCrumb() {
    var crumb = $('fs-crumb')
    crumb.innerHTML = ''
    var root = document.createElement('button')
    root.className = 'crumb-btn'
    root.textContent = '根'
    root.addEventListener('click', function () { state.fsPath = ''; state.fsParent = ''; loadFsList() })
    crumb.appendChild(root)
    if (state.fsPath === '') return
    if (state.fsParent !== '') {
      var back = document.createElement('button')
      back.className = 'crumb-btn'
      back.textContent = '↑ 上一级'
      back.title = '返回上一级目录'
      back.addEventListener('click', function () { state.fsPath = state.fsParent; loadFsList() })
      crumb.appendChild(back)
    }
    var parts = state.fsPath.split(/[\\/]/).filter(function (p) { return p !== '' })
    var acc = ''
    parts.forEach(function (part, i) {
      var sepEl = document.createElement('span')
      sepEl.className = 'crumb-sep'
      sepEl.textContent = ' / '
      crumb.appendChild(sepEl)
      // 第一段是盘符(如 D:),不可点击。
      if (i === 0 && /^[A-Za-z]:$/.test(part)) {
        var drive = document.createElement('span')
        drive.className = 'crumb-drive'
        drive.textContent = part
        crumb.appendChild(drive)
        acc = part
        return
      }
      acc = acc === '' ? part : acc + '\\' + part
      var crumbPath = acc
      var btn = document.createElement('button')
      btn.className = 'crumb-btn'
      btn.textContent = part
      btn.addEventListener('click', function () { state.fsPath = crumbPath; loadFsList() })
      crumb.appendChild(btn)
    })
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  function renderFsRoots(roots) {
    var host = $('fs-list')
    host.innerHTML = ''
    if (roots.length === 0) {
      host.innerHTML = '<p class="empty">没有可浏览的根目录(先在电脑端「设置 → 远程访问」配置预设根,或建立工作区)</p>'
      return
    }
    roots.forEach(function (r) {
      var row = document.createElement('div')
      row.className = 'fs-row'
      var icon = document.createElement('span')
      icon.className = 'fs-icon'
      icon.textContent = '📁'
      var name = document.createElement('span')
      name.className = 'fs-name'
      name.textContent = r.name + '  (' + r.path + ')'
      row.appendChild(icon)
      row.appendChild(name)
      row.addEventListener('click', function () { state.fsPath = r.path; loadFsList() })
      host.appendChild(row)
    })
  }

  function renderFsEntries(data) {
    var host = $('fs-list')
    host.innerHTML = ''
    if (fsPickMode === 'addRoot') {
      var tip = document.createElement('p')
      tip.className = 'empty'
      tip.textContent = '挑一个文件夹点「＋根」,将其设为预设工作区根目录(仅这些目录下可在手机端新建文件夹工作区)'
      host.appendChild(tip)
    }
    var entries = data.entries || []
    if (entries.length === 0) {
      var empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '(空目录)'
      host.appendChild(empty)
    }
    entries.forEach(function (e) {
      var row = document.createElement('div')
      row.className = 'fs-row'
      var icon = document.createElement('span')
      icon.className = 'fs-icon'
      icon.textContent = e.isDir ? '📁' : '📄'
      var name = document.createElement('span')
      name.className = 'fs-name'
      name.textContent = e.isDir ? e.name : e.name + '  ' + fmtSize(e.size)
      row.appendChild(icon)
      row.appendChild(name)
      if (e.isDir) {
        var addRoot = document.createElement('button')
        addRoot.className = 'row-act'
        addRoot.textContent = '＋根'
        addRoot.title = '添加为预设工作区根目录'
        addRoot.addEventListener('click', function (ev) {
          ev.stopPropagation()
          addPresetRoot(e.path)
        })
        row.appendChild(addRoot)
        row.addEventListener('click', function () { state.fsPath = e.path; loadFsList() })
      } else {
        row.addEventListener('click', function () { openFsPreview(e.path, e.name) })
      }
      host.appendChild(row)
    })
    if (data.truncated) {
      var more = document.createElement('p')
      more.className = 'empty'
      more.textContent = '(仅显示前 200 项)'
      host.appendChild(more)
    }
  }

  function openFsPreview(path, name) {
    $('fsp-title').textContent = name
    var content = $('fsp-content')
    content.innerHTML = ''
    openSheet($('view-fspreview'))
    var lower = String(name).toLowerCase()
    var media: string | null = null
    if (['.mp4', '.webm', '.mov', '.m4v'].some(function (ext) { return lower.endsWith(ext) })) media = 'video'
    else if (['.mp3', '.wav', '.ogg', '.m4a'].some(function (ext) { return lower.endsWith(ext) })) media = 'audio'
    else if (lower.endsWith('.pdf')) media = 'pdf'
    else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].some(function (ext) { return lower.endsWith(ext) })) media = 'image'
    if (media !== null) {
      var source = state.server + '/api/fs/stream?path=' + encodeURIComponent(path)
        + '&token=' + encodeURIComponent(state.token) + '&device=' + encodeURIComponent(state.deviceId)
      if (media === 'pdf') {
        // 手机浏览器通常禁用在 iframe 里嵌 PDF;提供"新窗口打开 + 下载"。
        var pdfHint = document.createElement('p')
        pdfHint.className = 'empty'
        pdfHint.textContent = '浏览器不支持内嵌 PDF,请用下方按钮打开或下载'
        content.appendChild(pdfHint)
        content.appendChild(previewActionRow(source, name, true))
      } else if (media === 'video') {
        var video = document.createElement('video')
        video.className = 'fsp-media'
        video.controls = true
        video.playsInline = true
        video.preload = 'metadata'
        video.src = source
        content.appendChild(video)
        content.appendChild(previewActionRow(source, name, false))
      } else if (media === 'audio') {
        var audio = document.createElement('audio')
        audio.className = 'fsp-audio'
        audio.controls = true
        audio.preload = 'metadata'
        audio.src = source
        content.appendChild(audio)
        content.appendChild(previewActionRow(source, name, false))
      } else {
        var image = document.createElement('img')
        image.className = 'fsp-media'
        image.alt = name
        image.src = source
        content.appendChild(image)
        content.appendChild(previewActionRow(source, name, false))
      }
      return
    }
    content.textContent = '加载中…'
    loadFsPreviewChunk(path, 0)
  }

  /** 预览底部操作行:新窗口打开(可选)+ 下载。 */
  function previewActionRow(source, name, withOpen) {
    var row = document.createElement('div')
    row.className = 'fsp-actions'
    if (withOpen) {
      var open = document.createElement('a')
      open.className = 'btn'
      open.href = source
      open.target = '_blank'
      open.rel = 'noopener'
      open.textContent = '↗ 在新窗口打开'
      row.appendChild(open)
    }
    var dl = document.createElement('a')
    dl.className = 'btn'
    dl.href = source
    dl.download = name
    dl.textContent = '⬇ 下载'
    row.appendChild(dl)
    return row
  }

  function renderMarkdownPreview(text) {
    var escaped = S.escapeHtml(text)
    return escaped
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>')
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/```([\\s\\S]*?)```/g, '<pre class="md-code">$1</pre>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(?:\r?\n){2,}/g, '<br /><br />')
      .replace(/\r?\n/g, '<br />')
  }

  function loadFsPreviewChunk(path, offset) {
    apiAction('fs.read', { path: path, offset: offset }).then(function (data) {
      var pre = $('fsp-content')
      if (data.image) {
        pre.textContent = ''
        var img = document.createElement('img')
        img.src = data.dataUrl
        img.style.maxWidth = '100%'
        img.style.borderRadius = '8px'
        pre.appendChild(img)
        return
      }
      var isMarkdown = /\.(md|markdown|mdown|mkdn)$/i.test(path)
      if (offset === 0) {
        if (isMarkdown) {
          pre.innerHTML = renderMarkdownPreview(data.text || '') || '(空文件)'
          pre.classList.add('rich-preview')
        } else {
          pre.textContent = data.text || '(空文件)'
          pre.classList.remove('rich-preview')
        }
      } else if (isMarkdown) {
        pre.innerHTML += renderMarkdownPreview(data.text || '')
      } else pre.textContent += data.text
      if (data.truncated) {
        var more = document.createElement('button')
        more.className = 'btn btn-sm'
        more.textContent = '加载更多(' + Math.max(1, Math.round((data.size - data.nextOffset) / 1024)) + 'KB 剩余)'
        more.addEventListener('click', function () {
          more.remove()
          loadFsPreviewChunk(path, data.nextOffset)
        })
        pre.appendChild(more)
      }
    }).catch(function (err) {
      $('fsp-content').textContent = '预览失败:' + err.message
    })
  }

  function addPresetRoot(path) {
    apiAction('fs.addRoot', { path: path }).then(function () {
      S.toast('已添加预设工作区根目录', 'ok')
      if (fsPickMode === 'addRoot') {
        closeFsBrowser()
        loadPresetRoots()
      }
    }).catch(function (err) {
      S.toast('添加失败:' + err.message, 'error')
    })
  }

  // ---- 预设工作区根目录管理(PWA 端) ----
  function loadPresetRoots() {
    var host = $('preset-roots')
    host.innerHTML = '<p class="empty">加载中…</p>'
    apiAction('fs.list', { path: '' }).then(function (data) {
      var roots = (data.roots || []).filter(function (r) { return r.isPreset })
      if (roots.length === 0) {
        host.innerHTML = '<p class="empty">(未配置预设根;可在电脑端「设置 → 远程访问」用文件资源管理器选择,或点下方按钮浏览添加)</p>'
        return
      }
      host.innerHTML = ''
      roots.forEach(function (r) {
        var row = document.createElement('div')
        row.className = 'sched-row'
        var info = document.createElement('span')
        info.textContent = r.name + '  ' + r.path
        var del = document.createElement('button')
        del.className = 'row-act'
        del.textContent = '✕'
        del.title = '从预设根移除(不删除文件夹)'
        del.addEventListener('click', function () {
          apiAction('fs.removeRoot', { path: r.path }).then(function () {
            S.toast('已移除', 'ok')
            loadPresetRoots()
          }).catch(function (err) { S.toast('移除失败:' + err.message, 'error') })
        })
        row.appendChild(info)
        row.appendChild(del)
        host.appendChild(row)
      })
    }).catch(function (err) {
      host.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  // ---- 用量与费用(今日) ----
  function loadUsage() {
    var host = $('set-usage')
    apiAction('usage.get').then(function (data) {
      var r = data.report
      if (!r) {
        host.innerHTML = '<p class="empty">暂无数据</p>'
        return
      }
      var html = ''
      html += '会话:' + r.todaySessions + ' 个 / 回合:' + r.todayTurns + ' 次<br>'
      html += 'Token:' + (r.tokens.total / 1000).toFixed(1) + 'K(输入 ' + (r.tokens.input / 1000).toFixed(1) + 'K / 输出 ' + (r.tokens.output / 1000).toFixed(1) + 'K' + (r.tokens.cache > 0 ? ' / 缓存 ' + (r.tokens.cache / 1000).toFixed(1) + 'K' : '') + ')'
      if (r.cost.total > 0) {
        html += '<br>💰 费用估算:¥' + r.cost.total.toFixed(3) + '(倍率 ' + r.prices.multiplier + ')'
      }
      if (r.byModel.length > 0) {
        html += '<br><br>按模型:'
        r.byModel.slice(0, 6).forEach(function (m) {
          html += '<br>· ' + m.provider + '/' + m.model + ':' + ((m.input + m.output) / 1000).toFixed(1) + 'K Token,' + m.calls + ' 次'
        })
      }
      host.innerHTML = html
    }).catch(function (err) {
      host.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  // ---- 切换会话模型 ----
  function openModelSheet() {
    openSheet($('view-model'))
    var list = $('model-list')
    list.innerHTML = '<p class="empty">加载中…</p>'
    apiRpc('llm.models', {}).then(function (data) {
      var groups = data.groups || []
      list.innerHTML = ''
      groups.forEach(function (group) {
        var head = document.createElement('div')
        head.className = 'model-group'
        head.textContent = (group.name || group.id) + ' / ' + group.id
        list.appendChild(head)
        group.models.forEach(function (model) {
          var row = document.createElement('div')
          row.className = 'model-row'
          var name = document.createElement('span')
          name.className = 'model-name'
          name.textContent = model.name || model.id
          row.appendChild(name)
          var state2 = document.createElement('span')
          state2.className = 'model-id'
          state2.textContent = model.id
          row.appendChild(state2)
          row.addEventListener('click', function () {
            apiRpc('session.selectModel', { sessionId: state.sessionId, provider: group.id, model: model.id }).then(function () {
              S.toast('已切换:' + group.id + '/' + model.id, 'ok')
              closeSheet($('view-model'))
              setChatStatus('已切换模型 ' + model.id, '')
            }).catch(function (err) {
              S.toast('切换失败:' + err.message, 'error')
            })
          })
          list.appendChild(row)
        })
      })
      if (groups.length === 0) list.innerHTML = '<p class="empty">(未配置模型)</p>'
    }).catch(function (err) {
      list.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  // ---- 连接流程 ----
  function connect() {
    var server = $('conn-server').value.trim().replace(/\/+$/, '')
    var token = $('conn-token').value.trim()
    if (server === '' || token === '') {
      $('conn-status').textContent = '请填写服务器地址和令牌'
      $('conn-status').className = 'conn-status err'
      return
    }
    state.server = server
    state.token = token
    applyWallpaper(server)
    $('conn-status').textContent = '连接中…'
    $('conn-status').className = 'conn-status'
    apiRpc('host.describe', {}).then(function (host) {
      localStorage.setItem('dsh-server', server)
      localStorage.setItem('dsh-token', token)
      $('conn-status').textContent = '已连接 ✓'
      $('conn-status').className = 'conn-status ok'
      state.connected = true
      enterMain(host)
    }).catch(function (err) {
      var message = String(err && err.message ? err.message : err)
      var hint = /等待桌面端批准/.test(message)
        ? '等待桌面端批准此设备(请在电脑上点击「允许连接」)'
        : /Failed to fetch|NetworkError|ECONNREFUSED|ERR_CONNECTION/.test(message)
          ? '无法连接电脑。请确认:手机与电脑在同一 Wi-Fi、电脑远程访问已启用、防火墙放行该端口'
          : message
      $('conn-status').textContent = '连接失败:' + hint
      $('conn-status').className = 'conn-status err'
    })
  }

  function enterMain(host) {
    $('set-server').textContent = state.server
    $('set-harness').textContent = host ? ('v' + (host.version || '?') + ' · ' + (host.cwd || '')) : ''
    showView('main')
    setChatStatus('空闲', '')
    bindScrollStick()
    connectEvents()
    loadSidebar()
    fillWorkspaceSelect()
    loadModels()
    openSidebar()
  }

  function showView(name) {
    var map = { connect: 'view-connect', main: 'view-main' }
    for (var key in map) {
      $(map[key]).classList.toggle('hidden', key !== name)
    }
  }

  function disconnect() {
    eventsGeneration++
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (state.es) state.es.close()
    state.es = null
    eventsWasDisconnected = false
    esDelay = 1000
    state.connected = false
    state.sessionId = null
    closeSidebar()
    showView('connect')
  }

  // ---- 壁纸 ----
  function applyWallpaper(base) {
    var stamp = '?t=' + Date.now()
    fetch((base.replace(/\/+$/, '')) + '/api/info').then(function (res) {
      return res.json()
    }).then(function (info) {
      var pos = info.wallpaperPosition || { x: 0.5, y: 0.5 }
      document.body.style.setProperty('--wallpaper-position', (pos.x * 100) + '% ' + (pos.y * 100) + '%')
      var img = new Image()
      img.onload = function () { document.body.classList.add('has-wallpaper') }
      img.onerror = function () { document.body.classList.remove('has-wallpaper') }
      img.src = base.replace(/\/+$/, '') + '/wallpaper' + stamp
    }).catch(function () {
      var img = new Image()
      img.onload = function () { document.body.classList.add('has-wallpaper') }
      img.onerror = function () { document.body.classList.remove('has-wallpaper') }
      img.src = base.replace(/\/+$/, '') + '/wallpaper' + stamp
    })
  }

  function loadHealth() {
    var host = $('set-health')
    apiAction('workspace.health').then(function (data) {
      var items = data.items || []
      host.textContent = items.length === 0 ? '暂无已注册工作区。' : items.map(function (item) {
        var state = item.exists && item.readable && item.writable ? '正常' : '需检查'
        var free = item.freeBytes === null ? '' : ' / 可用 ' + (item.freeBytes / 1073741824).toFixed(1) + ' GB'
        return (state === '正常' ? '✓ ' : '⚠️ ') + (item.title || item.path) + ': ' + state + free + ' / 会话 ' + (item.sessions === null ? '?' : item.sessions)
      }).join('\n')
    }).catch(function (err) { host.textContent = '检查失败:' + err.message })
  }

  function loadInteractions() {
    var host = $('set-interactions')
    apiAction('interactions.get').then(function (data) {
      var items = data.items || []
      host.innerHTML = ''
      if (items.length === 0) { host.textContent = '当前没有待审批或待回答的问题。'; return }
      items.forEach(function (item) {
        var row = document.createElement('div')
        row.className = 'interaction-row'
        row.textContent = (item.kind === 'approval' ? '⚠️ ' : '❓ ') + item.title + '\n' + item.detail + '\n会话:' + item.sessionId
        if (item.kind === 'approval' && item.approvalId) {
          ;[['允许', 'allowed-once'], ['拒绝', 'rejected']].forEach(function (action) {
            var button = document.createElement('button')
            button.className = 'btn btn-sm'
            button.textContent = action[0]
            button.addEventListener('click', function () {
              button.disabled = true
              apiAction('interactions.respondApproval', { sessionId: item.sessionId, approvalId: item.approvalId, outcome: action[1] }).then(function (result) { S.toast(result.result || result, 'ok'); loadInteractions() }).catch(function (err) { S.toast(err.message, 'error') })
            })
            row.appendChild(button)
          })
        } else if (item.kind === 'question' && item.questionId && item.options) {
          item.options.forEach(function (label, index) {
            var button = document.createElement('button')
            button.className = 'btn btn-sm'
            button.textContent = (index + 1) + '. ' + label
            button.addEventListener('click', function () {
              button.disabled = true
              apiAction('interactions.respondQuestion', { sessionId: item.sessionId, questionId: item.questionId, optionIndex: index }).then(function (result) { S.toast(result.result || result, 'ok'); loadInteractions() }).catch(function (err) { S.toast(err.message, 'error') })
            })
            row.appendChild(button)
          })
        }
        host.appendChild(row)
      })
    }).catch(function (err) { host.textContent = '加载失败:' + err.message })
  }

  function loadWorkbench() {
    apiAction('activity.get').then(function (data) {
      var items = data.items || []
      $('set-activities').textContent = items.length === 0 ? '暂无活动。' : items.slice(0, 20).map(function (item) { return item.status + ' | ' + item.source + '/' + item.type + ' | ' + item.title + '\n' + item.lastEvent }).join('\n\n')
    }).catch(function (err) { $('set-activities').textContent = '加载失败:' + err.message })
    apiAction('audit.get').then(function (data) {
      var items = data.items || []
      $('set-audit').textContent = items.length === 0 ? '暂无审计记录。' : items.slice(0, 30).map(function (item) { return new Date(item.time).toLocaleString() + ' | ' + item.type + '\n' + item.detail }).join('\n\n')
    }).catch(function (err) { $('set-audit').textContent = '加载失败:' + err.message })
    apiAction('memory.getAll').then(function (data) {
      var items = data.items || {}
      var paths = Object.keys(items)
      $('set-memories').textContent = paths.length === 0 ? '暂无工作区记忆。' : paths.map(function (path) { var m = items[path]; return path + '\n' + (m.summary || '(未填写简介)') }).join('\n\n')
    }).catch(function (err) { $('set-memories').textContent = '加载失败:' + err.message })
  }

  function loadPwaQueue() {
    var host = $('set-queue')
    apiAction('queue.get').then(function (data) {
      var items = data.items || []
      var active = items.filter(function (item) { return item.status === 'queued' || item.status === 'running' || item.status === 'failed' })
      if (active.length === 0) { host.textContent = '队列为空。'; return }
      host.textContent = active.slice(0, 10).map(function (item) {
        var retryIn = item.status === 'failed' && item.nextAttemptAt !== null
          ? ' / ' + Math.max(1, Math.ceil((item.nextAttemptAt - Date.now()) / 1000)) + 's 后自动重试'
          : ''
        var state = item.status === 'failed' ? '失败(尝试 ' + item.attempts + '/' + item.maxAttempts + ')' + retryIn : item.status === 'running' ? '运行中' : '排队中'
        return state + ' | ' + item.source + '\n' + item.description.slice(0, 80) + (item.error ? '\n' + item.error.slice(0, 100) : '')
      }).join('\n\n')
    }).catch(function (err) { host.textContent = '加载失败:' + err.message })
  }

  function loadTaskHistory() {
    var host = $('set-task-history')
    apiAction('tasks.get').then(function (data) {
      var items = data.items || []
      host.textContent = items.length === 0 ? '暂无任务记录。' : items.slice(0, 20).map(function (item) {
        return item.status + ' | ' + item.description.slice(0, 70) + ' | 尝试 ' + item.attempts + (item.error ? ' | ' + item.error : '')
      }).join('\n')
    }).catch(function (err) { host.textContent = '加载失败:' + err.message })
  }

  function loadDiagnostics() {
    apiAction('diagnostics.get').then(function (data) {
      $('set-diagnostics').textContent = JSON.stringify(data.report || data, null, 2)
    }).catch(function (err) { $('set-diagnostics').textContent = '加载失败:' + err.message })
  }

  // ---- 初始化 ----
  function init() {
    var params = new URLSearchParams(window.location.search)
    var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    var serverParam = params.get('server') || hashParams.get('server')
    var tokenParam = params.get('token') || hashParams.get('token')
    // 读取后立即清除地址栏中的配对参数,避免令牌留在浏览器历史/截图。
    if ((params.has('server') || params.has('token')) || (hashParams.has('server') || hashParams.has('token'))) {
      history.replaceState(null, '', window.location.pathname)
    }
    var savedServer = localStorage.getItem('dsh-server')
    var savedToken = localStorage.getItem('dsh-token')
    if (serverParam) $('conn-server').value = serverParam
    else if (savedServer) $('conn-server').value = savedServer
    else $('conn-server').value = window.location.origin
    if (tokenParam) $('conn-token').value = tokenParam
    else if (savedToken) $('conn-token').value = savedToken
    applyWallpaper(window.location.origin)
    $('opt-temp-cache').checked = state.tempCache

    $('btn-connect').addEventListener('click', connect)
    $('conn-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect() })

    if ((serverParam && tokenParam) || (savedServer && savedToken)) connect()

    // 侧边栏
    $('btn-menu').addEventListener('click', openSidebar)
    $('btn-empty-new').addEventListener('click', openNewsessSheet)
    $('btn-new-session').addEventListener('click', openNewsessSheet)
    $('btn-sidebar-close').addEventListener('click', closeSidebar)
    $('sidebar-backdrop').addEventListener('click', closeSidebar)
    $('btn-new-workspace').addEventListener('click', function () {
      closeSidebar()
      openNewWsSheet()
    })

    // 新对话弹层(工作区优先,与 harness Web 一致)
    $('btn-newsess-close').addEventListener('click', function () { closeSheet($('view-newsess')) })
    $('btn-newsess-create').addEventListener('click', createFromNewsess)
    $('btn-newsess-newws').addEventListener('click', function () {
      closeSheet($('view-newsess'))
      openNewWsSheet()
    })

    // 新建工作区弹层
    $('btn-newws-close').addEventListener('click', function () { closeSheet($('view-newws')) })
    $('btn-newws-create').addEventListener('click', createNewWorkspace)

    // 聊天
    $('btn-chat-send').addEventListener('click', function () { sendMessage(selectedSendMode()) })
    $('btn-chat-steer').addEventListener('click', function () { sendMessage('steer') })
    $('session-send-mode').addEventListener('change', function () {
      var select = $('session-send-mode')
      var steer = select.value === 'steer'
      $('btn-chat-send').textContent = steer ? '插入发送' : '发送'
    })
    $('session-permission').addEventListener('change', function () {
      var select = $('session-permission')
      if (select.value !== 'danger-full-access') return
      if (window.confirm('完全访问会允许新会话读写工作区并跳过审批确认,确定启用吗？')) return
      select.value = 'workspace-write'
    })
    $('btn-wallpaper-upload').addEventListener('click', uploadPhoneWallpaper)
    $('btn-chat-export').addEventListener('click', exportSession)
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendMessage('queue')
      }
    })
    $('btn-chat-stop').addEventListener('click', function () {
      if (state.sessionId !== null) {
        $('btn-chat-stop').disabled = true
        apiRpc('session.cancel', { sessionId: state.sessionId }).then(function () {
          S.toast('已请求停止', 'ok')
        }).catch(function (err) { S.toast('停止失败:' + err.message, 'error') })
      }
    })

    // 任务
    $('btn-open-task').addEventListener('click', function () {
      closeSidebar()
      fillWorkspaceSelect(state.currentWsId)
      openSheet($('view-task'))
    })
    $('btn-task-close').addEventListener('click', function () { closeSheet($('view-task')) })
    $('btn-ws-refresh').addEventListener('click', function () {
      fillWorkspaceSelect().catch(function (err) { S.toast(err.message, 'error') })
    })
    $('btn-task-run').addEventListener('click', runTask)

    // 设置
    $('btn-open-settings').addEventListener('click', function () {
      closeSidebar()
      apiRpc('llm.models', {}).then(function (data) {
        var names = (data.groups || []).map(function (g) {
          return (g.name || g.id) + ': ' + g.models.map(function (m) { return m.name || m.id }).join(', ')
        })
        $('set-models').textContent = names.join('\n') || '(未配置)'
      }).catch(function () { $('set-models').textContent = '(未连接)' })
      loadWallpapers()
      loadScheduled()
      loadPresetRoots()
      loadUsage()
      loadHealth()
      loadInteractions()
      loadWorkbench()
      loadPwaQueue()
      loadTaskHistory()
      loadDiagnostics()
      openSheet($('view-settings'))
    })
    $('btn-settings-close').addEventListener('click', function () { closeSheet($('view-settings')) })
    $('btn-usage-refresh').addEventListener('click', loadUsage)
    $('btn-health-refresh').addEventListener('click', loadHealth)
    $('btn-queue-refresh').addEventListener('click', loadPwaQueue)
    $('btn-interactions-refresh').addEventListener('click', loadInteractions)
    $('btn-diagnostics').addEventListener('click', loadDiagnostics)
    $('btn-chat-model').addEventListener('click', openModelSheet)
    $('btn-model-close').addEventListener('click', function () { closeSheet($('view-model')) })
    $('btn-sched-add').addEventListener('click', addScheduled)
    $('btn-preset-add').addEventListener('click', function () {
      closeSheet($('view-settings'))
      openFsBrowser('', 'addRoot')
    })
    $('btn-fs-close').addEventListener('click', closeFsBrowser)
    $('btn-fsp-close').addEventListener('click', function () { closeSheet($('view-fspreview')) })
    $('opt-temp-cache').addEventListener('change', function () {
      state.tempCache = $('opt-temp-cache').checked
      localStorage.setItem('dsh-temp-cache', state.tempCache ? '1' : '0')
      S.toast(state.tempCache ? '已开启:会话仅缓存本机' : '已关闭本机缓存', 'ok')
    })
    $('btn-clear-cache').addEventListener('click', function () {
      clearAllCache()
      S.toast('本机会话缓存已清除', 'ok')
    })
      $('btn-restart-service').addEventListener('click', function () {
      if (!state.connected) {
        S.toast('未连接', 'error')
        return
      }
      if (!window.confirm('重启 Harness 会中断当前服务连接,确定继续吗？')) return
      fetch(state.server + '/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId, 'x-dsh-device-label': navigator.userAgent.slice(0, 60) },
        body: JSON.stringify({ action: 'harness.restart' }),
      }).then(function (res) {
        return res.json()
      }).then(function (data) {
        if (data.ok) S.toast('已请求重启服务', 'ok')
        else S.toast('重启失败:' + (data.error || 'unknown'), 'error')
      }).catch(function (err) {
        S.toast('重启失败:' + err.message, 'error')
      })
    })
    $('btn-add-home').addEventListener('click', function () {
      S.toast('在浏览器菜单中选择「添加到主屏幕」', 'ok')
    })
    $('btn-forget').addEventListener('click', function () {
      localStorage.removeItem('dsh-server')
      localStorage.removeItem('dsh-token')
      $('conn-server').value = ''
      $('conn-token').value = ''
      disconnect()
    })
    $('btn-disconnect').addEventListener('click', disconnect)

    // 页面隐藏/退出前立即落盘缓存(防抖窗口内的消息不丢)。
    window.addEventListener('pagehide', flushCacheNow)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushCacheNow()
    })
  }

  init()
})()
