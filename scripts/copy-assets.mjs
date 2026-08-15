/**
 * 构建辅助:把渲染进程的静态资源(html/css)复制到 dist/renderer。
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'src', 'renderer')
const targetDir = join(root, 'dist', 'renderer')

mkdirSync(targetDir, { recursive: true })

let copied = 0
for (const name of readdirSync(sourceDir)) {
  const source = join(sourceDir, name)
  if (!statSync(source).isFile()) continue
  if (!name.endsWith('.html') && !name.endsWith('.css')) continue
  copyFileSync(source, join(targetDir, name))
  copied += 1
}

console.log(`copy-assets: ${copied} 个静态资源已复制到 dist/renderer`)
