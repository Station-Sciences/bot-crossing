/**
 * Procedural sound. Every name the registry knows can be made from Web Audio nodes alone,
 * so the colony is fully audible with not one audio file in the repository — and when a real
 * sample does turn up in the manifest, it slots into exactly the same `Voice` shape, so the
 * mixer never has to know which it got.
 *
 * Two rules keep this honest for an always-open window. Nothing here allocates on a frame
 * unless it is actually making a new sound — a bed sitting idle is a buffer source, a filter
 * and a gain, and its `update` is a few multiplies. And nothing ever changes a gain by
 * assignment: every level goes through `setTargetAtTime` or a ramp, because a stepped gain is
 * a click, and one click is enough to get the whole layer muted for good.
 */

/** Noise loops are this long. Long enough that the ear never catches the repeat. */
const NOISE_SECONDS = 5
/** How much of the tail is blended back into the head so the loop point is inaudible. */
const NOISE_CROSSFADE = 0.5

const TAU = Math.PI * 2
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

/**
 * One buffer each of white, pink and brown noise, built once per context. Generated a
 * crossfade's worth *longer* than the loop and folded over: the head is a blend of the true
 * head and the samples that would have followed the tail, so the last sample runs straight
 * into the first. For brown noise especially, whose whole character is low frequency, a
 * plain wrap is a thud every five seconds.
 */
export function createNoiseBuffers(ctx) {
  const rate = ctx.sampleRate
  const length = Math.floor(NOISE_SECONDS * rate)
  const fade = Math.floor(NOISE_CROSSFADE * rate)
  const total = length + fade

  const white = new Float32Array(total)
  const pink = new Float32Array(total)
  const brown = new Float32Array(total)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, walk = 0
  for (let i = 0; i < total; i++) {
    const w = Math.random() * 2 - 1
    white[i] = w
    // Paul Kellet's pink filter: cheap, and flat enough for wind.
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    pink[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
    // Leaky integrator; the leak is what stops it wandering off to one rail.
    walk = (walk + 0.02 * w) / 1.02
    brown[i] = walk * 3.5
  }

  const out = {}
  for (const [name, data] of [['white', white], ['pink', pink], ['brown', brown]]) {
    const buffer = ctx.createBuffer(1, length, rate)
    const ch = buffer.getChannelData(0)
    let mean = 0
    for (let i = 0; i < length; i++) mean += data[i]
    mean /= length
    let peak = 1e-6
    for (let i = 0; i < length; i++) {
      let v = data[i] - mean
      if (i < fade) {
        // Equal-power blend keeps the loudness flat through the seam.
        const t = (i / fade) * Math.PI * 0.5
        v = (data[length + i] - mean) * Math.cos(t) + v * Math.sin(t)
      }
      ch[i] = v
      if (Math.abs(v) > peak) peak = Math.abs(v)
    }
    const norm = 0.9 / peak
    for (let i = 0; i < length; i++) ch[i] *= norm
    out[name] = buffer
  }
  return out
}

/**
 * A sound that is currently playing. Owns its own output gain so whoever started it can fade
 * it out and drop it without knowing what is behind it — three oscillators or one sample.
 * `until` is the context time by which a one-shot has finished; loops leave it infinite.
 */
export class Voice {
  constructor(ctx, dest) {
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.connect(dest)
    this.until = Infinity
    this.isSample = false
    this._sources = []
    this._nodes = [this.out]
  }

  /** Register a started source so `stop` reaches it. */
  source(node) {
    this._sources.push(node)
    return node
  }

  /** Register an intermediate node so `dispose` disconnects it. */
  node(node) {
    this._nodes.push(node)
    return node
  }

  /** Called every frame while alive — LFOs, swells, scheduled taps. Most voices do nothing. */
  update(dt, now) {}

  /** The pool's idea of how loud this source is (0..1); a rotor pitches up with it. */
  setLevel(level) {}

  stop(when) {
    for (let i = 0; i < this._sources.length; i++) {
      // A source that has already ended throws on a second stop; nothing to do about it.
      try {
        this._sources[i].stop(when)
      } catch {}
    }
  }

  dispose() {
    this.stop(this.ctx.currentTime)
    for (let i = 0; i < this._nodes.length; i++) {
      try {
        this._nodes[i].disconnect()
      } catch {}
    }
  }
}

/** A decoded file standing in for a synth. Loops with the manifest's trim, or plays once. */
export class SampleVoice extends Voice {
  constructor(ctx, dest, buffer, entry, loop) {
    super(ctx, dest)
    this.isSample = true
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const trim = Array.isArray(entry?.trim) ? entry.trim : null
    const start = trim ? Math.max(0, trim[0]) : 0
    const end = trim ? Math.min(buffer.duration, trim[1]) : buffer.duration
    src.connect(this.out)
    const now = ctx.currentTime
    if (loop) {
      src.loop = true
      src.loopStart = start
      src.loopEnd = end
      // A random offset so two copies of the same loop do not phase against each other.
      src.start(now, start + Math.random() * Math.max(0, end - start - 0.1))
    } else {
      src.start(now, start, Math.max(0.01, end - start))
      this.until = now + (end - start)
    }
    this.source(src)
  }
}

// ---------------------------------------------------------------------------------------------
// Small building blocks.

function looped(ctx, buffer, dest) {
  const s = ctx.createBufferSource()
  s.buffer = buffer
  s.loop = true
  s.connect(dest)
  // Random phase, for the same reason as the sample loop above.
  s.start(ctx.currentTime, Math.random() * buffer.duration * 0.9)
  return s
}

/** A slice of a noise buffer, played once. */
function burst(ctx, buffer, dest, when, duration) {
  const s = ctx.createBufferSource()
  s.buffer = buffer
  s.connect(dest)
  const offset = Math.random() * Math.max(0, buffer.duration - duration - 0.05)
  s.start(when, offset, duration)
  return s
}

function osc(ctx, type, freq, dest, when) {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.value = freq
  o.connect(dest)
  o.start(when)
  return o
}

function filter(ctx, type, freq, q = 1) {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  return f
}

function gain(ctx, value, dest) {
  const g = ctx.createGain()
  g.gain.value = value
  if (dest) g.connect(dest)
  return g
}

/**
 * Attack-hold-decay on a param. The decay is an exponential approach, which is what a
 * struck or blown thing actually does; `decay` is the time to fall to about 2%.
 * Returns when the envelope is effectively over.
 */
function envelope(param, now, peak, attack, decay, hold = 0) {
  param.setValueAtTime(0, now)
  param.linearRampToValueAtTime(peak, now + attack)
  param.setTargetAtTime(0, now + attack + hold, decay / 4)
  return now + attack + hold + decay
}

/**
 * One FM chirp: a sine that glides from `f0` to `f1`, optionally wobbled by a modulator, with
 * an attack/decay. Every bird here is a handful of these with a different contour.
 */
function chirp(ctx, dest, when, o) {
  const g = gain(ctx, 0, dest)
  const c = ctx.createOscillator()
  c.type = o.type || 'sine'
  c.frequency.setValueAtTime(o.f0, when)
  if (o.fMid !== undefined) {
    c.frequency.exponentialRampToValueAtTime(o.fMid, when + o.dur * 0.4)
    c.frequency.exponentialRampToValueAtTime(o.f1, when + o.dur)
  } else {
    c.frequency.exponentialRampToValueAtTime(o.f1, when + o.dur)
  }
  c.connect(g)
  c.start(when)
  let end = envelope(g.gain, when, o.gain, o.attack ?? 0.01, o.decay ?? 0.08, Math.max(0, o.dur - (o.attack ?? 0.01)))
  c.stop(end + 0.05)
  if (o.modF) {
    const m = ctx.createOscillator()
    m.frequency.value = o.modF
    const md = gain(ctx, o.modD, c.frequency)
    m.connect(md)
    m.start(when)
    m.stop(end + 0.05)
  }
  return end
}

// ---------------------------------------------------------------------------------------------
// Beds: looping layers, all cheap, all driven a little from `update` so they never sit still.

/**
 * Noise through a lowpass whose cutoff wanders. The random walk lives in `update`, not in an
 * LFO node, because wind is not periodic — the moment it is, you hear the loop.
 */
class WindVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.lo = o.lo
    this.hi = o.hi
    this.base = o.base
    this.swell = o.swell
    this.rate = o.rate ?? 1
    this.cutoff = (o.lo + o.hi) * 0.5
    this.level = 0.5
    this.velocity = 0
    this.acc = 0
    this.filter = this.node(filter(ctx, o.type || 'lowpass', this.cutoff, o.q ?? 0.7))
    this.filter.connect(this.out)
    this.source(looped(ctx, noise[o.noise || 'pink'], this.filter))
    this.out.gain.value = o.base
  }

  update(dt, now) {
    // Cutoff and loudness move together: a gust is both louder and brighter.
    this.velocity += (Math.random() - 0.5) * 3 * this.rate * dt
    this.velocity *= 1 - 0.8 * dt
    this.level += this.velocity * dt
    if (this.level < 0) {
      this.level = 0
      this.velocity = Math.abs(this.velocity) * 0.3
    } else if (this.level > 1) {
      this.level = 1
      this.velocity = -Math.abs(this.velocity) * 0.3
    }
    this.acc += dt
    if (this.acc < 0.08) return
    this.acc = 0
    const cutoff = this.lo + (this.hi - this.lo) * this.level
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.25)
    this.out.gain.setTargetAtTime(this.base * (1 - this.swell + this.swell * this.level), now, 0.25)
  }
}

/** Brown noise through a bandpass, swelling on a slow, uneven period. */
class SurfVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.periodLo = o.period[0]
    this.periodHi = o.period[1]
    this.period = rand(this.periodLo, this.periodHi)
    this.phase = Math.random()
    this.acc = 0
    const f = this.node(filter(ctx, o.type || 'bandpass', o.center, o.q ?? 0.5))
    f.connect(this.out)
    this.source(looped(ctx, noise[o.noise || 'brown'], f))
    this.out.gain.value = o.base * 0.3
  }

  update(dt, now) {
    this.phase += dt / this.period
    if (this.phase >= 1) {
      this.phase -= 1
      this.period = rand(this.periodLo, this.periodHi)
    }
    this.acc += dt
    if (this.acc < 0.08) return
    this.acc = 0
    // A wave builds slowly and breaks quickly: the rise is the long part of the shape.
    const p = this.phase
    const shape = p < 0.7 ? Math.pow(p / 0.7, 2.2) : Math.pow(1 - (p - 0.7) / 0.3, 1.4)
    this.out.gain.setTargetAtTime(this.base * (0.18 + 0.82 * shape), now, 0.2)
  }
}

/** Noise with a fast, small flutter — running water, or leaves. */
class FlutterVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.depth = o.depth
    this.speed = o.speed
    this.acc = 0
    const f = this.node(filter(ctx, o.type || 'bandpass', o.center, o.q ?? 0.6))
    f.connect(this.out)
    this.source(looped(ctx, noise[o.noise || 'white'], f))
    this.out.gain.value = o.base
  }

  update(dt, now) {
    this.acc += dt
    if (this.acc < 1 / this.speed) return
    this.acc = 0
    this.out.gain.setTargetAtTime(this.base * (1 - this.depth + this.depth * Math.random()), now, 0.5 / this.speed)
  }
}

/**
 * A cricket: a sine gated at ~28 Hz by a square LFO, itself gated into bursts. Six nodes
 * for the whole chorus, and the square wave does the chirping for free.
 */
class CricketVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.on = false
    this.timer = rand(0.2, 1)
    const burstGain = this.node(gain(ctx, 0, this.out))
    const gate = this.node(gain(ctx, 0.5, burstGain))
    const lfoDepth = this.node(gain(ctx, 0.5, gate.gain))
    this.source(osc(ctx, 'square', o.rate ?? 28, lfoDepth, ctx.currentTime))
    this.source(osc(ctx, 'sine', o.freq ?? rand(3900, 4500), gate, ctx.currentTime))
    this.burst = burstGain
    this.out.gain.value = 1
  }

  update(dt, now) {
    this.timer -= dt
    if (this.timer > 0) return
    this.on = !this.on
    // Bursts run about 0.6 s; the gaps are what make it a cricket and not a tone.
    this.timer = this.on ? rand(0.45, 0.8) : rand(0.3, 1.4)
    this.burst.gain.setTargetAtTime(this.on ? this.base : 0, now, 0.02)
  }
}

/** A buzzing bandpass that drifts in pitch, with the odd FM tweet on top. */
class InsectVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.center = 3500
    this.acc = 0
    this.tweet = rand(1, 4)
    this.filter = this.node(filter(ctx, 'bandpass', this.center, 9))
    this.filter.connect(this.out)
    this.source(looped(ctx, noise.white, this.filter))
    this.out.gain.value = o.base
  }

  update(dt, now) {
    this.acc += dt
    this.tweet -= dt
    if (this.tweet <= 0) {
      this.tweet = rand(1.5, 6)
      chirp(this.ctx, this.out, now, { f0: rand(2600, 4200), f1: rand(3000, 5000), dur: 0.09, gain: this.base * 0.9, modF: 60, modD: 300 })
    }
    if (this.acc < 0.12) return
    this.acc = 0
    this.center += (Math.random() - 0.5) * 900
    this.center = Math.min(5500, Math.max(2400, this.center))
    this.filter.frequency.setTargetAtTime(this.center, now, 0.3)
    this.out.gain.setTargetAtTime(this.base * rand(0.55, 1), now, 0.3)
  }
}

/** A faint bed that lets a bird go every so often. */
class BirdBedVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.kinds = o.kinds
    this.every = o.every
    this.timer = rand(o.every[0] * 0.3, o.every[1] * 0.6)
    if (o.hiss) {
      const f = this.node(filter(ctx, 'bandpass', 4000, 0.4))
      f.connect(this.out)
      this.source(looped(ctx, noise.pink, f))
      this.out.gain.value = o.hiss
    } else {
      this.out.gain.value = 1
    }
    this.callGain = this.node(gain(ctx, 1, dest))
  }

  update(dt, now) {
    this.timer -= dt
    if (this.timer > 0) return
    this.timer = rand(this.every[0], this.every[1])
    const kind = this.kinds[(Math.random() * this.kinds.length) | 0]
    BIRDS[kind](this.ctx, this.callGain, now, this.base)
  }
}

/** Brown rumble with random thuds under it. */
class LavaVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.pop = rand(1, 4)
    this.acc = 0
    const f = this.node(filter(ctx, 'lowpass', 120, 0.8))
    f.connect(this.out)
    this.source(looped(ctx, noise.brown, f))
    this.out.gain.value = o.base
  }

  update(dt, now) {
    this.pop -= dt
    if (this.pop <= 0) {
      this.pop = rand(1.5, 6)
      chirp(this.ctx, this.out, now, { f0: rand(55, 80), f1: 28, dur: 0.16, gain: this.base * 1.6, attack: 0.005, decay: 0.2 })
    }
    this.acc += dt
    if (this.acc < 0.15) return
    this.acc = 0
    this.out.gain.setTargetAtTime(this.base * rand(0.7, 1), now, 0.4)
  }
}

/** Highpassed hiss that occasionally vents. */
class HissVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.vent = rand(3, 9)
    this.venting = 0
    const f = this.node(filter(ctx, 'highpass', 3800, 0.7))
    f.connect(this.out)
    this.source(looped(ctx, noise.white, f))
    this.out.gain.value = o.base
  }

  update(dt, now) {
    this.vent -= dt
    if (this.vent > 0) return
    if (this.venting) {
      this.venting = 0
      this.vent = rand(4, 11)
      this.out.gain.setTargetAtTime(this.base, now, 0.8)
    } else {
      this.venting = 1
      this.vent = rand(1.5, 3.5)
      this.out.gain.setTargetAtTime(this.base * 2.6, now, 0.6)
    }
  }
}

/**
 * Airless worlds: what you hear is the inside of a helmet. A sub-audible hum, a whisper of
 * band-limited noise for the suit radio, and a slow breathing wobble so it is not a test tone.
 */
class HumVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.phase = Math.random() * TAU
    const now = ctx.currentTime
    const a = this.node(gain(ctx, 1, this.out))
    const b = this.node(gain(ctx, 0.25, this.out))
    this.source(osc(ctx, 'sine', o.freq ?? 48, a, now))
    this.source(osc(ctx, 'sine', (o.freq ?? 48) * 2.01, b, now))
    if (o.radio) {
      const f = this.node(filter(ctx, 'bandpass', 1800, 1.2))
      const rg = this.node(gain(ctx, o.radio, this.out))
      f.connect(rg)
      this.source(looped(ctx, noise.pink, f))
    }
    this.out.gain.value = o.base
    this.acc = 0
  }

  update(dt, now) {
    this.phase += dt * 0.35
    this.acc += dt
    if (this.acc < 0.1) return
    this.acc = 0
    this.out.gain.setTargetAtTime(this.base * (0.8 + 0.2 * Math.sin(this.phase)), now, 0.3)
  }
}

// ---------------------------------------------------------------------------------------------
// Positional loops: what a thing in the world sounds like from where it stands.

/**
 * Hammering. Taps are scheduled a little ahead of time from `update`, so the rhythm is
 * sample-accurate however uneven the frame rate; each tap is a highpassed noise tick plus a
 * 180 Hz thud, and under it all a faint bandpassed crackle stands in for the welder.
 */
class HammerVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.noise = noise
    this.base = o.base
    this.next = ctx.currentTime + rand(0, 0.4)
    this.taps = 0
    this.acc = 0
    const crackleFilter = this.node(filter(ctx, 'bandpass', 3200, 2.5))
    this.crackle = this.node(gain(ctx, 0.02, this.out))
    crackleFilter.connect(this.crackle)
    this.source(looped(ctx, noise.white, crackleFilter))
    this.out.gain.value = 1
  }

  update(dt, now) {
    const ctx = this.ctx
    while (this.next < now + 0.25) {
      const t = Math.max(this.next, now)
      const tick = gain(ctx, 0, this.out)
      const hp = filter(ctx, 'highpass', 2600, 0.8)
      hp.connect(tick)
      burst(ctx, this.noise.white, hp, t, 0.035)
      envelope(tick.gain, t, this.base * 0.55, 0.002, 0.05)
      const thud = gain(ctx, 0, this.out)
      const o = osc(ctx, 'sine', 180, thud, t)
      o.frequency.exponentialRampToValueAtTime(110, t + 0.06)
      o.stop(envelope(thud.gain, t, this.base, 0.003, 0.09) + 0.02)
      // 2.2 Hz with a little jitter, and a breath every eight or so strikes — a metronome
      // is the one thing hammering should never sound like.
      this.next = t + 1 / 2.2 + rand(-0.06, 0.06)
      if (++this.taps % 8 === 0) this.next += rand(0.6, 1.6)
    }
    this.acc += dt
    if (this.acc < 0.1) return
    this.acc = 0
    this.crackle.gain.setTargetAtTime(this.base * rand(0, 0.07), now, 0.05)
  }
}

/** Detuned low saws through a resonant lowpass: a big machine idling, kept well down. */
class ShipHumVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.cutoff = 170
    this.acc = 0
    const now = ctx.currentTime
    this.filter = this.node(filter(ctx, 'lowpass', this.cutoff, 5))
    this.filter.connect(this.out)
    const mix = this.node(gain(ctx, 0.5, this.filter))
    this.source(osc(ctx, 'sawtooth', 55, mix, now))
    this.source(osc(ctx, 'sawtooth', 55.6, mix, now))
    const upper = this.node(gain(ctx, 0.12, this.filter))
    this.source(osc(ctx, 'sawtooth', 110.3, upper, now))
    this.out.gain.value = o.base
  }

  update(dt, now) {
    this.acc += dt
    if (this.acc < 0.2) return
    this.acc = 0
    this.cutoff += (Math.random() - 0.5) * 30
    this.cutoff = Math.min(230, Math.max(130, this.cutoff))
    this.filter.frequency.setTargetAtTime(this.cutoff, now, 0.6)
  }
}

/** A rotor: sine plus a little saw, amplitude-modulated at the blade-pass rate. */
class DroneVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    const now = ctx.currentTime
    const lp = this.node(filter(ctx, 'lowpass', 2400, 0.7))
    lp.connect(this.out)
    const am = this.node(gain(ctx, 0.65, lp))
    const depth = this.node(gain(ctx, 0.35, am.gain))
    this.source(osc(ctx, 'sine', 55, depth, now))
    this.sine = this.source(osc(ctx, 'sine', 210, am, now))
    const sawMix = this.node(gain(ctx, 0.22, am))
    this.saw = this.source(osc(ctx, 'sawtooth', 210, sawMix, now))
    this.out.gain.value = o.base
  }

  setLevel(level) {
    // Throttle pitches the rotor up a touch; the pool sets the loudness itself.
    const f = 210 * (0.92 + 0.16 * level)
    const now = this.ctx.currentTime
    this.sine.frequency.setTargetAtTime(f, now, 0.3)
    this.saw.frequency.setTargetAtTime(f, now, 0.3)
  }
}

/** Small laps of water against a shore, each one its own little rise and fall. */
class ShoreVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.timer = rand(0.5, 2)
    const f = this.node(filter(ctx, 'bandpass', 700, 0.7))
    f.connect(this.out)
    this.source(looped(ctx, noise.brown, f))
    this.out.gain.value = o.base * 0.2
  }

  update(dt, now) {
    this.timer -= dt
    if (this.timer > 0) return
    this.timer = rand(1.5, 4)
    const g = this.out.gain
    g.cancelScheduledValues(now)
    g.setTargetAtTime(this.base * rand(0.6, 1), now, 0.12)
    g.setTargetAtTime(this.base * 0.2, now + 0.35, 0.3)
  }
}

// ---------------------------------------------------------------------------------------------
// One-shots. Each is a function (ctx, dest, now, level) → end time, wrapped into a Voice.

const BIRDS = {
  gull(ctx, dest, now, level) {
    let t = now
    const n = 2 + ((Math.random() * 2) | 0)
    for (let i = 0; i < n; i++) {
      chirp(ctx, dest, t, { f0: rand(1400, 1700), f1: rand(850, 1000), dur: 0.34, gain: level * 0.5, attack: 0.03, decay: 0.12, modF: 28, modD: 70 })
      t += rand(0.4, 0.6)
    }
    return t + 0.2
  },
  parrot(ctx, dest, now, level) {
    let t = now
    const n = 1 + ((Math.random() * 2) | 0)
    for (let i = 0; i < n; i++) {
      chirp(ctx, dest, t, { f0: rand(1000, 1300), fMid: rand(1500, 1900), f1: rand(800, 1000), dur: 0.28, gain: level * 0.45, attack: 0.01, decay: 0.06, modF: 180, modD: 420 })
      t += rand(0.3, 0.5)
    }
    return t + 0.2
  },
  crow(ctx, dest, now, level) {
    let t = now
    const n = 2 + ((Math.random() * 2) | 0)
    for (let i = 0; i < n; i++) {
      chirp(ctx, dest, t, { f0: rand(650, 750), f1: rand(450, 520), dur: 0.26, gain: level * 0.5, attack: 0.02, decay: 0.07, modF: 95, modD: 320 })
      t += rand(0.32, 0.45)
    }
    return t + 0.2
  },
  songbird(ctx, dest, now, level) {
    let t = now
    const n = 3 + ((Math.random() * 4) | 0)
    for (let i = 0; i < n; i++) {
      const up = Math.random() < 0.5
      const a = rand(2500, 4200)
      const b = a * (up ? rand(1.2, 1.6) : rand(0.65, 0.85))
      chirp(ctx, dest, t, { f0: a, f1: b, dur: rand(0.06, 0.12), gain: level * 0.35, attack: 0.008, decay: 0.05, modF: 40, modD: 90 })
      t += rand(0.1, 0.2)
    }
    return t + 0.2
  },
  owl(ctx, dest, now, level) {
    chirp(ctx, dest, now, { f0: 390, f1: 340, dur: 0.32, gain: level * 0.6, attack: 0.06, decay: 0.15 })
    chirp(ctx, dest, now + 0.55, { f0: 380, f1: 320, dur: 0.55, gain: level * 0.6, attack: 0.08, decay: 0.25 })
    return now + 1.6
  },
}

const ONE_SHOTS = {
  thunder(ctx, dest, now, level, noise) {
    const lp = filter(ctx, 'lowpass', 160, 0.9)
    const g = gain(ctx, 0, dest)
    lp.connect(g)
    const dur = rand(3.5, 5.5)
    burst(ctx, noise.brown, lp, now, dur + 1)
    // The rumble darkens as it decays, the way it does when it has come a long way.
    lp.frequency.setValueAtTime(220, now)
    lp.frequency.exponentialRampToValueAtTime(70, now + dur)
    const end = envelope(g.gain, now, level, 0.35, dur, 0.4)
    const sub = gain(ctx, 0, dest)
    const o = osc(ctx, 'sine', 36, sub, now)
    o.stop(envelope(sub.gain, now, level * 0.5, 0.5, dur * 0.7, 0.2) + 0.1)
    return end
  },
  gust(ctx, dest, now, level, noise) {
    const bp = filter(ctx, 'bandpass', 500, 0.8)
    const g = gain(ctx, 0, dest)
    bp.connect(g)
    burst(ctx, noise.pink, bp, now, 4)
    bp.frequency.setValueAtTime(400, now)
    bp.frequency.exponentialRampToValueAtTime(1500, now + 1.1)
    bp.frequency.exponentialRampToValueAtTime(450, now + 3.2)
    return envelope(g.gain, now, level, 1.1, 2.2, 0.2)
  },
  wave(ctx, dest, now, level, noise) {
    const bp = filter(ctx, 'bandpass', 900, 0.6)
    const g = gain(ctx, 0, dest)
    bp.connect(g)
    burst(ctx, noise.brown, bp, now, 3.5)
    const end = envelope(g.gain, now, level, 0.45, 2.4, 0.1)
    // The hiss of it running up the sand trails the break.
    const hp = filter(ctx, 'highpass', 2800, 0.7)
    const hg = gain(ctx, 0, dest)
    hp.connect(hg)
    burst(ctx, noise.white, hp, now + 0.3, 3.2)
    envelope(hg.gain, now + 0.3, level * 0.35, 0.6, 2, 0.3)
    return end
  },
  splash(ctx, dest, now, level, noise) {
    const bp = filter(ctx, 'bandpass', 2500, 1)
    const g = gain(ctx, 0, dest)
    bp.connect(g)
    burst(ctx, noise.white, bp, now, 0.4)
    const end = envelope(g.gain, now, level * 0.7, 0.005, 0.3)
    chirp(ctx, dest, now, { f0: 600, f1: 180, dur: 0.07, gain: level * 0.6, attack: 0.003, decay: 0.05 })
    return end
  },
  geyser(ctx, dest, now, level, noise) {
    const bp = filter(ctx, 'bandpass', 1400, 0.6)
    const g = gain(ctx, 0, dest)
    bp.connect(g)
    burst(ctx, noise.white, bp, now, 5.5)
    bp.frequency.setValueAtTime(600, now)
    bp.frequency.exponentialRampToValueAtTime(2200, now + 1.2)
    bp.frequency.exponentialRampToValueAtTime(900, now + 4.5)
    const end = envelope(g.gain, now, level, 0.9, 2.2, 1.8)
    const lp = filter(ctx, 'lowpass', 140, 0.8)
    const rg = gain(ctx, 0, dest)
    lp.connect(rg)
    burst(ctx, noise.brown, lp, now, 5)
    envelope(rg.gain, now, level * 0.8, 0.7, 2, 1.5)
    return end
  },
  ember(ctx, dest, now, level, noise) {
    let t = now
    const n = 1 + ((Math.random() * 3) | 0)
    for (let i = 0; i < n; i++) {
      const hp = filter(ctx, 'highpass', 2200, 0.8)
      const g = gain(ctx, 0, dest)
      hp.connect(g)
      burst(ctx, noise.white, hp, t, 0.04)
      envelope(g.gain, t, level * 0.5, 0.002, 0.03)
      chirp(ctx, dest, t, { f0: rand(700, 1100), f1: 250, dur: 0.05, gain: level * 0.4, attack: 0.002, decay: 0.04 })
      t += rand(0.12, 0.5)
    }
    return t + 0.1
  },
  iceCrack(ctx, dest, now, level, noise) {
    const hp = filter(ctx, 'highpass', 3000, 0.8)
    const g = gain(ctx, 0, dest)
    hp.connect(g)
    burst(ctx, noise.white, hp, now, 0.03)
    envelope(g.gain, now, level * 0.6, 0.001, 0.025)
    // The ring is the sheet itself: a very narrow bandpass struck by the same tick.
    const ring = filter(ctx, 'bandpass', rand(1500, 2100), 24)
    const rg = gain(ctx, 0, dest)
    ring.connect(rg)
    burst(ctx, noise.white, ring, now, 0.05)
    envelope(rg.gain, now, level * 1.2, 0.002, 0.45)
    chirp(ctx, dest, now + 0.01, { f0: 140, f1: 60, dur: 0.08, gain: level * 0.5, attack: 0.002, decay: 0.08 })
    return now + 0.6
  },
  coyote(ctx, dest, now, level) {
    const lp = filter(ctx, 'lowpass', 1500, 0.7)
    const g = gain(ctx, 0, dest)
    lp.connect(g)
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(480, now)
    o.frequency.exponentialRampToValueAtTime(920, now + 0.55)
    o.frequency.exponentialRampToValueAtTime(860, now + 1.4)
    o.frequency.exponentialRampToValueAtTime(560, now + 2.1)
    o.connect(lp)
    o.start(now)
    const m = osc(ctx, 'sine', 5.5, gain(ctx, 14, o.frequency), now)
    const end = envelope(g.gain, now, level * 0.5, 0.25, 0.5, 1.6)
    o.stop(end + 0.05)
    m.stop(end + 0.05)
    return end
  },
  droneDrop(ctx, dest, now, level, noise) {
    const g = gain(ctx, 0, dest)
    const o = osc(ctx, 'square', 2400, g, now)
    o.stop(envelope(g.gain, now, level * 0.12, 0.002, 0.03) + 0.02)
    const hp = filter(ctx, 'highpass', 4000, 0.8)
    const ng = gain(ctx, 0, dest)
    hp.connect(ng)
    burst(ctx, noise.white, hp, now, 0.02)
    envelope(ng.gain, now, level * 0.25, 0.001, 0.02)
    chirp(ctx, dest, now + 0.09, { f0: 140, f1: 55, dur: 0.1, gain: level * 0.8, attack: 0.004, decay: 0.12 })
    return now + 0.4
  },
  /**
   * Two soft marimba-ish notes a fifth apart. The one sound allowed to interrupt, so it is
   * built to be un-hateable: slow attack, a long even decay, nothing above the fourth partial.
   */
  chime(ctx, dest, now, level) {
    const note = (f, t) => {
      const g = gain(ctx, 0, dest)
      const a = osc(ctx, 'sine', f, g, t)
      const pg = gain(ctx, 0.22, g)
      const p = osc(ctx, 'sine', f * 4, pg, t)
      pg.gain.setTargetAtTime(0, t + 0.02, 0.12) // the bright partial dies first
      const end = envelope(g.gain, t, level, 0.02, 1.4)
      a.stop(end + 0.05)
      p.stop(end + 0.05)
      return end
    }
    note(523.25, now)
    return note(783.99, now + 0.22)
  },
}

function bird(kind) {
  return (ctx, dest, now, level) => (BIRDS[kind] || BIRDS.songbird)(ctx, dest, now, level)
}

/** Wrap a scheduling function into a Voice that knows when it will be over. */
/**
 * A robot's word: a run of short square-ish chirps, each gliding from one pitch to the next
 * with a hair of space between them. The tables are [from Hz, to Hz, seconds] per syllable.
 */
function robotPhrase(syllables) {
  return (ctx, dest, now, level) => {
    let t = now
    for (const [f0, f1, dur] of syllables) {
      chirp(ctx, dest, t, { f0, f1, dur, gain: level * 0.5, attack: 0.008, decay: dur * 0.9 })
      t += dur + 0.035
    }
    return t + 0.15
  }
}

/**
 * A little robot's beep-boop: round sine blips, each with a soft octave partial and a hair
 * of pitch droop at the end, like a toy. The table is [Hz, seconds] per blip.
 */
function beepBoop(blips) {
  return (ctx, dest, now, level) => {
    let t = now
    for (const [f, dur] of blips) {
      chirp(ctx, dest, t, { f0: f, f1: f * 0.94, dur, gain: level * 0.42, attack: 0.006, decay: dur * 0.7 })
      chirp(ctx, dest, t, { f0: f * 2, f1: f * 1.9, dur: dur * 0.6, gain: level * 0.09, attack: 0.004, decay: dur * 0.4 })
      t += dur + 0.05
    }
    return t + 0.12
  }
}

function oneShot(fn) {
  return (ctx, dest, o, noise) => {
    const v = new Voice(ctx, dest)
    // Contours are written at unit level; the engine sets the actual loudness outside.
    v.until = fn(ctx, v.out, ctx.currentTime, 1, noise, o) + 0.05
    return v
  }
}

// ---------------------------------------------------------------------------------------------
// The generator table the registry points at. Each is (ctx, dest, opts, noise) → Voice.

export const GENERATORS = {
  // Beds
  'wind-soft': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 240, hi: 900, base: 0.5, swell: 0.4, rate: 0.7 }),
  'wind-desert': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 350, hi: 1500, base: 0.55, swell: 0.6, rate: 1.3 }),
  'wind-arctic': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 600, hi: 2200, base: 0.45, swell: 0.55, rate: 1, q: 1.8 }),
  'wind-high': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 500, hi: 1800, base: 0.45, swell: 0.35, rate: 0.9, q: 1.2 }),
  'snow-wind': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 300, hi: 1100, base: 0.35, swell: 0.5, rate: 0.6, q: 1.5 }),
  'mars-wind': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 1800, hi: 3800, base: 0.22, swell: 0.6, rate: 1.4, q: 1.5, type: 'bandpass', noise: 'white' }),
  'cherry-breeze': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 200, hi: 700, base: 0.28, swell: 0.5, rate: 0.5 }),
  'autumn-rustle': (ctx, d, o, n) => new FlutterVoice(ctx, d, n, { center: 2600, q: 0.8, base: 0.22, depth: 0.7, speed: 9 }),
  'surf': (ctx, d, o, n) => new SurfVoice(ctx, d, n, { center: 500, base: 0.6, period: [7, 13] }),
  'surf-gentle': (ctx, d, o, n) => new SurfVoice(ctx, d, n, { center: 380, base: 0.32, period: [8, 13] }),
  'ocean-swell': (ctx, d, o, n) => new SurfVoice(ctx, d, n, { center: 220, base: 0.45, period: [9, 16], type: 'lowpass', q: 0.8 }),
  'stream': (ctx, d, o, n) => new FlutterVoice(ctx, d, n, { center: 1300, q: 0.6, base: 0.3, depth: 0.25, speed: 12 }),
  'jungle-insects': (ctx, d, o, n) => new InsectVoice(ctx, d, n, { base: 0.16 }),
  'jungle-birds': (ctx, d, o, n) => new BirdBedVoice(ctx, d, n, { base: 0.5, kinds: ['parrot', 'songbird', 'songbird'], every: [3, 9], hiss: 0.05 }),
  'meadow-birds': (ctx, d, o, n) => new BirdBedVoice(ctx, d, n, { base: 0.35, kinds: ['songbird'], every: [4, 12] }),
  'rainforest-rain': (ctx, d, o, n) => new FlutterVoice(ctx, d, n, { center: 1800, q: 0.3, base: 0.35, depth: 0.15, speed: 4 }),
  'crickets': (ctx, d, o, n) => new CricketVoice(ctx, d, n, { base: 0.18 }),
  'lava-rumble': (ctx, d, o, n) => new LavaVoice(ctx, d, n, { base: 0.6 }),
  'volcanic-hiss': (ctx, d, o, n) => new HissVoice(ctx, d, n, { base: 0.12 }),
  'lunar-silence': (ctx, d, o, n) => new HumVoice(ctx, d, n, { base: 0.07, freq: 48, radio: 0.05 }),

  // One-shots
  'gull': oneShot(bird('gull')),
  'parrot': oneShot(bird('parrot')),
  'crow': oneShot(bird('crow')),
  'songbird': oneShot(bird('songbird')),
  'owl': oneShot(bird('owl')),
  'bird-call': oneShot((ctx, dest, now, level, noise, o) => bird(o?.kind)(ctx, dest, now, level)),
  'thunder-distant': oneShot(ONE_SHOTS.thunder),
  'wind-gust': oneShot(ONE_SHOTS.gust),
  'wave-crash': oneShot(ONE_SHOTS.wave),
  'fish-splash': oneShot(ONE_SHOTS.splash),
  'geyser': oneShot(ONE_SHOTS.geyser),
  'ember-pop': oneShot(ONE_SHOTS.ember),
  'ice-crack': oneShot(ONE_SHOTS.iceCrack),
  'coyote': oneShot(ONE_SHOTS.coyote),
  'drone-drop': oneShot(ONE_SHOTS.droneDrop),
  'select-1': oneShot(robotPhrase([[880, 1320, 0.09], [1320, 1180, 0.12]])),
  'select-2': oneShot(beepBoop([[1318, 0.08], [659, 0.13]])), // beep, boop
  'select-3': oneShot(beepBoop([[784, 0.07], [1046, 0.07], [1568, 0.11]])), // boo-dee-beep
  'select-4': oneShot(robotPhrase([[520, 780, 0.08], [780, 1040, 0.08], [1040, 1300, 0.12]])),
  'select-5': oneShot(robotPhrase([[980, 980, 0.07], [980, 980, 0.07], [1470, 1240, 0.14]])),
  'select-6': oneShot(robotPhrase([[1200, 900, 0.1], [600, 1000, 0.16]])),
  'chime-attention': oneShot(ONE_SHOTS.chime),

  // Positional loops
  'work-hammer': (ctx, d, o, n) => new HammerVoice(ctx, d, n, { base: 0.5 }),
  'ship-hum': (ctx, d, o, n) => new ShipHumVoice(ctx, d, n, { base: 0.2 }),
  'drone-whine': (ctx, d, o, n) => new DroneVoice(ctx, d, n, { base: 0.22 }),
  'shore-lap': (ctx, d, o, n) => new ShoreVoice(ctx, d, n, { base: 0.4 }),
}
