import * as THREE from 'three'

const ISO_POLAR = THREE.MathUtils.degToRad(56)
const MIN_POLAR = THREE.MathUtils.degToRad(6)
const MAX_POLAR = THREE.MathUtils.degToRad(84)
const MIN_DIST = 4
const MAX_DIST = 150
const WORLD_LIMIT = 82
/** Orbit mode's rate: about two minutes a revolution, slow enough to watch. */
const ORBIT_RATE = 0.055
/** How long after you stop working the camera before the sweep picks itself back up. */
const ORBIT_RESUME_DELAY = 2.0
/**
 * Ramp rates for the sweep's blend, quicker to stop than to start. Grabbing the ground
 * should feel like the camera handing control straight over, while the pick-up afterwards
 * wants to be slow enough that you are not sure of the exact moment it began.
 */
const ORBIT_RAMP_DOWN = 3.5
const ORBIT_RAMP_UP = 1.1

/** The four clean isometric headings. Resting snaps to whichever you are nearest. */
const ISO_AZIMUTHS = [0, 1, 2, 3].map((i) => (i * Math.PI) / 2 + Math.PI / 4)

const damp = (current, target, lambda, dt) => THREE.MathUtils.damp(current, target, lambda, dt)

/**
 * Google Earth's navigation model, over a camera that wants to be isometric.
 *
 * The two things that make Earth feel like Earth are both *anchoring* behaviours, and both
 * are here:
 *
 * - **Left-drag grabs the ground.** Not a pixels-to-metres pan — the world point you put the
 *   cursor on is projected onto the ground plane at mouse-down and then pinned under the
 *   cursor for the whole drag. Panning is applied at 1:1 with no smoothing, because any
 *   damping at all makes the ground visibly lag the hand that is dragging it.
 * - **The wheel zooms at the cursor, not at the screen centre.** The ground point under the
 *   pointer is held still while the camera dollies, so zooming into a corner of the colony
 *   pulls that corner in rather than diving through the middle of the screen. The correction
 *   is re-applied every frame while the dolly eases, so the zoom stays smooth *and* anchored.
 *
 * Right-drag (also middle-, ctrl- and shift-drag) tilts and rotates: horizontal turns the
 * heading, vertical tilts between overhead and the horizon, matching Earth's directions.
 *
 * On top of that, and unlike Earth, letting go eventually eases the *heading and tilt* back
 * to the nearest clean isometric angle. Position and zoom are never touched by that — going
 * home on its own would fight you; tidying the angle after you stop does not.
 */
export class CameraRig {
  constructor(camera, domElement, settings) {
    this.camera = camera
    this.dom = domElement
    this.settings = settings

    this.target = new THREE.Vector3(0, 0, 0)
    this.desiredTarget = this.target.clone()

    this.azimuth = ISO_AZIMUTHS[0]
    this.desiredAzimuth = this.azimuth
    this.polar = ISO_POLAR
    this.desiredPolar = ISO_POLAR
    this.distance = 62
    this.desiredDistance = 62

    this.idleFor = 0
    this.interacting = false
    this.enabled = true
    /** Google Earth's auto-rotate: a slow continuous sweep around whatever is centred. */
    this.orbiting = false
    /** 0..1 share of ORBIT_RATE currently being applied — see `update`. */
    this.orbitBlend = 0
    /** Set by the picker when a drag started on something clickable, so it does not pan. */
    this.suppressed = false

    this._pointers = new Map()
    this._mode = null
    this._last = new THREE.Vector2()
    this._pinch = 0
    this._moved = 0
    this._panAnchor = new THREE.Vector3()
    this._hasAnchor = false
    this._zoom = null // { world, sx, sy } while a cursor-anchored dolly is easing

    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    this._ray = new THREE.Raycaster()
    this._ndc = new THREE.Vector2()
    this._hit = new THREE.Vector3()
    this._hit2 = new THREE.Vector3()
    this._shake = 0
    this._followAgent = null
    this._followPosition = new THREE.Vector3()
    this._followDelta = new THREE.Vector3()

    this._bind()
    this._sync()
  }

  _bind() {
    const dom = this.dom
    dom.style.touchAction = 'none'
    this._onDown = (e) => this._pointerDown(e)
    this._onMove = (e) => this._pointerMove(e)
    this._onUp = (e) => this._pointerUp(e)
    this._onWheel = (e) => this._wheel(e)
    this._onMenu = (e) => e.preventDefault()

    dom.addEventListener('pointerdown', this._onDown)
    window.addEventListener('pointermove', this._onMove, { passive: false })
    window.addEventListener('pointerup', this._onUp)
    window.addEventListener('pointercancel', this._onUp)
    dom.addEventListener('wheel', this._onWheel, { passive: false })
    dom.addEventListener('contextmenu', this._onMenu)
  }

  dispose() {
    const dom = this.dom
    dom.removeEventListener('pointerdown', this._onDown)
    window.removeEventListener('pointermove', this._onMove)
    window.removeEventListener('pointerup', this._onUp)
    window.removeEventListener('pointercancel', this._onUp)
    dom.removeEventListener('wheel', this._onWheel)
    dom.removeEventListener('contextmenu', this._onMenu)
  }

  // ── input ───────────────────────────────────────────────────────────────────────────

  _pointerDown(e) {
    if (!this.enabled) return
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this._moved = 0
    this._zoom = null

    if (this._pointers.size === 2) {
      this._mode = 'pinch'
      this._moved = 6 // lifting either finger must not select/deselect beneath the pinch
      this._pinch = this._pinchDistance()
      this._grab(...this._pinchCentre())
      return
    }

    // Right, middle, ctrl or shift all mean "tilt and rotate", as in Earth.
    const orbit = e.button === 2 || e.button === 1 || e.ctrlKey || e.shiftKey || e.altKey
    this._mode = orbit ? 'orbit' : 'pan'
    this._last.set(e.clientX, e.clientY)
    this.interacting = true
    this.idleFor = 0
    if (!orbit) this._grab(e.clientX, e.clientY)
  }

  /** Remember the world point under the cursor: the thing a drag has to keep pinned. */
  _grab(clientX, clientY) {
    this._hasAnchor = Boolean(this.groundPoint(clientX, clientY, this._panAnchor))
  }

  _pointerMove(e) {
    if (!this._mode) return
    const p = this._pointers.get(e.pointerId)
    if (p) {
      p.x = e.clientX
      p.y = e.clientY
    }
    this.idleFor = 0

    if (this._mode === 'pinch') {
      e.preventDefault()
      const d = this._pinchDistance()
      const [cx, cy] = this._pinchCentre()
      if (this._pinch > 0 && d > 0) {
        this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * (this._pinch / d), MIN_DIST, MAX_DIST)
        this.distance = this.desiredDistance
        this._sync()
      }
      this._pinch = d
      // Two fingers pan as well as zoom, both anchored on the point between them.
      this._dragGround(cx, cy)
      return
    }

    const dx = e.clientX - this._last.x
    const dy = e.clientY - this._last.y
    this._last.set(e.clientX, e.clientY)
    this._moved += Math.abs(dx) + Math.abs(dy)

    if (this._mode === 'orbit') {
      e.preventDefault()
      this.desiredAzimuth -= dx * 0.006
      // Mouse up tilts toward the horizon, mouse down returns to overhead — Earth's sense.
      this.desiredPolar = THREE.MathUtils.clamp(this.desiredPolar - dy * 0.005, MIN_POLAR, MAX_POLAR)
      return
    }

    if (this.suppressed) return
    e.preventDefault()
    this._dragGround(e.clientX, e.clientY)
  }

  /**
   * Move the world so the anchored point sits back under the cursor. Applied straight to
   * the live target rather than the damped one: a grabbed surface that eases into place
   * reads as slipping, however small the lag.
   */
  _dragGround(clientX, clientY) {
    if (!this._hasAnchor) return
    if (!this.groundPoint(clientX, clientY, this._hit)) return

    const dx = this._panAnchor.x - this._hit.x
    const dz = this._panAnchor.z - this._hit.z
    // A ray that grazes the horizon lands absurdly far away; ignore those rather than
    // teleporting the camera across the world on one stray pixel.
    if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) > this.distance * 2) return

    this.desiredTarget.x += dx
    this.desiredTarget.z += dz
    this._clampTarget()
    this.target.copy(this.desiredTarget)
    this._sync()
  }

  _pointerUp(e) {
    this._pointers.delete(e.pointerId)
    if (this._pointers.size === 0) {
      this._mode = null
      this.interacting = false
      this.suppressed = false
      this._hasAnchor = false
    } else if (this._pointers.size === 1) {
      this._mode = 'pan'
      const [only] = this._pointers.values()
      this._last.set(only.x, only.y)
      this._grab(only.x, only.y)
    }
  }

  _wheel(e) {
    if (!this.enabled) return
    e.preventDefault()
    // Trackpads report tiny per-event deltas and mice report ~100, so both are normalised
    // to the same felt zoom step. A pinch on a trackpad arrives as ctrl+wheel.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
    const raw = (e.deltaY * unit) / 100
    const step = Math.sign(raw) * Math.min(Math.abs(raw), 2.5) * (e.ctrlKey ? 1.6 : 1)

    this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * (1 + step * 0.16), MIN_DIST, MAX_DIST)
    // Hold the point under the pointer still for as long as the dolly takes to settle.
    if (this.groundPoint(e.clientX, e.clientY, this._hit2)) {
      this._zoom = { world: this._hit2.clone(), sx: e.clientX, sy: e.clientY }
    }
    this.idleFor = 0
  }

  _pinchDistance() {
    const [a, b] = [...this._pointers.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  _pinchCentre() {
    const [a, b] = [...this._pointers.values()]
    return [(a.x + b.x) / 2, (a.y + b.y) / 2]
  }

  _clampTarget() {
    const t = this.desiredTarget
    const len = Math.hypot(t.x, t.z)
    if (len > WORLD_LIMIT) {
      t.x = (t.x / len) * WORLD_LIMIT
      t.z = (t.z / len) * WORLD_LIMIT
    }
  }

  /** True when the pointer went down and up without really moving — a click, not a drag. */
  get wasClick() {
    return this._moved < 6
  }

  /** Glide the view to a world point without yanking it — used when you pick an astronaut. */
  focus(point, { distance } = {}) {
    this.desiredTarget.copy(point)
    this.desiredTarget.y = 0
    this._clampTarget()
    if (distance) this.desiredDistance = THREE.MathUtils.clamp(distance, MIN_DIST, MAX_DIST)
    this._zoom = null
    this.idleFor = 99 // settle to isometric right away rather than after a pause
  }

  /** Follow translation only: orbit, zoom, and a user's pan offset remain theirs. */
  setFollow(agent) {
    agent = agent || null
    if (agent === this._followAgent) return
    this._followAgent = agent
    this._zoom = null
    if (agent) {
      this._followPosition.copy(agent.pos)
      this.desiredTarget.copy(agent.pos)
      this.desiredTarget.y += 0.65
      this._clampTarget()
    } else {
      // Deselecting also stops an unfinished glide toward the previous agent.
      this.desiredTarget.copy(this.target)
    }
  }

  get following() {
    return Boolean(this._followAgent)
  }

  /** Keep the orbit target centered in the space the HUD leaves visible, without
   * moving it in the world or changing the user's pan, heading, or zoom. CSS pixels
   * are intentional: adaptive rendering resolution must not change the framing. */
  setViewportInsets(width, height, { right = 0, bottom = 0 } = {}) {
    width = Math.max(1, width)
    height = Math.max(1, height)
    right = THREE.MathUtils.clamp(right, 0, width * 0.9)
    bottom = THREE.MathUtils.clamp(bottom, 0, height * 0.9)
    const previous = this._framing
    if (previous && previous.width === width && previous.height === height && previous.right === right && previous.bottom === bottom) return
    this._framing = { width, height, right, bottom }
    this.camera.aspect = width / height
    if (right || bottom) this.camera.setViewOffset(width, height, right / 2, bottom / 2, width, height)
    else this.camera.clearViewOffset()
    this._refreshInputAnchors()
  }

  _trackFollow() {
    if (!this._followAgent) return
    const delta = this._followDelta.subVectors(this._followAgent.pos, this._followPosition)
    this._followPosition.copy(this._followAgent.pos)
    if (delta.lengthSq() === 0) return
    // Move both sides of the damping together, including while the pointer is held.
    // Re-centering every frame would erase the user's pan and fight cursor-anchored zoom.
    this.target.add(delta)
    this.desiredTarget.add(delta)
    this._sync()
    this._refreshInputAnchors()
  }

  _refreshInputAnchors() {
    // The ground grabbed by a drag/dolly travels with the follow frame. Reprojecting also
    // accounts for height/framing changes, while groundPoint still uses the ground plane.
    if (this._hasAnchor) {
      const [x, y] = this._mode === 'pinch' ? this._pinchCentre() : [this._last.x, this._last.y]
      this._hasAnchor = Boolean(this.groundPoint(x, y, this._panAnchor))
    }
    if (this._zoom && !this.groundPoint(this._zoom.sx, this._zoom.sy, this._zoom.world)) this._zoom = null
  }

  resetView() {
    this.orbiting = false
    this.desiredTarget.set(0, 0, 0)
    this.desiredDistance = 62
    this.desiredPolar = ISO_POLAR
    this.desiredAzimuth = this._nearestIso()
    this._zoom = null
    this.idleFor = 99
  }

  /**
   * Toggle the slow automatic sweep. It drives the heading only, so you can still drag,
   * tilt and zoom while it runs — and it suppresses the rest-to-isometric easing, which
   * would otherwise pull the heading straight back to a corner it just left.
   */
  setOrbit(on) {
    this.orbiting = on
    // Switching it on deliberately should start the ramp now rather than after the pause
    // that follows a drag — the blend still eases it in from a standstill.
    if (on) this.idleFor = ORBIT_RESUME_DELAY
    return this.orbiting
  }

  toggleOrbit() {
    return this.setOrbit(!this.orbiting)
  }

  /** A small camera kick, for a rocket landing or a launch. */
  shake(amount = 0.5) {
    if (this.settings.get('reducedMotion')) return
    this._shake = Math.min(1.4, this._shake + amount)
  }

  _nearestIso() {
    let best = ISO_AZIMUTHS[0]
    let bestDelta = Infinity
    for (const base of ISO_AZIMUTHS) {
      // Compare in the same revolution as the current heading, so easing home never takes
      // the long way round the compass.
      const wrapped = base + Math.round((this.desiredAzimuth - base) / (Math.PI * 2)) * Math.PI * 2
      const delta = Math.abs(wrapped - this.desiredAzimuth)
      if (delta < bestDelta) {
        bestDelta = delta
        best = wrapped
      }
    }
    return best
  }

  // ── frame ───────────────────────────────────────────────────────────────────────────

  update(dt) {
    this._trackFollow()
    if (!this.interacting) this.idleFor += dt

    // The sweep yields while you are working the camera and eases back in a couple of
    // seconds after you let go. Cutting it in and out at full rate reads as a glitch — and
    // fighting a drag for the whole drag reads as the camera arguing with you.
    if (this.orbiting) {
      const wants = !this.interacting && this.idleFor >= ORBIT_RESUME_DELAY ? 1 : 0
      this.orbitBlend = damp(this.orbitBlend, wants, wants ? ORBIT_RAMP_UP : ORBIT_RAMP_DOWN, dt)
      const rate = ORBIT_RATE * this.orbitBlend
      this.desiredAzimuth += rate * dt
      this.azimuth += rate * dt // move both, so the sweep never lags behind itself
    } else {
      this.orbitBlend = 0
    }

    // Rest back to isometric: after a beat of no input the heading walks to the nearest
    // clean 45° and the tilt returns to the iso angle. Position and zoom are left alone.
    if (!this.following && !this.orbiting && this.settings.get('autoFrame') && this.idleFor > 2.2 && !this.interacting) {
      const ease = Math.min(1.4, (this.idleFor - 2.2) * 0.7)
      this.desiredAzimuth = damp(this.desiredAzimuth, this._nearestIso(), ease, dt)
      this.desiredPolar = damp(this.desiredPolar, ISO_POLAR, ease, dt)
    }

    const lambda = this.settings.get('reducedMotion') ? 40 : 9
    this.azimuth = damp(this.azimuth, this.desiredAzimuth, lambda, dt)
    this.polar = damp(this.polar, this.desiredPolar, lambda, dt)
    this.distance = damp(this.distance, this.desiredDistance, 12, dt)
    if (!this.interacting) {
      this.target.x = damp(this.target.x, this.desiredTarget.x, lambda, dt)
      this.target.y = damp(this.target.y, this.desiredTarget.y, lambda, dt)
      this.target.z = damp(this.target.z, this.desiredTarget.z, lambda, dt)
    }

    this._sync()
    this._holdZoomAnchor()

    if (this._shake > 0.001) {
      this._shake = damp(this._shake, 0, 3.2, dt)
      const t = performance.now() * 0.001
      const a = this._shake * 0.35
      this.camera.position.x += Math.sin(t * 41) * a
      this.camera.position.y += Math.sin(t * 57) * a
      this.camera.position.z += Math.cos(t * 47) * a
      this.camera.lookAt(this.target)
      this.camera.updateMatrixWorld()
    }
  }

  /**
   * Keep the wheel's anchor point under the cursor while the dolly eases in. Without this
   * the zoom is only anchored on the frame the wheel fired and then drifts as the distance
   * animates, which is exactly the wrong half of the effect.
   */
  _holdZoomAnchor() {
    if (!this._zoom) return
    if (Math.abs(this.distance - this.desiredDistance) < 0.02) {
      this._zoom = null
      return
    }
    if (!this.groundPoint(this._zoom.sx, this._zoom.sy, this._hit)) {
      this._zoom = null
      return
    }
    const dx = this._zoom.world.x - this._hit.x
    const dz = this._zoom.world.z - this._hit.z
    if (Math.hypot(dx, dz) > this.distance * 2) {
      this._zoom = null
      return
    }
    this.desiredTarget.x += dx
    this.desiredTarget.z += dz
    this._clampTarget()
    this.target.x = this.desiredTarget.x
    this.target.z = this.desiredTarget.z
    this._sync()
  }

  /** Place the camera from the current spherical state and make its matrices current. */
  _sync() {
    const sinP = Math.sin(this.polar)
    this.camera.position.set(
      this.target.x + this.distance * sinP * Math.sin(this.azimuth),
      this.target.y + this.distance * Math.cos(this.polar),
      this.target.z + this.distance * sinP * Math.cos(this.azimuth)
    )
    this.camera.lookAt(this.target)
    // Raycasts during a drag read these directly, so they cannot wait for the render pass.
    this.camera.updateMatrixWorld()
  }

  /** Where a screen point lands on the ground plane, or null if the ray never gets there. */
  groundPoint(clientX, clientY, out = new THREE.Vector3()) {
    const rect = this.dom.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    this._ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this._ray.setFromCamera(this._ndc, this.camera)
    return this._ray.ray.intersectPlane(this._plane, out) ? out : null
  }
}
