/**
 * 提问(选择题)端到端触发:创建会话并让 agent 调用提问工具。
 * 用法:node scripts/q-e2e-trigger.mjs <baseUrl> <token> <sessionId>
 * 输出会话 id 供 PWA 打开。
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:3082').replace(/\/+$/, '')
const token = process.argv[3]
const sid = process.argv[4]
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
;(async () => {
  const sessionId = sid ?? (await rpc('session.create', {})).sessionId
  console.log('SID=' + sessionId)
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '请用提问工具(ask_user_question)问我一个问题:「你更喜欢哪个颜色?」,选项:蓝色 / 绿色 / 金色。只问这一个问题,不要做其他事。' }],
  })
  console.log('prompt sent')
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
