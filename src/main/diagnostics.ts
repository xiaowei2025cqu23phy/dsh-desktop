/** Collect a small, credential-free diagnostic snapshot for support and export. */
import { app } from 'electron'
import { hostname, platform, release } from 'node:os'
import type { ConfigStore } from './config'
import type { HarnessManager } from './harness'
import type { RemoteGateway } from './gateway'
import type { QQBotAdapter } from './qq-bot'
import type { TelegramBotAdapter } from './telegram-bot'

export interface DiagnosticsDeps {
  config: ConfigStore
  harness: HarnessManager
  gateway?: RemoteGateway
  qqBot?: QQBotAdapter
  telegramBot?: TelegramBotAdapter
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer <redacted>')
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, '<redacted>')
      .replace(/sk-[0-9A-Za-z]{20,}/g, '<redacted>')
      .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '<user-path>')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const secret = /token|secret|password|apikey|api_key|credential/i.test(key)
      return [key, secret ? '<redacted>' : redact(item)]
    }))
  }
  return value
}

export function collectDiagnostics(deps: DiagnosticsDeps): Record<string, unknown> {
  return redact({
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    app: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
    system: { platform: platform(), release: release(), hostname: hostname() },
    configPath: deps.config.filePath(),
    harness: { status: deps.harness.status(), logs: deps.harness.logs.slice(-80) },
    gateway: deps.gateway === undefined ? null : { config: deps.gateway.getConfig(), addresses: deps.gateway.lanAddresses() },
    qq: deps.qqBot === undefined ? null : { started: deps.qqBot.isStarted() },
    telegram: deps.telegramBot === undefined ? null : { started: deps.telegramBot.isStarted() },
  }) as Record<string, unknown>
}
