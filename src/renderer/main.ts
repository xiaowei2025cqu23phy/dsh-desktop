/**
 * 主窗口逻辑:状态轮询、模型切换、屏保设置抽屉、Provider 向导、日志。
 * 经典脚本(无 import/export),整体包在 IIFE 中避免全局命名冲突。
 */

(() => {

function $id(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing element #${id}`)
  return el
}

function input(id: string): HTMLInputElement { return $id(id) as HTMLInputElement }
function select(id: string): HTMLSelectElement { return $id(id) as HTMLSelectElement }

const S = window.DSHShared
const API = window.dshDesktop
let discoveredGatewayModels: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }> = []

interface HarnessConfigView {
  mode: 'auto' | 'external' | 'managed'
  url: string
  port: number
  command: string
  autoStart: boolean
  restartOnCrash: boolean
  stopOnQuit: boolean
  dshHome: string | null
  cwd: string | null
}

const GATEWAY_PRESETS: Array<{ label: string; baseURL: string; api: string }> = [
  { label: 'DeepSeek 官方(OpenAI 兼容)', baseURL: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', api: 'openai-completions' },
  { label: 'Ollama 本地', baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
  { label: '自定义网关', baseURL: '', api: 'openai-completions' },
]

const STATE_LABEL: Record<string, string> = {
  idle: '未启动', probing: '探测中…', external: '已连接外部服务', running: '运行中',
  starting: '启动中…', stopping: '停止中…', stopped: '已停止', error: '错误',
}

let lastBaseUrl = ''
/** 当前查看的实例:stable = 主实例(默认),preview = 实验预览实例。 */
let viewSource: 'stable' | 'preview' = 'stable'
let previewStatus: HarnessStatus | null = null
  let drawerOpen = false
  let logsTimer: ReturnType<typeof setInterval> | null = null
  let webviewWallpaperKey: string | null = null
  let webviewFailed = false
  /** 内嵌页加载失败后的自动重试(重启后 harness 启动期会先失败几次)。 */
  let webviewReloadTimer: ReturnType<typeof setTimeout> | null = null
  /** 连续失败次数:成功(did-finish-load)清零;超过上限停止自动重试,避免死循环。 */
  let webviewFailStreak = 0

/** 排期一次内嵌页自动重载(间隔 2 秒;连续失败上限 12 次 ≈ 24 秒后停手)。 */
function scheduleWebviewRetry(): void {
  const view = harnessView()
  if (webviewReloadTimer !== null || webviewFailStreak >= 12) return
  webviewReloadTimer = setTimeout(() => {
    webviewReloadTimer = null
    webviewFailStreak += 1
    if (webviewFailed) view.reload()
  }, 2000)
}

function harnessView(): WebviewElement {
  return document.getElementById('harness-view') as unknown as WebviewElement
}

/** 把主窗口壁纸注入内嵌 harness Web UI 背景,让对话页也透出壁纸。 */
async function syncWebviewWallpaper(): Promise<void> {
  const view = harnessView()
  const remove = async (): Promise<void> => {
    if (webviewWallpaperKey !== null) {
      try {
        await view.removeInsertedCSS(webviewWallpaperKey)
      } catch {
        /* 页面可能已重建,忽略。 */
      }
      webviewWallpaperKey = null
    }
  }
  try {
    if (!document.body.classList.contains('has-wallpaper')) {
      await remove()
      return
    }
    const { dataUrl, position } = await API.appearance.wallpaperData('window')
    if (dataUrl === null) {
      await remove()
      return
    }
    // 注入前用 canvas 压缩到最长边 2560 的 JPEG,避免超大 data URL 拖慢内嵌页面。
    const compressed = await compressImageDataUrl(dataUrl, 2560, 0.82)
    if (compressed === null) {
      await remove()
      return
    }
    await remove()
    const css = `html { background-image: url("${compressed}") !important; background-size: cover !important; ` +
      `background-position: ${position.x * 100}% ${position.y * 100}% !important; ` +
      `background-repeat: no-repeat !important; } ` +
      `html, body, [class$="_frame"], [class$="_root"], [class$="_sidebarCol"] { background-color: transparent !important; }`
    webviewWallpaperKey = await view.insertCSS(css)
  } catch (error) {
    console.error('[wallpaper] 内嵌页面注入失败:', error)
  }
}

/** 用 canvas 缩放压缩图片 data URL(最长边限制 + JPEG 质量)。 */
function compressImageDataUrl(dataUrl: string, maxEdge: number, quality: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
        const width = Math.max(1, Math.round(img.naturalWidth * scale))
        const height = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (ctx === null) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

async function refreshStatus(): Promise<void> {
  let status: HarnessStatus
  try {
    status = await API.harness.getStatus()
  } catch {
    return
  }
  // 预览实例状态(顶栏按钮角标 + 设置面板状态)。
  try {
    previewStatus = await API.preview.getStatus()
  } catch {
    previewStatus = null
  }
  refreshPreviewChip()
  // 桌面宠物:连接/运行状态驱动动画节奏。
  petBusy = status.state === 'running' || status.state === 'external'
  lastStableBaseUrl = status.baseUrl
  // 工作台概览:Harness 状态卡(顶栏已精简)。
  const harnessStat = $id('stat-harness')
  harnessStat.textContent = STATE_LABEL[status.state] ?? status.state
  harnessStat.className = 'wb-stat-value wb-stat-value-sm' +
    (status.state === 'running' || status.state === 'external' ? ' stat-ok'
      : status.state === 'error' ? ' stat-err'
        : status.state === 'idle' || status.state === 'stopped' ? ' stat-dim' : ' stat-warn')
  const view = harnessView()
  // 查看目标:预览实例就绪时可按顶栏按钮切换。
  const activeUrl = viewSource === 'preview' && previewStatus !== null && previewStatus.baseUrl !== ''
    ? previewStatus.baseUrl
    : status.baseUrl
  if (activeUrl !== lastBaseUrl) {
    lastBaseUrl = activeUrl
    view.src = activeUrl
  }
  const modelSelect = select('model-select')
  if ((status.state === 'running' || status.state === 'external') && modelSelect.disabled) {
    modelSelect.disabled = false
    void loadModels()
  }
  // harness 就绪后,若内嵌页面之前加载失败(启动期连接被拒),自动重载并重试到成功。
  if ((status.state === 'running' || status.state === 'external') && webviewFailed) {
    scheduleWebviewRetry()
  }
  if (status.state === 'error') {
    const text = $id('view-error-text')
    text.textContent = status.error ?? '未知错误'
    $id('view-error').classList.remove('hidden')
  }
}

async function loadModels(): Promise<void> {
  let result: ModelsListResult
  try {
    result = await API.models.list()
  } catch (error) {
    S.toast(`读取模型失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  const modelSelect = select('model-select')
  const previous = modelSelect.value
  modelSelect.innerHTML = ''
  if (result.groups.length === 0) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = '尚未配置任何模型(去 Web UI 的 设置 → Models 添加)'
    modelSelect.appendChild(option)
    modelSelect.disabled = true
    return
  }
  for (const group of result.groups) {
    const optgroup = document.createElement('optgroup')
    optgroup.label = group.name ?? group.id
    for (const model of group.models) {
      const option = document.createElement('option')
      option.value = `${group.id}|${model.id}`
      option.textContent = model.name ?? model.id
      optgroup.appendChild(option)
    }
    modelSelect.appendChild(optgroup)
  }
  if (result.selected !== null) {
    const selectedValue = `${result.selected.provider}|${result.selected.model}`
    if (Array.from(modelSelect.options).some((option) => option.value === selectedValue)) {
      modelSelect.value = selectedValue
    }
  } else if (previous !== '' && Array.from(modelSelect.options).some((option) => option.value === previous)) {
    modelSelect.value = previous
  }
}

async function applyModelSelection(): Promise<void> {
  const value = select('model-select').value
  if (value === '') return
  const [provider, model] = value.split('|')
  try {
    await API.models.setDefault(provider, model)
    S.toast(`默认模型已切换:${provider} / ${model}`, 'ok')
  } catch (error) {
    S.toast(`切换失败:${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

// ---- 设置抽屉 ----

async function loadActivities(): Promise<void> {
  const host = $id('activity-list')
  try {
    const items = await API.activity.list()
    host.textContent = ''
    if (items.length === 0) {
      host.textContent = '暂无活动。'
      return
    }
    items.slice(0, 30).forEach((item) => {
      const row = document.createElement('div')
      row.className = 'queue-row'
      row.textContent = `${new Date(item.updatedAt).toLocaleString()} | ${item.status} | ${item.source}/${item.type} | ${item.title}\n${item.lastEvent}${item.workspace === null ? '' : `\n工作区:${item.workspace}`}`
      row.title = '点击查看详情'
      row.addEventListener('click', () => void showActivityDetail(item))
      host.appendChild(row)
    })
  } catch (error) {
    host.textContent = `加载失败:${error instanceof Error ? error.message : String(error)}`
  }
}

async function showActivityDetail(item: { id: string; type: string; source: string; workspace: string | null; sessionId: string | null; status: string; title: string; lastEvent: string; createdAt: number; updatedAt: number }): Promise<void> {
  $id('ad-title').textContent = `活动详情:${item.title.slice(0, 40)}`
  let related = ''
  try {
    const audits = await API.audit.list()
    const filtered = audits.filter((entry) => (entry.activityId === item.id) || (item.sessionId !== null && entry.sessionId === item.sessionId))
    related = filtered.length === 0 ? '(无关联审计记录)' : filtered.map((entry) => `${new Date(entry.time).toLocaleString()} | ${entry.type}\n${entry.detail}`).join('\n\n')
  } catch {
    related = '(审计加载失败)'
  }
  let workspaceChanges = ''
  if (item.workspace !== null) {
    try {
      const result = await API.workspace.changes(item.workspace, false)
      workspaceChanges = result.unavailable ? '(非 Git 仓库或不可用)' : `\n${result.status === '' ? '(工作区干净)' : result.status ?? ''}`
    } catch {
      workspaceChanges = '(变更读取失败)'
    }
  }
  $id('ad-body').textContent = [
    `ID: ${item.id}`,
    `类型: ${item.source}/${item.type}`,
    `状态: ${item.status}`,
    `会话: ${item.sessionId ?? '(无)'}`,
    `工作区: ${item.workspace ?? '(无)'}`,
    `创建: ${new Date(item.createdAt).toLocaleString()}`,
    `更新: ${new Date(item.updatedAt).toLocaleString()}`,
    `最近事件: ${item.lastEvent}`,
    item.workspace === null ? '' : `\n── 工作区 Git 变更 ──${workspaceChanges}`,
    '',
    '── 关联审计 ──',
    related,
  ].join('\n')
  $id('activity-detail').classList.remove('hidden')
}

async function loadAudit(): Promise<void> {
  const host = $id('audit-list')
  try {
    const items = await API.audit.list()
    host.textContent = items.length === 0 ? '暂无审计记录。' : items.slice(0, 50).map((item) => `${new Date(item.time).toLocaleString()} | ${item.type}\n${item.detail}`).join('\n\n')
  } catch (error) {
    host.textContent = `加载失败:${error instanceof Error ? error.message : String(error)}`
  }
}

async function suggestMemory(): Promise<void> {
  const path = input('memory-path').value.trim()
  if (path === '') { $id('memory-status').textContent = '请先选择或填写工作区路径。'; return }
  try {
    const suggest = await API.memory.suggest(path)
    if (suggest.summary === '' && suggest.commands === '') {
      $id('memory-status').textContent = '未找到 README 或 package.json,无法生成草稿。'
      return
    }
    const summary = (input('memory-summary') as unknown as HTMLTextAreaElement)
    const commands = (input('memory-commands') as unknown as HTMLTextAreaElement)
    if (suggest.summary !== '' && summary.value.trim() === '') summary.value = suggest.summary
    if (suggest.commands !== '' && commands.value.trim() === '') commands.value = suggest.commands
    $id('memory-status').textContent = '已生成草稿(未保存),请确认后点击保存。'
  } catch (error) {
    $id('memory-status').textContent = `生成草稿失败:${error instanceof Error ? error.message : String(error)}`
  }
}

async function loadMemory(): Promise<void> {
  const path = input('memory-path').value.trim()
  if (path === '') { $id('memory-status').textContent = '请先填写工作区路径。'; return }
  const memory = await API.memory.get(path)
  input('memory-enabled').checked = memory.enabled
  ;(input('memory-summary') as unknown as HTMLTextAreaElement).value = memory.summary
  ;(input('memory-conventions') as unknown as HTMLTextAreaElement).value = memory.conventions
  ;(input('memory-commands') as unknown as HTMLTextAreaElement).value = memory.commands
  ;(input('memory-notes') as unknown as HTMLTextAreaElement).value = memory.notes
  $id('memory-status').textContent = memory.updatedAt === 0 ? '该工作区尚无本地记忆。' : `已读取，更新于 ${new Date(memory.updatedAt).toLocaleString()}`
}

async function saveMemory(): Promise<void> {
  const path = input('memory-path').value.trim()
  if (path === '') { $id('memory-status').textContent = '请先填写工作区路径。'; return }
  await API.memory.set(path, {
    enabled: input('memory-enabled').checked,
    summary: (input('memory-summary') as unknown as HTMLTextAreaElement).value,
    conventions: (input('memory-conventions') as unknown as HTMLTextAreaElement).value,
    commands: (input('memory-commands') as unknown as HTMLTextAreaElement).value,
    notes: (input('memory-notes') as unknown as HTMLTextAreaElement).value,
  })
  $id('memory-status').textContent = '已保存到本机。'
  await loadAudit()
}

async function clearMemory(): Promise<void> {
  const path = input('memory-path').value.trim()
  if (path === '') return
  await API.memory.clear(path)
  await loadMemory()
  await loadAudit()
}

async function loadNotificationConfig(): Promise<void> {
  const config = await API.notifications.getConfig()
  input('notify-enabled').checked = config.enabled
  input('notify-approval').checked = config.approval
  input('notify-question').checked = config.question
  input('notify-task-done').checked = config.taskDone
  input('notify-task-fail').checked = config.taskFail
  input('notify-update').checked = config.update === true
  input('notify-quiet').checked = config.quietHoursEnabled
  input('notify-quiet-start').value = String(config.quietStart)
  input('notify-quiet-end').value = String(config.quietEnd)
  input('notify-urgent-bypass').checked = config.urgentBypassQuiet
}

async function saveNotificationConfig(patch: object): Promise<void> {
  await API.notifications.setConfig(patch)
}

async function loadTaskHistory(): Promise<void> {
  const host = $id('task-history-report')
  try {
    const tasks = await API.tasks.history()
    host.textContent = tasks.length === 0 ? '暂无任务记录。' : tasks.slice(0, 20).map((task) => `${task.status} | ${task.description.slice(0, 80)} | 尝试 ${task.attempts} 次${task.error === undefined ? '' : ` | ${task.error}`}`).join('\n')
  } catch (error) {
    host.textContent = `加载失败:${error instanceof Error ? error.message : String(error)}`
  }
}

async function loadInteractions(): Promise<void> {
  const host = $id('interaction-list')
  try {
    const items = await API.interactions.list()
    host.textContent = ''
    if (items.length === 0) {
      host.textContent = '当前没有待审批或待回答的问题。'
      return
    }
    items.forEach((item) => {
      const row = document.createElement('div')
      row.className = 'interaction-row'
      row.textContent = `${item.kind === 'approval' ? '⚠️' : '❓'} ${item.title}\n${item.detail}\n会话:${item.sessionId}`
      if (item.kind === 'approval' && item.approvalId) {
        const allow = document.createElement('button')
        allow.className = 'btn btn-sm'
        allow.textContent = '允许'
        allow.addEventListener('click', async () => { allow.disabled = true; allow.textContent = await API.interactions.respondApproval(item.sessionId, item.approvalId!, 'allowed-once'); await loadInteractions() })
        const reject = document.createElement('button')
        reject.className = 'btn btn-sm btn-danger'
        reject.textContent = '拒绝'
        reject.addEventListener('click', async () => { reject.disabled = true; reject.textContent = await API.interactions.respondApproval(item.sessionId, item.approvalId!, 'rejected'); await loadInteractions() })
        row.append(allow, reject)
      } else if (item.kind === 'question' && item.questionId && item.options) {
        item.options.forEach((label, index) => {
          const button = document.createElement('button')
          button.className = 'btn btn-sm'
          button.textContent = `${index + 1}. ${label}`
          button.addEventListener('click', async () => { button.disabled = true; button.textContent = await API.interactions.respondQuestion(item.sessionId, item.questionId!, index); await loadInteractions() })
          row.appendChild(button)
        })
      }
      host.appendChild(row)
    })
  } catch (error) {
    host.textContent = `加载失败:${error instanceof Error ? error.message : String(error)}`
  }
}

function switchView(view: 'workbench' | 'workspaces' | 'session'): void {
  const isWorkbench = view === 'workbench'
  const isWorkspaces = view === 'workspaces'
  $id('view-workbench').classList.toggle('hidden', !isWorkbench)
  $id('view-workspaces').classList.toggle('hidden', !isWorkspaces)
  harnessView().classList.toggle('hidden', isWorkbench || isWorkspaces)
  $id('nav-workbench').classList.toggle('active', isWorkbench)
  $id('nav-workspaces').classList.toggle('active', isWorkspaces)
  $id('nav-session').classList.toggle('active', !isWorkbench && !isWorkspaces)
  if (isWorkbench) void loadWorkbench()
  if (isWorkspaces) void loadWorkspaces()
}

let selectedWorkspacePath: string | null = null

async function loadWorkspaces(): Promise<void> {
  const host = $id('workspace-list')
  try {
    const items = await API.workspace.health()
    host.textContent = ''
    if (items.length === 0) {
      host.textContent = '暂无已注册工作区。'
      return
    }
    items.forEach((item) => {
      const row = document.createElement('div')
      row.className = 'queue-row'
      const state = item.exists && item.readable && item.writable ? '✓ 正常' : '⚠️ 需检查'
      const free = item.freeBytes === null ? '' : ` / 可用 ${(item.freeBytes / 1073741824).toFixed(1)} GB`
      row.textContent = `${state} ${item.title ?? item.path}${free}\n${item.path}`
      if (selectedWorkspacePath !== null && item.path === selectedWorkspacePath) row.classList.add('selected')
      row.addEventListener('click', () => {
        selectedWorkspacePath = item.path
        void showWorkspaceDetail(item)
        void loadWorkspaces()
      })
      host.appendChild(row)
    })
  } catch (error) {
    host.textContent = `加载失败:${error instanceof Error ? error.message : String(error)}`
  }
}

async function loadWorkspaceChanges(diff = false): Promise<void> {
  const host = $id('workspace-changes')
  if (selectedWorkspacePath === null) { host.textContent = '请先选择工作区。'; return }
  try {
    const result = await API.workspace.changes(selectedWorkspacePath, diff)
    if (result.unavailable) {
      host.textContent = result.message === undefined ? '该目录不是 Git 仓库或 Git 不可用。' : result.message
      return
    }
    host.textContent = diff ? (result.diff === '' ? '(没有未提交 diff)' : `${result.summary ?? ''}\n${result.diff ?? ''}${result.truncated ? '\n\n(diff 已截断)' : ''}`) : (result.status === '' ? '(工作区干净)' : result.status ?? '(无状态)')
  } catch (error) {
    host.textContent = `读取变更失败:${error instanceof Error ? error.message : String(error)}`
  }
}

/** 文件选择器:把选中的第一个目录填入输入框(取消/失败时保留原值)。 */
async function pickDirectoryInto(inputId: string): Promise<string | null> {
  try {
    const dirs = await API.dialog.pickDirectories()
    if (dirs.length === 0) return null
    const path = dirs[0]
    input(inputId).value = path
    return path
  } catch (error) {
    S.toast(`选择文件夹失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    return null
  }
}

/** 打开任意目录作为工作区详情:健康信息有则显示,未注册时仅记忆/变更/活动可用。 */
async function openWorkspaceByPath(path: string, healthItem?: { title: string; path: string; exists: boolean; readable: boolean; writable: boolean; freeBytes: number | null; sessions: number | null }): Promise<void> {
  selectedWorkspacePath = path
  input('memory-path').value = path
  $id('workspace-memory-box').classList.remove('hidden')
  if (healthItem === undefined) {
    try {
      const items = await API.workspace.health()
      healthItem = items.find((item) => item.path === path) ?? undefined
    } catch {
      /* 健康查询失败时按未注册处理。 */
    }
  }
  if (healthItem === undefined) {
    $id('workspace-detail').textContent = `名称: ${path.split(/[\\/]/).pop() ?? path}\n路径: ${path}\n\n(该目录未注册为工作区,仅记忆与变更可用)`
  } else {
    const free = healthItem.freeBytes === null ? '未知' : `${(healthItem.freeBytes / 1073741824).toFixed(1)} GB`
    $id('workspace-detail').textContent = [
      `名称: ${healthItem.title}`,
      `路径: ${healthItem.path}`,
      `存在: ${healthItem.exists ? '是' : '否'}`,
      `可读: ${healthItem.readable ? '是' : '否'}`,
      `可写: ${healthItem.writable ? '是' : '否'}`,
      `磁盘可用: ${free}`,
      `会话数: ${healthItem.sessions === null ? '未知' : healthItem.sessions}`,
    ].join('\n')
  }
  await loadMemory()
  await loadWorkspaceChanges(false)
  try {
    const acts = await API.activity.list()
    const filtered = acts.filter((a) => a.workspace === path)
    $id('workspace-activities').textContent = filtered.length === 0 ? '(无关联活动)' : filtered.slice(0, 10).map((a) => `${new Date(a.updatedAt).toLocaleString()} | ${a.status} | ${a.title}`).join('\n')
  } catch {
    $id('workspace-activities').textContent = '(活动加载失败)'
  }
}

async function showWorkspaceDetail(item: { title: string; path: string; exists: boolean; readable: boolean; writable: boolean; freeBytes: number | null; sessions: number | null }): Promise<void> {
  await openWorkspaceByPath(item.path, item)
}

async function loadHealth(): Promise<void> {
  const host = $id('health-list')
  try {
    const items = await API.workspace.health()
    host.textContent = items.length === 0 ? '暂无已注册工作区。' : items.map((item) => {
      const state = item.exists && item.readable && item.writable ? '正常' : '需检查'
      const free = item.freeBytes === null ? '' : ` ${(item.freeBytes / 1073741824).toFixed(1)}GB`
      const title = (item.title ?? item.path).length > 22 ? `${(item.title ?? item.path).slice(0, 21)}…` : (item.title ?? item.path)
      return `${state === '正常' ? '✓' : '⚠️'} ${title}${free} · ${item.sessions === null ? '?会话' : `${item.sessions}会话`}`
    }).join('\n')
  } catch (error) {
    host.textContent = `检查失败:${error instanceof Error ? error.message : String(error)}`
  }
}

let selectedQueueId: string | null = null

async function loadQueue(): Promise<void> {
  const host = $id('queue-list')
  try {
    const items = await API.queue.list()
    host.textContent = ''
    const active = items.filter((item) => item.status === 'queued' || item.status === 'running' || item.status === 'failed')
    const finished = items.filter((item) => item.status === 'completed' || item.status === 'cancelled')
    if (active.length === 0 && finished.length === 0) {
      host.textContent = '队列为空。'
      return
    }
    const renderRow = (item: { id: string; description: string; status: string; attempts: number; maxAttempts: number; nextAttemptAt: number | null; error?: string; source: string }): void => {
      const row = document.createElement('div')
      row.className = selectedQueueId === item.id ? 'queue-row selected' : 'queue-row'
      const retryIn = item.status === 'failed' && item.nextAttemptAt !== null
        ? ` / ${Math.max(1, Math.ceil((item.nextAttemptAt - Date.now()) / 1000))}s 后自动重试`
        : ''
      const state = item.status === 'failed' ? `失败(尝试 ${item.attempts}/${item.maxAttempts})${retryIn}` : item.status === 'running' ? '运行中' : item.status === 'queued' ? '排队中' : item.status
      const label = document.createElement('div')
      label.className = 'queue-label'
      label.textContent = `${item.source} | ${state}\n${item.description.slice(0, 100)}${item.error === undefined || item.error === '' ? '' : `\n${item.error.slice(0, 120)}`}`
      row.appendChild(label)
      if (item.status === 'running' || item.status === 'queued') {
        const cancel = document.createElement('button')
        cancel.className = 'btn btn-sm btn-danger queue-act'
        cancel.textContent = '取消'
        cancel.addEventListener('click', (event) => {
          event.stopPropagation()
          void API.queue.cancel(item.id).then((result) => { S.toast(result, 'ok'); void loadQueue() })
        })
        row.appendChild(cancel)
      } else if (item.status === 'failed' || item.status === 'cancelled') {
        const retry = document.createElement('button')
        retry.className = 'btn btn-sm queue-act'
        retry.textContent = '重试'
        retry.addEventListener('click', (event) => {
          event.stopPropagation()
          void API.queue.retry(item.id).then((result) => { S.toast(result, 'ok'); void loadQueue() })
        })
        row.appendChild(retry)
      }
      row.addEventListener('click', () => {
        selectedQueueId = item.id
        void loadQueue()
      })
      host.appendChild(row)
    }
    active.forEach(renderRow)
    if (finished.length > 0) {
      const sep = document.createElement('div')
      sep.className = 'queue-sep'
      sep.textContent = '── 已完成/已取消 ──'
      host.appendChild(sep)
      finished.slice(0, 10).forEach(renderRow)
    }
  } catch (error) {
    host.textContent = `加载失败:${error instanceof Error ? error.message : String(error)}`
  }
}

async function loadWorkbench(): Promise<void> {
  await Promise.all([
    loadInteractions(), loadActivities(), loadAudit(), loadTaskHistory(), loadUsageReport(), loadHealth(), loadQueue(),
  ])
  try {
    const interactions = await API.interactions.list()
    $id('stat-interactions').textContent = String(interactions.length)
    const activities = await API.activity.list()
    $id('stat-running').textContent = String(activities.filter((item) => item.status === 'running' || item.status === 'queued' || item.status === 'waiting').length)
    const usage = await API.usage.report()
    const tokens = usage?.tokens?.total ?? 0
    $id('stat-usage').textContent = tokens > 0 ? `${(tokens / 1000).toFixed(1)}K` : '0'
  } catch {
    /* 统计数字加载失败时保留占位符。 */
  }
}

function applyDrawerGroup(group: string): void {
  const panels = Array.from(document.querySelectorAll<HTMLElement>('#drawer > .panel'))
  const groups: Record<string, string[]> = {
    general: ['通知与勿扰', '用量费用', '配置备份与恢复'],
    service: ['Harness 服务', '远程访问', 'QQ 机器人', 'Telegram 机器人', 'Webhook'],
    appearance: ['外观', 'AI 屏保'],
    maintenance: ['诊断与支持', '软件更新', '添加自定义 Provider', '服务日志'],
  }
  const allowed = groups[group] ?? groups.general
  panels.forEach((panel) => {
    const title = panel.querySelector('h3')?.textContent ?? ''
    panel.classList.toggle('drawer-panel-hidden', !allowed.some((name) => title.includes(name)))
  })
  document.querySelectorAll<HTMLButtonElement>('.drawer-tab').forEach((button) => button.classList.toggle('active', button.dataset.drawerGroup === group))
}

function bindDrawerNavigation(): void {
  document.querySelectorAll<HTMLButtonElement>('.drawer-tab').forEach((button) => {
    button.addEventListener('click', () => applyDrawerGroup(button.dataset.drawerGroup ?? 'general'))
  })
  applyDrawerGroup('general')
}

let pendingDeviceForApproval: { id: string; label: string; address: string } | null = null
let shownDeviceIds = new Set<string>()

async function showDeviceApproval(device: { id: string; label: string; address: string }): Promise<void> {
  shownDeviceIds.add(device.id)
  pendingDeviceForApproval = device
  $id('da-info').textContent = `设备:${device.label}\n地址:${device.address}\n\n只有你确认的局域网设备才能远程访问电脑,包括任务、文件与审批操作。`
  $id('device-approve').classList.remove('hidden')
  // 同时打开设置抽屉并切到服务组,方便查看设备列表。
  drawerOpen = true
  $id('drawer').classList.remove('hidden')
  applyDrawerGroup('service')
  await renderRemoteDevices()
}

/** 轮询兜底:即使 IPC 事件丢失,待批准设备也会弹出审批(每 10 秒)。 */
async function pollPendingDevices(): Promise<void> {
  try {
    const pending = await API.remote.pendingDevices()
    for (const device of pending) {
      if (!shownDeviceIds.has(device.id)) await showDeviceApproval(device)
    }
  } catch {
    /* 远程访问未启用或 IPC 暂不可用时忽略。 */
  }
}

async function openDrawer(): Promise<void> {
  drawerOpen = true
  $id('drawer').classList.remove('hidden')
  await Promise.all([loadHarnessConfig(), loadPreviewConfig(), loadScreensaverConfig(), loadRegistered(), loadAppearance(),
    loadWallpaperPacks(), loadRemoteConfig(), loadQQConfig(), loadTelegramConfig(), loadUsageConfig(), loadNotificationConfig(), refreshWebhookEndpoint(),
    loadUpdateInfo(), refreshLogs()])
  if (logsTimer === null) {
    logsTimer = setInterval(() => { if (drawerOpen) void refreshLogs() }, 3000)
  }
}

function closeDrawer(): void {
  drawerOpen = false
  $id('drawer').classList.add('hidden')
}

async function loadHarnessConfig(): Promise<void> {
  try {
    const config = await API.harness.getConfig() as HarnessConfigView
    select('cfg-mode').value = config.mode
    input('cfg-url').value = config.url
    input('cfg-port').value = String(config.port)
    input('cfg-command').value = config.command
    input('cfg-dshhome').value = config.dshHome ?? ''
    input('cfg-cwd').value = config.cwd ?? ''
  } catch (error) {
    S.toast(`读取服务配置失败:${String(error)}`, 'error')
  }
}

/** 顶栏预览按钮角标 + 设置面板状态按钮。 */
function refreshPreviewChip(): void {
  const btn = $id('btn-preview')
  const state = previewStatus?.state ?? 'idle'
  const label = state === 'running' || state === 'external'
    ? '🧪 预览·运行中'
    : state === 'error'
      ? '🧪 预览·错误'
      : '🧪 预览'
  btn.textContent = viewSource === 'preview' ? `{ } ${label}` : label
  btn.classList.toggle('preview-active', viewSource === 'preview')
  btn.classList.toggle('stat-ok', state === 'running' || state === 'external')
  btn.classList.toggle('stat-err', state === 'error')
  const pv = $id('pv-panel-status')
  if (pv !== null) {
    pv.textContent = STATE_LABEL[state] ?? state ?? '未启动'
    ;(pv as HTMLButtonElement).disabled = true
  }
}

/** 切换 webview 查看主实例/预览实例。 */
function togglePreviewView(): void {
  if (viewSource === 'preview') {
    viewSource = 'stable'
    const view = harnessView()
    if (lastStableBaseUrl !== '') view.src = lastStableBaseUrl
  } else {
    if (previewStatus === null || (previewStatus.state !== 'running' && previewStatus.state !== 'external')) {
      S.toast('预览实例未运行,请在设置 → 实验预览实例里启动', 'error')
      return
    }
    viewSource = 'preview'
    const view = harnessView()
    view.src = previewStatus.baseUrl
  }
  refreshPreviewChip()
  S.toast(viewSource === 'preview' ? '已切换到实验预览实例' : '已切回主实例', 'ok')
}

let lastStableBaseUrl = ''

const OFFICIAL_HARNESS_CMD = 'npx --yes @deepseek-ai/dsh web --port {port}'

/** 命令模板选择:官方最新 / 官方指定版本 / 本机仓库,选中即填入命令框;手动输入时回到「自定义」。 */
function initCommandTemplate(selectId: string, inputId: string): void {
  const templateSelect = $id(selectId) as HTMLSelectElement
  const commandInput = input(inputId)
  templateSelect.addEventListener('change', () => {
    const value = templateSelect.value
    if (value === '') return
    if (value === 'official') {
      commandInput.value = OFFICIAL_HARNESS_CMD
    } else if (value === 'official-version') {
      const version = window.prompt('官方版本号(如 0.1.1-rc.2,必须已在 npm 发布):', '0.1.1-rc.2')
      if (version === null) { templateSelect.value = ''; return }
      const trimmed = version.trim()
      if (trimmed === '') { templateSelect.value = ''; return }
      commandInput.value = `npx --yes @deepseek-ai/dsh@${trimmed} web --port {port}`
    } else if (value === 'local') {
      void API.dialog.pickFile().then((file) => {
        if (file === null) { templateSelect.value = ''; return }
        commandInput.value = `"${file}" web --port {port}`
        // 与手动修改命令一样触发保存。
        commandInput.dispatchEvent(new Event('change', { bubbles: true }))
      })
      return
    }
    // 与手动修改命令一样触发保存。
    commandInput.dispatchEvent(new Event('change', { bubbles: true }))
  })
  commandInput.addEventListener('input', () => { if (templateSelect.value !== '') templateSelect.value = '' })
}

async function loadPreviewConfig(): Promise<void> {
  try {
    const config = await API.preview.getConfig() as {
      enabled: boolean; url: string; port: number; command: string; dshHome: string | null; cwd: string | null
    }
    const enabled = $id('pv-enabled') as HTMLInputElement
    enabled.checked = config.enabled
    input('pv-port').value = String(config.port)
    input('pv-command').value = config.command
    input('pv-dshhome').value = config.dshHome ?? ''
    input('pv-cwd').value = config.cwd ?? ''
  } catch (error) {
    S.toast(`读取预览配置失败:${String(error)}`, 'error')
  }
}

async function savePreviewConfig(): Promise<void> {
  try {
    const enabled = $id('pv-enabled') as HTMLInputElement
    const patch = {
      enabled: enabled.checked,
      port: Math.max(1, Math.min(65535, Number(input('pv-port').value) || 3081)),
      command: input('pv-command').value.trim(),
      dshHome: input('pv-dshhome').value.trim() || null,
      cwd: input('pv-cwd').value.trim() || null,
    }
    await API.preview.setConfig(patch)
    S.toast('预览配置已保存', 'ok')
    void refreshStatus()
  } catch (error) {
    S.toast(`保存失败:${String(error)}`, 'error')
  }
}

async function saveHarnessConfig(): Promise<void> {
  try {
    const patch = {
      mode: select('cfg-mode').value,
      url: input('cfg-url').value.trim() || 'http://127.0.0.1:3080',
      port: Math.max(1, Math.min(65535, Number(input('cfg-port').value) || 3080)),
      command: input('cfg-command').value.trim(),
      dshHome: input('cfg-dshhome').value.trim() || null,
      cwd: input('cfg-cwd').value.trim() || null,
    }
    await API.harness.setConfig(patch)
    S.toast('服务配置已保存', 'ok')
  } catch (error) {
    S.toast(`保存失败:${String(error)}`, 'error')
  }
}

async function loadScreensaverConfig(): Promise<void> {
  try {
    const config = await API.screensaver.getConfig()
    input('ss-enabled').checked = config.enabled
    input('ss-idle').value = String(config.idleMinutes)
    input('ss-auto-task').checked = config.autoTask
    input('ss-prompt').value = config.taskPrompt
    input('ss-cwd').value = config.taskCwd ?? ''
    input('ss-max').value = String(config.taskMaxMinutes ?? 10)
  } catch (error) {
    S.toast(`读取屏保配置失败:${String(error)}`, 'error')
  }
}

async function saveScreensaverConfig(patch: object): Promise<void> {
  try {
    await API.screensaver.setConfig(patch)
  } catch (error) {
    S.toast(`保存屏保配置失败:${String(error)}`, 'error')
  }
}

async function loadRegistered(): Promise<void> {
  try {
    const registered = await API.screensaver.systemRegistered()
    $id('ss-registered').textContent = registered ? '✓ 已注册为系统屏保' : ''
  } catch {
    // 忽略
  }
}

async function refreshLogs(): Promise<void> {
  try {
    const logs = await API.harness.getLogs()
    $id('log-view').textContent = logs.join('\n')
    $id('log-view').scrollTop = $id('log-view').scrollHeight
  } catch {
    // 忽略
  }
}

// ---- Provider 向导 ----

function fillGatewayPreset(): void {
  const preset = GATEWAY_PRESETS[Number(select('gw-preset').value) || 0]
  input('gw-url').value = preset.baseURL
  input('gw-api').value = preset.api
}

async function discoverGatewayModels(): Promise<void> {
  const baseURL = input('gw-url').value.trim()
  const api = input('gw-api').value.trim()
  const apiKey = input('gw-key').value
  if (baseURL === '') {
    S.toast('请先填写 Base URL', 'error')
    return
  }
  S.toast('正在从网关拉取模型…')
  try {
    const models = await API.models.discover(baseURL, api, apiKey)
    discoveredGatewayModels = models
    if (models.length === 0) {
      S.toast('网关没有返回模型,请手动填写', 'error')
      return
    }
    input('gw-models').value = models.map((model) => model.id).join(', ')
    S.toast(`拉取到 ${models.length} 个模型`, 'ok')
  } catch (error) {
    S.toast(`拉取失败:${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function saveGatewayProvider(): Promise<void> {
  const spec = {
    id: input('gw-id').value.trim(),
    displayName: input('gw-name').value.trim(),
    baseURL: input('gw-url').value.trim(),
    api: input('gw-api').value.trim(),
    apiKey: input('gw-key').value,
    models: input('gw-models').value,
    modelDetails: discoveredGatewayModels.filter((model) => input('gw-models').value.split(',').map((id) => id.trim()).includes(model.id)),
  }
  try {
    await API.models.addProvider(spec)
    discoveredGatewayModels = []
    S.toast('Provider 已保存并热生效', 'ok')
    input('gw-key').value = ''
    void loadModels()
  } catch (error) {
    S.toast(`保存失败:${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

// ---- 外观:壁纸 ----

type WallpaperKind = 'window' | 'phone' | 'screensaver'

const KIND_NAME: Record<WallpaperKind, string> = {
  window: '主窗口',
  phone: '手机端',
  screensaver: '屏保',
}

/** 各端目标画面比例(裁剪/布设预览用)。 */
const TARGET_ASPECT: Record<WallpaperKind, number> = {
  window: 1280 / 800,
  phone: 9 / 16,
  screensaver: 16 / 9,
}

interface CropRect { x: number; y: number; w: number; h: number }

interface WallpaperEditorState {
  kind: WallpaperKind
  img: HTMLImageElement
  /** 当前裁剪比例(null = 自由)。 */
  ratio: number | null
  /** 滤镜效果:none 原图 / beads 拼豆像素。 */
  effect: 'none' | 'beads'
  crop: CropRect
  position: { x: number; y: number }
  outputMime: string
  display: { scale: number; ox: number; oy: number }
  preview: { pw: number; ph: number; dw: number; dh: number } | null
  drag: {
    mode: 'move' | 'resize' | 'place'
    handle: 'nw' | 'ne' | 'sw' | 'se'
    startX: number
    startY: number
    startCrop: CropRect
    startPos: { x: number; y: number }
  } | null
}

let editorState: WallpaperEditorState | null = null

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function applyWindowWallpaper(config: AppearanceConfigView): void {
  const body = document.body
  const windowSpec = config.window
  if (windowSpec.path !== null) {
    body.style.setProperty('--wallpaper-image', `url("file:///${windowSpec.path.replace(/\\/g, '/')}")`)
    body.style.setProperty('--wallpaper-position', `${windowSpec.position.x * 100}% ${windowSpec.position.y * 100}%`)
    body.style.setProperty('--wallpaper-mask', String(config.mask))
    body.classList.add('has-wallpaper')
    $id('wall-window-name').textContent = windowSpec.path.split(/[\\/]/).pop() ?? ''
  } else {
    body.classList.remove('has-wallpaper')
    body.style.removeProperty('--wallpaper-image')
    body.style.removeProperty('--wallpaper-position')
    $id('wall-window-name').textContent = '默认深色'
  }
  $id('wall-phone-name').textContent = config.phone.path === null ? '默认深色' : (config.phone.path.split(/[\\/]/).pop() ?? '')
  $id('wall-screensaver-name').textContent =
    config.screensaver.path === null ? '默认深色' : (config.screensaver.path.split(/[\\/]/).pop() ?? '')
  input('wall-mask').value = String(config.mask)
  void syncWebviewWallpaper()
}

async function loadAppearance(): Promise<void> {
  try {
    applyWindowWallpaper(await API.appearance.getConfig())
  } catch (error) {
    S.toast(`读取外观配置失败:${String(error)}`, 'error')
  }
}

/** 加载内置壁纸包按钮。 */
async function loadWallpaperPacks(): Promise<void> {
  const host = $id('wallpaper-packs')
  try {
    const packs = await API.appearance.listPacks()
    host.innerHTML = ''
    if (packs.length === 0) {
      host.innerHTML = '<span class="hint">(无内置壁纸包)</span>'
      return
    }
    for (const pack of packs) {
      const btn = document.createElement('button')
      btn.className = 'btn btn-sm'
      btn.textContent = pack.id
      btn.title = '一键应用到主窗口 / 手机端 / 屏保'
      btn.addEventListener('click', () => {
        void API.appearance.applyPack(pack.id).then(async () => {
          await loadAppearance()
          S.toast(`壁纸包「${pack.id}」已应用到三端`, 'ok')
        }).catch((error: unknown) => {
          S.toast(`应用失败:${error instanceof Error ? error.message : String(error)}`, 'error')
        })
      })
      host.appendChild(btn)
    }
  } catch (error) {
    host.innerHTML = `<span class="hint">加载失败:${String(error)}</span>`
  }
}

async function pickWallpaper(kind: WallpaperKind): Promise<void> {
  try {
    const result = await API.appearance.pickSource(kind)
    if (result !== null) openWallpaperEditor(kind, result.path)
  } catch (error) {
    S.toast(`选择壁纸失败:${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function clearWallpaper(kind: WallpaperKind): Promise<void> {
  try {
    await API.appearance.clear(kind)
    await loadAppearance()
  } catch (error) {
    S.toast(`清除壁纸失败:${String(error)}`, 'error')
  }
}

// ---- 壁纸编辑器:裁剪 + 布设区域 ----

function openWallpaperEditor(kind: WallpaperKind, sourcePath: string): void {
  const img = new Image()
  img.onload = () => {
    const w = img.naturalWidth
    const h = img.naturalHeight
    const ext = sourcePath.toLowerCase()
    const outputMime = ext.endsWith('.png') ? 'image/png'
      : ext.endsWith('.webp') ? 'image/webp'
        : ext.endsWith('.gif') ? 'image/gif'
          : 'image/jpeg'
    editorState = {
      kind,
      img,
      ratio: null,
      effect: 'none',
      crop: { x: 0, y: 0, w, h },
      position: { x: 0.5, y: 0.5 },
      outputMime,
      display: { scale: 1, ox: 0, oy: 0 },
      preview: null,
      drag: null,
    }
    $id('we-title').textContent = `壁纸编辑 · ${KIND_NAME[kind]}`
    $id('we-preview-label').textContent = `布设预览(${KIND_NAME[kind]})`
    $id('we-info').textContent = `原图 ${w}×${h},拖动选区/预览调整`
    $id('wall-editor').classList.remove('hidden')
    const active = document.querySelector<HTMLButtonElement>('#we-ratios .btn.active')
    if (active !== null) active.classList.remove('active')
    drawEditor()
    drawPreview()
  }
  img.onerror = () => S.toast('图片加载失败', 'error')
  img.src = `file:///${sourcePath.replace(/\\/g, '/')}`
}

function closeWallpaperEditor(): void {
  editorState = null
  $id('wall-editor').classList.add('hidden')
}

/** 按比例设置裁剪区(最大居中矩形;null = 整图)。 */
function setCropRatio(ratio: number | null): void {
  const e = editorState
  if (e === null) return
  const imgW = e.img.naturalWidth
  const imgH = e.img.naturalHeight
  if (ratio === null) {
    e.crop = { x: 0, y: 0, w: imgW, h: imgH }
  } else {
    let w = imgW
    let h = w / ratio
    if (h > imgH) {
      h = imgH
      w = h * ratio
    }
    e.crop = {
      x: Math.round((imgW - w) / 2),
      y: Math.round((imgH - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    }
  }
  e.ratio = ratio
  drawEditor()
  drawPreview()
}

function drawEditor(): void {
  const e = editorState
  if (e === null) return
  const canvas = $id('we-canvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const W = canvas.width
  const H = canvas.height
  e.display = {
    scale: Math.min(W / e.img.naturalWidth, H / e.img.naturalHeight),
    ox: (W - e.img.naturalWidth * Math.min(W / e.img.naturalWidth, H / e.img.naturalHeight)) / 2,
    oy: (H - e.img.naturalHeight * Math.min(W / e.img.naturalWidth, H / e.img.naturalHeight)) / 2,
  }
  ctx.clearRect(0, 0, W, H)
  ctx.drawImage(
    e.img,
    e.display.ox,
    e.display.oy,
    e.img.naturalWidth * e.display.scale,
    e.img.naturalHeight * e.display.scale,
  )
  const r = {
    x: e.crop.x * e.display.scale + e.display.ox,
    y: e.crop.y * e.display.scale + e.display.oy,
    w: e.crop.w * e.display.scale,
    h: e.crop.h * e.display.scale,
  }
  ctx.fillStyle = 'rgba(5, 8, 15, 0.58)'
  ctx.fillRect(0, 0, W, r.y)
  ctx.fillRect(0, r.y + r.h, W, H - r.y - r.h)
  ctx.fillRect(0, r.y, r.x, r.h)
  ctx.fillRect(r.x + r.w, r.y, W - r.x - r.w, r.h)
  ctx.strokeStyle = '#4d7cfe'
  ctx.lineWidth = 2
  ctx.strokeRect(r.x, r.y, r.w, r.h)
  ctx.fillStyle = '#4d7cfe'
  const corners: Array<[number, number]> = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ]
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx - 4, cy - 4, 8, 8)
  }
}

function drawPreview(): void {
  const e = editorState
  if (e === null) return
  const canvas = $id('we-preview') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const pw = 320
  const ph = Math.max(120, Math.round(320 / TARGET_ASPECT[e.kind]))
  canvas.width = pw
  canvas.height = ph
  ctx.fillStyle = '#0b0e14'
  ctx.fillRect(0, 0, pw, ph)
  const c = e.crop
  const scale = Math.max(pw / c.w, ph / c.h)
  const dw = c.w * scale
  const dh = c.h * scale
  const dx = (pw - dw) * e.position.x
  const dy = (ph - dh) * e.position.y
  ctx.drawImage(e.img, c.x, c.y, c.w, c.h, dx, dy, dw, dh)
  e.preview = { pw, ph, dw, dh }
}

function hitCrop(
  e: WallpaperEditorState,
  x: number,
  y: number,
): { mode: 'resize'; handle: 'nw' | 'ne' | 'sw' | 'se' } | { mode: 'move' } | null {
  const r = {
    x: e.crop.x * e.display.scale + e.display.ox,
    y: e.crop.y * e.display.scale + e.display.oy,
    w: e.crop.w * e.display.scale,
    h: e.crop.h * e.display.scale,
  }
  const corners: Record<'nw' | 'ne' | 'sw' | 'se', [number, number]> = {
    nw: [r.x, r.y],
    ne: [r.x + r.w, r.y],
    sw: [r.x, r.y + r.h],
    se: [r.x + r.w, r.y + r.h],
  }
  for (const key of Object.keys(corners) as Array<'nw' | 'ne' | 'sw' | 'se'>) {
    const [cx, cy] = corners[key]
    if (Math.abs(x - cx) <= 8 && Math.abs(y - cy) <= 8) return { mode: 'resize', handle: key }
  }
  if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { mode: 'move' }
  return null
}

function bindWallpaperEditor(): void {
  const canvas = $id('we-canvas') as HTMLCanvasElement
  canvas.addEventListener('pointerdown', (ev) => {
    const e = editorState
    if (e === null) return
    const rect = canvas.getBoundingClientRect()
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width)
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height)
    const hit = hitCrop(e, x, y)
    if (hit === null) return
    canvas.setPointerCapture(ev.pointerId)
    e.drag = {
      mode: hit.mode === 'resize' && e.ratio === null ? 'resize' : 'move',
      handle: hit.mode === 'resize' ? hit.handle : 'se',
      startX: x,
      startY: y,
      startCrop: { ...e.crop },
      startPos: { ...e.position },
    }
  })
  canvas.addEventListener('pointermove', (ev) => {
    const e = editorState
    if (e === null || e.drag === null || e.drag.mode === 'place') return
    const rect = canvas.getBoundingClientRect()
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width)
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height)
    const dx = (x - e.drag.startX) / e.display.scale
    const dy = (y - e.drag.startY) / e.display.scale
    const imgW = e.img.naturalWidth
    const imgH = e.img.naturalHeight
    const s = e.drag.startCrop
    if (e.drag.mode === 'move') {
      e.crop.x = clamp(s.x + dx, 0, imgW - s.w)
      e.crop.y = clamp(s.y + dy, 0, imgH - s.h)
    } else {
      let x1 = s.x
      let y1 = s.y
      let x2 = s.x + s.w
      let y2 = s.y + s.h
      const handle = e.drag.handle
      if (handle === 'se') {
        x2 = clamp(s.x + s.w + dx, s.x + 32, imgW)
        y2 = clamp(s.y + s.h + dy, s.y + 32, imgH)
      } else if (handle === 'nw') {
        x1 = clamp(s.x + dx, 0, s.x + s.w - 32)
        y1 = clamp(s.y + dy, 0, s.y + s.h - 32)
      } else if (handle === 'ne') {
        x2 = clamp(s.x + s.w + dx, s.x + 32, imgW)
        y1 = clamp(s.y + dy, 0, s.y + s.h - 32)
      } else {
        x1 = clamp(s.x + dx, 0, s.x + s.w - 32)
        y2 = clamp(s.y + s.h + dy, s.y + 32, imgH)
      }
      e.crop = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      }
    }
    drawEditor()
    drawPreview()
  })
  const endDrag = (ev: PointerEvent): void => {
    const e = editorState
    if (e === null || e.drag === null) return
    e.drag = null
    try { canvas.releasePointerCapture(ev.pointerId) } catch { /* 忽略 */ }
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  const preview = $id('we-preview') as HTMLCanvasElement
  preview.addEventListener('pointerdown', (ev) => {
    const e = editorState
    if (e === null) return
    preview.setPointerCapture(ev.pointerId)
    e.drag = {
      mode: 'place',
      handle: 'se',
      startX: ev.clientX,
      startY: ev.clientY,
      startCrop: { ...e.crop },
      startPos: { ...e.position },
    }
  })
  preview.addEventListener('pointermove', (ev) => {
    const e = editorState
    if (e === null || e.drag === null || e.drag.mode !== 'place' || e.preview === null) return
    const rect = preview.getBoundingClientRect()
    const p = e.preview
    const dx = (ev.clientX - e.drag.startX) * (p.pw / rect.width)
    const dy = (ev.clientY - e.drag.startY) * (p.ph / rect.height)
    if (p.dw > p.pw) e.position.x = clamp(e.drag.startPos.x + dx / (p.dw - p.pw), 0, 1)
    if (p.dh > p.ph) e.position.y = clamp(e.drag.startPos.y + dy / (p.dh - p.ph), 0, 1)
    drawPreview()
  })
  const endPlace = (ev: PointerEvent): void => {
    const e = editorState
    if (e === null || e.drag === null) return
    e.drag = null
    try { preview.releasePointerCapture(ev.pointerId) } catch { /* 忽略 */ }
  }
  preview.addEventListener('pointerup', endPlace)
  preview.addEventListener('pointercancel', endPlace)

  $id('we-close').addEventListener('click', closeWallpaperEditor)
  $id('we-cancel').addEventListener('click', closeWallpaperEditor)
  $id('we-apply').addEventListener('click', () => void applyWallpaperEditor())
  const ratioBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('#we-ratios .btn'))
  ratioBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const ratio = Number(btn.dataset.ratio)
      ratioBtns.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      setCropRatio(ratio === 0 ? null : ratio)
    })
  })
  const effectBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('#we-effects .btn'))
  effectBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (editorState === null) return
      const effect = btn.dataset.effect === 'beads' ? 'beads' : 'none'
      effectBtns.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      editorState.effect = effect
    })
  })
}

async function applyWallpaperEditor(): Promise<void> {
  const e = editorState
  if (e === null) return
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(e.crop.w))
  out.height = Math.max(1, Math.round(e.crop.h))
  const ctx = out.getContext('2d')
  if (ctx === null) return
  ctx.drawImage(e.img, e.crop.x, e.crop.y, e.crop.w, e.crop.h, 0, 0, out.width, out.height)
  // 拼豆像素化滤镜:缩到格子尺寸再最近邻放大 + 珠点高光。
  if (e.effect === 'beads') {
    applyBeadsEffect(out)
  }
  const mime = e.outputMime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  const dataUrl = out.toDataURL(mime, 0.92)
  try {
    await API.appearance.saveWallpaper(e.kind, dataUrl, e.position)
    closeWallpaperEditor()
    await loadAppearance()
    S.toast(`${KIND_NAME[e.kind]}壁纸已更新${e.effect === 'beads' ? '(拼豆)' : ''}`, 'ok')
  } catch (error) {
    S.toast(`保存壁纸失败:${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

/** 拼豆像素化:像素格平均色 + 最近邻放大 + 珠点高光。 */
function applyBeadsEffect(canvas: HTMLCanvasElement): void {
  const cell = 40
  const tw = Math.max(1, Math.round(canvas.width / cell))
  const th = Math.max(1, Math.round(canvas.height / cell))
  const small = document.createElement('canvas')
  small.width = tw
  small.height = th
  const sctx = small.getContext('2d')
  if (sctx === null) return
  sctx.drawImage(canvas, 0, 0, tw, th)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height)
  // 珠点高光(隔格小亮点)
  ctx.fillStyle = 'rgba(255,255,255,0.09)'
  for (let yy = 0; yy < th; yy += 2) {
    for (let xx = 0; xx < tw; xx += 2) {
      ctx.beginPath()
      ctx.arc(xx * cell + cell * 0.22, yy * cell + cell * 0.22, cell * 0.14, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

// ---- 远程访问 ----

async function loadRemoteConfig(): Promise<void> {
  try {
    const config = await API.remote.getConfig()
    input('remote-enabled').checked = config.enabled
    input('remote-port').value = '' + config.port
    input('remote-token').value = '' + config.token
    await renderRemoteDevices()
    const expiry = $id('remote-expiry') as HTMLSelectElement
    if (config.expiresAt === null) expiry.value = '0'
    else {
      const minutes = Math.max(1, Math.round((config.expiresAt - Date.now()) / 60000))
      expiry.value = minutes <= 30 ? '30' : minutes <= 120 ? '120' : '480'
      $id('remote-expiry-status').textContent = `将在 ${new Date(config.expiresAt).toLocaleString()} 自动关闭`
    }
    const presetRootsEl = $id('remote-preset-roots') as HTMLTextAreaElement
    presetRootsEl.value = (config.presetWorkspaceRoots ?? []).join('\n')
    await renderQr()
  } catch (error) {
    S.toast(`读取远程配置失败:${String(error)}`, 'error')
  }
}

async function renderRemoteDevices(): Promise<void> {
  const pending = await API.remote.pendingDevices()
  const approved = await API.remote.approvedDevices()
  const pendingHost = $id('remote-pending-devices')
  const approvedHost = $id('remote-approved-devices')
  pendingHost.textContent = pending.length === 0 ? '暂无待批准设备' : ''
  pending.forEach((device) => {
    const row = document.createElement('div')
    row.textContent = `${device.label} · ${device.address} `
    const allow = document.createElement('button')
    allow.className = 'btn btn-sm'
    allow.textContent = '允许'
    allow.onclick = async () => { await API.remote.approveDevice(device.id); await renderRemoteDevices() }
    const reject = document.createElement('button')
    reject.className = 'btn btn-sm btn-danger'
    reject.textContent = '拒绝'
    reject.onclick = async () => { await API.remote.rejectDevice(device.id); await renderRemoteDevices() }
    row.append(allow, reject)
    pendingHost.appendChild(row)
  })
  approvedHost.textContent = approved.length === 0 ? '暂无已批准设备' : ''
  approved.forEach((device) => {
    const row = document.createElement('div')
    row.textContent = `${device.label} · ${device.address} `
    const revoke = document.createElement('button')
    revoke.className = 'btn btn-sm btn-danger'
    revoke.textContent = '撤销'
    revoke.onclick = async () => { await API.remote.revokeDevice(device.id); await renderRemoteDevices() }
    row.appendChild(revoke)
    approvedHost.appendChild(row)
  })
}

async function renderQr(): Promise<void> {
  const wrap = $id('remote-qr')
  wrap.innerHTML = ''
  const config = await API.remote.getConfig()
  const addresses = await API.remote.lanAddresses()
  $id('remote-addresses').textContent =
    addresses.length > 0 ? `手机与电脑连接同一 WiFi,扫码或访问:\n${addresses.map((a) => `http://${a}:${config.port}`).join('\n')}` : '(未检测到局域网地址)'
  if (!config.enabled || config.token === '') {
    const empty = document.createElement('div')
    empty.className = 'qr-empty'
    empty.textContent = '启用远程访问后显示二维码'
    wrap.appendChild(empty)
    return
  }
  const pairUrl = await API.remote.pairUrl()
  const qrList = await API.remote.qrDataUrls()
  if (qrList.length > 0) {
    // 每个局域网地址一个二维码:手机连哪个网络就扫哪个。
    qrList.forEach((entry) => {
      const cell = document.createElement('div')
      cell.className = 'qr-cell'
      const img = document.createElement('img')
      img.src = entry.dataUrl ?? ''
      img.alt = '扫码连接'
      img.width = 150
      img.height = 150
      const label = document.createElement('div')
      label.className = 'qr-label'
      label.textContent = entry.address
      cell.append(img, label)
      wrap.appendChild(cell)
    })
    return
  }
  const empty = document.createElement('div')
  empty.className = 'qr-empty'
  empty.textContent = pairUrl
  wrap.appendChild(empty)
}

// ---- QQ 机器人 ----

async function loadQQConfig(): Promise<void> {
  try {
    const config = await API.qq.getConfig()
    input('qq-enabled').checked = config.enabled
    input('qq-appid').value = config.appId
    input('qq-secret').value = config.appSecret
    input('qq-target').value = config.defaultTarget ?? ''
    input('qq-autochat').checked = config.autoChat === true
    input('qq-report').checked = config.report === true
    const botConfig = await API.bot.getConfig()
    const taskPromptEl = $id('bot-task-prompt') as HTMLTextAreaElement
    taskPromptEl.value = botConfig.taskPrompt
    const chatPromptEl = $id('bot-chat-prompt') as HTMLTextAreaElement
    chatPromptEl.value = botConfig.chatPrompt
    const diag = await API.qq.diag()
    const time = diag.readyAt !== null ? new Date(diag.readyAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    const lines: string[] = []
    if (!config.enabled || !config.appId) {
      lines.push(config.enabled && !config.appId ? '⚠️ 已启用但凭据为空:请填写 AppID/AppSecret' : '')
    } else if (diag.connected) {
      lines.push(`✓ 已连接 QQ${time !== '' ? `(${time})` : ''}`)
    } else {
      lines.push('⚠️ QQ 未连接(凭据错误、网络不通或连接断开;看服务日志)')
    }
    if (diag.lastError !== null) {
      lines.push(`最近失败(${diag.lastError.action}):${diag.lastError.detail.slice(0, 120)}`)
      if (diag.lastError.hint !== '') lines.push(diag.lastError.hint)
    }
    $id('qq-status').textContent = lines.filter((line) => line !== '').join('\n')
  } catch {
    // 忽略
  }
}

// ---- Telegram 机器人 ----

async function loadTelegramConfig(): Promise<void> {
  try {
    const config = await API.telegram.getConfig()
    input('tg-enabled').checked = config.enabled
    input('tg-token').value = config.token
    input('tg-users').value = config.allowedUserIds ?? ''
    input('tg-autochat').checked = config.autoChat === true
    input('tg-report').checked = config.report === true
    const diag = await API.telegram.diag()
    const lines: string[] = []
    if (!config.enabled || !config.token) {
      lines.push('')
    } else if (diag.started) {
      lines.push('✓ Telegram 机器人运行中(长轮询)')
    } else {
      lines.push('⚠️ Telegram 未运行(令牌无效、网络不通或已停止;看服务日志)')
    }
    if (diag.lastError !== null) {
      lines.push(`最近失败(${diag.lastError.action}):${diag.lastError.detail.slice(0, 120)}`)
    }
    if (diag.deniedChats.length > 0) {
      const latest = diag.deniedChats[diag.deniedChats.length - 1]
      lines.push(`有人尝试使用被拒绝(${latest.kind === 'user' ? '私聊' : '群组'} ID:${latest.id}):如是你自己,把它加入「允许的用户 ID」`)
    }
    $id('tg-status').textContent = lines.filter((line) => line !== '').join('\n')
  } catch {
    // 忽略
  }
}

// ---- 用量与费用 ----

async function loadUsageConfig(): Promise<void> {
  try {
    const config = await API.usage.getConfig()
    input('usage-multiplier').value = String(config.multiplier ?? 1)
  } catch {
    // 忽略
  }
}

/** 今日用量报告(按模型分开统计 + 费用估算;与 QQ/PWA 同一数据源)。 */
async function loadUsageReport(): Promise<void> {
  const pre = $id('usage-report')
  try {
    const r = await API.usage.report()
    if (r === null) {
      pre.textContent = '(用量统计不可用)'
      return
    }
    const lines: string[] = [
      `今日会话:${r.todaySessions} 个(总 ${r.totalSessions} 个)`,
      `今日回合:${r.todayTurns} 次 / 模型耗时:${(r.todayLlmMs / 60000).toFixed(1)} 分钟`,
    ]
    if (r.tokens.total > 0) {
      lines.push(`Token:${(r.tokens.total / 1000).toFixed(1)}K(输入 ${(r.tokens.input / 1000).toFixed(1)}K / 输出 ${(r.tokens.output / 1000).toFixed(1)}K${r.tokens.cache > 0 ? ` / 缓存 ${(r.tokens.cache / 1000).toFixed(1)}K` : ''})`)
      lines.push(`💰 费用估算:¥${r.cost.total.toFixed(3)}(倍率 ${r.prices.multiplier})`)
    }
    if (r.byModel.length > 0) {
      lines.push('')
      lines.push('按模型(今日):')
      for (const m of r.byModel) {
        lines.push(`  ${m.provider}/${m.model}:${((m.input + m.output) / 1000).toFixed(1)}K Token,${m.calls} 次调用`)
      }
    }
    if (r.tokens.total === 0 && r.byModel.length === 0) {
      lines.push('(今日暂无 Token 消耗;有请求后自动累计)')
    }
    pre.textContent = lines.join('\n')
  } catch (error) {
    pre.textContent = `加载失败:${error instanceof Error ? error.message : String(error)}`
  }
}

async function refreshWebhookEndpoint(): Promise<void> {
  try {
    const remote = await API.remote.getConfig()
    const addresses = await API.remote.lanAddresses()
    if (!remote.enabled) {
      $id('webhook-endpoint').textContent = '请先启用「远程访问」'
      return
    }
    const host = addresses[0] ?? '127.0.0.1'
    $id('webhook-endpoint').textContent = `http://${host}:${remote.port}/api/command`
  } catch {
    // 忽略
  }
}

// ---- 更新 ----

async function loadUpdateInfo(): Promise<void> {
  try {
    const info = await API.updater.getInfo()
    const hasUpdate = info.latest !== null &&
      info.latest.split('.').map(Number).join('.') > info.current.split('.').map(Number).join('.')
    $id('update-info').textContent = hasUpdate
      ? `当前 v${info.current} → 发现新版本 v${info.latest}`
      : `当前版本 v${info.current}${info.checkedAt > 0 ? ' · 已是最新' : ''}`
    $id('btn-open-release').classList.toggle('hidden', !hasUpdate)
    const updaterConfig = await API.updater.getConfig()
    input('upd-autocheck').checked = updaterConfig.autoCheck === true
  } catch {
    // 忽略
  }
}

// ---- 事件绑定 ----

function bind(): void {
  const view = harnessView()
  view.addEventListener('did-fail-load', (event) => {
    webviewFailed = true
    const details = event as unknown as { errorCode?: number; errorDescription?: string }
    $id('view-error-text').textContent = `加载失败(${String(details.errorCode)}):${details.errorDescription ?? '未知错误'}`
    $id('view-error').classList.remove('hidden')
    // 失败即排期重试(harness 启动期会先失败几次,服务起来后自动恢复)。
    scheduleWebviewRetry()
  })
  view.addEventListener('dom-ready', () => {
    // 仅隐藏错误浮层;是否真成功以 did-finish-load 为准(错误页也会触发 dom-ready)。
    $id('view-error').classList.add('hidden')
    void syncWebviewWallpaper()
  })
  view.addEventListener('did-finish-load', () => {
    webviewFailed = false
    webviewFailStreak = 0
    $id('view-error').classList.add('hidden')
  })

  select('model-select').addEventListener('change', () => void applyModelSelection())

  $id('btn-screensaver').addEventListener('click', () => {
    void API.screensaver.activate().then(() => {
      S.toast('AI 屏保已启动,移动鼠标或按键退出', 'ok')
    }).catch((error: unknown) => {
      S.toast(`启动失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  })
  $id('btn-drawer').addEventListener('click', () => void openDrawer())
  $id('btn-drawer-close').addEventListener('click', closeDrawer)
  bindDrawerNavigation()
  $id('btn-preview').addEventListener('click', () => togglePreviewView())
  $id('pv-start').addEventListener('click', async () => {
    try {
      await API.preview.start()
      S.toast('预览实例启动请求已发出', 'ok')
      await savePreviewConfig()
      void refreshStatus()
    } catch (error) {
      S.toast(`启动失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  })
  $id('pv-stop').addEventListener('click', async () => {
    try {
      await API.preview.stop()
      if (viewSource === 'preview') togglePreviewView()
      S.toast('预览实例已停止', 'ok')
      void refreshStatus()
    } catch (error) {
      S.toast(`停止失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  })
  $id('pv-open').addEventListener('click', () => { void API.preview.openWebUi() })
  $id('pv-save').addEventListener('click', () => void savePreviewConfig())
  $id('nav-workbench').addEventListener('click', () => switchView('workbench'))
  $id('nav-workspaces').addEventListener('click', () => switchView('workspaces'))
  $id('nav-session').addEventListener('click', () => switchView('session'))
  $id('btn-workspace-refresh').addEventListener('click', () => void loadWorkspaces())
  $id('btn-workspace-changes').addEventListener('click', () => void loadWorkspaceChanges(false))
  $id('btn-workspace-diff').addEventListener('click', () => void loadWorkspaceChanges(true))
  $id('btn-workspace-open').addEventListener('click', async () => {
    if (selectedWorkspacePath === null) { S.toast('请先选择工作区', 'error'); return }
    const result = await API.workspace.openFolder(selectedWorkspacePath)
    if (result !== 'ok') S.toast(`打开失败:${result}`, 'error')
  })
  $id('btn-memory-pick').addEventListener('click', async () => {
    const path = await pickDirectoryInto('memory-path')
    if (path !== null) await openWorkspaceByPath(path)
  })
  $id('btn-qq-target-pick').addEventListener('click', async () => {
    const path = await pickDirectoryInto('qq-target')
    if (path !== null) {
      await API.qq.setConfig({ defaultTarget: path })
      S.toast(`默认工作区已设为:${path}`, 'ok')
    }
  })
  $id('btn-ss-cwd-pick').addEventListener('click', async () => {
    const path = await pickDirectoryInto('ss-cwd')
    if (path !== null) {
      await API.screensaver.setConfig({ taskCwd: path })
      S.toast(`屏保任务目录已设为:${path}`, 'ok')
    }
  })
  switchView('workbench')
  $id('btn-retry').addEventListener('click', () => {
    void API.harness.restart()
  })
  $id('btn-restart').addEventListener('click', () => {
    void API.harness.restart().then(() => S.toast('已请求重启', 'ok'))
  })
  $id('btn-open-settings').addEventListener('click', () => {
    void API.app.openSettingsFolder().then(() => S.toast('已打开 settings.yaml', 'ok')).catch((error: unknown) => {
      S.toast(`打开失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  })
  $id('btn-open-webui').addEventListener('click', () => void API.harness.openWebUi())

  // 远程访问
  input('remote-enabled').addEventListener('change', async () => {
    const enabled = input('remote-enabled').checked
    await API.remote.setConfig({ enabled, expiresAt: enabled ? Date.now() + 120 * 60 * 1000 : null })
    await renderQr()
    S.toast(enabled ? '远程访问已启用(默认 2 小时后自动关闭)' : '远程访问已关闭', 'ok')
  })
  select('remote-expiry').addEventListener('change', async () => {
    const minutes = Number(select('remote-expiry').value)
    const expiresAt = minutes === 0 ? null : Date.now() + minutes * 60 * 1000
    await API.remote.setConfig({ expiresAt })
    $id('remote-expiry-status').textContent = expiresAt === null ? '不会自动关闭;不用时请手动关闭。' : `将在 ${new Date(expiresAt).toLocaleString()} 自动关闭`
    S.toast('远程访问过期策略已更新', 'ok')
  })
  input('remote-port').addEventListener('change', async () => {
    await API.remote.setConfig({ port: Math.max(1024, Math.min(65535, Number(input('remote-port').value) || 3082)) })
    await renderQr()
  })
  $id('btn-token-regenerate').addEventListener('click', async () => {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('')
    await API.remote.setConfig({ token })
    await loadRemoteConfig()
    S.toast('令牌已重新生成', 'ok')
  })
  $id('remote-preset-roots').addEventListener('change', async () => {
    const roots = ($id('remote-preset-roots') as HTMLTextAreaElement).value
      .split('\n').map((s) => s.trim()).filter((s) => s !== '')
    await API.remote.setConfig({ presetWorkspaceRoots: roots })
    S.toast('预设工作区根目录已保存', 'ok')
  })
  $id('btn-preset-pick').addEventListener('click', async () => {
    const picked = await API.dialog.pickDirectories()
    if (picked.length === 0) return
    const el = $id('remote-preset-roots') as HTMLTextAreaElement
    const existing = el.value.split('\n').map((s) => s.trim()).filter((s) => s !== '')
    const seen = new Set(existing)
    let added = 0
    for (const p of picked) {
      if (!seen.has(p)) {
        seen.add(p)
        existing.push(p)
        added++
      }
    }
    if (added === 0) {
      S.toast('所选目录已在列表中', 'ok')
      return
    }
    el.value = existing.join('\n')
    await API.remote.setConfig({ presetWorkspaceRoots: existing })
    S.toast(`已添加 ${added} 个预设根目录`, 'ok')
  })

  // QQ 机器人
  input('qq-enabled').addEventListener('change', async () => {
    await API.qq.setConfig({ enabled: input('qq-enabled').checked })
    await loadQQConfig()
  })
  input('qq-appid').addEventListener('change', async () => {
    await API.qq.setConfig({ appId: input('qq-appid').value.trim() })
  })
  input('qq-secret').addEventListener('change', async () => {
    await API.qq.setConfig({ appSecret: input('qq-secret').value.trim() })
  })
  input('qq-target').addEventListener('change', async () => {
    await API.qq.setConfig({ defaultTarget: input('qq-target').value.trim() })
  })
  input('qq-autochat').addEventListener('change', async () => {
    await API.qq.setConfig({ autoChat: input('qq-autochat').checked })
  })
  input('qq-report').addEventListener('change', async () => {
    await API.qq.setConfig({ report: input('qq-report').checked })
    S.toast(input('qq-report').checked ? '已开启主动汇报(完成/失败/审批/提问)' : '已关闭主动汇报', 'ok')
  })
  $id('bot-task-prompt').addEventListener('change', async () => {
    await API.bot.setConfig({ taskPrompt: ($id('bot-task-prompt') as HTMLTextAreaElement).value.trim() })
    S.toast('工作模式提示词已保存', 'ok')
  })
  $id('usage-multiplier').addEventListener('change', async () => {
    const value = Number(($id('usage-multiplier') as HTMLInputElement).value)
    if (!Number.isFinite(value) || value <= 0) {
      S.toast('倍率必须是大于 0 的数字', 'error')
      await loadUsageConfig()
      return
    }
    await API.usage.setConfig({ multiplier: value })
    S.toast(`费用倍率已设为 ${value}(官方价 × ${value})`, 'ok')
    await loadUsageReport()
  })
  $id('btn-usage-refresh').addEventListener('click', () => void loadUsageReport())
  $id('btn-health-refresh').addEventListener('click', () => void loadHealth())
  $id('btn-health-manage').addEventListener('click', () => switchView('workspaces'))
  // 概览统计卡点击滚动到对应面板。
  const statScrollMap: Array<[string, string]> = [
    ['stat-interactions', 'interaction-list'],
    ['stat-running', 'activity-list'],
    ['stat-usage', 'usage-report'],
  ]
  statScrollMap.forEach(([statId, targetId]) => {
    $id(statId).parentElement?.addEventListener('click', () => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  })
  $id('btn-queue-refresh').addEventListener('click', () => void loadQueue())
  $id('ad-close').addEventListener('click', () => $id('activity-detail').classList.add('hidden'))
  // 设备审批弹窗。
  $id('da-close').addEventListener('click', () => $id('device-approve').classList.add('hidden'))
  $id('da-allow').addEventListener('click', async () => {
    if (pendingDeviceForApproval === null) return
    const device = pendingDeviceForApproval
    pendingDeviceForApproval = null
    await API.remote.approveDevice(device.id)
    $id('device-approve').classList.add('hidden')
    await renderRemoteDevices()
    S.toast(`已允许设备:${device.label}`, 'ok')
  })
  $id('da-reject').addEventListener('click', async () => {
    if (pendingDeviceForApproval === null) return
    const device = pendingDeviceForApproval
    pendingDeviceForApproval = null
    await API.remote.rejectDevice(device.id)
    $id('device-approve').classList.add('hidden')
    await renderRemoteDevices()
    S.toast(`已拒绝设备:${device.label}`, 'ok')
  })
  API.remote.onDevicePending((device) => { shownDeviceIds.add(device.id); void showDeviceApproval(device) })
  // 每 10 秒轮询待批准设备,保证审批弹窗必然出现(事件推送丢失时的兜底)。
  window.setInterval(() => void pollPendingDevices(), 10_000)
  void pollPendingDevices()
  // 弹层背景点击关闭。
  $id('activity-detail').addEventListener('click', (event) => {
    if (event.target === $id('activity-detail')) $id('activity-detail').classList.add('hidden')
  })
  $id('device-approve').addEventListener('click', (event) => {
    if (event.target === $id('device-approve')) $id('device-approve').classList.add('hidden')
  })
  // Esc 关闭抽屉/弹层。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!$id('device-approve').classList.contains('hidden')) { $id('device-approve').classList.add('hidden'); return }
    if (!$id('activity-detail').classList.contains('hidden')) { $id('activity-detail').classList.add('hidden'); return }
    if (!$id('drawer').classList.contains('hidden')) closeDrawer()
  })
  $id('btn-interactions-refresh').addEventListener('click', () => void loadInteractions())
  $id('btn-activity-refresh').addEventListener('click', () => void loadActivities())
  $id('btn-audit-refresh').addEventListener('click', () => void loadAudit())
  $id('btn-audit-export').addEventListener('click', async () => { const path = await API.audit.export(); if (path !== null) S.toast(`审计记录已导出:${path}`, 'ok') })
  $id('btn-audit-clear').addEventListener('click', async () => { await API.audit.clear(); await loadAudit(); S.toast('审计记录已清空', 'ok') })
  $id('btn-memory-load').addEventListener('click', () => void loadMemory())
  $id('btn-memory-save').addEventListener('click', () => void saveMemory())
  $id('btn-memory-clear').addEventListener('click', () => void clearMemory())
  $id('btn-memory-suggest').addEventListener('click', () => void suggestMemory())
  // 通知设置:全部即改即存(与其他配置一致)。
  const notifyFields: Record<string, string> = {
    'notify-enabled': 'enabled',
    'notify-approval': 'approval',
    'notify-question': 'question',
    'notify-task-done': 'taskDone',
    'notify-task-fail': 'taskFail',
    'notify-update': 'update',
    'notify-quiet': 'quietHoursEnabled',
    'notify-urgent-bypass': 'urgentBypassQuiet',
  }
  Object.entries(notifyFields).forEach(([id, field]) => {
    input(id).addEventListener('change', () => void saveNotificationConfig({ [field]: input(id).checked }))
  })
  input('notify-quiet-start').addEventListener('change', () => void saveNotificationConfig({ quietStart: Number(input('notify-quiet-start').value) }))
  input('notify-quiet-end').addEventListener('change', () => void saveNotificationConfig({ quietEnd: Number(input('notify-quiet-end').value) }))
  $id('btn-config-backup').addEventListener('click', async () => {
    const path = await API.config.backup()
    $id('config-status').textContent = `已备份:${path}`
  })
  $id('btn-config-export').addEventListener('click', async () => {
    const path = await API.config.exportSafe()
    $id('config-status').textContent = path === null ? '已取消导出' : `已导出脱敏配置:${path}`
  })
  $id('btn-config-import').addEventListener('click', async () => {
    const result = await API.config.importSafe()
    $id('config-status').textContent = result === null ? '已取消导入' : '配置已导入,部分设置将在重启后生效'
  })
  $id('btn-diagnostics').addEventListener('click', async () => {
    const report = await API.diagnostics.collect()
    $id('diagnostics-report').textContent = JSON.stringify(report, null, 2)
  })
  $id('btn-diagnostics-export').addEventListener('click', async () => {
    const path = await API.diagnostics.export()
    $id('diagnostics-report').textContent = path === null ? '已取消导出' : `已导出:${path}`
  })
  $id('bot-chat-prompt').addEventListener('change', async () => {
    await API.bot.setConfig({ chatPrompt: ($id('bot-chat-prompt') as HTMLTextAreaElement).value.trim() })
    S.toast('对话模式提示词已保存', 'ok')
  })
  // 机器人指令集(桌面端可查看)
  $id('btn-bot-help').addEventListener('click', async () => {
    const pre = $id('bot-help-text')
    if (!pre.classList.contains('hidden')) {
      pre.classList.add('hidden')
      return
    }
    pre.textContent = '加载中…'
    pre.classList.remove('hidden')
    try {
      pre.textContent = await API.bot.help()
    } catch (error) {
      pre.textContent = '加载失败:' + String(error)
    }
  })

  // QQ 扫码登录
  let onboardTimer: number | null = null
  const clearOnboardTimer = () => {
    if (onboardTimer !== null) { window.clearInterval(onboardTimer); onboardTimer = null }
  }
  const showOnboard = (visible: boolean) => {
    $id('qq-onboard-area').classList.toggle('hidden', !visible)
    $id('btn-qq-onboard-cancel').classList.toggle('hidden', !visible)
    input('btn-qq-onboard').disabled = visible
  }
  const pollOnboard = () => {
    void API.qq.onboardStatus().then((progress) => {
      if (progress === null) return
      const statusEl = $id('qq-onboard-status')
      const qrImg = $id('qq-onboard-qr') as HTMLImageElement
      if (progress.status === 'pending') {
        // 二维码更新(过期自动刷新):重新赋值图片并提示。
        if (progress.qrDataUrl !== null && progress.qrDataUrl !== qrImg.src) {
          qrImg.src = progress.qrDataUrl
          statusEl.textContent = qrImg.src === '' ? '正在生成二维码…' : '请用手机 QQ 扫描二维码,并在手机端确认绑定'
        } else if (statusEl.textContent === '') {
          statusEl.textContent = '请用手机 QQ 扫描二维码,并在手机端确认绑定'
        }
      } else if (progress.status === 'completed') {
        clearOnboardTimer()
        showOnboard(false)
        statusEl.textContent = `✓ 绑定成功(扫码者 ${progress.userOpenid ?? '?'}),凭据已自动填入并重启机器人`
        void loadQQConfig()
      } else if (progress.status === 'expired') {
        // 过期:主进程会自动刷新新码,这里提示并继续轮询。
        statusEl.textContent = progress.error ?? '二维码已过期,正在自动刷新…'
      } else {
        clearOnboardTimer()
        showOnboard(false)
        statusEl.textContent = '扫码失败:' + (progress.error ?? '未知错误')
      }
    }).catch(() => {})
  }
  $id('btn-qq-onboard').addEventListener('click', async () => {
    showOnboard(true)
    const qrImg = $id('qq-onboard-qr') as HTMLImageElement
    qrImg.src = ''
    $id('qq-onboard-status').textContent = '正在生成二维码…'
    try {
      const progress = await API.qq.onboardStart()
      if (progress.qrDataUrl !== null) qrImg.src = progress.qrDataUrl
      if (progress.status !== 'pending') {
        pollOnboard()
      } else {
        clearOnboardTimer()
        onboardTimer = window.setInterval(pollOnboard, 2000)
        pollOnboard()
      }
    } catch (error) {
      showOnboard(false)
      $id('qq-onboard-status').textContent = '启动扫码失败:' + String(error)
    }
  })
  $id('btn-qq-onboard-cancel').addEventListener('click', () => {
    void API.qq.onboardCancel()
    clearOnboardTimer()
    showOnboard(false)
  })

  // Telegram 机器人
  input('tg-enabled').addEventListener('change', async () => {
    await API.telegram.setConfig({ enabled: input('tg-enabled').checked })
    await loadTelegramConfig()
  })
  input('tg-token').addEventListener('change', async () => {
    await API.telegram.setConfig({ token: input('tg-token').value.trim() })
    await loadTelegramConfig()
  })
  input('tg-users').addEventListener('change', async () => {
    await API.telegram.setConfig({ allowedUserIds: input('tg-users').value.trim() })
  })
  input('tg-autochat').addEventListener('change', async () => {
    await API.telegram.setConfig({ autoChat: input('tg-autochat').checked })
  })
  input('tg-report').addEventListener('change', async () => {
    await API.telegram.setConfig({ report: input('tg-report').checked })
    S.toast(input('tg-report').checked ? '已开启主动汇报(完成/失败/审批/提问)' : '已关闭主动汇报', 'ok')
  })

  // 更新
  $id('btn-check-update').addEventListener('click', async () => {
    $id('update-info').textContent = '正在检查更新…'
    try {
      const info = await API.updater.check()
      const hasUpdate = info.latest !== null &&
        info.latest.split('.').map(Number).join('.') > info.current.split('.').map(Number).join('.')
      $id('update-info').textContent = hasUpdate
        ? `发现新版本 v${info.latest}(当前 v${info.current})`
        : `已是最新版本 v${info.current}`
      $id('btn-open-release').classList.toggle('hidden', !hasUpdate)
      if (hasUpdate) S.toast(`发现新版本 v${info.latest}`, 'ok')
    } catch (error) {
      $id('update-info').textContent = '检查失败,请检查网络'
      S.toast(`检查更新失败:${String(error)}`, 'error')
    }
  })
  $id('btn-open-release').addEventListener('click', () => void API.updater.openRelease())
  input('upd-autocheck').addEventListener('change', async () => {
    await API.updater.setConfig({ autoCheck: input('upd-autocheck').checked })
    S.toast(input('upd-autocheck').checked ? '已开启:启动后自动检查更新' : '已关闭自动检查', 'ok')
  })

  // 外观
  $id('btn-wall-window').addEventListener('click', () => void pickWallpaper('window'))
  $id('btn-wall-window-clear').addEventListener('click', () => void clearWallpaper('window'))
  $id('btn-wall-phone').addEventListener('click', () => void pickWallpaper('phone'))
  $id('btn-wall-phone-clear').addEventListener('click', () => void clearWallpaper('phone'))
  $id('btn-wall-screensaver').addEventListener('click', () => void pickWallpaper('screensaver'))
  $id('btn-wall-screensaver-clear').addEventListener('click', () => void clearWallpaper('screensaver'))
  bindWallpaperEditor()
  let maskTimer: ReturnType<typeof setTimeout> | null = null
  input('wall-mask').addEventListener('input', () => {
    document.body.style.setProperty('--wallpaper-mask', input('wall-mask').value)
    if (maskTimer !== null) clearTimeout(maskTimer)
    maskTimer = setTimeout(() => {
      void API.appearance.setMask(Number(input('wall-mask').value)).catch(() => { /* 忽略 */ })
    }, 400)
  })

  // 屏保设置
  input('ss-enabled').addEventListener('change', () =>
    void saveScreensaverConfig({ enabled: input('ss-enabled').checked }))
  input('ss-idle').addEventListener('change', () =>
    void saveScreensaverConfig({ idleMinutes: Math.max(1, Number(input('ss-idle').value) || 5) }))
  input('ss-auto-task').addEventListener('change', () =>
    void saveScreensaverConfig({ autoTask: input('ss-auto-task').checked }))
  input('ss-prompt').addEventListener('change', () =>
    void saveScreensaverConfig({ taskPrompt: input('ss-prompt').value }))
  input('ss-cwd').addEventListener('change', () =>
    void saveScreensaverConfig({ taskCwd: input('ss-cwd').value.trim() || null }))
  input('ss-max').addEventListener('change', () =>
    void saveScreensaverConfig({ taskMaxMinutes: Math.max(1, Math.min(120, Number(input('ss-max').value) || 10)) }))
  $id('btn-ss-now').addEventListener('click', () => {
    void API.screensaver.activate().then(() => {
      S.toast('AI 屏保已启动,移动鼠标或按键退出', 'ok')
    }).catch((error: unknown) => {
      S.toast(`启动失败:${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  })
  $id('btn-ss-register').addEventListener('click', () => {
    void API.screensaver.registerSystem().then((result) => {
      S.toast(result.message, result.ok ? 'ok' : 'error')
      void loadRegistered()
    })
  })
  $id('btn-ss-unregister').addEventListener('click', () => {
    void API.screensaver.unregisterSystem().then((result) => {
      S.toast(result.message, result.ok ? 'ok' : 'error')
      void loadRegistered()
    })
  })

  // Harness 配置
  select('cfg-mode').addEventListener('change', () => void saveHarnessConfig())
  for (const id of ['cfg-url', 'cfg-port', 'cfg-command', 'cfg-dshhome']) {
    input(id).addEventListener('change', () => void saveHarnessConfig())
  }

  // 命令模板:官方最新 / 官方指定版本 / 本机仓库,填入命令框。
  initCommandTemplate('cfg-command-preset', 'cfg-command')
  initCommandTemplate('pv-command-preset', 'pv-command')

  // Provider 向导
  const presetSelect = select('gw-preset')
  for (const [index, preset] of GATEWAY_PRESETS.entries()) {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = preset.label
    presetSelect.appendChild(option)
  }
  presetSelect.addEventListener('change', fillGatewayPreset)
  $id('btn-gw-discover').addEventListener('click', () => void discoverGatewayModels())
  $id('btn-gw-save').addEventListener('click', () => void saveGatewayProvider())
}

function init(): void {
  bind()
  void refreshStatus()
  setInterval(() => void refreshStatus(), 2000)
  void loadModels()
  void loadAppearance()
  initPet()
}

// ---- 桌面宠物(小鲸鱼) ----

let petBusy = false
let petVisible = localStorage.getItem('dsh-pet') !== '0'

function initPet(): void {
  const canvas = $id('pet-canvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  if (!petVisible) canvas.classList.add('hidden')
  else canvas.classList.remove('hidden')

  let x = canvas.offsetWidth / 2
  let y = canvas.offsetHeight / 2
  let t = 0
  let dragging = false
  let dx = 0
  let dy = 0

  // Gemini 生成的鲸鱼图(assets/pet-whale.svg),加载完成后替换手绘。
  const whaleImg = new Image()
  whaleImg.src = 'assets/pet-whale.svg'
  let whaleReady = false
  whaleImg.onload = () => { whaleReady = true }

  const draw = (): void => {
    t += 0.05
    const speed = petBusy ? 2.2 : 0.8
    const sway = Math.sin(t * speed) * (petBusy ? 0.22 : 0.12)
    const bob = Math.sin(t * speed * 1.7) * 3
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.translate(x, y + bob)
    ctx.rotate(sway)
    if (whaleReady) {
      const size = 112
      ctx.drawImage(whaleImg, -size / 2, -size / 2, size, size)
    } else {
      // 手绘回退(图片未加载完成)
      // 尾巴
      ctx.fillStyle = '#2f6fb2'
      ctx.beginPath()
      ctx.moveTo(-22, 0)
    ctx.lineTo(-36, -12 + Math.sin(t * speed * 2) * 4)
    ctx.lineTo(-36, 12 + Math.sin(t * speed * 2 + 1) * 4)
    ctx.closePath()
    ctx.fill()
    // 身体
    const grad = ctx.createLinearGradient(-20, -14, 20, 14)
    grad.addColorStop(0, '#3d7fd4')
    grad.addColorStop(1, '#1f4e8c')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.ellipse(0, 0, 24, 15, 0, 0, Math.PI * 2)
    ctx.fill()
    // 鳍
    ctx.fillStyle = '#2a62ab'
    ctx.beginPath()
    ctx.moveTo(2, 8)
    ctx.quadraticCurveTo(12, 14, 18, 8)
    ctx.quadraticCurveTo(10, 6, 2, 8)
    ctx.fill()
    // 眼睛
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(12, -4, 5.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#12233f'
    ctx.beginPath()
    ctx.arc(13.5, -4, 2.6, 0, Math.PI * 2)
    ctx.fill()
    // 腮红/嘴
    ctx.strokeStyle = '#7fb2e8'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(15, 3, 4, -0.4, 0.9)
    ctx.stroke()
    }
    ctx.restore()

    // 冒泡(忙碌时更频繁)
    if (Math.random() < (petBusy ? 0.16 : 0.05)) {
      bubbles.push({ by: y - 16, bx: x + 8 + Math.random() * 8, r: 1.5 + Math.random() * 2 })
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i]
      b.by -= 0.8
      b.bx += Math.sin(t + i) * 0.2
      if (b.by < 0) bubbles.splice(i, 1)
      else {
        ctx.strokeStyle = 'rgba(180,220,255,0.7)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(b.bx, b.by, b.r, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    requestAnimationFrame(draw)
  }
  const bubbles: Array<{ by: number; bx: number; r: number }> = []
  requestAnimationFrame(draw)

  // 拖动(移动 canvas 元素本身,绘制坐标保持中心)
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true
    dx = e.clientX - 70
    dy = e.clientY - 60
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return
    canvas.style.left = `${e.clientX - dx}px`
    canvas.style.top = `${e.clientY - dy}px`
    canvas.style.right = 'auto'
    canvas.style.bottom = 'auto'
  })
  canvas.addEventListener('pointerup', () => { dragging = false })
  canvas.addEventListener('dblclick', () => {
    petVisible = !petVisible
    localStorage.setItem('dsh-pet', petVisible ? '1' : '0')
    canvas.classList.toggle('hidden', !petVisible)
  })
  // 常驻右下角(未拖动时)
  const place = (): void => {
    if (dragging) return
    canvas.style.left = 'auto'
    canvas.style.top = 'auto'
    canvas.style.right = '18px'
    canvas.style.bottom = '14px'
    x = canvas.offsetWidth / 2
    y = canvas.offsetHeight / 2
  }
  place()
  window.addEventListener('resize', place)
}

init()

})()
