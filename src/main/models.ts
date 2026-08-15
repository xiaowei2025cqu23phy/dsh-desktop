/**
 * 模型管理:通过 harness 协议读取/切换模型。
 *
 * - `llm.providers` + `llm.models`:可配置 Provider 目录与模型目录。
 * - `settings.replace('agent-default-model', …)`:设置新会话默认模型(热生效)。
 * - `settings.update('llm-pi-ai', …)` + `credentials.set`:添加自定义 OpenAI 兼容网关。
 * - `llm.discoverModels`:从网关拉取模型清单。
 */

import { HarnessClient } from './client'

export interface ProviderView {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  active: boolean
}

export interface ModelEntry {
  id: string
  name?: string
  description?: string
}

export interface ModelGroup {
  /** Provider 路由 id(与 llm.providers 的 provider 对应)。 */
  id: string
  name: string
  models: ModelEntry[]
}

export interface DefaultSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface CustomProviderSpec {
  id: string
  displayName: string
  baseURL: string
  /** pi-ai 协议标识,默认 openai-completions。 */
  api: string
  apiKey: string
  /** 逗号分隔的模型 ID 列表。 */
  models: string
}

/** 常见网关预设,供"添加自定义 Provider"向导使用。 */
export const GATEWAY_PRESETS: Array<{ label: string; baseURL: string; api: string }> = [
  { label: 'DeepSeek 官方(OpenAI 兼容)', baseURL: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', api: 'openai-completions' },
  { label: 'Ollama 本地', baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
  { label: '自定义网关', baseURL: '', api: 'openai-completions' },
]

export class ModelManager {
  constructor(private client: () => HarnessClient) {}

  private get(): HarnessClient {
    return this.client()
  }

  /** Provider 目录(llm.providers)。 */
  async providers(): Promise<ProviderView[]> {
    const result = await this.get().rpc<{ providers: ProviderView[] }>('llm.providers')
    return result.providers
  }

  /** 模型目录(llm.models)。 */
  async models(): Promise<{ groups: ModelGroup[]; failures: Array<{ id: string; name: string; message: string }> }> {
    const result = await this.get().rpc<{
      groups: ModelGroup[]
      failures: Array<{ id: string; name: string; message: string }>
    }>('llm.models')
    return { groups: result.groups ?? [], failures: result.failures ?? [] }
  }

  /** 当前默认模型(host.describe 的 provider/model 字段;未配置时为 null)。 */
  async defaultSelection(): Promise<DefaultSelection | null> {
    const result = await this.get().rpc<{ provider?: string; model?: string }>('host.describe')
    if (typeof result.provider !== 'string' || typeof result.model !== 'string') return null
    return { provider: result.provider, model: result.model }
  }

  /**
   * 设置默认模型:通过 session.selectModel 写入(host 侧会同时持久化为新会话默认)。
   * 应用到最近一个会话;没有会话时创建一个空会话承载该选择。
   * @returns 被应用的会话 id。
   */
  async setDefault(provider: string, model: string): Promise<{ appliedToSession: string }> {
    const client = this.get()
    let sessionId: string | null = null
    try {
      const list = await client.rpc<{ items: Array<{ sessionId: string }> }>('session.list')
      sessionId = list.items[0]?.sessionId ?? null
    } catch {
      sessionId = null
    }
    if (sessionId === null) {
      const created = await client.rpc<{ sessionId: string }>('session.create', {})
      sessionId = created.sessionId
    }
    await client.rpc('session.selectModel', { sessionId, provider, model })
    return { appliedToSession: sessionId }
  }

  /** 添加自定义 Provider(OpenAI 兼容网关)。密钥经 credentials.set 写入。 */
  async addCustomProvider(spec: CustomProviderSpec): Promise<void> {
    const client = this.get()
    const id = spec.id.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error('Provider ID 只能包含小写字母、数字和连字符,且不能以连字符开头')
    }
    if (!/^https?:\/\//.test(spec.baseURL.trim())) {
      throw new Error('Base URL 必须以 http:// 或 https:// 开头')
    }
    const apiKeyEnv = spec.apiKey.trim() !== ''
      ? `DSH_DESKTOP_${id.replace(/[^a-z0-9]/g, '_').toUpperCase()}`
      : undefined
    if (apiKeyEnv !== undefined) {
      try {
        await client.rpc('credentials.set', { ref: apiKeyEnv, value: spec.apiKey.trim() })
      } catch (error) {
        throw new Error(`写入密钥失败:${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const models = spec.models
      .split(',')
      .map((model: string) => model.trim())
      .filter((model: string) => model !== '')
    if (models.length === 0) {
      throw new Error('至少填写一个模型 ID(逗号分隔)')
    }
    const profile: Record<string, unknown> = {
      displayName: spec.displayName.trim() || id,
      api: spec.api.trim() || 'openai-completions',
      baseURL: spec.baseURL.trim(),
      models: models.map((model) => ({ id: model })),
    }
    if (apiKeyEnv !== undefined) profile.apiKeyEnv = apiKeyEnv
    await client.rpc('settings.update', { ns: 'llm-pi-ai', patch: { providers: { [id]: profile } } })
  }

  /** 从网关拉取模型清单(llm.discoverModels)。 */
  async discoverModels(baseURL: string, api: string, apiKey: string): Promise<ModelEntry[]> {
    const result = await this.get().rpc<{ models: ModelEntry[] }>('llm.discoverModels', {
      settingsNs: 'llm-pi-ai',
      baseURL: baseURL.trim(),
      api: api.trim() || 'openai-completions',
      ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
    })
    return result.models ?? []
  }

  /** 删除一个自定义 Provider(清空 llm-pi-ai.providers.<id>)。 */
  async removeProvider(id: string): Promise<void> {
    await this.get().rpc('settings.mutate', {
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', id] }],
    })
  }
}
