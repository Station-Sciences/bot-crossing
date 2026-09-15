import { PRESETS, PLANETS_ORDER } from './hud-data.js'
import { PLANETS } from '../world/planet.js'
import { TIMES, systemTimeOfDay } from '../world/sky.js'
import { STATUS_LABEL } from '../game/colony.js'
import { FACE, FRAME_COLS, FRAME_ROWS } from '../agents/faces.js'
import { PLOT_PALETTE, hashString } from '../world/plots.js'

/**
 * The whole HUD, in plain DOM.
 *
 * Deliberately not a framework: this sits on top of a render loop that must not miss a
 * frame, so the UI only ever touches the DOM when something it shows has actually changed —
 * every setter compares against the last value it wrote and returns early otherwise.
 *
 * The one hard rule is that all of this is optional. Pressing H hides every panel, and the
 * game stays fully readable because status lives above the astronauts' heads in the scene,
 * not in here.
 */

/**
 * The page only ever runs on the machine the server is on — it answers nothing else — so the
 * browser's OS is the server's OS, and the name of the thing that shows a folder can be read
 * here rather than asked for.
 */
const IS_MAC = /Mac/.test(navigator.platform)
const FILE_MANAGER = IS_MAC ? 'Finder' : /Win/.test(navigator.platform) ? 'Explorer' : 'Files'

const ICON = {
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M6.6 6.6C4.06 8.2 2 11 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6h5v6"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8.5h3.2l1.5-2h8.6l1.5 2H21v11H3z"/><circle cx="12" cy="14" r="3.4"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6v.4"/><path d="M12 17h.01"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18v3H3z"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.7a8 8 0 0 1-8.5 8 9.3 9.3 0 0 1-2.7-.4L4.5 21l1.4-4.1a7.9 7.9 0 0 1-2.4-5.7A8 8 0 0 1 12 3.6a8 8 0 0 1 8.5 8.1z"/><path d="M12 8.6v5.4M9.3 11.3h5.4"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4A1.4 1.4 0 0 1 4.4 6h4.2l2 2.5h7A1.4 1.4 0 0 1 19 9.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.6z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.6"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6"/></svg>`,
  orbit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10.2" ry="4.6" transform="rotate(-24 12 12)"/><circle cx="21" cy="8.2" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3.5V6M16 3.5V6"/></svg>`,
}

const STAT_DEFS = [
  { key: 'working', label: 'building', cls: 'working' },
  { key: 'thinking', label: 'thinking', cls: 'thinking' },
  { key: 'waiting', label: 'need you', cls: 'waiting' },
  { key: 'blocked', label: 'blocked', cls: 'blocked' },
  { key: 'celebrating', label: 'shipped', cls: 'done' },
  { key: 'agents', label: 'crew', cls: 'idle' },
]

export class Hud {
  constructor(root, settings, actions) {
    this.settings = settings
    this.actions = actions
    this.visible = true
    this._last = {}
    this.hiddenOpen = false

    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = TEMPLATE
    root.appendChild(this.el)

    this.$ = (sel) => this.el.querySelector(sel)

    this._buildStats()
    this._buildSettings()
    this._buildAvatar()
    this._wire()
    this.syncSettings()
  }

  // ── construction ────────────────────────────────────────────────────────────────────

  _buildStats() {
    const wrap = this.$('.stats')
    this.statEls = {}
    for (const def of STAT_DEFS) {
      const b = document.createElement('button')
      b.className = `stat ${def.cls}`
      b.type = 'button'
      b.dataset.key = def.key
      b.title = `Jump to the next ${def.label} astronaut`
      b.innerHTML = `<i class="pip"></i><span class="n">0</span><span class="lbl">${def.label}</span>`
      b.type = 'button'
      b.addEventListener('click', () => this.actions.focusStatus?.(def.key))
      wrap.appendChild(b)
      this.statEls[def.key] = b
    }
  }

  _buildSettings() {
    const body = this.$('.settings .body')
    const s = this.settings
    this.controls = []

    // Quality presets.
    body.appendChild(
      group(
        'Quality preset',
        chips(
          Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, title: p.hint })),
          () => s.get('preset'),
          (id) => s.applyPreset(id),
          this.controls
        )
      )
    )

    // Performance.
    const perf = group('Performance')
    perf.append(
      this._toggle('HDR + bloom', 'bloom', 'Glowing eyes, lamps and windows. The first thing to drop.'),
      this._toggle('Tilt-shift', 'tiltShift', 'A shallow depth of field, which is what makes the colony read as a model.'),
      this._slider(
        'Tilt-shift blur',
        'tiltShiftStrength',
        0,
        1,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        'Aperture: how shallow the focus is, and how far out of it things go.'
      ),
      this._slider(
        'Tilt-shift angle',
        'tiltShiftAngle',
        -90,
        90,
        1,
        (v) => `${v}°`,
        'Swings the plane of focus, the way tilting a real lens does.'
      ),
      this._select('Shadows', 'shadows', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Particles', 'particles', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['full', 'Full'],
      ]),
      this._select('Textures', 'textureQuality', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Ground detail', 'groundDetail', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
      ]),
      this._toggle('Anti-aliasing', 'antialias', 'SMAA pass. Cheap, but not free.'),
      this._slider(
        'Render scale',
        'renderScale',
        0.35,
        2,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        '100% is your display’s own resolution, retina included.'
      ),
      this._toggle('Adaptive quality', 'autoQuality', 'Quietly drops render scale if frames get expensive.'),
      this._slider('Scatter', 'scatterDensity', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._slider('Max crew', 'maxAgents', 10, 200, 10, (v) => String(v)),
      this._toggle('Stars', 'stars')
    )
    body.appendChild(perf)

    // World.
    const world = group('Planet')
    const planets = document.createElement('div')
    planets.className = 'planets'
    for (const id of PLANETS_ORDER) {
      const planet = PLANETS[id]
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'planet'
      b.title = planet.blurb
      const c1 = hex(planet.ground.high)
      const c2 = hex(planet.ground.low)
      b.innerHTML = `<i class="orb" style="background:radial-gradient(circle at 33% 30%, ${c1}, ${c2})"></i><span>${planet.name}</span>`
      b.addEventListener('click', () => this.settings.set('planet', id))
      planets.appendChild(b)
      this.controls.push({ el: b, sync: () => b.setAttribute('aria-pressed', String(this.settings.get('planet') === id)) })
    }
    world.appendChild(planets)
    body.appendChild(world)

    // Lighting.
    const light = group('Lighting')
    light.append(
      chips(
        // `Live` is a time of day like the others from where you are standing, so it belongs
        // in the same row rather than in a toggle further down.
        [...TIMES.map((t) => ({ id: t.id, label: t.label })), { id: 'live', label: 'Live' }],
        () => (this.settings.get('clockTime') ? 'live' : nearestTime(this.settings.get('timeOfDay'))),
        (id) => {
          this.settings.set('autoTime', false)
          this.settings.set('clockTime', id === 'live')
          if (id === 'live') this.settings.set('timeOfDay', systemTimeOfDay())
          else this.settings.set('timeOfDay', TIMES.find((t) => t.id === id).value)
        },
        this.controls
      ),
      this._slider('Time of day', 'timeOfDay', 0, 1, 0.005, clockLabel, undefined, () => {
        // Reaching for the slider is a request for a particular light, so stop following the
        // clock — otherwise the next frame would drag the thumb straight back.
        this.settings.set('clockTime', false)
      }),
      this._toggle(
        'Cycle day/night',
        'autoTime',
        'Runs the clock forward on its own. Ignored while the sky is following this machine’s clock.'
      ),
      this._slider('Cycle length', 'dayLength', 30, 900, 30, (v) => `${Math.round(v / 60)}m`),
      this._toggle(
        'Environment light',
        'ibl',
        'Image-based lighting taken from this planet’s own sky. Metals get something to reflect.'
      ),
      this._slider('Environment', 'iblIntensity', 0, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Exposure', 'exposure', 0.4, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Bloom', 'bloomStrength', 0, 1.6, 0.02, (v) => v.toFixed(2))
    )
    body.appendChild(light)

    // View.
    const view = group('View')
    view.append(
      this._toggle(
        'Hide dormant repos',
        'hideDormant',
        'Takes a repo off the map when every thread in it has been quiet for three days. Its threads are untouched, and it comes back to the same ground the moment one wakes up.'
      ),
      this._buildAutoArchive()
    )
    view.append(
      this._toggle('Return to isometric', 'autoFrame', 'Eases the angle back when you stop dragging.'),
      this._slider('Field of view', 'fov', 20, 60, 1, (v) => `${v}°`),
      this._toggle('Project labels', 'showLabels'),
      this._toggle(
        'Color zones by model',
        'modelHeatmap',
        'Adds a swatch for each repo\u2019s dominant model beside its name, with a legend under the repo list.'
      ),
      this._toggle('Reduced motion', 'reducedMotion', 'Calms the bobbing and the camera easing.'),
      this._toggle('Show FPS', 'showFps')
    )
    body.appendChild(view)
  }

  _row(label, hint) {
    const row = document.createElement('div')
    row.className = 'row'
    const l = document.createElement('div')
    l.className = 'label'
    l.innerHTML = `<span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`
    row.appendChild(l)
    return row
  }

  /**
   * Auto-archive: a toggle plus its “after how many days” detail row, shown only while the
   * toggle is on. The number is clamped to the input's own bounds before it is saved, so a
   * hand-typed 5 or 9999 lands on the nearest real setting rather than on nonsense.
   */
  _buildAutoArchive() {
    const wrap = document.createElement('div')
    wrap.append(
      this._toggle(
        'Auto-archive dormant sessions',
        'autoArchive',
        'Sessions that have been quiet for the chosen number of days are archived for you — they leave the map and head home, exactly as if you archived them by hand.'
      )
    )

    const detail = document.createElement('div')
    detail.className = 'setting-detail'
    const label = document.createElement('label')
    label.textContent = 'After '
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '7'
    input.max = '365'
    input.step = '1'
    label.appendChild(input)
    label.appendChild(document.createTextNode(' days dormant'))
    detail.appendChild(label)
    wrap.appendChild(detail)

    input.addEventListener('change', () => {
      const n = Math.max(7, Math.min(365, Math.round(Number(input.value)) || 30))
      if (Number(input.value) !== n) input.value = String(n)
      this.settings.set('autoArchiveDays', n)
    })
    this.controls.push({
      el: detail,
      sync: () => {
        detail.hidden = !this.settings.get('autoArchive')
        if (document.activeElement !== input) input.value = String(this.settings.get('autoArchiveDays') ?? 30)
      },
    })
    return wrap
  }

  _toggle(label, key, hint) {
    const row = this._row(label, hint)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'toggle'
    b.setAttribute('role', 'switch')
    b.addEventListener('click', () => this.settings.set(key, !this.settings.get(key)))
    row.appendChild(b)
    this.controls.push({
      el: row,
      sync: () => {
        b.setAttribute('aria-checked', String(Boolean(this.settings.get(key))))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _select(label, key, options, hint) {
    const row = this._row(label, hint)
    const sel = document.createElement('select')
    sel.className = 'select'
    for (const [value, text] of options) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => this.settings.set(key, sel.value))
    row.appendChild(sel)
    this.controls.push({
      el: row,
      sync: () => {
        sel.value = String(this.settings.get(key))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _slider(label, key, min, max, step, format, hint, onInput) {
    const row = this._row(label, hint)
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px'
    const input = document.createElement('input')
    input.type = 'range'
    input.className = 'slider'
    input.min = min
    input.max = max
    input.step = step
    const out = document.createElement('span')
    out.className = 'value'
    input.addEventListener('input', () => {
      onInput?.()
      this.settings.set(key, Number(input.value))
    })
    wrap.append(input, out)
    row.appendChild(wrap)
    this.controls.push({
      el: row,
      sync: () => {
        const v = Number(this.settings.get(key))
        // Never fight the thumb the user is dragging.
        if (document.activeElement !== input) input.value = String(v)
        out.textContent = format(v)
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  /** The little face on the agent card, drawn from the same atlas the astronauts use. */
  _buildAvatar() {
    const canvas = this.$('.thread-pop .avatar canvas')
    canvas.width = 108
    canvas.height = 108
    this.avatarCtx = canvas.getContext('2d')
    this.avatarTmp = document.createElement('canvas')
    this.avatarTmp.width = 108
    this.avatarTmp.height = 108
    this.avatarTmpCtx = this.avatarTmp.getContext('2d')
    this._avatarState = { frame: -1, color: '' }
  }

  _wire() {
    const on = (sel, ev, fn) => this.$(sel).addEventListener(ev, fn)

    on('#btn-settings', 'click', () => this.toggleSettings())
    on('#btn-close-settings', 'click', () => this.toggleSettings(false))
    on('#btn-search', 'click', () => this.toggleSearch())
    on('#btn-close-search', 'click', () => this.toggleSearch(false))
    on('#btn-timeline', 'click', () => this.toggleTimeline())
    on('#btn-close-timeline', 'click', () => this.toggleTimeline(false))
    on('#btn-hide', 'click', () => this.toggleUi())
    on('#btn-help', 'click', () => this.toggleHelp())
    on('#btn-shot', 'click', () => this.actions.screenshot?.())
    on('#btn-home', 'click', () => this.actions.resetView?.())
    on('#btn-next', 'click', () => this.actions.focusStatus?.('waiting'))
    on('#btn-orbit', 'click', () => this.setOrbit(this.actions.toggleOrbit?.()))
    on('#btn-planet', 'click', () => this.actions.cyclePlanet?.())
    on('#btn-time', 'click', () => this.actions.cycleTime?.())
    on('#btn-open', 'click', () => this.actions.openThread?.())
    on('#btn-viewed', 'click', () => this.actions.markViewed?.())
    on('#btn-archive', 'click', () => this.actions.archiveThread?.())
    on('#btn-deselect', 'click', () => this.actions.select?.(null))
    on('#btn-new-session', 'click', () => this.actions.newConversation?.())
    on('#btn-reveal', 'click', () => this.actions.revealProject?.())
    on('#btn-copy-path', 'click', () => this.actions.copyProjectPath?.())
    on('#btn-hide-project', 'click', () => this.actions.hideProject?.())
    on('#btn-hidden-toggle', 'click', () => this.toggleHiddenList())
    on('#btn-clear-filter', 'click', () => this._clearTimeFilter())
    on('#btn-locate', 'click', () => this.actions.focusProject?.(this.project?.name))
    on('#btn-close-project', 'click', () => this.actions.closeProject?.())
    on('.help', 'click', (e) => {
      if (e.target === this.$('.help')) this.toggleHelp(false)
    })
    this.$('.help .sheet').addEventListener('click', (e) => e.stopPropagation())
    on('#btn-help-close', 'click', () => this.toggleHelp(false))

    this.settings.onChange(() => this.syncSettings())

    this._wireSearch()
    this._wireTimeline()
  }

  // ── session search ─────────────────────────────────────────────────────────────────

  /**
   * The search box: debounced queries against the server's last scan, results rendered as
   * a scrollable list. The query never runs for fewer than two characters, and a reply that
   * arrives after the input has moved on is dropped — a slower early query overwriting a
   * newer one's results is the kind of thing that reads as the search being broken.
   */
  _wireSearch() {
    const input = this.$('#search-input')
    const resultsEl = this.$('.search-results')
    let timer = 0

    input.addEventListener('input', () => {
      clearTimeout(timer)
      const q = input.value.trim()
      if (!q) {
        resultsEl.innerHTML = ''
        return
      }
      timer = setTimeout(async () => {
        const results = (await this.actions.search?.(q)) || []
        if (input.value.trim() !== q) return
        this._renderSearchResults(results, q)
      }, 300)
    })

    input.addEventListener('keydown', (e) => {
      // The page's own Escape handler steps aside for anything typed into (the guard on
      // HTMLInputElement in main.js), so the field closes itself — and stops the event so
      // the same press cannot also deselect an astronaut behind the panel.
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.toggleSearch(false)
      }
      // Enter takes the first result, the way every search box behaves.
      if (e.key === 'Enter') {
        const first = resultsEl.querySelector('.result')
        if (first) first.click()
      }
    })
  }

  /** Results as a scrollable list — title, project, model, and how long since it moved. */
  _renderSearchResults(results, q) {
    const resultsEl = this.$('.search-results')
    resultsEl.innerHTML = ''
    if (!results.length) {
      const empty = document.createElement('div')
      empty.className = 'search-empty'
      empty.textContent = `No sessions match “${q}”`
      resultsEl.appendChild(empty)
      return
    }
    for (const r of results) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'result'
      const meta = [r.project, r.model ? shortModel(r.model) : '', ago(r.lastActivityAt)]
        .filter(Boolean)
        .map((s) => escapeHtml(s))
        .join(' · ')
      b.innerHTML =
        `<div class="result-title">${escapeHtml(r.title || 'Untitled session')}</div>` +
        `<div class="result-meta">${meta}</div>`
      b.addEventListener('click', () => this.actions.selectSearchResult?.(r))
      resultsEl.appendChild(b)
    }
  }

  toggleSearch(force) {
    const panel = this.$('.search-panel')
    const open = force ?? panel.classList.contains('closed')
    panel.classList.toggle('closed', !open)
    this.$('#btn-search').setAttribute('aria-pressed', String(open))
    if (open) {
      const input = this.$('#search-input')
      input.value = ''
      this.$('.search-results').innerHTML = ''
      input.focus()
    }
  }

  // ── activity timeline ────────────────────────────────────────────────────────────────

  /**
   * The timeline panel: preset ranges, a custom from/to pair, and a grid rebuilt whenever
   * either moves. Presets are simple offsets from now; “All” asks from the distant past and
   * lets the server's own list say where the data actually begins. Every range change also
   * drives the colony's time filter, so the heatmap and the world always agree about which
   * slice of time you are looking at.
   */
  _wireTimeline() {
    for (const b of this.el.querySelectorAll('.timeline-panel [data-range]')) {
      b.addEventListener('click', () => {
        this.timelineRange = b.dataset.range
        this._syncTimelineControls()
        this._applyTimelineFilter()
        this._loadTimeline()
      })
    }
    const custom = () => {
      this.timelineRange = 'custom'
      this._syncTimelineControls()
      this._applyTimelineFilter()
      this._loadTimeline()
    }
    this.$('#timeline-from').addEventListener('change', custom)
    this.$('#timeline-to').addEventListener('change', custom)
    this.timelineRange = '30d'
  }

  /**
   * Push the panel's range at the colony as well as the heatmap. A preset or custom range
   * becomes the colony's window; “All” clears the filter entirely — the live view, where a
   * session that starts a second from now walks down the ramp on the next poll, which a
   * filter spanning all time never would.
   */
  _applyTimelineFilter() {
    if (this.timelineRange === 'all') {
      this._filterRange = null
      this.actions.setTimeFilter?.(null)
    } else {
      const { from, to } = this._timelineWindow()
      this._filterRange = { from, to }
      this.actions.setTimeFilter?.(from, to)
    }
    this._syncFilterBadge()
  }

  /**
   * The badge's ✕: exactly what pressing “All” in the panel does, from anywhere. Widening
   * the heatmap too keeps the two views honest about the same range.
   */
  _clearTimeFilter() {
    this.timelineRange = 'all'
    this._syncTimelineControls()
    this._applyTimelineFilter()
    if (!this.$('.timeline-panel').classList.contains('closed')) this._loadTimeline()
  }

  /** The badge that says the colony is a slice of time, not the live thing. */
  _syncFilterBadge() {
    const badge = this.$('#time-filter-badge')
    if (!this._filterRange) {
      badge.hidden = true
      return
    }
    badge.hidden = false
    this.$('#time-filter-label').textContent = `Showing: ${this._filterLabel(this._filterRange)}`
  }

  /** Presets read as their own name; anything else reads as the dates it spans. */
  _filterLabel({ from, to }) {
    const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    if (dayKey(from) === dayKey(to)) {
      return from.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86400000)
    if (Math.abs(days - 7) <= 1) return 'Last 7 days'
    if (Math.abs(days - 30) <= 1) return 'Last 30 days'
    if (Math.abs(days - 90) <= 1) return 'Last 90 days'
    const year = from.getFullYear() !== to.getFullYear() ? ` ${to.getFullYear()}` : ''
    return `${fmt(from)} – ${fmt(to)}${year}`
  }

  /** Presets light their own button; a custom range lights none of them. */
  _syncTimelineControls() {
    for (const b of this.el.querySelectorAll('.timeline-panel [data-range]')) {
      b.classList.toggle('active', b.dataset.range === this.timelineRange)
    }
  }

  toggleTimeline(force) {
    const panel = this.$('.timeline-panel')
    const open = force ?? panel.classList.contains('closed')
    panel.classList.toggle('closed', !open)
    this.$('#btn-timeline').setAttribute('aria-pressed', String(open))
    if (open) this._loadTimeline()
  }

  /** The window the panel is currently looking at, as local Dates. */
  _timelineWindow() {
    const to = new Date()
    if (this.timelineRange === 'all') return { from: new Date(2000, 0, 1), to }
    if (this.timelineRange === 'custom') {
      const from = parseDateInput(this.$('#timeline-from').value)
      const customTo = parseDateInput(this.$('#timeline-to').value)
      return {
        from: from || new Date(to.getTime() - 30 * 86400000),
        to: customTo ? endOfDay(customTo) : to,
      }
    }
    const days = this.timelineRange === '7d' ? 7 : this.timelineRange === '90d' ? 90 : 30
    return { from: new Date(to.getTime() - days * 86400000), to }
  }

  /**
   * Fetch and draw. A reply that arrives after the range moved on is dropped by token, the
   * same rule the search box lives by — an older answer overwriting a newer one's grid is
   * what “the timeline is broken” looks like from the outside.
   */
  async _loadTimeline() {
    const token = (this._timelineToken = (this._timelineToken || 0) + 1)
    const { from, to } = this._timelineWindow()
    // Presets keep the date inputs honest — “30d” shows as real dates, and editing either
    // one switches to the custom range those two dates describe.
    if (this.timelineRange !== 'custom') {
      this.$('#timeline-from').value = toDateInput(from)
      this.$('#timeline-to').value = toDateInput(to)
    }
    const grid = this.$('.timeline-grid')
    const result = await this.actions.loadActivity?.(from.toISOString(), to.toISOString())
    if (token !== this._timelineToken) return
    if (!result || !result.buckets) {
      grid.innerHTML = ''
      const empty = document.createElement('div')
      empty.className = 'timeline-empty'
      empty.textContent = 'Could not read session activity'
      grid.appendChild(empty)
      return
    }
    this._renderTimeline(result.buckets, from, to)
    // Kept so a filter change can repaint the grid's highlights without refetching —
    // picking a day should move the outline, not blank the heatmap for a round trip.
    this._lastBuckets = { buckets: result.buckets, from, to }
  }

  /**
   * GitHub-style: a column per week, a row per weekday (Mon–Sun), one cell per day, tinted
   * by how many sessions moved that day. The server buckets hourly; a day is just the sum
   * of its hours, so the two views of the same data stay honest. While a colony filter is
   * active, the days it covers are outlined and the rest step back; every in-window day is
   * clickable, and picks that one day as the filter.
   */
  _renderTimeline(buckets, from, to) {
    const days = new Map()
    for (const [key, n] of Object.entries(buckets || {})) {
      const day = key.slice(0, 10)
      days.set(day, (days.get(day) || 0) + n)
    }
    const grid = this.$('.timeline-grid')
    grid.innerHTML = ''
    if (!days.size) {
      const empty = document.createElement('div')
      empty.className = 'timeline-empty'
      empty.textContent = 'No sessions in this range'
      grid.appendChild(empty)
      return
    }

    // The colony filter, when one is set: days inside it are outlined, days outside it dim.
    const filter = this._filterRange
    const filterFrom = filter ? startOfDay(filter.from).getTime() : 0
    grid.classList.toggle('filtered', Boolean(filter))

    let max = 1
    for (const n of days.values()) if (n > max) max = n

    // From the Monday on/before `from`, so the first column is always a whole week.
    const start = startOfDay(from)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
    const end = startOfDay(to)

    // Weekday gutter — Mon, Wed, Fri, the convention the shape comes from.
    const gutter = document.createElement('div')
    gutter.className = 'week-gutter'
    for (const label of ['M', '', 'W', '', 'F', '', '']) {
      const s = document.createElement('span')
      s.textContent = label
      gutter.appendChild(s)
    }
    grid.appendChild(gutter)

    const frag = document.createDocumentFragment()
    let lastMonth = -1
    for (let w = new Date(start); w <= end; w = new Date(w.getFullYear(), w.getMonth(), w.getDate() + 7)) {
      const week = document.createElement('div')
      week.className = 'week'
      const month = document.createElement('span')
      month.className = 'month-label'
      if (w.getMonth() !== lastMonth) {
        month.textContent = w.toLocaleString(undefined, { month: 'short' })
        lastMonth = w.getMonth()
      }
      week.appendChild(month)
      for (let i = 0; i < 7; i++) {
        const d = new Date(w.getFullYear(), w.getMonth(), w.getDate() + i)
        const cell = document.createElement('i')
        cell.className = 'day'
        if (d < startOfDay(from) || d > end) {
          // Outside the asked-for window: a placeholder keeps the column's shape without
          // claiming anything about days the range does not cover.
          cell.classList.add('out')
        } else {
          const n = days.get(dayKey(d)) || 0
          cell.style.background = HEAT_LEVELS[n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4))]
          cell.title = `${d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} — ${n} session${n === 1 ? '' : 's'}`
          // The day this cell is, for the click that filters the colony to it.
          cell.dataset.date = dayKey(d)
          if (filter) {
            cell.classList.toggle('in-range', d.getTime() >= filterFrom && d.getTime() <= filter.to.getTime())
          }
          cell.addEventListener('click', () => this._pickTimelineDay(d))
        }
        week.appendChild(cell)
      }
      frag.appendChild(week)
    }
    grid.appendChild(frag)
  }

  /**
   * Clicking a day filters the colony to that one day. The heatmap keeps its window —
   * seeing which slice you picked is the point — so the grid repaints from the data
   * already in hand and only the highlight moves. The date inputs follow, because they
   * describe the filter; the next range change realigns everything.
   */
  _pickTimelineDay(d) {
    const from = startOfDay(d)
    const to = endOfDay(d)
    this.timelineRange = 'custom'
    this.$('#timeline-from').value = toDateInput(from)
    this.$('#timeline-to').value = toDateInput(to)
    this._syncTimelineControls()
    this._filterRange = { from, to }
    this.actions.setTimeFilter?.(from, to)
    this._syncFilterBadge()
    if (this._lastBuckets) {
      this._renderTimeline(this._lastBuckets.buckets, this._lastBuckets.from, this._lastBuckets.to)
    }
  }

  // ── state in ────────────────────────────────────────────────────────────────────────

  syncSettings() {
    for (const c of this.controls) c.sync()
    this.$('.fps').classList.toggle('on', Boolean(this.settings.get('showFps')))
  }

  setStats(stats) {
    for (const def of STAT_DEFS) {
      const n = stats[def.key] ?? 0
      const el = this.statEls[def.key]
      if (this._last['stat:' + def.key] === n) continue
      this._last['stat:' + def.key] = n
      el.querySelector('.n').textContent = String(n)
      el.dataset.empty = String(n === 0)
    }
  }

  /**
   * Every repo, in the sidebar. This was a strip of chips along the bottom of the screen;
   * it is a list now because the sidebar is where all the chrome lives, and because a list
   * can carry a count and an alarm without running out of room at eleven repos.
   */
  setLegend(projects, activeName = null, hidden = [], folded = []) {
    const heat = Boolean(this.settings.get('modelHeatmap'))
    const signature =
      projects
        .map((p) => `${p.name}:${p.count}:${p.accent}:${p.urgent ? 1 : 0}:${heat ? p.modelColor ?? 0 : 0}`)
        .join('|') +
      `~${activeName}~${heat ? 1 : 0}` +
      hidden.map((p) => `${p.name}:${p.count}`).join('|') +
      `~${folded.length}`
    if (this._last.legend === signature) return
    this._last.legend = signature

    const wrap = this.$('.projects')
    wrap.innerHTML = ''
    for (const p of projects) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'repo'
      b.title = `${p.count} thread${p.count === 1 ? '' : 's'} in ${p.name}`
      b.setAttribute('aria-pressed', String(p.name === activeName))
      // With the model heatmap on, a second swatch beside the name says what the repo
      // thinks with; the zone's own accent stays put, because it is how you find the repo
      // on the map in the first place.
      b.innerHTML =
        `<i class="swatch" style="background:${hex(p.accent)};color:${hex(p.accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        (heat && p.modelColor != null
          ? `<i class="model-swatch" style="background:${hex(p.modelColor)};color:${hex(p.modelColor)}" title="${escapeHtml(modelLabel(p.model))}"></i>`
          : '') +
        (p.urgent ? '<i class="alarm"></i>' : '') +
        `<span class="count">${p.count}</span>`
      b.addEventListener('click', () => this.actions.pickProject?.(p.name))
      wrap.appendChild(b)
    }
    this.$('.sec-head span').textContent = `${projects.length} repo${projects.length === 1 ? '' : 's'}`

    // The heatmap's own legend: one line of model → colour pairs, built from the zones
    // actually on the map rather than a fixed list that might name models nobody ran.
    this._renderModelLegend(heat ? projects : [])

    // The hidden list is its own block at the foot of the sidebar: collapsed by default, because
    // the whole point of hiding a repo is not to look at it.
    const block = this.$('.hidden-block')
    block.hidden = hidden.length === 0 && folded.length === 0
    const hiddenWrap = this.$('.hidden-projects')
    hiddenWrap.innerHTML = ''
    for (const p of hidden) {
      const accent = PLOT_PALETTE[hashString(p.name) % PLOT_PALETTE.length]
      const row = document.createElement('div')
      row.className = 'repo hidden-repo'
      row.innerHTML =
        `<i class="swatch" style="background:${hex(accent)};color:${hex(accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        `<span class="count">${p.count}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = `Show ${p.name} on the map again`
      show.textContent = 'Show'
      show.addEventListener('click', () => this.actions.unhideProject?.(p.name))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    // The dormant fold gets one line rather than a row each: it is a setting, not a list of
    // decisions, and the thing worth offering is the way back rather than per-repo control.
    if (folded.length) {
      const n = folded.reduce((sum, p) => sum + p.count, 0)
      const row = document.createElement('div')
      row.className = 'repo hidden-repo folded-note'
      row.innerHTML =
        `<span class="n">${folded.length} quiet repo${folded.length === 1 ? '' : 's'}` +
        `, ${n} thread${n === 1 ? '' : 's'}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = 'Put dormant repos back on the map'
      show.textContent = 'Show'
      show.addEventListener('click', () => this.settings.set('hideDormant', false))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    const total = hidden.length + folded.length
    this.$('#btn-hidden-toggle .label').textContent = `${total} off the map`
    this._syncHiddenList()
  }

  toggleHiddenList() {
    this.hiddenOpen = !this.hiddenOpen
    this._syncHiddenList()
  }

  /**
   * The model → colour pairs for the heatmap, one entry per distinct model actually on the
   * map. Hidden entirely (not just emptied) when the heatmap is off, so the sidebar's foot
   * is only ever chrome that is doing something.
   */
  _renderModelLegend(projects) {
    const el = this.$('.model-legend')
    el.innerHTML = ''
    const seen = new Map()
    for (const p of projects) {
      if (p.modelColor == null || !p.model) continue
      const key = `${p.model}|${p.modelColor}`
      if (!seen.has(key)) seen.set(key, { color: p.modelColor, model: p.model })
    }
    el.hidden = seen.size === 0
    for (const { color, model } of seen.values()) {
      const row = document.createElement('div')
      row.innerHTML = `<i style="background:${hex(color)}"></i>${escapeHtml(modelLabel(model))}`
      el.appendChild(row)
    }
  }

  _syncHiddenList() {
    this.$('#btn-hidden-toggle').setAttribute('aria-expanded', String(this.hiddenOpen))
    this.$('.hidden-projects').hidden = !this.hiddenOpen
  }

  /**
   * The project sidebar: what a zone is, and the things you can do to the *repo* rather
   * than to one thread in it. Opened by clicking a zone, its name plate, its legend chip,
   * or any astronaut standing on it.
   */
  setProject(project) {
    const panel = this.$('.side')
    if (!project) {
      this.project = null
      if (this._last.project === null) return
      this._last.project = null
      panel.classList.remove('drilled')
      return
    }

    this.project = project
    // The minute is part of the signature because `ago()` is: without it a repo where
    // nothing is happening keeps whatever "4m ago" it was first drawn with, for as long as
    // you leave the panel open.
    const signature =
      `${project.name}~${project.path}~${project.accent}~${project.selectedId}~${Math.floor(Date.now() / 60000)}~` +
      project.threads.map((t) => `${t.id}:${t.status}:${t.title}:${t.lastActivityAt}`).join('|')
    panel.classList.add('drilled')
    if (this._last.project === signature) return
    this._last.project = signature

    const swatch = this.$('.side .who .swatch')
    swatch.style.background = hex(project.accent)
    swatch.style.color = hex(project.accent) // the halo is `currentColor`
    this.$('.side .name').textContent = project.name
    const path = this.$('.side .path')
    path.textContent = project.path ? shortPath(project.path) : 'folder unknown'
    path.title = project.path || ''
    // Nothing to open a new thread in, and nothing to reveal, without a folder on disk.
    this.$('#btn-new-session').disabled = !project.path
    this.$('#btn-reveal').disabled = !project.path
    this.$('#btn-copy-path').disabled = !project.path

    const n = project.threads.length
    const waiting = project.threads.filter((t) => t.status === 'waiting' || t.status === 'blocked').length
    this.$('.side .threads-head').innerHTML =
      `<span>${n} thread${n === 1 ? '' : 's'}</span>` + (waiting ? `<span class="want">${waiting} need you</span>` : '')

    const list = this.$('.side .threads')
    // A poll rewrites these rows every time a live thread's timestamp moves. Losing your
    // place in a forty-thread repo every fifteen seconds would make the list unusable.
    const scroll = list.scrollTop
    list.innerHTML = ''
    for (const t of project.threads) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `thread ${statusClass(t.status)}`
      b.setAttribute('aria-pressed', String(t.id === project.selectedId))
      b.title = STATUS_LABEL[t.status] || t.status
      b.innerHTML =
        '<i class="pip"></i>' +
        `<span class="t">${escapeHtml(t.title || 'Untitled thread')}</span>` +
        `<span class="when">${ago(t.lastActivityAt)}</span>` +
        (t.worktree ? `<span class="wt">⑂ ${escapeHtml(t.worktree)}</span>` : '')
      b.addEventListener('click', () => this.actions.focusThread?.(t.id))
      list.appendChild(b)
      // A long repo can hide the astronaut you just clicked in the world. Scrolled by hand
      // rather than with `scrollIntoView`, which walks up the ancestors and will happily
      // scroll the *page* — and a page that can scroll at all is one keystroke away from
      // the whole HUD sitting sideways with nothing to put it back.
      if (t.id === project.selectedId && this._scrolledTo !== t.id) {
        this._scrolledTo = t.id
        const row = b
        requestAnimationFrame(() => {
          const top = row.offsetTop
          const bottom = top + row.offsetHeight
          if (top < list.scrollTop) list.scrollTop = top
          else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
        })
      }
    }
    list.scrollTop = scroll
    if (!project.selectedId) this._scrolledTo = null
  }

  /**
   * The selected thread, shown inside the zone sidebar rather than in a panel of its own —
   * one thread and its repo are the same context, and splitting them across the screen made
   * you look in two places to act on one astronaut.
   */
  setSelection(agent, thread) {
    const card = this.$('.thread-pop')
    // Only ever one accent button in the panel: whichever action is the immediate one.
    this.$('#btn-new-session').classList.toggle('primary', !agent || !thread)
    if (!agent || !thread) {
      card.classList.remove('on')
      this.selected = null
      // So the next pick of the same thread reloads its conversation rather than showing
      // the one from before — the panel is down, whatever it held is spent.
      this._transcriptId = null
      this._stopTranscriptTail()
      this.$('.transcript-live').hidden = true
      return
    }
    this.selected = { agent, thread }
    card.classList.add('on')

    this.$('.thread-pop .title').textContent = thread.title || 'Untitled thread'
    const status = STATUS_LABEL[agent.status] || agent.status
    const meta = this.$('.thread-pop .meta')
    const bits = [
      `<span class="tag"><i class="swatch" style="background:${hex(agent.trim.getHex())}"></i>${escapeHtml(status)}</span>`,
    ]
    // The repo is the panel's own heading now, so the card says what the *thread* is.
    if (thread.worktree) bits.push(`<span class="tag">⑂ ${escapeHtml(thread.worktree)}</span>`)
    if (thread.gitBranch) bits.push(`<span class="tag">${escapeHtml(thread.gitBranch)}</span>`)
    // The PR the session worked on, when the head named one — the number, with what
    // happened to it in the tooltip.
    if (thread.ref?.pr?.number) {
      const pr = thread.ref.pr
      const state =
        ({ MERGED: 'merged', APPROVED: 'approved', CLOSED: 'closed', DRAFT: 'draft' }[pr.state] || 'open')
      const title = escapeHtml(`PR #${pr.number}${pr.repo ? ` in ${pr.repo}` : ''} — ${state}`)
      bits.push(`<span class="tag pr-tag" title="${title}">#${escapeHtml(String(pr.number))}</span>`)
    }
    if (thread.model) bits.push(`<span class="tag">${escapeHtml(shortModel(thread.model))}</span>`)
    bits.push(`<span>${ago(thread.lastActivityAt)}</span>`)
    meta.innerHTML = bits.join('')

    const pct = Math.round((this.actions.progressFor?.(thread.id) ?? 0) * 100)
    this.$('.thread-pop .progress > i').style.width = `${pct}%`
    this.$('.thread-pop .progress > i').style.background = hex(agent.trim.getHex())
    // Measured once per selection rather than per frame: placing the card beside its
    // astronaut needs its size sixty times a second, and asking the layout for it that
    // often is how a HUD starts costing frames.
    this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
    this.$('#btn-open').disabled = thread.canOpen === false
    // Only offered when there is something to dismiss. A third button on every card would
    // crowd the two that are always worth having, and "Viewed" on a thread that is not asking
    // for anything is a control with no effect.
    this.$('#btn-viewed').hidden = !thread.unread
    this._setOpenLabel(thread)
    this._loadTranscript(thread)
    this._armTranscriptTail(thread)
  }

  /** The open button names where the thread will open — "Open in OpenClaw", not a bare "Open". */
  _setOpenLabel(thread) {
    const label = thread.harnessName ? `Open in ${thread.harnessName}` : 'Open'
    if (this._last.openLabel === label) return
    this._last.openLabel = label
    this.$('#btn-open .lbl').textContent = label
  }

  /**
   * The conversation itself, in the card.
   *
   * Fetched once per selection: `setSelection` runs again on every poll for as long as a
   * card is open, and rereading a transcript every fifteen seconds is a lot of disk for
   * nothing new. The fetch never blocks the selection — the card appears immediately with
   * its loading line, and the chat lands when it lands, re-measuring the card so it keeps
   * clearing its astronaut and the window edge at its new height.
   *
   * Every word of the conversation is untrusted text from a file, so it is escaped before
   * it touches `innerHTML` — the one place in this HUD that renders content it did not
   * write itself.
   */
  _loadTranscript(thread) {
    if (this._transcriptId === thread.id) return
    this._transcriptId = thread.id
    const card = this.$('.thread-pop')
    const messagesEl = this.$('.transcript-messages')
    const loadingEl = this.$('.transcript-loading')
    const emptyEl = this.$('.transcript-empty')
    const stale = () => this._transcriptId !== thread.id
    messagesEl.innerHTML = ''
    loadingEl.hidden = false
    emptyEl.hidden = true

    const pending = this.actions.loadTranscript?.(thread)
    if (!pending || typeof pending.then !== 'function') {
      loadingEl.hidden = true
      emptyEl.hidden = false
      return
    }
    pending.then((result) => {
      if (stale()) return
      loadingEl.hidden = true
      if (!result || !result.ok || !result.messages?.length) {
        emptyEl.hidden = false
        return
      }
      messagesEl.innerHTML = renderMessages(result.messages)
      // Newest at the bottom, like every chat you have ever read.
      this.$('.transcript').scrollTop = messagesEl.scrollHeight
      this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
    }).catch(() => {
      if (stale()) return
      loadingEl.hidden = true
      emptyEl.hidden = false
    })
  }

  /**
   * Live tail: a running or thinking session keeps its card's conversation fresh on its
   * own, so watching the card is watching the session. Re-armed on every poll —
   * `setSelection` runs again with fresh thread data, which is also what retires the tail
   * once the session goes quiet, without the interval having to guess at state itself.
   */
  _armTranscriptTail(thread) {
    this._stopTranscriptTail()
    const live = Boolean(thread.running || thread.thinking)
    this.$('.transcript-live').hidden = !live
    if (!live) return
    this._transcriptTail = setInterval(async () => {
      // Only the card being looked at pays for polling; a tick landing after the user has
      // moved on retires itself rather than rendering into a closed card.
      if (this.selected?.thread?.id !== thread.id) {
        this._stopTranscriptTail()
        return
      }
      let result
      try {
        result = await this.actions.loadTranscript?.(thread)
      } catch {
        return
      }
      if (this.selected?.thread?.id !== thread.id || !result?.ok || !result.messages?.length) return
      const scroller = this.$('.transcript')
      const messagesEl = this.$('.transcript-messages')
      // Follow the conversation only for someone already at the bottom — a reader scrolled
      // up through history keeps their place.
      const wasAtBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 20
      messagesEl.innerHTML = renderMessages(result.messages)
      this.$('.transcript-loading').hidden = true
      this.$('.transcript-empty').hidden = true
      if (wasAtBottom) scroller.scrollTop = messagesEl.scrollHeight
      // The card's height is cached for placement, and the conversation just grew.
      const card = this.$('.thread-pop')
      this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
    }, 3000)
  }

  _stopTranscriptTail() {
    if (this._transcriptTail) {
      clearInterval(this._transcriptTail)
      this._transcriptTail = null
    }
  }

  /**
   * Put the thread card beside its own astronaut, in screen space, every frame.
   *
   * `screen` is where the astronaut is right now, in CSS pixels, or null when it is behind
   * the camera. The card prefers the astronaut's right, flips to its left rather than slide
   * under the sidebar, and never leaves the window — so it stays reachable at any zoom
   * without ever covering the thing it is describing.
   */
  placeCard(screen) {
    const el = this.$('.thread-pop')
    if (!screen || !this.selected) {
      if (this._cardOn) {
        this._cardOn = false
        el.classList.remove('on')
      }
      return
    }
    const size = this._cardSize || { w: 280, h: 150 }
    const margin = 12
    const gap = 26
    const rightWall = window.innerWidth - margin - (this._sideWidth || 0)

    let flip = false
    let left = screen.x + gap
    if (left + size.w > rightWall) {
      left = screen.x - gap - size.w
      flip = true
      // Nowhere to go on either side — sit over the middle rather than off the edge.
      if (left < margin) left = Math.min(Math.max(margin, screen.x - size.w / 2), rightWall - size.w)
    }
    const top = Math.min(Math.max(margin, screen.y - size.h / 2), window.innerHeight - margin - size.h)

    if (!this._cardOn) {
      this._cardOn = true
      el.classList.add('on')
    }
    // Whole pixels, and only when it actually moved: a transform written every frame with a
    // fractional delta is a repaint the compositor cannot skip.
    const x = Math.round(left)
    const y = Math.round(top)
    if (x !== this._cardX || y !== this._cardY) {
      this._cardX = x
      this._cardY = y
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // The nib points back at the astronaut, so it changes sides with the card.
    if (flip !== this._cardFlip) {
      this._cardFlip = flip
      el.classList.toggle('flip', flip)
    }
    // And it tracks the astronaut vertically when the card has been pushed off-centre.
    const nib = Math.min(Math.max(14, screen.y - y), size.h - 14)
    if (nib !== this._cardNib) {
      this._cardNib = nib
      el.style.setProperty('--nib-y', `${Math.round(nib)}px`)
    }
  }

  /** How much of the right-hand edge the sidebar is taking, so the card can avoid it. */
  setSideWidth(px) {
    this._sideWidth = px
  }

  /** Redraw the card's face so it blinks in step with the astronaut it belongs to. */
  updateAvatar(faceAtlasCanvas) {
    if (!this.selected || !faceAtlasCanvas) return
    const agent = this.selected.agent
    const frame = agent.faceFrame ?? FACE.idle
    const color = agent.eye
    const css = cssFromGlow(color)
    if (this._avatarState.frame === frame && this._avatarState.color === css) return
    this._avatarState = { frame, color: css }

    const size = 108
    const cell = faceAtlasCanvas.width / FRAME_COLS
    const sx = (frame % FRAME_COLS) * cell
    const sy = Math.floor(frame / FRAME_COLS) * (faceAtlasCanvas.height / FRAME_ROWS)

    // The atlas is an opaque white-on-black mask, so the tint is a `multiply`, not a
    // `source-in`: black stays black and the white features take the eye colour. Keying on
    // alpha instead would flood the whole cell, because every pixel in it is opaque.
    const t = this.avatarTmpCtx
    t.globalCompositeOperation = 'source-over'
    t.clearRect(0, 0, size, size)
    t.drawImage(faceAtlasCanvas, sx, sy, cell, cell, 0, 0, size, size)
    t.globalCompositeOperation = 'multiply'
    t.fillStyle = css
    t.fillRect(0, 0, size, size)
    t.globalCompositeOperation = 'source-over'

    const c = this.avatarCtx
    c.fillStyle = '#06070c'
    c.fillRect(0, 0, size, size)
    c.drawImage(this.avatarTmp, 0, 0)
    // Scanlines, so the card's face reads as the same little screen as the one in the world.
    c.globalAlpha = 0.2
    c.fillStyle = '#000'
    for (let y = 0; y < size; y += 3) c.fillRect(0, y, size, 1)
    c.globalAlpha = 1
  }

  setFps(perf, viewport, extra) {
    if (!this.settings.get('showFps')) return
    const el = this.$('.fps')
    const fps = Math.round(perf.fps)
    if (this._last.fps === fps && this._last.calls === perf.drawCalls) return
    this._last.fps = fps
    this._last.calls = perf.drawCalls
    el.innerHTML =
      `<b>${fps}</b> fps · ${perf.frameMs.toFixed(1)} ms<br>` +
      `${perf.drawCalls} draws · ${(perf.triangles / 1000).toFixed(0)}k tris<br>` +
      // The setting is a share of the display, so the readout is too — otherwise a retina
      // machine sitting exactly on the 100% slider reads back "200%".
      `${viewport.bw}×${viewport.bh} (${Math.round((viewport.scale / (window.devicePixelRatio || 1)) * 100)}%)` +
      (extra ? `<br>${extra}` : '')
  }

  hint(text, ms = 3200) {
    const el = this.$('.hint-pill')
    el.textContent = text
    el.classList.add('on')
    clearTimeout(this._hintTimer)
    this._hintTimer = setTimeout(() => el.classList.remove('on'), ms)
  }

  toast(message, kind = '') {
    const el = document.createElement('div')
    el.className = `toast panel ${kind}`
    el.textContent = message
    this.$('.toasts').appendChild(el)
    setTimeout(() => {
      el.classList.add('leaving')
      setTimeout(() => el.remove(), 260)
    }, 3600)
  }

  // ── visibility ──────────────────────────────────────────────────────────────────────

  /** Reflect orbit mode on the rail button. */
  setOrbit(on) {
    this.$('#btn-orbit').setAttribute('aria-pressed', String(Boolean(on)))
  }

  toggleSettings(force) {
    const panel = this.$('.settings')
    const open = force ?? panel.classList.contains('closed')
    panel.classList.toggle('closed', !open)
    this.$('#btn-settings').setAttribute('aria-pressed', String(open))
    // Both live in the same slot on the right; the sidebar steps aside rather than hides.
    this.$('.side').classList.toggle('shifted', open)
  }

  toggleHelp(force) {
    const el = this.$('.help')
    const open = force ?? !el.classList.contains('open')
    el.classList.toggle('open', open)
  }

  /**
   * Dismiss everything. This is the mode the game is really meant to be left in — the
   * colony carries its own state above the astronauts' heads, so the panels are for
   * setting things up, not for playing.
   */
  toggleUi(force) {
    this.visible = force ?? !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    this.$('#btn-hide').innerHTML = this.visible ? ICON.eye : ICON.eyeOff
    this.actions.uiVisibility?.(this.visible)
    if (!this.visible) this.toggleHelp(false)
    return this.visible
  }

  removeBoot() {
    const boot = document.querySelector('.boot')
    if (!boot) return
    boot.classList.add('gone')
    setTimeout(() => boot.remove(), 550)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

function group(title, child) {
  const el = document.createElement('div')
  el.className = 'group'
  el.innerHTML = `<h3>${title}</h3>`
  if (child) el.appendChild(child)
  return el
}

function chips(items, current, onPick, registry) {
  const wrap = document.createElement('div')
  wrap.className = 'chips'
  const buttons = []
  for (const item of items) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = item.label
    if (item.title) b.title = item.title
    b.addEventListener('click', () => onPick(item.id))
    wrap.appendChild(b)
    buttons.push([item.id, b])
  }
  registry.push({
    el: wrap,
    sync: () => {
      const now = current()
      for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === now))
    },
  })
  return wrap
}

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6)
/**
 * Eye colours are authored above 1.0 so the bloom pass catches them in the scene. For the
 * card they are normalised by the brightest channel — which keeps the hue the astronaut
 * actually has rather than clipping a 3.0-red down to the same white as a 3.0-blue.
 */
function cssFromGlow(color) {
  const peak = Math.max(color.r, color.g, color.b, 1)
  const enc = (v) => Math.round(Math.pow(Math.min(1, v / peak), 1 / 2.2) * 255)
  return `rgb(${enc(color.r)},${enc(color.g)},${enc(color.b)})`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/**
 * One message row for the card's transcript — the one place that renders conversation
 * content, shared by the initial load and the live tail so the two never drift apart in
 * shape. Every word is untrusted text from a file, so it is escaped before it touches
 * `innerHTML`.
 */
function renderMessages(messages) {
  return messages
    .map((m) => {
      const cls = m.role === 'assistant' ? 'msg-assistant' : 'msg-user'
      const label = m.role === 'assistant' ? (m.model ? shortModel(m.model) : 'Assistant') : 'You'
      let text = String(m.text || '')
      if (text.length > 1500) text = `${text.slice(0, 1500)}…`
      const body = escapeHtml(text).replace(/\n/g, '<br>')
      const t = m.timestamp ? new Date(m.timestamp) : null
      const time = t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      const toolBadge = m.hasToolUse ? '<span class="tool-badge">⚒ used tools</span>' : ''
      return (
        `<div class="${cls}">` +
        `<div class="msg-header"><span class="msg-role">${escapeHtml(label)}</span>${toolBadge}<span class="msg-time">${time}</span></div>` +
        `<div class="msg-body">${body}</div>` +
        `</div>`
      )
    })
    .join('')
}

/** A model id a person would say — “Opus” rather than “anthropic/claude-opus-4-6”. */
function modelLabel(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('opus')) return 'Opus'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('haiku')) return 'Haiku'
  if (m.includes('glm')) return 'GLM'
  if (m.includes('deepseek')) return 'DeepSeek'
  if (m.includes('gemini')) return 'Gemini'
  if (m.includes('minimax')) return 'MiniMax'
  if (m.includes('qwen')) return 'Qwen'
  if (m.includes('kimi')) return 'Kimi'
  if (m.includes('gpt') || m.includes('o3')) return 'GPT'
  return shortModel(String(model)) || 'other'
}

// ── timeline helpers ───────────────────────────────────────────────────────────────────

/** The five steps a day cell can sit on: empty, then four of increasing intensity. */
const HEAT_LEVELS = [
  'rgba(200, 140, 100, 0.08)',
  'rgba(200, 140, 100, 0.28)',
  'rgba(200, 140, 100, 0.52)',
  'rgba(200, 140, 100, 0.76)',
  'rgba(200, 140, 100, 1)',
]

const pad2 = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
/** `YYYY-MM-DD` (a date input's value, or a server bucket key's prefix) → the same shape. */
const toDateInput = (d) => dayKey(d)

/** A date input's `YYYY-MM-DD` → a local Date, or null for anything else. */
function parseDateInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** Status → the colour family the top-bar counters already use for it. */
function statusClass(status) {
  if (status === 'working') return 'working'
  if (status === 'thinking') return 'thinking'
  if (status === 'waiting') return 'waiting'
  if (status === 'blocked') return 'blocked'
  if (status === 'celebrating') return 'done'
  return 'idle'
}

/**
 * A path that fits, trimmed from the *left* so the repo end survives — the deep end is the
 * part that identifies it. CSS can only ellipsise the tail, and `direction: rtl` mangles a
 * leading `~`, so the trim is done here and the whole path lives in the title attribute.
 */
function shortPath(dir, max = 30) {
  const home = dir.replace(/^\/Users\/[^/]+/, '~')
  if (home.length <= max) return home
  const parts = home.split('/')
  let out = parts.pop() || ''
  while (parts.length) {
    const next = parts.pop()
    if (out.length + next.length + 3 > max) break
    out = `${next}/${out}`
  }
  return `…/${out}`
}

function shortModel(model) {
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function clockLabel(t) {
  const total = t * 24 * 60
  const h = Math.floor(total / 60) % 24
  const m = Math.floor(total % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function nearestTime(value) {
  let best = TIMES[0]
  let bestD = Infinity
  for (const t of TIMES) {
    // Wrap-aware, so 0.99 is nearest to dawn rather than to noon.
    const d = Math.min(Math.abs(t.value - value), 1 - Math.abs(t.value - value))
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return bestD < 0.03 ? best.id : null
}

function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TEMPLATE = `
<aside class="side panel">
  <header class="brandbar">
    <div class="brand"><i class="dot"></i>Bot Crossing</div>
    <button class="btn icon ghost" id="btn-shot" title="Screenshot (P)">${ICON.camera}</button>
    <button class="btn icon ghost" id="btn-help" title="Help (?)">${ICON.help}</button>
    <button class="btn icon ghost" id="btn-timeline" title="Activity timeline (T)" aria-pressed="false">${ICON.calendar}</button>
    <button class="btn icon ghost" id="btn-search" title="Search sessions (F)" aria-pressed="false">${ICON.search}</button>
    <button class="btn icon ghost" id="btn-hide" title="Hide all UI (H)">${ICON.eye}</button>
    <button class="btn icon ghost" id="btn-settings" title="Settings (S)" aria-pressed="false">${ICON.settings}</button>
  </header>

  <div class="stats"></div>

  <div class="time-filter-badge" id="time-filter-badge" hidden>
    <span id="time-filter-label">Showing: last 30 days</span>
    <button type="button" class="btn icon ghost" id="btn-clear-filter" title="Show all time — back to the live colony">✕</button>
  </div>

  <div class="side-body">
    <div class="projects-pane">
      <div class="sec-head"><span>Repos</span></div>
      <div class="projects"></div>
      <div class="model-legend" hidden></div>
      <div class="hidden-block" hidden>
        <button type="button" class="hidden-toggle" id="btn-hidden-toggle" aria-expanded="false">
          <span class="label">0 hidden</span>
        </button>
        <div class="hidden-projects" hidden></div>
      </div>
    </div>

    <div class="project-detail">
      <button class="btn ghost back" id="btn-close-project" title="Back to every repo (Esc)">${ICON.back} All repos</button>
      <div class="who">
        <i class="swatch"></i>
        <div class="text">
          <div class="name"></div>
          <div class="path"></div>
        </div>
        <button class="btn icon ghost" id="btn-locate" title="Fly to this zone">${ICON.locate}</button>
      </div>
      <div class="project-actions">
        <button class="btn primary" id="btn-new-session" title="Start a new thread in this folder (C)">${ICON.plus} New conversation</button>
        <div class="pair">
          <button class="btn" id="btn-reveal" title="Show this folder in ${FILE_MANAGER}">${ICON.folder} ${FILE_MANAGER}</button>
          <button class="btn" id="btn-copy-path" title="Copy the folder path">${ICON.copy} Copy path</button>
        </div>
        <button class="btn" id="btn-hide-project" title="Hide this repo from the colony — does not archive its threads">${ICON.eyeOff} Hide from colony</button>
      </div>
      <div class="threads-head"></div>
      <div class="threads"></div>
    </div>
  </div>
</aside>

<div class="rail panel">
  <button class="btn icon" id="btn-home" title="Reset the view (0)">${ICON.home}</button>
  <button class="btn icon" id="btn-next" title="Next astronaut waiting on you (N)">${ICON.next}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-orbit" title="Orbit mode — sweep around the colony (O)" aria-pressed="false">${ICON.orbit}</button>
  <button class="btn icon" id="btn-planet" title="Change planet (Tab)">${ICON.globe}</button>
  <button class="btn icon" id="btn-time" title="Change the time of day (L)">${ICON.sun}</button>
</div>

<div class="settings panel closed">
  <header>Settings <button class="btn icon ghost" id="btn-close-settings" title="Close">${ICON.close}</button></header>
  <div class="body"></div>
</div>

<div class="search-panel panel closed">
  <div class="search-bar">
    <input type="text" id="search-input" placeholder="Search sessions…" autocomplete="off" spellcheck="false" />
    <button class="btn icon ghost" id="btn-close-search" title="Close (Esc)">${ICON.close}</button>
  </div>
  <div class="search-results"></div>
</div>

<div class="timeline-panel panel closed">
  <header>
    <span class="timeline-title">Activity Timeline</span>
    <div class="timeline-controls">
      <button type="button" class="btn small" data-range="7d">7d</button>
      <button type="button" class="btn small active" data-range="30d">30d</button>
      <button type="button" class="btn small" data-range="90d">90d</button>
      <button type="button" class="btn small" data-range="all">All</button>
      <input type="date" id="timeline-from" />
      <input type="date" id="timeline-to" />
    </div>
    <button class="btn icon ghost" id="btn-close-timeline" title="Close (Esc)">${ICON.close}</button>
  </header>
  <div class="timeline-grid"></div>
  <div class="timeline-legend">
    <span>Less</span>
    <i style="background:rgba(200,140,100,0.28)"></i>
    <i style="background:rgba(200,140,100,0.52)"></i>
    <i style="background:rgba(200,140,100,0.76)"></i>
    <i style="background:rgba(200,140,100,1)"></i>
    <span>More</span>
  </div>
</div>

<div class="thread-pop panel">
  <i class="nib"></i>
  <div class="top">
    <div class="avatar"><canvas></canvas></div>
    <div class="info">
      <div class="title"></div>
      <div class="meta"></div>
    </div>
    <button class="btn icon ghost" id="btn-deselect" title="Deselect (Esc)">${ICON.close}</button>
  </div>
  <div class="progress"><i></i></div>
  <div class="transcript">
    <div class="transcript-live" hidden>● LIVE</div>
    <div class="transcript-messages"></div>
    <div class="transcript-loading">Loading conversation…</div>
    <div class="transcript-empty">No messages in this session</div>
  </div>
  <div class="pair">
    <button class="btn primary" id="btn-open" title="Open this thread in the harness it came from (Enter)">${ICON.open} <span class="lbl">Open</span></button>
    <button class="btn" id="btn-viewed" title="Stop this thread asking for you until it moves on again (V)">${ICON.eye} Viewed</button>
    <button class="btn" id="btn-archive" title="Archive — this astronaut walks back to the ship (A)">${ICON.archive} Archive</button>
  </div>
</div>

<div class="toasts"></div>
<div class="fps panel"></div>
<div class="hint-pill panel"></div>

<div class="help">
  <div class="sheet panel">
    <h2>Bot Crossing</h2>
    <p class="sub">Every coding-agent thread on this machine is an astronaut. They walk out of the ship, claim a plot for their repo, and build. Click one to open its thread; click a zone — its deck or its name — for the repo itself, and start a new conversation there. Hide a repo from that panel if you would rather not see it — its threads stay in your harness, and you can show it again from the list. Navigation works like Google Earth — drag the ground itself, right-drag to tilt, scroll to zoom in on whatever is under the cursor.</p>
    <div class="cols">
      <div>
        <div class="k"><span>Drag the ground</span><kbd>drag</kbd></div>
        <div class="k"><span>Tilt &amp; rotate</span><kbd>right-drag</kbd></div>
        <div class="k"><span>&nbsp;</span><kbd>⌃ or ⇧ + drag</kbd></div>
        <div class="k"><span>Zoom to cursor</span><kbd>scroll</kbd></div>
        <div class="k"><span>Move / zoom</span><kbd>arrows</kbd> <kbd>+ −</kbd></div>
        <div class="k"><span>Reset view</span><kbd>0</kbd></div>
        <div class="k"><span>Hide all UI</span><kbd>H</kbd> <kbd>${IS_MAC ? '⌘' : 'Ctrl'}\\</kbd></div>
        <div class="k"><span>Settings</span><kbd>S</kbd></div>
        <div class="k"><span>Activity timeline</span><kbd>T</kbd></div>
        <div class="k"><span>Screenshot</span><kbd>P</kbd></div>
      </div>
      <div>
        <div class="k"><span>Next needing you</span><kbd>N</kbd></div>
        <div class="k"><span>Open thread</span><kbd>Enter</kbd></div>
        <div class="k"><span>Mark viewed</span><kbd>V</kbd></div>
        <div class="k"><span>Archive</span><kbd>A</kbd></div>
        <div class="k"><span>New conversation</span><kbd>C</kbd></div>
        <div class="k"><span>Search sessions</span><kbd>F</kbd> <kbd>/</kbd></div>
        <div class="k"><span>Orbit mode</span><kbd>O</kbd></div>
        <div class="k"><span>Change planet</span><kbd>Tab</kbd></div>
        <div class="k"><span>Time of day</span><kbd>L</kbd></div>
        <div class="k"><span>Deselect</span><kbd>Esc</kbd></div>
        <div class="k"><span>This sheet</span><kbd>?</kbd></div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="legend-row"><i class="badge" style="background:#1a2b46;color:#8fb4ee">?</i> waiting on your reply — click to open the thread</div>
      <div class="legend-row"><i class="badge" style="background:#3d1c1c;color:#e88b8b">!</i> the session hit an error</div>
      <div class="legend-row"><i class="badge" style="background:#16301f;color:#7fd39a">⚒</i> running right now, building</div>
      <div class="legend-row"><i class="badge" style="background:#2a1d3e;color:#b088e8">…</i> thinking — the model is processing</div>
      <div class="legend-row"><i class="badge" style="background:#332b12;color:#e6c67f">✓</i> its pull request landed</div>
      <div class="legend-row"><i class="badge" style="background:#1d1f2e;color:#a9a8c0">z</i> nothing for three days</div>
    </div>
    <div style="margin-top:18px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btn-help-close">Got it</button>
    </div>
  </div>
</div>
`
