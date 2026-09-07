/**
 * Harness 进程托管:探测已运行实例 → 必要时托管启动 `dsh web` → 健康轮询 → 崩溃重启。
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { HarnessClient } from './client'
import type { RpcProtocolBox } from './client'
import type { HarnessConfig } from './config'

export type HarnessState =
  | 'idle'        // 未开始
  | 'probing'     // 探测中
  | 'external'    // 连接到了外部已运行实例
  | 'running'     // 托管进程就绪
  | 'starting'    // 托管进程启动中
  | 'stopping'    // 正在停止
  | 'stopped'     // 已停止(手动)
  | 'error'       // 错误(端口被占、启动失败等)

export interface HarnessStatus {
  state: HarnessState
  baseUrl: string
  error: string | null
  managed: boolean
  pid: number | null
}

export class HarnessManager extends EventEmitter {
  state: HarnessState = 'idle'
  error: string | null = null
  managedPid: number | null = null

  private child: ReturnType<typeof spawn> | null = null
  /** 官方 0.1.2-rc.1+ 的进程级 launch token:启动输出 `?token=` URL 时提取,供 webview/RPC 鉴权。 */
  private launchTokenValue: string | null = null
  private stopRequested = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempts = 0
  readonly logs: string[] = []
  /** RPC 端点协议共享盒:一次协商,所有 client 实例(探测/网关/mux)共用。 */
  private readonly protocolBox: RpcProtocolBox = { value: null }

  constructor(private config: HarnessConfig) {
    super()
  }

  client(): HarnessClient {
    return new HarnessClient(this.baseUrl(), () => this.config.launchToken ?? this.launchTokenValue, this.protocolBox)
  }

  /** 官方 0.1.2-rc.1+ 鉴权缺失时的错误文案(设置里的「连接令牌」引导)。 */
  private authRequiredError(): string {
    return `端口 ${this.config.port} 上的 dsh 服务需要访问令牌(官方 0.1.2-rc.1+ 浏览器鉴权)。` +
      '请在该服务的启动输出中找到 `?token=` 值,粘贴到「设置 → Harness 服务 → 连接令牌」;或改用桌面端托管启动。'
  }

  /** 进程级访问 token(官方 0.1.2-rc.1+ 鉴权):配置的连接令牌优先,其次托管启动捕获值。 */
  getLaunchToken(): string | null {
    return this.config.launchToken ?? this.launchTokenValue
  }

  baseUrl(): string {
    if (this.config.mode === 'external') return this.config.url.replace(/\/+$/, '')
    return `http://127.0.0.1:${this.config.port}`
  }

  status(): HarnessStatus {
    return {
      state: this.state,
      baseUrl: this.baseUrl(),
      error: this.error,
      managed: this.config.mode !== 'external',
      pid: this.managedPid,
    }
  }

  updateConfig(next: HarnessConfig): void {
    const restart = next.port !== this.config.port || next.url !== this.config.url ||
      next.command !== this.config.command || next.mode !== this.config.mode ||
      next.dshHome !== this.config.dshHome || next.launchToken !== this.config.launchToken
    this.config = next
    if (restart) void this.restart()
  }

  /** 应用启动入口:按配置开始探测/托管。 */
  async start(): Promise<void> {
    this.stopRequested = false
    this.error = null
    if (this.config.mode === 'managed') {
      if (this.config.autoStart) this.spawnManaged()
      return
    }
    await this.probeAndAdopt()
  }

  /** 手动重启(托管模式重启进程;外部模式重新探测)。 */
  async restart(): Promise<void> {
    this.clearTimers()
    if (this.child !== null) {
      await this.killChild()
    }
    this.state = 'idle'
    this.error = null
    this.stopRequested = false
    await this.start()
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.clearTimers()
    if (this.child !== null) {
      await this.killChild()
    }
    this.state = 'stopped'
  }

  private recheckTimer: ReturnType<typeof setTimeout> | null = null
  /** recheck 里连续看到「dsh 页面但 RPC 未就绪」的次数(上限后按不可达处理)。 */
  private dshWaitCount = 0

  /**
   * 事件流断线时调用:重新探测 harness。外部实例已死时按 autoStart 托管拉起,
   * 让桌面端在用户关闭自己的 harness 终端后自动接管。带节流,避免频繁重试。
   */
  recheck(): void {
    if (this.recheckTimer !== null) return
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null
      if (this.stopRequested || this.state === 'stopped' || this.state === 'starting' || this.state === 'probing') return
      if (this.child !== null) return // 托管进程还活着,mux 重连即可。
      void (async () => {
        const client = this.client()
        const ok = await client.probe(12000)
        if (this.stopRequested) return
        if (ok) {
          this.dshWaitCount = 0
          return // 外部实例仍在(短暂断线),mux 会自动重连。
        }
        // 401 = 服务在线但需要 launch token:停止重试,直接给出引导。
        if (client.lastProbeFailure()?.code === 'http-401') {
          this.dshWaitCount = 0
          this.state = 'error'
          this.error = this.authRequiredError()
          this.emit('status', this.status())
          return
        }
        // 端口上还有 dsh 页面 = 外部实例正在重启(RPC 未就绪),等它自己恢复,不要抢占端口。
        const occupied = await this.portProbe()
        if (this.stopRequested) return
        if (occupied === 'dsh' && this.dshWaitCount < 10) {
          this.dshWaitCount += 1
          void this.recheck()
          return
        }
        this.dshWaitCount = 0
        console.log('[harness] 外部 harness 不可达,尝试托管接管…')
        if (this.config.mode === 'external') {
          this.state = 'error'
          this.error = `无法连接到 ${this.baseUrl()},请确认 harness 已启动`
          this.emit('status', this.status())
          return
        }
        if (this.config.autoStart) {
          this.spawnManaged()
        } else {
          this.state = 'idle'
          this.emit('status', this.status())
        }
      })()
    }, 1500)
  }

  private clearTimers(): void {
    if (this.probeTimer !== null) { clearTimeout(this.probeTimer); this.probeTimer = null }
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
  }

  /**
   * 探测已运行实例;无则按 autoStart 决定是否托管启动。
   *
   * 启动窗口:harness 的 HTTP 服务器先监听、RPC 处理器后注册,期间会
   * 「页面可访问但 RPC 探测失败」。遇到 dsh 页面时按 2s 间隔重试
   * (最多 30s),避免一次探测失败就永久报错。
   */
  private async probeAndAdopt(): Promise<void> {
    if (this.stopRequested || this.state === 'stopped') return
    this.state = 'probing'
    this.emit('status', this.status())
    const client = this.client()
    for (let attempt = 0; attempt < 15 && !this.stopRequested; attempt++) {
      const ok = await client.probe()
      if (this.stopRequested) return
      if (ok) {
        this.state = 'external'
        this.error = null
        this.emit('status', this.status())
        return
      }
      // 401 = 服务在线但需要 launch token:等多久都不会好,直接给出引导,
      // 而不是让用户对「30 秒未就绪」的笼统错误摸不着头脑。
      if (client.lastProbeFailure()?.code === 'http-401') {
        this.state = 'error'
        this.error = this.authRequiredError()
        this.emit('status', this.status())
        return
      }
      const occupied = await this.portProbe()
      if (this.stopRequested) return
      if (occupied === 'other') {
        this.state = 'error'
        this.error = `端口 ${this.config.port} 已被其他程序占用,且不是 dsh 服务。请在设置中更换端口。`
        this.emit('status', this.status())
        return
      }
      if (occupied === 'dsh') {
        // RPC 尚未就绪(启动窗口):继续等待。
        if (attempt >= 14) {
          this.state = 'error'
          this.error = `端口 ${this.config.port} 上检测到 dsh 服务,但 RPC 探测失败(30 秒未就绪)。请查看服务日志。`
          this.emit('status', this.status())
          return
        }
        await sleep(2000)
        continue
      }
      // 端口无服务:按配置托管启动或进入空闲。
      if (this.config.mode === 'external') {
        this.state = 'error'
        this.error = `无法连接到 ${this.baseUrl()},请确认 harness 已启动`
        this.emit('status', this.status())
        return
      }
      if (this.config.autoStart) {
        this.spawnManaged()
      } else {
        this.state = 'idle'
        this.emit('status', this.status())
      }
      return
    }
  }

  /** 端口上有无服务,以及是否为 dsh 页面。返回 'none' | 'dsh' | 'other'。 */
  private async portProbe(): Promise<'none' | 'dsh' | 'other'> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const response = await fetch(`http://127.0.0.1:${this.config.port}/`, { signal: controller.signal })
      clearTimeout(timer)
      const text = await response.text().catch(() => '')
      return text.includes('__DSH_BOOT__') || /deepseek|dsh/i.test(text.slice(0, 2000))
        ? 'dsh'
        : 'other'
    } catch {
      return 'none'
    }
  }

  /** 托管启动 dsh web。 */
  private spawnManaged(): void {
    if (this.child !== null || this.stopRequested) return
    this.state = 'starting'
    this.error = null
    this.launchTokenValue = null
    // npx 兜底:如果命令是默认的 `npx @deepseek-ai/dsh` 形态,且本机已有可用的
    // dsh(本地运行时/缓存),则直接 `node <bin>` 启动——这台机器上 npx 会在
    // 解析依赖树时永久卡住,绕开它能显著提升启动可靠性(其它机器不受影响)。
    let template = this.config.command.replace('{port}', String(this.config.port))
    const resolved = rewriteNpxToLocal(template)
    if (resolved !== null) {
      this.log(`检测到本地 dsh,改用直连启动:${resolved}`)
      template = resolved
    }
    this.log(`启动托管服务:${template}`)
    const { command, args } = splitCommand(template)
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (this.config.dshHome) env.DSH_HOME = this.config.dshHome
    // 工作目录:配置了用配置值,否则用主目录下的 dsh-workspace —— 避免 agent
    // 无工作区任务把产物写进应用安装目录(如 dsh-desktop 仓库)。
    const cwd = this.config.cwd && this.config.cwd.trim() !== '' ? this.config.cwd : join(homedir(), 'dsh-workspace')
    // 目录缺失会让 spawn 立刻 ENOENT(Node 不会替我们补建);先补建,
    // 否则预览/主实例一旦被清过用户目录就永远启动失败。
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
    // Windows 上 npx/pnpm/yarn 等是 .cmd/.bat 批处理,直接 spawn 会抛 ENOENT/EINVAL。
    // 用 shell 启动但传入「已安全转义的完整命令行」而不是 args 数组——既避免
    // Node 的 DEP0190 弃用告警(参数拼接),也保留对含空格路径/引号参数的正确处理。
    const isWindows = process.platform === 'win32'
    const cmdLine = [command, ...args].map((token) => quoteForShell(token)).join(' ')
    const child = isWindows
      ? spawn(cmdLine, [], { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      : spawn(command, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.managedPid = child.pid ?? null
    this.emit('status', this.status())

    child.stdout?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString(), false))
    child.stderr?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString(), true))
    child.on('error', (error) => {
      this.pushLog(`进程错误:${error.message}`, true)
      // spawn 失败(不存在、无权限等)不会触发 exit;立刻转为错误并上报,
      // 而不是让 waitReady 空转 90 秒后才报「未就绪」。
      if (!this.stopRequested && this.child === child) {
        this.child = null
        this.managedPid = null
        this.state = 'error'
        this.error = `托管进程启动失败:${error.message}`
        this.emit('status', this.status())
      }
    })
    child.on('exit', (code, signal) => {
      this.log(`托管进程退出(code=${String(code)}, signal=${String(signal)})`)
      const crashed = !this.stopRequested && this.state !== 'stopping'
      this.child = null
      this.managedPid = null
      if (crashed && this.config.restartOnCrash) {
        this.state = 'error'
        this.error = `托管进程退出(code=${String(code) ?? signal ?? '?'}),准备重启…`
        this.emit('status', this.status())
        this.restartAttempts += 1
        const delay = Math.min(1000 * 2 ** Math.min(this.restartAttempts, 5), 30000)
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          void this.restart()
        }, delay)
      } else {
        this.state = this.stopRequested ? 'stopped' : 'error'
        this.error = crashed ? `托管进程退出(code=${String(code)})` : null
        this.emit('status', this.status())
      }
    })

    void this.waitReady()
  }

  /** 轮询探测直到就绪或超时。 */
  private async waitReady(): Promise<void> {
    const client = this.client()
    const deadline = Date.now() + 90000
    for (;;) {
      if (this.stopRequested || this.child === null) return
      const ok = await client.probe(12000)
      if (this.stopRequested || this.child === null) return
      if (ok) {
        this.state = 'running'
        this.error = null
        this.restartAttempts = 0
        this.emit('status', this.status())
        return
      }
      if (Date.now() > deadline) {
        this.state = 'error'
        this.error = '托管服务在 90 秒内未就绪,请查看日志'
        this.emit('status', this.status())
        return
      }
      await sleep(800)
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null || child.pid === undefined) return
    this.state = 'stopping'
    this.emit('status', this.status())
    // Windows 下 npx 会拉起进程树,用 taskkill /T 确保整树结束。
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      setTimeout(resolve, 4000)
    })
    this.managedPid = null
  }

  private pushLog(line: string, isError: boolean): void {
    for (const raw of line.split(/\r?\n/)) {
      const text = raw.trim()
      if (text === '') continue
      // 新版官方 harness 启动打印带进程级 token 的 URL(`/?token=…`);提取后供
      // webview 与 RPC 客户端完成一次性鉴权(换取持久 cookie)。
      const tokenMatch = /token=([A-Za-z0-9_-]{32,})/.exec(text)
      if (tokenMatch !== null && this.launchTokenValue === null) {
        this.launchTokenValue = tokenMatch[1] ?? null
        this.emit('log', `[auth] 已捕获进程访问 token(长度 ${tokenMatch[1]?.length ?? 0})`)
      }
      this.log(`${isError ? '[err] ' : ''}${text}`)
    }
  }

  private log(text: string): void {
    const entry = `[${new Date().toLocaleTimeString()}] ${text}`
    this.logs.push(entry)
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400)
    this.emit('log', entry)
  }
}

/** 极简 shell 分词:支持双引号包裹的参数。 */
function splitCommand(template: string): { command: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of template) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === ' ' || char === '\t') {
      if (current !== '') { tokens.push(current); current = '' }
    } else {
      current += char
    }
  }
  if (current !== '') tokens.push(current)
  if (tokens.length === 0) throw new Error('空的启动命令')
  return { command: tokens[0], args: tokens.slice(1) }
}

/**
 * 默认 npx 启动形态 → 本地 dsh 直连:
 * 仅当命令形如 `npx … @deepseek-ai/dsh …`(用户没有特意自定义)且能定位到本地
 * 已安装的 dsh bin 时改写为 `node <bin> …`。定位不到就原样返回 null(走 npx)。
 */
function rewriteNpxToLocal(template: string): string | null {
  const parsed = splitCommand(template)
  const base = parsed.command.toLowerCase().replace(/\.cmd$/, '').replace(/\.exe$/, '')
  if (!base.endsWith('npx')) return null
  if (!parsed.args.some((token) => token.startsWith('@deepseek-ai/dsh'))) return null
  const bin = findLocalDshBin()
  if (bin === null) return null
  // 去掉 npx 专属开关与包名,保留业务参数。
  const args = parsed.args.filter((arg) =>
    arg !== '--yes' && arg !== '--offline' && arg !== '--prefer-offline' && !arg.startsWith('@deepseek-ai/'))
  return ['node', quoteForShell(bin), ...args.map((arg) => quoteForShell(arg))].join(' ')
}

/** 定位本机可用的 dsh CLI(env 显式指定 > ~/dsh-runtime > npm npx 缓存)。 */
function findLocalDshBin(): string | null {
  const explicit = process.env.DSH_DESKTOP_DSH_BIN
  if (explicit !== undefined && explicit.trim() !== '' && existsSync(explicit)) return explicit
  const homeRuntime = join(homedir(), 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const candidates: string[] = [homeRuntime]
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData !== '') {
    const npxRoot = join(localAppData, 'npm-cache', '_npx')
    try {
      for (const hash of readdirSync(npxRoot)) {
        candidates.push(join(npxRoot, hash, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      }
    } catch {
      // _npx 目录不存在或不可读,忽略。
    }
  }
  let best: string | null = null
  let bestVersion = ''
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let version = ''
    try {
      const pkg = join(dirname(candidate), '..', 'package.json')
      if (existsSync(pkg)) {
        version = (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? ''
      }
    } catch {
      version = ''
    }
    if (version >= bestVersion) {
      bestVersion = version
      best = candidate
    }
  }
  return best
}

/** cmd/shell 令牌安全转义:含空白或元字符时加引号并加倍内部引号。 */
function quoteForShell(token: string): string {
  if (/^[A-Za-z0-9_./:=@%+\-]+$/.test(token)) return token
  return `"${token.replace(/"/g, '""')}"`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
