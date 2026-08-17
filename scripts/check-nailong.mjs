// 验证第三方中转站(nailongapi)端到端:创建会话 → 选模型 → prompt → 读结果
// 用法:GATEWAY_TOKEN=xxx node scripts/check-nailong.mjs [provider] [model]
const base = 'http://127.0.0.1:3082'
const token = process.env.GATEWAY_TOKEN || ''
const provider = process.argv[2] || 'nailongapi'
const model = process.argv[3] || 'gpt-5.6-sol'

if (token === '') {
  console.error('请设置 GATEWAY_TOKEN 环境变量')
  process.exit(1)
}

async function rpc(method, payload) {
  const res = await fetch(base + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ method, payload }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error((data.error && data.error.message) || 'rpc failed')
  return data.value
}

const created = await rpc('session.create', {})
console.log('created:', created.sessionId)
await rpc('session.selectModel', { sessionId: created.sessionId, provider, model })
console.log(`model selected: ${provider}/${model}`)
await rpc('session.prompt', {
  sessionId: created.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回复两个字:成功' }],
})
console.log('prompt sent, waiting…')
await new Promise((r) => setTimeout(r, 25000))
const hist = await rpc('session.history', { sessionId: created.sessionId, maxMessages: 10 })
const events = hist.events || []
let reply = ''
for (const entry of events) {
  const ev = entry.event || entry
  if (ev.type === 'assistant/message' && ev.data && ev.data.message) {
    const blocks = ev.data.message.content || []
    reply += blocks.map((b) => b.text || '').join('')
  }
}
console.log('REPLY:', JSON.stringify(reply.slice(0, 300)))
const ok = reply.trim() !== ''
console.log(ok ? 'NAILONG_OK' : 'NAILONG_FAIL')
process.exit(ok ? 0 : 1)
