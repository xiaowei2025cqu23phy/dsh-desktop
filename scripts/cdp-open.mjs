/**
 * CDP 创建新页面(target)并打开指定 URL。
 * 用法:node scripts/cdp-open.mjs <url>
 */

import { get } from 'node:http'

const url = process.argv[2]
const port = process.env.CDP_PORT ?? '9222'

get(`http://127.0.0.1:${port}/json/version`, (res) => {
  let data = ''
  res.on('data', (chunk) => { data += chunk })
  res.on('end', () => {
    const version = JSON.parse(data)
    const ws = new WebSocket(version.webSocketDebuggerUrl)
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
      const result = await call('Target.createTarget', { url })
      console.log(result.result?.targetId ?? JSON.stringify(result))
      ws.close()
      process.exit(0)
    }
  })
})
