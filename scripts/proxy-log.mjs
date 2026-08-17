// HTTP 日志代理:打印请求头/体并转发到目标 HTTPS 站点
// 用法:node scripts/proxy-log.mjs <listenPort> <targetHost> [targetPort]
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'

const port = Number(process.argv[2]) || 3083
const targetHost = process.argv[3] || 'generativelanguage.googleapis.com'
const targetPort = Number(process.argv[4]) || 443

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const auth = (req.headers.authorization || '').replace(/Bearer .{6}.*/, (m) => 'Bearer ' + m.slice(7, 13) + '…(len ' + (m.length - 7) + ')')
    console.log(`\n>>> ${req.method} ${req.url}`)
    console.log('    content-type:', req.headers['content-type'])
    console.log('    authorization:', auth)
    if (body.length > 0) {
      const text = body.toString('utf8')
      console.log('    body(' + body.length + 'B):', text.slice(0, 1500) + (text.length > 1500 ? '\n    …(truncated)' : ''))
    }
    const upstream = httpsRequest(
      { hostname: targetHost, port: targetPort, path: req.url, method: req.method, headers: { ...req.headers, host: targetHost } },
      (upRes) => {
        const resChunks = []
        upRes.on('data', (c) => resChunks.push(c))
        upRes.on('end', () => {
          const out = Buffer.concat(resChunks)
          console.log(`<<< ${upRes.statusCode} len=${out.length}`)
          if (out.length > 0 && (upRes.headers['content-type'] || '').includes('json')) {
            console.log('    resp:', out.toString('utf8').slice(0, 500))
          }
          res.writeHead(upRes.statusCode || 502, upRes.headers)
          res.end(out)
        })
      },
    )
    upstream.on('error', (e) => {
      console.log('    upstream error:', e.message)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'proxy upstream: ' + e.message } }))
    })
    upstream.end(body)
  })
})

server.listen(port, '127.0.0.1', () => console.log(`proxy listening on 127.0.0.1:${port} -> https://${targetHost}`))
