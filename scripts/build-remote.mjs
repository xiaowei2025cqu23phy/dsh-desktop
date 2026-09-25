/**
 * 远程 PWA 构建:esbuild 打包 src/remote/app.ts 为单文件 IIFE(dist/remote/app.js)。
 * index.html 仍以经典 <script src="./app.js"> 加载,无需改动页面。
 *
 * 另外产出一份「纯函数」的 CJS 包(dist/remote/pure.js):markdown 渲染这类逻辑不碰
 * DOM,理应能脱离浏览器与手机直接验证。页面不加载它,只给离线测试 require。
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

// 纯函数导出包(供 scripts/*-test.mjs require):util.ts 里的 renderMarkdown 等不碰 DOM。
await build({
  entryPoints: [join(root, 'src', 'remote', 'pure.ts')],
  outfile: join(root, 'dist', 'remote', 'pure.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node22'],
  logLevel: 'warning',
  sourcemap: false,
})

console.log('build-remote: pure.ts → dist/remote/pure.js (esbuild, 供离线测试)')
