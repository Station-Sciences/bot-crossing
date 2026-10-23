import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { withCurve } from '../core/curve.js'
import { buildingUniforms } from './buildings.js'

/**
 * Squad flags: a small pennant on a pole beside every crew member's building, in the colour of
 * the manager that sent it out — the same colour as the manager's own pennant and the crew's
 * backpacks, so a squad reads as one colour across the plot even with nobody standing at home.
 *
 * The pole stands on the deck at the building's edge rather than on its roof. Roofs in the
 * pack are anything but flat — a dome, a turbine hub, a solar field whose highest point is a
 * lamp post in one corner — and a flag that floats a hand's width above a solar array is worse
 * than no flag at all. On the ground it always has something to stand on, and the pole tucks
 * inside the building's keep-out ring, so the crew walk round it like part of the building.
 *
 * Every flag in the colony is one instance of one mesh: a single draw, however many squads.
 * The instance colour paints the cloth only — the pole stays brushed grey — and the cloth
 * flutters in the vertex shader off the colony's shared clock, so a flag costs nothing per
 * frame beyond its matrix.
 */

/** Pole height, in world units. An astronaut is about 1.1, so the cloth flies over their heads. */
const POLE = 1.9
const POLE_RADIUS = 0.035
/** The pennant: how far it streams out from the pole, and how deep it is at the hoist. */
const CLOTH_LENGTH = 0.62
const CLOTH_DEPTH = 0.36
/** Strips along the cloth, so it has joints to bend at. */
const CLOTH_STRIPS = 6
/** The pole's grey, before light: painted metal, like the pack's own structural swatch. */
const POLE_GREY = 0.62

/**
 * One pole and one pennant, merged, with an `aCloth` flag per vertex: 0 on the pole, and on
 * the cloth the fraction of the way out from the hoist — which is also how far that vertex is
 * allowed to flap, so the edge sewn to the pole stays put.
 */
function flagGeometry() {
  // Non-indexed, to match the pennant: geometries only merge if all or none carry an index.
  const pole = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS * 1.3, POLE, 6).toNonIndexed()
  pole.translate(0, POLE / 2, 0) // pivot at the foot, so a flag is placed by where it stands
  pole.deleteAttribute('uv')
  pole.setAttribute('aCloth', new THREE.BufferAttribute(new Float32Array(pole.attributes.position.count), 1))

  // A tapering strip, hoist at the pole and point at the fly end: two triangles per strip.
  const positions = []
  const normals = []
  const cloth = []
  const top = POLE - 0.04
  for (let i = 0; i < CLOTH_STRIPS; i++) {
    const u0 = i / CLOTH_STRIPS
    const u1 = (i + 1) / CLOTH_STRIPS
    const corner = (u) => {
      // The pennant narrows to a point, centred on the line halfway down the hoist.
      const half = (CLOTH_DEPTH / 2) * (1 - u)
      const mid = top - CLOTH_DEPTH / 2
      return [u * CLOTH_LENGTH + POLE_RADIUS, mid + half, mid - half]
    }
    const [x0, a0, b0] = corner(u0)
    const [x1, a1, b1] = corner(u1)
    positions.push(x0, a0, 0, x0, b0, 0, x1, a1, 0, x1, a1, 0, x0, b0, 0, x1, b1, 0)
    cloth.push(u0, u0, u1, u1, u0, u1)
  }
  for (let i = 0; i < positions.length / 3; i++) normals.push(0, 0, 1)
  const pennant = new THREE.BufferGeometry()
  pennant.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  pennant.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  pennant.setAttribute('aCloth', new THREE.Float32BufferAttribute(cloth, 1))

  const merged = BufferGeometryUtils.mergeGeometries([pole, pennant], false)
  pole.dispose()
  pennant.dispose()
  return merged
}

export class SquadFlags {
  constructor(scene, capacity = 128) {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.7,
      metalness: 0.1,
      // The cloth is a single sheet, seen from both sides as it turns with the wind.
      side: THREE.DoubleSide,
    })
    material.onBeforeCompile = (shader) => {
      withCurve(shader)
      shader.uniforms.uTime = buildingUniforms.uTime
      shader.uniforms.uNight = buildingUniforms.uNight
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aCloth;
           varying float vCloth;
           uniform float uTime;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vCloth = aCloth;
           // The flutter: a wave running out along the cloth, growing toward the fly end. Its
           // phase comes from where the flag stands, so a plot of them never flaps in step.
           float phase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 1.3;
           transformed.z += sin( uTime * 4.2 - aCloth * 5.0 + phase ) * aCloth * 0.11;
           transformed.y -= aCloth * aCloth * 0.05;`
        )
        // Instance colour is the squad's, and belongs on the cloth alone: the pole is put back
        // to grey after three has multiplied it through.
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
           vColor.rgb = mix( vec3( ${POLE_GREY.toFixed(2)} ), vColor.rgb, step( 0.0001, aCloth ) );`
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying float vCloth;
           uniform float uNight;`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           // A little of the colour glows, and more after dark, so a squad is still a colour
           // at night — the same promise the manager's pennant keeps.
           totalEmissiveRadiance += diffuseColor.rgb * step( 0.0001, vCloth ) * ( 0.12 + uNight * 0.55 );`
        )
    }

    this.mesh = new THREE.InstancedMesh(flagGeometry(), material, capacity)
    // Allocated up front, so the shader is compiled with instance colour from the first frame.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
    this.scene = scene
    this.capacity = capacity
    this._n = 0
    this._dummy = new THREE.Object3D()
    this._colour = new THREE.Color()
  }

  /** Start a frame's worth of flags. Follow with `place` for each, then `end`. */
  begin() {
    this._n = 0
  }

  /**
   * One flag, standing at `x, y, z` and facing `yaw`, grown to `amount` (0..1) — it rises and
   * sinks with the building it belongs to, and fades out by shrinking when its link ends.
   */
  place(x, y, z, yaw, amount, colour) {
    if (this._n >= this.capacity || amount <= 0.01) return
    const d = this._dummy
    d.position.set(x, y, z)
    d.rotation.set(0, yaw, 0)
    d.scale.setScalar(amount)
    d.updateMatrix()
    this.mesh.setMatrixAt(this._n, d.matrix)
    this.mesh.setColorAt(this._n, this._colour.set(colour))
    this._n++
  }

  end() {
    this.mesh.count = this._n
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.scene.remove(this.mesh)
  }
}
