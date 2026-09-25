/**
 * PWA 端纯工具:不持有状态、不碰业务逻辑,方便单测与被各模块复用。
 *
 * 说明:原本这些函数定义在 app.ts 的 IIFE 里。拆分后由 esbuild 打包成单个 IIFE,
 * 模块间共享同一个闭包,行为与拆分前一致。
 */

type AnyRecord = Record<string, unknown>

/**
 * 按 id 取元素(宽松类型:$ 返回 any,历史代码逐步收紧中)。
 *
 * 放在 util 里供各模块共用 —— 拆分前它是 app.ts 顶部的局部 var,拆分后如果每个模块
 * 各自复制一份,就会出现"某个模块的 $ 行为被改而其它模块没跟上"的经典漂移。
 */
export function $ (id: string): any { return document.getElementById(id) }

export const S = {
  isRecord: function (v: unknown): v is AnyRecord {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  },
  /** 从内容块提取文本与图片(排除思维链/推理块,对话里只显示答案)。 */
  blocksParts: function (blocks: unknown): { text: string; images: Array<AnyRecord> } {
    let text = ''
    const images: Array<AnyRecord> = []
    if (Array.isArray(blocks)) {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]
        if (!S.isRecord(b)) continue
        // 推理/思维链块不显示(不占屏),仅保留文本与图片。
        if (b.type === 'reasoning' || b.type === 'thinking' || b.type === 'reasoning-text') continue
        let innerText = ''
        if (typeof b.text === 'string') innerText = b.text
        else if (typeof b.content === 'string') innerText = b.content
        else if (Array.isArray(b.content)) {
          const inner = S.blocksParts(b.content)
          innerText = inner.text
          for (let k = 0; k < inner.images.length; k++) images.push(inner.images[k])
        }
        if (innerText !== '') text += (text === '' ? '' : '\n') + innerText
        if (b.type === 'image') {
          const attachment = b.attachment
          if (S.isRecord(attachment) && typeof attachment.attachmentId === 'string') {
            images.push({
              attachmentId: attachment.attachmentId,
              mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : 'image/png',
              name: typeof attachment.name === 'string' ? attachment.name : '',
            })
          } else if (typeof b.data === 'string' && b.data !== '') {
            images.push({ dataUrl: b.data.indexOf('data:') === 0 ? b.data : 'data:image/png;base64,' + b.data })
          }
        }
      }
    }
    return { text: text, images: images }
  },
  escapeHtml: function (t: unknown): string {
    return String(t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  },
  toast: function (msg: string, kind?: string): void {
    toast(msg, kind)
  },
}

/** 轻提示。需要 toast 宿主元素,故按 id 查找(与拆分前一致)。 */
export function toast(msg: string, kind?: string): void {
  const host = document.getElementById('toast-host')
  if (host === null) return
  const el = document.createElement('div')
  el.className = 'toast ' + (kind === 'error' ? 'toast-error' : kind === 'ok' ? 'toast-ok' : '')
  el.textContent = msg
  host.appendChild(el)
  setTimeout(function () {
    el.classList.add('toast-hide')
    setTimeout(function () { el.remove() }, 300)
  }, 3200)
}
