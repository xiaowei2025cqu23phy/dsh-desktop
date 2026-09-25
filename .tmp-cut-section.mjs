/**
 * 通用抽取工具:把 app.ts 中某个 `// ---- 标题 ----` 分区的自洽函数整段搬到新模块。
 * 只搬运、不改写;常量声明随段一起迁走。
 *
 * 用法:node .tmp-cut-section.mjs "<标题>" <目标文件> [额外 import 行]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'src/remote/app.ts'
const [title, target, ...extraImports] = process.argv.slice(2)
if (title === undefined || target === undefined) throw new Error('用法: <标题> <目标文件> [import 行...]')

const lines = readFileSync(SRC, 'utf8').split('\n')
const fns = []
for (let i = 0; i < lines.length; i++) {
  const m = /^  (?:async )?function ([a-zA-Z0-9_]+)/.exec(lines[i])
  if (m) fns.push({ name: m[1], line: i })
}

const sections = []
for (let i = 0; i < lines.length; i++) {
  if (/^\s*\/\/ ---- /.test(lines[i])) sections.push({ line: i, title: lines[i].trim().replace(/^\/\/ ---- /, '').replace(/ ----$/, '') })
}
const idx = sections.findIndex((s) => s.title === title)
if (idx < 0) throw new Error(`未找到分区「${title}」;现有:${sections.map((s) => s.title).join(' | ')}`)

const from = sections[idx].line
const to = idx + 1 < sections.length ? sections[idx + 1].line : lines.length
const inside = fns.filter((f) => f.line >= from && f.line < to)
if (inside.length === 0) throw new Error(`分区「${title}」内没有顶层函数`)

// 段文本:分区标题行到下一个分区之前
let body = lines.slice(from, to)
// 去掉尾部空行与"下一段的注释"(下一段标题已排除,这里只清空行)
while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()

// 段内顶层常量(形如 `  var X = ...` 或 `  const X = ...`)
const constDecls = body.filter((l) => /^\s{2}(var|const|let) [A-Z0-9_]+ *=/.test(l))

const header = `/**
 * PWA 端「${title}」。
 *
 * 从 app.ts 按分区整段搬出:只搬运、不改写函数体,行为与拆分前一致
 * (esbuild 打成单个 IIFE,模块共享同一闭包)。
 */

${extraImports.join('\n')}

`
// 函数与常量统一去两格缩进并加 export
const exported = body
  .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
  .join('\n')
  .replace(/^(var|const|let) ([A-Z0-9_]+) *=/gm, 'export $1 $2 =')
  .replace(/^function /gm, 'export function ')

writeFileSync(target, header + exported + '\n', 'utf8')
console.log(`${target}: 写入 ${(header + exported).split('\n').length} 行(段 ${from + 1}–${to} 行,${inside.length} 函数)`)
console.log(`  含顶层常量: ${constDecls.length > 0 ? constDecls.map((l) => l.trim().split(' ')[1]).join(', ') : '(无)'}`)
console.log(`  函数: ${inside.map((f) => f.name).join(', ')}`)

// 从 app.ts 删除该段
const out = [...lines.slice(0, from), ...lines.slice(to)]
writeFileSync(SRC, out.join('\n'), 'utf8')
console.log(`app.ts: 新行数 ${out.length}`)
