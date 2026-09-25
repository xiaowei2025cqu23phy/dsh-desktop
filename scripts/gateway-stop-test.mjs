/**
 * 网关「真正断开」与「访问判定」离线测试(用假 harness/config/events,无需 Electron 运行)。
 * 覆盖:建立 SSE 连接后 setPaused(true) → 该响应被 end 且 EventHub 订阅归零;
 *       blacklistDevice 只断开被拉黑设备的连接;
 *       令牌即访问权(带令牌首次连接直接可用)、被暂停/被拉黑设备仍被拒绝。
 * 用法:node scripts/gateway-stop-test.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { RemoteGateway } = require('../dist/main/gateway.js')

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`✓ ${name}`)
  } else {
    failures++
    console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`)
  }
}

function makeConfig() {
  const store = {
    remote: {
      enabled: true, port: 0, bindHost: '127.0.0.1', paused: false,
      token: 'test-token', expiresAt: null, blacklistedDevices: [],
      approvedDevices: [], presetWorkspaceRoots: [],
    },
    appearance: { phone: { path: null, position: { x: 0.5, y: 0.5 } }, window: { path: null, position: { x: 0.5, y: 0.5 } } },
    chatSessions: {},
  }
  return {
    get: () => store,
    update: (section, patch) => { if (section === 'remote') store.remote = { ...store.remote, ...patch }; return store.remote },
    appendAudit: () => {},
  }
}

let subCount = 0
const events = { subscribe: () => { subCount += 1; return () => { subCount -= 1 } } }
const harness = { client: () => ({}), status: () => ({ state: 'stopped' }), baseUrl: () => 'http://x' }

// ---- setPaused(true) 断开 SSE ----
{
  const gateway = new RemoteGateway(makeConfig(), harness, events)
  gateway.start()
  // listen(0) 由系统分配端口,需等待监听就绪。
  let port = null
  for (let i = 0; i < 200 && port === null; i++) {
    const addr = gateway.server !== null ? gateway.server.address() : null
    port = addr !== null && typeof addr.port === 'number' ? addr.port : null
    if (port === null) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  check('网关监听就绪', port !== null, true)

  const ticketRes = await fetch(`http://127.0.0.1:${port}/api/events/ticket`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'x-dsh-device': 'dev-A' },
  })
  const ticket = await ticketRes.json()
  check('ticket 签发', typeof ticket.ticket, 'string')

  const sseRes = await fetch(`http://127.0.0.1:${port}/api/events?ticket=${ticket.ticket}`)
  const reader = sseRes.body.getReader()
  // 读取首帧(连接确认)。
  const first = await reader.read()
  check('SSE 首帧 connected', new TextDecoder().decode(first.value ?? new Uint8Array()).includes('connected'), true)
  check('订阅建立', subCount, 1)

  // 暂停 → 真正断开:该响应被 end,订阅归零。
  gateway.setPaused(true)
  let sawEnd = false
  for (let i = 0; i < 20; i++) {
    const { done } = await reader.read()
    if (done) { sawEnd = true; break }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  check('暂停后 SSE 被 end', sawEnd, true)
  check('暂停后订阅归零', subCount, 0)
  gateway.stop()
}

// ---- blacklistDevice 只断开目标设备 ----
{
  const gateway = new RemoteGateway(makeConfig(), harness, events)
  const ended = []
  const unsubbed = []
  const fakeEntry = (deviceId) => ({
    deviceId,
    unsubscribe: () => unsubbed.push(deviceId),
    res: { destroyed: false, end: () => ended.push(deviceId) },
  })
  gateway.activeSse.add(fakeEntry('dev-A'))
  gateway.activeSse.add(fakeEntry('dev-B'))

  gateway.blacklistDevice('dev-A')
  check('拉黑只断开目标设备 end', ended.join(','), 'dev-A')
  check('拉黑只断开目标设备 unsubscribe', unsubbed.join(','), 'dev-A')
  check('其他设备连接保留', gateway.activeSse.size, 1)
}

// ---- 令牌即访问权:无设备标识直接放行;暂停/拉黑/错误令牌仍拒绝 ----
{
  const config = makeConfig()
  const gateway = new RemoteGateway(config, harness, events)
  gateway.start()
  let port = null
  for (let i = 0; i < 200 && port === null; i++) {
    const addr = gateway.server !== null ? gateway.server.address() : null
    port = addr !== null && typeof addr.port === 'number' ? addr.port : null
    if (port === null) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  // 用 /api/rpc 探测鉴权结果:401 = 拒绝;其他状态码 = 已通过鉴权进入业务处理。
  const rpcStatus = async (headers) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ method: 'session.list', payload: {} }),
    })
    return res.status
  }
  const token = { authorization: 'Bearer test-token' }

  check('无令牌被拒', await rpcStatus({}), 401)
  check('错误令牌被拒', await rpcStatus({ authorization: 'Bearer wrong-token' }), 401)
  check('有效令牌无设备标识直接放行', await rpcStatus(token), 200)
  check('有效令牌 + 首次连接的设备标识直接放行', await rpcStatus({ ...token, 'x-dsh-device': 'dev-new' }), 200)
  check(
    '首次连接的设备自动登记为已连接设备',
    config.get().remote.approvedDevices.some((device) => device.id === 'dev-new'),
    true,
  )

  // 桌面端暂停该设备:令牌正确也拒绝。
  gateway.pauseDevice('dev-new')
  check('已暂停设备被拒(令牌正确)', await rpcStatus({ ...token, 'x-dsh-device': 'dev-new' }), 401)
  gateway.resumeDevice('dev-new')
  check('恢复后同一设备可用', await rpcStatus({ ...token, 'x-dsh-device': 'dev-new' }), 200)

  // 拉黑:令牌正确也拒绝,且优先于一切。
  gateway.blacklistDevice('dev-new')
  check('已拉黑设备被拒(令牌正确)', await rpcStatus({ ...token, 'x-dsh-device': 'dev-new' }), 401)

  // 全局暂停兜底:config.paused 为 true 时,请求打到仍在监听的服务器也一律拒绝(竞态窗口兜底)。
  config.update('remote', { paused: true })
  check('全局暂停后拒绝', await rpcStatus(token), 503)
  config.update('remote', { paused: false })
  gateway.stop()
}

// ---- 绑定地址失效时的回退与可恢复性 ----
// 场景:用户选了「仅当前局域网 IP」,之后换了网络 —— 配置里的地址不再属于本机。
// 修前:listen 报 EADDRNOTAVAIL,但 server 引用仍被赋值,于是
//   ① 界面按 server !== null 显示"已监听",用户不知道其实没监听;
//   ② start() 因 server !== null 直接 return,点「重新启用」永远无效,只能重启应用。
{
  const config = makeConfig()
  // 用 RFC5737 文档保留地址,保证不属于本机。
  config.update('remote', { bindHost: '203.0.113.7', port: 0 })
  const gateway = new RemoteGateway(config, harness, events)

  gateway.start()
  // 等待条件必须用「是否等于 '(未监听)'」而不是 `=== null`:
  // state().listenHost 为显示友好返回的是字符串 '(未监听)' 而非 null,
  // 写 `=== null` 会让循环一次都不执行,进而误判成"回退失败"。
  let state = gateway.state()
  for (let i = 0; i < 200 && state.listenHost === '(未监听)'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    state = gateway.state()
  }

  check('失效地址回退到 0.0.0.0', state.listenHost, '0.0.0.0')
  check('回退原因如实上报', typeof state.lastError === 'string' && state.lastError.includes('203.0.113.7'), true)
  check('回退后确实在监听', gateway.server !== null, true)

  // 可恢复性:停止后能再次启动(修前 server 引用不清会导致 start() 直接 return)。
  gateway.stop()
  check('停止后 listenHost 归位', gateway.state().listenHost, '(未监听)')
  gateway.start()
  let again = gateway.state()
  for (let i = 0; i < 200 && again.listenHost === '(未监听)'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    again = gateway.state()
  }
  check('停止后可重新启用', again.listenHost, '0.0.0.0')
  gateway.stop()
}

// ---- 端口被占用时:不谎报"已监听",且失败后可重试 ----
{
  const blocked = new RemoteGateway(makeConfig(), harness, events)
  blocked.start()
  let port = null
  for (let i = 0; i < 200 && port === null; i++) {
    const addr = blocked.server !== null ? blocked.server.address() : null
    port = addr !== null && typeof addr.port === 'number' ? addr.port : null
    if (port === null) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  check('占用测试:先占住一个端口', port !== null, true)

  const clashConfig = makeConfig()
  clashConfig.update('remote', { bindHost: '127.0.0.1', port })
  const clash = new RemoteGateway(clashConfig, harness, events)
  clash.start()
  let cs = clash.state()
  for (let i = 0; i < 200 && cs.lastError === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    cs = clash.state()
  }
  check('端口冲突被识别', typeof cs.lastError === 'string' && cs.lastError.includes('失败'), true)
  check('端口冲突时不谎报已监听', cs.listenHost, '(未监听)')
  // 关键:失败后引用已清,再次 start 会真的重试(而不是 return)。
  clash.start()
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('失败后仍可重试(start 不早退)', clash.state().lastError !== null, true)

  blocked.stop()
  clash.stop()
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 个失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
