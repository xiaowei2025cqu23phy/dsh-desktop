/**
 * QQ 机器人扫码登录(onboard):生成二维码 → 用户用 QQ 扫码 → 轮询绑定结果 →
 * AES-256-GCM 解密得到 AppID/AppSecret。
 *
 * 协议参考 tencent-connect/qqbot-agent-sdk 的 start_onboard(create_bind_task /
 * poll_bind_result),仅用 node:crypto 与 fetch,无额外依赖。
 */

import { createDecipheriv, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

/** qrcode 包(CJS,主进程直接 require 生成二维码 dataURL)。 */
const qrcode = createRequire(__filename)('qrcode') as { toDataURL: (text: string, opts?: unknown) => Promise<string> }

/** 创建绑定任务与轮询结果用的 portal 端点。 */
const PORTAL_HOST = 'q.qq.com'
const ONBOARD_CREATE_PATH = '/lite/create_bind_task'
const ONBOARD_POLL_PATH = '/lite/poll_bind_result'

/** 二维码目标 URL 模板(与官方 SDK 一致)。 */
const QR_URL_TEMPLATE = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2'

/** 轮询间隔与总超时。 */
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 5 * 60 * 1000

export type OnboardStatus = 'pending' | 'completed' | 'expired' | 'error'

export interface OnboardProgress {
  status: OnboardStatus
  /** 二维码图片 dataURL(创建任务后立即可得;失败时为 null)。 */
  qrDataUrl: string | null
  /** 绑定的机器人凭据(completed 时)。 */
  appId?: string
  appSecret?: string
  userOpenid?: string
  error?: string
}

/** 生成 256 位随机 AES 密钥(base64),服务端用它加密凭据后返回。 */
function generateBindKey(): string {
  return randomBytes(32).toString('base64')
}

/** 解密服务端返回的凭据:IV(12B) | ciphertext | AuthTag(16B),AES-256-GCM。 */
function decryptSecret(encryptedBase64: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64')
  const raw = Buffer.from(encryptedBase64, 'base64')
  const iv = raw.subarray(0, 12)
  const ciphertextWithTag = raw.subarray(12)
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16)
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`https://${PORTAL_HOST}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'dsh-desktop-qqbot/0.1',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`onboard HTTP ${response.status}`)
  const data = await response.json() as { retcode?: unknown; msg?: unknown; data?: unknown }
  if (data.retcode !== 0) {
    throw new Error(`onboard retcode=${String(data.retcode)}: ${String(data.msg ?? 'unknown')}`)
  }
  return data.data as T
}

interface BindTaskData {
  task_id?: unknown
}

interface PollResultData {
  status?: unknown
  bot_appid?: unknown
  bot_encrypt_secret?: unknown
  user_openid?: unknown
}

/**
 * 启动扫码绑定流程:生成 AES key → 创建绑定任务 → 回调二维码 → 轮询直到
 * 完成(解密凭据)/过期/超时,或 signal 取消。
 *
 * @param onQr - 二维码 dataURL 就绪回调(渲染层展示)。
 * @param onProgress - 状态变化回调(completed 时携带 appId/appSecret)。
 * @param signal - 取消信号(用户关闭扫码弹层时中止轮询)。
 */
export async function startOnboard(
  onQr: (qrDataUrl: string) => void,
  onProgress: (progress: OnboardProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const aesKey = generateBindKey()
  try {
    const data = await postJson<BindTaskData>(ONBOARD_CREATE_PATH, { key: aesKey })
    const taskId = data.task_id
    if (typeof taskId !== 'string' || taskId === '') throw new Error('创建绑定任务失败:缺少 task_id')
    const qrUrl = QR_URL_TEMPLATE.replace('{task_id}', encodeURIComponent(taskId))
    const qrDataUrl = await qrcode.toDataURL(qrUrl, { width: 240, margin: 1 })
    onQr(qrDataUrl)

    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      if (signal.aborted) return
      const poll = await postJson<PollResultData>(ONBOARD_POLL_PATH, { task_id: taskId })
      if (poll.status === 2) {
        const appId = typeof poll.bot_appid === 'string' ? poll.bot_appid : ''
        const appSecret = typeof poll.bot_encrypt_secret === 'string'
          ? decryptSecret(poll.bot_encrypt_secret, aesKey)
          : ''
        onProgress({
          status: 'completed',
          qrDataUrl,
          appId,
          appSecret,
          userOpenid: typeof poll.user_openid === 'string' ? poll.user_openid : undefined,
        })
        return
      }
      if (poll.status === 3) {
        onProgress({ status: 'expired', qrDataUrl })
        return
      }
      if (Date.now() > deadline) {
        onProgress({ status: 'error', qrDataUrl, error: '扫码超时(5 分钟),请重新生成' })
        return
      }
      await sleep(POLL_INTERVAL_MS)
    }
  } catch (error) {
    onProgress({
      status: 'error',
      qrDataUrl: null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
