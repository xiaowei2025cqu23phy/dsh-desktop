/**
 * PWA 端静态一致性检查(离线,不需要浏览器)。
 *
 * 为什么需要它:`src/remote/app.ts` 拆成多模块后由 esbuild 打包成单个 IIFE,
 * 而打包产物**不经过任何类型检查之外的行为验证**——真机验证要连手机。这个脚本用
 * 静态比对兜住"拆分/改动把东西弄丢了"这一类回归:
 *
 *   1. 产物可解析(node --check 级别);
 *   2. app.ts / 各模块引用的元素 id 必须都在 index.html 里存在(防拼写错、防删漏);
 *   3. index.html 的元素 id 必须被引用(防留下无人使用的死标记);
 *   4. 产物里必须保留几处关键行为标记(工具函数、SSE 票、壁纸、markdown 渲染);
 *   5. 每个模块都被真正打包进去(防止 import 被优化掉而功能静默消失)。
 *
 * 用法:node scripts/pwa-shell-test.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

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

const html = readFileSync('src/remote/index.html', 'utf8')
const bundle = readFileSync('dist/remote/app.js', 'utf8')

// ---- 1. 产物语法可解析 ----
try {
  execFileSync(process.execPath, ['--check', 'dist/remote/app.js'], { stdio: 'pipe' })
  check('产物语法可解析', true, true)
} catch {
  check('产物语法可解析', false, true)
}

// ---- 收集 id ----
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))

const sourceFiles = ['src/remote/app.ts', ...readdirSync('src/remote').filter((f) => f.endsWith('.ts') && f !== 'app.ts').map((f) => join('src/remote', f))]
const sourceText = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n')

/** app.ts 里静态取用的 id:$('x') / $id('x') / document.getElementById('x')。 */
const referenced = new Set()
for (const m of sourceText.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) referenced.add(m[1])
for (const m of sourceText.matchAll(/\$id\(\s*'([^']+)'\s*\)/g)) referenced.add(m[1])
for (const m of sourceText.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) referenced.add(m[1])

// ---- 2. 引用的 id 必须存在 ----
const missing = [...referenced].filter((id) => !htmlIds.has(id)).sort()
check(`引用的元素 id 全部存在(引用 ${referenced.size} 个)`, missing, [])

// ---- 3. 静态扫不到的 id(逐个说明原因,避免把"漏改"混进白名单) ----
// - app:只被 CSS 选中(#app { … }),JS 不用它。
// - status-strip / view-connect / view-main:由 JS 从映射表拼接取值
//   (viewSwitch 里的 `map = { connect: 'view-connect', main: 'view-main' }`),
//   以及 CSS 选中 status-strip,静态 $('x') 扫不到。
// - toast-host:由 util.ts 的 toast() 按 id 查找,形式是 getElementById('toast-host'),
//   已被上面的引用集合覆盖,这里只为容错保留。
const staticScanMisses = ['app', 'status-strip', 'view-connect', 'view-main']
const unused = [...htmlIds].filter((id) => !referenced.has(id) && !staticScanMisses.includes(id)).sort()
check(`index.html 无未被引用的 id(${htmlIds.size} 个)`, unused, [])

// ---- 4. 产物保留关键行为 ----
const markers = [
  ['工具函数 escapeHtml', '&amp;'],
  ['思维链过滤', 'reasoning-text'],
  ['toast 提示', 'toast-hide'],
  ['SSE 一次性票', 'events/ticket'],
  ['事件流端点', '/api/events'],
  ['RPC 端点', '/api/rpc'],
  ['动作端点', '/api/action'],
  ['markdown 预览', 'md-code'],
  // PWA 的壁纸遮罩是 CSS 里固定的 ::after 叠层(body.has-wallpaper::after),
  // 没有可配置变量;只有布点用 CSS 变量传递。
  ['壁纸布点变量', '--wallpaper-position'],
  ['设备标识头', 'x-dsh-device'],
]
for (const [label, needle] of markers) {
  check(`产物保留:${label}`, bundle.includes(needle), true)
}

// ---- 5. 每个模块都被打包进去 ----
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8')
  // 取该文件导出的顶层函数名,任取一个出现即说明模块未被打包器丢掉。
  const exported = [...text.matchAll(/export (?:async )?function ([a-zA-Z0-9_]+)/g)].map((m) => m[1])
  if (exported.length === 0) continue
  const hit = exported.some((name) => bundle.includes(name))
  check(`模块已打包:${file}`, hit, true)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
