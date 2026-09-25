/**
 * Token 预算闸门离线测试(假 harness,无需 Electron / 无需真实网络)。
 *
 * 覆盖:未设预算不拦截、达到 80% 只告警一次、超限且 block 时拒绝新的任务启动、
 *       超限且 notify 时照常放行、本地日期跨天重置(昨日用量不计入今日)、
 *       月度预算按本地自然月聚合与跨月重置。
 *
 * 金额口径:假配置把单价设成 ¥1,000,000/百万 token(= 1 token 恰好 ¥1),
 * 于是"喂进去的 token 数"就是"花掉的钱",断言可以直读。
 *
 * 用法:node scripts/budget-test.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { RemoteCommandProcessor, BUDGET_DENY_PREFIX } = require('../dist/main/remote-commands.js')

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

/** 金额断言:浮点乘法会有极小误差,按分比较。 */
function checkMoney(name, actual, expected) {
  check(name, Math.round(actual * 100) / 100, expected)
}

const PRICES = { inputPricePerM: 1_000_000, outputPricePerM: 1_000_000, cachePricePerM: 1_000_000, multiplier: 1 }

/** 假 harness:session.list 返回给定会话(带 updatedAt,用于划分今日/本月窗口)。 */
function makeHarness(log, sessions) {
  let counter = 0
  return {
    client() {
      return {
        async rpc(method, payload) {
          log.push(['rpc', method, payload])
          if (method === 'workspace.list') return { items: [] }
          if (method === 'session.list') return { items: sessions }
          if (method === 'session.create') return { sessionId: `session-test-${++counter}` }
          if (method === 'session.history') return { events: [] }
          return {}
        },
        async respond() {
          return { accepted: true }
        },
      }
    },
  }
}

/** 假配置仓库:只实现被测路径用到的部分(与 task-queue-test.mjs 同风格)。 */
function makeConfig(usage) {
  const store = { taskQueue: [], taskHistory: [], activities: [] }
  return {
    get: () => ({
      usage,
      bot: { taskPrompt: '', chatPrompt: '', character: '' },
      chatSessions: {},
      defaultTaskSessions: {},
      namedChatSessions: [],
      scheduledTasks: [],
      taskHistory: store.taskHistory,
      taskQueue: store.taskQueue,
      activities: store.activities,
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
    activities: () => [...store.activities],
    upsertActivity: (activity) => {
      store.activities = [activity, ...store.activities.filter((item) => item.id !== activity.id)]
    },
    appendAudit: () => {},
    memory: () => ({ enabled: false, summary: '', conventions: '', commands: '', notes: '', updatedAt: 0 }),
  }
}

/** 把 token 计入某会话(模拟 harness 的 usage 事件;只对"今日有活动"的会话生效)。 */
function feedTokens(processor, sessionId, tokens) {
  processor.handleInteractionFrame({
    type: 'server-request',
    rpcId: `r-usage-${sessionId}`,
    method: 'session/event',
    payload: {
      sessionId,
      event: { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0 } } } },
    },
  })
}

/** 组装一个处理器:假 harness + 假配置 + 通知替身。 */
function makeProcessor({ log = [], sessions = [], usage }) {
  const notices = []
  const processor = new RemoteCommandProcessor(makeHarness(log, sessions), makeConfig({ ...PRICES, ...usage }))
  processor.setNotifier((kind, title, body) => notices.push({ kind, title, body }))
  return { processor, notices, log }
}

const rpcMethods = (log) => log.filter(([kind]) => kind === 'rpc').map(([, method]) => method)

// ---- 未设预算:不拦截、不告警、报表里没有预算块 ----
{
  const today = [{ sessionId: 'session-a', updatedAt: Date.now() }]
  const { processor, notices } = makeProcessor({ sessions: today, usage: { dailyBudget: 0, monthlyBudget: 0, onExceed: 'block' } })
  feedTokens(processor, 'session-a', 500)

  const report = await processor.usageReport()
  check('未设预算:报表不含预算判定', report.budget, null)
  check('未设预算:不产生通知', notices.length, 0)

  const reply = await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  check('未设预算:任务照常启动', reply.includes('任务已启动'), true)
}

// ---- 达到 80%:提醒一次(同一本地日内不重复打扰) ----
{
  const today = [{ sessionId: 'session-a', updatedAt: Date.now() }]
  const { processor, notices } = makeProcessor({ sessions: today, usage: { dailyBudget: 10, monthlyBudget: 0, onExceed: 'notify' } })
  feedTokens(processor, 'session-a', 8)

  const report = await processor.usageReport()
  checkMoney('达到 80%:今日已用金额', report.budget.daily.spent, 8)
  check('达到 80%:warn 标记', report.budget.daily.warn, true)
  check('达到 80%:尚未超限', report.budget.daily.exceeded, false)
  check('达到 80%:不拦截', report.budget.blocked, false)
  check('达到 80%:发出一次通知', notices.length, 1)
  check('达到 80%:通知走 taskFail 分级', notices[0].kind, 'taskFail')
  check('达到 80%:通知内容含提醒线', notices[0].body.includes('已达 80% 提醒线'), true)

  await processor.usageReport()
  check('达到 80%:重复评估不再通知', notices.length, 1)

  const reply = await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  check('达到 80%:任务仍可启动', reply.includes('任务已启动'), true)
}

// ---- 超限 + block:拒绝新的任务启动,并给出明确原因 ----
{
  const today = [{ sessionId: 'session-a', updatedAt: Date.now() }]
  const { processor, notices, log } = makeProcessor({ sessions: today, usage: { dailyBudget: 10, monthlyBudget: 0, onExceed: 'block' } })
  feedTokens(processor, 'session-a', 12)

  const report = await processor.usageReport()
  checkMoney('超限 block:今日已用金额', report.budget.daily.spent, 12)
  check('超限 block:判定超限', report.budget.exceeded, true)
  check('超限 block:判定拒绝', report.budget.blocked, true)
  check('超限 block:原因以固定前缀开头', report.budget.message.startsWith(BUDGET_DENY_PREFIX), true)
  check('超限 block:通知说明会拒绝启动', notices.some((item) => item.body.includes('新的任务启动已被拒绝')), true)

  log.length = 0
  const reply = await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  check('超限 block:任务被拒绝', reply.startsWith(BUDGET_DENY_PREFIX), true)
  check('超限 block:拒绝文本说明未启动', reply.includes('本次任务未启动'), true)
  check('超限 block:拒绝文本给出恢复方式', reply.includes('用量费用'), true)
  check('超限 block:没有创建会话', rpcMethods(log).includes('session.create'), false)
  check('超限 block:没有下发提示词', rpcMethods(log).includes('session.prompt'), false)
}

// ---- 超限 + notify:只提醒,任务照常执行 ----
{
  const today = [{ sessionId: 'session-a', updatedAt: Date.now() }]
  const { processor, notices, log } = makeProcessor({ sessions: today, usage: { dailyBudget: 10, monthlyBudget: 0, onExceed: 'notify' } })
  feedTokens(processor, 'session-a', 12)

  const report = await processor.usageReport()
  check('超限 notify:判定超限', report.budget.exceeded, true)
  check('超限 notify:不拒绝', report.budget.blocked, false)
  check('超限 notify:通知说明仅提醒', notices.some((item) => item.body.includes('仅提醒')), true)

  log.length = 0
  const reply = await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  check('超限 notify:任务照常启动', reply.includes('任务已启动'), true)
  check('超限 notify:下发了提示词', rpcMethods(log).includes('session.prompt'), true)
}

// ---- 跨天重置:昨天的花费不算今天(本地日期边界,而非固定 86400 秒累加) ----
{
  const yesterday = Date.now() - 86_400_000
  const sessions = [{ sessionId: 'session-a', updatedAt: yesterday }]
  const { processor, notices } = makeProcessor({ sessions, usage: { dailyBudget: 10, monthlyBudget: 0, onExceed: 'block' } })
  feedTokens(processor, 'session-a', 500)

  const report = await processor.usageReport()
  checkMoney('跨天重置:今日已用金额归零', report.budget.daily.spent, 0)
  check('跨天重置:今日未超限', report.budget.daily.exceeded, false)
  check('跨天重置:不拦截', report.budget.blocked, false)
  check('跨天重置:不产生通知', notices.length, 0)

  const reply = await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  check('跨天重置:任务照常启动', reply.includes('任务已启动'), true)
}

// ---- 月度预算:按本地自然月聚合,超限同样能拒绝启动 ----
{
  const today = [{ sessionId: 'session-a', updatedAt: Date.now() }]
  const { processor } = makeProcessor({ sessions: today, usage: { dailyBudget: 0, monthlyBudget: 10, onExceed: 'block' } })
  feedTokens(processor, 'session-a', 12)

  const report = await processor.usageReport()
  check('月度预算:未设日预算时不含日判定', report.budget.daily, null)
  checkMoney('月度预算:本月已用金额', report.budget.monthly.spent, 12)
  check('月度预算:判定超限', report.budget.monthly.exceeded, true)
  check('月度预算:拒绝启动', report.budget.blocked, true)

  const reply = await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  check('月度预算:拒绝文本指向本月', reply.includes('本月'), true)
}

// ---- 跨月重置:上月(31 天前)的花费不计入本月 ----
{
  const lastMonth = Date.now() - 31 * 86_400_000
  const sessions = [{ sessionId: 'session-a', updatedAt: lastMonth }]
  const { processor, notices } = makeProcessor({ sessions, usage: { dailyBudget: 0, monthlyBudget: 10, onExceed: 'block' } })
  feedTokens(processor, 'session-a', 500)

  const report = await processor.usageReport()
  checkMoney('跨月重置:本月已用金额归零', report.budget.monthly.spent, 0)
  check('跨月重置:不拦截', report.budget.blocked, false)
  check('跨月重置:不产生通知', notices.length, 0)

  const reply = await processor.handleText('telegram', '42', '任务 分析仓库', undefined)
  check('跨月重置:任务照常启动', reply.includes('任务已启动'), true)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
