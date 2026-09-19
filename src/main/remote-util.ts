/**
 * 远程命令处理器的纯函数工具(无 Electron/harness/类状态依赖,可独立单测)。
 * 从 remote-commands.ts 抽出:时间/身份格式化、历史事件解释、审批风险分级、有界 Map 淘汰。
 */

/** 有界 Map 淘汰:超过 cap 时删除最早插入的键,防止按会话索引的 Map 随会话数长期无限增长。 */
export function evictOldest<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next().value as K | undefined
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

export function fmtDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds} 秒` : `${minutes} 分 ${seconds % 60} 秒`
}

/** 归一化用户标识:按钮事件给裸 openid,消息侧可能带 t: 前缀(回复目标回退),比较时统一。 */
export function normUserId(id: string): string {
  return id.startsWith('t:') ? id.slice(2) : id
}

/** 相对时间描述(会话列表用)。 */
export function fmtAgo(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return '刚刚'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

/**
 * 从模型提示文本提炼会话标题:先取 [消息] 之后、去掉 [系统注记] 包装,
 * 再剥离 [xxx] 类型的声明行,取首个正文段(历史会话补名用)。
 */
export function promptTitleFrom(text: string): string {
  let t = text
  const messageIdx = t.lastIndexOf('[消息]')
  if (messageIdx >= 0) t = t.slice(messageIdx + '[消息]'.length)
  const noteIdx = t.indexOf('[系统注记]')
  if (noteIdx >= 0) t = t.slice(0, noteIdx)
  t = t
    .split('\n')
    .filter((line) => !/^\s*\[[^\]]+\]\s*$/.test(line.trim()))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
  return t.slice(0, 24)
}

export interface HistoryEventLike {
  event?: { type?: string; data?: { message?: { content?: unknown }; chunk?: unknown } }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从会话历史事件提取「最终交付文本」:text-delta chunk 流优先(即模型真正输出的内容),
 * assistant/message 兜底(推理型模型会把思考过程记成 message,不能直接当回复展示)。
 */
export function deliveredText(events: HistoryEventLike[], cap: number): string {
  let messageText = ''
  let chunkBuf = ''
  for (const entry of events) {
    const ev = entry?.event
    if (ev === undefined) continue
    const data = isRecord(ev.data) ? ev.data : {}
    if (ev.type === 'assistant/message' && isRecord(data.message) && Array.isArray(data.message.content)) {
      const text = (data.message.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')
      if (text.trim() !== '') messageText = text
    } else if (ev.type === 'assistant/chunk' && isRecord(data.chunk)) {
      const chunk = data.chunk
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        chunkBuf += chunk.text
        if (chunkBuf.length > cap * 8) chunkBuf = chunkBuf.slice(-cap * 8)
      }
    }
  }
  const chunkTail = chunkBuf.replace(/\s+/g, ' ').trim()
  if (chunkTail !== '') return chunkTail.slice(-cap)
  return messageText.replace(/\s+/g, ' ').trim().slice(0, cap)
}

/** turn/end 失败信息:提取错误消息与 TRANSPORT 中断标记;非失败回合返回 null。 */
export function turnEndFailure(ev: Record<string, unknown>): { message: string; isTransport: boolean; failed: boolean } | null {
  const data = isRecord(ev.data) ? ev.data : {}
  const reason = isRecord(data.reason) ? data.reason : {}
  const detail = reason.error ?? reason.failure
  const message = typeof detail === 'object' && detail !== null && typeof (detail as { message?: unknown }).message === 'string'
    ? (detail as { message: string }).message
    : typeof reason.message === 'string'
      ? reason.message
      : ''
  const failed = reason.kind === 'error'
  const isTransport = failed && (reason.code === 'TRANSPORT' || (message !== '' && message.includes('finish_reason')))
  return failed ? { message, isTransport, failed } : null
}

/**
 * 审批风险分级:决定「谁」有应答权(职责分离)。
 *
 * 高风险 = 聊天侧的「允许」无效,只能转桌面端确认:
 *  - 删除/破坏类工具(rm/delete/remove/trash/unlink/mv 覆盖等);
 *  - 执行类工具(bash/exec/shell/run)且理由涉及删除、权限提升或越权路径;
 *  - 理由明确请求完全访问(danger-full-access / full-access / 完全访问 / 不受限);
 *  - 理由表明路径在工作区之外(工作区外 / 任意路径 / 越权);
 *  - 写入类工具(write/edit/save/create/mkdir/patch/apply/upload/put)一律按高风险保守处理
 *    —— 写入可能落在工作区之外,聊天端看不到完整路径,只有桌面端能核对后再决定。
 *
 * 低风险 = 只读浏览(glob/read/list/cat 等)与理由不含任何越权信号的工具调用。
 */
export function approvalRisk(toolName: string, reason: string): 'high' | 'low' {
  // 工具名多为 snake_case / camelCase:先拆成词(下划线/连字符视为分隔),再按词匹配。
  const tool = toolName.toLowerCase().replace(/[_-]+/g, ' ').trim()
  const text = reason.toLowerCase()
  // 删除/破坏类工具。
  if (/\b(rm|del(ete)?|remove|trash|unlink|rmdir|purge|destroy|wipe)\b/.test(tool) || /删除|移除|清空|覆盖|删除文件|销毁/.test(text)) {
    return 'high'
  }
  // 完全访问 / 越权 cwd 请求。
  if (/danger-full-access|full[\s-]*access|完全访问|不受限|任意路径|工作区外|越权/.test(text)) {
    return 'high'
  }
  // 执行类工具:能运行任意命令;理由若含删除/权限提升/越权路径则高风险。
  if (/\b(bash|exec|shell|sh|run|eval|command|spawn)\b/.test(tool)) {
    if (/rm |delete|sudo|chmod|chown|chgrp|curl|wget|>|>>|工作区外|任意路径|越权/.test(text)) return 'high'
    // 无参数线索的执行类调用(如「执行 rm」的 reason 就含 rm)按保守高风险。
    if (text.includes('rm') || text.includes('删除') || text.includes('执行')) return 'high'
  }
  // 写入类工具:保守按高风险(聊天端无法核对写入路径)。
  if (/\b(write|edit|save|create|mkdir|patch|apply|upload|put|publish|deploy|install|uninstall)\b/.test(tool)) {
    return 'high'
  }
  return 'low'
}
