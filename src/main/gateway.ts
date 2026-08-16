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
import { networkInterfaces } from 'node:os'
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve, sep, basename } from 'node:path'
import { app, nativeImage } from 'electron'
import type { ConfigStore } from './config'
import type { EventHub } from './event-hub'
import type { HarnessManager } from './harness'
import type { RemoteCommandProcessor } from './remote-commands'

export interface RemoteConfig {
  enabled: boolean
  port: number
  token: string
  presetWorkspaceRoots: string[]
}

export const REMOTE_DEFAULTS: RemoteConfig = {
  enabled: false,
  port: 3082,
  token: '',
  presetWorkspaceRoots: [],
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
    private commands?: RemoteCommandProcessor,
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
      if (req.method === 'GET' && path === '/wallpaper') {
        this.serveWallpaper(res)
        return
      }
      if (req.method === 'GET' && path === '/api/wallpapers') {
        this.serveWallpaperList(url, req, res)
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
      if (req.method === 'POST' && path === '/api/action') {
        await this.handleAction(url, req, res)
        return
      }
      if (req.method === 'GET' && path === '/api/info') {
        const appearance = this.config.get().appearance
        const spec = appearance.phone.path !== null ? appearance.phone : appearance.window
        this.json(res, 200, {
          name: 'dsh-desktop-remote',
          version: '0.1.0',
          wallpaperPosition: spec.position,
        })
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

  /** Webhook 命令端点:POST { text } → 统一命令处理器 → 返回 { reply }。 */
  private async handleCommand(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(url, req)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
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
      await this.harness.restart()
      this.json(res, 200, { ok: true })
      return
    }
    if (body.action === 'workspace.subdirs') {
      this.json(res, 200, { ok: true, roots: this.listPresetSubdirs() })
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
    if (body.action === 'appearance.clearPhoneWallpaper') {
      this.config.update('appearance', { phone: { path: null, position: { x: 0.5, y: 0.5 } } })
      this.json(res, 200, { ok: true })
      return
    }
    this.json(res, 403, { error: `action not allowed: ${String(body.action)}` })
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

/**
 * 过滤不适合手机局域网访问的地址:
 * - 198.18.0.0/15:代理软件(Clash/sing-box 等)fake-ip 保留段,只存在于本机 TUN 隧道,手机无法路由;
 * - 169.254.x.x:链路本地;
 * - 虚拟网卡(WSL/Hyper-V/Docker/VMware/VirtualBox/TUN 等)的接口名。
 */
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
