// 截取桌面宠物区域(右下角 canvas)并保存 PNG
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const wsUrl = process.argv[2]
const out = process.argv[3] || 'pet-shot.png'
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
    // 等 1.5s 让动画与图片加载
    await new Promise((r) => setTimeout(r, 1500))
    const info = await send('Runtime.evaluate', {
      expression: `(() => {
        const c = document.getElementById('pet-canvas')
        if (!c) return null
        const rect = c.getBoundingClientRect()
        const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let colored = 0, darkBlue = 0
        for (let i = 0; i < img.length; i += 4) {
          if (img[i + 3] > 0) {
            colored++
            if (img[i + 2] > 100 && img[i] < 90) darkBlue++
          }
        }
        return { rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, colored, darkBlue }
      })()`,
      returnByValue: true,
    })
    const v = info.result.value
    console.log('canvas:', JSON.stringify(v))
    if (!v) { process.exit(1) }
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: v.rect.x, y: v.rect.y, width: v.rect.w, height: v.rect.h, scale: 2 },
    })
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log('saved:', out)
    process.exit(v.colored > 500 ? 0 : 1)
  } catch (e) {
    console.error('ERR', e.message)
    process.exit(1)
  } finally {
    ws.close()
  }
})
ws.on('error', (e) => { console.error('WS_ERR', e.message); process.exit(1) })
