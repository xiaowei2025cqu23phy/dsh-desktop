/**
 * 修复 harness 工作区注册表:把按 cwd 能归属的会话补回 workspace.json。
 *
 * 背景:harness 自带侧栏判断会话归属靠 `$DSH_HOME/storages/workspace.json` 里每个工作区
 * 记录的 sessionIds,不看路径。工作区被移除再重新添加后,旧会话的归属不会恢复,于是
 * 它们落进「未分组」。本脚本按 cwd 的前缀关系把缺失的归属补回去。
 *
 * 安全约定:
 *  - 先整文件备份(带时间戳),可完整回滚;
 *  - 只**补**不**删**:现有 sessionIds 一个都不移除;
 *  - 只处理非子代理会话(带 origin 的子代理会话本就不该出现在侧栏);
 *  - 只往**已登记的**工作区里补,不新建工作区(id 由 harness 生成,自造 id 有风险);
 *  - 最长的 path 前缀优先,避免 AppData 抢走它的子目录。
 *
 * 另有 `--create`:为「目录存在、但从未登记为工作区」的路径新建工作区
 * (用于会话存在而工作区被删干净的情况)。缺目录的路径**不会**新建 —— 那只会得到
 * 一个指向不存在目录的空工作区。新建时 id 用 `crypto.randomUUID()`,与既有 id 同形态;
 * title 取 path 末段,重名时加 -2/-3 后缀。
 *
 * 用法:node scripts/repair-workspace-registry.mjs [--apply] [--create]
 *   不带 --apply 时只报告将发生的改动(dry-run)。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const APPLY = process.argv.includes('--apply')
const CREATE = process.argv.includes('--create')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const REG = join(dshHome, 'storages', 'workspace.json')

if (!existsSync(REG)) {
  console.error(`✗ 找不到注册表:${REG}`)
  process.exit(1)
}

const reg = JSON.parse(readFileSync(REG, 'utf8'))
const rows = reg.tables?.workspaces
if (rows === undefined) {
  console.error('✗ 注册表结构不认识(缺少 tables.workspaces),不做任何修改')
  process.exit(1)
}

/** 与 PWA 的 groupKey 同构:统一分隔符、去掉结尾斜杠、盘符路径小写化。 */
function normPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}

// 会话归属从磁盘索引读:不依赖 harness 在线。
// `session_projcache.json` 记录每个会话的 identity.cwd,是判断归属最可靠的来源
// (会话文件里也有 cwd,但要解压 zstd 且格式随版本变化)。
const cachePath = join(dshHome, 'storages', 'session_projcache.json')
if (!existsSync(cachePath)) {
  console.error(`✗ 找不到会话索引:${cachePath}`)
  process.exit(1)
}
const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
const sessions = Object.entries(cache.tables?.sessions ?? {}).map(([id, row]) => ({
  id,
  cwd: row?.identity?.cwd ?? null,
}))

const accounted = new Set()
for (const row of Object.values(rows)) for (const sid of row.sessionIds ?? []) accounted.add(sid)

// 目标工作区:按 path 长度降序,最长前缀优先。
const targets = Object.entries(rows)
  .map(([id, row]) => ({ id, row, key: normPath(row.path) }))
  .filter((t) => t.key !== '')
  .sort((a, b) => b.key.length - a.key.length)

console.log('=== 现状 ===')
console.log('  注册表工作区: ' + Object.keys(rows).length)
console.log('  已登记归属的会话: ' + accounted.size)
console.log('  会话索引总数: ' + sessions.length)

const additions = new Map() // workspaceId -> sessionId[]
const skippedNoCwd = []
let alreadyOk = 0
for (const s of sessions) {
  if (accounted.has(s.id)) { alreadyOk++; continue }
  const k = normPath(s.cwd)
  if (k === '') { skippedNoCwd.push(s.id); continue }
  const hit = targets.find((t) => k === t.key || k.startsWith(t.key + '/'))
  if (hit === undefined) { skippedNoCwd.push(s.id); continue }
  if (!additions.has(hit.id)) additions.set(hit.id, [])
  additions.get(hit.id).push(s.id)
}

console.log('')
console.log('=== 将补充的归属 ===')
let total = 0
for (const [id, sids] of [...additions.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const row = rows[id]
  console.log('  +' + String(sids.length).padStart(3) + '  ' + String(row.title ?? row.path).slice(0, 36).padEnd(38) + row.path)
  total += sids.length
}
console.log('  ---')
console.log('  合计补充: ' + total + ' 个会话')
console.log('  已正确归属(不动): ' + alreadyOk)
console.log('  无法归属(跳过): ' + skippedNoCwd.length)

// ---- 可选:为「目录存在但从未登记」的路径新建工作区 ----
// 只处理目录仍然存在的路径:为一个不存在的目录建工作区,只会得到空壳。
const creations = []
if (CREATE) {
  const noHome = new Map() // path -> sessionId[]
  for (const id of skippedNoCwd) {
    const s = sessions.find((x) => x.id === id)
    if (s === undefined || s.cwd === null || s.cwd === '') continue
    if (!noHome.has(s.cwd)) noHome.set(s.cwd, [])
    noHome.get(s.cwd).push(id)
  }
  const takenTitles = new Set(Object.values(rows).map((r) => r.title))
  const takenKeys = new Set(Object.values(rows).map((r) => normPath(r.path)))
  for (const [cwd, ids] of noHome) {
    if (!existsSync(cwd)) continue
    if (takenKeys.has(normPath(cwd))) continue
    const seg = String(cwd).split(/[\\/]/).filter(Boolean).pop() ?? cwd
    let title = seg
    for (let n = 2; takenTitles.has(title); n++) title = seg + '-' + n
    takenTitles.add(title)
    creations.push({ path: cwd, title, sessionIds: ids })
  }
  console.log('')
  console.log('=== 将新建的工作区(仅目录存在者)===')
  let createdSessions = 0
  for (const c of creations) {
    console.log('  +' + String(c.sessionIds.length).padStart(3) + ' 会话  ' + c.title.padEnd(30) + c.path)
    createdSessions += c.sessionIds.length
  }
  console.log('  ---')
  console.log('  新建工作区: ' + creations.length + ' 个,覆盖会话 ' + createdSessions + ' 个')
}

if (!APPLY) {
  console.log('')
  console.log('(dry-run;加 --apply 才会写入)')
  process.exit(0)
}
if (total === 0 && creations.length === 0) {
  console.log('')
  console.log('无需修改。')
  process.exit(0)
}

// 备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = REG + '.before-regroup-' + stamp
copyFileSync(REG, backup)
console.log('')
console.log('已备份: ' + backup)

const now = new Date().toISOString()

// 新建工作区:字段与既有条目完全一致(id 用 randomUUID,同形态)
for (const c of creations) {
  const id = randomUUID()
  rows[id] = { path: c.path, title: c.title, sessionIds: c.sessionIds, createdAt: now, updatedAt: now }
  if (Array.isArray(reg.global?.workspaceIds)) reg.global.workspaceIds.push(id)
  console.log('新建工作区 ' + c.title + '  (' + id + ')')
}

// 写入(只追加,不改动既有条目)
for (const [id, sids] of additions) {
  const row = rows[id]
  row.sessionIds = [...(row.sessionIds ?? []), ...sids]
  row.updatedAt = now
}
writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n', 'utf8')
console.log('已写入: ' + REG)
console.log('提示:需要重启 harness(退出应用再启动)才会重新读取注册表。')
