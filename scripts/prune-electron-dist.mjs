/**
 * 打包前清理 electronDist 里的运行期产物。
 *
 * `build.electronDist` 指向 node_modules/electron/dist,electron-builder 会把该目录
 * 原样复制进发行包,于是开发机上的 `debug.log`(Chromium crashpad 的历史报错记录)
 * 会被一并打进用户拿到的 zip / 安装包。这里在打包前删掉它。
 *
 * 用法:node scripts/prune-electron-dist.mjs(由 npm run pack* 自动调用)
 */

import { existsSync, rmSync } from 'node:fs'

/** electronDist 中不应随发行包分发的运行期文件。 */
const RUNTIME_ARTIFACTS = ['debug.log']

let removed = 0
for (const name of RUNTIME_ARTIFACTS) {
  const target = `node_modules/electron/dist/${name}`
  if (!existsSync(target)) continue
  try {
    rmSync(target, { force: true })
    removed += 1
    console.log(`prune-electron-dist: 已移除 ${target}`)
  } catch {
    // 文件被占用(如 Electron 正在运行)时跳过:它本来就只是日志,不影响打包。
    console.log(`prune-electron-dist: 跳过被占用的 ${target}`)
  }
}
console.log(`prune-electron-dist: 完成(${removed} 项)`)
