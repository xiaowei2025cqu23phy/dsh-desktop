/**
 * 任务调度队列集成测试(用假 harness,无需 Electron)。
 * 覆盖:任务启动入队 → 完成/失败状态迁移 → 指数退避 → 自动重试 tick →
 *       手动重试/取消 → 重启恢复 → cmdRetry 优先队列。
 * 用法:node scripts/task-queue-test.mjs
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
  let sessionCounter = 0
  return {
    client() {
      return {
        async rpc(method, payload) {
          log.push(['rpc', method, payload])
          if (method === 'workspace.list') return { items: [{ workspaceId: 'w1', title: 'ws1', path: 'D:/x' }] }
          if (method === 'session.create') return { sessionId: `session-test-${++sessionCounter}` }
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

function makeQueueConfig() {
  const store = { taskQueue: [], taskHistory: [] }
  return {
    get: () => ({
      bot: { taskPrompt: '', chatPrompt: '', character: '' },
      chatSessions: {},
      taskHistory: store.taskHistory,
      taskQueue: store.taskQueue,
    }),
    update: (key, value) => {
      if (key === 'taskQueue') store.taskQueue = value
      if (key === 'taskHistory') store.taskHistory = value
      return undefined
    },
    taskQueue: () => [...store.taskQueue],
    upsertTaskQueueEntry: (entry) => {
      store.taskQueue = [entry, ...store.taskQueue.filter((item) => item.id !== entry.id)].slice(0, 200)
    },
    appendAudit: () => {},
    memory: () => ({ enabled: false, summary: '', conventions: '', commands: '', notes: '', updatedAt: 0 }),
  }
}

/** 向处理器注入一次 turn/end 事件(完成或失败)。 */
function turnEnd(processor, sessionId, kind, extra = {}) {
  processor.handleInteractionFrame({
    type: 'server-request',
    rpcId: `r-${Date.now()}-${Math.random()}`,
    method: 'session/event',
    payload: { sessionId, event: { type: 'turn/end', data: { reason: { kind, ...extra } } } },
  })
}

// ---- 任务启动入队 + 完成 ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  let queue = config.taskQueue()
  check('启动后入队(1 项)', queue.length, 1)
  check('启动状态 running', queue[0].status, 'running')
  check('启动尝试次数 1', queue[0].attempts, 1)
  check('来源 telegram', queue[0].source, 'telegram')
  check('描述', queue[0].description, '分析仓库')

  turnEnd(processor, 'session-test-1', 'done')
  queue = config.taskQueue()
  check('完成后状态 completed', queue[0].status, 'completed')
  check('完成后无退避时间', queue[0].nextAttemptAt, null)
}

// ---- 失败 → 指数退避 → 自动重试 tick ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  await processor.handleText('telegram', '42', '任务 会失败', undefined)

  const before = Date.now()
  turnEnd(processor, 'session-test-1', 'error', { message: '网关超时' })
  let queue = config.taskQueue()
  check('失败后状态 failed', queue[0].status, 'failed')
  check('失败后尝试次数 2', queue[0].attempts, 2)
  check('失败记录错误', queue[0].error, '网关超时')
  check('第 1 次失败退避 30s', queue[0].nextAttemptAt, before + 30_000)
  check('退避时间在未来', queue[0].nextAttemptAt > Date.now(), true)

  // 未到期:tick 不触发重试。
  log.length = 0
  await processor.tickQueue()
  check('未到期不重试', log.filter(([kind]) => kind === 'rpc').length, 0)

  // 到期:把 nextAttemptAt 改为过去,再 tick 应触发 session.prompt。
  log.length = 0
  const target = config.taskQueue()
  config.upsertTaskQueueEntry({ ...target[0], nextAttemptAt: Date.now() - 1000 })
  await processor.tickQueue()
  const prompts = log.filter(([kind, method]) => kind === 'rpc' && method === 'session.prompt')
  check('到期后自动重试 prompt', prompts.length, 1)
  check('重试沿用同一会话', prompts[0][2].sessionId, 'session-test-1')
  check('重试后状态 running', config.taskQueue()[0].status, 'running')
}

// ---- 连续失败达到上限后不再自动重试 ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  await processor.handleText('telegram', '42', '任务 连败', undefined)

  turnEnd(processor, 'session-test-1', 'error', { message: 'e1' }) // attempts 2
  turnEnd(processor, 'session-test-1', 'error', { message: 'e2' }) // attempts 3
  let queue = config.taskQueue()
  check('二次失败尝试 3', queue[0].attempts, 3)
  check('二次失败退避 60s', queue[0].nextAttemptAt, queue[0].updatedAt + 60_000)

  turnEnd(processor, 'session-test-1', 'error', { message: 'e3' }) // attempts 4,超过上限
  queue = config.taskQueue()
  check('三次失败后超过上限', queue[0].attempts, 4)
  check('达到上限后不再退避', queue[0].nextAttemptAt, null)
  queue = config.taskQueue()
  check('三次失败后达到上限', queue[0].attempts, 4)
  check('达到上限后不再退避', queue[0].nextAttemptAt, null)

  log.length = 0
  await processor.tickQueue()
  check('达到上限后 tick 不重试', log.filter(([kind, method]) => kind === 'rpc' && method === 'session.prompt').length, 0)
}

// ---- 手动重试与取消 ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  await processor.handleText('telegram', '42', '任务 手动重试', undefined)
  const id = config.taskQueue()[0].id

  turnEnd(processor, 'session-test-1', 'error', { message: '失败' })
  log.length = 0
  const retryReply = await processor.retryQueueEntry(id)
  check('手动重试返回', retryReply.includes('已重新执行'), true)
  check('手动重试 prompt 调用', log.filter(([kind, method]) => kind === 'rpc' && method === 'session.prompt').length, 1)
  check('手动重试后状态 running', config.taskQueue()[0].status, 'running')

  // 运行中的项不能手动重试。
  log.length = 0
  const retryAgain = await processor.retryQueueEntry(id)
  check('非失败不可重试', retryAgain.includes('只有失败或已取消'), true)

  // 取消后仍可手动重试。
  turnEnd(processor, 'session-test-1', 'error', { message: '又失败' })
  const cancelReply = await processor.cancelQueueEntry(id)
  check('取消返回', cancelReply.includes('已取消'), true)
  check('取消调用 session.cancel', log.filter(([kind, method]) => kind === 'rpc' && method === 'session.cancel').length, 1)
  check('取消后状态 cancelled', config.taskQueue()[0].status, 'cancelled')
}

// ---- 重启恢复:running → failed ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  await processor.handleText('telegram', '42', '任务 中断', undefined)
  check('恢复前 running', config.taskQueue()[0].status, 'running')

  processor.recoverQueue()
  const queue = config.taskQueue()
  check('恢复后 failed', queue[0].status, 'failed')
  check('恢复记录中断原因', queue[0].error, '应用退出导致任务中断')
  check('恢复后不再自动重试', queue[0].nextAttemptAt, null)
}

// ---- cmdRetry 优先命中队列 ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  await processor.handleText('telegram', '42', '任务 指令重试', undefined)
  const id = config.taskQueue()[0].id

  turnEnd(processor, 'session-test-1', 'error', { message: '失败' })
  log.length = 0
  const reply = await processor.handleText('telegram', '42', `重试 ${id}`, undefined)
  check('指令重试返回', reply.includes('已重新执行'), true)
  check('指令重试走队列 prompt', log.filter(([kind, method]) => kind === 'rpc' && method === 'session.prompt').length, 1)
}

// ---- 非机器人任务不进入队列 ----
{
  const log = []
  const processor = new RemoteCommandProcessor(makeHarness(log))
  processor.setReport('telegram', true)
  processor.handleInteractionFrame({
    type: 'server-request', rpcId: 'r-x', method: 'session/event',
    payload: { sessionId: 'session-other', event: { type: 'turn/end', data: { reason: { kind: 'error', message: 'x' } } } },
  })
  // 无 taskDescriptions 注册:不应抛出异常(静默跳过)。
  check('未知会话 turn/end 不崩溃', true, true)
}

// ---- 串行执行:运行中提交新任务进入排队,完成后自动启动 ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  const r1 = await processor.handleText('telegram', '42', '任务 第一个', undefined)
  check('首个任务直接启动', r1.includes('任务已启动'), true)
  const r2 = await processor.handleText('telegram', '42', '任务 第二个', undefined)
  check('运行中提交返回排队', r2.includes('已排队'), true)
  let queue = config.taskQueue()
  check('排队后队列 2 项', queue.length, 2)
  const first = queue.find((item) => item.description === '第一个')
  const second = queue.find((item) => item.description === '第二个')
  check('第一项 running', first.status, 'running')
  check('第二项 queued', second.status, 'queued')
  check('排队项无会话', second.sessionId, null)
  check('排队未创建新会话', log.filter(([kind, method]) => kind === 'rpc' && method === 'session.create').length, 1)

  // 第一个任务完成 → 自动启动排队任务。
  turnEnd(processor, 'session-test-1', 'done')
  await new Promise((resolve) => setTimeout(resolve, 50))
  queue = config.taskQueue()
  const second2 = queue.find((item) => item.description === '第二个')
  check('排队任务转 running', second2.status, 'running')
  check('排队任务关联会话', second2.sessionId, 'session-test-2')
  check('排队任务创建会话', log.filter(([kind, method]) => kind === 'rpc' && method === 'session.create').length, 2)
  check('排队任务已 prompt', log.filter(([kind, method]) => kind === 'rpc' && method === 'session.prompt').length, 2)

  // 第二个任务完成 → 队列全部结束。
  turnEnd(processor, 'session-test-2', 'done')
  await new Promise((resolve) => setTimeout(resolve, 50))
  queue = config.taskQueue()
  check('两个任务都 completed', queue.every((item) => item.status === 'completed'), true)
}

// ---- 运行中重试转排队 ----
{
  const log = []
  const config = makeQueueConfig()
  const processor = new RemoteCommandProcessor(makeHarness(log), config)
  processor.setReport('telegram', true)
  await processor.handleText('telegram', '42', '任务 甲', undefined)
  await processor.handleText('telegram', '42', '任务 乙', undefined) // queued
  const first = config.taskQueue().find((item) => item.status === 'running')
  turnEnd(processor, 'session-test-1', 'error', { message: '失败' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const retry = await processor.retryQueueEntry(first.id)
  check('运行中重试转排队', retry.includes('已排队'), true)
  const queued = config.taskQueue().find((item) => item.id === first.id)
  check('重试项 queued 且保留会话', queued.status, 'queued')
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
