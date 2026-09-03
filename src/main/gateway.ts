/**
 * 局域网远程网关:手机 PWA 通过它访问 harness。
 *
 * - Bearer token 认证(首次生成,设置面板显示 + 二维码配对)。
 * - POST /api/rpc:白名单 RPC 转发到本机 harness。
 * - POST /api/command:Webhook 命令端点 —— 任意 HTTP 客户端(脚本/钉钉群机器人/
 *   Home Assistant 等)POST { text: "指令" } 即可执行远程命令并返回结果。
 * - GET /api/events:SSE 事件流(共享 EventHub 广播,断线重连)。
 * - GET /:伺服手机 PWA 静态页面。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { createReadStream, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, statSync, accessSync, constants, statfsSync } from 'node:fs'
import { dirname, extname, join, resolve, sep, basename } from 'node:path'
import { app, nativeImage } from 'electron'
import type { ConfigStore } from './config'
import type { EventHub } from './event-hub'
import type { HarnessManager } from './harness'
import { parseSchedDelay } from './qq-commands'
import type { RemoteCommandProcessor } from './remote-commands'
import { dshHomeOf, unarchiveInRegistry } from './workspace-registry'

export interface RemoteConfig {
  enabled: boolean
  port: number
  token: string
  expiresAt: number | null
  approvedDevices: Array<{ id: string; label: string; address: string; approvedAt: number; lastSeenAt: number }>
  pendingDevices: Array<{ id: string; label: string; address: string; requestedAt: number; lastSeenAt: number }>
  presetWorkspaceRoots: string[]
}

export const REMOTE_DEFAULTS: RemoteConfig = {
  enabled: false,
  port: 3082,
  token: '',
  expiresAt: null,
  approvedDevices: [],
  pendingDevices: [],
  presetWorkspaceRoots: [],
}

/** 手机端允许调用的 RPC 白名单(纵深防御:token 之外的访问边界)。 */
const ALLOWED_METHODS = new Set([
  'session.list',
  'session.history',
  'session.attachment',
  'session.create',
  'session.prompt',
  'session.cancel',
  'session.rename',
  'session.selectModel',
  'session.models',
  'workspace.list',
  'workspace.create',
  'workspace.rename',
  'workspace.archiveSession',
  'workspace.unarchiveSession',
  'llm.models',
  'llm.providers',
  'host.describe',
  'host.listEntries',
  'host.readTextFile',
])

/** 容易超时的操作放宽超时。 */
const SLOW_METHODS = new Set(['session.prompt', 'session.history', 'session.list'])

interface RpcBody {
  method?: unknown
  payload?: unknown
}

export class RemoteGateway {
  private server: ReturnType<typeof createServer> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private sseTickets = new Map<string, { deviceId: string; expiresAt: number }>()
  private remoteDir: string
  /** 新设备请求批准时的回调(桌面端据此拉起审批)。 */
  onPendingDevice: ((device: { id: string; label: string; address: string }) => void) | null = null

  constructor(
    private config: ConfigStore,
    private harness: HarnessManager,
    private events: EventHub,
    private commands?: RemoteCommandProcessor,
  ) {
    this.remoteDir = join(__dirname, '..', 'remote')
  }

  getConfig(): RemoteConfig {
    const config = this.config.get().remote
    if (config.expiresAt !== null && Date.now() >= config.expiresAt) {
      config.enabled = false
      config.expiresAt = null
      this.config.update('remote', { enabled: false, expiresAt: null })
      this.stop()
    }
    if (config.token === '') {
      config.token = randomBytes(16).toString('hex')
      this.config.update('remote', { token: config.token })
    }
    return config
  }

  setConfig(patch: Partial<RemoteConfig>): RemoteConfig {
    const next = this.config.update('remote', patch)
    return next
  }

  /** 局域网可达地址列表(供设置面板显示与二维码)。 */
  lanAddresses(): string[] {
    const result: string[] = []
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal && usableLanAddress(entry.address, name)) {
          result.push(entry.address)
        }
      }
    }
    return result
  }

  /** 二维码内容:手机扫码后打开 PWA 并自动填入地址与 token。 */
  pairUrl(): string {
    const addresses = this.lanAddresses()
    const host = addresses[0] ?? '127.0.0.1'
    const config = this.getConfig()
    // 用查询参数传递:部分扫码应用(如微信)会丢弃 URL fragment,导致参数丢失。
    // PWA 读取后立即 replaceState 清除地址栏;网关无访问日志,Token 不会落盘。
    const server = `http://${host}:${config.port}`
    return `${server}/?server=${encodeURIComponent(server)}&token=${encodeURIComponent(config.token)}`
  }

  /** 二维码 data URL(主进程用 qrcode 生成,渲染进程直接显示)。 */
  async qrDataUrl(): Promise<string | null> {
    const config = this.getConfig()
    if (!config.enabled || config.token === '') return null
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const QRCode = require('qrcode') as { toDataURL: (text: string, opts?: object) => Promise<string> }
      return await QRCode.toDataURL(this.pairUrl(), { width: 180, margin: 1 })
    } catch (error) {
      console.error('[gateway] 二维码生成失败:', error)
      return null
    }
  }

  /** 为每个局域网地址生成配对二维码(手机连哪个网络就扫哪个)。 */
  async qrDataUrls(): Promise<Array<{ address: string; url: string; dataUrl: string | null }>> {
    const config = this.getConfig()
    if (!config.enabled || config.token === '') return []
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const QRCode = require('qrcode') as { toDataURL: (text: string, opts?: object) => Promise<string> }
      const addresses = this.lanAddresses()
      const results: Array<{ address: string; url: string; dataUrl: string | null }> = []
      for (const address of addresses.slice(0, 3)) {
        const server = `http://${address}:${config.port}`
        const url = `${server}/?server=${encodeURIComponent(server)}&token=${encodeURIComponent(config.token)}`
        try {
          results.push({ address, url, dataUrl: await QRCode.toDataURL(url, { width: 180, margin: 1 }) })
        } catch {
          results.push({ address, url, dataUrl: null })
        }
      }
      return results
    } catch (error) {
      console.error('[gateway] 二维码生成失败:', error)
      return []
    }
  }

  start(): void {
    if (this.server !== null) return
    const config = this.getConfig()
    if (!config.enabled) return
    const server = createServer((req, res) => void this.handle(req, res))
    server.on('error', (error) => {
      console.error('[gateway] 监听失败:', error.message)
    })
    server.listen(config.port, '0.0.0.0', () => {
      console.log(`[gateway] 远程网关已启动,端口 ${config.port} (仅可信局域网客户端)`)
    })
    if (config.expiresAt !== null) {
      const delay = Math.max(0, config.expiresAt - Date.now())
      this.expiryTimer = setTimeout(() => {
        this.config.update('remote', { enabled: false, expiresAt: null })
        this.stop()
        console.warn('[gateway] 远程访问已自动过期并关闭')
      }, delay)
    }
    this.server = server
  }

  stop(): void {
    this.server?.close()
    this.server = null
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  restart(): void {
    this.stop()
    this.start()
  }

  // ---- 内部 ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://remote.local')
      // CORS:手机 PWA 与网关不同源。
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      const path = url.pathname

      if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/app.js' ||
          path === '/app.css' || path === '/manifest.webmanifest' || path === '/icon.png')) {
        this.serveStatic(path, res)
        return
      }
      if (req.method === 'GET' && path === '/wallpaper') {
        this.serveWallpaper(res)
        return
      }
      if (req.method === 'GET' && path === '/api/wallpapers') {
        this.serveWallpaperList(url, req, res)
        return
      }
      if (req.method === 'POST' && path === '/api/events/ticket') {
        await this.issueSseTicket(url, req, res)
        return
      }
      if (req.method === 'GET' && path === '/api/events') {
        this.serveEvents(url, req, res)
        return
      }
      if (req.method === 'POST' && path === '/api/rpc') {
        await this.handleRpc(url, req, res)
        return
      }
      if (req.method === 'POST' && path === '/api/command' && this.commands !== undefined) {
        await this.handleCommand(url, req, res)
        return
      }
      if (req.method === 'POST' && path === '/api/respond') {
        // 审批/提问应答:转发到 harness 的 /api/respond(带 token 认证)。
        await this.handleRespond(url, req, res)
        return
      }
      if (req.method === 'GET' && path === '/api/fs/stream') {
        await this.serveFsStream(url, req, res)
        return
      }
      if (req.method === 'GET' && path === '/api/tasks') {
        this.serveTaskList(url, req, res)
        return
      }
      if (req.method === 'POST' && path === '/api/action') {
        await this.handleAction(url, req, res)
        return
      }
      if (req.method === 'GET' && path === '/api/info') {
        const appearance = this.config.get().appearance
        const spec = appearance.phone.path !== null ? appearance.phone : appearance.window
        // 机器人通道的固定对话会话(手机端置顶展示):只认"纯对话"条目,
        // 过滤历史版本误写入的工作区会话(标签不是 (纯对话… 前缀)。
        const chatSessions = this.config.get().chatSessions ?? {}
        const botChatIds = Object.entries(chatSessions)
          .filter(([, e]) => typeof e?.label === 'string' && e.label.startsWith('(纯对话'))
          .map(([, e]) => e.sessionId)
        this.json(res, 200, {
          name: 'dsh-desktop-remote',
          version: '0.1.0',
          wallpaperPosition: spec.position,
          chatSessionIds: botChatIds,
        })
        return
      }
      // PWA 客户端诊断上报(历史加载失败等浏览器侧错误,写审计供本地排查)。
      if (req.method === 'POST' && path === '/api/diag' && this.authorization(url, req) === 'ok') {
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
          if (Buffer.concat(chunks).byteLength > 64 * 1024) break
        }
        let detail = 'pwa diag'
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown; sessionId?: unknown }
          detail = `pwa ${String(req.socket.remoteAddress ?? '?')}: ${String(body.error ?? '').slice(0, 400)}`
        } catch {
          // 非 JSON 上报,保留原始标记。
        }
        this.config.appendAudit({ time: Date.now(), type: 'remote.pwa-diag', detail })
        this.json(res, 200, { ok: true })
        return
      }
      this.json(res, 404, { error: 'not found' })
    } catch (error) {
      this.json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private authToken(url: URL, req: IncomingMessage): string | null {
    const query = url.searchParams.get('token')
    if (query !== null && query !== '') return query
    const header = req.headers.authorization
    if (header !== undefined && header.startsWith('Bearer ')) return header.slice(7)
    return null
  }

  private auditRemote(req: IncomingMessage, detail: string): void {
    this.config.appendAudit({ time: Date.now(), type: 'remote.request', detail: `局域网 ${req.socket.remoteAddress ?? '?'}: ${detail}`.slice(0, 300) })
  }

  private authorization(url: URL, req: IncomingMessage): 'ok' | 'pending' | 'denied' {
    const remote = req.socket.remoteAddress ?? ''
    if (!trustedLanClient(remote)) return 'denied'
    const token = this.authToken(url, req)
    if (token === null) return 'denied'
    const config = this.getConfig()
    if (config.expiresAt !== null && Date.now() >= config.expiresAt) return 'denied'
    if (config.token === '' || token !== config.token) return 'denied'
    if (remote === '127.0.0.1' || remote === '::1' || remote.endsWith('::ffff:127.0.0.1')) return 'ok'
    const id = req.headers['x-dsh-device'] ?? url.searchParams.get('device') ?? ''
    const deviceId = typeof id === 'string' && id.trim() !== '' ? id.trim().slice(0, 120) : ''
    const address = remote.replace(/^::ffff:/i, '')
    if (deviceId === '') return 'pending'
    const approved = config.approvedDevices.find((device) => device.id === deviceId)
    if (approved !== undefined) {
      if (Date.now() - approved.lastSeenAt > 60_000) {
        approved.lastSeenAt = Date.now()
        this.config.update('remote', { approvedDevices: config.approvedDevices })
      }
      return 'ok'
    }
    if (!config.pendingDevices.some((device) => device.id === deviceId)) {
      const labelHeader = req.headers['x-dsh-device-label']
      const label = typeof labelHeader === 'string' && labelHeader !== '' ? labelHeader.slice(0, 80) : '未命名设备'
      this.config.update('remote', { pendingDevices: [...config.pendingDevices, { id: deviceId, label, address, requestedAt: Date.now(), lastSeenAt: Date.now() }] })
      this.auditRemote(req, `新设备请求批准:${label}`)
      this.onPendingDevice?.({ id: deviceId, label, address })
    }
    return 'pending'
  }

  private authorized(url: URL, req: IncomingMessage): boolean {
    return this.authorization(url, req) === 'ok'
  }

  pendingDevices(): RemoteConfig['pendingDevices'] { return this.config.get().remote.pendingDevices }
  approvedDevices(): RemoteConfig['approvedDevices'] { return this.config.get().remote.approvedDevices }
  approveDevice(id: string): void {
    const remote = this.config.get().remote
    const pending = remote.pendingDevices.find((device) => device.id === id)
    if (pending === undefined) return
    this.config.update('remote', {
      pendingDevices: remote.pendingDevices.filter((device) => device.id !== id),
      approvedDevices: [...remote.approvedDevices.filter((device) => device.id !== id), { id: pending.id, label: pending.label, address: pending.address, approvedAt: Date.now(), lastSeenAt: pending.lastSeenAt }],
    })
    this.config.appendAudit({ time: Date.now(), type: 'remote.device.approved', detail: `批准远程设备:${pending.label} ${pending.address}` })
  }
  rejectDevice(id: string): void {
    const remote = this.config.get().remote
    const pending = remote.pendingDevices.find((device) => device.id === id)
    this.config.update('remote', { pendingDevices: remote.pendingDevices.filter((device) => device.id !== id) })
    if (pending !== undefined) this.config.appendAudit({ time: Date.now(), type: 'remote.device.rejected', detail: `拒绝远程设备:${pending.label} ${pending.address}` })
  }
  revokeDevice(id: string): void {
    const remote = this.config.get().remote
    const device = remote.approvedDevices.find((item) => item.id === id)
    this.config.update('remote', { approvedDevices: remote.approvedDevices.filter((item) => item.id !== id) })
    if (device !== undefined) this.config.appendAudit({ time: Date.now(), type: 'remote.device.revoked', detail: `撤销远程设备:${device.label} ${device.address}` })
  }

  /**
   * 恢复(取消归档)一个会话:从 harness 工作区注册表的 archivedSessionIds 移除
   * (harness 只提供 archiveSession,没有 unarchive RPC,见 workspace-registry.ts)。
   * 注册表内存态在 harness 进程内:连接的是本应用托管的实例且当前无运行中会话时,
   * 自动重启一次让列表立即生效;外部托管实例则提示重启后生效。
   */
  private async unarchiveSession(sessionId: string): Promise<{ note: string }> {
    const home = dshHomeOf(this.config.get().harness.dshHome)
    unarchiveInRegistry(home, sessionId)
    const status = this.harness.status()
    if (status.state === 'running' || status.state === 'starting') {
      // 本应用托管的实例:空闲(无运行中会话)时重启一次,让注册表内存态生效。
      try {
        const current = await this.harness.client().rpc<{ items: Array<{ running?: boolean }> }>('session.list', {}, 15000)
        const busy = (current.items ?? []).some((s) => s.running === true)
        if (!busy) {
          setTimeout(() => {
            void this.harness.restart().catch(() => { /* 重启失败会在服务状态里体现 */ })
          }, 600)
          return { note: '会话已恢复,正在刷新服务…' }
        }
      } catch {
        /* 查询失败按有任务处理,不冒险重启。 */
      }
      return { note: '会话已恢复(有任务运行中,将在服务空闲重启后生效)' }
    }
    return { note: '会话已恢复(当前服务由外部进程托管,重启电脑或服务后彻底生效)' }
  }

  private serveStatic(path: string, res: ServerResponse): void {
    const name = path === '/' ? 'index.html' : path.slice(1)
    const file = join(this.remoteDir, name)
    if (!existsSync(file)) {
      this.json(res, 404, { error: 'not found' })
      return
    }
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.webmanifest': 'application/manifest+json',
      '.png': 'image/png',
    }
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(readFileSync(file))
  }

  private async issueSseTicket(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.authorization(url, req)
    if (auth !== 'ok') {
      this.json(res, auth === 'pending' ? 428 : 401, { error: auth === 'pending' ? 'desktop approval required' : 'unauthorized' })
      return
    }
    const device = req.headers['x-dsh-device']
    if (typeof device !== 'string' || device === '') {
      this.json(res, 400, { error: 'device id required' })
      return
    }
    const ticket = randomBytes(24).toString('hex')
    this.sseTickets.set(ticket, { deviceId: device.slice(0, 120), expiresAt: Date.now() + 60_000 })
    this.json(res, 200, { ok: true, ticket })
  }

  private async handleRpc(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.authorization(url, req)
    if (auth !== 'ok') {
      this.json(res, auth === 'pending' ? 428 : 401, { error: auth === 'pending' ? 'desktop approval required' : 'unauthorized' })
      return
    }
    this.auditRemote(req, 'rpc')
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
      if (Buffer.concat(chunks).byteLength > 1024 * 1024) {
        this.config.appendAudit({ time: Date.now(), type: 'remote.rpc-skip', detail: 'payload too large' })
        this.json(res, 413, { error: 'payload too large' })
        return
      }
    }
    let body: RpcBody
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcBody
    } catch {
      this.config.appendAudit({ time: Date.now(), type: 'remote.rpc-skip', detail: 'invalid json' })
      this.json(res, 400, { error: 'invalid json' })
      return
    }
    if (typeof body.method !== 'string' || body.payload === undefined || body.payload === null) {
      this.config.appendAudit({ time: Date.now(), type: 'remote.rpc-skip', detail: 'missing method/payload' })
      this.json(res, 400, { error: 'method and payload required' })
      return
    }
    if (!ALLOWED_METHODS.has(body.method)) {
      this.config.appendAudit({ time: Date.now(), type: 'remote.rpc-skip', detail: `method not allowed: ${body.method}` })
      this.json(res, 403, { error: `method not allowed: ${body.method}` })
      return
    }
    // 会话 cwd 只能落在工作区或预设根内(预设根本身可直接作为工作区)。
    if (body.method === 'session.create') {
      const payload = body.payload as { cwd?: unknown }
      if (typeof payload.cwd === 'string' && payload.cwd.trim() !== '' && !(await this.fsAllowed(payload.cwd))) {
        this.config.appendAudit({ time: Date.now(), type: 'remote.rpc-skip', detail: 'cwd not allowed' })
        this.json(res, 403, { error: 'cwd not allowed: 仅限工作区或预设根目录' })
        return
      }
    }
    // 恢复归档会话:harness 无 unarchive RPC,由本机落盘注册表实现(见 unarchiveSession)。
    if (body.method === 'workspace.unarchiveSession') {
      const payload = body.payload as { sessionId?: unknown }
      if (typeof payload?.sessionId !== 'string' || !/^session-/.test(payload.sessionId)) {
        this.json(res, 400, { error: 'sessionId required (session-xxxx)' })
        return
      }
      try {
        const value = await this.unarchiveSession(payload.sessionId)
        this.config.appendAudit({ time: Date.now(), type: 'remote.rpc', detail: `恢复归档会话:${payload.sessionId}` })
        this.json(res, 200, { ok: true, value })
      } catch (error) {
        this.config.appendAudit({ time: Date.now(), type: 'remote.rpc-fail', detail: `workspace.unarchiveSession: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) })
        this.json(res, 200, { ok: false, error: { code: 'unarchive_failed', message: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    const timeoutMs = SLOW_METHODS.has(body.method) ? 120000 : 30000
    try {
      const value = await this.harness.client().rpc(body.method, body.payload, timeoutMs)
      this.json(res, 200, { ok: true, value })
    } catch (error) {
      this.config.appendAudit({ time: Date.now(), type: 'remote.rpc-fail', detail: `${body.method}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) })
      this.json(res, 200, {
        ok: false,
        error: { code: (error as { code?: string }).code ?? 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /** Webhook 命令端点:POST { text } → 统一命令处理器 → 返回 { reply }。 */
  private async handleCommand(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    this.auditRemote(req, 'command')
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
      if (Buffer.concat(chunks).byteLength > 256 * 1024) {
        this.json(res, 413, { error: 'payload too large' })
        return
      }
    }
    let body: { text?: unknown }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: unknown }
    } catch {
      this.json(res, 400, { error: 'invalid json' })
      return
    }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      this.json(res, 400, { error: 'text required (JSON body: {"text": "状态"})' })
      return
    }
    if (this.commands === undefined) {
      this.json(res, 500, { error: 'command processor unavailable' })
      return
    }
    try {
      const reply = await this.commands.handleText('webhook', 'client', body.text)
      this.json(res, 200, { ok: true, reply })
    } catch (error) {
      this.json(res, 200, {
        ok: false,
        error: { code: (error as { code?: string }).code ?? 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /** 审批/提问应答端点:把 client-response 原样转发给 harness /api/respond。 */
  private async handleRespond(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    this.auditRemote(req, 'respond')
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
      if (Buffer.concat(chunks).byteLength > 256 * 1024) {
        this.json(res, 413, { error: 'payload too large' })
        return
      }
    }
    const body = Buffer.concat(chunks)
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      this.json(res, 400, { error: 'invalid json' })
      return
    }
    const record = parsed as { type?: unknown; rpcId?: unknown; result?: unknown }
    if (record.type !== 'client-response' || typeof record.rpcId !== 'string' || record.result === undefined) {
      this.json(res, 400, { error: 'client-response with rpcId and result required' })
      return
    }
    try {
      const response = await fetch(`${this.harness.baseUrl()}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
        signal: AbortSignal.timeout(15000),
      })
      const text = await response.text()
      this.json(res, response.status, text === '' ? {} : JSON.parse(text))
    } catch (error) {
      this.json(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 手机端可执行的控制动作(白名单,与 RPC 白名单同样受 token 保护)。 */
  private async handleAction(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    this.auditRemote(req, 'action')
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    let body: { action?: unknown }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action?: unknown }
    } catch {
      this.json(res, 400, { error: 'invalid json' })
      return
    }
    if (body.action === 'harness.restart') {
      this.json(res, 403, { error: '此危险操作必须在桌面端确认' })
      return
    }
    if (body.action === 'workspace.subdirs') {
      this.json(res, 200, { ok: true, roots: this.listPresetSubdirs() })
      return
    }
    if (body.action === 'workspace.health') {
      await this.serveWorkspaceHealth(res)
      return
    }
    if (body.action === 'workspace.changes') {
      await this.serveWorkspaceChanges(res, body as { path?: unknown; diff?: unknown })
      return
    }
    if (body.action === 'fs.list') {
      await this.serveFsList(res, body as { path?: unknown })
      return
    }
    if (body.action === 'fs.read') {
      await this.serveFsRead(res, body as { path?: unknown })
      return
    }
    if (body.action === 'fs.addRoot') {
      await this.serveFsAddRoot(res, body as { path?: unknown })
      return
    }
    if (body.action === 'fs.removeRoot') {
      this.json(res, 403, { error: '移除预设根目录必须在桌面端确认' })
      return
    }
    if (body.action === 'workspace.createNew') {
      await this.createPresetWorkspace(res, body as { action?: string; root?: unknown; name?: unknown })
      return
    }
    if (body.action === 'appearance.setPhoneWallpaper') {
      const path = typeof (body as { path?: unknown }).path === 'string' ? (body as { path: string }).path : ''
      if (path === '' || !this.wallpaperEntries().some((w) => w.path === path)) {
        this.json(res, 403, { error: 'wallpaper path not allowed' })
        return
      }
      this.config.update('appearance', { phone: { path, position: { x: 0.5, y: 0.5 } } })
      this.json(res, 200, { ok: true })
      return
    }
    if (body.action === 'appearance.uploadPhoneWallpaper') {
      await this.uploadPhoneWallpaper(res, body as { data?: unknown })
      return
    }
    if (body.action === 'appearance.clearPhoneWallpaper') {
      this.config.update('appearance', { phone: { path: null, position: { x: 0.5, y: 0.5 } } })
      this.json(res, 200, { ok: true })
      return
    }
    if (body.action === 'sched.add') {
      const expr = typeof (body as { expr?: unknown }).expr === 'string' ? (body as { expr: string }).expr.trim() : ''
      const description = typeof (body as { description?: unknown }).description === 'string' ? (body as { description: string }).description.trim() : ''
      const delay = parseSchedDelay(expr)
      if (delay === null || description === '') {
        this.json(res, 400, { error: 'expr or description invalid(如:10分钟 / 每天9:00)' })
        return
      }
      const result = this.commands?.addScheduled('pwa', 'desktop', delay, description)
      this.json(res, 200, { ok: true, message: result })
      return
    }
    if (body.action === 'sched.remove') {
      const index = typeof (body as { index?: unknown }).index === 'number' ? (body as { index: number }).index : -1
      const ok = this.commands?.removeScheduled(index) === true
      this.json(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'invalid index' })
      return
    }
    if (body.action === 'session.export') {
      const sessionId = typeof (body as { sessionId?: unknown }).sessionId === 'string' ? (body as { sessionId: string }).sessionId : ''
      if (sessionId === '') {
        this.json(res, 400, { error: 'sessionId required' })
        return
      }
      try {
        const result = await this.commands?.exportSession(sessionId)
        this.json(res, 200, { ok: true, ...result })
      } catch (error) {
        this.json(res, 502, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (body.action === 'usage.get') {
      try {
        const report = await this.commands?.usageReport()
        this.json(res, 200, { ok: true, report })
      } catch (error) {
        this.json(res, 502, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (body.action === 'interactions.get') {
      this.json(res, 200, { ok: true, items: this.commands?.pendingInteractions() ?? [] })
      return
    }
    if (body.action === 'interactions.respondApproval') {
      const b = body as { sessionId?: unknown; approvalId?: unknown; outcome?: unknown }
      const result = await this.commands?.respondApprovalDesktop(String(b.sessionId ?? ''), String(b.approvalId ?? ''), b.outcome === 'rejected' ? 'rejected' : 'allowed-once')
      this.json(res, 200, { ok: true, result })
      return
    }
    if (body.action === 'interactions.respondQuestion') {
      const b = body as { sessionId?: unknown; questionId?: unknown; optionIndex?: unknown }
      const result = await this.commands?.respondQuestionDesktop(String(b.sessionId ?? ''), String(b.questionId ?? ''), Number(b.optionIndex))
      this.json(res, 200, { ok: true, result })
      return
    }
    if (body.action === 'tasks.get') {
      this.json(res, 200, { ok: true, items: this.config.get().taskHistory ?? [] })
      return
    }
    if (body.action === 'queue.get') {
      this.json(res, 200, { ok: true, items: this.commands?.queueList() ?? [] })
      return
    }
    if (body.action === 'activity.get') {
      this.json(res, 200, { ok: true, items: this.config.activities() })
      return
    }
    if (body.action === 'audit.get') {
      this.json(res, 200, { ok: true, items: this.config.auditList() })
      return
    }
    if (body.action === 'memory.getAll') {
      this.json(res, 200, { ok: true, items: this.config.get().workspaceMemories ?? {} })
      return
    }
    if (body.action === 'diagnostics.get') {
      const config = this.config.get().remote
      this.json(res, 200, { ok: true, report: { schemaVersion: 1, harness: this.harness.status(), gateway: { enabled: config.enabled, port: config.port, addresses: this.lanAddresses() }, pendingInteractions: this.commands?.pendingInteractions().length ?? 0 } })
      return
    }
    this.json(res, 403, { error: `action not allowed: ${String(body.action)}` })
  }

  /** 定时任务列表(PWA 查看)。 */
  private serveTaskList(url: URL, req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    this.json(res, 200, { ok: true, items: this.commands?.listScheduled() ?? [] })
  }

  /** 预设根目录及其直接子目录(手机端"新建工作区"的可选路径)。 */
  private listPresetSubdirs(): Array<{ root: string; dirs: Array<{ path: string; name: string }> }> {
    const roots = this.presetRoots()
    const result: Array<{ root: string; dirs: Array<{ path: string; name: string }> }> = []
    for (const root of roots) {
      const dirs: Array<{ path: string; name: string }> = []
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          dirs.push({ path: join(root, entry.name), name: entry.name })
        }
      } catch {
        // 根目录不存在/不可读:忽略该根。
      }
      result.push({ root, dirs })
    }
    return result
  }

  /** 规范化后的预设根目录列表。 */
  private presetRoots(): string[] {
    const list = this.config.get().remote.presetWorkspaceRoots ?? []
    const seen = new Set<string>()
    const roots: string[] = []
    for (const raw of list) {
      const normalized = resolve(raw.trim())
      if (normalized === '' || seen.has(normalized)) continue
      seen.add(normalized)
      roots.push(normalized)
    }
    return roots
  }

  // ---- 手机端文件夹浏览与预设根管理(只读白名单:工作区路径 + 预设根) ----

  /** 目标路径是否在某个工作区路径或预设根目录之下。 */
  private async fsAllowed(target: string): Promise<boolean> {
    if (target === '') return false
    const normalized = resolve(target)
    let roots = this.presetRoots()
    try {
      const client = this.harness.client()
      const ws = await client.rpc<{ items: Array<{ path?: string }> }>('workspace.list', {}, 20000)
      roots = [...(ws.items ?? []).map((w) => w.path).filter((p): p is string => typeof p === 'string'), ...roots]
    } catch {
      // workspace.list 失败时仍允许预设根下的路径。
    }
    for (const root of roots) {
      const r = resolve(root)
      if (normalized === r || normalized.startsWith(r + sep)) return true
    }
    return false
  }

  /** 可浏览的根:工作区路径 + 预设根(去重,标记是否预设根)。 */
  private async fsRoots(): Promise<Array<{ path: string; name: string; isPreset: boolean }>> {
    const seen = new Set<string>()
    const roots: Array<{ path: string; name: string; isPreset: boolean }> = []
    const preset = new Set(this.presetRoots())
    try {
      const client = this.harness.client()
      const ws = await client.rpc<{ items: Array<{ path?: string }> }>('workspace.list', {}, 20000)
      for (const w of ws.items ?? []) {
        if (typeof w.path !== 'string') continue
        const r = resolve(w.path)
        if (seen.has(r)) continue
        seen.add(r)
        roots.push({ path: r, name: basename(r), isPreset: preset.has(r) })
      }
    } catch {
      // workspace.list 失败:仍列出预设根。
    }
    for (const raw of this.presetRoots()) {
      if (seen.has(raw)) continue
      seen.add(raw)
      roots.push({ path: raw, name: basename(raw), isPreset: true })
    }
    return roots
  }

  /** 列出目录内容(单层;目录在前,文件带大小,最多 200 项)。 */
  /** 读取工作区 Git 变更摘要与受限 diff(只读)。 */
  async changesReport(path: string, diff = false): Promise<Record<string, unknown>> {
    if (!(await this.fsAllowed(path))) throw new Error('path not allowed')
    const args = diff ? ['-C', path, 'diff', '--no-ext-diff', '--stat', '--', '.'] : ['-C', path, 'status', '--short']
    const summary = execFileSync('git', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true })
    if (!diff) return { path, status: summary.slice(0, 16000) }
    const text = execFileSync('git', ['-C', path, 'diff', '--no-ext-diff', '--', '.'], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true })
    return { path, summary: summary.slice(0, 16000), diff: text.slice(0, 64 * 1024), truncated: text.length > 64 * 1024 }
  }

  /** 工作区健康报告(桌面端与 PWA 共用)。 */
  async healthReport(): Promise<Array<{ workspaceId: string | null; title: string; path: string; exists: boolean; readable: boolean; writable: boolean; freeBytes: number | null; sessions: number | null }>> {
    const workspaces = await this.harness.client().rpc<{ items: Array<{ workspaceId?: string; title?: string; path?: string; sessions?: unknown[] }> }>('workspace.list', {}, 20000)
    return (workspaces.items ?? []).map((workspace) => {
      const path = workspace.path ?? ''
      let exists = false
      let readable = false
      let writable = false
      let freeBytes: number | null = null
      try {
        exists = path !== '' && existsSync(path)
        if (exists) {
          accessSync(path, constants.R_OK)
          readable = true
          accessSync(path, constants.W_OK)
          writable = true
          const fs = statfsSync(path)
          freeBytes = fs.bavail * fs.bsize
        }
      } catch {
        // 权限或磁盘信息不可用时保留明确的 false/null 状态。
      }
      return { workspaceId: workspace.workspaceId ?? null, title: workspace.title ?? path, path, exists, readable, writable, freeBytes, sessions: Array.isArray(workspace.sessions) ? workspace.sessions.length : null }
    })
  }

  private async serveWorkspaceChanges(res: ServerResponse, body: { path?: unknown; diff?: unknown }): Promise<void> {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (!(await this.fsAllowed(path))) {
      this.json(res, 403, { error: 'path not allowed' })
      return
    }
    try {
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        this.json(res, 400, { error: 'not a directory' })
        return
      }
      const args = body.diff === true ? ['-C', path, 'diff', '--no-ext-diff', '--stat', '--', '.'] : ['-C', path, 'status', '--short']
      const text = execFileSync('git', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true })
      if (body.diff === true) {
        const diff = execFileSync('git', ['-C', path, 'diff', '--no-ext-diff', '--', '.'], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true })
        this.json(res, 200, { ok: true, path, summary: text.slice(0, 16000), diff: diff.slice(0, 64 * 1024), truncated: diff.length > 64 * 1024 })
      } else {
        this.json(res, 200, { ok: true, path, status: text.slice(0, 16000) })
      }
    } catch (error) {
      this.json(res, 200, { ok: true, path, status: '', unavailable: true, message: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) })
    }
  }

  private async serveWorkspaceHealth(res: ServerResponse): Promise<void> {
    try {
      this.json(res, 200, { ok: true, items: await this.healthReport() })
    } catch (error) {
      this.json(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async serveFsList(res: ServerResponse, body: { path?: unknown }): Promise<void> {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (path === '') {
      this.json(res, 200, { ok: true, path: '', roots: await this.fsRoots() })
      return
    }
    if (!(await this.fsAllowed(path))) {
      this.json(res, 403, { error: 'path not allowed' })
      return
    }
    if (!existsSync(path)) {
      this.json(res, 404, { error: '目录不存在' })
      return
    }
    try {
      if (!statSync(path).isDirectory()) {
        this.json(res, 400, { error: 'not a directory' })
        return
      }
      const entries = readdirSync(path, { withFileTypes: true })
      const list: Array<{ name: string; path: string; isDir: boolean; size: number }> = []
      for (const entry of entries) {
        const full = join(path, entry.name)
        if (entry.isDirectory()) {
          list.push({ name: entry.name, path: full, isDir: true, size: 0 })
        } else if (entry.isFile()) {
          let size = 0
          try { size = statSync(full).size } catch { size = 0 }
          list.push({ name: entry.name, path: full, isDir: false, size })
        }
      }
      list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
      const parent = dirname(path)
      const parentAllowed = parent !== path && (await this.fsAllowed(parent))
      this.json(res, 200, {
        ok: true,
        path,
        parent: parentAllowed ? parent : '',
        entries: list.slice(0, 200),
        truncated: list.length > 200,
      })
    } catch (error) {
      this.json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 读取文件用于预览:文本支持 offset/length 分片(单次 ≤64KB);图片返回 data URL(≤2MB)。 */
  private async serveFsRead(res: ServerResponse, body: { path?: unknown; offset?: unknown; length?: unknown }): Promise<void> {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    const offset = typeof body.offset === 'number' && Number.isFinite(body.offset) && body.offset >= 0 ? Math.floor(body.offset) : 0
    const length = typeof body.length === 'number' && Number.isFinite(body.length) && body.length > 0 ? Math.min(Math.floor(body.length), 64 * 1024) : 64 * 1024
    if (!(await this.fsAllowed(path))) {
      this.json(res, 403, { error: 'path not allowed' })
      return
    }
    if (!existsSync(path)) {
      this.json(res, 404, { error: '文件不存在' })
      return
    }
    try {
      if (!statSync(path).isFile()) {
        this.json(res, 400, { error: 'not a file' })
        return
      }
      const size = statSync(path).size
      const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(extname(path).toLowerCase())
      if (isImage) {
        if (size > 2 * 1024 * 1024) {
          this.json(res, 400, { error: `图片过大(${Math.round(size / 1024)}KB),仅支持 2MB 以内预览` })
          return
        }
        const data = readFileSync(path)
        const mime = extname(path).toLowerCase() === '.jpg' ? 'jpeg' : extname(path).toLowerCase().slice(1)
        this.json(res, 200, { ok: true, path, name: basename(path), size, image: true, dataUrl: `data:image/${mime};base64,${data.toString('base64')}` })
        return
      }
      // 文本:按字节分片,避免超大文件一次性读入。
      const buffer = readFileSync(path)
      const chunk = buffer.subarray(offset, offset + length)
      const nextOffset = offset + chunk.length
      this.json(res, 200, {
        ok: true,
        path,
        name: basename(path),
        size,
        offset,
        length: chunk.length,
        text: chunk.toString('utf8'),
        truncated: nextOffset < size,
        nextOffset: nextOffset < size ? nextOffset : null,
      })
    } catch (error) {
      this.json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Stream a whitelisted file with byte ranges for browser-native media/PDF viewers. */
  private async serveFsStream(url: URL, req: IncomingMessage, res: ServerResponse, body?: { path?: unknown }): Promise<void> {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    const raw = typeof body?.path === 'string' ? body.path : url.searchParams.get('path')
    const path = typeof raw === 'string' ? raw.trim() : ''
    if (!(await this.fsAllowed(path))) {
      this.json(res, 403, { error: 'path not allowed' })
      return
    }
    let size: number
    try {
      const info = statSync(path)
      if (!info.isFile()) {
        this.json(res, 400, { error: 'not a file' })
        return
      }
      size = info.size
    } catch {
      this.json(res, 404, { error: 'file not found' })
      return
    }
    const mimeByExt: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    }
    const contentType = mimeByExt[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const range = req.headers.range
    let start = 0
    let end = Math.max(0, size - 1)
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (match === null || size === 0) {
        res.writeHead(416, { 'content-range': `bytes */${size}` })
        res.end()
        return
      }
      if (match[1] !== '') start = Number(match[1])
      if (match[2] !== '') end = Number(match[2])
      else end = Math.min(size - 1, start + 1024 * 1024 - 1)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` })
        res.end()
        return
      }
      end = Math.min(end, size - 1)
    }
    const length = size === 0 ? 0 : end - start + 1
    res.writeHead(range === undefined ? 200 : 206, {
      'content-type': contentType,
      'content-length': length,
      'accept-ranges': 'bytes',
      ...(range === undefined ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }),
      'cache-control': 'no-store',
    })
    if (size === 0) {
      res.end()
      return
    }
    createReadStream(path, { start, end }).on('error', () => {
      if (!res.headersSent) res.writeHead(500)
      res.destroy()
    }).pipe(res)
  }

  /** 把目录添加为预设工作区根(仅限可浏览目录;去重)。 */
  private async serveFsAddRoot(res: ServerResponse, body: { path?: unknown }): Promise<void> {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (!(await this.fsAllowed(path))) {
      this.json(res, 403, { error: 'path not allowed' })
      return
    }
    try {
      if (!statSync(path).isDirectory()) {
        this.json(res, 400, { error: 'not a directory' })
        return
      }
    } catch {
      this.json(res, 403, { error: 'path not allowed' })
      return
    }
    const current = this.config.get().remote.presetWorkspaceRoots ?? []
    const normalized = resolve(path)
    if (!current.some((p) => resolve(p) === normalized)) {
      this.config.update('remote', { presetWorkspaceRoots: [...current, normalized] })
    }
    const roots = (this.config.get().remote.presetWorkspaceRoots ?? [])
      .filter((p): p is string => typeof p === 'string')
      .map((p) => resolve(p))
    this.json(res, 200, { ok: true, roots })
  }

  /**
   * 在预设根目录下新建文件夹工作区(远程端仅允许此路径;防越权校验):
   * root 必须是预设根目录之一,name 不能含路径分隔符/.. /以点开头。
   */
  private async createPresetWorkspace(
    res: ServerResponse,
    body: { action?: string; root?: unknown; name?: unknown },
  ): Promise<void> {
    const root = typeof body.root === 'string' ? body.root.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (root === '' || name === '') {
      this.json(res, 400, { error: 'root and name required' })
      return
    }
    const normalizedRoot = resolve(root)
    if (!this.presetRoots().includes(normalizedRoot)) {
      this.json(res, 403, { error: 'root is not in preset workspace roots' })
      return
    }
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.startsWith('.')) {
      this.json(res, 400, { error: 'invalid folder name' })
      return
    }
    const target = resolve(join(normalizedRoot, name))
    // 双重校验:解析后的目标必须仍在预设根目录之下。
    if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
      this.json(res, 403, { error: 'path escapes preset root' })
      return
    }
    try {
      mkdirSync(target, { recursive: true })
    } catch (error) {
      this.json(res, 500, { error: `mkdir failed: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const client = this.harness.client()
    try {
      const created = await client.rpc<{ workspaceId: string }>('workspace.create', { path: target }, 30000)
      this.json(res, 200, { ok: true, workspaceId: created.workspaceId, path: target })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 目录已建但注册失败:保留目录,报错由前端提示。
      this.json(res, 502, { error: `workspace.create failed: ${message}` })
    }
  }

  /** 可用的手机壁纸列表(内置包 + 用户本地包 + 自定义壁纸;带缩略图,供 PWA 选择)。 */
  private serveWallpaperList(url: URL, req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    const entries = this.wallpaperEntries()
    const current = this.config.get().appearance.phone.path
    const currentBase = current !== null ? basename(current) : ''
    // 桌面端「应用壁纸包」会把副本存为 pack-<id>-phone.png,与列表项路径不同,按包名匹配高亮。
    const appliedPack = /^pack-(.+)-(?:phone|window)\.[^.]+$/.exec(currentBase)
    const items = [
      { id: 'default', name: '默认壁纸', path: '', thumb: '', active: current === null },
      ...entries.map((entry) => {
        let thumb = ''
        try {
          const image = nativeImage.createFromPath(entry.path)
          if (!image.isEmpty()) thumb = image.resize({ width: 240 }).toDataURL()
        } catch {
          // 缩略图生成失败:忽略该项的 thumb,前端仍可展示名称。
        }
        const active = entry.path === current ||
          (appliedPack !== null && entry.id === appliedPack[1])
        return { id: entry.id, name: entry.name, path: entry.path, thumb, active }
      }),
    ]
    this.json(res, 200, { ok: true, items })
  }

  /**
   * 扫描壁纸:内置包(assets/wallpapers)+ 用户本地包(userData/wallpapers 下 pack-* 子目录)
   * + 自定义壁纸(userData/wallpapers 根目录的 phone-、window- 前缀图片,桌面端保存的成品)。
   */
  private wallpaperEntries(): Array<{ id: string; name: string; path: string }> {
    const entries: Array<{ id: string; name: string; path: string }> = []
    const collect = (root: string, isUserPack: boolean): void => {
      if (!existsSync(root)) return
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        try {
          if (!statSync(dir).isDirectory()) continue
        } catch {
          continue
        }
        if (isUserPack && !name.startsWith('pack-')) continue
        const phone = join(dir, 'phone.png')
        const window_ = join(dir, 'window.png')
        const file = existsSync(phone) ? phone : existsSync(window_) ? window_ : null
        if (file !== null) entries.push({ id: name, name, path: file })
      }
    }
    collect(join(app.getAppPath(), 'assets', 'wallpapers'), false)
    collect(join(app.getPath('userData'), 'wallpapers'), true)
    // 自定义壁纸(桌面端「外观」保存的成品,位于 wallpapers 根目录)。
    const userRoot = join(app.getPath('userData'), 'wallpapers')
    if (existsSync(userRoot)) {
      for (const name of readdirSync(userRoot)) {
        const file = join(userRoot, name)
        try {
          if (!statSync(file).isFile()) continue
        } catch {
          continue
        }
        if (/^(phone|window)-.+\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(name)) {
          entries.push({ id: `custom-${name}`, name: `自定义·${name}`, path: file })
        }
      }
    }
    return entries
  }

  /**
   * Upload a phone wallpaper picked from the device's own photo library.
   * The body carries a base64 data URL; size and image magic are validated,
   * the decoded bytes are saved under the userData wallpapers folder as a
   * `phone-<ts>.<ext>` file, and it becomes the active phone wallpaper.
   */
  private async uploadPhoneWallpaper(res: ServerResponse, body: { data?: unknown }): Promise<void> {
    if (typeof body.data !== 'string' || body.data === '') {
      this.json(res, 400, { error: 'data URL required' })
      return
    }
    const match = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/=]+)$/.exec(body.data)
    if (match === null) {
      this.json(res, 400, { error: 'unsupported image format (png/jpeg/webp/gif/bmp)' })
      return
    }
    const ext: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/bmp': 'bmp',
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(match[2]!, 'base64')
    } catch {
      this.json(res, 400, { error: 'invalid base64 payload' })
      return
    }
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) {
      this.json(res, 400, { error: 'image size must be between 1 byte and 12 MB' })
      return
    }
    // Magic-byte guard so a non-image payload cannot be persisted as wallpaper.
    const sig = bytes.subarray(0, 8)
    const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47
    const isJpeg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff
    const isGif = sig[0] === 0x47 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x38
    const isWebp = sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46
    const isBmp = sig[0] === 0x42 && sig[1] === 0x4d
    if (!isPng && !isJpeg && !isGif && !isWebp && !isBmp) {
      this.json(res, 400, { error: 'payload is not a recognized image' })
      return
    }
    const userRoot = join(app.getPath('userData'), 'wallpapers')
    mkdirSync(userRoot, { recursive: true })
    const file = join(userRoot, `phone-${Date.now()}.${ext[match[1]!] ?? 'png'}`)
    writeFileSync(file, bytes)
    this.config.update('appearance', { phone: { path: file, position: { x: 0.5, y: 0.5 } } })
    this.config.appendAudit({ time: Date.now(), type: 'remote.wallpaper-upload', detail: '手机端上传了自定义壁纸' })
    this.json(res, 200, { ok: true, path: file })
  }

  /** 手机 PWA 背景壁纸:与桌面端主窗口壁纸保持一致。 */
  private serveWallpaper(res: ServerResponse): void {
    const appearance = this.config.get().appearance
    const file = appearance.phone.path ?? appearance.window.path
    if (file === null || !existsSync(file)) {
      this.json(res, 404, { error: 'no wallpaper' })
      return
    }
    const types: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    }
    const ext = extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': types[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(readFileSync(file))
  }

  private serveEvents(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const ticket = url.searchParams.get('ticket')
    const session = ticket === null ? undefined : this.sseTickets.get(ticket)
    if (session === undefined || Date.now() >= session.expiresAt) {
      this.json(res, 401, { error: 'invalid or expired event ticket' })
      return
    }
    this.sseTickets.delete(ticket as string)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const unsubscribe = this.events.subscribe((frame) => {
      if (res.destroyed) return
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
    })
    req.on('close', () => {
      unsubscribe()
    })
    req.on('error', () => {
      unsubscribe()
    })
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }
}

/**
 * 过滤不适合手机局域网访问的地址:
 * - 198.18.0.0/15:代理软件(Clash/sing-box 等)fake-ip 保留段,只存在于本机 TUN 隧道,手机无法路由;
 * - 169.254.x.x:链路本地;
 * - 虚拟网卡(WSL/Hyper-V/Docker/VMware/VirtualBox/TUN 等)的接口名。
 */
function trustedLanClient(address: string): boolean {
  const value = address.replace(/^::ffff:/i, '')
  if (value === '127.0.0.1' || value === '::1') return true
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
}

function usableLanAddress(address: string, interfaceName: string): boolean {
  if (/virtual|vethernet|wsl|hyper-v|docker|vmware|virtualbox|loopback|bluetooth|tun|tap|utun|ppp|meta/i.test(interfaceName)) {
    return false
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4) return false
  const first = parts[0]
  if (first === 169) return false // 169.254 链路本地
  if (first === 198 && (parts[1] === 18 || parts[1] === 19)) return false // 代理 fake-ip
  return true
}
