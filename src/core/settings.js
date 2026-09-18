/**
 * Every knob that costs frames, in one place.
 *
 * Settings are a flat object so they serialise straight to localStorage, and everything
 * that reads them subscribes rather than polling — a change fires `onChange` with the set
 * of keys that moved, so the renderer can rebuild only what actually needs rebuilding.
 */

const STORE_KEY = 'botcrossing.settings.v1'

/**
 * What a fresh install opens on. Fixed rather than guessed from the device: `autoQuality`
 * scales the render buffer *under* whichever preset is chosen, so a slow machine is caught
 * by the governor within a second or two — which it does by measuring actual frame times
 * rather than by inferring speed from core counts.
 *
 * Only ever used when nothing is stored. An explicit choice always wins.
 */
export const DEFAULT_PRESET = 'balanced'

export const PRESETS = {
  potato: {
    label: 'Potato',
    hint: 'battery first — flat light, no extras',
    values: {
      renderScale: 0.5,
      shadows: 'off',
      bloom: false,
      antialias: false,
      particles: 'off',
      textureQuality: 'low',
      scatterDensity: 0.15,
      groundDetail: 'low',
      maxAgents: 40,
      stars: false,
      ibl: false,
      tiltShift: false,
      colorGrade: false,
      ambientOcclusion: 0,
      clouds: false,
      fauna: 'low',
    },
  },
  low: {
    label: 'Low',
    hint: 'for when you are on the go',
    values: {
      renderScale: 0.7,
      shadows: 'off',
      bloom: true,
      antialias: false,
      particles: 'low',
      textureQuality: 'low',
      scatterDensity: 0.35,
      groundDetail: 'low',
      maxAgents: 60,
      stars: true,
      ibl: false,
      tiltShift: false,
      colorGrade: true,
      ambientOcclusion: 0,
      clouds: true,
      fauna: 'low',
    },
  },
  balanced: {
    label: 'Balanced',
    hint: 'the default — looks good, runs cool',
    values: {
      renderScale: 1,
      shadows: 'low',
      bloom: true,
      antialias: false,
      particles: 'low',
      textureQuality: 'medium',
      scatterDensity: 0.6,
      groundDetail: 'medium',
      maxAgents: 90,
      stars: true,
      ibl: true,
      tiltShift: true,
      colorGrade: true,
      ambientOcclusion: 0.25,
      clouds: true,
      fauna: 'full',
    },
  },
  high: {
    label: 'High',
    hint: 'sharp shadows and a full sky',
    values: {
      renderScale: 1,
      shadows: 'high',
      bloom: true,
      antialias: true,
      particles: 'full',
      textureQuality: 'high',
      scatterDensity: 0.85,
      groundDetail: 'high',
      maxAgents: 140,
      stars: true,
      ibl: true,
      tiltShift: true,
      colorGrade: true,
      ambientOcclusion: 0.25,
      clouds: true,
      fauna: 'full',
    },
  },
  ultra: {
    label: 'Ultra',
    hint: 'everything on, plugged in',
    values: {
      renderScale: 1.5,
      shadows: 'ultra',
      bloom: true,
      antialias: true,
      particles: 'full',
      textureQuality: 'ultra',
      scatterDensity: 1,
      groundDetail: 'high',
      maxAgents: 200,
      stars: true,
      ibl: true,
      tiltShift: true,
      colorGrade: true,
      ambientOcclusion: 0.25,
      clouds: true,
      fauna: 'full',
    },
  },
}

export const SHADOW_SIZES = { off: 0, low: 1024, high: 2048, ultra: 4096 }
const TEXTURE_SIZES = { low: 256, medium: 512, high: 1024, ultra: 1024 }
const PARTICLE_BUDGET = { off: 0, low: 900, full: 3000 }

/**
 * The largest `maxAgents` any preset asks for. Anything sized once at boot — the badge buffers,
 * which are never rebuilt — allocates against this rather than against whatever preset happened
 * to be active, so raising quality later cannot outrun a buffer.
 */
export const MAX_AGENT_CAP = Math.max(...Object.values(PRESETS).map((p) => p.values.maxAgents || 0))

const DEFAULTS = {
  preset: 'balanced',
  ...PRESETS.balanced.values,

  // World
  planet: 'moon',
  /**
   * Fold away repos where every thread has been quiet for three days. On by default: with
   * several harnesses read at once the map otherwise fills with every checkout you have ever
   * opened, and the few repos actually being worked in get lost among them. It is reversible in
   * one click and a folded repo returns to the same ground the moment a thread wakes up.
   */
  hideDormant: true,
  timeOfDay: 0.32, // 0..1 — 0 is midnight, 0.5 is noon
  autoTime: false,
  /** Sky follows this machine's own clock. Wins over `autoTime`; both off is manual. */
  clockTime: false,
  dayLength: 240, // seconds for a full cycle when autoTime is on

  // Look
  exposure: 1.0,
  bloomStrength: 0.25,
  tiltShiftStrength: 0.2, // 0..1 — share of the effect's full blur radius (2% of frame height)
  tiltShiftAngle: 0, // degrees — 0 keeps the sharp band horizontal
  iblIntensity: 1.0,
  fov: 38,
  /**
   * How far the world bends away toward the horizon — Animal Crossing's little-round-world
   * look. 0 is flat. The bend is keyed off wherever the camera is looking, so the ground
   * under the cursor never moves; only the far side of the colony dips.
   */
  worldCurve: 0.45,
  /** The colour grade on top of tone mapping: saturation, a warm cast, and a soft vignette. */
  saturation: 1.0,
  vignette: 0.3,

  // Sound. On by default but silent until the first click — browsers insist — and every
  // layer has its own fader, because the one thing an always-open window must never do is
  // make a noise you cannot turn down.
  sound: true,
  masterVolume: 0.6,
  ambienceVolume: 0.8,
  effectsVolume: 0.8,

  // Behaviour
  autoQuality: true, // drop render scale when frames get expensive
  autoFrame: false, // ease the camera back to isometric when you stop dragging; opt-in
  // On by default: picking a bot is nearly always the start of watching it, and having to find
  // the toggle first meant the one you clicked had usually walked off before you got there.
  followSelected: true, // track the selected bot while retaining manual camera controls
  /** Set once when the follow default flipped on, so the migration never runs twice. */
  followDefaultOn: false,
  showFps: false,
  showLabels: true,
  reducedMotion: false,

  // Opening
  openIn: 'app', // 'app' | 'terminal' — the harness's desktop app, or its CLI in a new window
}

/** Keys whose change forces a full rebuild of the world (terrain, scatter, sky). */
const WORLD_KEYS = new Set(['planet', 'groundDetail', 'scatterDensity', 'stars'])
/** Keys that only need the renderer reconfigured. */
const RENDER_KEYS = new Set([
  'autoQuality',
  'renderScale',
  'shadows',
  'bloom',
  'antialias',
  'exposure',
  'bloomStrength',
  'tiltShift',
  'tiltShiftStrength',
  'tiltShiftAngle',
  'colorGrade',
  'saturation',
  'vignette',
  'ambientOcclusion',
])

export class Settings {
  constructor() {
    const stored = load()
    this.values = { ...DEFAULTS, ...stored }
    // An existing Low/Potato install should not inherit Balanced's new effect by accident.
    if (!Object.hasOwn(stored, 'ambientOcclusion')) {
      this.values.ambientOcclusion = PRESETS[this.values.preset]?.values.ambientOcclusion ?? DEFAULTS.ambientOcclusion
    }
    // Following the selected bot used to be opt-in, so every existing colony has `false` stored
    // against it and a changed default would never reach one. Turned on once, and remembered as
    // done — otherwise this would fight anybody who turns it back off, every single boot.
    if (!Object.hasOwn(stored, 'followDefaultOn')) {
      this.values.followSelected = true
      this.values.followDefaultOn = true
    }
    this.listeners = new Set()
    this._saveTimer = 0
  }

  get(key) {
    return this.values[key]
  }

  /** True when `key` currently differs from what the active preset specifies. */
  isOverridden(key) {
    const preset = PRESETS[this.values.preset]
    return Boolean(preset && key in preset.values && preset.values[key] !== this.values[key])
  }

  set(key, value) {
    if (this.values[key] === value) return
    this.values[key] = value
    // Touching any quality knob directly means you are no longer on a named preset.
    const preset = PRESETS[this.values.preset]
    if (preset && key in preset.values) this.values.preset = 'custom'
    this._emit([key])
  }

  applyPreset(name) {
    const preset = PRESETS[name]
    if (!preset) return
    const changed = []
    for (const [k, v] of Object.entries(preset.values)) {
      if (this.values[k] !== v) {
        this.values[k] = v
        changed.push(k)
      }
    }
    this.values.preset = name
    this._emit(changed.length ? changed : ['preset'])
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _emit(keys) {
    const changed = new Set(keys)
    const scope = {
      world: keys.some((k) => WORLD_KEYS.has(k)),
      render: keys.some((k) => RENDER_KEYS.has(k)),
    }
    for (const fn of this.listeners) fn(changed, scope, this.values)
    this._scheduleSave()
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.values))
      } catch {
        /* private mode, quota — the game just forgets between sessions */
      }
    }, 400)
  }

  /**
   * Adopt a whole saved set at once — the colony file's copy, when this browser has none of
   * its own. One emit rather than one per key, so the renderer is reconfigured once instead
   * of thirty times on the way in.
   */
  applyAll(values) {
    const incoming = { ...values }
    // The colony file may predate this setting too (for example, in a fresh browser).
    if (PRESETS[incoming.preset] && !Object.hasOwn(incoming, 'ambientOcclusion')) {
      incoming.ambientOcclusion = PRESETS[incoming.preset].values.ambientOcclusion
    }
    const changed = []
    for (const [key, value] of Object.entries(incoming)) {
      if (!(key in this.values) || this.values[key] === value) continue
      this.values[key] = value
      changed.push(key)
    }
    if (changed.length) this._emit(changed)
    return changed.length
  }

  // Convenience readers used all over the render code.
  get shadowSize() {
    return SHADOW_SIZES[this.values.shadows] || 0
  }
  get textureSize() {
    return TEXTURE_SIZES[this.values.textureQuality] || 512
  }
  get particleBudget() {
    return PARTICLE_BUDGET[this.values.particles] ?? 0
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function hasStoredSettings() {
  try {
    return Boolean(localStorage.getItem(STORE_KEY))
  } catch {
    return false
  }
}
