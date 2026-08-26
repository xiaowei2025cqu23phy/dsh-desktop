/**
 * settings.yaml 自动补全(一劳永逸)。
 *
 * 用户在模型设置里新增 provider 时常漏默认字段(streamIdleTimeoutMs /
 * defaultMaxTokens 等),导致「流式超时/链接问题」这类隐形故障。应用启动时
 * 对 llm-pi-ai 下已存在的 provider 补齐缺省值、规范化 baseURL:
 * - 只补缺失字段,绝不覆盖用户显式配置;
 * - openai-completions 兼容接口的 baseURL 缺 /v1 时自动补上;
 * - 解析/写入失败静默跳过,不影响应用启动。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

/** Provider 常用缺省值(与其它 provider 的显式配置对齐)。 */
const PROVIDER_DEFAULTS: Record<string, { value: unknown; label: string }> = {
  defaultContextWindow: { value: 262144, label: 'defaultContextWindow' },
  defaultMaxTokens: { value: 32768, label: 'defaultMaxTokens' },
  streamIdleTimeoutMs: { value: 300000, label: 'streamIdleTimeoutMs' },
  defaultInput: { value: ['text'], label: 'defaultInput' },
}

/** settings.yaml 路径:配置了 DSH 家目录时用它,否则默认 ~/.dsh。 */
export function settingsPath(dshHome: string | null): string {
  return dshHome && dshHome.trim() !== ''
    ? join(dshHome.trim(), 'settings.yaml')
    : join(homedir(), '.dsh', 'settings.yaml')
}

/** 规范化 openai-completions 接口的 baseURL:缺版本段时补 /v1,否则原样。 */
function normalizeBaseURL(api: unknown, base: unknown): string | undefined {
  if (api !== 'openai-completions') return undefined
  if (typeof base !== 'string' || base.trim() === '') return undefined
  const trimmed = base.trim().replace(/\/+$/, '')
  // 已含 /v1、/api/v1、/v2 等版本段的不动。
  if (/(?:^|\/)(?:api\/)?v\d+$/i.test(trimmed) || /(?:^|\/)(?:api\/)?v\d+\//i.test(trimmed)) return undefined
  return `${trimmed}/v1`
}

/** 执行补全;返回改动条数与说明(供日志)。 */
export function healProviderSettings(path: string): { changed: number; messages: string[] } {
  if (!existsSync(path)) return { changed: 0, messages: [] }
  let doc: unknown
  try {
    doc = load(readFileSync(path, 'utf8')) ?? {}
  } catch (error) {
    return { changed: 0, messages: [`settings.yaml 解析失败:${error instanceof Error ? error.message : String(error)}`] }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { changed: 0, messages: ['settings.yaml 不是对象格式,跳过补全'] }
  }
  const root = doc as Record<string, unknown>
  const llm = root['llm-pi-ai']
  if (typeof llm !== 'object' || llm === null) return { changed: 0, messages: [] }
  const providers = (llm as Record<string, unknown>)['providers']
  if (typeof providers !== 'object' || providers === null) return { changed: 0, messages: [] }

  const messages: string[] = []
  let changed = 0
  for (const [name, raw] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const provider = raw as Record<string, unknown>
    // 只处理 openai-completions 形态(有 baseURL 的 provider),跳过内部厂家。
    const api = provider['api'] ?? 'openai-completions'
    const fixes: string[] = []
    for (const [key, def] of Object.entries(PROVIDER_DEFAULTS)) {
      if (provider[key] === undefined) {
        provider[key] = def.value
        fixes.push(def.label)
      }
    }
    const normalized = normalizeBaseURL(api, provider['baseURL'])
    if (normalized !== undefined) {
      provider['baseURL'] = normalized
      fixes.push(`baseURL→${normalized}`)
    }
    if (fixes.length > 0) {
      changed += 1
      messages.push(`provider「${name}」补全:${fixes.join(', ')}`)
    }
  }
  if (changed === 0) return { changed: 0, messages: [] }
  try {
    writeFileSync(path, dump(root, { lineWidth: 120, noRefs: true }), 'utf8')
  } catch (error) {
    return { changed: 0, messages: [`settings.yaml 写入失败:${error instanceof Error ? error.message : String(error)}`] }
  }
  return { changed, messages }
}
