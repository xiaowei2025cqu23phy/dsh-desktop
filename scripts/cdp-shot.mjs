/**
 * CDP 截图:对指定 target 截图保存 PNG,可选模拟手机视口。
 * 用法:node scripts/cdp-shot.mjs <输出路径> [targetType] [width] [height]
 */

import { get } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const outPath = process.argv[2]
const targetType = process.argv[3] ?? 'page'
const width = Number(process.argv[4] ?? 0)
const height = Number(process.argv[5] ?? 0)
const titleKeyword = process.argv[6] ?? ''
const port = process.env.CDP_PORT ?? '9222'

get(`http://127.0.0.1:${port}/json`, (res) => {
  let data = ''
  res.on('data', (chunk) => { data += chunk })
  res.on('end', () => {
    const targets = JSON.parse(data)
    const target = targets.find((t) => t.type === targetType &&
      (titleKeyword === '' ||
        (titleKeyword.startsWith('url:')
          ? t.url.includes(titleKeyword.slice(4))
          : t.title.includes(titleKeyword))))
    if (target === undefined) {
      console.error(`no ${targetType}${titleKeyword !== '' ? ` titled *${titleKeyword}*` : ''} target found`)
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
      try {
        if (width > 0 && height > 0) {
          await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
        }
        const result = await call('Page.captureScreenshot', { format: 'png' })
        if (result.result?.data === undefined) {
          console.error('capture failed:', JSON.stringify(result).slice(0, 200))
          process.exit(1)
        }
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, Buffer.from(result.result.data, 'base64'))
        console.log('saved', outPath)
      } finally {
        ws.close()
        process.exit(0)
      }
    }
  })
})
