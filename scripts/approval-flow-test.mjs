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

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 个失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
