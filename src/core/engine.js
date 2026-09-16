import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { Pass } from 'three/addons/postprocessing/Pass.js'

/**
 * The layer for things that are *read* rather than looked at — status badges, name plates.
 * Their own pass follows bloom and depth of field so symbols stay sharp regardless of
 * the scene depth behind them. With the composer off they are simply part of the scene.
 */
export const OVERLAY_LAYER = 1
import { SHADOW_SIZES } from './settings.js'
import { createTiltShift } from './tiltshift.js'
import { OcclusionPass } from './occlusion.js'

/** Safari and friends — not Chrome, which also says "Safari" in its user agent. */
const IS_WEBKIT =
  typeof navigator !== 'undefined' &&
  /apple/i.test(navigator.vendor || '') &&
  !/chrome|chromium|edg\//i.test(navigator.userAgent || '')

/**
 * Renderer, post chain, and the frame loop.
 *
 * Two things here are load-bearing for performance:
 *
 * 1. **The post chain is built lazily and torn down when off.** With bloom disabled the
 *    composer is not merely skipped — it is disposed, so its float render targets stop
 *    costing memory and bandwidth. Turning HDR off on a weak machine has to actually
 *    give the memory back, not just stop drawing.
 * 2. **Render scale is separate from device pixel ratio.** `setPixelRatio` alone cannot go
 *    below 1 usefully on a retina panel, so the drawing buffer is sized directly. That is
 *    the single biggest lever there is, and it is what the auto-quality governor pulls.
 *
 *    The setting is a fraction of *the display's own resolution*, not of CSS pixels: 100%
 *    on a retina panel is 2 buffer pixels per CSS pixel. Reading it as CSS pixels is what
 *    the earlier version did, and it quietly rendered every retina machine at half
 *    resolution — text on the name plates and the badge glyphs magnify hardest, so they
 *    are where a soft buffer shows up first.
 */
export class Engine {
  constructor(settings) {
    this.settings = settings
    // Timer replaces the deprecated Clock. Connecting it to the document means a tab that
    // has been in the background reports a zero delta rather than one enormous catch-up
    // frame, so nothing in the colony teleports when you come back to it.
    this.timer = new THREE.Timer()
    this.timer.connect(document)
    this.elapsed = 0
    this.updaters = []
    this.running = false

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.5, 900)

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // handled by SMAA in the post chain, or not at all
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      /**
       * Off everywhere it can be: preserving the buffer costs a full copy on every frame,
       * forever, and the screenshot path already works around needing it.
       *
       * On WebKit it has to be on. Safari treats a window with another app in front of it
       * as *hidden*, stops driving `requestAnimationFrame`, and then composites the canvas
       * anyway — and a drawing buffer nobody has drawn into since the last composite is
       * transparent black. The symptom is the whole colony blinking out for a frame every
       * few seconds, but only while something is layered over the window, which is exactly
       * the case where nothing is repainting it.
       */
      preserveDrawingBuffer: IS_WEBKIT,
    })
    this.renderer.setPixelRatio(1) // the drawing buffer is sized by hand, see resize()
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = settings.get('exposure')
    // PCFSoftShadowMap is deprecated and silently downgraded by three anyway.
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.info.autoReset = false

    this.canvas = this.renderer.domElement
    this.canvas.classList.add('bot-crossing-canvas')

    this.composer = null
    this.bloomPass = null
    this.occlusionPass = null
    this.smaaPass = null
    this.tiltShift = null
    this.gradePass = null
    /** The planet's own nudge to the grade, multiplied into the user's sliders. */
    this._planetGrade = { saturation: 1, warmth: 0 }
    /** How far the view is orbiting; the focal plane sits here. Fed by the frame loop. */
    this._focusDistance = 30

    this.perf = new PerfMonitor()
    this._boundLoop = this._loop.bind(this)
    this._onResize = () => this.resize()

    this.applySettings()
  }

  mount(parent) {
    parent.appendChild(this.canvas)
    window.addEventListener('resize', this._onResize)
    // A window dragged between a retina and a non-retina display changes DPR with no resize.
    this._dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this._dprQuery.addEventListener?.('change', this._onResize)
    // A page that loads in a background tab has a zero-width parent and no `resize` event
    // coming, which would leave a one-pixel drawing buffer until the window happened to
    // move. The observer fires the moment the element is actually laid out.
    this._observer = new ResizeObserver(this._onResize)
    this._observer.observe(parent)

    // Coming back from hidden — a tab switch, or another window moving off this one — the
    // compositor can ask for the canvas before the frame loop has run once. Drawing here
    // rather than waiting for the next animation frame is what stops that moment being a
    // black flash.
    this._onWake = () => {
      if (document.hidden || !this.running) return
      this.resize()
      this.renderFrame()
    }
    document.addEventListener('visibilitychange', this._onWake)
    window.addEventListener('focus', this._onWake)
    window.addEventListener('pageshow', this._onWake)

    this.resize()
    return this
  }

  add(updater) {
    this.updaters.push(updater)
    return updater
  }

  /** Rebuilds only what a settings change actually invalidated. */
  applySettings() {
    const s = this.settings
    const renderer = this.renderer

    const size = SHADOW_SIZES[s.get('shadows')] || 0
    renderer.shadowMap.enabled = size > 0
    // A shadow map that changes size has to be thrown away or three keeps the old target.
    if (this._shadowSize !== size) {
      this._shadowSize = size
      this.scene.traverse((o) => {
        if (o.isLight && o.shadow?.map) {
          o.shadow.map.dispose()
          o.shadow.map = null
          if (size) o.shadow.mapSize.setScalar(size)
        }
      })
      renderer.shadowMap.needsUpdate = true
    }

    renderer.toneMappingExposure = s.get('exposure')
    this.camera.fov = s.get('fov')
    this.camera.updateProjectionMatrix()

    const wantsPost = this._wantsPost()
    if (wantsPost) this._ensureComposer()
    else this._disposeComposer()

    if (this.composer) {
      this.occlusionPass?.setStrength(s.get('ambientOcclusion'))
      if (this.bloomPass) {
        this.bloomPass.enabled = s.get('bloom')
        this.bloomPass.strength = s.get('bloomStrength')
      }
      if (this.smaaPass) this.smaaPass.enabled = s.get('antialias')
      if (this.gradePass) {
        this.gradePass.enabled = s.get('colorGrade')
        this._syncGrade()
      }
      if (this.tiltShift) {
        this.tiltShift.enabled = s.get('tiltShift')
        this.tiltShift.setStrength(s.get('tiltShiftStrength'))
        this.tiltShift.setAngle(s.get('tiltShiftAngle'))
        this.tiltShift.setCamera(this.camera)
      }
    }

    this.resize()
  }

  _ensureComposer() {
    if (this.composer) return
    // A depth texture on the target is what lets tilt-shift be a real depth of field rather
    // than a screen-space smear. It costs one attachment, where asking three's own BokehPass
    // for the same thing costs a second pass over the entire scene.
    const depthTexture = new THREE.DepthTexture(1, 1)
    depthTexture.type = THREE.UnsignedIntType
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // HDR: values above 1 survive to the bloom pass
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    })
    const composer = new EffectComposer(this.renderer, target)
    composer.addPass(new RenderPass(this.scene, this.camera))

    // Contact shading comes before bloom/defocus and never touches the readable overlays.
    this.occlusionPass = new OcclusionPass(this.camera)
    this.occlusionPass.setStrength(this.settings.get('ambientOcclusion'))
    composer.addPass(this.occlusionPass)

    // A high threshold is what keeps this an accent rather than a haze: only the eyes,
    // lamps, sparks and the sun's disc clear it, so lit surfaces stay crisp.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), this.settings.get('bloomStrength'), 0.55, 0.92)
    composer.addPass(this.bloomPass)

    // After bloom, so an out-of-focus lamp keeps its glow and the glow goes soft with it
    // — blurring first would drop those pixels under the bloom threshold and switch the
    // glow off exactly where the eye expects the most of it. Still before OutputPass, so
    // the blur averages linear HDR values rather than tone-mapped ones.
    this.tiltShift = createTiltShift()
    for (const pass of this.tiltShift.passes) composer.addPass(pass)
    // RenderPass and the bloom pass both leave their result in the composer's *read* buffer
    // and neither asks for a swap, so renderTarget2 is what actually holds the scene — and
    // its depth texture is the clone that got written, not the one handed in above.
    // Deliberately not bound to a fixed target here — see `_syncDepthTexture`.
    this.tiltShift.enabled = this.settings.get('tiltShift')
    this.tiltShift.setStrength(this.settings.get('tiltShiftStrength'))
    this.tiltShift.setAngle(this.settings.get('tiltShiftAngle'))
    this.tiltShift.setCamera(this.camera)
    this.tiltShift.setFocusDistance(this._focusDistance)

    // Draw readable overlays after both blur passes. Badges don't write depth, so putting
    // them before tilt-shift blurs them using the depth of the house or sky behind them.
    // Keep them in linear HDR here so OutputPass still applies their existing colour treatment.
    composer.addPass(new OverlayPass(this.scene, this.camera))

    // OutputPass is what applies tone mapping + sRGB once, at the end of the chain.
    composer.addPass(new OutputPass())

    // The grade sits on the finished, display-referred image: a touch more saturation, a
    // warm cast, lifted shadows and a soft vignette. Doing it after tone mapping is what
    // keeps it a *grade* — the same nudge whatever the exposure — rather than a change to
    // the lighting.
    this.gradePass = new ShaderPass(GRADE_SHADER)
    this.gradePass.enabled = this.settings.get('colorGrade')
    composer.addPass(this.gradePass)
    this._syncGrade()

    this.smaaPass = new SMAAPass(1, 1)
    composer.addPass(this.smaaPass)

    this.composer = composer
  }

  _disposeComposer() {
    if (!this.composer) return
    for (const pass of this.composer.passes) pass.dispose?.()
    this.composer.dispose()
    this.composer = null
    this.bloomPass = null
    this.occlusionPass = null
    this.smaaPass = null
    this.tiltShift = null
    this.gradePass = null
  }

  _wantsPost() {
    const s = this.settings
    return Boolean(s.get('bloom') || s.get('antialias') || s.get('tiltShift') || s.get('colorGrade') || s.get('ambientOcclusion') > 0)
  }

  /** A planet's own colour character — Mars a little warm, Frost a little cool. */
  setPlanetGrade(grade) {
    this._planetGrade = { saturation: grade?.saturation ?? 1, warmth: grade?.warmth ?? 0 }
    this._syncGrade()
  }

  _syncGrade() {
    if (!this.gradePass) return
    const u = this.gradePass.uniforms
    u.uSaturation.value = this.settings.get('saturation') * this._planetGrade.saturation
    u.uWarmth.value = this._planetGrade.warmth
    u.uVignette.value = this.settings.get('vignette')
  }

  resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const w = Math.max(1, parent.clientWidth)
    const h = Math.max(1, parent.clientHeight)

    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()

    const ceiling = this._targetScale()
    // A focus event or a new window size must not undo an adaptive reduction. Only a
    // changed resolution setting/DPR or disabling the governor restores native scale.
    const scale = this.settings.get('autoQuality') && this._scaleCeiling === ceiling
      ? Math.min(this.viewport?.scale ?? ceiling, ceiling)
      : ceiling
    this._scaleCeiling = ceiling
    const bw = Math.max(1, Math.round(w * scale))
    const bh = Math.max(1, Math.round(h * scale))

    // Only the drawing buffer is sized here. The element's own size is left to the CSS
    // (`position: absolute; inset: 0`), because a hand-written width is a second opinion
    // about how big the canvas is — and the moment the two disagree, the scene is drawn to
    // one rectangle while every panel is positioned against the other.
    this.viewport = { w, h, bw, bh, scale }
    this.autoScaled = scale < ceiling - 0.01
    this._resizePending = true
  }

  /** Resize only immediately before drawing: changing canvas dimensions clears it. */
  _resizeBuffers() {
    if (!this._resizePending || !this.viewport) return
    this._resizePending = false
    const { bw, bh } = this.viewport
    if (this.canvas.width !== bw || this.canvas.height !== bh) this.renderer.setSize(bw, bh, false)
    if (this.composer && (this.composer.renderTarget1.width !== bw || this.composer.renderTarget1.height !== bh)) {
      this.composer.setSize(bw, bh)
    }
    this.tiltShift?.setSize(bw, bh)
    this.tiltShift?.setCamera(this.camera)
  }

  /**
   * Buffer pixels per CSS pixel. `renderScale` is a share of what the display can actually
   * show, so 100% is native on any panel and 50% is half of it either way.
   */
  /**
   * Point the depth-of-field pass at the depth that was actually just written.
   *
   * This cannot be wired once at build time. `EffectComposer` keeps its read/write buffers
   * between frames, and this chain performs an odd number of swaps, so the two targets trade
   * places every frame — and `RenderPass` always draws into whichever is currently the *read*
   * buffer. Binding one target's depth texture permanently therefore samples the previous
   * frame's depth on every other frame, which shows up as the whole picture strobing between
   * sharp and smeared rather than as anything recognisable as a depth-of-field bug.
   */
  _syncDepthTexture() {
    if (this.tiltShift && this.composer) {
      this.tiltShift.setDepthTexture(this.composer.readBuffer.depthTexture)
    }
  }

  /** What the view is looking at, so the plane of focus can sit on it. */
  setFocusDistance(distance) {
    this._focusDistance = distance
    this.tiltShift?.setFocusDistance(distance)
  }

  _targetScale() {
    return this.settings.get('renderScale') * (window.devicePixelRatio || 1)
  }

  start() {
    if (this.running) return
    this.running = true
    this.timer.reset()
    this.renderer.setAnimationLoop(this._boundLoop)
  }

  stop() {
    this.running = false
    this.renderer.setAnimationLoop(null)
  }

  _loop() {
    this.timer.update()
    // The timer already zeroes the delta across a hidden tab; the clamp is the backstop for
    // an ordinary long frame, so one stalled frame never jumps the whole colony forward.
    const dt = Math.min(this.timer.getDelta(), 0.1)
    this.elapsed += dt

    for (const u of this.updaters) u.update?.(dt, this.elapsed)

    if (this.settings.get('autoQuality')) this._governQuality()
    this.renderer.info.reset()
    this._draw(dt)

    this.perf.sample(dt, this.renderer.info)
  }

  /**
   * Draw one frame without stepping the simulation. Used by the screenshot path, which has
   * to read the drawing buffer in the same task as the draw that filled it — the alternative
   * is `preserveDrawingBuffer`, which costs a full copy on every frame forever.
   */
  renderFrame() {
    this.renderer.info.reset()
    this._draw(0)
  }

  _draw(dt) {
    this._resizeBuffers()
    if (this.composer && this._wantsPost()) {
      // The scene pass sees everything but the overlay; the overlay pass sees only it.
      this.camera.layers.set(0)
      this._syncDepthTexture()
      this.composer.render(dt)
    } else {
      this.camera.layers.enableAll()
      this.renderer.render(this.scene, this.camera)
    }
  }

  /**
   * Adaptive render scale. Never touches the setting the user chose; it scales *under* it.
   *
   * Every move resizes the drawing buffer and rebuilds the post chain's render targets,
   * which is a visible event — on WebKit it can cost a black frame outright. So the bar for
   * moving is deliberately high: a full second between samples, several consecutive samples
   * agreeing before anything changes, and a long cooldown before it climbs back after a
   * drop. A governor that reacts to one bad second finds the boundary and then sits on it,
   * resizing back and forth for as long as you leave the window open.
   */
  _governQuality() {
    const now = performance.now()
    if (now - (this._lastGovern || 0) < 1000) return
    this._lastGovern = now

    const fps = this.perf.fps
    if (fps <= 0) return
    const ceiling = this._targetScale()
    const current = this.viewport?.scale ?? ceiling
    // The floor is relative to the display, and never above the user's own ceiling.
    const floor = Math.min(ceiling, 0.35 * (window.devicePixelRatio || 1))

    // Sustained evidence, not one sample: 3 slow seconds to drop, 8 fast ones to climb.
    this._slow = fps < 45 ? (this._slow || 0) + 1 : 0
    this._fast = fps > 58 ? (this._fast || 0) + 1 : 0
    const dpr = window.devicePixelRatio || 1

    let next = current
    if (this._slow >= 3) {
      next = Math.max(floor, current - 0.15 * dpr)
      this._slow = 0
      // Having just proved this machine cannot hold the higher scale, do not go back and
      // ask it again ten seconds later — that is the oscillation.
      this._climbAt = now + 30000
    } else if (this._fast >= 8 && current < ceiling && now >= (this._climbAt || 0)) {
      next = Math.min(ceiling, current + 0.1 * dpr)
      this._fast = 0
    }

    if (Math.abs(next - current) > 0.01) {
      const parent = this.canvas.parentElement
      if (!parent) return
      const bw = Math.max(1, Math.round(parent.clientWidth * next))
      const bh = Math.max(1, Math.round(parent.clientHeight * next))
      this.viewport = { ...this.viewport, bw, bh, scale: next }
      this._resizePending = true
      this.autoScaled = next < ceiling - 0.01
    }
  }

  dispose() {
    this.stop()
    this.timer.dispose()
    window.removeEventListener('resize', this._onResize)
    this._dprQuery?.removeEventListener?.('change', this._onResize)
    this._observer?.disconnect()
    document.removeEventListener('visibilitychange', this._onWake)
    window.removeEventListener('focus', this._onWake)
    window.removeEventListener('pageshow', this._onWake)
    this._disposeComposer()
    this.renderer.dispose()
  }
}

/** Draws the overlay layer on top of whatever is in the composer's buffer, keeping its depth. */
class OverlayPass extends Pass {
  constructor(scene, camera) {
    super()
    this.scene = scene
    this.camera = camera
    this.needsSwap = false
    this.clear = false
  }

  render(renderer, writeBuffer, readBuffer) {
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    this.camera.layers.set(OVERLAY_LAYER)
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer)
    renderer.render(this.scene, this.camera)
    this.camera.layers.set(0)
    renderer.autoClear = autoClear
  }
}

/**
 * The grade. Saturation is pulled around luminance; warmth tips red up and blue down; the
 * lift adds a faint cool tint into the blacks so shadows read as shade rather than as holes
 * — the single most Animal Crossing thing in here — and a gentle S-curve gives the mids a
 * little pop. The vignette is wide and soft so it never reads as a border.
 */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 1 },
    uWarmth: { value: 0 },
    uVignette: { value: 0.3 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uWarmth;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec3 col = c.rgb;
      // Lifted, tinted blacks.
      col += ( 1.0 - col ) * vec3( 0.035, 0.045, 0.075 ) * ( 1.0 - smoothstep( 0.0, 0.5, dot( col, vec3( 0.333 ) ) ) );
      float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( l ), col, uSaturation );
      col *= vec3( 1.0 + uWarmth * 0.9, 1.0 + uWarmth * 0.25, 1.0 - uWarmth * 0.9 );
      col = mix( col, col * col * ( 3.0 - 2.0 * col ), 0.16 );
      vec2 d = vUv - 0.5;
      col *= 1.0 - dot( d, d ) * uVignette * 1.15;
      gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), c.a );
    }
  `,
}

/** Rolling frame stats — an EMA so the readout does not flicker on a single slow frame. */
class PerfMonitor {
  constructor() {
    this.fps = 0
    this.frameMs = 0
    this.drawCalls = 0
    this.triangles = 0
    this._frames = 0
  }

  sample(dt, info) {
    const ms = dt * 1000
    const k = this._frames < 10 ? 0.3 : 0.06
    this.frameMs += (ms - this.frameMs) * k
    this.fps = this.frameMs > 0 ? 1000 / this.frameMs : 0
    this._frames++
    if (this._frames % 10 === 0) {
      this.drawCalls = info.render.calls
      this.triangles = info.render.triangles
    }
  }
}
