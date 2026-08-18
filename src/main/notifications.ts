/** Windows desktop notifications for important Harness state changes. */
import { BrowserWindow, Notification } from 'electron'
import type { ConfigStore, NotificationConfig } from './config'

export type NotificationKind = 'approval' | 'question' | 'taskDone' | 'taskFail'

export class DesktopNotifications {
  constructor(private readonly config: ConfigStore) {}

  getConfig(): NotificationConfig {
    return this.config.get().notifications
  }

  setConfig(patch: Partial<NotificationConfig>): NotificationConfig {
    return this.config.update('notifications', patch)
  }

  show(kind: NotificationKind, title: string, body: string): void {
    const config = this.getConfig()
    if (!config.enabled || !config[kind] || !Notification.isSupported()) return
    const hour = new Date().getHours()
    const quiet = config.quietStart <= config.quietEnd
      ? hour >= config.quietStart && hour < config.quietEnd
      : hour >= config.quietStart || hour < config.quietEnd
    const urgent = kind === 'approval' || kind === 'taskFail'
    if (config.quietHoursEnabled && quiet && !(urgent && config.urgentBypassQuiet)) return
    const notification = new Notification({ title, body: body.slice(0, 240) })
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
      if (win !== undefined) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    notification.show()
  }
}
