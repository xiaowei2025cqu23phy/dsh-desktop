/**
 * 本地交付门禁:一条命令跑完 CI 的全部检查。
 *
 * 为什么需要它:仓库的 GitHub Actions 工作流在账号计费锁定期间无法启动,
 * 推送前若没有本地门禁,坏提交会直接落到 master。`npm run verify` 与 CI 的
 * 检查项保持一致,`git push` 时由 .githooks/pre-push 自动调用。
 *
 * 检查项(与 .github/workflows/build.yml 的 test job 对齐):
 *   1. 三道 tsc 类型检查(main / renderer / remote)
 *   2. scripts/ 的 checkJs 扫描
 *   3. 构建(build-remote + copy-assets,产出 dist/)
 *   4. ESLint
 *   5. 离线测试套件(npm test)
 *
 * 用法:node scripts/verify.mjs [--fast]
 *   --fast  跳过构建与测试,只跑类型检查与 lint(改动文档时够用)
 */

import { spawnSync } from 'node:child_process'

const fast = process.argv.includes('--fast')

/**
 * scripts/ 的 checkJs 扫描。
 * tsconfig.scripts.json 只能 include 脚本,而脚本 require 了 dist/ 下的编译产物,
 * 因此输出里会混入 dist/ 的类型噪声——只把来自 scripts/ 的错误视为失败(与 CI 一致)。
 */
function checkScripts() {
  const result = spawnSync('npx tsc -p tsconfig.scripts.json', { shell: true, encoding: 'utf8', env: process.env })
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split(/\r?\n/)
  const scriptErrors = lines.filter((line) => line.startsWith('scripts/'))
  if (scriptErrors.length === 0) return { ok: true }
  console.error(scriptErrors.join('\n'))
  return { ok: false }
}

/** 每步:名称 + 命令;`run` 存在时优先用它(需要过滤输出的步骤)。 */
const steps = [
  { name: '类型检查 main', cmd: 'npx tsc -p tsconfig.json --noEmit' },
  { name: '类型检查 renderer', cmd: 'npx tsc -p tsconfig.renderer.json --noEmit' },
  { name: '类型检查 remote', cmd: 'npx tsc -p tsconfig.remote.json --noEmit' },
  { name: '脚本 checkJs', cmd: 'npx tsc -p tsconfig.scripts.json(仅 scripts/ 错误计为失败)', run: checkScripts },
  ...(fast
    ? []
    : [
        { name: '构建', cmd: 'npm run build' },
        { name: 'Lint', cmd: 'npm run lint' },
        { name: '离线测试', cmd: 'npm test' },
      ]),
]

const failed = []
const start = Date.now()

for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`
  console.log(`\n=== ${label} ===`)
  console.log(`$ ${step.cmd}`)
  const t0 = Date.now()
  const result = step.run !== undefined
    ? step.run()
    : { ok: spawnSync(step.cmd, { shell: true, stdio: 'inherit', env: process.env }).status === 0 }
  const ms = Date.now() - t0
  if (result.ok) {
    console.log(`✓ ${step.name}(${(ms / 1000).toFixed(1)}s)`)
  } else {
    console.log(`✗ ${step.name} 失败(${(ms / 1000).toFixed(1)}s)`)
    failed.push(step.name)
    // 类型/脚本检查失败时后续步骤意义不大,直接停下给反馈。
    if (step.name.startsWith('类型检查') || step.name === '脚本 checkJs') {
      console.log('\n类型检查未通过,已停止后续步骤。')
      break
    }
  }
}

const total = ((Date.now() - start) / 1000).toFixed(1)
if (failed.length > 0) {
  console.error(`\n✗ 交付门禁未通过(${total}s):${failed.join('、')}`)
  if (!fast && failed.includes('离线测试')) {
    console.error('  提示:单独跑 node scripts/<套件名>.mjs 可看到具体失败断言。')
  }
  process.exit(1)
}
console.log(`\n✓ 交付门禁全部通过(${total}s${fast ? ',--fast 模式' : ''})`)
