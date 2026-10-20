import * as THREE from 'three'

/**
 * Tethers: a cable from a manager to each of the crew it sent out.
 *
 * Shown for one family at a time — whoever is under the cursor, or else whoever is selected —
 * because a cable to every child of every manager is a tangle across the whole map, and the
 * question a cable answers ("who belongs to whom") is only ever asked about one bot at once.
 *
 * The other thing a cable carries is a report. When one of the crew finishes a turn — the
 * moment the desktop app hands its result back to the session that started it — a bright
 * pulse runs up its cable from the crew member to the manager. That cable shows itself for as
 * long as the pulse takes, family in focus or not, so a report reads from anywhere on the map.
 *
 * Each cable is an arc of short straight segments, rebuilt every frame from where the two
 * astronauts are standing — they walk, and a cable that did not follow would point at where
 * someone used to be. Every segment of every cable is one instance of one mesh: a single draw,
 * however many families there are. The world's curve bends them like anything else drawn
 * through three's own vertex chunks.
 */

const MAX_TETHERS = 24
const SEGMENTS = 22
const RADIUS = 0.06
/** Seconds to fade a cable in or out when its family gains or loses focus. */
const FADE = 0.25
/** Seconds a report takes to run from the crew member to its manager. */
const PULSE_TRAVEL = 1.4
/** Seconds the cable stays up around a report: in, travel, and a beat to let it land. */
const PULSE_LIFE = PULSE_TRAVEL + 0.9
/**
 * How bright a cable is at rest, and how much a passing report adds on top. Past 1.0 on
 * purpose: the cables are additive and unlit, and against a sunlit deck anything dimmer than
 * the bloom threshold all but disappears.
 */
const REST = 1.5
const FLASH = 4
/** How far up a cable arcs: a little for neighbours, more across the map, never absurdly. */
const LIFT_BASE = 0.7
const LIFT_PER_UNIT = 0.16
const LIFT_MAX = 6

const UNIT_Z = new THREE.Vector3(0, 0, 1)

export class Tethers {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(RADIUS, RADIUS, 1, 5, 1, true)
    // Along +Z with its pivot at one end, so a segment is placed by its start and stretched to
    // its length by scale.z alone — the same trick the switchboard's beams use.
    geo.rotateX(Math.PI / 2)
    geo.translate(0, 0, 0.5)
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    })
    this.mesh = new THREE.InstancedMesh(geo, material, MAX_TETHERS * SEGMENTS)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
    this.mesh.name = 'tethers'
    const black = new THREE.Color(0, 0, 0)
    for (let i = 0; i < MAX_TETHERS * SEGMENTS; i++) this.mesh.setColorAt(i, black)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    scene.add(this.mesh)
    this.scene = scene

    /** `manager>crew` → { manager, crew, alpha, pulse } — pulse is seconds since a report, or -1. */
    this.links = new Map()
    this._points = Array.from({ length: SEGMENTS + 1 }, () => new THREE.Vector3())
    this._a = new THREE.Vector3()
    this._b = new THREE.Vector3()
    this._c = new THREE.Vector3()
    this._d = new THREE.Vector3()
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._color = new THREE.Color()
  }

  _link(manager, crew) {
    const key = `${manager}>${crew}`
    let link = this.links.get(key)
    if (!link) {
      link = { manager, crew, alpha: 0, pulse: -1 }
      this.links.set(key, link)
    }
    return link
  }

  /** A crew member just finished a turn: run a report up its cable to the manager. */
  pulse(manager, crew) {
    this._link(manager, crew).pulse = 0
  }

  /**
   * Advance and draw. `wanted` is the links the focused family should show, as
   * `[manager, crew]` pairs; `anchorOf(id, out)` puts the top of that astronaut's antenna in
   * `out` and returns false when it is not on the map; `colorOf(manager)` is the squad colour.
   */
  update(dt, wanted, anchorOf, colorOf) {
    const want = new Set()
    for (const [manager, crew] of wanted) {
      this._link(manager, crew)
      want.add(`${manager}>${crew}`)
    }

    let n = 0
    for (const [key, link] of this.links) {
      const target = want.has(key) ? 1 : 0
      link.alpha = THREE.MathUtils.clamp(link.alpha + (target > link.alpha ? dt : -dt) / FADE, 0, 1)
      if (link.pulse >= 0) {
        link.pulse += dt
        if (link.pulse > PULSE_LIFE) link.pulse = -1
      }
      // A report holds its cable up on its own: in over the first beat, out over the last.
      const report = link.pulse >= 0 ? Math.min(1, link.pulse / 0.2, (PULSE_LIFE - link.pulse) / 0.4) : 0
      const shown = Math.max(link.alpha, report)
      if (shown <= 0.001 && link.pulse < 0 && !want.has(key)) {
        this.links.delete(key)
        continue
      }
      if (shown <= 0.001 || n >= MAX_TETHERS) continue
      if (!anchorOf(link.manager, this._a) || !anchorOf(link.crew, this._b)) continue

      this._arc(this._a, this._b)
      const base = this._color.setHex(colorOf(link.manager) ?? 0xffffff)
      // Where along the cable the report is, from the crew end (1) to the manager's (0).
      const at = link.pulse >= 0 ? 1 - Math.min(1, link.pulse / PULSE_TRAVEL) : -1
      for (let s = 0; s < SEGMENTS; s++) {
        const from = this._points[s]
        const to = this._points[s + 1]
        const dir = this._d.subVectors(to, from)
        const len = dir.length()
        this._q.setFromUnitVectors(UNIT_Z, dir.multiplyScalar(1 / Math.max(len, 1e-5)))
        this._m.compose(from, this._q, this._s.set(1, 1, len))
        const i = n * SEGMENTS + s
        this.mesh.setMatrixAt(i, this._m)
        const u = (s + 0.5) / SEGMENTS
        const flash = at >= 0 ? Math.exp(-((u - at) ** 2) / 0.006) * FLASH : 0
        // Additive, so dimming the colour is how a cable fades: black adds nothing.
        const k = shown * (REST + flash)
        this.mesh.setColorAt(i, this._c.set(base.r * k, base.g * k, base.b * k))
      }
      n++
    }
    this.mesh.count = n * SEGMENTS
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
  }

  /** The arc between two points: a quadratic up through a lifted midpoint. */
  _arc(a, b) {
    const dist = Math.hypot(b.x - a.x, b.z - a.z)
    const lift = Math.min(LIFT_MAX, LIFT_BASE + dist * LIFT_PER_UNIT)
    const cx = (a.x + b.x) / 2
    const cy = Math.max(a.y, b.y) + lift
    const cz = (a.z + b.z) / 2
    for (let s = 0; s <= SEGMENTS; s++) {
      const t = s / SEGMENTS
      const u = 1 - t
      this._points[s].set(
        u * u * a.x + 2 * u * t * cx + t * t * b.x,
        u * u * a.y + 2 * u * t * cy + t * t * b.y,
        u * u * a.z + 2 * u * t * cz + t * t * b.z
      )
    }
  }

  clear() {
    this.links.clear()
    this.mesh.count = 0
  }

  dispose() {
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
