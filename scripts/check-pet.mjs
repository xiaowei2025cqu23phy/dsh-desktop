// 通过 CDP 验证桌面宠物渲染:canvas 可见性 + 像素统计
// 用法: node scripts/check-pet.mjs
import WebSocket from 'ws'

const wsUrl = process.argv[2] || 'ws://127.0.0.1:9222/devtools/page/31FDC2282E9EA55572DE1AAC24A514B5'
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
})

ws.on('open', async () => {
  try {
    await send('Runtime.enable')
    const expr = `(() => {
      const c = document.getElementById('pet-canvas')
      if (!c) return { found: false }
      const style = getComputedStyle(c)
      const ctx = c.getContext('2d')
      const img = ctx.getImageData(0, 0, c.width, c.height).data
      let colored = 0
      let blue = 0
      for (let i = 0; i < img.length; i += 4) {
        if (img[i + 3] > 0) {
          colored++
          if (img[i + 2] > img[i]) blue++  // b > r: 鲸鱼蓝
        }
      }
      return {
        found: true,
        hidden: style.display === 'none',
        position: style.position,
        right: style.right,
        bottom: style.bottom,
        coloredPixels: colored,
        blueDominant: blue,
        total: c.width * c.height
      }
    })()`
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    console.log(JSON.stringify(res.result.value, null, 2))
    const v = res.result.value
    const ok = v.found && !v.hidden && v.position === 'fixed' && v.coloredPixels > 500 && v.blueDominant > 0
    console.log(ok ? 'PET_OK' : 'PET_FAIL')
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('ERR', e.message)
    process.exit(1)
  } finally {
    ws.close()
  }
})

ws.on('error', (e) => {
  console.error('WS_ERR', e.message)
  process.exit(1)
})
