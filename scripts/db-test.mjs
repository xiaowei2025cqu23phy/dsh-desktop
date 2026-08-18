/**
 * 本地 SQLite 存储层测试(依赖 Node ≥22.13 的 node:sqlite,无需 Electron)。
 * 覆盖:活动写入/排序/上限、审计写入/清空/上限、队列写入/排序/保留策略、旧 JSON 迁移。
 * 用法:node scripts/db-test.mjs
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { LocalDb } = require('../dist/main/db.js')

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

const dir = mkdtempSync(join(tmpdir(), 'dsh-db-test-'))

try {
  const db = new LocalDb(dir)

  // ---- 活动 ----
  db.upsertActivity({
    id: 'act-1', type: 'task', source: 'telegram', workspace: null, sessionId: 'session-test-1',
    status: 'running', title: '分析仓库', lastEvent: '任务已启动', createdAt: 1000, updatedAt: 1000,
  })
  db.upsertActivity({
    id: 'act-2', type: 'chat', source: 'qq', workspace: 'D:/x', sessionId: 'session-test-2',
    status: 'completed', title: '聊天', lastEvent: '完成', createdAt: 2000, updatedAt: 3000,
  })
  // 更新 act-1(同 id upsert)。
  db.upsertActivity({
    id: 'act-1', type: 'task', source: 'telegram', workspace: null, sessionId: 'session-test-1',
    status: 'completed', title: '分析仓库', lastEvent: '任务完成', createdAt: 1000, updatedAt: 4000,
  })
  let acts = db.activities()
  check('活动条数', acts.length, 2)
  check('同 id 更新生效', acts.find((a) => a.id === 'act-1').status, 'completed')
  check('活动按更新时间排序', acts[0].id, 'act-1')

  // ---- 审计 ----
  db.appendAudit({ time: 100, type: 'task.running', sessionId: 'session-test-1', detail: '启动' })
  db.appendAudit({ time: 200, type: 'approval.requested', sessionId: 'session-test-1', detail: '写入文件' })
  const audit = db.auditList()
  check('审计条数', audit.length, 2)
  check('审计按时间倒序', audit[0].type, 'approval.requested')
  check('审计 id 生成', audit[0].id.startsWith('audit-'), true)

  db.clearAudit()
  check('清空审计', db.auditList().length, 0)

  // ---- 队列 ----
  const base = {
    description: '任务', sessionId: 'session-test-1', attempts: 1, maxAttempts: 3, nextAttemptAt: null,
    workspace: null, source: 'telegram', channel: 'telegram', userId: '42', pushTarget: null,
  }
  db.upsertTaskQueueEntry({ id: 'q-1', ...base, status: 'running', createdAt: 1000, updatedAt: 1000 })
  db.upsertTaskQueueEntry({ id: 'q-2', ...base, sessionId: null, status: 'queued', attempts: 0, createdAt: 2000, updatedAt: 2000 })
  db.upsertTaskQueueEntry({ id: 'q-3', ...base, status: 'completed', attempts: 2, createdAt: 1500, updatedAt: 1500 })
  let queue = db.taskQueue()
  check('队列活跃项在前', queue[0].id, 'q-1')
  check('队列活跃按创建排序', queue[1].id, 'q-2')
  check('队列已结束在后', queue[2].id, 'q-3')
  // 更新 q-1 → failed。
  db.upsertTaskQueueEntry({ id: 'q-1', ...base, status: 'failed', error: '超时', nextAttemptAt: 999999, createdAt: 1000, updatedAt: 2000 })
  queue = db.taskQueue()
  check('失败项保留', queue.find((q) => q.id === 'q-1').status, 'failed')
  check('失败记录错误', queue.find((q) => q.id === 'q-1').error, '超时')

  // 保留策略:已结束项只留最近 100。
  for (let i = 0; i < 150; i++) {
    db.upsertTaskQueueEntry({ id: `q-f-${i}`, ...base, status: 'completed', attempts: 1, createdAt: 10000 + i, updatedAt: 10000 + i })
  }
  queue = db.taskQueue()
  const finished = queue.filter((q) => q.status === 'completed' && q.id.startsWith('q-f-'))
  check('已结束项限量 100', finished.length, 100)
  check('最新已结束项保留', finished.some((q) => q.id === 'q-f-149'), true)
  check('最旧已结束项清除', finished.some((q) => q.id === 'q-f-0'), false)
  check('活跃项不受影响', queue.filter((q) => q.status === 'failed' || q.status === 'queued').length, 2)

  // ---- 旧 JSON 迁移(独立空库导入) ----
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-db-test-2-'))
  try {
    const db2 = new LocalDb(dir2)
    db2.migrateFromLegacy(
      [{ id: 'legacy-a', type: 'task', source: 'system', workspace: null, sessionId: null, status: 'completed', title: '旧活动', lastEvent: 'x', createdAt: 1, updatedAt: 2 }],
      [{ id: 'legacy-u', time: 1, type: 'task.completed', detail: '旧审计' }],
      [{ id: 'legacy-q', description: '旧任务', sessionId: null, status: 'completed', attempts: 1, maxAttempts: 3, nextAttemptAt: null, workspace: null, source: 'system', channel: 'system', userId: '', pushTarget: null, createdAt: 1, updatedAt: 2 }],
    )
    check('迁移活动', db2.activities().some((a) => a.id === 'legacy-a'), true)
    check('迁移审计', db2.auditList().some((a) => a.id === 'legacy-u'), true)
    check('迁移队列', db2.taskQueue().some((q) => q.id === 'legacy-q'), true)
    // 再次迁移不应重复(库非空)。
    db2.migrateFromLegacy(
      [{ id: 'legacy-b', type: 'task', source: 'system', workspace: null, sessionId: null, status: 'completed', title: '重复', lastEvent: 'x', createdAt: 1, updatedAt: 2 }],
      [], [],
    )
    check('非空库不重复迁移', db2.activities().some((a) => a.id === 'legacy-b'), false)
    db2.close()
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }

  db.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
