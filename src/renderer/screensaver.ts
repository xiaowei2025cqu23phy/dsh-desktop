/**
 * 屏保页面:纯屏保 —— 壁纸 + 时钟,不做任何 agent 工作。
 *
 * 刻意保持"什么都不做":屏保的职责是遮挡屏幕,不是替你跑任务。想要空闲时让 agent
 * 干活,用定时任务或机器人通道,那些有独立的开关与配额。这样也避免了失控任务在无人
 * 看管时烧 token / 占 CPU。
 *
 * 经典脚本(无 import/export),整体包在 IIFE 中。按键 / 点击 / 滚轮 / 触摸退出。
 */

(() => {

function $id(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing element #${id}`)
  return el
}

const API = window.dshScreen

/** 窗口打开后的输入宽限期:合成事件不应立刻关掉屏保。 */
let exitArmedAt = Date.now() + 1000

function exit(): void {
  if (Date.now() < exitArmedAt) return
  // 调试/演示钩子:?keep=1 时保持打开(录制演示用)。
  if (new URLSearchParams(window.location.search).get('keep') === '1') return
  void API.exit()
}

function bindExitEvents(): void {
  // 不绑定 mousemove:鼠标抖动会误退出。只认明确输入。
  window.addEventListener('keydown', exit, { passive: true })
  window.addEventListener('mousedown', exit, { passive: true })
  window.addEventListener('pointerdown', exit, { passive: true })
  window.addEventListener('click', exit, { passive: true })
  window.addEventListener('wheel', exit, { passive: true })
  window.addEventListener('touchstart', exit, { passive: true })
}

function tickClock(): void {
  const now = new Date()
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  $id('ss-clock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false })
  $id('ss-ambient-clock').textContent = hhmm
  $id('ss-ambient-date').textContent = now.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })
}

/**
 * 壁纸:img 元素铺满 + 遮罩。
 *
 * 走 data URL 而不是 CSS 变量:chromium 对内联样式里的大 data URL(>~800KB)会直接
 * 丢弃导致黑底,img 的 src 没有该限制;sandbox 渲染进程对 file:// 本地图也不可靠。
 */
async function applyWallpaper(): Promise<void> {
  try {
    const [wallpaper, appearance] = await Promise.all([API.wallpaper(), API.appearance()])
    if (wallpaper === null || !wallpaper.dataUrl) return
    const img = document.getElementById('ss-wallpaper') as HTMLImageElement | null
    if (img !== null) {
      img.src = wallpaper.dataUrl
      const pos = wallpaper.position ?? { x: 0.5, y: 0.5 }
      img.style.objectPosition = `${pos.x * 100}% ${pos.y * 100}%`
      img.hidden = false
    }
    document.body.style.setProperty('--wallpaper-mask', String(appearance?.mask ?? 0.55))
    document.body.classList.add('has-wallpaper')
  } catch {
    // 壁纸读取失败退回纯深色背景,不影响屏保。
  }
}

async function boot(): Promise<void> {
  bindExitEvents()
  tickClock()
  setInterval(tickClock, 1000)
  await applyWallpaper()
  // 加载完成后重新起算宽限期,避免首帧合成事件立即退出。
  exitArmedAt = Date.now() + 800
}

void boot()

})()
