/**
 * 渲染进程共享工具(经典脚本,挂到 window.DSHShared)。
 * 不使用 import/export,由 tsc module:none 编译为普通脚本。
 */

type UnknownRecord = Record<string, unknown>

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 从 LLM ContentBlock 数组提取纯文本(处理 text/thinking 块)。 */
function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (typeof block.text === 'string') {
      parts.push(block.text)
    } else if (typeof block.content === 'string') {
      parts.push(block.content)
    } else if (Array.isArray(block.content)) {
      parts.push(textFromBlocks(block.content))
    }
  }
  return parts.join('\n')
}

/** 对未知载荷做防御性文本提取(用于屏保实时渲染)。 */
function extractAnyText(value: unknown, depth = 0): string {
  if (depth > 6) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      const text = extractAnyText(item, depth + 1)
      if (text !== '') parts.push(text)
    }
    return parts.join('\n')
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content !== 'undefined') {
      const text = extractAnyText(value.content, depth + 1)
      if (text !== '') return text
    }
    if (typeof value.delta === 'string') return value.delta
    if (typeof value.message !== 'undefined') {
      const text = extractAnyText(value.message, depth + 1)
      if (text !== '') return text
    }
    return ''
  }
  return ''
}

function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const host = document.getElementById('toast-host')
  if (host === null) return
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.textContent = message
  host.appendChild(el)
  setTimeout(() => {
    el.classList.add('toast-hide')
    setTimeout(() => el.remove(), 300)
  }, 3600)
}

window.DSHShared = {
  escapeHtml,
  formatTime,
  isRecord,
  textFromBlocks,
  extractAnyText,
  toast,
}
