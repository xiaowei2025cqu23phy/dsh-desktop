/**
 * DSH Remote PWA:DeepSeek Harness 手机遥控。
 * 纯 vanilla JS。连接桌面端远程网关(局域网),实现会话收发、工作区、任务、模型。
 */

(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }

  // ---- 连接状态 ----
  var state = {
    server: '',
    token: '',
    connected: false,
    sessionId: null,      // 当前查看的会话
    lastSeq: 0,           // 事件去重
    messages: [],         // 当前会话渲染的消息
    es: null,             // EventSource
  }

  var S = {
    isRecord: function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v) },
    textFromBlocks: function (blocks) {
      if (!Array.isArray(blocks)) return ''
      var parts = []
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i]
        if (!S.isRecord(b)) continue
        if (typeof b.text === 'string') parts.push(b.text)
        else if (typeof b.content === 'string') parts.push(b.content)
        else if (Array.isArray(b.content)) parts.push(S.textFromBlocks(b.content))
      }
      return parts.join('\n')
    },
    escapeHtml: function (t) {
      return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    },
    toast: function (msg, kind) {
      var host = $('toast-host')
      var el = document.createElement('div')
      el.className = 'toast ' + (kind === 'error' ? 'toast-error' : kind === 'ok' ? 'toast-ok' : '')
      el.textContent = msg
      host.appendChild(el)
      setTimeout(function () { el.classList.add('toast-hide'); setTimeout(function () { el.remove() }, 300) }, 3200)
    },
  }

  // ---- API ----
  function apiRpc(method, payload) {
    return fetch(state.server + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ method: method, payload: payload || {} }),
    }).then(function (res) {
      return res.json()
    }).then(function (data) {
      if (!data.ok) {
        var err = new Error((data.error && data.error.message) || 'RPC 失败')
        err.code = data.error && data.error.code
        throw err
      }
      return data.value
    })
  }

  function connectEvents() {
    if (state.es) state.es.close()
    var es = new EventSource(state.server + '/api/events?token=' + encodeURIComponent(state.token))
    state.es = es
    es.onopen = function () { setConnDot(true) }
    es.onerror = function () { setConnDot(false) }
    es.onmessage = function (event) {
      var frame
      try { frame = JSON.parse(event.data) } catch (e) { return }
      handleFrame(frame)
    }
  }

  // ---- 事件折叠(与屏保同款逻辑的精简版) ----
  function handleFrame(frame) {
    if (!frame || frame.method !== 'session/event') return
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
        break
      case 'user/message': {
        var text = S.textFromBlocks(data.content)
        if (text.trim() !== '') appendMessage('user', text)
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
        var full = S.isRecord(data.message) ? S.textFromBlocks(data.message.content) : ''
        if (full !== '') replaceLastAssistant(full)
        break
      }
      case 'tool/call': {
        appendTool(data.name || '工具', typeof data.arguments === 'string' ? pretty(data.arguments) : '', false)
        break
      }
      case 'tool/result': {
        markLastTool(data.error !== undefined)
        break
      }
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') $('chat-title').textContent = data.title.trim()
        break
      }
      default:
        break
    }
  }

  function pretty(raw) {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch (e) { return raw }
  }

  // ---- 消息渲染 ----
  function appendMessage(kind, text) {
    var stream = $('chat-stream')
    var el = document.createElement('div')
    el.className = 'msg msg-' + kind
    var node = document.createTextNode(text)
    el.appendChild(node)
    el._textNode = node
    el._kind = kind
    state.messages.push(el)
    stream.appendChild(el)
    stream.scrollTop = stream.scrollHeight
    return el
  }

  function lastAssistantEl() {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i]._kind === 'assistant') return state.messages[i]
    }
    return null
  }

  function appendDelta(delta) {
    var el = lastAssistantEl()
    if (el === null) el = appendMessage('assistant', '')
    el._textNode.appendData(delta)
    el.classList.add('cursor-blink')
    var stream = $('chat-stream')
    stream.scrollTop = stream.scrollHeight
  }

  function replaceLastAssistant(full) {
    var el = lastAssistantEl()
    if (el === null) el = appendMessage('assistant', '')
    el._textNode.textContent = full
    el.classList.remove('cursor-blink')
  }

  function appendTool(name, args, failed) {
    var stream = $('chat-stream')
    var el = document.createElement('div')
    el.className = 'msg msg-tool'
    el.innerHTML = '<span class="tool-name">' + S.escapeHtml(name) + '</span>' +
      '<span class="tool-state">调用中…</span><br><pre style="margin-top:4px;white-space:pre-wrap">' +
      S.escapeHtml(args.slice(0, 300)) + '</pre>'
    el._kind = 'tool'
    el._stateEl = el.querySelector('.tool-state')
    state.messages.push(el)
    stream.appendChild(el)
    stream.scrollTop = stream.scrollHeight
    return el
  }

  function markLastTool(failed) {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var el = state.messages[i]
      if (el._kind === 'tool' && el._stateEl && el._stateEl.textContent === '调用中…') {
        el._stateEl.textContent = failed ? '失败' : '完成'
        el._stateEl.className = 'tool-state ' + (failed ? 'fail' : 'done')
        return
      }
    }
  }

  function setChatStatus(text, cls) {
    var el = $('chat-status')
    el.textContent = text
    el.className = 'chat-status' + (cls === 'running' ? ' running' : '')
  }

  function setConnDot(on) {
    var el = $('conn-dot')
    el.className = 'conn-dot ' + (on ? 'on' : 'off')
  }

  // ---- 视图切换 ----
  function showView(name) {
    var map = { connect: 'view-connect', main: 'view-main', chat: 'view-chat' }
    for (var key in map) {
      $(map[key]).classList.toggle('hidden', key !== name)
    }
  }

  // ---- 会话列表 ----
  function loadSessions() {
    var list = $('session-list')
    list.innerHTML = '<p class="empty">加载中…</p>'
    return apiRpc('session.list', {}).then(function (data) {
      var items = data.items || []
      if (items.length === 0) {
        list.innerHTML = '<p class="empty">还没有会话,去「任务」页创建一个吧</p>'
        return
      }
      list.innerHTML = ''
      items.forEach(function (item) {
        var el = document.createElement('div')
        el.className = 'item'
        var title = item.title || item.sessionId.slice(0, 16)
        var sub = item.running ? '<span class="badge running">运行中</span>' : ''
        if (item.blank) sub += '<span class="badge blank">空</span>'
        var time = item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
        el.innerHTML = '<div class="item-title">' + S.escapeHtml(title) + '</div>' +
          '<div class="item-sub">' + sub + '<span>' + S.escapeHtml(time) + '</span></div>'
        el.addEventListener('click', function () { openSession(item.sessionId) })
        list.appendChild(el)
      })
    }).catch(function (err) {
      list.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  // ---- 会话详情 ----
  function openSession(sessionId) {
    state.sessionId = sessionId
    state.lastSeq = 0
    state.messages = []
    $('chat-stream').innerHTML = ''
    $('chat-title').textContent = '会话'
    setChatStatus('加载中…', '')
    showView('chat')
    apiRpc('session.history', { sessionId: sessionId, maxMessages: 30 }).then(function (data) {
      var events = data.events || []
      events.forEach(function (entry) {
        var ev = entry && S.isRecord(entry.event) ? entry.event : entry
        handleFrame({ method: 'session/event', payload: { sessionId: sessionId, event: ev } })
      })
      setChatStatus(state.messages.length > 0 ? '已加载' : '空会话', '')
    }).catch(function (err) {
      setChatStatus('加载失败:' + err.message, '')
      S.toast('加载历史失败:' + err.message, 'error')
    })
  }

  function sendMessage() {
    var input = $('chat-input')
    var text = input.value.trim()
    if (text === '' || state.sessionId === null) return
    input.value = ''
    apiRpc('session.prompt', {
      sessionId: state.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: text }],
    }).then(function () {
      setChatStatus('运行中…', 'running')
    }).catch(function (err) {
      S.toast('发送失败:' + err.message, 'error')
      input.value = text
    })
  }

  // ---- 工作区 ----
  function loadWorkspaces() {
    var list = $('workspace-list')
    list.innerHTML = '<p class="empty">加载中…</p>'
    return apiRpc('workspace.list', {}).then(function (data) {
      var items = data.items || []
      if (items.length === 0) {
        list.innerHTML = '<p class="empty">还没有工作区</p>'
        return
      }
      list.innerHTML = ''
      items.forEach(function (item) {
        var el = document.createElement('div')
        el.className = 'item'
        el.innerHTML = '<div class="item-title">' + S.escapeHtml(item.title || item.path) + '</div>' +
          '<div class="item-sub"><span>' + S.escapeHtml(item.path) + '</span></div>'
        el.addEventListener('click', function () { selectWorkspace(item) })
        list.appendChild(el)
      })
    }).catch(function (err) {
      list.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  function selectWorkspace(item) {
    S.toast('已选择:' + (item.title || item.path), 'ok')
    fillWorkspaceSelect(item)
  }

  function fillWorkspaceSelect(selected) {
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
        o.textContent = (item.title || item.path)
        if (selected && item.workspaceId === selected.workspaceId) o.selected = true
        select.appendChild(o)
      })
    })
  }

  // ---- 模型 ----
  function loadModels() {
    return apiRpc('llm.models', {}).then(function (data) {
      var groups = data.groups || []
      var select = $('task-model')
      select.innerHTML = ''
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

  // ---- 运行任务 ----
  function runTask() {
    var prompt = $('task-prompt').value.trim()
    if (prompt === '') {
      S.toast('请填写任务描述', 'error')
      return
    }
    var workspaceId = $('task-workspace').value
    var modelValue = $('task-model').value
    var statusEl = $('task-status')
    statusEl.textContent = '正在创建会话…'
    statusEl.className = 'conn-status'
    var payload = {}
    if (workspaceId !== '') payload.workspaceId = workspaceId
    apiRpc('session.create', payload).then(function (created) {
      var sessionId = created.sessionId
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
      openSession(sessionId)
    }).catch(function (err) {
      statusEl.textContent = '启动失败:' + err.message
      statusEl.className = 'conn-status err'
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
      $('conn-status').textContent = '连接失败:' + err.message
      $('conn-status').className = 'conn-status err'
    })
  }

  function enterMain(host) {
    $('set-server').textContent = state.server
    $('set-harness').textContent = host ? ('v' + (host.version || '?') + ' · ' + (host.cwd || '')) : ''
    showView('main')
    connectEvents()
    loadSessions()
    loadWorkspaces()
    loadModels().then(function () {})
    fillWorkspaceSelect()
  }

  function disconnect() {
    if (state.es) state.es.close()
    state.es = null
    state.connected = false
    state.sessionId = null
    showView('connect')
  }

  // ---- 初始化 ----
  function init() {
    // 扫码参数:?token=xxx 或 ?server=xxx&token=xxx
    var params = new URLSearchParams(window.location.search)
    var serverParam = params.get('server')
    var tokenParam = params.get('token')
    var savedServer = localStorage.getItem('dsh-server')
    var savedToken = localStorage.getItem('dsh-token')
    if (serverParam) $('conn-server').value = serverParam
    else if (savedServer) $('conn-server').value = savedServer
    else $('conn-server').value = window.location.origin
    if (tokenParam) $('conn-token').value = tokenParam
    else if (savedToken) $('conn-token').value = savedToken

    $('btn-connect').addEventListener('click', connect)
    $('conn-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect() })

    // 自动连接:有完整参数(扫码或已保存)时直接尝试
    if ((serverParam && tokenParam) || (savedServer && savedToken)) {
      connect()
    }

    // Tab 切换
    var tabs = document.querySelectorAll('.tab-btn')
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        tabs.forEach(function (b) { b.classList.remove('active') })
        btn.classList.add('active')
        var pages = ['sessions', 'task', 'workspaces', 'settings']
        pages.forEach(function (p) {
          $('tab-' + p).classList.toggle('hidden', p !== btn.dataset.tab)
        })
        if (btn.dataset.tab === 'sessions') loadSessions()
        if (btn.dataset.tab === 'workspaces') loadWorkspaces()
      })
    })

    $('btn-new-session').addEventListener('click', function () {
      tabs[1].click()
    })
    $('btn-disconnect').addEventListener('click', disconnect)
    $('btn-task-run').addEventListener('click', runTask)
    $('btn-ws-refresh').addEventListener('click', function () {
      fillWorkspaceSelect().catch(function (err) { S.toast(err.message, 'error') })
    })
    $('btn-ws-new').addEventListener('click', function () {
      var path = prompt('请输入工作区目录的完整路径:')
      if (path && path.trim() !== '') {
        apiRpc('workspace.create', { path: path.trim() }).then(function () {
          S.toast('工作区已创建', 'ok')
          loadWorkspaces()
          fillWorkspaceSelect()
        }).catch(function (err) { S.toast('创建失败:' + err.message, 'error') })
      }
    })
    $('btn-chat-back').addEventListener('click', function () {
      state.sessionId = null
      showView('main')
      loadSessions()
    })
    $('btn-chat-send').addEventListener('click', sendMessage)
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendMessage()
      }
    })
    $('btn-chat-stop').addEventListener('click', function () {
      if (state.sessionId !== null) {
        apiRpc('session.cancel', { sessionId: state.sessionId }).then(function () {
          S.toast('已请求停止', 'ok')
        }).catch(function (err) { S.toast('停止失败:' + err.message, 'error') })
      }
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

    // 设置页模型展示
    apiRpc('llm.models', {}).then(function (data) {
      var names = (data.groups || []).map(function (g) {
        return (g.name || g.id) + ': ' + g.models.map(function (m) { return m.name || m.id }).join(', ')
      })
      $('set-models').textContent = names.join('\n') || '(未配置)'
    }).catch(function () { /* 未连接时忽略 */ })
  }

  init()
})()
