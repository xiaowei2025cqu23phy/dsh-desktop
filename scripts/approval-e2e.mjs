/**
 * 审批端到端真实链路测试(需 harness 运行中,会消耗少量模型额度)。
 *
 * 覆盖:approval/requested 帧经网关 SSE 送达 → /api/respond 应答 → accepted 回执。
 * 用法:node scripts/approval-e2e.mjs [baseUrl] [token]
 * 说明:默认 127.0.0.1:3082 与 token 参数;触发"写工作区外非临时文件"审批,
 *       以 allowed-once 应答后校验回执 accepted:true。
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:3082').replace(/\/+$/, '')
const token = process.argv[3]
if (token === undefined) {
  console.error('用法:node scripts/approval-e2e.mjs <baseUrl> <token>')
  process.exit(2)
}

const rpc = async (m, p) => {
  const r = await fetch(base + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ method: m, payload: p || {} }),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json()
  if (!j.ok) throw new Error((j.error && j.error.message) || m + ' failed')
  return j.value
}

const target = `C:/Users/${process.env.USERNAME ?? 'user'}/AppData/Local/dsh-approval-e2e-${Date.now()}.txt`

;(async () => {
  const ac = new AbortController()
  const es = await fetch(base + '/api/events?token=' + token, { signal: ac.signal })
  const reader = es.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let responded = false
  const watch = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('\n')
        if (!data) continue
        try {
          const f = JSON.parse(data)
          if (f.method === 'approval/requested') {
            console.log('✓ approval/requested 帧送达:', f.payload.toolName, f.payload.sessionId.slice(0, 14))
            const r = await fetch(base + '/api/respond', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
              body: JSON.stringify({
                type: 'client-response',
                rpcId: f.rpcId,
                result: {
                  ok: true,
                  value: { sessionId: f.payload.sessionId, approvalId: f.payload.approvalId, outcome: 'allowed-once' },
                },
              }),
              signal: AbortSignal.timeout(15000),
            })
            const receipt = await r.json()
            console.log('✓ /api/respond 回执:', JSON.stringify(receipt))
            if (receipt.accepted !== true) throw new Error('应答未被接受:' + (receipt.reason ?? 'unknown'))
            responded = true
            ac.abort()
            return
          }
        } catch { /* 忽略非目标帧 */ }
      }
    }
  })()

  const c = await rpc('session.create', {})
  console.log('会话:', c.sessionId)
  await rpc('session.prompt', {
    sessionId: c.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: `把文字 approval-e2e 写入文件 ${target}(只做这一步,不要做其他事)` }],
  })
  console.log('已发送提示词,等待审批帧…(最多 60 秒)')
  const timeout = setTimeout(() => { console.error('✗ 超时:未收到审批帧(审批策略可能为 never 或该路径被预设放行)'); ac.abort() }, 60000)
  await watch.catch((e) => { if (!ac.signal.aborted) throw e })
  clearTimeout(timeout)
  if (!responded) process.exit(2)
  console.log('✓ 审批端到端链路全部通过(帧送达 → 应答 → accepted)')
  process.exit(0)
})().catch((e) => { console.error('✗', e.message); process.exit(1) })
