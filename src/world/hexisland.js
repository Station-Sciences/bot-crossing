import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry } from './planet.js'
import { withCurve } from '../core/curve.js'

/**
 * The underside of a floating island that is exactly as big as the colony standing on it.
 *
 * Rather than one round plinth, every hex cell the colony holds gets its own jagged plug of
 * rock hanging beneath it — a hex prism that shrinks and twists as it goes down, with a few
 * stalactite spikes trailing lower — and the plugs of neighbouring cells overlap into one
 * scraggly mass. So a repo claiming a new tile grows the island by a tile, and a repo folding
 * away lets a chunk of rock drop off the edge. Vines hang from the edges that face open sky.
 *
 * Built from the cell list the colony already has, in world space, as one geometry for the
 * rock and one instanced mesh for the vines.
 */

const HEX_PHASE = Math.PI / 6
/** Depth of a cell's plug at the island's middle, and how much shallower the edge ones are. */
const DEPTH = { min: 9, max: 17 }
/**
 * The rings of the plug, as fractions of its depth: the radius left at each as a share of
 * the cell's, plus how much of the grass margin the ring still covers. The top two rings
 * reach out under the margin so the ground has a proper soil lip rather than a paper edge.
 */
const RINGS = [
  { t: 0, r: 1.04, lip: 1.15 },
  { t: 0.07, r: 1.0, lip: 0.95 },
  { t: 0.18, r: 0.9, lip: 0.5 },
  { t: 0.34, r: 0.74, lip: 0.12 },
  { t: 0.54, r: 0.52, lip: 0 },
  { t: 0.76, r: 0.3, lip: 0 },
  { t: 0.93, r: 0.13, lip: 0 },
]
const AROUND = 12 // vertices per ring: the six corners and the six edge midpoints
const STRAND_SEGMENTS = 6

export function createHexIsland({ cells, cellRadius, margin = 3, seed = 1717, palette = {}, quality = 'medium' }) {
  const group = new THREE.Group()
  group.name = 'hex-island'
  const rand = mulberry(seed)
  const soil = new THREE.Color(palette.soil ?? 0x6b4a32)
  const rockLight = new THREE.Color(palette.rock ?? 0x7a6e62)
  const rockDark = new THREE.Color(palette.rock ?? 0x7a6e62).multiplyScalar(0.55)
  const moss = new THREE.Color(palette.moss ?? 0x4f8f3a)

  const key = (c) => `${Math.round(c.x / (cellRadius * 0.75))},${Math.round(c.z / (cellRadius * Math.sqrt(3) * 0.5))}`
  const centre = cells.reduce((a, c) => ({ x: a.x + c.x / cells.length, z: a.z + c.z / cells.length }), { x: 0, z: 0 })
  const spread = Math.max(1, ...cells.map((c) => Math.hypot(c.x - centre.x, c.z - centre.z)))

  const parts = []
  const vineAnchors = []

  for (const cell of cells) {
    // Edge cells hang shallower than the middle, so the mass tapers toward the sides.
    const inward = 1 - Math.hypot(cell.x - centre.x, cell.z - centre.z) / (spread + cellRadius)
    const depth = DEPTH.min + (DEPTH.max - DEPTH.min) * (0.4 + 0.6 * inward) * (0.85 + rand() * 0.3)
    const twist = (rand() - 0.5) * 0.5
    const lean = { x: (rand() - 0.5) * 0.25, z: (rand() - 0.5) * 0.25 }
    parts.push(plug(cell, cellRadius, margin, depth, twist, lean, rand, soil, rockLight, rockDark, moss))
    // Stalactites: spikes rooted just under the soil, where the plug is still wide enough to
    // swallow their base, trailing below it. The ones under the middle of the island are the
    // big ones — long and thick — and the edge cells get slender ones.
    const spikes = 1 + Math.floor(rand() * 3) + (inward > 0.55 ? 1 : 0)
    for (let i = 0; i < spikes; i++) {
      const a = rand() * Math.PI * 2
      const r = rand() * cellRadius * 0.5
      const big = inward * inward
      parts.push(
        spike(
          cell.x + Math.cos(a) * r,
          cell.z + Math.sin(a) * r,
          -1 - rand() * 2,
          -depth - 2 - rand() * 8 - big * (6 + rand() * 14),
          (0.5 + rand() * 0.8) * (1 + big * 2.2),
          rand,
          rockLight,
          rockDark
        )
      )
    }
    // Which of this cell's six edges face nothing: those get vines.
    for (let e = 0; e < 6; e++) {
      const a = (Math.PI / 3) * e + Math.PI / 6
      const nx = cell.x + Math.cos(a) * cellRadius * Math.sqrt(3)
      const nz = cell.z + Math.sin(a) * cellRadius * Math.sqrt(3)
      const open = !cells.some((o) => Math.hypot(o.x - nx, o.z - nz) < cellRadius * 0.6)
      if (!open) continue
      const n = 2 + Math.floor(rand() * 3)
      for (let i = 0; i < n; i++) {
        const along = (rand() - 0.5) * 0.8
        const px = cell.x + Math.cos(a) * cellRadius * 0.86 + Math.cos(a + Math.PI / 2) * along * cellRadius
        const pz = cell.z + Math.sin(a) * cellRadius * 0.86 + Math.sin(a + Math.PI / 2) * along * cellRadius
        vineAnchors.push({ x: px, z: pz, y: -0.6 - rand() * 1.4, len: 3 + Math.pow(rand(), 1.3) * 10, yaw: a })
      }
    }
  }

  const rockGeo = BufferGeometryUtils.mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  rockGeo.computeVertexNormals()
  const rock = new THREE.Mesh(
    rockGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, flatShading: true })
  )
  rock.castShadow = true
  rock.receiveShadow = true
  rock.name = 'island-rock'
  group.add(rock)

  const vines = buildVines(vineAnchors, rand, palette.vine ?? 0x4f8f3a, quality)
  group.add(vines.mesh)

  return {
    group,
    update(dt, elapsed) {
      vines.uniforms.uTime.value = elapsed
    },
    dispose() {
      group.removeFromParent()
      rock.geometry.dispose()
      rock.material.dispose()
      vines.mesh.geometry.dispose()
      vines.mesh.material.dispose()
      vines.mesh.customDepthMaterial?.dispose()
    },
  }
}

/** One cell's plug: stacked, shrinking, jagged hex rings closed to a point. */
function plug(cell, R, margin, depth, twist, lean, rand, soil, rockLight, rockDark, moss) {
  const rings = RINGS.length
  const positions = []
  const colors = []
  const c = new THREE.Color()
  // Per-ring jitter is fixed per corner so the plug reads as faceted rock, not noise.
  for (let k = 0; k < rings; k++) {
    const { t, r, lip } = RINGS[k]
    const y = -0.3 - depth * t
    // The top ring must stay under the ground; the lower ones may wobble.
    const wobble = k === 0 ? 0.15 : depth * 0.06
    for (let i = 0; i < AROUND; i++) {
      const a = (i / AROUND) * Math.PI * 2 + HEX_PHASE + twist * t
      // Corners stick out, midpoints tuck in, and both wobble — a hex that has weathered.
      const corner = i % 2 === 0 ? 1 : 0.9
      const rr = (R * r + margin * lip) * corner * (0.86 + rand() * 0.28)
      positions.push(cell.x + Math.cos(a) * rr + lean.x * depth * t, y - rand() * wobble, cell.z + Math.sin(a) * rr + lean.z * depth * t)
      // Soil at the lip, rock below, darkening to the tip, with a streak of moss here and there.
      if (t < 0.2) c.copy(soil).offsetHSL(0, 0, -t * 0.4)
      else c.copy(rockLight).lerp(rockDark, Math.min(1, (t - 0.18) * 1.3))
      if (t > 0.05 && t < 0.4 && rand() < 0.22) c.lerp(moss, 0.55)
      c.offsetHSL(0, 0, (rand() - 0.5) * 0.08)
      colors.push(c.r, c.g, c.b)
    }
  }
  const tipY = -0.3 - depth - 1.2
  positions.push(cell.x + lean.x * depth, tipY, cell.z + lean.z * depth)
  c.copy(rockDark)
  colors.push(c.r, c.g, c.b)
  const tip = rings * AROUND
  // A soil cap over the top ring: the ground frays away inside the lip, and what shows
  // through the gaps has to be earth, not the hollow inside of the plug.
  positions.push(cell.x, -0.2, cell.z)
  c.copy(soil)
  colors.push(c.r, c.g, c.b)
  const cap = tip + 1

  const index = []
  for (let k = 0; k < rings - 1; k++) {
    for (let i = 0; i < AROUND; i++) {
      const a = k * AROUND + i
      const b = k * AROUND + ((i + 1) % AROUND)
      const d = (k + 1) * AROUND + i
      const e = (k + 1) * AROUND + ((i + 1) % AROUND)
      // Counter-clockwise seen from outside, so the outer faces are the front faces.
      index.push(a, b, d, b, e, d)
    }
  }
  for (let i = 0; i < AROUND; i++) {
    const a = (rings - 1) * AROUND + i
    const b = (rings - 1) * AROUND + ((i + 1) % AROUND)
    index.push(a, b, tip)
    // The cap faces up, so it winds the other way round.
    index.push(cap, (i + 1) % AROUND, i)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(index)
  return geo.toNonIndexed()
}

/** A stalactite: a thin, slightly bent cone from `top` down to `bottom`. */
function spike(x, z, top, bottom, radius, rand, rockLight, rockDark) {
  const geo = new THREE.ConeGeometry(radius, top - bottom, 5, 3)
  geo.rotateX(Math.PI)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const c = new THREE.Color()
  const h = top - bottom
  const bendX = (rand() - 0.5) * 0.25
  const bendZ = (rand() - 0.5) * 0.25
  for (let i = 0; i < pos.count; i++) {
    // ConeGeometry is centred; after the flip its apex is at -h/2 and its base at +h/2.
    const yy = pos.getY(i)
    const down = (h / 2 - yy) / h // 0 at the base, 1 at the tip
    pos.setXYZ(i, pos.getX(i) * (1 + (rand() - 0.5) * 0.3) + bendX * down * h, yy, pos.getZ(i) * (1 + (rand() - 0.5) * 0.3) + bendZ * down * h)
    c.copy(rockLight).lerp(rockDark, 0.3 + down * 0.7)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.translate(x, (top + bottom) / 2, z)
  // Merging insists every part carry the same attributes: the plugs have position and
  // colour and nothing else, so the cone's own normals and uvs go, and the merged rock
  // computes flat normals for the lot.
  geo.deleteAttribute('normal')
  geo.deleteAttribute('uv')
  return geo.index ? geo.toNonIndexed() : geo
}

/** Vines: thin strips hanging from the open edges, swaying in the vertex shader. */
function buildVines(anchors, rand, color, quality) {
  const w0 = 0.16
  const positions = []
  const uvs = []
  const index = []
  for (let i = 0; i <= STRAND_SEGMENTS; i++) {
    const t = i / STRAND_SEGMENTS
    const w = (w0 * (1 - 0.7 * t) + 0.03) / 2
    positions.push(-w, -t, 0, w, -t, 0)
    uvs.push(0, t, 1, t)
    if (i < STRAND_SEGMENTS) {
      const a = i * 2
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(positions.length).fill(0).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3))
  geo.setIndex(index)

  const count = Math.max(1, Math.round(anchors.length * (quality === 'low' ? 0.5 : 1)))
  const phase = new Float32Array(count)
  const uniforms = { uTime: { value: 0 } }
  const decorate = (shader) => {
    withCurve(shader)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n attribute float aPhase;\n uniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         // The top stays tied to the rock; the free end swings, more the further it hangs.
         float bcT = uv.y;
         transformed.x += sin( uTime * 0.7 + aPhase ) * bcT * bcT * 0.5;
         transformed.z += cos( uTime * 0.5 + aPhase * 1.6 ) * bcT * bcT * 0.25;`
      )
  }
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide })
  material.onBeforeCompile = decorate
  material.customProgramCacheKey = () => 'bc-hex-vine'
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  depth.onBeforeCompile = decorate
  depth.customProgramCacheKey = () => 'bc-hex-vine:depth'

  const mesh = new THREE.InstancedMesh(geo, material, count)
  mesh.customDepthMaterial = depth
  mesh.castShadow = quality !== 'low'
  mesh.frustumCulled = false
  mesh.name = 'island-vines'
  const dummy = new THREE.Object3D()
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const a = anchors[i % anchors.length]
    dummy.position.set(a.x, a.y, a.z)
    dummy.rotation.set(0, a.yaw + (rand() - 0.5) * 0.8, 0)
    dummy.scale.set(1, a.len, 1)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
    c.set(color).offsetHSL((rand() - 0.5) * 0.04, (rand() - 0.5) * 0.15, (rand() - 0.5) * 0.18)
    mesh.setColorAt(i, c)
    phase[i] = rand() * Math.PI * 2
  }
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1))
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return { mesh, uniforms }
}
