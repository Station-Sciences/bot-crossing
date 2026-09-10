/**
 * How a hosted planet gets its crew.
 *
 * Two pieces of DOM, both optional like the rest of the HUD. A chip at the top of the screen
 * says which folders the page is reading and how fresh the scan is; the overlay behind it is
 * where a folder is picked, a lapsed grant is revived, and the paid crew is offered. Every
 * picker and permission call here runs from a click, because the browser insists on one.
 */
import { LocalScanner } from '../scan/index.js'

const IS_MAC = /Mac/.test(navigator.platform)
const HINT = IS_MAC
  ? 'Hidden folders show with ⌘⇧. in the picker, or press ⌘⇧G and type ~/.claude'
  : 'Pick the folder in your home directory — it is not hidden on this system'

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

const TEMPLATE = `
<button class="crew-chip" type="button" title="Which sessions this planet is reading"></button>
<div class="crew-overlay" hidden>
  <div class="crew-dialog panel" role="dialog" aria-labelledby="crew-title">
    <button class="btn icon crew-close" type="button" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <h2 id="crew-title">How do you want to crew this planet?</h2>
    <p class="crew-sub">Every coding-agent thread becomes an astronaut. Nothing installs. Only titles and status ever leave your computer — never a transcript.</p>
    <div class="crew-cards">
      <section class="crew-card">
        <h3>Read my sessions</h3>
        <p>Pick the folder your coding agent keeps its sessions in. It stays on your computer; this page reads it while it is open.</p>
        <div class="crew-folders"></div>
        <div class="crew-add"></div>
        <p class="crew-hint"></p>
        <div class="crew-drop">or drop the folder here</div>
        <p class="crew-unsupported" hidden>This browser cannot read folders. Open this page in Chrome, Edge, Brave or Arc on the computer that runs your agents.</p>
      </section>
      <section class="crew-card crew-card-paid">
        <h3>Built-in agents</h3>
        <p>Crew that lives on the planet and keeps working while your computer is closed. Chat with them here, no coding agent needed.</p>
        <p class="crew-price">$20 / month</p>
        <button class="btn" type="button" disabled>Coming soon</button>
      </section>
    </div>
    <button class="btn ghost crew-skip" type="button">Just look around</button>
  </div>
</div>`

export class CrewPanel {
  /**
   * @param {HTMLElement} root
   * @param {{ scanner: LocalScanner, toast: (message: string, kind?: string) => void }} opts
   */
  constructor(root, { scanner, toast }) {
    this.scanner = scanner
    this.toast = toast
    this.el = document.createElement('div')
    this.el.className = 'crew'
    this.el.innerHTML = TEMPLATE
    root.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.status = scanner.status()
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
    const { supported, folders, available } = this.status
    this.$('.crew-unsupported').hidden = supported
    this.$('.crew-add').hidden = !supported
    this.$('.crew-drop').hidden = !supported
    this.$('.crew-hint').textContent = supported ? HINT : ''

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
            ? ''
            : `<button class="btn primary" type="button" data-grant="${esc(f.harness)}">Allow</button>`
        return `<div class="crew-folder ${esc(f.state)}">
          <span class="dot"></span>
          <span class="crew-folder-name"><strong>${esc(f.name)}</strong> · <code>${esc(f.folder)}</code></span>
          <span class="crew-folder-state">${esc(f.error || state)}</span>
          ${action}
          <button class="btn ghost" type="button" data-forget="${esc(f.harness)}">Remove</button>
        </div>`
      })
      .join('')

    this.$('.crew-add').innerHTML = available
      .map(
        (a) =>
          `<button class="btn primary" type="button" data-add="${esc(a.harness)}">Choose your <code>${esc(a.folder)}</code> folder</button>`
      )
      .join('')
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
