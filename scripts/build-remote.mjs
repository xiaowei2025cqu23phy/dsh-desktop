/**
 * 远程 PWA 构建:esbuild 打包 src/remote/app.ts 为单文件 IIFE(dist/remote/app.js)。
 * index.html 仍以经典 <script src="./app.js"> 加载,无需改动页面。
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src', 'remote', 'app.ts')],
  outfile: join(root, 'dist', 'remote', 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  logLevel: 'warning',
  sourcemap: false,
  // PWA 为经典脚本单文件,顶部保留原注释头由源文件携带。
  banner: { js: '/* DeepSeek Harness Desktop PWA (built from src/remote/app.ts) */' },
})

console.log('build-remote: app.ts → dist/remote/app.js (esbuild)')
