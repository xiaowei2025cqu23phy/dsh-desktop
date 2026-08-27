#!/usr/bin/env node
/**
 * No Negative Echo 检查:交付物(提交信息/变更说明/文档)不应包含
 * 被否方案的负向回声(「未采用 X」「没有 X」「暂不 X」等)。
 *
 * 判别规则:
 * - 洋葱皮:否定只描述决策过程(候选对比、临时纠正),成品状态未变 → 必须删除;
 * - 疤痕:否定描述成品事实(移除/迁移/安全/兼容/废弃) → 保留,且应改写为
 *   可用于读者的肯定陈述(「不再支持 X」→「仅支持 Y」)。
 *
 * 用法:node scripts/check-negative-echo.mjs <文件或文本…>(默认检查 git 输出的提交信息)
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 洋葱皮模板(命中即违规,必须重写)。 */
const ONION_PATTERNS = [
  /未(?:采用|实现|考虑|纳入|进行|做过|完成|添加|生成|提交|发布|测试|验证计划|采用方案|选用)/g,
  /没有(?:采用|实现|考虑|纳入|做过|完成|添加|生成|提交|发布|使用)/g,
  /(?:暂|先)?不(?:采用|实现|考虑|纳入|用了|做了|打算|继续)/g,
  /未有(?:采用|实现)/g,
  /未做(?:最后|过)?/g,
  /没用(?:到|过)/g,
  /不含(?:ZIP|历史|此前|旧版|该方案)/g,
  /(?:未|没)(?:能|法)实现/g,
]

/** 疤痕关键词(命中即视为成品事实,予以保留;仍需提示改写为肯定陈述)。 */
const SCAR_KEYWORDS = /移除|删除|迁移|安全|兼容|废弃|弃用|不再支持|不再维护|受限|仅支持|改为|重命名|改名|升级|回退|损失|注意|限制/

/** 违规上下文窗口。 */
function scan(text, label) {
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const re of ONION_PATTERNS) {
      const m = line.match(re)
      if (m !== null) {
        hits.push({ line: i + 1, text: line.trim().slice(0, 120), what: m[0] })
      }
    }
  }
  // 洋葱皮命中行若同时含疤痕关键词,按疤痕处理(删除/迁移类事实,不改写)。
  const onions = hits.filter((h) => !SCAR_KEYWORDS.test(h.text))
  const scars = hits.filter((h) => SCAR_KEYWORDS.test(h.text))
  return { onions, scars }
}

const args = process.argv.slice(2)
let report = []
if (args.length > 0) {
  for (const arg of args) {
    report.push({ label: arg, ...scan(readFileSync(arg, 'utf8'), arg) })
  }
} else {
  // 默认:分析未推送提交的标题。
  const log = execSync('git log --format=%s%n%b origin/master..HEAD', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  report.push({ label: '未推送提交', ...scan(log, 'git log') })
}

let bad = 0
for (const r of report) {
  if (r.onions.length > 0) {
    bad += r.onions.length
    console.log(`\n❌ [${r.label}] 洋葱皮(必须重写):`)
    for (const h of r.onions) console.log(`  第${h.line}行:「${h.text}」 ← 命中「${h.what}」`)
  }
  if (r.scars.length > 0) {
    console.log(`\nℹ️  [${r.label}] 疤痕(保留,建议改肯定陈述):`)
    for (const h of r.scars) console.log(`  第${h.line}行:「${h.text}」`)
  }
}
if (bad === 0) console.log('\n✓ 无洋葱皮负向回声;疤痕条目已列(如需改肯定陈述自行调整)。')
process.exit(bad > 0 ? 1 : 0)
