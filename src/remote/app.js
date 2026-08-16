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
    approvals: {},        // sessionId -> [{ rpcId, sessionId, approvalId, toolName, reason }]
    approvalCards: {},    // `${sessionId}:${approvalId}` -> DOM 元素
    questions: {},        // sessionId -> { rpcId, sessionId, questions }
    questionCards: {},    // sessionId -> DOM 元素
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

  /** 应答服务端请求(审批 / 提问),与桌面端机器人通道同一路径。返回 {accepted, reason?}。 */
  function apiRespond(rpcId, result) {
    return fetch(state.server + '/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ type: 'client-response', rpcId: rpcId, result: result }),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    })
  }

  /** 控制动作(白名单,桌面端执行;用于预设工作区目录等)。 */
  function apiAction(action, extra) {
    return fetch(state.server + '/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
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
    $('chat-stream').querySelectorAll('.interaction-card').forEach(function (el) { el.remove() })
    state.approvalCards = {}
    state.questionCards = {}
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
    stream.scrollTop = stream.scrollHeight
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
    stream.scrollTop = stream.scrollHeight
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
      // 恢复该会话未决的审批/提问卡片(切回会话时仍可应答)
      renderPendingCards(sessionId)
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
    apiRpc('workspace.create', { path: path }).then(function () {
      S.toast('工作区已就绪:' + name, 'ok')
      statusEl.textContent = ''
      closeSheet($('view-newws'))
      loadSidebar()
      fillWorkspaceSelect()
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
    apiAction('workspace.createNew', { root: root, name: name }).then(function () {
      S.toast('工作区已创建:' + name, 'ok')
      statusEl.textContent = ''
      $('newws-name').value = ''
      closeSheet($('view-newws'))
      loadSidebar()
      fillWorkspaceSelect()
    }).catch(function (err) {
      statusEl.textContent = '创建失败:' + err.message
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
      closeSidebar()
      openNewWsSheet()
    })

    // 新建工作区弹层
    $('btn-newws-close').addEventListener('click', function () { closeSheet($('view-newws')) })
    $('btn-newws-create').addEventListener('click', createNewWorkspace)

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
