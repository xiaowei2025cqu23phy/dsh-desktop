/**
 * 端到端管线测试:设置默认模型 → 创建会话 → 发送提示 → 订阅 mux 事件流。
 * 用法:node scripts/mux-test.mjs [baseUrl] [provider] [model]
 * 注意:会真实修改目标 harness 的默认模型并消耗少量模型调用。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { HarnessClient } = require('../dist/main/client.js')
const { ModelManager } = require('../dist/main/models.js')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080'
const provider = process.argv[3] ?? 'deepseek-official'
const model = process.argv[4] ?? 'deepseek-v4-flash'

const client = new HarnessClient(baseUrl)

console.log(`1) 设置默认模型 ${provider}/${model} (session.selectModel,host 同时持久化为默认)…`)
const mm = new ModelManager(() => client)
const applied = await mm.setDefault(provider, model)
console.log(`   已写入并应用到会话 ${applied.appliedToSession}`)

console.log('2) 创建会话并发送提示 …')
const created = await client.rpc('session.create', {})
const targetSessionId = created.sessionId
await client.rpc('session.prompt', {
  sessionId: targetSessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '请只回复两个字:收到' }],
})
console.log(`   会话 ${targetSessionId}`)

console.log('3) 订阅 mux 事件流并等待 30 秒 …')
const seenTypes = new Set()
let assistantText = ''
let toolCalls = 0
let turnCount = 0
const deadline = Date.now() + 30000
const stop = client.openMux((frame) => {
  if (frame.method !== 'session/event') return
  const payload = frame.payload
  const event = payload.event
  if (payload.sessionId !== targetSessionId) return
  seenTypes.add(event.type)
  const data = event.data ?? {}
  if (event.type === 'assistant/chunk' && data.chunk?.type === 'text-delta') {
    assistantText += data.chunk.text
  }
  if (event.type === 'tool/call') toolCalls += 1
  if (event.type === 'turn/end') turnCount += 1
  if (event.type === 'turn/end' && Date.now() > deadline) return false
})

await new Promise((resolve) => setTimeout(resolve, 30000))

console.log('4) 取消会话并断开 …')
try { await client.rpc('session.cancel', { sessionId: targetSessionId }) } catch { /* 已结束 */ }
stop()

console.log('--- 结果 ---')
console.log(`收到事件类型:${[...seenTypes].join(', ')}`)
console.log(`turn/end 次数:${turnCount},工具调用:${toolCalls}`)
console.log(`助手文本:${assistantText.slice(0, 200) || '(空,可能超时)'}`)
