// 验证桌面端与 PWA 的新 UI:按钮存在 + PWA 页面元素
import WebSocket from 'ws'

const desktopWs = process.argv[2]

// 打开 PWA 页面(桌面 CDP 创建 target)
function openTarget(wsUrl, url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 8000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === 1) {
        clearTimeout(timer)
        ws.close()
        resolve(msg.result && msg.result.targetId)
      }
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function listTargets(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 8000)
    ws.on('open', () => { ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' })) })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === 1) {
        clearTimeout(timer)
        ws.close()
        resolve(msg.result && msg.result.targetInfos || [])
      }
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function evalIn(wsUrl, expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 8000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === 1) {
        clearTimeout(timer)
        ws.close()
        resolve(msg.result && msg.result.result && msg.result.result.value)
      }
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

// 1. 桌面端 UI
const desktopCheck = `(() => {
  const pick = document.getElementById('btn-preset-pick')
  return { pickButton: pick !== null, pickText: pick ? pick.textContent : '' }
})()`
try {
  console.log('[desktop] ' + JSON.stringify(await evalIn(desktopWs, desktopCheck)))
} catch (e) {
  console.log('[desktop] ERROR: ' + e.message)
}

// 2. 打开 PWA 并检查元素
try {
  const token = 'REPLACED_WITH_GATEWAY_TOKEN'
  const pwaUrl = 'http://127.0.0.1:3082/?token=' + token
  const targetId = await openTarget(desktopWs, pwaUrl)
  await new Promise((r) => setTimeout(r, 2500))
  const targets = await listTargets(desktopWs)
  const pwa = targets.find((t) => t.url.indexOf('3082') !== -1 && t.type === 'page')
  if (!pwa) {
    console.log('[pwa] ERROR: PWA target not found')
    process.exit(1)
  }
  const pwaCheck = `(() => {
    const ids = ['view-fs', 'view-fspreview', 'fs-crumb', 'fs-list', 'preset-roots', 'btn-preset-add']
    const found = {}
    ids.forEach(function (id) { found[id] = document.getElementById(id) !== null })
    return found
  })()`
  console.log('[pwa] ' + JSON.stringify(await evalIn(pwa.webSocketDebuggerUrl, pwaCheck)))
} catch (e) {
  console.log('[pwa] ERROR: ' + e.message)
}
process.exit(0)
