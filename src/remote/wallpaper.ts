/**
 * PWA 端挂载在抽屉/工作台里的数据加载与壁纸应用。
 *
 * 从 app.ts 按分区整段搬出:只搬运、不改写函数体,行为与拆分前一致
 * (esbuild 打成单个 IIFE,模块共享同一闭包)。
 *
 * 注:原分区标题只写了"壁纸",但这段实际还包含工作台各面板的取数函数
 * (交互 / 队列 / 任务历史 / 诊断)。按内容如实命名,不再沿用误导性的标题。
 */

import { $, S } from './util'
import { apiAction } from './api'

// ---- 壁纸 ----
export function applyWallpaper(base) {
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

export function loadInteractions() {
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

export function loadWorkbench() {
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

export function loadPwaQueue() {
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

export function loadTaskHistory() {
  var host = $('set-task-history')
  apiAction('tasks.get').then(function (data) {
    var items = data.items || []
    host.textContent = items.length === 0 ? '暂无任务记录。' : items.slice(0, 20).map(function (item) {
      return item.status + ' | ' + item.description.slice(0, 70) + ' | 尝试 ' + item.attempts + (item.error ? ' | ' + item.error : '')
    }).join('\n')
  }).catch(function (err) { host.textContent = '加载失败:' + err.message })
}

export function loadDiagnostics() {
  apiAction('diagnostics.get').then(function (data) {
    $('set-diagnostics').textContent = JSON.stringify(data.report || data, null, 2)
  }).catch(function (err) { $('set-diagnostics').textContent = '加载失败:' + err.message })
}
