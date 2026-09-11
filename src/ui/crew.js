/**
 * How a hosted planet gets its crew.
 *
 * Two pieces of DOM, both optional like the rest of the HUD. A chip at the top of the screen
 * says which folders the page is reading and how fresh the scan is; the dialog behind it is
 * where a folder is picked, a lapsed grant is revived, and the paid crew is offered. Every
 * picker and permission call here runs from a click, because the browser insists on one.
 */
import { LocalScanner } from '../scan/index.js'

const PLATFORM = /Mac/.test(navigator.platform)
  ? 'mac'
  : /Win/.test(navigator.platform)
    ? 'windows'
    : 'linux'

/** Where a harness folder is, in the words of the person's own operating system. */
const folderPath = (folder) =>
  PLATFORM === 'windows' ? `C:\\Users\\you\\${folder}` : `~/${folder}`

/** How to reach a hidden folder in this operating system's picker. */
const HINT = {
  mac: 'Hidden in the picker? Press ⌘⇧. to show hidden folders, or ⌘⇧G and type the path.',
  windows: 'Open your user folder, then pick the folder by name. It is not hidden on Windows.',
  linux: 'Hidden in the picker? Press Ctrl+H to show hidden folders.',
}[PLATFORM]

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const ago = (t) => {
  if (!t) return 'not yet'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

const ICON = {
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4A1.4 1.4 0 0 1 4.4 6h4.2l2 2.5h7A1.4 1.4 0 0 1 19 9.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.6z"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8"/></svg>`,
}

const PERKS = [
  'A crew that lives on your planet, not on your laptop',
  'Keeps working while your computer is closed',
  'Chat from any device, no coding agent needed',
]

const TEMPLATE = `
<button class="crew-chip" type="button"></button>
<div class="crew-overlay" hidden>
  <div class="crew-dialog" role="dialog" aria-labelledby="crew-title">
    <button class="crew-close" type="button" aria-label="Close">${ICON.close}</button>
    <header class="crew-head">
      <div class="crew-eyebrow">Bot Crossing</div>
      <h2 id="crew-title">How do you want to crew this planet?</h2>
      <p class="crew-sub">Every coding-agent thread becomes an astronaut. Nothing installs. Only titles and status ever leave your computer, never a transcript.</p>
    </header>
    <div class="crew-cards">
      <section class="crew-card">
        <div class="crew-card-head">
          <h3>Bring your own agents</h3>
          <span class="crew-tag">Free</span>
        </div>
        <p>Pick the folder each coding agent keeps its sessions in. It stays on your computer; this page reads it while it is open.</p>
        <div class="crew-rows crew-folders"></div>
        <div class="crew-rows crew-add"></div>
        <div class="crew-drop">or drop the folder here</div>
        <p class="crew-hint"></p>
        <p class="crew-unsupported" hidden>This browser cannot read folders. Open this page in Chrome, Edge, Brave or Arc on the computer that runs your agents.</p>
      </section>
      <section class="crew-card crew-card-paid">
        <div class="crew-card-head">
          <h3>Built-in agents</h3>
          <span class="crew-tag crew-tag-state" hidden></span>
        </div>
        <div class="crew-price"><span class="crew-price-amount">$20</span><span class="crew-price-cadence">/ month</span></div>
        <ul class="crew-perks">${PERKS.map((p) => `<li>${ICON.check}<span>${esc(p)}</span></li>`).join('')}</ul>
        <div class="crew-paid-actions"></div>
        <p class="crew-fine">Cancel any time. Secure checkout by Stripe.</p>
      </section>
    </div>
    <footer class="crew-foot">
      <span class="crew-fine">Hosted by Emra</span>
      <button class="crew-btn ghost crew-skip" type="button">Just look around</button>
    </footer>
  </div>
</div>`

export class CrewPanel {
  /**
   * @param {HTMLElement} root
   * @param {{
   *   scanner: LocalScanner,
   *   toast: (message: string, kind?: string) => void,
   *   checkout: () => Promise<{ url: string }>,
   * }} opts
   */
  constructor(root, { scanner, toast, checkout }) {
    this.scanner = scanner
    this.toast = toast
    this.checkout = checkout
    this.el = document.createElement('div')
    this.el.className = 'crew'
    this.el.innerHTML = TEMPLATE
    root.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.status = scanner.status()
    /** The person's plan, once the workspace has said; null until then. */
    this.billing = null
    this._wire()
    this.render()
    // The chip's "12s ago" has to move on its own.
    setInterval(() => this._renderChip(), 5000)
  }

  _wire() {
    this.$('.crew-chip').addEventListener('click', () => this.open())
    this.$('.crew-close').addEventListener('click', () => this.close())
    this.$('.crew-skip').addEventListener('click', () => this.close())
    this.$('.crew-overlay').addEventListener('click', (e) => {
      if (e.target === this.$('.crew-overlay')) this.close()
    })
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && this.isOpen()) {
          e.stopPropagation()
          this.close()
        }
      },
      true
    )

    const drop = this.$('.crew-drop')
    drop.addEventListener('dragover', (e) => {
      e.preventDefault()
      drop.classList.add('over')
    })
    drop.addEventListener('dragleave', () => drop.classList.remove('over'))
    drop.addEventListener('drop', async (e) => {
      e.preventDefault()
      drop.classList.remove('over')
      await this._run(() => this.scanner.addDropped(e), (name) => `Reading your ${name} sessions`)
    })

    this.$('.crew-add').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-add]')
      if (!btn) return
      await this._run(
        () => this.scanner.addFolder(btn.dataset.add),
        (name) => (name ? `Reading your ${name} sessions` : '')
      )
    })

    this.$('.crew-paid-actions').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-pay], button[data-go]')
      if (!btn) return
      if (btn.dataset.go) {
        window.location.assign(btn.dataset.go)
        return
      }
      btn.disabled = true
      btn.textContent = 'Opening checkout…'
      try {
        const { url } = await this.checkout()
        window.location.assign(url)
      } catch (err) {
        this.toast(err?.message || 'Could not start checkout', 'err')
        this._renderPaid()
      }
    })

    this.$('.crew-folders').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-grant], button[data-forget]')
      if (!btn) return
      if (btn.dataset.grant) {
        const ok = await this.scanner.grant(btn.dataset.grant)
        this.toast(ok ? 'Reading your sessions again' : 'Permission was not given', ok ? '' : 'err')
      } else {
        await this.scanner.forget(btn.dataset.forget)
        this.toast('Folder removed — nothing on your computer changed')
      }
    })
  }

  async _run(fn, message) {
    try {
      const result = await fn()
      const text = message(result)
      if (text) this.toast(text)
      if (result && this.scanner.active.length) this.close()
    } catch (err) {
      this.toast(err?.message || 'Could not read that folder', 'err')
    }
  }

  setStatus(status) {
    this.status = status
    this.render()
  }

  /** @param {{ plan: string, active: boolean, checkout: string, crewAgent: string|null, crewUrl: string|null } | null} billing */
  setBilling(billing) {
    this.billing = billing
    this._renderPaid()
  }

  isOpen() {
    return !this.$('.crew-overlay').hidden
  }

  open() {
    this.$('.crew-overlay').hidden = false
    this.render()
  }

  close() {
    this.$('.crew-overlay').hidden = true
  }

  render() {
    this._renderChip()
    this._renderPaid()
    const { supported, folders, available } = this.status
    this.$('.crew-unsupported').hidden = supported
    this.$('.crew-add').hidden = !supported
    this.$('.crew-drop').hidden = !supported
    this.$('.crew-hint').textContent = supported ? HINT : ''

    // Folders already granted or remembered, one row each, in the same shape as the buttons
    // below them so the list reads as one list whichever state a row is in.
    this.$('.crew-folders').innerHTML = folders
      .map((f) => {
        const state =
          f.state === 'granted'
            ? `${f.threads} thread${f.threads === 1 ? '' : 's'}`
            : f.state === 'prompt'
              ? 'needs your permission again'
              : 'permission denied'
        const action =
          f.state === 'granted'
            ? `<button class="crew-mini" type="button" data-forget="${esc(f.harness)}">Remove</button>`
            : `<button class="crew-mini primary" type="button" data-grant="${esc(f.harness)}">Allow</button>`
        return `<div class="crew-row is-${esc(f.state)}">
          <span class="crew-row-icon"><span class="dot"></span></span>
          <span class="crew-row-text"><strong>${esc(f.name)}</strong><span class="crew-row-meta">${esc(f.error || state)}</span></span>
          ${action}
        </div>`
      })
      .join('')

    this.$('.crew-add').innerHTML = available
      .map(
        (a) =>
          `<button class="crew-row" type="button" data-add="${esc(a.harness)}">
            <span class="crew-row-icon">${ICON.folder}</span>
            <span class="crew-row-text"><strong>${esc(a.name)}</strong><span class="crew-row-meta"><code>${esc(folderPath(a.folder))}</code></span></span>
            <span class="crew-row-go">Choose folder ${ICON.chevron}</span>
          </button>`
      )
      .join('')
  }

  _renderPaid() {
    const actions = this.$('.crew-paid-actions')
    const tag = this.$('.crew-tag-state')
    const fine = this.$('.crew-card-paid .crew-fine')
    const b = this.billing
    tag.hidden = true
    if (!b) {
      actions.innerHTML = `<button class="crew-btn primary" type="button" disabled>Checking your plan…</button>`
      return
    }
    if (b.active) {
      tag.hidden = false
      tag.textContent = 'Active'
      fine.textContent = 'Every chat with your crew is an astronaut on this planet.'
      actions.innerHTML = `<button class="crew-btn primary" type="button" data-go="${esc(b.crewUrl || '/')}">${ICON.sparkle} Chat with your crew</button>`
      return
    }
    fine.textContent = 'Cancel any time. Secure checkout by Stripe.'
    if (b.checkout === 'off') {
      actions.innerHTML = `<button class="crew-btn primary" type="button" disabled>Not available on this planet yet</button>`
      return
    }
    actions.innerHTML = `<button class="crew-btn primary" type="button" data-pay="1">Get built-in agents</button>`
  }

  _renderChip() {
    const chip = this.$('.crew-chip')
    const { supported, folders, lastScanAt } = this.status
    const granted = folders.filter((f) => f.state === 'granted')
    let text
    let kind = 'off'
    if (granted.length) {
      const threads = granted.reduce((n, f) => n + f.threads, 0)
      text = `${granted.map((f) => f.folder).join(' + ')} · ${threads} thread${threads === 1 ? '' : 's'} · ${ago(lastScanAt)}`
      kind = folders.some((f) => f.error) ? 'warn' : 'on'
    } else if (folders.length) {
      text = 'Sessions need your permission — click to allow'
      kind = 'warn'
    } else {
      text = supported ? 'Connect your sessions' : 'Open on your computer to connect sessions'
    }
    if (chip.textContent !== text) chip.textContent = text
    chip.dataset.kind = kind
  }
}
