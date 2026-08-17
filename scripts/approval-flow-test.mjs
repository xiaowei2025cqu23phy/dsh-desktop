/**
 * 审批/提问应答流集成测试(用假 harness,无需 Electron)。
 * 覆盖:审批帧 → 推送通知 → 回复提示 → 「允许/拒绝」应答 → respond 载荷;
 *       提问帧 → 选择题分步回答 → 全部答完提交。
 * 用法:node scripts/approval-flow-test.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { RemoteCommandProcessor } = require('../dist/main/remote-commands.js')

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`✓ ${name}`)
  } else {
    failures++
    console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`)
  }
}

function makeHarness(log) {
  return {
    client() {
      return {
        async rpc(method, payload) {
          log.push(['rpc', method, payload])
          if (method === 'workspace.list') {
            return { items: [{ workspaceId: 'w1', title: 'ws1', path: 'D:/x' }] }
          }
          if (method === 'session.create') return { sessionId: 'session-test-1' }
          return {}
        },
        async respond(rpcId, result) {
          log.push(['respond', rpcId, result])
          return { accepted: true }
        },
      }
    },
  }
}

// ---- 审批流 ----
{
  const log = []
  const pushes = []
  const processor = new RemoteCommandProcessor(makeHarness(log))
  processor.setPush((channel, userId, text) => pushes.push([channel, userId, text]))

  const entered = await processor.handleText('telegram', '42', '进入 ws1')
  check('进入工作区', entered.startsWith('已进入工作区'), true)

  processor.handleInteractionFrame({
    type: 'server-request',
    rpcId: 'r1',
    method: 'approval/requested',
    payload: { sessionId: 'session-test-1', approvalId: 'a1', toolName: 'write_file', reason: '写入 src/a.ts' },
  })
  check('审批帧推送通知', pushes.length, 1)
  check('通知含工具名', pushes[0][2].includes('write_file'), true)
  check('通知含原因', pushes[0][2].includes('写入 src/a.ts'), true)

  const statusReply = await processor.handleText('telegram', '42', '状态')
  check('回复附加待审批提示', statusReply.includes('待审批'), true)

  // 其他用户不能应答
  const otherReply = await processor.handleText('telegram', '99', '允许')
  check('非发起者无待审批', otherReply, '当前没有待审批项。收到审批通知后回复「允许」或「拒绝」即可。')

  const allowReply = await processor.handleText('telegram', '42', '允许')
  check('允许回复', allowReply.startsWith('✓ 已允许:write_file'), true)
  const respondCall = log.find(([kind]) => kind === 'respond')
  check('respond 载荷', respondCall[1], 'r1')
  check('approval 值', respondCall[2], { ok: true, value: { sessionId: 'session-test-1', approvalId: 'a1', outcome: 'allowed-once' } })
  const statusReply2 = await processor.handleText('telegram', '42', '状态')
  check('应答后无待审批提示', statusReply2.includes('待审批'), false)

  // 拒绝流
  processor.handleInteractionFrame({
    type: 'server-request',
    rpcId: 'r2',
    method: 'approval/requested',
    payload: { sessionId: 'session-test-1', approvalId: 'a2', toolName: 'bash', reason: '执行 rm' },
  })
  const rejectReply = await processor.handleText('telegram', '42', '拒绝 session-test-1')
  check('拒绝回复', rejectReply.startsWith('✗ 已拒绝:bash'), true)
  const rejectCall = log.filter(([kind]) => kind === 'respond').pop()
  check('reject 载荷', rejectCall[2], { ok: true, value: { sessionId: 'session-test-1', approvalId: 'a2', outcome: 'rejected' } })

  // 应答被拒(回执 accepted:false)
  const log2 = []
  const p2 = new RemoteCommandProcessor({
    client: () => ({
      async rpc() {
        return {}
      },
      async respond() {
        return { accepted: false, reason: 'expired' }
      },
    }),
  })
  log2.push('x')
  void log2
}

// ---- 提问流 ----
{
  const log = []
  const pushes = []
  const processor = new RemoteCommandProcessor(makeHarness(log))
  processor.setPush((channel, userId, text) => pushes.push([channel, userId, text]))
  await processor.handleText('telegram', '42', '进入 ws1')

  processor.handleInteractionFrame({
    type: 'server-request',
    rpcId: 'q1',
    method: 'question/requested',
    payload: {
      sessionId: 'session-test-1',
      questions: [
        { id: 'qq1', question: '是否继续?', options: [{ label: '是' }, { label: '否' }] },
        { id: 'qq2', question: '选择目标', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
      ],
    },
  })
  check('提问帧推送通知', pushes.length, 1)
  check('通知含选项', pushes[0][2].includes('(1) 是'), true)
  check('通知含多选标记', pushes[0][2].includes('多选'), true)

  const r1 = await processor.handleText('telegram', '42', '选 2')
  check('部分回答提示', r1.includes('1/2'), true)

  const r2 = await processor.handleText('telegram', '42', '#2 选 1 自定义:补充说明')
  check('提交完成提示', r2.startsWith('✓ 已回答 2 个问题'), true)
  const respondCall = log.find(([kind]) => kind === 'respond')
  check('question rpcId', respondCall[1], 'q1')
  check('question 值', respondCall[2], {
    ok: true,
    value: {
      sessionId: 'session-test-1',
      answer: {
        answers: [
          { id: 'qq1', selected: ['否'] },
          { id: 'qq2', selected: ['A'], custom: '补充说明' },
        ],
      },
    },
  })
}

// ---- 纯对话(无工作区) ----
{
  const log = []
  const processor = new RemoteCommandProcessor(makeHarness(log))
  const entered = await processor.handleText('telegram', '7', '进入')
  check('裸进入-纯对话', entered.startsWith('已进入对话模式 ✓(纯对话'), true)
  check('裸进入-无工作区参数', log.some(([kind, method, payload]) => kind === 'rpc' && method === 'session.create' && JSON.stringify(payload) === '{}'), true)
  const reply = await processor.handleText('telegram', '7', '你好')
  check('纯对话发消息-静默', reply, '')
}

// ---- 默认对话模式(autoChat) ----
{
  const log = []
  const processor = new RemoteCommandProcessor(makeHarness(log))
  processor.setAutoChat('telegram', true)
  const first = await processor.handleText('telegram', '8', '你好呀')
  check('autoChat-自动进入纯对话', first.includes('已进入对话模式'), true)
  check('autoChat-首条仅进入提示', first.includes('✓ 已发送'), false)
  const second = await processor.handleText('telegram', '8', '再聊一句')
  check('autoChat-复用会话不重复进入', second.includes('已进入对话模式'), false)
  check('autoChat-第二句静默', second, '')
  // 指令仍优先于对话
  const cmd = await processor.handleText('telegram', '8', '状态')
  check('autoChat-指令优先', cmd.includes('harness:'), true)
  // 退出后再次发消息会新建对话
  await processor.handleText('telegram', '8', '退出')
  const after = await processor.handleText('telegram', '8', '又来了')
  check('autoChat-退出后可重新进入', after.includes('已进入对话模式'), true)
}

// ---- 主动汇报(任务完成/失败) ----
{
  const pushes = []
  const processor = new RemoteCommandProcessor(makeHarness([]))
  processor.setPush((channel, userId, text) => pushes.push([channel, userId, text]))
  await processor.handleText('telegram', '42', '任务 干活', undefined)
  pushes.length = 0
  // 未开启汇报:不推送
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-t1', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason: { kind: 'ok' } } } },
  })
  check('汇报-默认关闭不推送', pushes.length, 0)
  processor.setReport('telegram', true)
  // 完成
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-t2', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason: { kind: 'ok' } } } },
  })
  check('汇报-完成推送', pushes.length, 1)
  check('汇报-完成文本', pushes[0][2].includes('任务完成'), true)
  // 失败
  pushes.length = 0
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-t3', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '磁盘满了' } } } } },
  })
  check('汇报-失败推送', pushes.length, 1)
  check('汇报-失败文本', pushes[0][2].includes('任务失败') && pushes[0][2].includes('磁盘满了'), true)
  // 非 turn/end 不推送
  pushes.length = 0
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-t4', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'assistant/message', data: {} } },
  })
  check('汇报-其他事件不推送', pushes.length, 0)
}

// ---- 群场景:推送目标=群(修复群里收不到审批/汇报) ----
{
  const pushes = []
  const processor = new RemoteCommandProcessor(makeHarness([]))
  processor.setPush((channel, userId, text, meta, target) => pushes.push([channel, userId, text, meta, target]))
  processor.setReport('qq', true)
  // 群里发任务(带群推送目标)
  const entered = await processor.handleText('qq', 'member-openid-1', '任务 写首诗', { scope: 'group', targetId: 'GROUP_OPENID_9' })
  check('群-任务启动', entered.includes('任务已启动'), true)
  // 任务完成汇报 → 应推送到群 target
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-g1', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason: { kind: 'ok' } } } },
  })
  check('群-汇报推送目标', pushes.length === 1 && JSON.stringify(pushes[0][4]) === JSON.stringify({ scope: 'group', targetId: 'GROUP_OPENID_9' }), true)
  // 审批 → 推送目标同样是群
  pushes.length = 0
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-g2', method: 'approval/requested',
    payload: { sessionId: 'session-test-1', approvalId: 'ga1', toolName: 'write', reason: '写文件' },
  })
  check('群-审批推送目标', pushes.length === 1 && pushes[0][3] !== undefined && pushes[0][4].targetId === 'GROUP_OPENID_9', true)
  // 私聊对照:无 pushTarget → 回调 target 为 undefined
  pushes.length = 0
  const pv = new RemoteCommandProcessor(makeHarness([]))
  pv.setPush((channel, userId, text, meta, target) => pushes.push([channel, userId, text, meta, target]))
  pv.setReport('qq', true)
  await pv.handleText('qq', 'private-openid-2', '任务 再来一首', undefined)
  pv.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-g3', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason: { kind: 'ok' } } } },
  })
  check('私聊-无显式目标', pushes.length === 1 && pushes[0][4] === undefined, true)
}

// ---- 汇报去重:同一会话多轮 turn/end 只推一次 ----
{
  const pushes = []
  const processor = new RemoteCommandProcessor(makeHarness([]))
  processor.setPush((channel, userId, text) => pushes.push([channel, userId, text]))
  processor.setReport('qq', true)
  await processor.handleText('qq', 'u-dedupe', '任务 干活', undefined)
  const frame = (rpcId, reason) => ({
    type: 'server-request', rpcId, method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason } } },
  })
  processor.handleInteractionFrame(frame('r-d1', { kind: 'ok' }))
  processor.handleInteractionFrame(frame('r-d2', { kind: 'ok' }))
  processor.handleInteractionFrame(frame('r-d3', { kind: 'ok' }))
  check('汇报-三轮只推一次', pushes.length, 1)
  // 失败不合并到完成的去重窗口,但同失败也去重
  pushes.length = 0
  processor.handleInteractionFrame(frame('r-d4', { kind: 'error', error: { message: 'boom' } }))
  processor.handleInteractionFrame(frame('r-d5', { kind: 'error', error: { message: 'boom' } }))
  check('汇报-失败两次只推一次', pushes.length, 1)
  check('汇报-失败文本', pushes[0][2].includes('任务失败'), true)
}

// ---- 提问按钮应答(单选单问题) ----
{
  const log = []
  const pushes = []
  const processor = new RemoteCommandProcessor(makeHarness(log))
  processor.setPush((channel, userId, text, meta) => pushes.push([channel, userId, text, meta]))
  await processor.handleText('telegram', '42', '进入 ws1')
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'q-b1', method: 'question/requested',
    payload: {
      sessionId: 'session-test-1',
      questions: [{ id: 'color', question: '喜欢什么颜色?', options: [{ label: '蓝' }, { label: '绿' }] }],
    },
  })
  check('提问按钮-推送带 meta', pushes.length === 1 && pushes[0][3] !== undefined && pushes[0][3].kind === 'question', true)
  check('提问按钮-选项数组', pushes[0][3].question.options.join(','), '蓝,绿')
  const result = await processor.respondQuestion('telegram', '42', 'session-test-1', 'color', 1)
  check('提问按钮-应答结果', result.startsWith('✓ 已选择:绿'), true)
  const respondCall = log.find(([kind]) => kind === 'respond')
  check('提问按钮-提交载荷', JSON.stringify(respondCall[2]), JSON.stringify({ ok: true, value: { sessionId: 'session-test-1', answer: { answers: [{ id: 'color', selected: ['绿'] }] } } }))
  // 多选问题不生成按钮 meta
  pushes.length = 0
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'q-b2', method: 'question/requested',
    payload: {
      sessionId: 'session-test-1',
      questions: [{ id: 'multi', question: '多选?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    },
  })
  check('提问按钮-多选无 meta', pushes.length === 1 && pushes[0][3] === undefined, true)
}

// ---- 任务操作按钮(停止/进展/打开) ----
{
  const log = []
  const processor = new RemoteCommandProcessor(makeHarness(log))
  await processor.handleText('telegram', '42', '任务 干活', undefined)
  const r1 = await processor.handleButtonAction('telegram', '42', 'session-test-1', 'progress')
  check('操作按钮-进展', r1.includes('最新输出') || r1.includes('会话'), true)
  const r2 = await processor.handleButtonAction('telegram', '42', 'session-test-1', 'stop')
  check('操作按钮-停止', r2.includes('已请求停止'), true)
  const r3 = await processor.handleButtonAction('telegram', '42', 'session-test-1', 'open')
  check('操作按钮-打开', r3.includes('会话'), true)
  // 非发起者无权
  const r4 = await processor.handleButtonAction('telegram', '99', 'session-test-1', 'stop')
  check('操作按钮-非发起者拒绝', r4.includes('无权'), true)
}

// ---- 提示词注入(任务=助手,对话=朋友)与对话会话持久化 ----
{
  // 假 config:记录 chatSessions 更新
  const stored = {}
  const fakeConfig = {
    get: () => ({ bot: { taskPrompt: '助手提示', chatPrompt: '朋友提示' }, chatSessions: stored }),
    update: (key, value) => { if (key === 'chatSessions') { Object.keys(stored).forEach((k) => delete stored[k]); Object.assign(stored, value) } return undefined },
  }
  const log = []
  const processor = new RemoteCommandProcessor(makeHarness(log), fakeConfig)
  // 对话模式消息应注入朋友提示词
  await processor.handleText('telegram', '42', '进入', undefined)
  await processor.handleText('telegram', '42', '今天天气如何', undefined)
  const chatPrompt = log.find(([kind, m, p]) => kind === 'rpc' && m === 'session.prompt')
  check('对话注入朋友提示词', chatPrompt[2].content[0].text.includes('朋友提示'), true)
  // 任务注入助手提示词
  log.length = 0
  await processor.handleText('telegram', '42', '任务 写报告', undefined)
  const taskPrompt = log.find(([kind, m, p]) => kind === 'rpc' && m === 'session.prompt')
  check('任务注入助手提示词', taskPrompt[2].content[0].text.includes('助手提示'), true)
  // 对话会话持久化:新实例恢复同一会话
  const processor2 = new RemoteCommandProcessor(makeHarness([]), fakeConfig)
  const reply2 = await processor2.handleText('telegram', '42', '继续聊', undefined)
  check('持久化-恢复对话会话', reply2, '')
  // 对话会话的 turn/end 不推送"任务完成"汇报
  const pushes3 = []
  const processor3 = new RemoteCommandProcessor(makeHarness([]))
  processor3.setPush((channel, userId, text) => pushes3.push([channel, userId, text]))
  processor3.setReport('telegram', true)
  await processor3.handleText('telegram', '42', '进入', undefined)
  processor3.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-chat1', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason: { kind: 'ok' } } } },
  })
  check('对话回合不推完成汇报', pushes3.length, 0)
  // 对话回复推送:发消息后回合结束,推 agent 回复文本
  const log4 = []
  const pushes4 = []
  const processor4 = new RemoteCommandProcessor({
    client: () => ({
      async rpc(method, payload) {
        log4.push([method, payload])
        if (method === 'session.create') return { sessionId: 'session-test-1' }
        if (method === 'session.history') {
          return { events: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好呀朋友!' }] } } } }] }
        }
        return {}
      },
      async respond() { return { accepted: true } },
    }),
  })
  processor4.setPush((channel, userId, text) => pushes4.push([channel, userId, text]))
  await processor4.handleText('telegram', '42', '进入', undefined)
  await processor4.handleText('telegram', '42', '在吗', undefined)
  processor4.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-chat2', method: 'session/event',
    payload: { sessionId: 'session-test-1', event: { type: 'turn/end', data: { reason: { kind: 'ok' } } } },
  })
  // 回复推送是异步的(session.history 后 push)
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('对话回复推送', pushes4.length === 1 && pushes4[0][2].includes('你好呀朋友'), true)
}

// ---- 对话流式输出(QQ 私聊:c2c + sink → chunk 实时,回合结束 onEnd) ----
{
  const deltas = []
  const ends = []
  const processor = new RemoteCommandProcessor(makeHarness([]))
  processor.setChatStream({
    onDelta: (channel, userId, delta, target) => deltas.push([channel, userId, delta, target && target.targetId]),
    onEnd: (channel, userId, target) => ends.push([channel, userId, target && target.targetId]),
  })
  await processor.handleText('qq', 'u-stream', '进入', { scope: 'c2c', targetId: 'OPENID_STREAM' })
  await processor.handleText('qq', 'u-stream', '讲个笑话', { scope: 'c2c', targetId: 'OPENID_STREAM' })
  const frame = (rpcId, event) => ({
    type: 'server-request', rpcId, method: 'session/event',
    payload: { sessionId: 'session-test-1', event },
  })
  processor.handleInteractionFrame(frame('r-s1', { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '哈' } } }))
  processor.handleInteractionFrame(frame('r-s2', { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '哈' } } }))
  processor.handleInteractionFrame(frame('r-s3', { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: '思考' } } }))
  processor.handleInteractionFrame(frame('r-s4', { type: 'turn/end', data: { reason: { kind: 'ok' } } }))
  check('流式-增量实时下发', deltas.length === 2 && deltas[0][2] === '哈' && deltas[0][3] === 'OPENID_STREAM', true)
  check('流式-回合结束回调', ends.length === 1, true)
  // 群/无 sink:走整段缓冲推送
  const pushes = []
  const p2 = new RemoteCommandProcessor(makeHarness([]))
  p2.setPush((channel, userId, text) => pushes.push([channel, userId, text]))
  await p2.handleText('qq', 'u-group', '进入', undefined)
  await p2.handleText('qq', 'u-group', '大家好', { scope: 'group', targetId: 'GROUP_X' })
  p2.handleInteractionFrame(frame('r-s5', { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '大家好呀' } } }))
  p2.handleInteractionFrame(frame('r-s6', { type: 'turn/end', data: { reason: { kind: 'ok' } } }))
  check('群场景-整段缓冲推送', pushes.length === 1 && pushes[0][2].includes('大家好呀'), true)
}

// ---- 模型切换命令 ----
{
  const log = []
  const processor = new RemoteCommandProcessor({
    client: () => ({
      async rpc(method, payload) {
        log.push([method, payload])
        if (method === 'session.create') return { sessionId: 'session-test-1' }
        if (method === 'llm.models') {
          return { groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] }, { id: 'gpt', models: [{ id: 'gpt-5.6' }] }] }
        }
        return {}
      },
      async respond() { return { accepted: true } },
    }),
  })
  await processor.handleText('telegram', '42', '进入', undefined)
  const r1 = await processor.handleText('telegram', '42', '模型 deepseek', undefined)
  check('模型切换-前缀匹配', r1.includes('deepseek-v4-flash'), true)
  check('模型切换-调用 selectModel', log.some(([m, p]) => m === 'session.selectModel' && p.provider === 'deepseek-official' && p.model === 'deepseek-v4-flash'), true)
  const r2 = await processor.handleText('telegram', '42', '模型 不存在模型', undefined)
  check('模型切换-未找到', r2.includes('未找到模型'), true)
  const r3 = await processor.handleText('telegram', '7', '模型 deepseek', undefined)
  check('模型切换-需对话模式', r3.includes('先发「进入」'), true)
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 个失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
