/**
 * RPC 协议适配层录制回放测试(纯函数,无需 Electron/harness)。
 * 以「样本请求 → 期望 wire 载荷」的夹具回放 toWireMethod / toWirePayload,
 * 覆盖端点名映射与 typert 四种参数壳(request / _request / spread / nsRequest)。
 * 用法:node scripts/rpc-protocol-test.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { toWireMethod, toWirePayload, SLASH_ENVELOPE } = require('../dist/main/rpc-protocol.js')

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

// ---- 端点名映射 ----
check('斜杠协议-映射点', toWireMethod('slash', 'session.prompt'), 'session/prompt')
check('点协议-保持点', toWireMethod('dot', 'session.prompt'), 'session.prompt')
check('斜杠协议-已是斜杠', toWireMethod('slash', 'session/list'), 'session/list')

// ---- typert 参数壳 ----
check('request 壳', toWirePayload('slash', 'session/create', { x: 1 }), { args: { request: { x: 1 } } })
check('_request 壳(缺省)', toWirePayload('slash', 'session/list', { x: 1 }), { args: { _request: { x: 1 } } })
check('spread 壳', toWirePayload('slash', 'llm/listProviders', { x: 1 }), { args: { x: 1 } })
check('nsRequest 壳-指定 ns', toWirePayload('slash', 'llm/discoverModels', { settingsNs: 'custom', y: 1 }), { args: { settingsNs: 'custom', request: { y: 1 } } })
check('nsRequest 壳-缺省 ns', toWirePayload('slash', 'llm/discoverModels', { y: 1 }), { args: { settingsNs: 'llm-pi-ai', request: { y: 1 } } })

// ---- 点协议:payload 原样透传(旧版端点无参数壳) ----
check('点协议-透传', toWirePayload('dot', 'session/create', { x: 1 }), { x: 1 })
check('点协议-空载荷', toWirePayload('dot', 'session.list', {}), {})

// ---- 录制回放:遍历整张 SLASH_ENVELOPE,断言每种方法都能稳定复现其参数壳 ----
// 这是一份「录制样本表」:每个 wire 方法名与其期望的壳类型逐一回放校验。
const samples = [
  ['session/modelCatalog', 'spread'],
  ['llm/listProviders', 'spread'],
  ['llm/listConfigurableProviders', 'spread'],
  ['llm/discoverModels', 'nsRequest'],
  ['session/create', 'request'],
  ['session/rename', 'request'],
  ['session/selectModel', 'request'],
  ['session/page', 'request'],
  ['session/prompt', 'request'],
  ['session/updateQueue', 'request'],
  ['session/cancel', 'request'],
  ['workspace/create', 'request'],
  ['workspace/rename', 'request'],
  ['workspace/delete', 'request'],
  ['workspace/archiveSession', 'request'],
  ['settings/describe', 'spread'],
  ['settings/update', 'spread'],
  ['settings/mutate', 'spread'],
  ['settings/replace', 'spread'],
  ['credentials/set', 'spread'],
  ['credentials/describe', 'spread'],
  ['credentials/unset', 'spread'],
  ['agentPresets/list', 'spread'],
  ['dynamicCordisRunner/inventory', 'spread'],
  ['dynamicCordisRunner/syncInspectManifest', 'spread'],
  ['commands/list', 'spread'],
  ['subagents/list', 'spread'],
  ['skills/list', 'request'],
]
for (const [wireName, envelope] of samples) {
  check(`录制样本-${wireName}`, SLASH_ENVELOPE[wireName], envelope)
}

// 未收录的方法应落到 _request 缺省壳。
check('未收录方法-_request 缺省', toWirePayload('slash', 'some/futureMethod', { a: 1 }), { args: { _request: { a: 1 } } })

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 个失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
