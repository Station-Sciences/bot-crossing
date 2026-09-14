/**
 * Procedural Web Audio API soundscape and SFX.
 *
 * 100% synthesized in code — zero external audio assets or downloads.
 * Provides subtle sci-fi / colony-sim feedback:
 *   - Ambient atmospheric background generators tailored to each planet (Luna, Mars, Terra)
 *   - Spatial/situational SFX: hammering, attention/waiting ('?'), celebration ('✓'), error ('!')
 *   - UI feedback: clean micro-clicks and astronaut selection chirps.
 */

export class SoundManager {
  constructor(settings) {
    this.settings = settings
    this.ctx = null
    this.masterGain = null
    this.sfxGain = null
    this.ambientGain = null

    this.ambientNodes = null
    this.currentPlanet = null
    this._initialized = false

    // Attach user gesture unlock
    const unlock = () => {
      this.init()
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume()
      }
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock, { passive: true })

    if (settings) {
      settings.onChange((keys) => {
        if (
          keys.has('soundEnabled') ||
          keys.has('sfxVolume') ||
          keys.has('ambientEnabled') ||
          keys.has('ambientVolume') ||
          keys.has('planet')
        ) {
          this.syncSettings()
        }
      })
    }
  }

  init() {
    if (this._initialized) return
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return
      this.ctx = new AudioCtx()

      this.masterGain = this.ctx.createGain()
      this.masterGain.connect(this.ctx.destination)

      this.sfxGain = this.ctx.createGain()
      this.sfxGain.connect(this.masterGain)

      this.ambientGain = this.ctx.createGain()
      this.ambientGain.connect(this.masterGain)

      this._initialized = true
      this.syncSettings()
      if (this.settings) {
        this.setPlanet(this.settings.get('planet') || 'moon')
      }
    } catch {
      // Web Audio unavailable
    }
  }

  syncSettings() {
    if (!this._initialized || !this.ctx) return
    const soundEnabled = this.settings ? Boolean(this.settings.get('soundEnabled')) : true
    const sfxVol = this.settings ? Number(this.settings.get('sfxVolume') ?? 0.7) : 0.7
    const ambEnabled = this.settings ? Boolean(this.settings.get('ambientEnabled')) : true
    const ambVol = this.settings ? Number(this.settings.get('ambientVolume') ?? 0.4) : 0.4
    const planet = this.settings ? this.settings.get('planet') : 'moon'

    const now = this.ctx.currentTime
    this.masterGain.gain.setTargetAtTime(soundEnabled ? 1 : 0, now, 0.05)
    this.sfxGain.gain.setTargetAtTime(soundEnabled ? sfxVol : 0, now, 0.05)
    this.ambientGain.gain.setTargetAtTime(soundEnabled && ambEnabled ? ambVol : 0, now, 0.1)

    if (planet && planet !== this.currentPlanet) {
      this.setPlanet(planet)
    }
  }

  // ── SFX ─────────────────────────────────────────────────────────────────────────────

  /** Soft UI button tick */
  playClick() {
    if (!this._canPlaySfx()) return
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(1100, now)
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.04)

    gain.gain.setValueAtTime(0.12, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04)

    osc.connect(gain)
    gain.connect(this.sfxGain)
    osc.start(now)
    osc.stop(now + 0.045)
  }

  /** Friendly radio / chirp when selecting an astronaut */
  playSelect() {
    if (!this._canPlaySfx()) return
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(540, now)
    osc.frequency.setValueAtTime(780, now + 0.04)
    osc.frequency.exponentialRampToValueAtTime(1020, now + 0.09)

    gain.gain.setValueAtTime(0.15, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12)

    osc.connect(gain)
    gain.connect(this.sfxGain)
    osc.start(now)
    osc.stop(now + 0.13)
  }

  /** Metallic tap/clink when an astronaut is hammering */
  playHammer() {
    if (!this._canPlaySfx()) return
    const now = this.ctx.currentTime

    // Filtered resonant metal ping
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(1600 + Math.random() * 200, now)
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.06)

    gain.gain.setValueAtTime(0.08, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06)

    osc.connect(gain)
    gain.connect(this.sfxGain)
    osc.start(now)
    osc.stop(now + 0.065)
  }

  /** Subtle radio alert chime when an agent needs user input ('?') */
  playAttention() {
    if (!this._canPlaySfx()) return
    const now = this.ctx.currentTime

    const playTone = (freq, start, dur) => {
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, start)
      gain.gain.setValueAtTime(0.18, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
      osc.connect(gain)
      gain.connect(this.sfxGain)
      osc.start(start)
      osc.stop(start + dur + 0.01)
    }

    playTone(880, now, 0.12)
    playTone(1320, now + 0.13, 0.22)
  }

  /** Uplifting major arpeggio when a PR is merged ('✓') */
  playCelebration() {
    if (!this._canPlaySfx()) return
    const now = this.ctx.currentTime
    const notes = [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const start = now + i * 0.08
      const osc = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, start)
      gain.gain.setValueAtTime(0.16, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25)
      osc.connect(gain)
      gain.connect(this.sfxGain)
      osc.start(start)
      osc.stop(start + 0.26)
    })
  }

  /** Warning glitch/buzz when an agent encounters an error ('!') */
  playError() {
    if (!this._canPlaySfx()) return
    const now = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const filter = this.ctx.createBiquadFilter()
    const gain = this.ctx.createGain()

    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(140, now)
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.18)

    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(600, now)

    gain.gain.setValueAtTime(0.15, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)

    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.sfxGain)
    osc.start(now)
    osc.stop(now + 0.19)
  }

  // ── Ambient generator ───────────────────────────────────────────────────────────────

  setPlanet(planet) {
    this.currentPlanet = planet
    if (!this._initialized || !this.ctx) return
    this._stopAmbient()
    this._startAmbient(planet)
  }

  _startAmbient(planet) {
    if (!this.ctx) return
    const now = this.ctx.currentTime

    // Luna: deep low-frequency cosmic drone with gentle subtle shimmer
    if (planet === 'moon') {
      const osc1 = this.ctx.createOscillator()
      const osc2 = this.ctx.createOscillator()
      const gain = this.ctx.createGain()
      const filter = this.ctx.createBiquadFilter()

      osc1.type = 'sine'
      osc1.frequency.setValueAtTime(55, now) // A1 sub
      osc2.type = 'sine'
      osc2.frequency.setValueAtTime(110.5, now) // Slight detuned A2

      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(180, now)

      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.12, now + 2)

      osc1.connect(filter)
      osc2.connect(filter)
      filter.connect(gain)
      gain.connect(this.ambientGain)

      osc1.start(now)
      osc2.start(now)

      this.ambientNodes = {
        stop: () => {
          const t = this.ctx.currentTime
          gain.gain.linearRampToValueAtTime(0.001, t + 1)
          setTimeout(() => {
            try {
              osc1.stop()
              osc2.stop()
              osc1.disconnect()
              osc2.disconnect()
            } catch { }
          }, 1100)
        },
      }
      return
    }

    // Mars: pink noise wind generator with LFO filter sweep
    if (planet === 'mars') {
      const noiseBuffer = this._createNoiseBuffer(3)
      const noise = this.ctx.createBufferSource()
      noise.buffer = noiseBuffer
      noise.loop = true

      const filter = this.ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.setValueAtTime(320, now)
      filter.Q.setValueAtTime(1.8, now)

      // LFO for breathing wind effect
      const lfo = this.ctx.createOscillator()
      const lfoGain = this.ctx.createGain()
      lfo.type = 'sine'
      lfo.frequency.setValueAtTime(0.15, now) // 0.15 Hz wind gust
      lfoGain.gain.setValueAtTime(140, now)
      lfo.connect(lfoGain)
      lfoGain.connect(filter.frequency)

      const gain = this.ctx.createGain()
      gain.gain.setValueAtTime(0.001, now)
      gain.gain.linearRampToValueAtTime(0.16, now + 2)

      noise.connect(filter)
      filter.connect(gain)
      gain.connect(this.ambientGain)

      noise.start(now)
      lfo.start(now)

      this.ambientNodes = {
        stop: () => {
          const t = this.ctx.currentTime
          gain.gain.linearRampToValueAtTime(0.001, t + 1)
          setTimeout(() => {
            try {
              noise.stop()
              lfo.stop()
              noise.disconnect()
              lfo.disconnect()
            } catch { }
          }, 1100)
        },
      }
      return
    }

    // Terra: gentle nature breeze with foliage rustle, airy Aeolian whistle, and subtle wind chimes
    if (planet === 'terra') {
      let isStopped = false
      let chimeTimer = null
      const activeChimeNodes = new Set()

      // 1. Desiran angin padang rumput & dedaunan (filtered pink noise dengan ayunan LFO alami)
      const noiseBuffer = this._createNoiseBuffer(5)
      const breeze = this.ctx.createBufferSource()
      breeze.buffer = noiseBuffer
      breeze.loop = true

      const breezeFilter = this.ctx.createBiquadFilter()
      breezeFilter.type = 'lowpass'
      breezeFilter.frequency.setValueAtTime(240, now)

      // LFO sangat lambat (0.07 Hz ~14 detik) untuk hembusan angin yang alami dan tidak monoton
      const breezeLfo = this.ctx.createOscillator()
      const breezeLfoGain = this.ctx.createGain()
      breezeLfo.frequency.setValueAtTime(0.07, now)
      breezeLfoGain.gain.setValueAtTime(110, now)
      breezeLfo.connect(breezeLfoGain)
      breezeLfoGain.connect(breezeFilter.frequency)

      const breezeGain = this.ctx.createGain()
      breezeGain.gain.setValueAtTime(0.001, now)
      breezeGain.gain.linearRampToValueAtTime(0.045, now + 3)

      breeze.connect(breezeFilter)
      breezeFilter.connect(breezeGain)
      breezeGain.connect(this.ambientGain)

      // 2. Harmoni siulan angin di celah rumput/pepohonan (Aeolian nature harmonics - E4, G4, B4 pentatonik lembut)
      const osc1 = this.ctx.createOscillator()
      const osc2 = this.ctx.createOscillator()
      const osc3 = this.ctx.createOscillator()
      const aeolianFilter = this.ctx.createBiquadFilter()
      const aeolianGain = this.ctx.createGain()

      osc1.type = 'sine'
      osc1.frequency.setValueAtTime(329.63, now) // E4 (nada udara sejuk)
      osc2.type = 'sine'
      osc2.frequency.setValueAtTime(392.0, now)  // G4
      osc3.type = 'sine'
      osc3.frequency.setValueAtTime(493.88, now) // B4

      aeolianFilter.type = 'bandpass'
      aeolianFilter.frequency.setValueAtTime(400, now)
      aeolianFilter.Q.setValueAtTime(1.2, now)

      aeolianGain.gain.setValueAtTime(0.001, now)
      aeolianGain.gain.linearRampToValueAtTime(0.018, now + 3) // Sangat lembut di latar belakang

      osc1.connect(aeolianFilter)
      osc2.connect(aeolianFilter)
      osc3.connect(aeolianFilter)
      aeolianFilter.connect(aeolianGain)
      aeolianGain.connect(this.ambientGain)

      // 3. Tingkikan lonceng angin alam (gentle wind chime pings tertiup angin sesekali)
      const chimeNotes = [587.33, 659.25, 783.99, 880.0, 987.77, 1174.66] // D5, E5, G5, A5, B5, D6
      const triggerChime = () => {
        if (isStopped || !this.ctx || this.ctx.state !== 'running') return
        try {
          const t = this.ctx.currentTime
          const chimeOsc = this.ctx.createOscillator()
          const chimeGain = this.ctx.createGain()
          const chimeFilter = this.ctx.createBiquadFilter()

          const note = chimeNotes[Math.floor(Math.random() * chimeNotes.length)]
          chimeOsc.type = 'sine'
          chimeOsc.frequency.setValueAtTime(note, t)

          chimeFilter.type = 'lowpass'
          chimeFilter.frequency.setValueAtTime(1600, t)

          // Lonceng lembut dengan peluruhan eksponensial panjang
          chimeGain.gain.setValueAtTime(0.0001, t)
          chimeGain.gain.linearRampToValueAtTime(0.022, t + 0.04)
          chimeGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.8)

          chimeOsc.connect(chimeFilter)
          chimeFilter.connect(chimeGain)
          chimeGain.connect(this.ambientGain)

          activeChimeNodes.add(chimeOsc)
          chimeOsc.start(t)
          chimeOsc.stop(t + 2.9)

          setTimeout(() => {
            try {
              activeChimeNodes.delete(chimeOsc)
              chimeOsc.disconnect()
              chimeFilter.disconnect()
              chimeGain.disconnect()
            } catch { }
          }, 3000)
        } catch { }

        // Interval acak antara 4 hingga 8.5 detik
        const nextDelay = 4000 + Math.random() * 4500
        chimeTimer = setTimeout(triggerChime, nextDelay)
      }

      breeze.start(now)
      breezeLfo.start(now)
      osc1.start(now)
      osc2.start(now)
      osc3.start(now)

      // Mulai jadwal lonceng angin pertama setelah 2 detik
      chimeTimer = setTimeout(triggerChime, 2000)

      this.ambientNodes = {
        stop: () => {
          isStopped = true
          if (chimeTimer) clearTimeout(chimeTimer)
          for (const node of activeChimeNodes) {
            try {
              node.stop()
              node.disconnect()
            } catch { }
          }
          activeChimeNodes.clear()

          const t = this.ctx.currentTime
          breezeGain.gain.linearRampToValueAtTime(0.0001, t + 1)
          aeolianGain.gain.linearRampToValueAtTime(0.0001, t + 1)
          setTimeout(() => {
            try {
              breeze.stop()
              breezeLfo.stop()
              osc1.stop()
              osc2.stop()
              osc3.stop()
              breeze.disconnect()
              breezeLfo.disconnect()
              breezeLfoGain.disconnect()
              osc1.disconnect()
              osc2.disconnect()
              osc3.disconnect()
              aeolianFilter.disconnect()
              aeolianGain.disconnect()
              breezeFilter.disconnect()
              breezeGain.disconnect()
            } catch { }
          }, 1100)
        },
      }
      return
    }

  }

  _stopAmbient() {
    if (this.ambientNodes) {
      try {
        this.ambientNodes.stop()
      } catch { }
      this.ambientNodes = null
    }
  }

  _createNoiseBuffer(seconds) {
    const sampleRate = this.ctx.sampleRate
    const bufferSize = sampleRate * seconds
    const buffer = this.ctx.createBuffer(1, bufferSize, sampleRate)
    const data = buffer.getChannelData(0)
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + white * 0.0555179
      b1 = 0.99332 * b1 + white * 0.0750759
      b2 = 0.969 * b2 + white * 0.153852
      b3 = 0.8665 * b3 + white * 0.3104856
      b4 = 0.55 * b4 + white * 0.5329522
      b5 = -0.7616 * b5 - white * 0.016898
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
      b6 = white * 0.115926
    }
    return buffer
  }

  _canPlaySfx() {
    if (!this._initialized || !this.ctx) return false
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { })
      return false
    }
    const soundEnabled = this.settings ? Boolean(this.settings.get('soundEnabled')) : true
    const sfxVol = this.settings ? Number(this.settings.get('sfxVolume') ?? 0.7) : 0.7
    return soundEnabled && sfxVol > 0
  }
}
