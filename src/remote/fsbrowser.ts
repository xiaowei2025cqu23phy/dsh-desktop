/**
 * PWA 端「文件夹浏览(只读:工作区/预设根目录内)」。
 *
 * 从 app.ts 按分区整段搬出:只搬运、不改写函数体,行为与拆分前一致
 * (esbuild 打成单个 IIFE,模块共享同一闭包)。
 */

import { $, S, renderMarkdown } from './util'
import { apiAction, state } from './api'
import { closeSheet, loadPresetRoots, openSheet } from './panels'

// ---- 文件夹浏览(只读:工作区/预设根目录内) ----
var fsPickMode = null   // null = 浏览;'addRoot' = 从浏览中挑选添加预设根

export function openFsBrowser(path, pickMode) {
  fsPickMode = pickMode || null
  state.fsPath = path || ''
  state.fsParent = ''
  openSheet($('view-fs'))
  loadFsList()
}

export function closeFsBrowser() {
  closeSheet($('view-fs'))
  fsPickMode = null
}

export function loadFsList() {
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

export function renderFsCrumb() {
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

export function fmtSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

export function renderFsRoots(roots) {
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

export function renderFsEntries(data) {
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

/** 换取媒体预览 ticket(短时效、绑定路径):令牌不落入 URL,只换一次。 */
export function fetchFsTicket(path) {
  return fetch(state.server + '/api/fs/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-device': state.deviceId },
    body: JSON.stringify({ path: path }),
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }).then(function (data) {
    return data && typeof data.ticket === 'string' ? data.ticket : ''
  })
}

export function openFsPreview(path, name) {
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
    // 先用 header 认证换取 ticket,再拿 ticket 构造媒体 URL——令牌不进入任何 href/src。
    fetchFsTicket(path).then(function (ticket) {
      if (ticket === '') { S.toast('媒体预览未授权或已过期', 'error'); return }
      var source = state.server + '/api/fs/stream?ticket=' + encodeURIComponent(ticket)
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
    }).catch(function () {
      S.toast('媒体预览未授权或已过期', 'error')
    })
    return
  }
  content.textContent = '加载中…'
  loadFsPreviewChunk(path, 0)
}

/** 预览底部操作行:新窗口打开(可选)+ 下载。 */
export function previewActionRow(source, name, withOpen) {
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

export function loadFsPreviewChunk(path, offset) {
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
        pre.innerHTML = renderMarkdown(data.text || '') || '(空文件)'
        pre.classList.add('rich-preview')
      } else {
        pre.textContent = data.text || '(空文件)'
        pre.classList.remove('rich-preview')
      }
    } else if (isMarkdown) {
      pre.innerHTML += renderMarkdown(data.text || '')
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

export function addPresetRoot(path) {
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
