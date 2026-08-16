/**
 * 一键发布新版本(本地打包 + 创建 Release + 上传资产)。
 *
 * GitHub Actions 因账号账单问题停用期间的发布路径;账单恢复后此脚本仍可用,
 * 也可只跑 `npm run build && npx electron-builder --win nsis zip` 交给 CI。
 *
 * 用法:node scripts/release.mjs
 * 流程:构建+测试 → electron-builder nsis+zip → 创建 Release(不存在时)
 *       → 上传 Setup + zip → 提示打 tag 推送(触发 CI 用)
 */

import { execSync } from 'node:child_process'

const REPO = 'xiaowei2025cqu23phy/dsh-desktop'

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

;(async () => {
  const { version } = JSON.parse(require('fs').readFileSync('package.json', 'utf8'))
  const tag = `v${version}`
  console.log(`=== 发布 ${tag} (${REPO}) ===`)

  // 1. 构建 + 测试
  run('npm run build')
  run('node scripts/qq-commands-test.mjs')
  run('node scripts/approval-flow-test.mjs')

  // 2. 打包 nsis + zip(注意:应用运行中会占用 win-unpacked,需先退出)
  run('npx electron-builder --win nsis zip')

  // 3. 创建 Release(已存在则跳过)
  try {
    run(`gh api repos/${REPO}/releases -f tag_name=${tag} -f name="v${version}"`, { stdio: 'pipe' })
    console.log(`✓ Release ${tag} 已创建`)
  } catch {
    console.log(`Release ${tag} 已存在,跳过创建`)
  }

  // 4. 上传资产
  const setup = `dist/DeepSeek-Harness-Desktop-Setup-${version}.exe`
  const zip = `dist/DeepSeek Harness Desktop-${version}-win.zip`
  run(`gh release upload ${tag} -R ${REPO} "${setup}" "${zip}" --clobber`)

  console.log(`
=== 完成 ===
Release: https://github.com/${REPO}/releases/tag/${tag}
下一步(可选,CI 恢复后自动构建时用):
  git tag ${tag}
  git push origin ${tag}
`)
})().catch((error) => {
  console.error(`✗ 发布失败:${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
