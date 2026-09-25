/**
 * 打包产物健全性测试:验证 asarUnpack 解到磁盘的 SDK 能真正加载。
 *
 * 为什么需要:打包产物**不经过任何运行时验证**,而这正是出过事的地方 ——
 * `@tencent-connect/qqbot-nodejs` 被 asarUnpack 解到磁盘,它的运行时依赖 `ws`
 * 却留在 asar 里;SDK 从磁盘路径加载时沿文件系统向上找 `node_modules/ws`,
 * 找不到就 ERR_MODULE_NOT_FOUND,表现为「打包版里 QQ 机器人启动即失败」。
 *
 * 关键:必须**真的 require 一次 SDK**,而不是只检查文件是否存在 ——
 * 文件都在、只是解析不到依赖,是这类问题的典型形态。同理也要真的 resolve('ws')。
 *
 * 用法:node scripts/pack-sanity-test.mjs(需先 npm run pack*)
 *      产物不存在时跳过(不阻断纯源码开发)。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`✓ ${name}`)
  else { failures++; console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

const unpacked = resolve('release/win-unpacked/resources/app.asar.unpacked')
const asar = resolve('release/win-unpacked/resources/app.asar')

if (!existsSync(asar)) {
  console.log('· 未找到打包产物(release/win-unpacked),跳过本测试')
  console.log('  先跑 npm run pack:portable 再验证')
  process.exit(0)
}

// ---- 1. SDK 及其依赖都在磁盘上(unpacked 里) ----
const sdkEntry = resolve(join(unpacked, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js'))
const wsDir = join(unpacked, 'node_modules', 'ws')
check('SDK 入口已解包到磁盘', existsSync(sdkEntry), true)
check('SDK 的运行时依赖 ws 已解包到磁盘', existsSync(wsDir), true)
check('qrcode 已解包到磁盘(网关二维码用)', existsSync(join(unpacked, 'node_modules', 'qrcode')), true)

// ---- 2. 真的能加载 + 真的能解析依赖 ----
if (existsSync(sdkEntry)) {
  const requireFromSdk = createRequire(sdkEntry)
  let sdkOk = false
  try {
    const sdk = requireFromSdk(sdkEntry)
    sdkOk = typeof sdk.QQBot === 'function'
  } catch (error) {
    console.log(`    SDK 加载报错: ${error.code} — ${String(error.message).split('\n')[0]}`)
  }
  check('SDK 可从磁盘路径加载(与 qq-bot.ts 同路径)', sdkOk, true)

  let wsResolved = null
  try { wsResolved = requireFromSdk.resolve('ws') } catch { /* 下面断言失败 */ }
  check('从 SDK 位置可解析 ws', wsResolved !== null, true)
}

// ---- 3. asar 里不应再有"本该解包"的包(否则说明 asarUnpack 漏了) ----
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const needUnpack = ['@tencent-connect', 'ws', 'qrcode']
for (const name of needUnpack) {
  check(`asarUnpack 覆盖 node_modules/${name}`, pkg.build.asarUnpack.some((g) => g.includes(`node_modules/${name}`)), true)
}

if (failures > 0) { console.error(`\n${failures} 项失败`); process.exit(1) }
console.log('\n全部通过 ✓')
