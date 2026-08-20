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
    msgLog: [],           // [{ kind: 'user'|'assistant'|'tool'|'system', text }]
    es: null,
    workspaces: [],       // [{ workspaceId, path, title, sessions: [] }]
    presetRoots: [],      // [{ path, name }] 预设工作区根(可直接作为工作区)
    currentWsId: null,
    currentWsPath: null,
    currentWsRoot: null,  // 当前选中的预设根(作为工作区使用)
    running: false,
    tempCache: localStorage.getItem('dsh-temp-cache') === '1',
    approvals: {},        // sessionId -> [{ rpcId, sessionId, approvalId, toolName, reason }]
    approvalCards: {},    // `${sessionId}:${approvalId}` -> DOM 元素
    questions: {},        // sessionId -> { rpcId, sessionId, questions }
    questionCards: {},    // sessionId -> DOM 元素
    fsPath: '',           // 文件夹浏览当前路径('' = 根列表)
    defaultModel: null,   // { provider, model } 桌面端预设模型(host.describe)
    deviceId: localStorage.getItem('dsh-device-id') || (function () { var id = crypto.randomUUID(); localStorage.setItem('dsh-device-id', id); return id })(),
    sidebarOpen: false,   // 左侧抽屉开关状态
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
    $('btn-chat-export').classList.add('hidden')
    $('btn-chat-model').classList.add('hidden')
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
    ;(el as any)._stateEl = el.querySelector('.tool-state')
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

  // ---- 事件流 ----
  function connectEvents() {
    if (state.es) state.es.close()
    fetch(state.server + '/api/events/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId, 'x-dsh-device-label': navigator.userAgent.slice(0, 60) },
      body: '{}',
    }).then(function (res) { return res.json() }).then(function (data) {
      if (!data.ok || typeof data.ticket !== 'string') { setConnDot(false); return }
      var es = new EventSource(state.server + '/api/events?ticket=' + encodeURIComponent(data.ticket))
      state.es = es
      es.onopen = function () { setConnDot(true) }
      es.onerror = function () { setConnDot(false) }
      es.onmessage = function (event) {
        var frame
        try { frame = JSON.parse(event.data) } catch (e) { return }
        handleFrame(frame)
      }
    }).catch(function () { setConnDot(false) })
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
      $('btn-chat-export').classList.remove('hidden')
      persistCache()
      // 恢复该会话未决的审批/提问卡片(切回会话时仍可应答)
      renderPendingCards(sessionId)
    }).catch(function (err) {
      setChatStatus('加载失败:' + err.message, '')
      S.toast('加载历史失败:' + err.message, 'error')
    })
  }

  function newSession() {
    var payload: Record<string, unknown> = {}
    if (state.currentWsId) payload.workspaceId = state.currentWsId
    else if (state.currentWsRoot) payload.cwd = state.currentWsRoot
    apiRpc('session.create', payload).then(function (created) {
      openSession(created.sessionId, state.currentWsPath)
      loadSidebar()
    }).catch(function (err) {
      S.toast('新建会话失败:' + err.message, 'error')
    })
  }

  function sendMessage(mode) {
    var input = $('chat-input')
    var text = input.value.trim()
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
      if (mode === 'steer') appendMessage('user', text)
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
      var archived = new Set(wsData.archivedSessionIds || [])
      var sessions = (sessData.items || []).filter(function (s) {
        return !s.origin && !s.blank && !archived.has(s.sessionId)
      })
      sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      // 机器人通道的固定对话会话(QQ/Telegram 聊天)→ 置顶分组,手机直接看到。
      var botChatIds = new Set(info.chatSessionIds || [])
      var botChats = sessions.filter(function (s) { return botChatIds.has(s.sessionId) })
      var rest = sessions.filter(function (s) { return !botChatIds.has(s.sessionId) })
      var byPath = {}
      workspaces.forEach(function (ws) {
        ws.sessions = []
        byPath[ws.path] = ws
      })
      presetRoots.forEach(function (root) { root.sessions = [] })
      var rootByPath = {}
      presetRoots.forEach(function (root) { rootByPath[root.path] = root })
      var unmatched = []
      rest.forEach(function (s) {
        var ws = byPath[s.cwd]
        if (ws) ws.sessions.push(s)
        else if (rootByPath[s.cwd]) rootByPath[s.cwd].sessions.push(s)
        else unmatched.push(s)
      })
      state.workspaces = workspaces
      state.currentWsId = findWorkspaceId(state.currentWsPath) || state.currentWsId
      renderSidebar(unmatched, botChats, presetRoots)
    }).catch(function (err) {
      list.innerHTML = '<p class="empty">加载失败:' + S.escapeHtml(err.message) + '</p>'
    })
  }

  function sessionTitle(s) {
    return (s.projections && s.projections.values && s.projections.values.title) || '新会话'
  }

  function renderSidebar(unmatched, botChats, presetRoots) {
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
    if (state.workspaces.length === 0 && unmatched.length === 0 && (!presetRoots || presetRoots.length === 0)) {
      var empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '还没有工作区,点上方「新建工作区」添加'
      frag.appendChild(empty)
    }
    list.appendChild(frag)
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

  /** 归档会话(隐藏出列表;日志保留,可随时从会话历史找回)。 */
  function archiveSession(sessionId) {
    if (!window.confirm('归档会话 ' + sessionId + '?\n(归档后从列表隐藏,日志保留)')) return
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
    root.addEventListener('click', function () { state.fsPath = ''; loadFsList() })
    crumb.appendChild(root)
    if (state.fsPath === '') return
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
      var btn = document.createElement('button')
      btn.className = 'crumb-btn'
      btn.textContent = part
      btn.addEventListener('click', function () { state.fsPath = acc; loadFsList() })
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
    $('fsp-content').textContent = '加载中…'
    openSheet($('view-fspreview'))
    loadFsPreviewChunk(path, 0)
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
      if (offset === 0) pre.textContent = data.text || '(空文件)'
      else pre.textContent += data.text
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
    $('btn-chat-send').addEventListener('click', function () { sendMessage('queue') })
    $('btn-chat-steer').addEventListener('click', function () { sendMessage('steer') })
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
  }

  init()
})()
