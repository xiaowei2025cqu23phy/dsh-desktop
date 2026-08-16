/**
 * 局域网远程网关:手机 PWA 通过它访问 harness。
 *
 * - Bearer token 认证(首次生成,设置面板显示 + 二维码配对)。
 * - POST /api/rpc:白名单 RPC 转发到本机 harness。
 * - GET /api/events:SSE 事件流(共享 EventHub 广播,断线重连)。
 * - GET /:伺服手机 PWA 静态页面。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ConfigStore } from './config'
import type { EventHub } from './event-hub'
import type { HarnessManager } from './harness'

export interface RemoteConfig {
  enabled: boolean
  port: number
  token: string
}

export const REMOTE_DEFAULTS: RemoteConfig = {
  enabled: false,
  port: 3082,
  token: '',
}

/** 手机端允许调用的 RPC 白名单(纵深防御:token 之外的访问边界)。 */
const ALLOWED_METHODS = new Set([
  'session.list',
  'session.history',
  'session.create',
  'session.prompt',
  'session.cancel',
  'session.rename',
  'session.selectModel',
  'session.models',
  'workspace.list',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.archiveSession',
  'llm.models',
  'llm.providers',
  'host.describe',
])

/** 容易超时的操作放宽超时。 */
const SLOW_METHODS = new Set(['session.prompt', 'session.history', 'session.list'])

interface RpcBody {
  method?: unknown
  payload?: unknown
}

export class RemoteGateway {
  private server: ReturnType<typeof createServer> | null = null
  private remoteDir: string

  constructor(
    private config: ConfigStore,
    private harness: HarnessManager,
    private events: EventHub,
  ) {
    this.remoteDir = join(__dirname, '..', 'remote')
  }

  getConfig(): RemoteConfig {
    const config = this.config.get().remote
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
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
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
    return `http://${host}:${config.port}/?token=${config.token}`
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

  start(): void {
    if (this.server !== null) return
    const config = this.getConfig()
    if (!config.enabled) return
    const server = createServer((req, res) => void this.handle(req, res))
    server.on('error', (error) => {
      console.error('[gateway] 监听失败:', error.message)
    })
    server.listen(config.port, '0.0.0.0', () => {
      console.log(`[gateway] 远程网关已启动,端口 ${config.port}`)
    })
    this.server = server
  }

  stop(): void {
    this.server?.close()
    this.server = null
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
      if (req.method === 'GET' && path === '/api/events') {
        this.serveEvents(url, req, res)
        return
      }
      if (req.method === 'POST' && path === '/api/rpc') {
        await this.handleRpc(url, req, res)
        return
      }
      if (req.method === 'GET' && path === '/api/info') {
        this.json(res, 200, { name: 'dsh-desktop-remote', version: '0.1.0' })
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

  private authorized(url: URL, req: IncomingMessage): boolean {
    const token = this.authToken(url, req)
    if (token === null) return false
    const expected = this.getConfig().token
    return expected !== '' && token === expected
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

  private async handleRpc(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
      if (Buffer.concat(chunks).byteLength > 1024 * 1024) {
        this.json(res, 413, { error: 'payload too large' })
        return
      }
    }
    let body: RpcBody
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcBody
    } catch {
      this.json(res, 400, { error: 'invalid json' })
      return
    }
    if (typeof body.method !== 'string' || body.payload === undefined || body.payload === null) {
      this.json(res, 400, { error: 'method and payload required' })
      return
    }
    if (!ALLOWED_METHODS.has(body.method)) {
      this.json(res, 403, { error: `method not allowed: ${body.method}` })
      return
    }
    const timeoutMs = SLOW_METHODS.has(body.method) ? 120000 : 30000
    try {
      const value = await this.harness.client().rpc(body.method, body.payload, timeoutMs)
      this.json(res, 200, { ok: true, value })
    } catch (error) {
      this.json(res, 200, {
        ok: false,
        error: { code: (error as { code?: string }).code ?? 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private serveEvents(url: URL, req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
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
