/**
 * 模拟手机 PWA 全流程测试:认证 → RPC → 事件流。
 * 用法:node scripts/remote-test.mjs <baseUrl> <token>
 */

const base = process.argv[2] ?? 'http://127.0.0.1:3082'
const token = process.argv[3] ?? ''

function rpc(method, payload) {
  return fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, payload: payload ?? {} }),
  }).then((res) => res.json())
}

async function main() {
  // 1. 静态页面与 info
  const info = await fetch(`${base}/api/info`).then((r) => r.json())
  console.log('1) /api/info ->', JSON.stringify(info))
  const pageRes = await fetch(`${base}/`)
  const page = { status: pageRes.status, type: pageRes.headers.get('content-type'), len: (await pageRes.text()).length }
  console.log('2) GET / ->', JSON.stringify(page))

  // 2. 无 token 401
  const unauthorized = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'host.describe', payload: {} }),
  })
  console.log('3) 无 token 状态 ->', unauthorized.status, '(期望 401)')

  // 3. 白名单外方法拒绝
  const denied = await rpc('settings.describe', {})
  console.log('4) 白名单外 settings.describe ->', denied.error ?? denied, '(期望 method not allowed)')

  // 4. 合法 RPC
  const host = await rpc('host.describe', {})
  console.log('5) host.describe ->', host.ok ? `ok, cwd=${host.value.cwd}` : JSON.stringify(host.error))

  const wsList = await rpc('workspace.list', {})
  console.log('6) workspace.list ->', wsList.ok ? `${wsList.value.items.length} 个工作区` : JSON.stringify(wsList.error))

  const sessions = await rpc('session.list', {})
  console.log('7) session.list ->', sessions.ok ? `${sessions.value.items.length} 个会话` : JSON.stringify(sessions.error))

  // 5. 事件流(手动 SSE)
  console.log('8) 事件流订阅中(25 秒)…')
  let frames = 0
  let types = new Set()
  let closed = false
  const esPromise = (async () => {
    const response = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!closed) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
        if (data === '') continue
        frames++
        try {
          const frame = JSON.parse(data)
          if (frame.method === 'session/event') types.add(frame.payload.event.type)
        } catch { /* 忽略 */ }
      }
    }
  })().catch((e) => console.log('   SSE 错误:', e.message))

  // 6. 创建会话并发送提示(真实任务)
  console.log('9) 创建任务会话…')
  const created = await rpc('session.create', {})
  console.log('   session.create ->', created.ok ? created.value.sessionId : JSON.stringify(created.error))
  if (created.ok) {
    const prompted = await rpc('session.prompt', {
      sessionId: created.value.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '请只回复两个字:收到,不要使用任何工具' }],
    })
    console.log('   session.prompt ->', prompted.ok ? '已入队' : JSON.stringify(prompted.error))
  }

  await new Promise((resolve) => setTimeout(resolve, 25000))
  closed = true
  await esPromise
  console.log('10) 事件流收到帧数:', frames, '事件类型:', [...types].slice(0, 10).join(','))

  if (created.ok) {
    const canceled = await rpc('session.cancel', { sessionId: created.value.sessionId })
    console.log('11) session.cancel ->', canceled.ok ? 'ok' : JSON.stringify(canceled.error))
  }
}

main().catch((error) => { console.error('测试失败:', error); process.exit(1) })
