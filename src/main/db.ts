/**
 * 本地 SQLite 存储:活动记录、审计时间线与任务队列的持久化层。
 * 使用 Electron 内置 Node 24 的 node:sqlite(零额外依赖);数据文件位于
 * userData/local.db,仅存本地摘要,不包含模型请求正文或密钥。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { ActivityRecord, AuditEntry, TaskQueueEntry } from './config'

function toNullable(value: string | null | undefined): string | null {
  return value === undefined ? null : value
}

export class LocalDb {
  private readonly db: DatabaseSync

  constructor(userDataPath: string) {
    this.db = new DatabaseSync(join(userDataPath, 'local.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        workspace TEXT,
        session_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        last_event TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        time INTEGER NOT NULL,
        type TEXT NOT NULL,
        session_id TEXT,
        activity_id TEXT,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_queue (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        next_attempt_at INTEGER,
        error TEXT,
        workspace TEXT,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        user_id TEXT NOT NULL,
        push_target TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activities_updated ON activities(updated_at);
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time);
      CREATE INDEX IF NOT EXISTS idx_queue_status ON task_queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_session ON task_queue(session_id);
    `)
  }

  // ---- 活动记录 ----

  activities(): ActivityRecord[] {
    const rows = this.db.prepare(
      'SELECT id, type, source, workspace, session_id, status, title, last_event, created_at, updated_at FROM activities',
    ).all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type) as ActivityRecord['type'],
      source: String(row.source) as ActivityRecord['source'],
      workspace: row.workspace === null ? null : String(row.workspace),
      sessionId: row.session_id === null ? null : String(row.session_id),
      status: String(row.status) as ActivityRecord['status'],
      title: String(row.title),
      lastEvent: String(row.last_event),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  upsertActivity(activity: ActivityRecord): void {
    this.db.prepare(`
      INSERT INTO activities (id, type, source, workspace, session_id, status, title, last_event, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type, source = excluded.source, workspace = excluded.workspace,
        session_id = excluded.session_id, status = excluded.status, title = excluded.title,
        last_event = excluded.last_event, created_at = excluded.created_at, updated_at = excluded.updated_at
    `).run(activity.id, activity.type, activity.source, toNullable(activity.workspace), toNullable(activity.sessionId), activity.status, activity.title, activity.lastEvent, activity.createdAt, activity.updatedAt)
    // 只保留最近 200 条。
    this.db.prepare('DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY updated_at DESC LIMIT 200)').run()
  }

  // ---- 审计时间线 ----

  auditList(): AuditEntry[] {
    const rows = this.db.prepare(
      'SELECT id, time, type, session_id, activity_id, detail FROM audit_log ORDER BY time DESC LIMIT 500',
    ).all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      time: Number(row.time),
      type: String(row.type),
      sessionId: row.session_id === null ? undefined : String(row.session_id),
      activityId: row.activity_id === null ? undefined : String(row.activity_id),
      detail: String(row.detail),
    }))
  }

  appendAudit(entry: Omit<AuditEntry, 'id'>): void {
    const id = `audit-${entry.time}-${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare('INSERT INTO audit_log (id, time, type, session_id, activity_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, entry.time, entry.type, toNullable(entry.sessionId), toNullable(entry.activityId), entry.detail)
    this.db.prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY time DESC LIMIT 500)').run()
  }

  clearAudit(): void {
    this.db.prepare('DELETE FROM audit_log').run()
  }

  // ---- 任务队列 ----

  taskQueue(): TaskQueueEntry[] {
    const rows = this.db.prepare('SELECT * FROM task_queue').all() as Array<Record<string, unknown>>
    const entries = rows.map((row) => ({
      id: String(row.id),
      description: String(row.description),
      sessionId: row.session_id === null ? null : String(row.session_id),
      status: String(row.status) as TaskQueueEntry['status'],
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
      ...(row.error === null ? {} : { error: String(row.error) }),
      workspace: row.workspace === null ? null : String(row.workspace),
      source: String(row.source),
      channel: String(row.channel),
      userId: String(row.user_id),
      pushTarget: row.push_target === null || row.push_target === '' ? null : JSON.parse(String(row.push_target)) as { scope: string; targetId: string },
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
    const active = entries.filter((item) => item.status === 'queued' || item.status === 'running' || item.status === 'failed')
    const rest = entries.filter((item) => item.status !== 'queued' && item.status !== 'running' && item.status !== 'failed')
    return [...active.sort((a, b) => a.createdAt - b.createdAt), ...rest.sort((a, b) => b.updatedAt - a.updatedAt)]
  }

  upsertTaskQueueEntry(entry: TaskQueueEntry): void {
    this.db.prepare(`
      INSERT INTO task_queue (id, description, session_id, status, attempts, max_attempts, next_attempt_at, error, workspace, source, channel, user_id, push_target, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description, session_id = excluded.session_id, status = excluded.status,
        attempts = excluded.attempts, max_attempts = excluded.max_attempts, next_attempt_at = excluded.next_attempt_at,
        error = excluded.error, workspace = excluded.workspace, source = excluded.source,
        channel = excluded.channel, user_id = excluded.user_id, push_target = excluded.push_target,
        created_at = excluded.created_at, updated_at = excluded.updated_at
    `).run(
      entry.id, entry.description, toNullable(entry.sessionId), entry.status, entry.attempts, entry.maxAttempts,
      entry.nextAttemptAt, toNullable(entry.error), toNullable(entry.workspace), entry.source, entry.channel, entry.userId,
      entry.pushTarget === undefined || entry.pushTarget === null ? null : JSON.stringify(entry.pushTarget),
      entry.createdAt, entry.updatedAt,
    )
    // 保留策略:活跃项全保留,已结束项只留最近 100 条。
    this.db.prepare(`
      DELETE FROM task_queue WHERE status NOT IN ('queued', 'running', 'failed')
        AND id NOT IN (SELECT id FROM task_queue WHERE status NOT IN ('queued', 'running', 'failed') ORDER BY updated_at DESC LIMIT 100)
    `).run()
  }

  /** 导入旧 JSON 数据(仅当库为空时由 ConfigStore 调用)。 */
  migrateFromLegacy(activities: ActivityRecord[], auditLog: AuditEntry[], taskQueue: TaskQueueEntry[]): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number } | undefined
    if (count !== undefined && count.n > 0) return
    const insertActivity = this.db.prepare('INSERT OR IGNORE INTO activities (id, type, source, workspace, session_id, status, title, last_event, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const activity of activities) {
      insertActivity.run(activity.id, activity.type, activity.source, toNullable(activity.workspace), toNullable(activity.sessionId), activity.status, activity.title, activity.lastEvent, activity.createdAt, activity.updatedAt)
    }
    const insertAudit = this.db.prepare('INSERT OR IGNORE INTO audit_log (id, time, type, session_id, activity_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    for (const entry of auditLog) {
      insertAudit.run(entry.id, entry.time, entry.type, toNullable(entry.sessionId), toNullable(entry.activityId), entry.detail)
    }
    const insertQueue = this.db.prepare('INSERT OR IGNORE INTO task_queue (id, description, session_id, status, attempts, max_attempts, next_attempt_at, error, workspace, source, channel, user_id, push_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const entry of taskQueue) {
      insertQueue.run(
        entry.id, entry.description, toNullable(entry.sessionId), entry.status, entry.attempts, entry.maxAttempts,
        entry.nextAttemptAt, toNullable(entry.error), toNullable(entry.workspace), entry.source, entry.channel, entry.userId,
        entry.pushTarget === undefined || entry.pushTarget === null ? null : JSON.stringify(entry.pushTarget),
        entry.createdAt, entry.updatedAt,
      )
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 关闭失败忽略。 */
    }
  }
}
