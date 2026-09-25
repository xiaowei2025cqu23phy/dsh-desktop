/**
 * PWA 端本机临时会话缓存(localStorage)。
 *
 * 只在用户于设置里打开「临时缓存」时启用:会话内容留在手机上,断网重进也能看到
 * 上次的消息。防抖写入,避免流式输出期间每个 token 都写一次存储。
 */

import { state } from './api'

/** 缓存上限:只保留最近 N 条,避免 localStorage 越写越慢、越占越大。 */
export var CACHE_MAX_MSGS = 300

export function cacheKey(sid) { return 'dsh-cache-' + sid }

export var cacheTimer: ReturnType<typeof setTimeout> | null = null

export function loadCachedMessages(sid) {
  try {
    var raw = localStorage.getItem(cacheKey(sid))
    return raw ? JSON.parse(raw) : null
  } catch (e) { return null }
}

/** 防抖持久化:事件密集(流式输出)时合并写入,手机端明显更跟手。 */

export function persistCache() {
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

export function flushCacheNow() {
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

export function clearAllCache() {
  var keys = []
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i)
    if (k && k.indexOf('dsh-cache-') === 0) keys.push(k)
  }
  keys.forEach(function (k) { localStorage.removeItem(k) })
}

// ---- 消息渲染 ----
