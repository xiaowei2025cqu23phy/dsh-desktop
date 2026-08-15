/**
 * Harness 进程托管:探测已运行实例 → 必要时托管启动 `dsh web` → 健康轮询 → 崩溃重启。
 */

import { spawn, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { HarnessClient } from './client'
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
  private stopRequested = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempts = 0
  readonly logs: string[] = []

  constructor(private config: HarnessConfig) {
    super()
  }

  client(): HarnessClient {
    return new HarnessClient(this.baseUrl())
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
      next.dshHome !== this.config.dshHome
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

  private clearTimers(): void {
    if (this.probeTimer !== null) { clearTimeout(this.probeTimer); this.probeTimer = null }
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
  }

  /** 探测已运行实例;无则按 autoStart 决定是否托管启动。 */
  private async probeAndAdopt(): Promise<void> {
    if (this.stopRequested || this.state === 'stopped') return
    this.state = 'probing'
    this.emit('status', this.status())
    const client = this.client()
    const ok = await client.probe()
    if (this.stopRequested) return
    if (ok) {
      this.state = 'external'
      this.error = null
      this.emit('status', this.status())
      return
    }
    if (this.config.mode === 'external') {
      this.state = 'error'
      this.error = `无法连接到 ${this.baseUrl()},请确认 harness 已启动`
      this.emit('status', this.status())
      return
    }
    // 端口被占用但不是 dsh:说明冲突,报错。
    if (await this.portBusy()) {
      this.state = 'error'
      this.error = `端口 ${this.config.port} 已被其他程序占用,且不是 dsh 服务。请在设置中更换端口。`
      this.emit('status', this.status())
      return
    }
    if (this.config.autoStart) {
      this.spawnManaged()
    } else {
      this.state = 'idle'
      this.emit('status', this.status())
    }
  }

  private async portBusy(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      const response = await fetch(`http://127.0.0.1:${this.config.port}/`, { signal: controller.signal })
      clearTimeout(timer)
      return response.ok || response.status !== 404
    } catch {
      return false
    }
  }

  /** 托管启动 dsh web。 */
  private spawnManaged(): void {
    if (this.child !== null || this.stopRequested) return
    this.state = 'starting'
    this.error = null
    this.log(`启动托管服务:${this.config.command.replace('{port}', String(this.config.port))}`)
    const { command, args } = splitCommand(this.config.command.replace('{port}', String(this.config.port)))
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (this.config.dshHome) env.DSH_HOME = this.config.dshHome
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    this.child = child
    this.managedPid = child.pid ?? null
    this.emit('status', this.status())

    child.stdout?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString(), false))
    child.stderr?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString(), true))
    child.on('error', (error) => {
      this.pushLog(`进程错误:${error.message}`, true)
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
      const ok = await client.probe(2000)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
