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

function harnessView(): WebviewElement {
  return document.getElementById('harness-view') as unknown as WebviewElement
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
  await Promise.all([loadHarnessConfig(), loadScreensaverConfig(), loadRegistered(), refreshLogs()])
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
}

init()

})()
