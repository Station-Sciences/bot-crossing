/**
 * Web Notification API manager for Bot Crossing.
 * Dispatches OS notifications when threads require attention or error.
 */

export class NotificationManager {
  constructor(settings) {
    this.settings = settings
    this.sentTags = new Map() // tag -> timestamp
  }

  get supported() {
    return typeof window !== 'undefined' && 'Notification' in window
  }

  get permission() {
    return this.supported ? Notification.permission : 'denied'
  }

  async requestPermission() {
    if (!this.supported) return false
    try {
      const res = await Notification.requestPermission()
      return res === 'granted'
    } catch {
      return false
    }
  }

  notify(title, options = {}, onClick = null) {
    if (!this.supported) return
    const enabled = this.settings ? Boolean(this.settings.get('desktopNotifications')) : false
    if (!enabled || Notification.permission !== 'granted') return

    // Debounce duplicate notifications within 2 minutes for the same tag
    const tag = options.tag || title
    const now = Date.now()
    const last = this.sentTags.get(tag) || 0
    if (now - last < 120000) return
    this.sentTags.set(tag, now)

    try {
      const n = new Notification(title, {
        body: options.body || '',
        icon: options.icon || '/assets/icon.png',
        tag,
        silent: false,
        ...options,
      })

      n.onclick = () => {
        try {
          window.focus()
          n.close()
        } catch {}
        onClick?.()
      }
    } catch {
      // Ignored if notifications fail in this environment
    }
  }
}
