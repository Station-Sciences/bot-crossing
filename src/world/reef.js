import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry } from './planet.js'

/**
 * The reef: everything that is *underwater-shaped* about the underwater world.
 *
 * The colony's structure — territories on a hex lattice, one structure per thread, an
 * arrival point, a navigation grid — is the same on the seabed as on the Moon. What differs
 * is the art, and all of it lives here so the rest of the world code can ask for "a
 * structure", "the scatter", "the place inhabitants arrive from" and get a coral colony, a
 * field of kelp and a shipwreck back instead of a habitat, a boulder field and a lander.
 *
 * Nothing in this file is loaded from disk. Corals are grown from primitives with a seeded
 * RNG, so a thread's coral is the same coral on every reload, and the same kinds dress the
 * scatter, the plots' edges and the wreck, so the whole reef reads as one place.
 *
 * Three shader ideas run through all of it and are shared by every material below:
 *
 * - **Caustics.** Light through a rippled surface, drawn as interfering sine ridges over
 *   world XZ and *multiplied into the albedo before lighting*, so it is lit and shadowed by
 *   the same sun as everything else and vanishes in the shade the way real caustics do.
 * - **Sway.** Anything soft — kelp, fans, anemone tentacles — leans with a slow current in
 *   the vertex stage, by an amount baked per vertex, so one rigid buffer moves like a plant.
 * - **Bioluminescence.** Tips and tentacles carry a per-vertex glow flag and light up after
 *   dark, pushed past 1.0 so the bloom pass picks them out. This is the reef's "windows".
 */

/** Shared by every reef material: one write a frame moves every frond and every caustic. */
export const reefUniforms = {
  uReefTime: { value: 0 },
  uReefNight: { value: 0 },
  /** 0..1 — how strong the caustic pattern is. Fades with the sun, off at night. */
  uCaustic: { value: 1 },
}

// ── shared GLSL ───────────────────────────────────────────────────────────────────────

const CAUSTIC_GLSL = /* glsl */ `
  // Two interfering sets of three waves each. The bright ridges are where both sums cross
  // zero, which is the same cellular look a real rippled surface focuses the sun into, for
  // six sines and no texture.
  float botCaustic( vec2 p, float t ) {
    vec2 q = p * 1.15;
    float a = sin( q.x * 1.7 + t * 0.9 ) + sin( q.y * 1.3 - t * 0.7 ) + sin( ( q.x + q.y ) * 1.1 + t * 0.5 );
    float b = sin( q.x * 2.9 - t * 1.1 + 1.7 ) + sin( q.y * 2.3 + t * 0.8 + 0.4 ) + sin( ( q.x - q.y ) * 1.9 - t * 0.6 );
    float c = ( 1.0 - abs( a ) / 3.0 ) * ( 1.0 - abs( b ) / 3.0 );
    return pow( clamp( c, 0.0, 1.0 ), 5.0 );
  }
`

const SWAY_GLSL = /* glsl */ `
  uniform float uReefTime;
  attribute float aSway;
  // A slow lean plus a faster flutter, both scaled by how much this vertex is allowed to
  // move — zero at a root, one at a tip — so a frond bends rather than slides.
  vec3 botSway( vec3 p, float phase ) {
    float t = uReefTime;
    float s = aSway;
    p.x += ( sin( t * 1.1 + phase ) * 0.6 + sin( t * 2.3 + phase * 1.7 ) * 0.25 ) * 0.16 * s;
    p.z += cos( t * 0.9 + phase * 1.3 ) * 0.11 * s;
    return p;
  }
`

/**
 * Light through water, on any lit surface.
 *
 * The pattern is multiplied into the diffuse colour before lighting, which is what makes
 * it read as light *falling on* the sand rather than as paint: it is brightest in full
 * sun, gone in shadow, and it fades out with the day along with everything else.
 */
export function decorateCaustics(material, strength = 0.9) {
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader) => {
    prev?.(shader)
    shader.uniforms.uReefTime = reefUniforms.uReefTime
    shader.uniforms.uCaustic = reefUniforms.uCaustic
    shader.uniforms.uCausticStrength = { value: strength }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec3 vReefPos;\n varying float vReefUp;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vReefPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
         vReefUp = max( ( modelMatrix * vec4( objectNormal, 0.0 ) ).y, 0.0 );`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vReefPos;
         varying float vReefUp;
         uniform float uReefTime;
         uniform float uCaustic;
         uniform float uCausticStrength;
         ${CAUSTIC_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         float caustic = botCaustic( vReefPos.xz, uReefTime ) * vReefUp * uCaustic * uCausticStrength;
         diffuseColor.rgb *= 1.0 + caustic * vec3( 0.75, 0.9, 0.85 );`
      )
  }
  return material
}

/**
 * The reef's surface material: vertex-coloured PBR with sway and bioluminescence.
 *
 * One material serves the scatter, the plots' clutter and the wreck's growth; the coral
 * colonies get their own copy with the construction sink on top (see `createCoral`).
 */
export function coralMaterial({ instanced = false, phase = 0 } = {}) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
    shadowSide: THREE.BackSide,
  })
  decorateReef(material, { instanced, phase })
  return material
}

function decorateReef(material, { instanced, phase, uniforms = {} }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uReefTime = reefUniforms.uReefTime
    shader.uniforms.uReefNight = reefUniforms.uReefNight
    shader.uniforms.uSwayPhase = { value: phase }
    Object.assign(shader.uniforms, uniforms)

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         ${SWAY_GLSL}
         attribute float aGlow;
         varying float vGlow;
         uniform float uSwayPhase;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vGlow = aGlow;
         #ifdef USE_INSTANCING
           float swayPhase = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.9;
         #else
           float swayPhase = uSwayPhase;
         #endif
         transformed = botSway( transformed, swayPhase );`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n varying float vGlow;\n uniform float uReefNight;\n uniform float uReefTime;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // Tentacle tips and polyps come on after dark, each on its own slow pulse.
         float pulse = 0.75 + 0.25 * sin( uReefTime * 1.4 + vGlow * 9.0 );
         totalEmissiveRadiance += diffuseColor.rgb * vGlow * ( 0.08 + uReefNight * 2.6 * pulse );`
      )
  }
  return material
}

// ── growing things ────────────────────────────────────────────────────────────────────

/** Bake colour, glow and sway into a geometry so it can merge with its siblings. */
function paint(geo, color, { glow = 0, sway = 0, swayFrom = 0, swayTo = 1, tint = 0 } = {}) {
  const c = new THREE.Color(color)
  const pos = geo.attributes.position
  const n = pos.count
  const colors = new Float32Array(n * 3)
  const glows = new Float32Array(n)
  const sways = new Float32Array(n)
  const rand = mulberry(n * 977 + 13)
  for (let i = 0; i < n; i++) {
    // A hair of per-vertex variation stops a flat colour reading as plastic.
    const v = 1 + (rand() - 0.5) * tint
    colors[i * 3] = c.r * v
    colors[i * 3 + 1] = c.g * v
    colors[i * 3 + 2] = c.b * v
    glows[i] = glow
    // Sway grows with height between two bounds, so a root stays planted.
    const y = pos.getY(i)
    const t = THREE.MathUtils.clamp((y - swayFrom) / Math.max(1e-3, swayTo - swayFrom), 0, 1)
    sways[i] = sway * t * t
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glows, 1))
  geo.setAttribute('aSway', new THREE.BufferAttribute(sways, 1))
  return geo
}

/** Merge painted parts into one buffer, dropping the UVs nothing here samples. */
function mergeParts(parts) {
  // Three's primitives disagree about indexing — an icosahedron is flat, a cylinder is
  // indexed — and a merge refuses a mix, so everything is flattened first.
  const flat = parts.map((p) => {
    p.deleteAttribute('uv')
    if (!p.attributes.normal) p.computeVertexNormals()
    if (!p.index) return p
    const f = p.toNonIndexed()
    p.dispose()
    return f
  })
  const merged = BufferGeometryUtils.mergeGeometries(flat, false)
  flat.forEach((g) => g.dispose())
  merged.computeBoundingBox()
  return merged
}

/** A lumpy sphere: boulder coral, brain coral, or plain rock depending on the paint. */
function lumpySphere(radius, rand, bump = 0.18, detail = 2) {
  const geo = new THREE.IcosahedronGeometry(radius, detail)
  const pos = geo.attributes.position
  const p = [rand() * 6.3, rand() * 6.3, rand() * 6.3, rand() * 6.3]
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const n = v.clone().normalize()
    const d =
      1 +
      bump *
        (Math.sin(n.x * 3.1 + p[0]) * Math.sin(n.y * 2.7 + p[1]) * 0.6 +
          Math.sin(n.z * 4.3 + p[2]) * Math.cos(n.x * 3.7 + p[3]) * 0.4)
    pos.setXYZ(i, n.x * radius * d, n.y * radius * d, n.z * radius * d)
  }
  geo.computeVertexNormals()
  return geo
}

/** One tapered segment from `a` to `b`. */
function segment(a, b, r0, r1, sides = 5) {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  const geo = new THREE.CylinderGeometry(r1, r0, len, sides, 1)
  geo.translate(0, len / 2, 0)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  geo.applyQuaternion(q)
  geo.translate(a.x, a.y, a.z)
  return geo
}

/**
 * Branching coral: a trunk that forks two or three ways, three levels deep. `flat` keeps
 * every fork in one plane, which is a sea fan.
 */
function branching(rand, { height = 1.2, radius = 0.09, flat = false, spread = 0.55, depth = 3 } = {}) {
  const parts = []
  const tips = []
  const grow = (from, dir, len, r, level) => {
    const to = from.clone().addScaledVector(dir, len)
    parts.push(segment(from, to, r, r * 0.62, 5))
    if (level >= depth) {
      tips.push(to)
      return
    }
    const forks = 2 + (rand() > 0.6 ? 1 : 0)
    for (let i = 0; i < forks; i++) {
      const tilt = spread * (0.6 + rand() * 0.8)
      const yaw = flat ? (i % 2 ? 1 : -1) * 0 : rand() * Math.PI * 2
      const side = flat ? (i - (forks - 1) / 2) * tilt : 0
      const d = dir.clone()
      if (flat) d.applyAxisAngle(new THREE.Vector3(0, 0, 1), side)
      else {
        d.applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt)
        d.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      }
      d.normalize()
      grow(to, d, len * (0.68 + rand() * 0.14), r * 0.66, level + 1)
    }
  }
  grow(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), height * 0.38, radius, 1)
  return { parts, tips }
}

/** The knobs on a branch coral's tips: what glows at night. */
function polyps(tips, size) {
  return tips.map((t) => {
    const g = new THREE.SphereGeometry(size, 5, 4)
    g.translate(t.x, t.y, t.z)
    return g
  })
}

// Reef palettes. Warm corals and cool ones both exist, so a plot can carry either.
const CORAL_TONES = [0xe8734a, 0xf2a45a, 0xd94f7a, 0xc95cc9, 0x7c6fe0, 0x4fb8c9, 0xf0d060, 0xe86a5a]
const KELP_TONES = [0x4a7a3a, 0x3f6f44, 0x5c8a3a, 0x6b7f2f]
const ROCK_TONE = 0x5f6a66
const SAND_TONE = 0xc9b58a

/**
 * What grows on the reef, as reusable geometries. Built once and cached: the scatter, the
 * plots and the wreck all draw from the same set, so they are one vocabulary.
 *
 * Each entry mirrors the shape the planet scatter expects — `geo`, `size`, `sink`,
 * `upright` — plus a `weight` for how often it comes up.
 */
let kinds = null
export function reefKinds() {
  if (kinds) return kinds
  const rand = mulberry(0xc07a1)
  const pick = (list) => list[Math.floor(rand() * list.length)]

  const kelp = () => {
    const h = 2.6 + rand() * 1.6
    const geo = new THREE.PlaneGeometry(0.34, h, 1, 9)
    geo.translate(0, h / 2, 0)
    // A blade twists a little as it rises, so the flat plane catches light on both faces.
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      const a = (y / h) * 1.4
      const x = pos.getX(i)
      pos.setXYZ(i, x * Math.cos(a), y, x * Math.sin(a))
    }
    geo.computeVertexNormals()
    return paint(geo, pick(KELP_TONES), { sway: 1, swayFrom: 0, swayTo: h, tint: 0.2 })
  }

  const rock = () => paint(lumpySphere(0.6, rand, 0.22, 1), ROCK_TONE, { tint: 0.25 })

  const boulder = () => paint(lumpySphere(0.55, rand, 0.12, 2), pick(CORAL_TONES), { tint: 0.12 })

  const anemone = () => {
    const tone = pick(CORAL_TONES)
    const parts = []
    const stalk = new THREE.CylinderGeometry(0.16, 0.22, 0.32, 8)
    stalk.translate(0, 0.16, 0)
    parts.push(paint(stalk, tone, { tint: 0.15 }))
    const n = 10 + Math.floor(rand() * 6)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.3
      const tilt = 0.35 + rand() * 0.55
      const dir = new THREE.Vector3(Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a))
      const base = new THREE.Vector3(Math.cos(a) * 0.1, 0.3, Math.sin(a) * 0.1)
      const len = 0.35 + rand() * 0.2
      const t = segment(base, base.clone().addScaledVector(dir, len), 0.035, 0.02, 4)
      parts.push(paint(t, tone, { glow: 0.35, sway: 0.7, swayFrom: 0.3, swayTo: 0.3 + len, tint: 0.2 }))
    }
    return mergeParts(parts)
  }

  const sponge = () => {
    const tone = pick([0xd9c14f, 0xb95c9a, 0x6f9fd0, 0xe89a4f])
    const parts = []
    const n = 3 + Math.floor(rand() * 4)
    for (let i = 0; i < n; i++) {
      const h = 0.45 + rand() * 0.7
      const r = 0.08 + rand() * 0.06
      const g = new THREE.CylinderGeometry(r, r * 0.7, h, 7, 1, true)
      g.translate(0, h / 2, 0)
      g.rotateZ((rand() - 0.5) * 0.5)
      g.rotateY(rand() * 6.3)
      g.translate((rand() - 0.5) * 0.4, 0, (rand() - 0.5) * 0.4)
      parts.push(paint(g, tone, { tint: 0.18 }))
    }
    return mergeParts(parts)
  }

  const stag = () => {
    const tone = pick(CORAL_TONES)
    const { parts, tips } = branching(rand, { height: 1.1 + rand() * 0.5, radius: 0.07 })
    const painted = parts.map((g) => paint(g, tone, { tint: 0.1, sway: 0.12, swayTo: 1.5 }))
    const knobs = polyps(tips, 0.05).map((g) => paint(g, tone, { glow: 0.6 }))
    return mergeParts([...painted, ...knobs])
  }

  const fan = () => {
    const tone = pick([0xc94f8b, 0x7c6fe0, 0xe8734a, 0xf0d060])
    const { parts } = branching(rand, { height: 1.4 + rand() * 0.4, radius: 0.045, flat: true, spread: 0.5, depth: 4 })
    const painted = parts.map((g) => paint(g, tone, { tint: 0.1, sway: 0.9, swayFrom: 0.2, swayTo: 1.6 }))
    return mergeParts(painted)
  }

  const table = () => {
    const tone = pick(CORAL_TONES)
    const stalk = new THREE.CylinderGeometry(0.1, 0.16, 0.5, 6)
    stalk.translate(0, 0.25, 0)
    const top = lumpySphere(0.7, rand, 0.1, 2)
    top.scale(1, 0.18, 1)
    top.translate(0, 0.55, 0)
    return mergeParts([paint(stalk, tone, { tint: 0.1 }), paint(top, tone, { tint: 0.12, glow: 0.12 })])
  }

  kinds = {
    kelp: { geo: kelp(), weight: 5, size: [0.6, 1.1], sink: 0.02, upright: true },
    kelp2: { geo: kelp(), weight: 4, size: [0.5, 1.0], sink: 0.02, upright: true },
    rock: { geo: rock(), weight: 4, size: [0.5, 1.4], sink: 0.35, upright: false },
    boulder: { geo: boulder(), weight: 2, size: [0.4, 0.9], sink: 0.3, upright: false },
    anemone: { geo: anemone(), weight: 3, size: [0.7, 1.2], sink: 0.05, upright: true },
    sponge: { geo: sponge(), weight: 2, size: [0.7, 1.2], sink: 0.05, upright: true },
    stag: { geo: stag(), weight: 2, size: [0.6, 1.1], sink: 0.03, upright: true },
    fan: { geo: fan(), weight: 2, size: [0.6, 1.0], sink: 0.03, upright: true },
    table: { geo: table(), weight: 1, size: [0.7, 1.2], sink: 0.05, upright: true },
  }
  // Every kind is flattened to the same attribute set — no index, no uv — so any of them
  // can be cloned into any merge below without the merge refusing the mix.
  for (const kind of Object.values(kinds)) kind.geo = mergeParts([kind.geo])
  return kinds
}

// ── coral colonies: one per thread ────────────────────────────────────────────────────

/**
 * A thread's structure on the reef, with the same contract as `createBuilding`: a mesh
 * whose `userData.setProgress` sinks it into the sand and discards what falls below, so a
 * new thread's coral *rises* out of the seabed rather than popping in.
 *
 * Seeded from the thread id, like the buildings, so it is the same coral every time. The
 * repo's accent is the colony's dominant colour, with the tips glowing in it after dark —
 * the reef's answer to a habitat's lit windows.
 */
const CORAL_SCALE = 1.6

export function createCoral({ seed = 1, accent = 0xe8734a } = {}) {
  const rand = mulberry(seed)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const base = new THREE.Color(accent)
  // Variations on the accent: a little lighter, a little shifted, so a colony is not one flat hue.
  const shade = (h, s, l) => new THREE.Color(base).offsetHSL(h, s, l).getHex()

  const parts = []
  let label = 'Coral head'

  // A rocky footing, half buried, that every colony grows out of.
  const footing = lumpySphere(0.75 + rand() * 0.25, rand, 0.2, 1)
  footing.scale(1.15, 0.55, 1.15)
  footing.translate(0, 0.05, 0)
  parts.push(paint(footing, ROCK_TONE, { tint: 0.25 }))

  const kind = Math.floor(rand() * 4)
  if (kind === 0) {
    // Boulder coral with a crown of anemones.
    label = 'Boulder coral'
    const head = lumpySphere(0.62 + rand() * 0.2, rand, 0.16, 2)
    head.translate(0, 0.55, 0)
    parts.push(paint(head, shade(0, 0.05, 0), { tint: 0.12, glow: 0.05 }))
    const n = 2 + Math.floor(rand() * 3)
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2
      const g = reefKinds().anemone.geo.clone()
      g.scale(0.7, 0.7, 0.7)
      g.translate(Math.cos(a) * 0.45, 0.95, Math.sin(a) * 0.45)
      parts.push(recolour(g, pick(CORAL_TONES)))
    }
  } else if (kind === 1) {
    // Staghorn thicket: two or three branching heads at different heights.
    label = 'Staghorn coral'
    const n = 2 + Math.floor(rand() * 2)
    for (let i = 0; i < n; i++) {
      const tone = shade(0.05 * (rand() - 0.5), 0.05, 0.05 * (rand() - 0.5))
      const { parts: p, tips } = branching(rand, { height: 1.3 + rand() * 0.7, radius: 0.08 })
      const a = rand() * Math.PI * 2
      const ox = Math.cos(a) * 0.35 * i
      const oz = Math.sin(a) * 0.35 * i
      for (const g of p) {
        g.translate(ox, 0.3, oz)
        parts.push(paint(g, tone, { tint: 0.1, sway: 0.1, swayFrom: 0.3, swayTo: 2 }))
      }
      for (const g of polyps(tips, 0.055)) {
        g.translate(ox, 0.3, oz)
        parts.push(paint(g, tone, { glow: 0.7 }))
      }
    }
  } else if (kind === 2) {
    // Table coral over a bed of sponges.
    label = 'Table coral'
    const stalk = new THREE.CylinderGeometry(0.14, 0.24, 0.9, 7)
    stalk.translate(0, 0.6, 0)
    parts.push(paint(stalk, shade(0, -0.1, -0.08), { tint: 0.1 }))
    const top = lumpySphere(0.95 + rand() * 0.25, rand, 0.12, 2)
    top.scale(1, 0.16, 1)
    top.translate(0, 1.1, 0)
    parts.push(paint(top, shade(0, 0.05, 0.02), { tint: 0.12, glow: 0.18 }))
    const sponge = reefKinds().sponge.geo.clone()
    sponge.translate(0.55, 0.25, -0.35)
    parts.push(recolour(sponge, pick(CORAL_TONES)))
  } else {
    // Sea fans on a rock, the softest silhouette on the reef.
    label = 'Sea fan'
    const n = 2 + Math.floor(rand() * 2)
    for (let i = 0; i < n; i++) {
      const tone = shade(0.04 * (rand() - 0.5), 0.05, 0.06)
      const { parts: p } = branching(rand, { height: 1.5 + rand() * 0.5, radius: 0.05, flat: true, spread: 0.5, depth: 4 })
      const yaw = rand() * Math.PI
      for (const g of p) {
        g.rotateY(yaw)
        g.translate((rand() - 0.5) * 0.5, 0.3, (rand() - 0.5) * 0.5)
        parts.push(paint(g, tone, { tint: 0.1, sway: 0.9, swayFrom: 0.4, swayTo: 2.2 }))
      }
    }
    const rock = lumpySphere(0.4, rand, 0.2, 1)
    rock.translate(0.4, 0.2, 0.3)
    parts.push(paint(rock, ROCK_TONE, { tint: 0.25 }))
  }

  const geo = mergeParts(parts)
  // Sized against the fish the way the buildings are sized against the crew: a coral head
  // a fish can hide behind, not one it could carry.
  geo.scale(CORAL_SCALE, CORAL_SCALE, CORAL_SCALE)
  geo.computeBoundingBox()
  const height = geo.boundingBox.max.y
  const footprint = Math.max(
    Math.abs(geo.boundingBox.max.x),
    Math.abs(geo.boundingBox.min.x),
    Math.abs(geo.boundingBox.max.z),
    Math.abs(geo.boundingBox.min.z)
  )

  const uniforms = {
    uProgress: { value: 1 },
    uMaxY: { value: height },
    uMinY: { value: geo.boundingBox.min.y },
    uAccent: { value: new THREE.Color(accent) },
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    side: THREE.DoubleSide,
    shadowSide: THREE.BackSide,
  })
  decorateReef(material, { instanced: false, phase: seed % 100, uniforms })
  sinkable(material, uniforms)

  const mesh = new THREE.Mesh(geo, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.customDepthMaterial = sinkableDepth(uniforms, seed % 100)

  mesh.userData.kind = label
  mesh.userData.label = label
  mesh.userData.height = height
  mesh.userData.footprint = footprint
  mesh.userData.uniforms = uniforms
  mesh.userData.progress = 1
  mesh.userData.setProgress = (p) => {
    const v = THREE.MathUtils.clamp(p, 0, 1)
    mesh.userData.progress = v
    uniforms.uProgress.value = v
    mesh.visible = v > 0.02
  }
  return mesh
}

/** Repaint a cloned kind in a new colour, keeping its glow and sway. */
function recolour(geo, hex) {
  const c = new THREE.Color(hex)
  const col = geo.attributes.color
  for (let i = 0; i < col.count; i++) {
    // Keep the per-vertex variation the original paint gave it.
    const v = col.getX(i) + col.getY(i) + col.getZ(i)
    const k = v > 0 ? v / 3 : 1
    col.setXYZ(i, c.r * (0.85 + k * 0.3), c.g * (0.85 + k * 0.3), c.b * (0.85 + k * 0.3))
  }
  col.needsUpdate = true
  return geo
}

/**
 * The construction sink, the same trick the buildings use: lower the whole structure and
 * discard whatever ends up below the sand, so a half-grown coral is a whole coral partly
 * buried. Layered on *after* `decorateReef`, so the sway is applied first and the sink to
 * the swayed position.
 */
function sinkable(material, uniforms) {
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader) => {
    prev?.(shader)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;`
      )
      .replace(
        'transformed = botSway( transformed, swayPhase );',
        `transformed = botSway( transformed, swayPhase );
         vLocalY = transformed.y;
         transformed.y -= ( 1.0 - uProgress ) * ( uMaxY - uMinY );`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;
         uniform vec3 uAccent;`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         float ground = uMinY + ( 1.0 - uProgress ) * ( uMaxY - uMinY );
         if ( vLocalY < ground - 0.001 ) discard;`
      )
      .replace(
        'totalEmissiveRadiance += diffuseColor.rgb * vGlow',
        `// A bright band where the coral is still rising out of the sand.
         float band = 1.0 - smoothstep( 0.0, 0.2, vLocalY - ground );
         totalEmissiveRadiance += uAccent * band * ( 1.0 - step( 0.999, uProgress ) ) * 1.4;
         totalEmissiveRadiance += diffuseColor.rgb * vGlow`
      )
  }
  return material
}

function sinkableDepth(uniforms, phase) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  mat.side = THREE.BackSide
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.uniforms.uReefTime = reefUniforms.uReefTime
    shader.uniforms.uSwayPhase = { value: phase }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         ${SWAY_GLSL}
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;
         uniform float uSwayPhase;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed = botSway( transformed, uSwayPhase );
         vLocalY = transformed.y;
         transformed.y -= ( 1.0 - uProgress ) * ( uMaxY - uMinY );`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vLocalY;
         uniform float uProgress;
         uniform float uMaxY;
         uniform float uMinY;`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         if ( vLocalY < uMinY + ( 1.0 - uProgress ) * ( uMaxY - uMinY ) - 0.001 ) discard;`
      )
  }
  return mat
}

// ── the wreck ─────────────────────────────────────────────────────────────────────────

const WRECK_SCALE = 1.7
const HULL_WOOD = 0x7d5f42
const HULL_DARK = 0x4a3728
const RUST = 0x7a4a2a
const BRASS = 0xb08a3a

/**
 * Where the fish come from. A sunken boat, listing in the sand, with an open hatch that
 * every new thread swims out of and every archived one swims back into — the same job the
 * lander does on the Moon, with the same interface (`shipDoor`, `ping`, `update`).
 */
export class Wreck {
  constructor(scene, position) {
    this.group = new THREE.Group()
    this.group.position.copy(position)
    // Hatch toward the middle of the reef, like the lander's ramp.
    this.group.rotation.y = Math.atan2(-position.x, -position.z)
    this.group.name = 'wreck'
    scene.add(this.group)
    this.scene = scene
    this.traffic = 0

    this._build()
  }

  _build() {
    const parts = []
    const rand = mulberry(0x5ea)

    // The hull: the lower half of a stretched sphere, listing to one side and sunk a little
    // into the sand. Open at the top, so it is double-sided like every shell here.
    const hull = new THREE.SphereGeometry(1, 22, 12, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58)
    hull.scale(2.1, 1.7, 4.6)
    parts.push(paint(hull, HULL_WOOD, { tint: 0.3 }))

    // Ribs and a keel, so the inside reads as a boat rather than a bowl.
    for (let i = -3; i <= 3; i++) {
      const rib = new THREE.TorusGeometry(1.0, 0.06, 5, 16, Math.PI)
      rib.rotateZ(Math.PI)
      rib.scale(2.05 * (1 - Math.abs(i) * 0.07), 1.65, 1)
      rib.translate(0, 0.02, i * 0.62)
      parts.push(paint(rib, HULL_DARK, { tint: 0.2 }))
    }
    const keel = new THREE.BoxGeometry(0.14, 0.3, 4.4)
    keel.translate(0, -1.6, 0)
    parts.push(paint(keel, HULL_DARK))

    // A deck at the bow with the hatch cut out of it — the "door".
    const deck = new THREE.RingGeometry(0.62, 2.0, 24, 1, 0, Math.PI * 2)
    deck.rotateX(-Math.PI / 2)
    deck.scale(1, 1, 1.3)
    deck.translate(0, 0.02, 1.5)
    parts.push(paint(deck, HULL_WOOD, { tint: 0.25 }))
    const hatchRim = new THREE.TorusGeometry(0.66, 0.07, 6, 20)
    hatchRim.rotateX(Math.PI / 2)
    hatchRim.scale(1, 1, 1.3)
    hatchRim.translate(0, 0.06, 1.5)
    parts.push(paint(hatchRim, BRASS, { tint: 0.1 }))

    // The mast, snapped and leaning, with a stub of a spar.
    const mast = segment(new THREE.Vector3(0, 0, -0.6), new THREE.Vector3(0.9, 3.4, -1.4), 0.12, 0.08, 7)
    parts.push(paint(mast, HULL_DARK, { tint: 0.2 }))
    const spar = segment(new THREE.Vector3(-0.3, 2.4, -1.0), new THREE.Vector3(1.6, 2.7, -1.35), 0.06, 0.04, 5)
    parts.push(paint(spar, HULL_DARK, { tint: 0.2 }))

    // Rust patches and a propeller at the stern.
    const prop = new THREE.TorusGeometry(0.28, 0.07, 5, 12)
    prop.translate(0, -0.9, -2.35)
    parts.push(paint(prop, RUST, { tint: 0.2 }))
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.BoxGeometry(0.1, 0.5, 0.05)
      blade.translate(0, 0.35, 0)
      blade.rotateZ((i / 3) * Math.PI * 2)
      blade.translate(0, -0.9, -2.4)
      parts.push(paint(blade, RUST, { tint: 0.2 }))
    }

    // What has grown on it: sponges along the hull, a fan on the mast, anemones on the deck.
    const kinds = reefKinds()
    const grow = (kind, x, y, z, s, ry = 0) => {
      const g = kinds[kind].geo.clone()
      g.scale(s, s, s)
      g.rotateY(ry)
      g.translate(x, y, z)
      parts.push(g)
    }
    grow('sponge', 1.6, -0.2, -0.4, 0.9)
    grow('sponge', -1.5, -0.4, 0.9, 0.8, 1.2)
    grow('anemone', 1.2, 0.05, 1.7, 0.8)
    grow('anemone', -1.1, 0.05, 2.2, 0.7, 2)
    grow('fan', 0.8, 2.1, -1.35, 0.55, 0.6)
    grow('stag', -1.4, -0.6, -1.6, 0.8)
    for (let i = 0; i < 4; i++) grow('kelp', -2.4 + rand() * 0.4, -0.6, -1.5 + i * 0.9, 0.7, rand() * 6)

    this.hull = new THREE.Mesh(mergeParts(parts), coralMaterial({ phase: 3 }))
    this.hull.castShadow = true
    this.hull.receiveShadow = true
    // Listing, and a third of the way into the sand. Scaled to the lander's footprint, so
    // the cell it owns on the lattice fits it the same way.
    this.hull.rotation.z = 0.34
    this.hull.scale.setScalar(WRECK_SCALE)
    this.hull.position.y = 0.7
    this.group.add(this.hull)

    // The dark of the open hatch, and a lamp in it that comes on at night and brightens
    // while fish are using it — the wreck's ramp strip.
    const dark = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 20),
      new THREE.MeshBasicMaterial({ color: 0x03060a, toneMapped: false })
    )
    dark.rotation.x = -Math.PI / 2
    dark.scale.set(1, 1.3, 1)
    dark.position.set(0, 0.05, 1.5)
    this.hull.add(dark)
    this.lampMaterial = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, toneMapped: true })
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), this.lampMaterial)
    this.lamp.position.set(0.5, 0.25, 1.9)
    this.hull.add(this.lamp)

    // Where fish appear and vanish: just above the hatch, in world space once the hull's
    // list is applied.
    this.doorLocal = new THREE.Vector3(0, 0.05, 1.5).multiplyScalar(WRECK_SCALE).applyEuler(new THREE.Euler(0, 0, 0.34))
    this.doorLocal.y += 0.7 + 0.9
    this.doorLocal.z += 1.4
  }

  shipDoor(out = new THREE.Vector3()) {
    return out.copy(this.doorLocal).applyMatrix4(this.group.matrixWorld)
  }

  update(dt, elapsed, night) {
    this.traffic = Math.max(0, this.traffic - dt * 1.5)
    const busy = Math.min(1, this.traffic)
    const pulse = 0.6 + 0.4 * Math.sin(elapsed * 4)
    const s = (0.35 + night * 2.2) * (1 + busy * pulse * 1.4)
    this.lampMaterial.color.setRGB(0.55 * s, 0.85 * s, 1.1 * s)
  }

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

// ── light shafts ──────────────────────────────────────────────────────────────────────

/**
 * Sunbeams. A handful of tall additive quads, turned to face the camera about their own
 * axis and leaning the way the sun does, that drift slowly across the reef. They carry no
 * information — they are there so the water is never completely still, and so the scene
 * reads as *under* something rather than merely blue.
 */
export class LightShafts {
  constructor(scene, count = 12) {
    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = 'shafts'
    scene.add(this.group)
    this.uniforms = { uStrength: { value: 1 }, uTime: { value: 0 } }
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uStrength;
        uniform float uTime;
        void main() {
          // Soft across, bright at the top, gone before it touches the sand.
          float across = pow( 1.0 - abs( vUv.x - 0.5 ) * 2.0, 2.2 );
          float down = smoothstep( 0.0, 0.35, vUv.y ) * pow( vUv.y, 1.6 );
          float flicker = 0.8 + 0.2 * sin( uTime * 0.7 + vUv.x * 9.0 );
          float a = across * down * flicker * uStrength * 0.16;
          gl_FragColor = vec4( vec3( 0.55, 0.85, 0.95 ) * a, a );
        }
      `,
    })
    const rand = mulberry(0x5a7)
    this.shafts = []
    for (let i = 0; i < count; i++) {
      const w = 3 + rand() * 5
      const geo = new THREE.PlaneGeometry(w, 46)
      geo.translate(0, 23, 0)
      const mesh = new THREE.Mesh(geo, material)
      mesh.frustumCulled = false
      mesh.renderOrder = 4
      const a = rand() * Math.PI * 2
      const r = 6 + rand() * 40
      mesh.userData.base = new THREE.Vector3(Math.cos(a) * r, -2, Math.sin(a) * r)
      mesh.userData.drift = rand() * 6.3
      mesh.userData.rate = 0.05 + rand() * 0.05
      this.group.add(mesh)
      this.shafts.push(mesh)
    }
    this._v = new THREE.Vector3()
  }

  /** `sunDir` leans the beams; `day` is how much sun there is to make them. */
  update(elapsed, camera, sunDir, day) {
    this.uniforms.uTime.value = elapsed
    this.uniforms.uStrength.value = day
    this.group.visible = day > 0.02
    if (!this.group.visible) return
    // Lean with the sun: the top of the beam sits toward where the light comes from.
    const lean = Math.atan2(Math.hypot(sunDir.x, sunDir.z), Math.max(0.2, sunDir.y)) * 0.5
    const yawToSun = Math.atan2(sunDir.x, sunDir.z)
    for (const mesh of this.shafts) {
      const { base, drift, rate } = mesh.userData
      mesh.position.set(base.x + Math.sin(elapsed * rate + drift) * 4, base.y, base.z + Math.cos(elapsed * rate * 0.8 + drift) * 4)
      // Face the camera about Y, then tip toward the sun.
      const dx = camera.position.x - mesh.position.x
      const dz = camera.position.z - mesh.position.z
      mesh.rotation.set(0, Math.atan2(dx, dz), 0)
      mesh.rotateOnWorldAxis(this._v.set(Math.cos(yawToSun), 0, -Math.sin(yawToSun)).normalize(), -lean)
    }
  }

  dispose() {
    for (const m of this.shafts) m.geometry.dispose()
    this.shafts[0]?.material.dispose()
    this.scene.remove(this.group)
  }
}

export { SAND_TONE }
