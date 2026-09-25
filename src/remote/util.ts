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

/**
 * 极小 markdown 渲染器(agent 输出常见语法)。
 *
 * 为什么不用现成库:手机端产物要保持单文件、无依赖(见 scripts/build-remote.mjs),
 * 为几百字节的语法引入一个 parser 不划算。这里只覆盖实际会遇到的子集:
 * 围栏代码块 / 标题 / 无序与有序列表 / 引用 / 表格 / 分割线 / 行内代码与粗斜体 / 链接。
 *
 * 顺序很重要(旧实现在这一点上是错的):
 * 1. 先把整个文本转义,HTML 结构一律由本函数生成,不信任输入;
 * 2. **先把代码区提出来存成占位符**——否则后续的行内替换会改到代码内容
 *    (旧实现就出现过 `**` 与反引号替换把已生成的标签内部一起改掉);
 * 3. 再做块级(标题/列表/引用/表格),最后做行内;
 * 4. 最后回填代码块(此时它已是 <pre> 片段,不再参与替换)。
 */
export function renderMarkdown(src: unknown): string {
  const escaped = S.escapeHtml(String(src ?? ''))
  const codeBlocks: string[] = []
  // 占位符用不合法的字符序列,确保不会与正文冲突(输入已被转义,不含 \u0000)。
  const placeholder = (i: number): string => `\u0000CODE${i}\u0000`

  // 1) 围栏代码块(含语言标注)
  let text = escaped.replace(/```([a-zA-Z0-9+#._-]*)\r?\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const cls = lang !== '' ? ` class="md-code lang-${lang.toLowerCase()}"` : ' class="md-code"'
    codeBlocks.push(`<pre${cls}><code>${code.replace(/\r?\n$/, '')}</code></pre>`)
    return placeholder(codeBlocks.length - 1)
  })
  // 未闭合的围栏(流式输出中途):按普通文本处理,不要吞掉后续内容。
  text = text.replace(/```([a-zA-Z0-9+#._-]*)\r?\n([\s\S]*)$/g, (_m, lang: string, code: string) => {
    const cls = lang !== '' ? ` class="md-code lang-${lang.toLowerCase()}"` : ' class="md-code"'
    codeBlocks.push(`<pre${cls}><code>${code.replace(/\r?\n$/, '')}</code></pre>`)
    return placeholder(codeBlocks.length - 1)
  })

  // 2) 表格:每行以 | 开头、以 | 结尾,连续两行以上;第二行是分隔行时成表。
  //    注意末尾不能写 [ \t]* —— 它会吃到行尾换行,导致第三行无法接续(只吃到两行)。
  text = text.replace(/(?:^\|.*\|(?:\r?\n|$)){2,}/gm, (block: string) => {
    const rows = block.trim().split(/\r?\n/)
    const cells = (line: string): string[] => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    const isSeparator = (line: string): boolean => /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-')
    if (rows.length < 2 || !isSeparator(rows[1])) return block
    const head = cells(rows[0]).map((c) => `<th>${c}</th>`).join('')
    const body = rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
    return `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>\n`
  })

  // 3) 块级:标题 / 分割线 / 引用 / 列表
  text = text
    .replace(/^######[ \t]+(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#####[ \t]+(.+)$/gm, '<h5>$1</h5>')
    .replace(/^####[ \t]+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###[ \t]+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^##[ \t]+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#[ \t]+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^(?:---|\*\*\*|___)[ \t]*$/gm, '<hr />')
    .replace(/^&gt;[ \t]?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^[ \t]*[-*+][ \t]+(.+)$/gm, '<li>$1</li>')
    .replace(/^[ \t]*\d+\.[ \t]+(.+)$/gm, '<li>$1</li>')
  // 连续的 <li> 包进 <ul>(简单折叠,不做嵌套)
  text = text.replace(/(?:<li>[\s\S]*?<\/li>\r?\n?)+/g, (block: string) => `<ul>${block.replace(/\r?\n/g, '')}</ul>`)
  // 相邻 blockquote 合并
  text = text.replace(/(?:<blockquote>[\s\S]*?<\/blockquote>\r?\n?)+/g, (block: string) => `<blockquote>${block.replace(/<\/?blockquote>/g, '').replace(/\r?\n/g, '<br />')}</blockquote>`)

  // 4) 行内(此时代码块已不在 text 里)
  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  // 5) 段落与换行:空行分段,单换行 <br />
  const html = text
    .split(/\r?\n{2,}/)
    .map((para) => (para.trim() === '' ? '' : /^<(h[2-6]|ul|ol|pre|blockquote|table|hr)/.test(para.trim()) ? para : `<p>${para.replace(/\r?\n/g, '<br />')}</p>`))
    .join('')

  // 6) 回填代码块
  return html.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? '')
}
