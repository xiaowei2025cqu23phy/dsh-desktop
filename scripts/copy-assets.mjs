/**
 * 构建辅助:把渲染进程静态资源(html/css)复制到 dist/renderer,
 * 把远程 PWA(html/css/js/manifest)复制到 dist/remote,并把应用图标复制到两处。
 */

import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

/** 用双线性插值把 PNG 缩放到目标尺寸;contentScale < 1 时内容居中、四周留透明边(maskable 安全区)。 */
function resizePng(srcBuf, targetW, targetH, contentScale = 1) {
  const src = PNG.sync.read(srcBuf)
  const out = new PNG({ width: targetW, height: targetH })
  const renderW = Math.round(targetW * contentScale)
  const renderH = Math.round(targetH * contentScale)
  const offsetX = Math.floor((targetW - renderW) / 2)
  const offsetY = Math.floor((targetH - renderH) / 2)
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const o = (y * targetW + x) * 4
      const dx = x - offsetX
      const dy = y - offsetY
      if (dx < 0 || dx >= renderW || dy < 0 || dy >= renderH) {
        out.data[o] = 0; out.data[o + 1] = 0; out.data[o + 2] = 0; out.data[o + 3] = 0
        continue
      }
      const gx = (dx + 0.5) * src.width / renderW - 0.5
      const gy = (dy + 0.5) * src.height / renderH - 0.5
      const x0 = Math.max(0, Math.floor(gx))
      const y0 = Math.max(0, Math.floor(gy))
      const x1 = Math.min(src.width - 1, x0 + 1)
      const y1 = Math.min(src.height - 1, y0 + 1)
      const fx = Math.max(0, Math.min(1, gx - x0))
      const fy = Math.max(0, Math.min(1, gy - y0))
      for (let c = 0; c < 4; c++) {
        const i00 = (y0 * src.width + x0) * 4 + c
        const i10 = (y0 * src.width + x1) * 4 + c
        const i01 = (y1 * src.width + x0) * 4 + c
        const i11 = (y1 * src.width + x1) * 4 + c
        const v = (src.data[i00] * (1 - fx) + src.data[i10] * fx) * (1 - fy) + (src.data[i01] * (1 - fx) + src.data[i11] * fx) * fy
        out.data[o + c] = Math.round(v)
      }
    }
  }
  return PNG.sync.write(out)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'src', 'renderer')
const targetDir = join(root, 'dist', 'renderer')
const remoteSourceDir = join(root, 'src', 'remote')
const remoteTargetDir = join(root, 'dist', 'remote')

mkdirSync(targetDir, { recursive: true })
mkdirSync(remoteTargetDir, { recursive: true })
mkdirSync(join(root, 'dist', 'main'), { recursive: true })

// 构建信息(版本 + commit + 时间):随 dist/main 打进 asar,界面可显示当前构建,
// 避免「源码改了但 exe 是旧包」这类版本漂移问题难以发现。
let buildVersion = '0.0.0'
let buildCommit = ''
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  buildVersion = pkg.version ?? '0.0.0'
  try {
    buildCommit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8', timeout: 3000 }).trim()
  } catch {
    buildCommit = ''
  }
  writeFileSync(
    join(root, 'dist', 'main', 'build-info.json'),
    JSON.stringify({ version: buildVersion, commit: buildCommit, builtAt: Date.now() }),
    'utf8',
  )
} catch {
  // 构建信息写入失败不影响资源复制。
}

let copied = 0
for (const name of readdirSync(sourceDir)) {
  const source = join(sourceDir, name)
  if (!statSync(source).isFile()) continue
  if (!name.endsWith('.html') && !name.endsWith('.css')) continue
  copyFileSync(source, join(targetDir, name))
  copied += 1
}
const swTarget = join(remoteTargetDir, 'sw.js')

for (const name of readdirSync(remoteSourceDir)) {
  const source = join(remoteSourceDir, name)
  if (!statSync(source).isFile()) continue
  // PWA 脚本由 esbuild 从 app.ts 构建,这里只复制 html/css 等静态资源。
  if (name.endsWith('.ts') || name === 'app.js') continue
  // Service Worker:注入构建版本,使缓存名随每次构建变化(否则手机端外壳永不更新)。
  if (name === 'sw.js') {
    const cacheVersion = buildCommit === '' ? buildVersion : `${buildVersion}-${buildCommit}`
    const text = readFileSync(source, 'utf8')
    if (!text.includes('__DSH_CACHE_VERSION__')) {
      throw new Error('src/remote/sw.js 缺少 __DSH_CACHE_VERSION__ 占位符,缓存将无法随版本失效')
    }
    writeFileSync(swTarget, text.replaceAll('__DSH_CACHE_VERSION__', cacheVersion), 'utf8')
    console.log(`copy-assets: sw.js 缓存版本 -> dsh-remote-${cacheVersion}`)
    copied += 1
    continue
  }
  copyFileSync(source, join(remoteTargetDir, name))
  copied += 1
}

// PWA 图标:复制原图 + 生成 192/512 与 maskable(内容缩放 80% 居中,留安全区)。
try {
  const iconBuf = readFileSync(join(root, 'assets', 'icon.png'))
  copyFileSync(join(root, 'assets', 'icon.png'), join(remoteTargetDir, 'icon.png'))
  writeFileSync(join(remoteTargetDir, 'icon-192.png'), resizePng(iconBuf, 192, 192))
  writeFileSync(join(remoteTargetDir, 'icon-512.png'), resizePng(iconBuf, 512, 512))
  writeFileSync(join(remoteTargetDir, 'icon-maskable.png'), resizePng(iconBuf, 512, 512, 0.8))
  copied += 3
} catch (error) {
  console.error('[copy-assets] PWA 图标生成失败:', error instanceof Error ? error.message : String(error))
}

// 桌面宠物图(Gemini 生成):复制到 renderer 供 file:// 相对路径加载。
mkdirSync(join(targetDir, 'assets'), { recursive: true })
copyFileSync(join(root, 'assets', 'pet-whale.svg'), join(targetDir, 'assets', 'pet-whale.svg'))
copied += 1

console.log(`copy-assets: ${copied + 1} 个静态资源已复制(dist/renderer + dist/remote)`)
