/**
 * 网关「真正断开」离线测试(用假 harness/config/events,无需 Electron 运行)。
 * 覆盖:建立 SSE 连接后 setPaused(true) → 该响应被 end 且 EventHub 订阅归零;
 *       blacklistDevice 只断开被拉黑设备的连接。
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
      approvedDevices: [], pendingDevices: [], presetWorkspaceRoots: [],
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

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 个失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
