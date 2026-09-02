/**
 * 远程网关回归测试(需桌面端运行中,远程访问已启用):
 *   1. 未授权 RPC 必须 401;
 *   2. PWA 打包内容必须包含新功能标记(防止发旧包);
 *   3. 白名单内文件流 Range 请求必须返回 206 + 正确 content-range + 切片长度;
 *   4. 越权路径必须 403。
 *
 * 用法:node scripts/test-remote.mjs [baseUrl] [token]
 * 不传 token 时自动读取桌面端配置 %APPDATA%/DeepSeek Harness Desktop/config.json。
 * 退出码:0 全部通过,1 有失败。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:3083').replace(/\/+$/, '')
let token = process.argv[3] ?? ''
if (token === '') {
  const cfgPath = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DeepSeek Harness Desktop', 'config.json')
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))
      token = cfg.remote?.token ?? ''
    } catch { /* 配置读不出来时按无 token 处理 */ }
  }
}

let failures = 0
const pass = (name) => console.log(`  ✓ ${name}`)
const fail = (name, detail) => { failures += 1; console.error(`  ✗ ${name}: ${detail}`) }

const headers = (withAuth) => ({
  'content-type': 'application/json',
  ...(withAuth ? { authorization: `Bearer ${token}`, 'x-dsh-device': 'regression-test', 'x-dsh-device-label': 'dsh-regression' } : {}),
})

console.log(`测试网关:${baseUrl} ${token === '' ? '(无 token)' : '(已读 token)'}`)

// 1. 未授权 RPC 必须拒绝。
{
  const res = await fetch(`${baseUrl}/api/rpc`, { method: 'POST', headers: headers(false), body: '{}' })
  if (res.status === 401) pass('未授权 RPC 被拒绝(401)')
  else fail('未授权 RPC 被拒绝(401)', `got ${res.status}`)
}

// 2. PWA 打包内容必须新鲜(含新功能标记)。
{
  const res = await fetch(`${baseUrl}/app.js`)
  const text = await res.text()
  // 中文在打包时被 esbuild 转义为 \uXXXX,按转义序列检查"重新启用"提示。
  const fresh = text.includes('previewActionRow') && text.includes('openNewsessSheet') && text.includes('\\u91cd\\u65b0\\u542f\\u7528')
  if (res.status === 200 && fresh) pass('PWA 打包包含新功能(app.js)')
  else fail('PWA 打包包含新功能(app.js)', `status=${res.status}, fresh=${fresh}`)
}

// 3. 白名单内第一个文件:Range 请求必须 206 + content-range + 切片长度。
{
  const listRes = await fetch(`${baseUrl}/api/action`, { method: 'POST', headers: headers(true), body: JSON.stringify({ action: 'fs.list', path: '' }) })
  const list = await listRes.json()
  const roots = Array.isArray(list.roots) ? list.roots : []
  let tested = false
  for (const root of roots) {
    if (typeof root.path !== 'string' || root.path === '') continue
    const r = await fetch(`${baseUrl}/api/action`, { method: 'POST', headers: headers(true), body: JSON.stringify({ action: 'fs.list', path: root.path }) })
    const data = await r.json()
    const entries = Array.isArray(data.entries) ? data.entries : []
    const file = entries.find((e) => e.isDir === false && typeof e.path === 'string')
    if (file === undefined) continue
    const stream = await fetch(`${baseUrl}/api/fs/stream?path=${encodeURIComponent(file.path)}&token=${encodeURIComponent(token)}&device=regression-test`, {
      headers: { range: 'bytes=0-63' },
    })
    if (stream.status !== 206) { fail('媒体流 Range 返回 206', `status=${stream.status}`); tested = true; break }
    const cr = stream.headers.get('content-range') ?? ''
    if (!/^bytes 0-63\//.test(cr)) { fail('媒体流 content-range 正确', cr); tested = true; break }
    const body = await stream.arrayBuffer()
    if (body.byteLength !== 64) { fail('媒体流切片长度 64', String(body.byteLength)); tested = true; break }
    pass('媒体流 Range 206 + content-range + 切片长度')
    tested = true
    break
  }
  if (!tested) fail('媒体流 Range', '白名单内没有可测文件(请在桌面端添加预设工作区根目录)')
}

// 4. 越权路径必须 403。
{
  const res = await fetch(`${baseUrl}/api/fs/stream?path=${encodeURIComponent('C:/Windows/System32/notepad.exe')}&token=${encodeURIComponent(token)}&device=regression-test`)
  if (res.status === 403) pass('越权文件流被拒绝(403)')
  else fail('越权文件流被拒绝(403)', `got ${res.status}`)
}

if (failures === 0) {
  console.log('\n全部通过 ✓')
  process.exit(0)
}
console.error(`\n${failures} 项失败`)
process.exit(1)
