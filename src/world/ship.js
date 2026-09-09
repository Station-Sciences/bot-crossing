import * as THREE from 'three'
import { withCurve } from '../core/curve.js'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The lander. Every astronaut walks out of its ramp when a thread appears and back up it
 * when one is archived, so it is the colony's one fixed piece of narrative furniture.
 *
 * The hull is merged into a single geometry; only the parts that actually move or glow —
 * the ramp, the beacon, the engine wash — stay separate.
 */

const HULL = 0xf0ece4
const HULL_DARK = 0xc4bfb4
const TRIM = 0xc96442
const METAL = 0x8f9299
const GLASS = 0x7fc4e0

/** Roughness / metalness per material, so the hull reads as painted panel over bare strut. */
const SURFACE = new Map([
  [HULL, [0.48, 0.05]],
  [HULL_DARK, [0.62, 0.08]],
  [TRIM, [0.45, 0.1]],
  [METAL, [0.26, 0.95]],
  [GLASS, [0.06, 0]],
  [0x4a4d55, [0.35, 0.85]],
])
const DEFAULT_SURFACE = [0.55, 0.15]

export class Ship {
  constructor(scene, position) {
    this.group = new THREE.Group()
    this.group.position.copy(position)
    // Turned so the ramp points back toward the middle of the colony.
    this.group.rotation.y = Math.atan2(-position.x, -position.z)
    this.group.name = 'ship'
    scene.add(this.group)
    this.scene = scene

    this._buildHull()
    this._buildRamp() // sets doorLocal from where the ramp actually lands
    this._buildLights()

    this.traffic = 0 // ramps glow brighter while astronauts are using them
  }

  _buildHull() {
    const parts = []
    const colors = []
    const push = (geo, color, rot) => {
      if (rot) {
        if (rot.x) geo.rotateX(rot.x)
        if (rot.y) geo.rotateY(rot.y)
        if (rot.z) geo.rotateZ(rot.z)
      }
      parts.push(geo)
      colors.push(new THREE.Color(color))
    }

    // Main body — a squat capsule sitting up on its legs.
    const body = new THREE.SphereGeometry(2.4, 22, 16)
    body.scale(1, 0.86, 1)
    body.translate(0, 3.5, 0)
    push(body, HULL)

    // Skirt under the belly, so the hull does not just stop in mid-air above the legs.
    const skirt = new THREE.CylinderGeometry(1.75, 1.15, 1.1, 20)
    skirt.translate(0, 1.5, 0)
    push(skirt, HULL_DARK)

    // Nose cap + sensor mast.
    const nose = new THREE.SphereGeometry(1.0, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)
    nose.scale(1, 0.9, 1)
    nose.translate(0, 5.42, 0)
    push(nose, TRIM)
    const mast = new THREE.CylinderGeometry(0.08, 0.11, 1.4, 6)
    mast.translate(0, 6.0, 0)
    push(mast, METAL)

    // Porthole surrounds, on the widest band where a flat ring genuinely sits flush.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.62
      const ring = new THREE.TorusGeometry(0.4, 0.07, 6, 14)
      ring.rotateY(-a + Math.PI / 2)
      ring.translate(Math.cos(a) * 2.33, 3.7, Math.sin(a) * 2.33)
      push(ring, HULL_DARK)
    }

    /**
     * Legs. Every dimension is derived from where the foot has to land, so the strut, the
     * footpad and the ground all agree — eyeballing the offsets separately is exactly how
     * legs end up floating above a pad or buried under one.
     */
    const tilt = 0.46
    const legLen = 2.9
    const hipR = 1.55
    const hipY = 2.75
    const footR = hipR + Math.sin(tilt) * legLen
    const footY = hipY - Math.cos(tilt) * legLen
    this.footRadius = footR

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const leg = new THREE.CylinderGeometry(0.16, 0.21, legLen, 8)
      leg.rotateZ(tilt)
      leg.rotateY(-a)
      leg.translate(Math.cos(a) * ((hipR + footR) / 2), (hipY + footY) / 2, Math.sin(a) * ((hipR + footR) / 2))
      push(leg, METAL)

      const pad = new THREE.CylinderGeometry(0.6, 0.46, 0.26, 12)
      pad.translate(Math.cos(a) * footR, Math.max(0.13, footY), Math.sin(a) * footR)
      push(pad, HULL_DARK)

      // A brace from mid-leg back up into the skirt.
      const braceR = (hipR + footR) * 0.36
      const brace = new THREE.CylinderGeometry(0.06, 0.06, 1.7, 5)
      brace.rotateZ(-0.95)
      brace.rotateY(-a)
      brace.translate(Math.cos(a) * (braceR + 0.5), 1.55, Math.sin(a) * (braceR + 0.5))
      push(brace, METAL)
    }

    // Engine bell.
    const bell = new THREE.CylinderGeometry(0.55, 1.05, 1.0, 14, 1, true)
    bell.translate(0, 0.85, 0)
    push(bell, 0x4a4d55)

    /**
     * The airlock. A short tube poking out of the hull rather than a flat ring laid on it —
     * a torus can never sit flush against a sphere, and one that tries ends up as an arch
     * with its bottom hanging in the air.
     */
    const collar = new THREE.CylinderGeometry(0.92, 0.92, 0.9, 16, 1, true)
    collar.rotateX(Math.PI / 2)
    collar.translate(0, 3.15, 2.25)
    push(collar, HULL_DARK)
    // Only the top two-thirds of the ring: a full torus leaves a bar hanging in the gap
    // the ramp comes out of, which reads as a handle rather than as a hatch frame.
    const lip = new THREE.TorusGeometry(0.92, 0.1, 6, 20, Math.PI * 1.34)
    lip.rotateZ(-Math.PI * 0.17)
    lip.translate(0, 3.15, 2.68)
    push(lip, TRIM)

    const merged = mergeWithColors(parts, colors)
    this.hull = new THREE.Mesh(merged, hullMaterial())
    this.hull.castShadow = true
    this.hull.receiveShadow = true
    this.group.add(this.hull)

    // The dark hatch opening, set at the back of the collar so it reads as depth.
    const opening = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 20),
      new THREE.MeshBasicMaterial({ color: 0x05060a, toneMapped: false })
    )
    opening.position.set(0, 3.15, 2.3)
    this.group.add(opening)

    const glassParts = []
    const glassColors = []
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.62
      const pane = new THREE.CircleGeometry(0.36, 14)
      pane.rotateY(-a + Math.PI / 2)
      pane.translate(Math.cos(a) * 2.37, 3.7, Math.sin(a) * 2.37)
      glassParts.push(pane)
      glassColors.push(new THREE.Color(GLASS))
    }
    this.glassMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true })
    this.glass = new THREE.Mesh(mergeWithColors(glassParts, glassColors), this.glassMaterial)
    this.group.add(this.glass)
  }

  /**
   * The ramp runs from the lip of the airlock down to the ground. Its length and angle are
   * solved from those two points rather than set by hand, so it always meets both.
   */
  _buildRamp() {
    const topY = 3.05
    const topZ = 2.68
    const footZ = 6.1
    const drop = topY - 0.06
    const run = footZ - topZ
    const length = Math.hypot(run, drop)
    const angle = Math.atan2(drop, run)

    const geo = new THREE.BoxGeometry(1.8, 0.14, length)
    geo.translate(0, 0, length / 2) // pivot at the hatch end
    const mat = new THREE.MeshStandardMaterial({ color: HULL_DARK, roughness: 0.7, metalness: 0.15 })
    this.ramp = new THREE.Mesh(geo, mat)
    this.ramp.position.set(0, topY, topZ)
    this.ramp.rotation.x = angle
    this.ramp.castShadow = true
    this.ramp.receiveShadow = true
    this.group.add(this.ramp)

    // Treads across it, and a lit strip down each edge.
    const treads = []
    const treadColors = []
    const steps = Math.max(3, Math.round(length / 0.55))
    for (let i = 1; i < steps; i++) {
      const t = new THREE.BoxGeometry(1.6, 0.05, 0.09)
      t.translate(0, 0.09, (length * i) / steps)
      treads.push(t)
      treadColors.push(new THREE.Color(0x8e8a80))
    }
    const treadMesh = new THREE.Mesh(mergeWithColors(treads, treadColors), hullMaterial())
    this.ramp.add(treadMesh)

    const strips = []
    const stripColors = []
    for (const dx of [-0.82, 0.82]) {
      const s = new THREE.BoxGeometry(0.1, 0.07, length - 0.15)
      s.translate(dx, 0.09, length / 2)
      strips.push(s)
      stripColors.push(new THREE.Color(TRIM))
    }
    this.stripMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true })
    this.strips = new THREE.Mesh(mergeWithColors(strips, stripColors), this.stripMaterial)
    this.ramp.add(this.strips)

    // Astronauts appear and vanish a step short of the ground, at the foot of the ramp —
    // and on a first load they come out of the airlock at its top and walk down it.
    this.doorLocal = new THREE.Vector3(0, 0, footZ + 0.6)
    this.airlockLocal = new THREE.Vector3(0, topY + 0.02, topZ - 0.3)
  }

  _buildLights() {
    // Beacon on the mast.
    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xff5a4a, toneMapped: true })
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), this.beaconMaterial)
    this.beacon.position.set(0, 6.5, 0)
    this.group.add(this.beacon)

    // Landing lights ringing the pad.
    const pads = []
    const padColors = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const r = (this.footRadius || 3) + 1.5
      const l = new THREE.SphereGeometry(0.12, 8, 6)
      l.translate(Math.cos(a) * r, 0.12, Math.sin(a) * r)
      pads.push(l)
      padColors.push(new THREE.Color(0x9fd8ff))
    }
    this.padMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true })
    this.padLights = new THREE.Mesh(mergeWithColors(pads, padColors), this.padMaterial)
    this.group.add(this.padLights)

    // Scorched apron under the ship.
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry((this.footRadius || 3) + 2.3, 32),
      new THREE.MeshStandardMaterial({ color: 0x2f2c2c, roughness: 1, transparent: true, opacity: 0.65 })
    )
    apron.rotation.x = -Math.PI / 2
    apron.position.y = 0.05
    apron.receiveShadow = true
    this.group.add(apron)
  }

  /** World position of the foot of the ramp — where astronauts appear and vanish. */
  shipDoor(out = new THREE.Vector3()) {
    // The first roster can arrive before the first frame, when the group's world matrix
    // is still the identity — and the door would be at the world origin, in the middle of
    // the colony, which is where a whole crew once appeared from.
    this.group.updateWorldMatrix(true, false)
    return out.copy(this.doorLocal).applyMatrix4(this.group.matrixWorld)
  }

  /** World position of the airlock at the top of the ramp. */
  shipAirlock(out = new THREE.Vector3()) {
    this.group.updateWorldMatrix(true, false)
    return out.copy(this.airlockLocal).applyMatrix4(this.group.matrixWorld)
  }

  update(dt, elapsed, night) {
    // Beacon: a double-blink, like a real aircraft strobe.
    const t = elapsed % 2
    const strobe = t < 0.08 || (t > 0.2 && t < 0.28) ? 1 : 0.08
    this.beaconMaterial.color.setRGB(3.2 * strobe, 0.35 * strobe, 0.28 * strobe)

    const gain = 0.35 + night * 2.2
    this.padMaterial.color.setRGB(0.55 * gain, 0.82 * gain, 1.1 * gain)
    this.glassMaterial.color.setRGB(0.5 * gain, 0.78 * gain, 0.92 * gain)

    // Ramp strips brighten while anyone is walking on them.
    this.traffic = Math.max(0, this.traffic - dt * 1.5)
    const busy = Math.min(1, this.traffic)
    const pulse = 0.6 + 0.4 * Math.sin(elapsed * 4)
    const s = (0.5 + night * 1.2) * (1 + busy * pulse * 1.6)
    this.stripMaterial.color.setRGB(1.0 * s, 0.45 * s, 0.3 * s)
  }

  /** Called when an astronaut uses the ramp, so the lights react. */
  ping() {
    this.traffic = Math.min(2.5, this.traffic + 1)
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.scene.remove(this.group)
  }
}

/**
 * Merge a set of geometries, baking one flat colour per part into vertex colours — plus the
 * roughness and metalness that colour implies, so a single merged hull can hold painted
 * panel, bare strut and glass and have each behave correctly under the environment map.
 */
function mergeWithColors(parts, colors) {
  parts.forEach((geo, i) => {
    const count = geo.attributes.position.count
    const arr = new Float32Array(count * 3)
    const surf = new Float32Array(count * 2)
    const c = colors[i]
    const s = SURFACE.get(colors[i].getHex()) || DEFAULT_SURFACE
    for (let k = 0; k < count; k++) {
      arr[k * 3] = c.r
      arr[k * 3 + 1] = c.g
      arr[k * 3 + 2] = c.b
      surf[k * 2] = s[0]
      surf[k * 2 + 1] = s[1]
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    geo.setAttribute('aSurface', new THREE.BufferAttribute(surf, 2))
    geo.deleteAttribute('uv')
    if (!geo.attributes.normal) geo.computeVertexNormals()
  })
  const merged = BufferGeometryUtils.mergeGeometries(parts, false)
  parts.forEach((g) => g.dispose())
  return merged
}

/** The hull material: per-vertex PBR, and double-sided so the engine bell and the airlock
 *  collar — both open tubes — show their insides instead of vanishing. */
function hullMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.22,
    side: THREE.DoubleSide,
    shadowSide: THREE.BackSide,
  })
  mat.onBeforeCompile = (shader) => {
    withCurve(shader)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n attribute vec2 aSurface;\n varying vec2 vSurface;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vSurface = aSurface;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n varying vec2 vSurface;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;')
  }
  return mat
}
