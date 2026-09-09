import { SOUNDS } from './sounds.js'
import { createNoiseBuffers, SampleVoice } from './synth.js'

/**
 * The colony's sound, built on the Web Audio API and nothing else.
 *
 * Three things are going on at once, kept deliberately independent of each other:
 *
 * 1. **Beds.** A planet names a few looping layers — wind, surf, insects. They cross-fade
 *    equal-power over three seconds when the world changes, and each blends between a day
 *    and a night level as the sun goes down.
 * 2. **Environment events.** One-shots on their own random timers — a gull, a distant
 *    rumble, an owl once it is dark. Nothing here is synchronised to anything else, which is
 *    what stops it turning into a pattern the ear learns.
 * 3. **Positional sources.** Things in the world make sound where they are. The camera is
 *    the listener, and every voice sits in a `PannerNode` with inverse distance rolloff, so
 *    zooming in on a site makes the hammering louder, the way a game engine does it. Only the
 *    nearest few are voiced at once; the rest fade in and out as the view moves.
 *
 * Everything routes master → { ambience bus, effects bus } → a gentle compressor → out, so
 * three events landing together cannot clip, and every level change is a ramp — an
 * always-open window will be muted forever after one click.
 *
 * Nothing audible happens before `unlock()`, which the browser's autoplay policy demands
 * anyway; this class hangs its own gesture listener on the document so the integrator can
 * forget about it. Without `AudioContext` at all — a test, a server render — every method
 * is a no-op rather than a throw.
 */

const BASE_URL = import.meta.env?.BASE_URL ?? '/'
const MANIFEST_PATH = 'audio/manifest.json'

/** How many positional voices can play at once. Enough that a busy colony hums; few enough that it is not a wall. */
export const MAX_VOICES = 10
/** Planet cross-fade, seconds. */
const BED_FADE = 3
/** Time constant of a positional fade — settles in about 0.4 s. */
const VOICE_TAU = 0.13
/** How long a fading-out voice is kept before its nodes are dropped; ~1% by then. */
const VOICE_STOP_DELAY = 0.6
/** Surf beds: full within this far of the shoreline, down to a distant wash beyond the other. */
const SHORE_NEAR = 14
const SHORE_FAR = 75
const SHORE_INLAND = 0.12
/** Synth → sample hand-over inside a running bed, seconds. */
const SWAP_FADE = 1.5
/** Distance band, around the listener, that ring-placed events land in. */
const RING = [10, 24]
const PANNER = { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 7, rolloffFactor: 1.15, maxDistance: 300 }

const EMPTY = Object.freeze([])
const NO_WORLD = Object.freeze({ night: 0, sources: EMPTY, water: null })
const HALF_PI = Math.PI / 2
/** What `play(name)` means with no options. Frozen: the event path has its own scratch object it mutates. */
const PLAY_DEFAULTS = Object.freeze({ gain: 1 })
const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export class Ambience {
  constructor(settings) {
    this.settings = settings
    this.ctx = null
    this.master = null
    this.mute = null
    this.compressor = null
    this.ambienceBus = null
    this.effectsBus = null

    this._enabled = this._flag('sound', true)
    this._visible = typeof document === 'undefined' ? true : !document.hidden
    this._planet = null
    /** The current bed group, and the ones on their way out. */
    this._beds = null
    this._retiring = []
    this._events = []
    /** Positional voices, at most MAX_VOICES, indexed both ways so the frame loop never iterates a Map. */
    this._pool = []
    this._byId = new Map()
    this._oneshots = []
    this._auditions = []
    this._buffers = new Map()
    this._manifest = null
    this._noise = null
    this._warned = new Set()
    this._sleepTimer = 0
    this._frame = 0
    this._sweepAt = 0
    this._night = -1
    // Ranking scratch, allocated once: the nearest candidates this frame, sorted.
    this._slots = []
    for (let i = 0; i < MAX_VOICES; i++) this._slots.push({ src: null, d: 0 })
    this._slotCount = 0
    /** Shore sources the engine makes for itself from the water points the integrator passes. */
    this._shore = []
    /** The surf beds' share of their level, by how far inland the view is. */
    this._shoreMix = 1
    /** Last frame's water, so a 'water' event can land on it. */
    this._water = null
    /** Reused argument objects for event placement — one for positional, one for 2D. */
    this._shot = { x: 0, y: 0, z: 0, gain: 1, kind: undefined }
    this._shot2d = { gain: 1, kind: undefined }
    // Listener state, kept so a still camera costs no automation calls at all.
    this._lx = 0
    this._ly = 0
    this._lz = 0
    this._fx = 0
    this._fy = 0
    this._fz = -1
    this._ux = 0
    this._uy = 1
    this._uz = 0
    this._listenerSet = false

    this._unsub = typeof settings?.onChange === 'function' ? settings.onChange((changed) => this._onSettings(changed)) : null

    if (typeof document !== 'undefined' && document.addEventListener) {
      // The first click or key anywhere is the gesture the autoplay policy wants; nobody
      // integrating this should have to remember to forward it.
      this._onGesture = () => this.unlock()
      document.addEventListener('pointerdown', this._onGesture, { passive: true })
      document.addEventListener('keydown', this._onGesture, { passive: true })
      this._onVisibility = () => {
        this._visible = !document.hidden
        this._applyMute()
      }
      document.addEventListener('visibilitychange', this._onVisibility)
    }

    // The manifest is fetched once, straight away; decoding waits for a context and for the
    // sound actually being asked for. A missing manifest is the normal case.
    if (typeof fetch === 'function') {
      try {
        fetch(BASE_URL + MANIFEST_PATH)
          .then((r) => (r.ok ? r.json() : null))
          .then((m) => {
            if (m && m.sounds && typeof m.sounds === 'object') this._manifest = m
          })
          .catch(() => {})
      } catch {}
    }
  }

  // -------------------------------------------------------------------------------------------
  // Public API

  /** Create or resume the context. Safe to call on every gesture; it does nothing once running. */
  unlock() {
    const Ctor = typeof globalThis !== 'undefined' ? globalThis.AudioContext || globalThis.webkitAudioContext : null
    if (!Ctor) return
    if (!this.ctx) {
      try {
        try {
          // 'playback' lets the browser use a bigger buffer: less CPU, and latency is irrelevant here.
          this.ctx = new Ctor({ latencyHint: 'playback' })
        } catch {
          this.ctx = new Ctor()
        }
      } catch (err) {
        this._warn('ctx', `[ambience] no audio: ${err?.message || err}`)
        return
      }
      this._buildMixer()
      if (this._enabled) this._startBeds(this._planet?.audio, 0)
    }
    if (!this._enabled) return
    if (this.ctx.state !== 'running' && typeof this.ctx.resume === 'function') {
      try {
        const p = this.ctx.resume()
        if (p && typeof p.then === 'function') {
          p.then(() => {
            if (this.ctx && this.ctx.state === 'running') this._dropGestureListeners()
          }).catch(() => {})
        }
      } catch {}
    } else {
      this._dropGestureListeners()
    }
  }

  get ready() {
    return Boolean(this.ctx) && this.ctx.state === 'running'
  }

  /**
   * Move to a planet's ambience. `planet.audio` is `{ beds, events, shore }`; a planet with
   * none is simply silent, which is right for a world that has no air.
   */
  setPlanet(planet) {
    if (planet === this._planet && this._planet) return
    this._planet = planet || null
    const audio = planet?.audio || null

    this._events.length = 0
    const events = audio?.events || EMPTY
    for (let i = 0; i < events.length; i++) {
      const spec = events[i]
      if (!spec || !SOUNDS[spec.sound]) {
        this._warn('event:' + spec?.sound, `[ambience] unknown event sound "${spec?.sound}"`)
        continue
      }
      const min = Math.max(0.5, spec.every?.[0] ?? 10)
      const max = Math.max(min, spec.every?.[1] ?? min * 2)
      this._events.push({
        sound: spec.sound,
        min,
        max,
        gain: spec.gain ?? 1,
        when: spec.when || 'any',
        where: spec.where || 'ring',
        kind: spec.kind,
        // The first one comes sooner than the average, so a new world speaks up.
        timer: rand(min, max) * rand(0.2, 0.8),
      })
    }
    this._shore.length = 0

    if (this.ctx && this._enabled) this._startBeds(audio, BED_FADE)
  }

  /**
   * Once a frame. Drives every LFO and timer, moves the listener to the camera, and runs
   * the positional pool against `world.sources`.
   */
  update(dt, camera, world) {
    if (!this.ctx || !this._enabled) return
    world = world || NO_WORLD
    const now = this.ctx.currentTime
    const night = clamp01(world.night ?? 0)

    this._updateListener(camera, now)
    this._updateBeds(dt, now, night, world.water)
    this._updateEvents(dt, night)
    this._updatePool(dt, now, world)

    if (now >= this._sweepAt) {
      this._sweepAt = now + 0.5
      this._sweepOneshots(now)
    }
    if (this._auditions.length) this._tickAuditions(dt, now)
  }

  /** Play a sound once; in the world when given a position, otherwise straight to the ear. */
  play(name, opts) {
    return this._shoot(name, opts || PLAY_DEFAULTS, this.effectsBus)
  }

  /**
   * Hear any sound by name for a few seconds, straight to the ear — the sound test panel.
   * A one-shot simply fires; a bed or a loop is faded in, held, and faded out again. The
   * function handed back stops it early.
   */
  audition(name, seconds = 8) {
    const def = SOUNDS[name]
    // The button that called this is a gesture, so the context can be created or resumed
    // here; `resume` is asynchronous, and nodes scheduled against a context that is still
    // waking simply start when it does.
    this.unlock()
    if (!def || !this.ctx || !this._enabled) return () => {}
    if (def.kind === 'event') {
      this.play(name, { gain: 1 })
      return () => {}
    }
    const ctx = this.ctx
    const voice = this._start(name, this.effectsBus, PLAY_DEFAULTS, true)
    const g = voice.out.gain
    const now = ctx.currentTime
    const level = Math.max(0.0001, this._baseGain(name, voice))
    g.setValueAtTime(0.0001, now)
    g.exponentialRampToValueAtTime(level, now + 0.6)
    const entry = { voice, stopAt: now + seconds, done: false }
    entry.stop = () => {
      if (entry.done) return
      entry.done = true
      const t = ctx.currentTime
      g.cancelScheduledValues(t)
      g.setValueAtTime(Math.max(0.0001, g.value), t)
      g.exponentialRampToValueAtTime(0.0001, t + 0.5)
      voice.stop(t + 0.55)
      if (typeof setTimeout === 'function') setTimeout(() => voice.dispose(), 700)
    }
    this._auditions.push(entry)
    return entry.stop
  }

  /** Whether `name` would play a file from the manifest or its synthesised stand-in. */
  sourceOf(name) {
    const entry = this._entry(name)
    if (this._buffers.get(name)) return 'sample'
    if (entry && typeof entry.file === 'string' && entry._state !== 'failed') return 'sample'
    return 'synth'
  }

  _tickAuditions(dt, now) {
    const list = this._auditions
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i]
      if (!a.done) a.voice.update?.(dt, now)
      if (!a.done && now >= a.stopAt) a.stop()
      if (a.done && now > a.stopAt + 1) list.splice(i, 1)
    }
  }

  /** Hard on/off with a short ramp, then the context is suspended so idle costs nothing. */
  setEnabled(on) {
    on = Boolean(on)
    if (this._enabled === on) return
    this._enabled = on
    if (this._sleepTimer) {
      clearTimeout(this._sleepTimer)
      this._sleepTimer = 0
    }
    if (!this.ctx) return
    this._applyMute()
    if (on) {
      this._wake()
    } else if (typeof setTimeout === 'function') {
      // Let the mute ramp land before anything is torn down; a stop under a live gain clicks.
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = 0
        this._sleep()
      }, 600)
    } else {
      this._sleep()
    }
  }

  dispose() {
    if (this._sleepTimer) clearTimeout(this._sleepTimer)
    this._sleepTimer = 0
    this._unsub?.()
    this._unsub = null
    this._dropGestureListeners()
    if (this._onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility)
      this._onVisibility = null
    }
    if (this.ctx) {
      this._stopEverything()
      try {
        const p = this.ctx.close?.()
        p?.catch?.(() => {})
      } catch {}
      this.ctx = null
    }
    this._buffers.clear()
    this._noise = null
  }

  // -------------------------------------------------------------------------------------------
  // Settings, mixer and lifecycle

  _flag(key, fallback) {
    const v = this.settings?.get?.(key)
    return v === undefined || v === null ? fallback : Boolean(v)
  }

  _vol(key, fallback) {
    const v = this.settings?.get?.(key)
    return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback
  }

  _onSettings(changed) {
    if (changed.has('sound')) this.setEnabled(this._flag('sound', true))
    if (changed.has('masterVolume') || changed.has('ambienceVolume') || changed.has('effectsVolume')) this._applyVolumes()
  }

  _buildMixer() {
    const ctx = this.ctx
    const compressor = ctx.createDynamicsCompressor()
    // Gentle: this is a safety net for stacked events, not a sound.
    compressor.threshold.value = -12
    compressor.ratio.value = 3
    compressor.knee.value = 12
    compressor.attack.value = 0.01
    compressor.release.value = 0.25
    compressor.connect(ctx.destination)

    const mute = ctx.createGain()
    mute.gain.value = this._enabled && this._visible ? 1 : 0
    mute.connect(compressor)

    const master = ctx.createGain()
    master.gain.value = this._vol('masterVolume', 0.6)
    master.connect(mute)

    const ambienceBus = ctx.createGain()
    ambienceBus.gain.value = this._vol('ambienceVolume', 0.8)
    ambienceBus.connect(master)

    const effectsBus = ctx.createGain()
    effectsBus.gain.value = this._vol('effectsVolume', 0.8)
    effectsBus.connect(master)

    this.compressor = compressor
    this.mute = mute
    this.master = master
    this.ambienceBus = ambienceBus
    this.effectsBus = effectsBus
  }

  _applyMute() {
    if (!this.mute) return
    const target = this._enabled && this._visible ? 1 : 0
    this.mute.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12)
  }

  _applyVolumes() {
    if (!this.master) return
    const now = this.ctx.currentTime
    this.master.gain.setTargetAtTime(this._vol('masterVolume', 0.6), now, 0.05)
    this.ambienceBus.gain.setTargetAtTime(this._vol('ambienceVolume', 0.8), now, 0.05)
    this.effectsBus.gain.setTargetAtTime(this._vol('effectsVolume', 0.8), now, 0.05)
  }

  _wake() {
    if (this.ctx.state !== 'running' && typeof this.ctx.resume === 'function') {
      try {
        this.ctx.resume()?.catch?.(() => {})
      } catch {}
    }
    if (!this._beds) this._startBeds(this._planet?.audio, 0)
  }

  _sleep() {
    if (!this.ctx || this._enabled) return
    this._stopEverything()
    try {
      this.ctx.suspend?.()?.catch?.(() => {})
    } catch {}
  }

  _stopEverything() {
    if (this._beds) this._disposeGroup(this._beds)
    this._beds = null
    for (let i = 0; i < this._retiring.length; i++) this._disposeGroup(this._retiring[i])
    this._retiring.length = 0
    for (let i = 0; i < this._pool.length; i++) this._disposeVoice(this._pool[i])
    this._pool.length = 0
    this._byId.clear()
    for (let i = 0; i < this._oneshots.length; i++) this._disposeOneshot(this._oneshots[i])
    this._oneshots.length = 0
  }

  _dropGestureListeners() {
    if (!this._onGesture || typeof document === 'undefined') return
    document.removeEventListener('pointerdown', this._onGesture)
    document.removeEventListener('keydown', this._onGesture)
    this._onGesture = null
  }

  _warn(key, message) {
    if (this._warned.has(key)) return
    this._warned.add(key)
    if (typeof console !== 'undefined') console.warn(message)
  }

  // -------------------------------------------------------------------------------------------
  // Starting sounds: sample if we have one, synth otherwise

  _noiseBuffers() {
    if (!this._noise) this._noise = createNoiseBuffers(this.ctx)
    return this._noise
  }

  _entry(name) {
    return this._manifest ? this._manifest.sounds[name] : undefined
  }

  /** A Voice for `name` into `dest`. Kicks off the file load if one is promised but not decoded yet. */
  _start(name, dest, opts, loop) {
    const def = SOUNDS[name]
    const buffer = this._buffers.get(name)
    if (buffer) {
      const entry = this._entry(name)
      // The manifest may say a file loops even where the synth would not, and vice versa.
      return new SampleVoice(this.ctx, dest, buffer, entry, typeof entry?.loop === 'boolean' ? entry.loop : loop)
    }
    this._load(name)
    return def.synth(this.ctx, dest, opts, this._noiseBuffers())
  }

  /** The level a voice should play at: registry trim, times the manifest's own gain for a sample. */
  _baseGain(name, voice) {
    const def = SOUNDS[name]
    if (!voice.isSample) return def.gain
    const entry = this._entry(name)
    return def.gain * (typeof entry?.gain === 'number' ? entry.gain : 1)
  }

  _load(name) {
    const entry = this._entry(name)
    if (!entry || entry._state || typeof entry.file !== 'string' || typeof fetch !== 'function') return
    entry._state = 'loading'
    const file = entry.file
    const url = /^(https?:)?\/\//.test(file) || file.startsWith('/') ? file : BASE_URL + file
    const ctx = this.ctx
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then(
        (data) =>
          // Callback form: it is the one every browser that has Web Audio at all accepts.
          new Promise((resolve, reject) => {
            const p = ctx.decodeAudioData(data, resolve, reject)
            if (p && typeof p.then === 'function') p.then(resolve, reject)
          }),
      )
      .then((buffer) => {
        if (this.ctx !== ctx) return
        entry._state = 'ready'
        this._buffers.set(name, buffer)
        this._onBufferReady(name)
      })
      .catch((err) => {
        entry._state = 'failed'
        this._warn('load:' + name, `[ambience] "${name}": could not use ${file} (${err?.message || err}); the synth plays instead`)
      })
  }

  /**
   * A sample arrived for a bed that is already playing on its synth. Hand over inside the
   * layer rather than restarting it: the sample fades up under the synth and the synth fades
   * out, and nobody hears the join. Positional loops are short-lived and just get the sample
   * next time they start.
   */
  _onBufferReady(name) {
    const group = this._beds
    if (!group) return
    const now = this.ctx.currentTime
    for (let i = 0; i < group.layers.length; i++) {
      const layer = group.layers[i]
      if (layer.spec.sound !== name || layer.voice.isSample || layer.retiring) continue
      const sample = this._start(name, layer.gain, layer.spec, true)
      sample.out.gain.value = 0
      sample.out.gain.setTargetAtTime(1, now, SWAP_FADE / 3)
      layer.voice.out.gain.setTargetAtTime(0, now, SWAP_FADE / 3)
      layer.retiring = layer.voice
      layer.retireAt = now + SWAP_FADE + 0.3
      layer.voice = sample
      layer.base = this._baseGain(name, sample)
      layer.gain.gain.setTargetAtTime(this._layerLevel(layer, Math.max(0, this._night)), now, 0.3)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Beds

  _startBeds(audio, fade) {
    const ctx = this.ctx
    if (this._beds) {
      this._beds.dir = -1
      this._retiring.push(this._beds)
      this._beds = null
    }
    const group = {
      mix: ctx.createGain(),
      layers: [],
      progress: fade > 0 ? 0 : 1,
      dir: fade > 0 ? 1 : 0,
      rate: 1 / BED_FADE,
    }
    group.mix.gain.value = fade > 0 ? 0 : 1
    group.mix.connect(this.ambienceBus)

    const night = Math.max(0, this._night)
    const beds = audio?.beds || EMPTY
    for (let i = 0; i < beds.length; i++) {
      const spec = beds[i]
      if (!spec || !SOUNDS[spec.sound]) {
        this._warn('bed:' + spec?.sound, `[ambience] unknown bed sound "${spec?.sound}"`)
        continue
      }
      const g = spec.gain ?? 1
      const layer = {
        spec,
        gain: ctx.createGain(),
        voice: null,
        retiring: null,
        retireAt: 0,
        day: spec.day ?? g,
        night: spec.night ?? g,
        base: 1,
      }
      layer.gain.connect(group.mix)
      layer.voice = this._start(spec.sound, layer.gain, spec, true)
      layer.base = this._baseGain(spec.sound, layer.voice)
      layer.gain.gain.value = this._layerLevel(layer, night)
      group.layers.push(layer)
    }
    this._beds = group
  }

  _layerLevel(layer, night) {
    const shore = layer.spec.shore ? this._shoreMix : 1
    return layer.base * (layer.day + (layer.night - layer.day) * night) * shore
  }

  /**
   * How much of the sea to hear from where the view is: all of it at the water's edge,
   * a distant wash well inland. The shoreline's nearest point is handed over each frame by
   * the integrator along with where the view sits, so this is one distance.
   */
  _shoreMixFor(water) {
    const p = water?.points?.[0]
    if (!p || water.focusX === undefined) return 1
    const d = Math.hypot(p.x - water.focusX, p.z - water.focusZ)
    const t = Math.min(1, Math.max(0, (d - SHORE_NEAR) / (SHORE_FAR - SHORE_NEAR)))
    return 1 - t * (1 - SHORE_INLAND)
  }

  _disposeGroup(group) {
    for (let i = 0; i < group.layers.length; i++) {
      const layer = group.layers[i]
      layer.voice?.dispose()
      layer.retiring?.dispose()
      try {
        layer.gain.disconnect()
      } catch {}
    }
    try {
      group.mix.disconnect()
    } catch {}
  }

  _updateBeds(dt, now, night, water) {
    const shoreMix = this._shoreMixFor(water)
    const shoreMoved = Math.abs(shoreMix - this._shoreMix) > 0.01
    if (shoreMoved) this._shoreMix = shoreMix
    const nightMoved = Math.abs(night - this._night) > 0.004 || shoreMoved
    if (nightMoved) this._night = night

    const group = this._beds
    if (group) {
      if (group.dir > 0) {
        group.progress += dt * group.rate
        if (group.progress >= 1) {
          group.progress = 1
          group.dir = 0
        }
        group.mix.gain.setTargetAtTime(Math.sin(group.progress * HALF_PI), now, 0.05)
      }
      this._tickLayers(group, dt, now, night, nightMoved)
    }

    for (let i = this._retiring.length - 1; i >= 0; i--) {
      const old = this._retiring[i]
      old.progress -= dt * old.rate
      if (old.progress <= 0) {
        this._disposeGroup(old)
        this._retiring[i] = this._retiring[this._retiring.length - 1]
        this._retiring.pop()
        continue
      }
      old.mix.gain.setTargetAtTime(Math.sin(old.progress * HALF_PI), now, 0.05)
      // Keep its wind moving while it goes; a frozen bed fading out is audibly a different thing.
      this._tickLayers(old, dt, now, night, nightMoved)
    }
  }

  _tickLayers(group, dt, now, night, nightMoved) {
    for (let i = 0; i < group.layers.length; i++) {
      const layer = group.layers[i]
      if (nightMoved) layer.gain.gain.setTargetAtTime(this._layerLevel(layer, night), now, 0.5)
      layer.voice.update(dt, now)
      if (layer.retiring && now >= layer.retireAt) {
        layer.retiring.dispose()
        layer.retiring = null
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Environment events

  _updateEvents(dt, night) {
    for (let i = 0; i < this._events.length; i++) {
      const ev = this._events[i]
      ev.timer -= dt
      if (ev.timer > 0) continue
      ev.timer = rand(ev.min, ev.max)
      if (ev.when === 'night' && night < 0.5) continue
      if (ev.when === 'day' && night >= 0.5) continue
      this._fireEvent(ev)
    }
  }

  _fireEvent(ev) {
    if (!this.ready) return
    let args = this._shot2d
    if (ev.where === 'water' || ev.where === 'ring') {
      const s = this._shot
      const water = ev.where === 'water' ? this._water : null
      const pts = water?.points
      if (pts && pts.length) {
        const p = pts[(Math.random() * pts.length) | 0]
        s.x = p.x
        s.y = water.level ?? 0
        s.z = p.z
      } else {
        // On a ring around the listener at the listener's own height: what matters is that
        // it is heard at a believable distance, wherever the camera happens to be.
        const a = Math.random() * Math.PI * 2
        const r = rand(RING[0], RING[1])
        s.x = this._lx + Math.cos(a) * r
        s.y = this._ly
        s.z = this._lz + Math.sin(a) * r
      }
      args = s
    }
    args.gain = ev.gain
    args.kind = ev.kind
    this._shoot(ev.sound, args, this.ambienceBus)
  }

  // -------------------------------------------------------------------------------------------
  // One-shots

  _shoot(name, opts, bus) {
    const def = SOUNDS[name]
    if (!def) {
      this._warn('sound:' + name, `[ambience] unknown sound "${name}"`)
      return null
    }
    if (!this.ready || !this._enabled || !bus) return null
    const ctx = this.ctx
    const now = ctx.currentTime
    const positional = typeof opts.x === 'number' && typeof opts.z === 'number'

    let dest = bus
    let panner = null
    if (positional) {
      panner = this._createPanner()
      this._place(panner, opts.x, opts.y ?? 0, opts.z, now, true)
      panner.connect(bus)
      dest = panner
    }
    const level = ctx.createGain()
    level.connect(dest)
    const voice = this._start(name, level, opts, def.kind !== 'event')
    level.gain.value = this._baseGain(name, voice) * (opts.gain ?? 1)
    // A loop asked for as a one-shot has no natural end; give it one so it cannot leak.
    if (!Number.isFinite(voice.until)) {
      voice.until = now + 8
      level.gain.setTargetAtTime(0, now + 7, 0.25)
    }
    const shot = { voice, level, panner }
    this._oneshots.push(shot)
    return shot.voice
  }

  _sweepOneshots(now) {
    const list = this._oneshots
    for (let i = list.length - 1; i >= 0; i--) {
      if (now < list[i].voice.until) continue
      this._disposeOneshot(list[i])
      list[i] = list[list.length - 1]
      list.pop()
    }
  }

  _disposeOneshot(shot) {
    shot.voice.dispose()
    try {
      shot.level.disconnect()
      shot.panner?.disconnect()
    } catch {}
  }

  // -------------------------------------------------------------------------------------------
  // Listener and panners

  _createPanner() {
    const p = this.ctx.createPanner()
    p.panningModel = PANNER.panningModel
    p.distanceModel = PANNER.distanceModel
    p.refDistance = PANNER.refDistance
    p.rolloffFactor = PANNER.rolloffFactor
    p.maxDistance = PANNER.maxDistance
    return p
  }

  _place(panner, x, y, z, now, immediate) {
    if (panner.positionX) {
      if (immediate) {
        panner.positionX.setValueAtTime(x, now)
        panner.positionY.setValueAtTime(y, now)
        panner.positionZ.setValueAtTime(z, now)
      } else {
        // Smoothed, so a source that moves every frame does not zip.
        panner.positionX.setTargetAtTime(x, now, 0.05)
        panner.positionY.setTargetAtTime(y, now, 0.05)
        panner.positionZ.setTargetAtTime(z, now, 0.05)
      }
    } else if (panner.setPosition) {
      panner.setPosition(x, y, z)
    }
  }

  _updateListener(camera, now) {
    const e = camera?.matrixWorld?.elements
    if (!e) return
    const x = e[12]
    const y = e[13]
    const z = e[14]
    // Forward is minus the local Z column; up is the Y column. Normalised in case the camera
    // is parented under something scaled.
    let fx = -e[8]
    let fy = -e[9]
    let fz = -e[10]
    let fl = Math.hypot(fx, fy, fz) || 1
    fx /= fl
    fy /= fl
    fz /= fl
    let ux = e[4]
    let uy = e[5]
    let uz = e[6]
    let ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul
    uy /= ul
    uz /= ul

    const eps = 1e-3
    const moved =
      !this._listenerSet ||
      Math.abs(x - this._lx) > eps ||
      Math.abs(y - this._ly) > eps ||
      Math.abs(z - this._lz) > eps ||
      Math.abs(fx - this._fx) > eps ||
      Math.abs(fy - this._fy) > eps ||
      Math.abs(fz - this._fz) > eps ||
      Math.abs(ux - this._ux) > eps ||
      Math.abs(uy - this._uy) > eps ||
      Math.abs(uz - this._uz) > eps
    if (!moved) return
    this._lx = x
    this._ly = y
    this._lz = z
    this._fx = fx
    this._fy = fy
    this._fz = fz
    this._ux = ux
    this._uy = uy
    this._uz = uz

    const l = this.ctx.listener
    if (!l) return
    if (l.positionX) {
      const first = !this._listenerSet
      const tau = 0.03
      if (first) {
        l.positionX.setValueAtTime(x, now)
        l.positionY.setValueAtTime(y, now)
        l.positionZ.setValueAtTime(z, now)
        l.forwardX.setValueAtTime(fx, now)
        l.forwardY.setValueAtTime(fy, now)
        l.forwardZ.setValueAtTime(fz, now)
        l.upX.setValueAtTime(ux, now)
        l.upY.setValueAtTime(uy, now)
        l.upZ.setValueAtTime(uz, now)
      } else {
        l.positionX.setTargetAtTime(x, now, tau)
        l.positionY.setTargetAtTime(y, now, tau)
        l.positionZ.setTargetAtTime(z, now, tau)
        l.forwardX.setTargetAtTime(fx, now, tau)
        l.forwardY.setTargetAtTime(fy, now, tau)
        l.forwardZ.setTargetAtTime(fz, now, tau)
        l.upX.setTargetAtTime(ux, now, tau)
        l.upY.setTargetAtTime(uy, now, tau)
        l.upZ.setTargetAtTime(uz, now, tau)
      }
    } else if (l.setPosition) {
      l.setPosition(x, y, z)
      l.setOrientation(fx, fy, fz, ux, uy, uz)
    }
    this._listenerSet = true
  }

  // -------------------------------------------------------------------------------------------
  // The positional voice pool

  _updatePool(dt, now, world) {
    this._frame++
    this._slotCount = 0
    this._water = world.water || null

    const sources = world.sources || EMPTY
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      if (s && s.id && s.sound) this._consider(s)
    }

    // Shore laps are ours to place: one source per water point the integrator hands over.
    const water = this._planet?.audio?.shore ? world.water : null
    const points = water?.points
    if (points && points.length) {
      if (this._shore.length !== points.length) {
        this._shore.length = 0
        for (let i = 0; i < points.length; i++) this._shore.push({ id: 'shore:' + i, sound: 'shore-lap', x: 0, y: 0, z: 0, gain: 1 })
      }
      for (let i = 0; i < points.length; i++) {
        const s = this._shore[i]
        s.x = points[i].x
        s.y = water.level ?? 0
        s.z = points[i].z
        this._consider(s)
      }
    } else if (this._shore.length) {
      this._shore.length = 0
    }

    // Anything ranked that already has a voice keeps it (and comes back if it was on its way out).
    const frame = this._frame
    for (let i = 0; i < this._slotCount; i++) {
      const s = this._slots[i].src
      const v = this._byId.get(s.id)
      if (!v) continue
      v.seen = frame
      v.src = s
      if (v.dying) {
        v.dying = false
        v.level = -1 // forces the level ramp below
      }
    }

    // Anything voiced but not ranked starts fading. It keeps its slot until it is quiet,
    // which is exactly what stops a source on the boundary flapping.
    const pool = this._pool
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i]
      if (v.seen !== frame && !v.dying) {
        v.dying = true
        v.stopAt = now + VOICE_STOP_DELAY
        v.gain.gain.setTargetAtTime(0, now, VOICE_TAU)
      }
    }

    // Fill free slots, nearest first. The ranking is sorted, so stopping at the first refusal is fine.
    if (this.ready) {
      for (let i = 0; i < this._slotCount && pool.length < MAX_VOICES; i++) {
        const s = this._slots[i].src
        if (!this._byId.has(s.id)) this._addVoice(s, now)
      }
    }

    // Per-voice frame work, and burying the ones that have finished fading.
    for (let i = pool.length - 1; i >= 0; i--) {
      const v = pool[i]
      if (v.dying) {
        if (now >= v.stopAt) {
          this._disposeVoice(v)
          this._byId.delete(v.id)
          pool[i] = pool[pool.length - 1]
          pool.pop()
        }
        continue
      }
      const s = v.src
      const srcGain = s.gain ?? 1
      const level = v.base * srcGain
      if (Math.abs(level - v.level) > 0.004) {
        v.level = level
        v.gain.gain.setTargetAtTime(level, now, VOICE_TAU)
        v.voice.setLevel(clamp01(srcGain))
      }
      if (s.x !== v.x || s.y !== v.y || s.z !== v.z) {
        v.x = s.x
        v.y = s.y
        v.z = s.z
        this._place(v.panner, s.x, s.y ?? 0, s.z, now, false)
      }
      v.voice.update(dt, now)
    }
  }

  /** Insertion into the sorted nearest-N scratch. O(N·MAX_VOICES), no allocation. */
  _consider(src) {
    const dx = src.x - this._lx
    const dy = (src.y ?? 0) - this._ly
    const dz = src.z - this._lz
    let d = dx * dx + dy * dy + dz * dz
    // A source already voiced counts as a little nearer than it is, so two at the same
    // distance do not trade the last slot back and forth every frame.
    const v = this._byId.get(src.id)
    if (v && !v.dying) d *= 0.8

    const slots = this._slots
    let n = this._slotCount
    if (n === MAX_VOICES) {
      if (d >= slots[n - 1].d) return
      n = MAX_VOICES - 1
    }
    let i = n
    while (i > 0 && slots[i - 1].d > d) {
      slots[i].src = slots[i - 1].src
      slots[i].d = slots[i - 1].d
      i--
    }
    slots[i].src = src
    slots[i].d = d
    this._slotCount = n + 1
  }

  _addVoice(s, now) {
    const def = SOUNDS[s.sound]
    if (!def || def.kind === 'event') {
      this._warn('source:' + s.sound, `[ambience] "${s.sound}" cannot be a positional source`)
      return
    }
    const ctx = this.ctx
    const panner = this._createPanner()
    panner.connect(this.effectsBus)
    this._place(panner, s.x, s.y ?? 0, s.z, now, true)
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(panner)
    const voice = this._start(s.sound, gain, s, true)
    const v = {
      id: s.id,
      src: s,
      voice,
      gain,
      panner,
      base: this._baseGain(s.sound, voice),
      level: 0,
      x: s.x,
      y: s.y,
      z: s.z,
      dying: false,
      stopAt: 0,
      seen: this._frame,
    }
    this._pool.push(v)
    this._byId.set(s.id, v)
  }

  _disposeVoice(v) {
    v.voice.dispose()
    try {
      v.gain.disconnect()
      v.panner.disconnect()
    } catch {}
  }
}
