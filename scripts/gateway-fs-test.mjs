/**
 * 网关文件夹浏览/预设根管理集成测试(需 app 运行中,网关在线)。
 * 覆盖:根列表、目录列表、文件读取、越权拒绝(403)、预设根添加/移除。
 * 用法:GATEWAY_TOKEN=xxx node scripts/gateway-fs-test.mjs [baseUrl]
 */
import { readdirSync, statSync } from 'node:fs'

const base = process.argv[2] || 'http://127.0.0.1:3082'
const token = process.env.GATEWAY_TOKEN || 'REPLACED_WITH_GATEWAY_TOKEN'

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

async function action(act, extra) {
  const res = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(Object.assign({ action: act }, extra || {})),
  })
  return { status: res.status, body: await res.json() }
}

// 1. 根列表:至少一个可浏览根(工作区或预设根)
const rootsResp = await action('fs.list', { path: '' })
check('根列表-状态', rootsResp.status, 200)
check('根列表-ok', rootsResp.body.ok, true)
const roots = rootsResp.body.roots || []
check('根列表-非空', roots.length > 0, true)
check('根列表-含字段', roots.every((r) => typeof r.path === 'string' && typeof r.name === 'string' && typeof r.isPreset === 'boolean'), true)

// 2. 选一个真实存在的根,列出内容并读取一个文件
const existing = roots.filter((r) => { try { return statSync(r.path).isDirectory() } catch { return false } })
check('根列表-至少一个存在', existing.length > 0, true)
let root = existing.length > 0 ? existing[0].path : roots[0].path
const listResp = await action('fs.list', { path: root })
check('目录列表-状态', listResp.status, 200)
check('目录列表-path 回显', listResp.body.path, root)
const entries = listResp.body.entries || []
const files = entries.filter((e) => !e.isDir)
check('目录列表-条目结构', entries.every((e) => typeof e.name === 'string' && typeof e.path === 'string' && typeof e.isDir === 'boolean'), true)
check('目录列表-大小字段', files.every((f) => typeof f.size === 'number'), true)

let readFile = null
if (files.length > 0) {
  readFile = files[0].path
} else {
  // 根目录没有文件:找第一层子目录里的文件
  const dirs = entries.filter((e) => e.isDir)
  if (dirs.length > 0) {
    const sub = await action('fs.list', { path: dirs[0].path })
    const subFiles = (sub.body.entries || []).filter((e) => !e.isDir)
    if (subFiles.length > 0) readFile = subFiles[0].path
  }
}
if (readFile !== null) {
  const readResp = await action('fs.read', { path: readFile })
  check('文件读取-状态', readResp.status, 200)
  check('文件读取-ok', readResp.body.ok, true)
  check('文件读取-文本', typeof readResp.body.text === 'string', true)
  // 与本地文件内容一致
  const local = readFileSync(readFile, 'utf8')
  check('文件读取-内容一致', readResp.body.text === local, true)
} else {
  console.log('⚠ 根目录下没有可读文件,跳过文件读取一致性检查')
}

// 3. 越权拒绝
const deniedResp = await action('fs.list', { path: process.env.SystemRoot || 'C:/Windows' })
check('越权列表-403', deniedResp.status, 403)
const deniedRead = await action('fs.read', { path: process.env.SystemRoot || 'C:/Windows' })
check('越权读取-403', deniedRead.status, 403)
const deniedAdd = await action('fs.addRoot', { path: process.env.SystemRoot || 'C:/Windows' })
check('越权加根-403', deniedAdd.status, 403)

// 3b. 白名单内但不存在的路径 → 404
const missingRoot = roots.find((r) => { try { return !statSync(r.path).isDirectory() } catch { return true } })
if (missingRoot) {
  const miss = await action('fs.list', { path: missingRoot.path })
  check('不存在目录-404', miss.status, 404)
}

// 4. 预设根添加/移除(用非预设且真实存在的可浏览根,幂等恢复)
const nonPreset = existing.find((r) => !r.isPreset)
if (nonPreset) {
  // addRoot/removeRoot 返回的是预设根字符串列表;before 取初始列表中的预设根。
  const before = roots.filter((r) => r.isPreset).map((r) => r.path).sort()
  const addResp = await action('fs.addRoot', { path: nonPreset.path })
  check('加根-状态', addResp.status, 200)
  check('加根-已包含', (addResp.body.roots || []).includes(nonPreset.path), true)
  // 幂等:重复添加不报错
  const addAgain = await action('fs.addRoot', { path: nonPreset.path })
  check('加根-幂等', addAgain.status, 200)
  const removeResp = await action('fs.removeRoot', { path: nonPreset.path })
  check('移除根-状态', removeResp.status, 200)
  check('移除根-已删除', (removeResp.body.roots || []).includes(nonPreset.path), false)
  const after = (removeResp.body.roots || []).sort()
  check('移除根-其余不变', JSON.stringify(after) === JSON.stringify(before), true)
} else {
  console.log('⚠ 没有非预设根,跳过添加/移除测试')
}

// 5. 越权路径拒绝(文件系统根)
const fsRoot = (() => { try { return statSync('/').isDirectory() ? '/' : null } catch { return null } })()
if (fsRoot) {
  const r = await action('fs.list', { path: fsRoot })
  check('越权根列表-403', r.status, 403)
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 个失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
