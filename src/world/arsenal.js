import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * What the bots fight with: a sword and a gun to carry, a tank and a helicopter to ride.
 *
 * Every piece is boxes, cylinders and cones in the colony's toy style, merged per material
 * with the colour baked into the vertices, the way the lander's hull is, so a tank is two
 * draw calls plus its moving parts however many bits it is made of. Only what has to move
 * (turret, barrel, rotors) stays its own object, exposed on `userData`.
 *
 * Only built-in materials are used, so the world bend reaches them without any `withCurve`.
 *
 * Axes: everything faces +Z, with +Y up. Bots are about 1.1 tall.
 */

const STEEL = 0xc9ced6
const HILT = 0x6b4a32
const GUNMETAL = 0x3a3d45
const DARK = 0x24262c
const GLASS = 0x7fc4e0
const GRIP = 0x2b2e35

/** Painted panels and bare metal read differently, so each gets its own material. */
const PAINT = { roughness: 0.55, metalness: 0.15 }
const METAL = { roughness: 0.3, metalness: 0.85 }

const X = Math.PI / 2 // laid on a Y-axis cylinder with rotateX, points it along Z

/** Collects parts and merges them into one mesh per material kind. */
class Builder {
  constructor() {
    this.parts = { paint: [], metal: [] }
  }

  add(geo, color, kind = 'paint', at = null, rot = null) {
    if (rot) {
      if (rot.x) geo.rotateX(rot.x)
      if (rot.y) geo.rotateY(rot.y)
      if (rot.z) geo.rotateZ(rot.z)
    }
    if (at) geo.translate(at[0], at[1], at[2])
    // Colour goes into the vertices, and the uvs go, so unlike geometries can merge.
    const c = new THREE.Color(color)
    const n = geo.attributes.position.count
    const arr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) c.toArray(arr, i * 3)
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    geo.deleteAttribute('uv')
    // Some primitives are indexed and some are not, and merging refuses a mix.
    if (geo.index) geo = geo.toNonIndexed()
    this.parts[kind].push(geo)
    return this
  }

  box(w, h, d, color, kind, at, rot) {
    return this.add(new THREE.BoxGeometry(w, h, d), color, kind, at, rot)
  }

  /** A cylinder along Y; pass `rot` to lay it down. */
  cyl(rTop, rBot, h, color, kind, at, rot, seg = 10) {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), color, kind, at, rot)
  }

  /** The finished meshes, one per material kind that got any parts. */
  meshes() {
    const out = []
    for (const [kind, list] of Object.entries(this.parts)) {
      if (!list.length) continue
      const geo = BufferGeometryUtils.mergeGeometries(list, false)
      list.forEach((g) => g.dispose())
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        ...(kind === 'metal' ? METAL : PAINT),
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.castShadow = true
      mesh.receiveShadow = false
      out.push(mesh)
    }
    return out
  }
}

/** A sword about 0.7 long, held by the hilt: the blade points up (+Y) from the grip. */
export function createSword() {
  const group = new THREE.Group()
  group.name = 'sword'
  const b = new Builder()
  b.cyl(0.028, 0.028, 0.16, GRIP, 'paint', [0, 0.08, 0]) // grip
  b.add(new THREE.SphereGeometry(0.04, 8, 6), HILT, 'metal', [0, -0.005, 0]) // pommel
  b.box(0.2, 0.035, 0.05, HILT, 'metal', [0, 0.17, 0]) // crossguard
  b.box(0.07, 0.46, 0.014, STEEL, 'metal', [0, 0.42, 0]) // blade
  b.add(new THREE.ConeGeometry(0.035, 0.08, 4), STEEL, 'metal', [0, 0.69, 0], { y: Math.PI / 4 }) // tip
  group.add(...b.meshes())
  return group
}

/** A blaster about 0.5 long, pointing along +Z, with a `muzzle` at the end of the barrel. */
export function createGun() {
  const group = new THREE.Group()
  group.name = 'gun'
  const b = new Builder()
  b.box(0.09, 0.14, 0.34, GUNMETAL, 'metal', [0, 0, 0]) // body
  b.box(0.07, 0.2, 0.09, GRIP, 'paint', [0, -0.15, -0.1], { x: 0.25 }) // grip
  b.cyl(0.026, 0.026, 0.2, DARK, 'metal', [0, 0.02, 0.26], { x: X }) // barrel
  b.box(0.04, 0.05, 0.08, STEEL, 'metal', [0, 0.095, -0.02]) // sight
  b.box(0.095, 0.05, 0.12, 0xc96442, 'paint', [0, 0.02, 0.06]) // a coloured slide, so it is not all grey
  group.add(...b.meshes())
  const muzzle = new THREE.Object3D()
  muzzle.name = 'muzzle'
  muzzle.position.set(0, 0.02, 0.37)
  group.add(muzzle)
  group.userData.muzzle = muzzle
  return group
}

/**
 * A small tank, about 3 long, 1.8 wide and 1.2 tall, in the owner's `accent`. The turret
 * yaws on the hull and the barrel pitches on the turret, and the `muzzle` rides the barrel.
 */
export function createTank(accent = 0xc96442) {
  const group = new THREE.Group()
  group.name = 'tank'
  const b = new Builder()

  // Tracks: a slab each side with a drum at either end to round the ends off, and wheels.
  for (const s of [-1, 1]) {
    b.box(0.46, 0.5, 2.6, DARK, 'paint', [s * 0.67, 0.3, 0])
    for (const z of [-1.3, 1.3]) b.cyl(0.25, 0.25, 0.46, DARK, 'paint', [s * 0.67, 0.3, z], { z: X }, 12)
    for (const z of [-0.8, 0, 0.8]) b.cyl(0.19, 0.19, 0.5, GUNMETAL, 'metal', [s * 0.67, 0.3, z], { z: X }, 10)
  }
  // Hull between the tracks, with a sloped glacis at the front.
  b.box(1.3, 0.34, 2.7, accent, 'paint', [0, 0.45, 0])
  b.box(1.3, 0.26, 0.5, accent, 'paint', [0, 0.6, 1.2], { x: -0.45 })
  b.box(1.3, 0.1, 0.4, GUNMETAL, 'metal', [0, 0.66, -1.2]) // engine deck

  const turret = new THREE.Group()
  turret.name = 'turret'
  turret.position.set(0, 0.72, 0.1)
  const t = new Builder()
  t.cyl(0.55, 0.62, 0.32, accent, 'paint', [0, 0.16, 0], null, 14)
  t.cyl(0.18, 0.2, 0.12, GUNMETAL, 'metal', [-0.22, 0.38, -0.12], null, 8) // hatch
  t.box(0.08, 0.3, 0.08, STEEL, 'metal', [0.3, 0.45, -0.2]) // antenna
  turret.add(...t.meshes())

  const barrel = new THREE.Group()
  barrel.name = 'barrel'
  barrel.position.set(0, 0.2, 0.4) // the trunnion, at the front of the turret
  const g = new Builder()
  g.cyl(0.07, 0.07, 0.95, GUNMETAL, 'metal', [0, 0, 0.45], { x: X }, 8)
  g.cyl(0.1, 0.1, 0.14, DARK, 'metal', [0, 0, 0.95], { x: X }, 8) // muzzle brake
  g.cyl(0.13, 0.13, 0.18, accent, 'paint', [0, 0, 0.1], { x: X }, 8) // mantlet
  barrel.add(...g.meshes())
  const muzzle = new THREE.Object3D()
  muzzle.name = 'muzzle'
  muzzle.position.set(0, 0, 1.05)
  barrel.add(muzzle)
  turret.add(barrel)

  group.add(...b.meshes(), turret)
  group.userData.turret = turret
  group.userData.barrel = barrel
  group.userData.muzzle = muzzle
  return group
}

/**
 * A little chopper, about 3.5 long, in the owner's `accent`, with a 4-unit main rotor. The
 * `rotor` and `tailRotor` spin on their own axes (Y and X) and the `muzzle` sits at the nose.
 */
export function createHelicopter(accent = 0x4aa3df) {
  const group = new THREE.Group()
  group.name = 'helicopter'
  const b = new Builder()

  // Cabin: a rounded pod with a glass canopy at the nose.
  const pod = new THREE.SphereGeometry(0.7, 14, 10)
  pod.scale(0.85, 0.8, 1.15)
  b.add(pod, accent, 'paint', [0, 0.85, 0.1])
  const canopy = new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  canopy.scale(0.95, 0.9, 1.2)
  b.add(canopy, GLASS, 'metal', [0, 0.95, 0.5], { x: 0.5 })
  // Tail boom, fin and stabiliser.
  b.cyl(0.1, 0.2, 1.9, accent, 'paint', [0, 0.95, -1.15], { x: X }, 8)
  b.box(0.06, 0.55, 0.4, accent, 'paint', [0, 1.2, -2.0], { x: -0.3 })
  b.box(0.7, 0.05, 0.25, accent, 'paint', [0, 0.98, -1.85])
  // Skids on struts.
  for (const s of [-1, 1]) {
    b.cyl(0.035, 0.035, 1.5, GUNMETAL, 'metal', [s * 0.5, 0.1, 0.1], { x: X }, 6)
    for (const z of [-0.3, 0.5]) b.box(0.04, 0.55, 0.05, GUNMETAL, 'metal', [s * 0.45, 0.35, z], { z: s * -0.15 })
  }
  // Mast, and a pair of stub wings with a gun pod under each.
  b.cyl(0.07, 0.09, 0.3, GUNMETAL, 'metal', [0, 1.6, 0], null, 6)
  b.box(1.5, 0.06, 0.28, accent, 'paint', [0, 0.78, 0.2])
  for (const s of [-1, 1]) b.cyl(0.07, 0.07, 0.4, DARK, 'metal', [s * 0.7, 0.68, 0.35], { x: X }, 6)
  // Nose gun.
  b.cyl(0.035, 0.035, 0.3, DARK, 'metal', [0, 0.55, 0.95], { x: X }, 6)
  group.add(...b.meshes())

  // Main rotor: two blades crossed, 4 across, turning on the mast top.
  const rotor = new THREE.Group()
  rotor.name = 'rotor'
  rotor.position.set(0, 1.78, 0)
  const r = new Builder()
  r.box(4, 0.03, 0.18, DARK, 'metal', [0, 0, 0])
  r.box(0.18, 0.03, 4, DARK, 'metal', [0, 0.001, 0])
  r.cyl(0.12, 0.12, 0.08, STEEL, 'metal', [0, 0.03, 0], null, 8) // hub
  rotor.add(...r.meshes())

  // Tail rotor: a small cross on the side of the fin, turning about X.
  const tailRotor = new THREE.Group()
  tailRotor.name = 'tailRotor'
  tailRotor.position.set(0.1, 1.25, -2.05)
  const tr = new Builder()
  tr.box(0.025, 0.8, 0.1, DARK, 'metal', [0, 0, 0])
  tr.box(0.025, 0.1, 0.8, DARK, 'metal', [0, 0, 0])
  tailRotor.add(...tr.meshes())

  const muzzle = new THREE.Object3D()
  muzzle.name = 'muzzle'
  muzzle.position.set(0, 0.55, 1.12)
  group.add(rotor, tailRotor, muzzle)
  group.userData.rotor = rotor
  group.userData.tailRotor = tailRotor
  group.userData.muzzle = muzzle
  return group
}

/**
 * A ball for the bots to play with, 0.35 across and resting on y = 0 with its centre at 0.175.
 * Two paint colours split along a band round the middle, so a roll is visible as it spins.
 */
export function createBall() {
  const group = new THREE.Group()
  group.name = 'ball'
  const r = 0.175
  const b = new Builder()
  // Top and bottom caps in toy red, with a cream band between them.
  b.add(new THREE.SphereGeometry(r, 12, 5, 0, Math.PI * 2, 0, Math.PI * 0.36), 0xc96442, 'paint', [0, r, 0])
  b.add(new THREE.SphereGeometry(r, 12, 5, 0, Math.PI * 2, Math.PI * 0.64, Math.PI * 0.36), 0xc96442, 'paint', [0, r, 0])
  b.add(new THREE.SphereGeometry(r, 12, 4, 0, Math.PI * 2, Math.PI * 0.36, Math.PI * 0.28), 0xf1e6d2, 'paint', [0, r, 0])
  group.add(...b.meshes())
  return group
}

/** Free every geometry and material under `group`. The meshes own theirs; nothing is shared. */
export function dispose(group) {
  group.traverse((o) => {
    if (!o.isMesh) return
    o.geometry?.dispose()
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) m?.dispose()
  })
}
