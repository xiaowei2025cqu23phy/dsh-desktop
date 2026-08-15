/**
 * 冒烟测试:连接一个正在运行的 dsh harness,验证 RPC 客户端与模型管理。
 * 用法:node scripts/smoke.mjs [baseUrl]
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { HarnessClient } = require('../dist/main/client.js')
const { ModelManager } = require('../dist/main/models.js')

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080'
const client = new HarnessClient(baseUrl)

const ok = await client.probe()
console.log(`probe ${baseUrl} -> ${ok}`)
if (!ok) {
  console.error('harness 不可用;请先启动 dsh web')
  process.exit(1)
}

const listResult = await client.rpc('session.list', {})
console.log(`session.list -> ${listResult.items.length} 个会话`)
for (const item of listResult.items.slice(0, 5)) {
  console.log(`  - ${item.sessionId}  ${item.title ?? '(无标题)'}`)
}

const models = new ModelManager(() => client)
const providers = await models.providers()
console.log(`llm.providers -> ${providers.length} 个可配置 Provider`)
for (const provider of providers) {
  console.log(`  - ${provider.provider} (${provider.displayName}) active=${provider.active}`)
}

const catalog = await models.models()
console.log(`llm.models -> ${catalog.groups.length} 组模型`)
for (const group of catalog.groups) {
  const ids = group.models.map((model) => model.id).join(', ')
  console.log(`  - ${group.name ?? group.id}: ${ids}`)
}
if (catalog.failures.length > 0) {
  console.log('模型目录失败:')
  for (const failure of catalog.failures) console.log(`  - ${failure.provider}: ${failure.message}`)
}

const selected = await models.defaultSelection()
console.log(`默认模型 -> ${selected === null ? '(未设置)' : `${selected.provider} / ${selected.model}`}`)

const host = await client.rpc('host.describe', {})
console.log(`host.describe -> version=${host.version}, cwd=${host.cwd}, attachedSessions=${host.attachedSessions}`)

const settings = await client.rpc('settings.describe', {})
console.log(`settings.describe -> writable=${settings.writable}, ${settings.namespaces.length} 个命名空间`)
