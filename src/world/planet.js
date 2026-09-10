import * as THREE from 'three'
import { atlasTexture, hasPart, part } from './kit.js'

/**
 * The worlds you can put the colony on, and the terrain generator that draws them.
 *
 * A planet is nothing but a bag of colours and a couple of switches — terrain, scatter, sky
 * and lighting all read from the same preset, so adding a world is a data change rather
 * than a code change.
 */

export const PLANETS = {
  moon: {
    id: 'moon',
    name: 'Luna',
    blurb: 'Airless, high contrast, very long shadows.',
    ground: { low: 0x4a4a52, high: 0x8f8d90, tint: 0xb9b4ae },
    rock: 0x6d6a70,
    horizon: 0x14141c,
    sky: { top: 0x05060c, bottom: 0x101018 },
    fog: { color: 0x07080e, near: 100, far: 235 },
    sun: { color: 0xfff4e2, intensity: 2.6, night: 0.05 },
    ambient: { sky: 0x3a4258, ground: 0x4a423a, intensity: 0.7 },
    // No atmosphere: shadows stay black and the stars never wash out.
    atmosphere: 0,
    craters: 26,
    roughness: 0.9,
    scatter: 'rocks',
    companion: { name: 'Earth', color: 0x4a7fc9, size: 5.4, glow: 0x6ea8ff },
    dust: 0,
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    blurb: 'Rust, dust, and a pink sky at noon.',
    ground: { low: 0x6b3320, high: 0xb56b40, tint: 0xd89464 },
    rock: 0x8a4a2c,
    horizon: 0x3a2118,
    sky: { top: 0x2b1a1e, bottom: 0xc4703c },
    fog: { color: 0x50301f, near: 82, far: 205 },
    sun: { color: 0xffd9b0, intensity: 2.2, night: 0.09 },
    ambient: { sky: 0xc07a52, ground: 0x4a2418, intensity: 0.75 },
    atmosphere: 0.55,
    craters: 12,
    roughness: 1.15,
    scatter: 'rocks',
    companion: { name: 'Phobos', color: 0x9a8878, size: 1.5, glow: 0xb8a494 },
    dust: 1,
  },
  terra: {
    id: 'terra',
    name: 'Terra',
    blurb: 'An earthlike one. Grass, blue hour, fireflies.',
    ground: { low: 0x2f5a34, high: 0x6d9a4a, tint: 0x86ae5c },
    rock: 0x6b6f63,
    horizon: 0x6fa8d8,
    sky: { top: 0x1d4d8f, bottom: 0x9ec8e8 },
    fog: { color: 0x6b8fa8, near: 92, far: 230 },
    sun: { color: 0xfff0d4, intensity: 2.4, night: 0.13 },
    ambient: { sky: 0x88bfe8, ground: 0x3f5a30, intensity: 0.95 },
    atmosphere: 1,
    craters: 0,
    roughness: 0.75,
    scatter: 'flora',
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0.25,
  },
  desert: {
    id: 'desert',
    name: 'Karak',
    blurb: 'Twin suns, endless dunes, and a spaceport that smells of hot metal.',
    ground: { low: 0x8a6a42, high: 0xd6b078, tint: 0xe8cf9a },
    rock: 0xa87848,
    horizon: 0xe0a468,
    sky: { top: 0x86aac2, bottom: 0xf0c48c },
    fog: { color: 0xd8a878, near: 78, far: 200 },
    sun: { color: 0xfff2cf, intensity: 2.5, night: 0.08 },
    ambient: { sky: 0xe8c090, ground: 0x8a6038, intensity: 0.85 },
    atmosphere: 0.8,
    craters: 0,
    roughness: 0.8,
    // Dunes instead of hills: same field inside the colony, ridges beyond it.
    terrain: 'dunes',
    scatter: 'desert',
    // Karak builds in its own kit — adobe domes and clay houses — instead of tinting the
    // base kit's hulls. Natively adobe, so no `buildingTint`: clay over clay only muddies.
    buildingKit: 'desertbase',
    // `sunTwin` puts the companion on the sun's own arc — a second, smaller sun that
    // rises and sets with the first instead of hanging fixed in the sky.
    companion: { name: 'Twin', color: 0xffd9a0, size: 2.4, glow: 0xffbe78, sunTwin: true },
    dust: 1,
  },
}

const GROUND_SIZE = 340
/** Everything inside this radius is the buildable colony, and is kept nearly flat. */
export const COLONY_RADIUS = 46
const DETAIL_SEGMENTS = { low: 72, medium: 128, high: 190 }

/**
 * Terrain is one plane, displaced and vertex-coloured on the CPU at build time. Doing it
 * once and baking it into the buffer means the GPU only ever sees static geometry — no
 * displacement map sample, no per-frame work — and vertex colours give the surface its
 * mottling for free rather than costing a texture fetch.
 */
export function createTerrain(planet, detail, seed = 1337) {
  const segments = DETAIL_SEGMENTS[detail] || DETAIL_SEGMENTS.medium
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, segments, segments)
  geo.rotateX(-Math.PI / 2)

  const noise = makeNoise(seed)
  const craters = makeCraters(planet.craters, seed)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)

  const low = new THREE.Color(planet.ground.low)
  const high = new THREE.Color(planet.ground.high)
  const tint = new THREE.Color(planet.ground.tint)
  const c = new THREE.Color()

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const dist = Math.hypot(x, z)

    const y = sampleHeight(x, z, noise, craters, planet)
    pos.setY(i, y)

    // Colour: height-driven blend, mottled with a second noise band so it never bands.
    const shade = THREE.MathUtils.clamp(0.42 + y * 0.09 + fbm(noise, x * 0.09, z * 0.09, 2) * 0.5, 0, 1)
    c.copy(low).lerp(high, shade)
    const speck = fbm(noise, x * 0.55, z * 0.55, 1)
    c.lerp(tint, Math.max(0, speck) * 0.22)
    // Darken the far field hard so the eye settles on the colony and the hills read as a
    // silhouette rather than as more ground competing with the plots for attention.
    c.multiplyScalar(1 - THREE.MathUtils.smoothstep(dist, COLONY_RADIUS * 0.7, GROUND_SIZE * 0.35) * 0.75)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    // Flat-ish shading keeps the low-poly read; a dielectric surface with no spec highlight
    // is what sells "dust" rather than "plastic".
    envMapIntensity: 0.3,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'terrain'

  // Sampler so anything placed later can sit exactly on the surface.
  mesh.userData.heightAt = (x, z) => sampleHeight(x, z, noise, craters, planet)
  return mesh
}

/**
 * The relief beyond the colony. Hills for most worlds; on a `dunes` planet, ridged noise
 * sampled in a squashed, rotated frame — 1-|fbm| folds the noise into sharp crests, and
 * stretching one axis of the sample space makes every crest run the same way, which is
 * what a wind-built dune field does.
 */
function farField(noise, x, z, planet) {
  if (planet.terrain === 'dunes') {
    const u = x * 0.9 + z * 0.44
    const v = z * 0.9 - x * 0.44
    const ridge = 1 - Math.abs(fbm(noise, u * 0.03, v * 0.009, 3))
    // Squaring sharpens the crest and flattens the trough — the asymmetry that makes a
    // dune a dune. A dash of isotropic detail keeps the slip faces from reading as glass.
    return ridge * ridge * 7 + fbm(noise, x * 0.05, z * 0.05, 2) * 0.8
  }
  return fbm(noise, x * 0.012, z * 0.012, 4) * 9 + fbm(noise, x * 0.05, z * 0.05, 2) * 1.4
}

/**
 * The one height field — the mesh is displaced by it and everything placed later samples
 * it, so the two can never drift apart.
 */
function sampleHeight(x, z, noise, craters, planet) {
  const dist = Math.hypot(x, z)
  // Flat where the colony lives, then relief that ramps in over the next forty metres —
  // so nothing ever builds on a slope but the horizon still has shape to it.
  const outside = THREE.MathUtils.smoothstep(dist, COLONY_RADIUS - 6, COLONY_RADIUS + 40)
  const gentle = fbm(noise, x * 0.035, z * 0.035, 3) * 0.5
  const far = farField(noise, x, z, planet)
  let y = gentle * planet.roughness * (1 - outside) + far * outside * planet.roughness
  for (const crater of craters) {
    const d = Math.hypot(x - crater.x, z - crater.z)
    if (d > crater.r * 1.5) continue
    // A bowl with a raised rim — the rim is what makes it read as an impact.
    const t = d / crater.r
    if (t < 1) y -= (1 - t * t) * crater.depth
    else y += (1 - Math.abs(t - 1.22) / 0.28) * crater.depth * 0.32
  }
  return y
}

/** Craters only ever land outside the colony, so they never eat a build plot. */
function makeCraters(count, seed) {
  const rand = mulberry(seed ^ 0x9e37)
  const out = []
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const d = COLONY_RADIUS + 14 + rand() * 110
    const r = 4 + rand() * 16
    out.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r, depth: r * (0.18 + rand() * 0.16) })
  }
  return out
}

// ── scatter ───────────────────────────────────────────────────────────────────────────

const SCATTER_BUDGET = 900

/**
 * Rocks, boulders and plants. All instanced, all placed with a deterministic RNG so the
 * same planet always looks the same, and all kept clear of the plots and walkways.
 */
/**
 * What grows on a world, and how it is planted.
 *
 * `weight` is how often a shape comes up relative to its siblings, `size` the range of its
 * base scale, and `sink` how far into the ground it settles as a fraction of that scale.
 * A boulder half-buried reads as bedrock; a tree buried by the same amount reads as a
 * mistake, so the two want very different numbers.
 *
 * All of it comes from KayKit's Forest Nature Pack, which is why the same list can dress a
 * meadow and a crater field: its boulders are painted neutral grey, so a per-instance tint
 * takes them to lunar dust or Martian rust without touching the atlas.
 */
const SCATTER = {
  flora: [
    { part: 'Tree_1_A_Color1', weight: 3, size: [0.35, 0.6], sink: 0.02, upright: true },
    { part: 'Tree_3_A_Color1', weight: 3, size: [0.35, 0.6], sink: 0.02, upright: true },
    { part: 'Tree_4_A_Color1', weight: 2, size: [0.3, 0.55], sink: 0.02, upright: true },
    { part: 'Tree_1_C_Color1', weight: 1, size: [0.25, 0.4], sink: 0.02, upright: true },
    { part: 'Tree_3_C_Color1', weight: 1, size: [0.22, 0.38], sink: 0.02, upright: true },
    { part: 'Tree_4_C_Color1', weight: 1, size: [0.2, 0.35], sink: 0.02, upright: true },
    { part: 'Bush_1_E_Color1', weight: 3, size: [0.5, 1.1], sink: 0.06, upright: true },
    { part: 'Bush_3_B_Color1', weight: 3, size: [0.5, 1.1], sink: 0.06, upright: true },
    { part: 'Grass_2_D_Color1', weight: 4, size: [0.6, 1.3], sink: 0.05, upright: true },
    { part: 'Rock_1_D_Color1', weight: 2, size: [0.4, 0.9], sink: 0.3, tint: true },
  ],
  rocks: [
    { part: 'Rock_1_D_Color1', weight: 4, size: [0.5, 1.2], sink: 0.3, tint: true },
    { part: 'Rock_2_C_Color1', weight: 4, size: [0.5, 1.2], sink: 0.3, tint: true },
    { part: 'Rock_3_E_Color1', weight: 3, size: [0.6, 1.4], sink: 0.15, tint: true },
    { part: 'Rock_1_J_Color1', weight: 1, size: [0.3, 0.7], sink: 0.25, tint: true },
    { part: 'Rock_2_G_Color1', weight: 1, size: [0.3, 0.7], sink: 0.25, tint: true },
    { part: 'Rock_3_L_Color1', weight: 2, size: [0.4, 0.9], sink: 0.12, tint: true },
    { part: 'Rock_3_Q_Color1', weight: 1, size: [0.25, 0.55], sink: 0.1, tint: true },
  ],
  // Sparse on purpose: a dune field crowded with props stops reading as a dune field.
  // Rocks take the planet's ochre; the grass stays the pack's own straw-dry green.
  desert: [
    { part: 'Rock_1_D_Color1', weight: 4, size: [0.5, 1.2], sink: 0.35, tint: true },
    { part: 'Rock_2_C_Color1', weight: 3, size: [0.5, 1.1], sink: 0.35, tint: true },
    { part: 'Rock_3_E_Color1', weight: 2, size: [0.6, 1.4], sink: 0.2, tint: true },
    { part: 'Rock_3_L_Color1', weight: 2, size: [0.4, 0.9], sink: 0.15, tint: true },
    { part: 'Grass_2_D_Color1', weight: 3, size: [0.5, 1.0], sink: 0.06, upright: true },
    { part: 'Bush_1_E_Color1', weight: 1, size: [0.35, 0.7], sink: 0.08, upright: true },
  ],
}

/** The fallback when the kit has not loaded: the primitives this used to be made of. */
function fallbackShapes(isFlora) {
  const shapes = isFlora
    ? [new THREE.IcosahedronGeometry(0.5, 0), new THREE.ConeGeometry(0.42, 1.5, 5), new THREE.SphereGeometry(0.5, 6, 4)]
    : [
        new THREE.DodecahedronGeometry(0.55, 0),
        new THREE.IcosahedronGeometry(0.6, 0),
        new THREE.TetrahedronGeometry(0.72, 0),
      ]
  for (const g of shapes) g.computeVertexNormals()
  return shapes.map((geo) => ({ geo, sink: 0.25, size: [0.28, 0.83], tint: true, upright: false }))
}

export function createScatter(planet, density, keepClear = [], seed = 4242) {
  const group = new THREE.Group()
  group.name = 'scatter'
  const count = Math.round(SCATTER_BUDGET * THREE.MathUtils.clamp(density, 0, 1))
  if (count <= 0) return group

  const rand = mulberry(seed)
  const isFlora = planet.scatter === 'flora'
  const recipe = SCATTER[planet.scatter] || SCATTER.rocks
  const ready = recipe.every((r) => hasPart(r.part, 'forest'))

  const kinds = ready
    ? recipe.map((r) => ({ ...r, geo: part(r.part, 'forest'), weight: r.weight }))
    : fallbackShapes(isFlora).map((r) => ({ ...r, weight: 1 }))

  // One material for the lot. The pack's atlas carries the greens and the greys, and the
  // per-instance colour is a *tint* on top of it — white for anything already the right
  // colour, the planet's own rock for a boulder that has to belong to this world.
  const atlas = ready ? atlasTexture('forest') : null
  const material = new THREE.MeshStandardMaterial({
    map: atlas,
    color: 0xffffff,
    roughness: isFlora ? 0.82 : 0.95,
    metalness: 0,
    flatShading: !ready,
  })

  const total = kinds.reduce((sum, k) => sum + k.weight, 0)
  const meshes = kinds.map((k) =>
    new THREE.InstancedMesh(k.geo, material, Math.ceil((count * k.weight) / total) + 8)
  )

  const rock = new THREE.Color(planet.rock)
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()
  const fill = new Array(kinds.length).fill(0)

  // Pick by weight: a cumulative table beats a uniform index when a fir should be rarer
  // than a grass tuft.
  const pickKind = () => {
    let roll = rand() * total
    for (let i = 0; i < kinds.length; i++) {
      roll -= kinds[i].weight
      if (roll <= 0) return i
    }
    return kinds.length - 1
  }

  for (let i = 0; i < count; i++) {
    // Bias outward: a ring is thicker where there is more area, which √ gives for free.
    const a = rand() * Math.PI * 2
    const d = 9 + Math.sqrt(rand()) * 150
    const x = Math.cos(a) * d
    const z = Math.sin(a) * d
    if (keepClear.some((p) => Math.hypot(x - p.x, z - p.z) < p.r)) continue

    const which = pickKind()
    const kind = kinds[which]
    const mesh = meshes[which]
    const slot = fill[which]
    if (slot >= mesh.instanceMatrix.count) continue

    // Far-field props are allowed to be much bigger, which reads as distance.
    const far = THREE.MathUtils.smoothstep(d, COLONY_RADIUS, 130)
    const [lo, hi] = kind.size
    const s = (lo + rand() * (hi - lo)) * (1 + far * 1.9)

    dummy.position.set(x, sampleY(x, z, planet, seed) - s * kind.sink, z)
    // A tree that leans is a fallen tree. Boulders may lie however they landed.
    if (kind.upright) dummy.rotation.set(0, rand() * Math.PI * 2, 0)
    else dummy.rotation.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5)
    const jitter = kind.upright ? 0.14 : 0.35
    dummy.scale.set(
      s * (1 - jitter / 2 + rand() * jitter),
      s * (1 - jitter / 2 + rand() * jitter),
      s * (1 - jitter / 2 + rand() * jitter)
    )
    dummy.updateMatrix()
    mesh.setMatrixAt(slot, dummy.matrix)

    // Foliage keeps the colour it was painted; rock takes the planet's. The tint is lifted
    // because it *multiplies* the atlas rather than replacing it — the pack's stone is a
    // mid grey, and rust times mid grey is a much darker rust than the ground it sits on.
    if (kind.tint) color.copy(rock).multiplyScalar(1.55)
    else color.setRGB(1, 1, 1)
    color.offsetHSL((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.14)
    mesh.setColorAt(slot, color)
    fill[which] = slot + 1
  }

  meshes.forEach((mesh, i) => {
    mesh.count = fill[i]
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    group.add(mesh)
  })
  return group
}

/**
 * Terrain height at a world point — the same field the mesh was built from, evaluated on
 * demand. Used to place scatter, and to keep anything that walks on the ground *on* it.
 */
export function terrainHeight(x, z, planet) {
  return sampleY(x, z, planet, 1337)
}

// A private terrain sampler for scatter placement — the same field the mesh was built from.
const _samplers = new Map()
function sampleY(x, z, planet, seed) {
  let s = _samplers.get(planet.id)
  if (!s) {
    s = { noise: makeNoise(1337), craters: makeCraters(planet.craters, 1337) }
    _samplers.set(planet.id, s)
  }
  return sampleHeight(x, z, s.noise, s.craters, planet)
}

// ── noise ─────────────────────────────────────────────────────────────────────────────

/** Small deterministic PRNG — same seed, same world, every reload. */
export function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Value noise on a hashed lattice with smoothstep interpolation — cheap and smooth enough. */
function makeNoise(seed) {
  const rand = mulberry(seed)
  const size = 256
  const table = new Float32Array(size * size)
  for (let i = 0; i < table.length; i++) table[i] = rand() * 2 - 1

  return function noise(x, y) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const at = (a, b) => table[(((a % size) + size) % size) * size + (((b % size) + size) % size)]
    const a = at(xi, yi)
    const b = at(xi + 1, yi)
    const c = at(xi, yi + 1)
    const d = at(xi + 1, yi + 1)
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
  }
}

function fbm(noise, x, y, octaves) {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.07
  }
  return sum / norm
}
