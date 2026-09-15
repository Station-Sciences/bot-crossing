import * as THREE from 'three'

/**
 * The other half of the goo canister: a short burst of glowing orbs, launched from the tank
 * toward whichever astronaut's thread just spent something — the reverse of the MCP factory's
 * pipes, which run from an astronaut *to* a building. Spend is money leaving the tank for the
 * crew doing the work, so the orbs travel the opposite way.
 *
 * Deliberately not a persistent connection like `MCPPipeField`'s tubes: a pipe represents an
 * ongoing call and fades when it ends, but a charge in a transcript is a discrete, already-over
 * event by the time it is read, so this is a one-shot flight rather than something with a
 * beginning and an end to track.
 */

const FLIGHT_SECONDS = 0.75
/** Seconds between orbs launched in the same burst, so a flurry of new charges reads as a
 *  stream rather than one fat orb. */
const STAGGER_SECONDS = 0.09
const ORB_RADIUS = 0.075
const MAX_ORBS_PER_BURST = 6

export class UsageBurstField {
  constructor(scene, canister) {
    this.scene = scene
    this.canister = canister
    /** `{ mesh, material, curve, delay, age }` — `delay` staggers a burst's own orbs, `age`
     *  counts up from spawn regardless of delay so one clock drives the whole flight. */
    this.orbs = []
  }

  /** Launch up to `count` orbs from the canister toward `targetPos`, tinted the tank's own
   *  current colour so the flight reads as *that* budget leaving, in whatever state it's in. */
  spawn(targetPos, count = 1) {
    // The canister sits straight in `scene`, unparented, so its own position is already world
    // space — no matrixWorld lookup needed for a fixed prop that never rotates or scales.
    const start = this.canister.group.position.clone()
    start.y += 2.1 // the goo's own middle, not the ground the tank stands on
    const color = this.canister.currentColor

    const end = targetPos.clone()
    end.y += 1.1 // roughly chest height, not an astronaut's feet
    const n = Math.min(MAX_ORBS_PER_BURST, Math.max(1, Math.round(count)))
    for (let i = 0; i < n; i++) {
      const mid = new THREE.Vector3(
        (start.x + end.x) / 2 + (Math.random() - 0.5) * 1.4,
        Math.max(start.y, end.y) + 1.4 + Math.random() * 0.8,
        (start.z + end.z) / 2 + (Math.random() - 0.5) * 1.4
      )
      const curve = new THREE.QuadraticBezierCurve3(start.clone(), mid, end.clone())
      const material = new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, toneMapped: true })
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(ORB_RADIUS, 8, 6), material)
      mesh.frustumCulled = false
      this.scene.add(mesh)
      this.orbs.push({ mesh, material, curve, baseColor: color.clone(), delay: i * STAGGER_SECONDS, age: 0 })
    }
  }

  update(dt) {
    if (!this.orbs.length) return
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i]
      orb.age += dt
      const t = orb.age - orb.delay
      if (t < 0) continue // still waiting its turn in the stagger
      if (t >= FLIGHT_SECONDS) {
        this._remove(i)
        continue
      }

      const p = t / FLIGHT_SECONDS
      orb.curve.getPoint(p, orb.mesh.position)
      // Pop in over the first beat, flare brighter on the run into the astronaut, then vanish.
      const growIn = p < 0.12 ? p / 0.12 : 1
      const flare = p > 0.82 ? 1 + ((p - 0.82) / 0.18) * 1.8 : 1
      orb.mesh.scale.setScalar(growIn)
      orb.material.opacity = p > 0.85 ? Math.max(0, 1 - (p - 0.85) / 0.15) : 1
      orb.material.color.copy(orb.baseColor).multiplyScalar(1.6 * flare)
    }
  }

  _remove(i) {
    const orb = this.orbs[i]
    this.scene.remove(orb.mesh)
    orb.mesh.geometry.dispose()
    orb.material.dispose()
    this.orbs.splice(i, 1)
  }

  dispose() {
    while (this.orbs.length) this._remove(this.orbs.length - 1)
  }
}
