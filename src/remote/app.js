/**
 * DSH Remote PWA:DeepSeek Harness 手机遥控。
 * 布局参考 DeepSeek App:左侧抽屉(工作区 ⇄ 会话)+ 聊天主界面。
 */
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }

  var state = {
    server: '',
    token: '',
    connected: false,
    sessionId: null,
    lastSeq: 0,
    msgLog: [],           // [{ kind: 'user'|'assistant'|'tool'|'system', text }]
    es: null,
    workspaces: [],       // [{ workspaceId, path, title, sessions: [] }]
    currentWsId: null,
    currentWsPath: null,
    tempCache: localStorage.getItem('dsh-temp-cache') === '1',
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

  // ---- 本机临时会话缓存 ----
  function cacheKey(sid) { return 'dsh-cache-' + sid }

  function loadCachedMessages(sid) {
    try {
      var raw = localStorage.getItem(cacheKey(sid))
      return raw ? JSON.parse(raw) : null
    } catch (e) { return null }
  }

  function persistCache() {
    if (!state.tempCache || state.sessionId === null) return
    try { localStorage.setItem(cacheKey(state.sessionId), JSON.stringify(state.msgLog)) } catch (e) { /* 存储满忽略 */ }
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
    hideEmpty(false)
  }

  function appendMessage(kind, text) {
    var stream = $('chat-stream')
    hideEmpty(true)
    var el = document.createElement('div')
    el.className = 'msg msg-' + kind
    el.appendChild(document.createTextNode(text))
    stream.appendChild(el)
    state.msgLog.push({ kind: kind, text: text })
    stream.scrollTop = stream.scrollHeight
    return el
  }

  function appendTool(name, args, failed) {
    var stream = $('chat-stream')
    hideEmpty(true)
    var el = document.createElement('div')
    el.className = 'msg msg-tool'
    el.innerHTML = '<span class="tool-name">' + S.escapeHtml(name) + '</span>' +
      '<span class="tool-state">调用中…</span><br><pre style="margin-top:4px;white-space:pre-wrap">' +
      S.escapeHtml(String(args || '').slice(0, 300)) + '</pre>'
    el._stateEl = el.querySelector('.tool-state')
    stream.appendChild(el)
    state.msgLog.push({ kind: 'tool', text: name + ' 调用中' })
    stream.scrollTop = stream.scrollHeight
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
      appendMessage('assistant', '')
      last = state.msgLog[state.msgLog.length - 1]
    }
    last.text += delta
    var el = lastAssistantEl()
    if (el) {
      el.lastChild.textContent = last.text
      el.classList.add('cursor-blink')
    }
    var stream = $('chat-stream')
    stream.scrollTop = stream.scrollHeight
  }

  function replaceLastAssistant(full) {
    var last = state.msgLog[state.msgLog.length - 1]
    if (!last || last.kind !== 'assistant') {
      appendMessage('assistant', full)
      return
    }
    last.text = full
    var el = lastAssistantEl()
    if (el) {
      el.lastChild.textContent = full
      el.classList.remove('cursor-blink')
    }
    persistCache()
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
      stream.scrollTop = stream.scrollHeight
      return
    }
    appendMessage(m.kind === 'user' ? 'user' : 'assistant', m.text)
  }

  function setChatStatus(text, cls) {
    var el = $('chat-status')
    el.textContent = text
    el.className = 'chat-status' + (cls === 'running' ? ' running' : '')
  }

  function setConnDot(on) {
    $('conn-dot').className = 'conn-dot ' + (on ? 'on' : 'off')
  }

  // ---- 事件流 ----
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
        persistCache()
        break
      case 'user/message': {
        var text = S.textFromBlocks(data.content)
        if (text.trim() !== '') appendMessage('user', text)
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

  // ---- 会话 ----
  function openSession(sessionId, cwd) {
    state.sessionId = sessionId
    state.currentWsPath = cwd || state.currentWsPath
    state.currentWsId = findWorkspaceId(state.currentWsPath)
    clearChat()
    $('chat-title').textContent = '会话'
    setChatStatus('加载中…', '')
    closeSidebar()
    markCurrentRow(sessionId)

    var cached = loadCachedMessages(sessionId)
    if (cached && cached.length > 0) {
      cached.forEach(renderCachedMessage)
      setChatStatus('已加载(本机缓存)', '')
    }

    apiRpc('session.history', { sessionId: sessionId, maxMessages: 50 }).then(function (data) {
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
      persistCache()
    }).catch(function (err) {
      setChatStatus('加载失败:' + err.message, '')
      S.toast('加载历史失败:' + err.message, 'error')
    })
  }

  function newSession() {
    var payload = {}
    if (state.currentWsId) payload.workspaceId = state.currentWsId
    apiRpc('session.create', payload).then(function (created) {
      openSession(created.sessionId, state.currentWsPath)
      loadSidebar()
    }).catch(function (err) {
      S.toast('新建会话失败:' + err.message, 'error')
    })
  }

  function sendMessage() {
    var input = $('chat-input')
    var text = input.value.trim()
    if (text === '' || state.sessionId === null) {
      if (state.sessionId === null) S.toast('请先新建或选择一个会话', 'error')
      return
    }
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

  function loadSidebar() {
    var list = $('workspace-list')
    list.innerHTML = '<p class="empty">加载中…</p>'
    Promise.all([
      apiRpc('workspace.list', {}),
      apiRpc('session.list', {}),
    ]).then(function (results) {
      var wsData = results[0]
      var sessData = results[1]
      var workspaces = wsData.items || []
      var sessions = (sessData.items || []).filter(function (s) { return !s.origin })
      sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      var byPath = {}
      workspaces.forEach(function (ws) {
        ws.sessions = []
        byPath[ws.path] = ws
      })
      var unmatched = []
      sessions.forEach(function (s) {
        var ws = byPath[s.cwd]
        if (ws) ws.sessions.push(s)
        else unmatched.push(s)
      })
      state.workspaces = workspaces
      state.currentWsId = findWorkspaceId(state.currentWsPath) || state.currentWsId
      renderSidebar(unmatched)
    }).catch(function (err) {
      list.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  function sessionTitle(s) {
    return (s.projections && s.projections.values && s.projections.values.title) || '新会话'
  }

  function renderSidebar(unmatched) {
    var list = $('workspace-list')
    list.innerHTML = ''
    var frag = document.createDocumentFragment()
    if (unmatched.length > 0) {
      frag.appendChild(wsGroupElement('最近', null, unmatched, true))
    }
    state.workspaces.forEach(function (ws, i) {
      frag.appendChild(wsGroupElement(ws.title || ws.path, ws, ws.sessions, unmatched.length === 0 && i === 0))
    })
    if (state.workspaces.length === 0 && unmatched.length === 0) {
      var empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '还没有工作区,点上方「新建工作区」添加'
      frag.appendChild(empty)
    }
    list.appendChild(frag)
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

    var body = document.createElement('div')
    body.className = 'ws-body' + (openDefault ? ' open' : '')
    if (sessions.length === 0) {
      var empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '暂无会话'
      body.appendChild(empty)
    } else {
      sessions.forEach(function (s) {
        var row = document.createElement('div')
        row.className = 'session-row' + (s.sessionId === state.sessionId ? ' current' : '')
        row._sid = s.sessionId
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
        row.addEventListener('click', function () { openSession(s.sessionId, s.cwd) })
        body.appendChild(row)
      })
    }

    head.addEventListener('click', function () {
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
      row.classList.toggle('current', row._sid === sessionId)
    })
  }

  // ---- 任务 ----
  function fillWorkspaceSelect(selectedId) {
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
    })
  }

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
      closeSheet($('view-task'))
      openSession(sessionId)
      loadSidebar()
    }).catch(function (err) {
      statusEl.textContent = '启动失败:' + err.message
      statusEl.className = 'conn-status err'
    })
  }

  // ---- 弹层 ----
  function openSheet(el) { el.classList.remove('hidden') }
  function closeSheet(el) { el.classList.add('hidden') }

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
      $('conn-status').textContent = '连接失败:' + err.message
      $('conn-status').className = 'conn-status err'
    })
  }

  function enterMain(host) {
    $('set-server').textContent = state.server
    $('set-harness').textContent = host ? ('v' + (host.version || '?') + ' · ' + (host.cwd || '')) : ''
    showView('main')
    setChatStatus('空闲', '')
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
    if (state.es) state.es.close()
    state.es = null
    state.connected = false
    state.sessionId = null
    closeSidebar()
    showView('connect')
  }

  // ---- 壁纸 ----
  function applyWallpaper(base) {
    fetch((base.replace(/\/+$/, '')) + '/api/info').then(function (res) {
      return res.json()
    }).then(function (info) {
      var pos = info.wallpaperPosition || { x: 0.5, y: 0.5 }
      document.body.style.setProperty('--wallpaper-position', (pos.x * 100) + '% ' + (pos.y * 100) + '%')
      var img = new Image()
      img.onload = function () { document.body.classList.add('has-wallpaper') }
      img.onerror = function () { document.body.classList.remove('has-wallpaper') }
      img.src = base.replace(/\/+$/, '') + '/wallpaper'
    }).catch(function () {
      var img = new Image()
      img.onload = function () { document.body.classList.add('has-wallpaper') }
      img.onerror = function () { document.body.classList.remove('has-wallpaper') }
      img.src = base.replace(/\/+$/, '') + '/wallpaper'
    })
  }

  // ---- 初始化 ----
  function init() {
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
    applyWallpaper(window.location.origin)
    $('opt-temp-cache').checked = state.tempCache

    $('btn-connect').addEventListener('click', connect)
    $('conn-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect() })

    if ((serverParam && tokenParam) || (savedServer && savedToken)) connect()

    // 侧边栏
    $('btn-menu').addEventListener('click', openSidebar)
    $('btn-empty-new').addEventListener('click', newSession)
    $('btn-new-session').addEventListener('click', newSession)
    $('btn-sidebar-close').addEventListener('click', closeSidebar)
    $('sidebar-backdrop').addEventListener('click', closeSidebar)
    $('btn-new-workspace').addEventListener('click', function () {
      var path = prompt('请输入工作区目录的完整路径:')
      if (path && path.trim() !== '') {
        apiRpc('workspace.create', { path: path.trim() }).then(function () {
          S.toast('工作区已创建', 'ok')
          loadSidebar()
          fillWorkspaceSelect()
        }).catch(function (err) { S.toast('创建失败:' + err.message, 'error') })
      }
    })

    // 聊天
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
      openSheet($('view-settings'))
    })
    $('btn-settings-close').addEventListener('click', function () { closeSheet($('view-settings')) })
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
      fetch(state.server + '/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
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
  }

  init()
})()
