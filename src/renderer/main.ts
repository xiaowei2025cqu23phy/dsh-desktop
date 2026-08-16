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

interface HarnessConfigView {
  mode: 'auto' | 'external' | 'managed'
  url: string
  port: number
  command: string
  autoStart: boolean
  restartOnCrash: boolean
  stopOnQuit: boolean
  dshHome: string | null
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
  let drawerOpen = false
  let logsTimer: ReturnType<typeof setInterval> | null = null
  let webviewWallpaperKey: string | null = null

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
  const pill = $id('status-pill')
  pill.className = `pill pill-${status.state}`
  pill.textContent = `${STATE_LABEL[status.state] ?? status.state} · ${status.baseUrl}`
  const view = harnessView()
  if (status.baseUrl !== lastBaseUrl) {
    lastBaseUrl = status.baseUrl
    view.src = status.baseUrl
  }
  const modelSelect = select('model-select')
  if ((status.state === 'running' || status.state === 'external') && modelSelect.disabled) {
    modelSelect.disabled = false
    void loadModels()
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

async function openDrawer(): Promise<void> {
  drawerOpen = true
  $id('drawer').classList.remove('hidden')
  await Promise.all([loadHarnessConfig(), loadScreensaverConfig(), loadRegistered(), loadAppearance(),
    loadRemoteConfig(), loadQQConfig(), loadTelegramConfig(), refreshWebhookEndpoint(), refreshLogs()])
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
  } catch (error) {
    S.toast(`读取服务配置失败:${String(error)}`, 'error')
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
  }
  try {
    await API.models.addProvider(spec)
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
  const mime = e.outputMime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  const dataUrl = out.toDataURL(mime, 0.92)
  try {
    await API.appearance.saveWallpaper(e.kind, dataUrl, e.position)
    closeWallpaperEditor()
    await loadAppearance()
    S.toast(`${KIND_NAME[e.kind]}壁纸已更新`, 'ok')
  } catch (error) {
    S.toast(`保存壁纸失败:${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

// ---- 远程访问 ----

async function loadRemoteConfig(): Promise<void> {
  try {
    const config = await API.remote.getConfig()
    input('remote-enabled').checked = config.enabled
    input('remote-port').value = String(config.port)
    input('remote-token').value = config.token
    await renderQr()
  } catch (error) {
    S.toast(`读取远程配置失败:${String(error)}`, 'error')
  }
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
  const qrDataUrl = await API.remote.qrDataUrl()
  if (qrDataUrl !== null) {
    const img = document.createElement('img')
    img.src = qrDataUrl
    img.alt = '扫码连接'
    img.width = 180
    img.height = 180
    wrap.appendChild(img)
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
    const started = await API.qq.status()
    $id('qq-status').textContent = started ? '✓ 已连接 QQ' : (config.enabled && config.appId ? '连接中/失败,查看日志' : '')
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
    const started = await API.telegram.status()
    $id('tg-status').textContent = started ? '✓ 已启动' : (config.enabled && config.token ? '启动中/失败,查看日志' : '')
  } catch {
    // 忽略
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

// ---- 事件绑定 ----

function bind(): void {
  const view = harnessView()
  view.addEventListener('did-fail-load', (event) => {
    const details = event as unknown as { errorCode?: number; errorDescription?: string }
    $id('view-error-text').textContent = `加载失败(${String(details.errorCode)}):${details.errorDescription ?? '未知错误'}`
    $id('view-error').classList.remove('hidden')
  })
  view.addEventListener('dom-ready', () => {
    $id('view-error').classList.add('hidden')
    void syncWebviewWallpaper()
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
    await API.remote.setConfig({ enabled: input('remote-enabled').checked })
    await renderQr()
    S.toast(input('remote-enabled').checked ? '远程访问已启用' : '远程访问已关闭', 'ok')
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
}

init()

})()
