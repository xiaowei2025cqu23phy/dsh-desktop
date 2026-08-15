/**
 * 通过 CDP Input 域向指定 target 派发真实鼠标点击(最接近物理点击)。
 * 用法:node scripts/cdp-click.mjs <x> <y>
 */

import { get } from 'node:http'

const x = Number(process.argv[2] ?? '200')
const y = Number(process.argv[3] ?? '200')
const port = process.env.CDP_PORT ?? '9222'

get(`http://127.0.0.1:${port}/json`, (res) => {
  let data = ''
  res.on('data', (chunk) => { data += chunk })
  res.on('end', () => {
    const targets = JSON.parse(data)
    const target = targets.find((t) => t.title.includes('屏保'))
    if (target === undefined) {
      console.error('no screensaver target')
      process.exit(1)
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      const resolve = pending.get(message.id)
      if (resolve !== undefined) { pending.delete(message.id); resolve(message) }
    }
    const call = (method, params = {}) => new Promise((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
    ws.onopen = async () => {
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      console.log('click dispatched at', x, y)
      ws.close()
      process.exit(0)
    }
  })
})
