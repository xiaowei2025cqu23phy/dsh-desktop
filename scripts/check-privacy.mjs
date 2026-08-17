/**
 * 隐私安全检查:提交/发布前确认仓库不含个人数据。
 *
 * 检查项:
 * 1. 暂存与工作区文件中不允许出现个人壁纸(config 目录产物)与凭据文件
 * 2. 不允许出现已知的网关令牌等敏感值(可扩展)
 * 3. --gif 模式:录制演示前检查三端壁纸必须是内置主题(assets/wallpapers),
 *    防止把个人壁纸录进演示
 *
 * 用法:
 *   node scripts/check-privacy.mjs            # 检查工作区/暂存
 *   node scripts/check-privacy.mjs --gif      # 检查壁纸配置(录制前)
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 个人壁纸/数据文件特征(出现在 %APPDATA% 下的产物命名)。 */
const PERSONAL_PATTERNS = [
  /^window-\d+\.(png|jpg|jpeg|webp|gif)$/,
  /^phone-\d+\.(png|jpg|jpeg|webp|gif)$/,
  /^screensaver-\d+\.(png|jpg|jpeg|webp|gif)$/,
  /^source-(window|phone|screensaver)-\d+/,
  /^pack-\d/,
]

/** 禁止入库的敏感文件。 */
const SENSITIVE_FILES = [
  /^config\.json$/,
  /\.credentials/,
  /\.env$/,
  /\.dsh/,
  /userData/,
  /qq-welcomed/,
]

/** API 密钥格式(误提交即泄漏;用格式而非明文,免于在脚本里存密钥)。 */
const SECRET_PATTERNS = [
  { name: 'Gemini API 密钥', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'OpenAI 风格密钥', pattern: /sk-[0-9A-Za-z]{20,}/ },
  { name: 'GitHub 令牌', pattern: /ghp_[0-9A-Za-z]{36}/ },
]

let failures = 0

function fail(where, what) {
  failures++
  console.log(`✗ [${where}] ${what}`)
}

function checkNames(where, names) {
  for (const name of names) {
    for (const pattern of PERSONAL_PATTERNS) {
      if (pattern.test(name)) fail(where, `疑似个人壁纸/数据文件:${name}`)
    }
    for (const pattern of SENSITIVE_FILES) {
      if (pattern.test(name)) fail(where, `疑似敏感文件:${name}`)
    }
  }
}

// 1. 工作区 + 暂存文件
let allNames = []
try {
  allNames = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
} catch {
  // 非 git 目录忽略
}
const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean)
checkNames('tracked', allNames)
checkNames('untracked', untracked)

// 2. 已知敏感值扫描(仓库文本文件;默认开启,无需 --scan-values)
{
  const files = [...allNames, ...untracked]
  for (const file of files) {
    if (!/\.(ts|js|mjs|json|md|html|yml|yaml|gql)$/.test(file)) continue
    try {
      const text = readFileSync(file, 'utf8')
      for (const secret of SECRET_PATTERNS) {
        if (secret.pattern.test(text)) fail('value', `${file} 疑似包含${secret.name}`)
      }
    } catch { /* 忽略不可读 */ }
  }
}

// 3. --gif:录制前检查壁纸为内置主题
if (process.argv.includes('--gif')) {
  const configPath = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DeepSeek Harness Desktop', 'config.json')
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
      const surfaces = ['window', 'phone', 'screensaver']
      for (const surface of surfaces) {
        const path = config.appearance?.[surface]?.path
        if (typeof path === 'string' && !path.includes('assets\\wallpapers') && !path.includes('assets/wallpapers')) {
          fail('gif', `录制前壁纸非内置主题:${surface}=${path}`)
        }
      }
    } catch {
      fail('gif', '无法读取壁纸配置')
    }
  }
}

if (failures > 0) {
  console.log(`\n✗ 发现 ${failures} 个隐私问题,请处理后再提交/录制`)
  process.exit(1)
}
console.log('✓ 隐私检查通过:无个人壁纸/敏感文件/敏感值')
process.exit(0)
