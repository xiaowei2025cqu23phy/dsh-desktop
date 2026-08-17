// 诊断 Gemini 会话:创建 → selectModel → prompt → 打印原始事件
const base = 'http://127.0.0.1:3082'
const token = process.env.GATEWAY_TOKEN || ''
const provider = process.argv[2] || 'gemini'
const model = process.argv[3] || 'gemini-3.6-flash'

async function rpc(method, payload) {
  const res = await fetch(base + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ method, payload }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(JSON.stringify(data.error))
  return data.value
}

const created = await rpc('session.create', {})
console.log('created:', created.sessionId)
await rpc('session.selectModel', { sessionId: created.sessionId, provider, model })
console.log('selected:', provider + '/' + model)
try {
  await rpc('session.prompt', {
    sessionId: created.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '只回复两个字:成功' }],
  })
  console.log('prompt accepted')
} catch (e) {
  console.log('prompt ERROR:', e.message)
}
await new Promise((r) => setTimeout(r, 20000))
const hist = await rpc('session.history', { sessionId: created.sessionId, maxMessages: 20 })
const events = hist.events || []
console.log('event count:', events.length)
for (const entry of events) {
  const ev = entry.event || entry
  const t = ev.type || '?'
  const d = ev.data || {}
  if (t === 'turn/end') {
    console.log('turn/end:', JSON.stringify(d.reason || d).slice(0, 400))
  } else if (t === 'assistant/chunk') {
    console.log('chunk:', JSON.stringify(d.chunk || d).slice(0, 200))
  } else if (t === 'assistant/message') {
    console.log('message:', JSON.stringify(d.message || d).slice(0, 400))
  } else {
    console.log(t + ':', JSON.stringify(d).slice(0, 200))
  }
}
process.exit(0)
