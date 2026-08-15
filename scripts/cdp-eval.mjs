/**
 * CDP 检查器:连接 Electron 的 --remote-debugging-port,对页面执行表达式。
 * 用法:node scripts/cdp-eval.mjs '<表达式>' [targetType=page]
 */

import { get } from 'node:http'

const expression = process.argv[2]
const targetType = process.argv[3] ?? 'page'
const port = process.env.CDP_PORT ?? '9222'

get(`http://127.0.0.1:${port}/json`, (res) => {
  let data = ''
  res.on('data', (chunk) => { data += chunk })
  res.on('end', () => {
    const targets = JSON.parse(data)
    const target = targets.find((t) => t.type === targetType)
    if (target === undefined) {
      console.error(`no ${targetType} target found`)
      process.exit(1)
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      const resolve = pending.get(message.id)
      if (resolve !== undefined) {
        pending.delete(message.id)
        resolve(message)
      }
    }
    const call = (method, params = {}) => new Promise((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
    ws.onopen = async () => {
      try {
        await call('Runtime.enable')
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result.result?.exceptionDetails !== undefined) {
          console.error('EXCEPTION:', JSON.stringify(result.result.exceptionDetails, null, 2))
          process.exit(1)
        }
        console.log(JSON.stringify(result.result?.result?.value, null, 2))
      } finally {
        ws.close()
        process.exit(0)
      }
    }
  })
})
