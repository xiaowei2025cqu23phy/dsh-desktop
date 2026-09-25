/**
 * PWA 端设置面板里的若干数据加载(定时任务 / 预设工作区根 / 今日用量 / 工作区健康)。
 *
 * 这些是纯"取数填 DOM"的函数,不参与主流程状态机,单独成模块便于按需查看与修改。
 */

import { $, S } from './util'
import { apiAction, state } from './api'

export function openSheet(el) { el.classList.remove('hidden') }

export function closeSheet(el) { el.classList.add('hidden') }

// ---- 手机壁纸选择 ----
/** Upload a wallpaper image chosen from the phone's own gallery. */

export function loadScheduled() {
  var host = $('sched-list')
  fetch(state.server + '/api/tasks', {
    signal: AbortSignal.timeout(10000),
    headers: { authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId },
  })
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

export function loadPresetRoots() {
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

export function loadUsage() {
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

export function loadHealth() {
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
