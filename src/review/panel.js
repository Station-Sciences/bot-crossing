/**
 * The review panel: walk the open pull requests inside the running colony.
 *
 * Self-contained on purpose — its own DOM, its own stylesheet, one entry point from main.js and
 * no edits to hud.js or styles.css. This is scaffolding for one round of PRs, not a feature of
 * the game, and it should be deletable in one commit without leaving a mark on the UI it sat
 * next to.
 *
 * Arrows move, and moving *applies*: a PR that adds a world flies there, a PR that changes
 * behaviour turns it on. That is the whole point — reading a diff tells you what changed, and
 * standing in it tells you whether you want it.
 */
import { PLANETS } from '../world/planet.js'
import { CATALOGUE, ORDERED, VERDICT, linkFor } from './catalogue.js'

const STORE_KEY = 'bot-crossing:review'

/** Restores where you were, so a reload does not start the round again from the top. */
function stored() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
  } catch {
    return {}
  }
}

export class ReviewPanel {
  /**
   * @param root   where the overlay mounts
   * @param deps   { settings, hud } — `settings` is how a planet preview is applied, since the
   *               colony already watches that key; `hud` is borrowed for its toast.
   */
  constructor(root, { settings, hud } = {}) {
    this.settings = settings
    this.hud = hud
    this.open = false
    this.applying = false
    // The planet the colony was on before the round started, so leaving review puts it back
    // rather than stranding you on whichever world the last PR flew you to.
    this.homePlanet = settings?.get('planet') || 'terra'

    const saved = stored()
    const at = CATALOGUE.findIndex((e) => e.n === saved.n)
    this.index = at >= 0 ? ORDERED.findIndex((e) => e.n === saved.n) : 0

    this._injectStyle()
    this._build(root)
    this._wire()
  }

  get current() {
    return ORDERED[this.index] || ORDERED[0]
  }

  toggle(force) {
    this.open = force === undefined ? !this.open : Boolean(force)
    this.el.hidden = !this.open
    if (this.open) {
      this._apply(this.current)
      this._render()
    } else {
      this._restore()
    }
  }

  /** ±1 through the list, applying as it goes. Wraps, because a round is a loop. */
  move(delta) {
    if (!this.open) return
    this.index = (this.index + delta + ORDERED.length) % ORDERED.length
    this._apply(this.current)
    this._render()
  }

  jumpTo(n) {
    const at = ORDERED.findIndex((e) => e.n === n)
    if (at < 0) return
    this.index = at
    this._apply(this.current)
    this._render()
  }

  /**
   * Put the PR in front of you.
   *
   * `planet` goes through settings rather than the colony directly: the colony, the ambience bed
   * and the colour grade all already watch that key, so one write moves everything that should
   * move and nothing here has to know about any of them.
   */
  _apply(entry) {
    if (!entry || !this.settings) return
    localStorage.setItem(STORE_KEY, JSON.stringify({ n: entry.n }))

    // Flags are cleared on every move, so a preview never leaks into the next PR's.
    for (const e of CATALOGUE) {
      if (e.preview?.kind === 'flag' && e.n !== entry.n) this.settings.set(e.preview.key, false)
    }

    const p = entry.preview
    // A world whose PR is not integrated on this branch yet must not reach settings — the colony
    // would rebuild against a preset that does not exist. The panel says so instead, which is
    // also the honest answer to "what does this one look like".
    const live = p?.kind === 'planet' && Boolean(PLANETS[p.id])
    this.pending = p?.kind === 'planet' && !live ? `Not integrated on this branch yet — nothing to fly to.` : ''

    if (live) {
      if (this.settings.get('planet') !== p.id) this.settings.set('planet', p.id)
      return
    }
    if (p?.kind === 'flag') {
      this.settings.set(p.key, true)
      return
    }
    // Nothing to show: back to the colony's own world rather than leaving the last preview's sky
    // overhead, which would read as this PR having put it there.
    if (this.settings.get('planet') !== this.homePlanet) this.settings.set('planet', this.homePlanet)
  }

  _restore() {
    for (const e of CATALOGUE) {
      if (e.preview?.kind === 'flag') this.settings?.set(e.preview.key, false)
    }
    if (this.settings && this.settings.get('planet') !== this.homePlanet) {
      this.settings.set('planet', this.homePlanet)
    }
  }

  _build(root) {
    this.el = document.createElement('aside')
    this.el.className = 'review'
    this.el.hidden = true
    this.el.innerHTML = `
      <header class="review-head">
        <span class="review-title">PR round</span>
        <span class="review-count"></span>
        <button class="review-close" title="Close (R)">×</button>
      </header>
      <div class="review-body">
        <ol class="review-list"></ol>
        <section class="review-detail"></section>
      </div>
      <footer class="review-foot">↑ ↓ move · Enter opens on GitHub · R closes</footer>`
    root.appendChild(this.el)
    this.list = this.el.querySelector('.review-list')
    this.detail = this.el.querySelector('.review-detail')
    this.count = this.el.querySelector('.review-count')
  }

  _wire() {
    this.el.querySelector('.review-close').addEventListener('click', () => this.toggle(false))
    this.list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-n]')
      if (li) this.jumpTo(Number(li.dataset.n))
    })
  }

  /** Called by main.js's keydown, so review keys live in the same place as every other shortcut. */
  handleKey(e) {
    if (e.key === 'r' || e.key === 'R') {
      this.toggle()
      return true
    }
    if (!this.open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      this.move(1)
      return true
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      this.move(-1)
      return true
    }
    if (e.key === 'Enter') {
      window.open(linkFor(this.current), '_blank', 'noopener')
      return true
    }
    if (e.key === 'Escape') {
      this.toggle(false)
      return true
    }
    return false
  }

  _render() {
    this.count.textContent = `${this.index + 1} / ${ORDERED.length}`
    this.list.innerHTML = ORDERED.map((e, i) => {
      const v = VERDICT[e.verdict]
      return `<li data-n="${e.n}" class="${i === this.index ? 'on' : ''}">
        <span class="dot ${v.tone}"></span>
        <span class="num">#${e.n}</span>
        <span class="who">${esc(e.title)}</span>
      </li>`
    }).join('')
    const on = this.list.querySelector('li.on')
    if (on) on.scrollIntoView({ block: 'nearest' })

    const e = this.current
    const v = VERDICT[e.verdict]
    const p = e.preview || {}
    const livePlanet = p.kind === 'planet' && Boolean(PLANETS[p.id])
    const shown = livePlanet
      ? `<p class="review-live">Showing it now — this is the world it adds.${p.hint ? ' ' + esc(p.hint) : ''}</p>`
      : p.kind === 'flag'
        ? `<p class="review-live">Turned on now.${p.hint ? ' ' + esc(p.hint) + '.' : ''}</p>`
        : `<p class="review-dim">${esc(this.pending || p.why || 'Nothing to preview.')}</p>`

    this.detail.innerHTML = `
      <h2>#${e.n} · ${esc(e.title)}</h2>
      <p class="review-by">${esc(e.author)} · <span class="tag ${v.tone}">${v.label}</span></p>
      <p>${esc(e.summary)}</p>
      <p class="review-measured"><strong>Measured:</strong> ${esc(e.measured)}</p>
      ${shown}
      <a href="${linkFor(e)}" target="_blank" rel="noopener">Open #${e.n} on GitHub →</a>`
  }

  _injectStyle() {
    if (document.getElementById('review-style')) return
    const s = document.createElement('style')
    s.id = 'review-style'
    s.textContent = `
      .review { position: fixed; inset: 12px auto 12px 12px; width: 460px; z-index: 40;
        display: flex; flex-direction: column; border-radius: 14px; overflow: hidden;
        background: rgba(16,18,24,.93); backdrop-filter: blur(18px);
        border: 1px solid rgba(255,255,255,.10); color: #e8ecf2;
        font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
        box-shadow: 0 18px 50px rgba(0,0,0,.5); }
      .review[hidden] { display: none !important; }
      .review-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,.08); }
      .review-title { font-weight: 600; letter-spacing: .2px; }
      .review-count { color: #8b94a6; font-variant-numeric: tabular-nums; }
      .review-close { margin-left: auto; background: none; border: 0; color: #8b94a6;
        font-size: 18px; cursor: pointer; line-height: 1; }
      .review-close:hover { color: #e8ecf2; }
      .review-body { display: flex; min-height: 0; flex: 1; }
      .review-list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; width: 190px;
        border-right: 1px solid rgba(255,255,255,.08); flex: none; }
      .review-list li { display: flex; align-items: center; gap: 7px; padding: 5px 7px;
        border-radius: 7px; cursor: pointer; white-space: nowrap; }
      .review-list li:hover { background: rgba(255,255,255,.06); }
      .review-list li.on { background: rgba(120,170,255,.18); }
      .review-list .num { color: #8b94a6; font-variant-numeric: tabular-nums; flex: none; }
      .review-list .who { overflow: hidden; text-overflow: ellipsis; }
      .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      .dot.good { background: #5fd08a } .dot.warn { background: #f0c05a }
      .dot.bad { background: #f07a7a } .dot.mute { background: #5a6272 }
      .review-detail { padding: 12px 14px; overflow-y: auto; flex: 1; min-width: 0; }
      .review-detail h2 { margin: 0 0 2px; font-size: 14px; }
      .review-detail p { margin: 0 0 8px; }
      .review-by { color: #8b94a6; }
      .tag { padding: 1px 7px; border-radius: 99px; font-size: 11px; }
      .tag.good { background: rgba(95,208,138,.18); color: #7fe0a4 }
      .tag.warn { background: rgba(240,192,90,.18); color: #f2cd78 }
      .tag.bad  { background: rgba(240,122,122,.18); color: #f49a9a }
      .tag.mute { background: rgba(140,150,170,.16); color: #9aa4b6 }
      .review-measured { color: #aab3c2; }
      .review-live { color: #7fe0a4; }
      .review-dim { color: #7c8496; font-style: italic; }
      .review-detail a { color: #8fb8ff; }
      .review-foot { padding: 8px 12px; border-top: 1px solid rgba(255,255,255,.08);
        color: #7c8496; font-size: 12px; }
      @media (max-width: 760px) { .review { inset: 8px; width: auto }
        .review-body { flex-direction: column } .review-list { width: auto; max-height: 150px;
        border-right: 0; border-bottom: 1px solid rgba(255,255,255,.08) } }`
    document.head.appendChild(s)
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
