/**
 * 构建辅助:把渲染进程静态资源(html/css)复制到 dist/renderer,
 * 把远程 PWA(html/css/js/manifest)复制到 dist/remote,并把应用图标复制到两处。
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'src', 'renderer')
const targetDir = join(root, 'dist', 'renderer')
const remoteSourceDir = join(root, 'src', 'remote')
const remoteTargetDir = join(root, 'dist', 'remote')

mkdirSync(targetDir, { recursive: true })
mkdirSync(remoteTargetDir, { recursive: true })

let copied = 0
for (const name of readdirSync(sourceDir)) {
  const source = join(sourceDir, name)
  if (!statSync(source).isFile()) continue
  if (!name.endsWith('.html') && !name.endsWith('.css')) continue
  copyFileSync(source, join(targetDir, name))
  copied += 1
}
for (const name of readdirSync(remoteSourceDir)) {
  const source = join(remoteSourceDir, name)
  if (!statSync(source).isFile()) continue
  // PWA 脚本由 esbuild 从 app.ts 构建,这里只复制 html/css 等静态资源。
  if (name.endsWith('.ts') || name === 'app.js') continue
  copyFileSync(source, join(remoteTargetDir, name))
  copied += 1
}

// PWA 图标:复用应用图标。
copyFileSync(join(root, 'assets', 'icon.png'), join(remoteTargetDir, 'icon.png'))

// 桌面宠物图(Gemini 生成):复制到 renderer 供 file:// 相对路径加载。
mkdirSync(join(targetDir, 'assets'), { recursive: true })
copyFileSync(join(root, 'assets', 'pet-whale.svg'), join(targetDir, 'assets', 'pet-whale.svg'))
copied += 1

console.log(`copy-assets: ${copied + 1} 个静态资源已复制(dist/renderer + dist/remote)`)
