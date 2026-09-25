/**
 * 路径白名单策略离线测试(无需 Electron / 无需真实网络)。
 *
 * 覆盖 path-policy 的判定口径:前缀边界(`/a/app` 与 `/a/app2` 是两个目录)、
 * 结尾分隔符、`..` 逃逸、大小写折叠(按当前平台)、正反斜杠混用、空输入,
 * 以及符号链接解析(工作区内指向外部的链接必须拒绝;手机端与聊天端结论一致)。
 * 平台不允许建符号链接/目录联接时,该组用例报「跳过」而不是失败。
 *
 * 用法:node scripts/path-policy-test.mjs
 */

import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { normPath, isSameOrUnder, realpathOrNull, realOrResolve, isPathAllowed } = require('../dist/main/path-policy.js')

const isWin = process.platform === 'win32'
/** 平台绝对路径字面量:win32 补盘符;不做 resolve,以便测试结尾分隔符。 */
const drive = isWin ? (process.env.SystemDrive || 'C:') : ''
const abs = (p) => drive + p

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

/** 跳过用例(例如平台不允许建符号链接):不计入失败,但要留下可见记录。 */
function skip(name, reason) {
  console.log(`⚠ 跳过 ${name}:${reason}`)
}

// ---- normPath:分隔符统一 + 仅 win32 折叠大小写 ----
{
  check('normPath 统一反斜杠', normPath('a\\b\\c'), 'a/b/c')
  check('normPath 保留正斜杠', normPath('a/b'), 'a/b')
  check('normPath 空输入', normPath(''), '')
  check('normPath 折叠大小写(仅 win32)', normPath(abs('/A/B')), isWin ? abs('/a/b').toLowerCase() : abs('/A/B'))
  check('normPath 幂等', normPath(normPath(abs('/A/B'))), normPath(abs('/A/B')))
}

// ---- isSameOrUnder:前缀边界 ----
{
  check('同路径命中', isSameOrUnder(abs('/a/app'), abs('/a/app')), true)
  check('子路径命中', isSameOrUnder(abs('/a/app/sub/file.txt'), abs('/a/app')), true)
  check('同前缀不同目录不命中(app2 与 app)', isSameOrUnder(abs('/a/app2'), abs('/a/app')), false)
  check('同前缀不同目录不命中(app2 下的文件)', isSameOrUnder(abs('/a/app2/file.txt'), abs('/a/app')), false)
  check('父路径不命中', isSameOrUnder(abs('/a'), abs('/a/app')), false)
  check('兄弟目录不命中', isSameOrUnder(abs('/a/other'), abs('/a/app')), false)
}

// ---- isSameOrUnder:结尾分隔符 ----
{
  check('子路径结尾带分隔符', isSameOrUnder(abs('/a/app/'), abs('/a/app')), true)
  check('根结尾带分隔符', isSameOrUnder(abs('/a/app/sub'), abs('/a/app/')), true)
  check('两侧都带分隔符', isSameOrUnder(abs('/a/app/'), abs('/a/app/')), true)
  check('重复分隔符', isSameOrUnder(abs('/a/app/sub'), abs('/a/app//')), true)
  check('根带分隔符仍不误放行 app2', isSameOrUnder(abs('/a/app2'), abs('/a/app/')), false)
  check('根带分隔符仍不误放行 app2 下的文件', isSameOrUnder(abs('/a/app2/file.txt'), abs('/a/app/')), false)
}

// ---- isSameOrUnder:分隔符混用 ----
{
  check('子路径反斜杠 vs 正斜杠根', isSameOrUnder(abs('/a/app/sub'), abs('/a/app').replace(/\//g, '\\')), true)
  check('混用仍不误放行 app2', isSameOrUnder(abs('/a/app2'), abs('/a/app').replace(/\//g, '\\')), false)
  check('相对路径混用', isSameOrUnder('a\\app\\sub', 'a/app'), true)
}

// ---- 空输入 ----
{
  check('空目标直接拒绝', isPathAllowed('', [abs('/a/app')]), false)
  check('空根不构成白名单', isPathAllowed(abs('/a/app/x'), ['']), false)
  check('空根列表直接拒绝', isPathAllowed(abs('/a/app/x'), []), false)
  check('空 root 的前缀判定', isSameOrUnder(abs('/a/app/x'), ''), false)
  check('两侧皆空', isSameOrUnder('', ''), false)
  check('realpathOrNull 空输入', realpathOrNull(''), null)
}

// ---- isPathAllowed:白名单命中 ----
{
  check('目标即根', isPathAllowed(abs('/a/app'), [abs('/a/app')]), true)
  check('目标在根之下', isPathAllowed(abs('/a/app/sub/file.txt'), [abs('/a/app')]), true)
  check('根带结尾分隔符', isPathAllowed(abs('/a/app/sub'), [abs('/a/app/')]), true)
  check('命中列表中的第二个根', isPathAllowed(abs('/b/proj/x'), [abs('/a/app'), abs('/b/proj')]), true)
  check('列表中的空根被忽略', isPathAllowed(abs('/b/proj/x'), ['', abs('/b/proj')]), true)
  check('同前缀不同目录被拒绝', isPathAllowed(abs('/a/app2/file.txt'), [abs('/a/app')]), false)
  check('列表外路径被拒绝', isPathAllowed(abs('/etc/passwd'), [abs('/a/app')]), false)
}

// ---- `..` 逃逸:先归位再比较 ----
{
  check('根内 .. 归位后仍命中', isPathAllowed(abs('/a/app/sub/../file.txt'), [abs('/a/app')]), true)
  check('.. 逃到同前缀目录被拒绝', isPathAllowed(abs('/a/app/../app2/file.txt'), [abs('/a/app')]), false)
  check('.. 逃到上层被拒绝', isPathAllowed(abs('/a/app/../../etc/passwd'), [abs('/a/app')]), false)
  check('.. 逃到父目录自身被拒绝', isPathAllowed(abs('/a/app/..'), [abs('/a/app')]), false)
  check('.. 逃逸后靠上根仍命中', isPathAllowed(abs('/a/app/../app/file.txt'), [abs('/a/app')]), true)
}

// ---- 大小写:仅 win32 折叠 ----
{
  check('大小写折叠按平台', isPathAllowed(abs('/A/APP/File.TXT'), [abs('/a/app')]), isWin)
  check('大小写折叠按平台(realpath:false)', isPathAllowed(abs('/A/APP/File.TXT'), [abs('/a/app')], { realpath: false }), isWin)
  check('大小写前缀不误放行 app2', isPathAllowed(abs('/A/APP2'), [abs('/a/app')]), false)
}

// ---- realOrResolve:存在则解析,不存在则回退 resolve ----
{
  check('不存在的路径回退 resolve', normPath(realOrResolve(abs('/__dsh_pp_missing__/x'))), normPath(resolve(abs('/__dsh_pp_missing__/x'))))
  check('realpathOrNull 对不存在路径返回 null', realpathOrNull(abs('/__dsh_pp_missing__/x')), null)
  const here = realpathSync(resolve('.'))
  check('realpathOrNull 对存在路径返回真实路径', normPath(realpathOrNull('.')) === normPath(here), true)
  check('realOrResolve 对存在路径返回真实路径', normPath(realOrResolve('.')) === normPath(here), true)
}

// ---- 符号链接:工作区内指向外部的链接必须拒绝(手机端与聊天端口径一致) ----
{
  let tmp = null
  let linked = false
  try {
    tmp = mkdtempSync(join(tmpdir(), 'dsh-path-policy-'))
    const rootDir = join(tmp, 'root')
    const outsideDir = join(tmp, 'outside')
    mkdirSync(rootDir)
    mkdirSync(outsideDir)
    writeFileSync(join(rootDir, 'inside.txt'), 'inside')
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
    const link = join(rootDir, 'link')
    try {
      // win32 用目录联接(junction,建目录链接无需管理员权限);其它平台用目录符号链接。
      symlinkSync(outsideDir, link, isWin ? 'junction' : 'dir')
      linked = true
    } catch (error) {
      skip('符号链接解析', `创建链接失败(${error instanceof Error ? error.message : String(error)})`)
    }

    check('根内普通文件放行', isPathAllowed(join(rootDir, 'inside.txt'), [rootDir]), true)
    check('根目录自身放行', isPathAllowed(rootDir, [rootDir]), true)

    if (linked) {
      const linkedFile = join(link, 'secret.txt')
      check('经链接指向外部文件被拒绝', isPathAllowed(linkedFile, [rootDir]), false)
      check('链接自身指向外部目录被拒绝', isPathAllowed(link, [rootDir]), false)
      check('字面比对时链接看似在根内(realpath:false 对照)', isPathAllowed(linkedFile, [rootDir], { realpath: false }), true)
      check('realOrResolve 把链接解析到外部目录', normPath(realOrResolve(link)), normPath(realOrResolve(outsideDir)))
      check('根为链接时其真实子路径仍放行', isPathAllowed(join(outsideDir, 'secret.txt'), [link]), true)

      // 手机 PWA(gateway.fsAllowed 走的 isPathAllowed)与聊天命令(remote-commands.allowPath
      // 走的 realpathOrNull + isPathAllowed)必须给出一致结论。
      const pwa = isPathAllowed(linkedFile, [rootDir])
      const real = realpathOrNull(linkedFile)
      const chat = real !== null && isPathAllowed(real, [rootDir])
      check('手机端与聊天端结论一致(链接外指)', pwa, chat)
      check('手机端与聊天端一致拒绝', pwa, false)
    }
  } catch (error) {
    skip('符号链接解析', error instanceof Error ? error.message : String(error))
  } finally {
    if (tmp !== null) {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响结论。 */
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✓')
