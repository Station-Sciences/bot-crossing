import * as THREE from 'three'
import { curveUniforms, withCurve } from '../core/curve.js'
import { fbm, mulberry } from './planet.js'

/**
 * The floating island — everything that lives *below and around* the rim.
 *
 * The terrain is still the terrain: on a `sky` world it simply falls out of sight past the
 * rim, and what this module supplies is the reason the colony does not look like a coaster
 * hanging in the air. Four things, four draw calls:
 *
 *   underside   one merged, vertex-coloured, flat-shaded lathe: a soil band tucked under the
 *               terrain's edge, a belly of stratified rock that bulges out past the rim and
 *               then draws in to a point, with moss streaking down it
 *   vines       one InstancedMesh of tapered strands rooted in the rock, swaying from a fixed
 *               anchor in the vertex shader, some with a tuft of leaves at the tip
 *   cloud sea   one big plane a long way below, drifting fbm cover with a lit side and a
 *               shaded trough, fading out before its own edge so it never shows a border
 *   puffs       a couple of dozen billboarded sprites in a wide ring around the island,
 *               drifting sideways and bobbing, one InstancedMesh with its matrices rewritten
 *               each frame — which for twenty-four of them is cheaper than a shader would be
 *
 * The belly is shaped around the terrain's own shelf rather than drawn freehand: the ground
 * past the rim drops on a smoothstep, which is a square-root-shaped wall near the top, so
 * the rock flares outward on the same curve with a couple of metres to spare, and anything
 * the shelf does below that is hidden inside the cloud sea's solid core. Nothing here reads
 * the terrain except through `heightAt`, so the underside follows the rim's rise and fall
 * whatever the world's roughness.
 *
 * Every material bends with the world curve: the two built on MeshStandardMaterial go
 * through three's patched `project_vertex` (and call `withCurve` because they install
 * their own `onBeforeCompile`); the two raw ShaderMaterials project by hand, so they carry
 * `curveUniforms` and call `bcBend` on their world position themselves.
 */

/** What a quality tier gets. `rings` is [above the belly, below it]. */
const QUALITY = {
  low: { segments: 36, rings: [7, 4], vines: 140, puffs: 16, sea: 16 },
  medium: { segments: 48, rings: [10, 6], vines: 260, puffs: 24, sea: 24 },
  high: { segments: 64, rings: [13, 8], vines: 400, puffs: 32, sea: 32 },
}

/** How far past the rim the rock lip sits, and how much further the belly bulges. */
const LIP = 2
const BELLY = 8
/** The lip is this far under the local rim height; the belly's widest point this far above the cloud sea. */
const LIP_DROP = 2
const BELLY_ABOVE_SEA = 50
/** The cloud sea is a 400-unit sheet — wider than the ground, so its fade hides the ground's corners. */
const SEA_SIZE = 400

// ── noise ─────────────────────────────────────────────────────────────────────────────

/**
 * The same value noise the terrain uses — a hashed lattice with smoothstep interpolation —
 * on its own seed. Every sample below is taken on a circle in noise space (cos, sin of the
 * angle round the island) rather than on the angle itself, so the seam at 0 and 2π never
 * shows: a circle has no ends.
 */
function makeNoise(seed) {
  const rand = mulberry(seed)
  const size = 256
  const table = new Float32Array(size * size)
  for (let i = 0; i < table.length; i++) table[i] = rand() * 2 - 1
  const at = (a, b) => table[(((a % size) + size) % size) * size + (((b % size) + size) % size)]
  return function noise(x, y) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    return (
      at(xi, yi) * (1 - u) * (1 - v) +
      at(xi + 1, yi) * u * (1 - v) +
      at(xi, yi + 1) * (1 - u) * v +
      at(xi + 1, yi + 1) * u * v
    )
  }
}

const smooth = THREE.MathUtils.smoothstep
const clamp = THREE.MathUtils.clamp

/** Replace a chunk include, and refuse to silently do nothing if three has renamed it. */
function splice(src, anchor, code) {
  if (!src.includes(anchor)) throw new Error(`skyisland: shader anchor ${anchor} not found`)
  return src.replace(anchor, code)
}

// ── the underside ─────────────────────────────────────────────────────────────────────

/**
 * The rock, as a lathe that has been left out in the weather.
 *
 * Rings run from a tuck ring just inside the rim (half a metre under the terrain, so the
 * join is never seen) out to the lip, flare down and out to the belly on a square-root
 * curve, then draw in to a jittered apex. Every ring vertex is pushed in and out by two
 * octaves of noise and by a sine-of-height ledge term — the ledges are what make it read as
 * strata rather than as a lumpy potato, and the same phase lightens the rock on each ledge
 * so the banding is in the colour as well as the silhouette. The whole thing is then
 * de-indexed and coloured per *face*, because the low-poly look wants facets, not gradients.
 */
function buildUnderside({ heightAt, rimRadius, depth, cloudLevel, segments, rings, noise, rand, palette }) {
  const [nUpper, nLower] = rings
  const S = segments
  const yBelly = cloudLevel + BELLY_ABOVE_SEA
  const yApex = -depth
  const rLip = rimRadius + LIP
  const rBelly = rimRadius + BELLY

  const ringCount = 1 + nUpper + (nLower - 1)
  const vertCount = ringCount * S + 1
  const positions = new Float32Array(vertCount * 3)
  const colors = new Float32Array(vertCount * 3)

  const rock = palette.rock
  const soil = palette.soil.clone().lerp(palette.groundLow, 0.35)
  const moss = palette.vine.clone().lerp(palette.groundLow, 0.3)
  const c = new THREE.Color()

  /** Displace, colour and store one ring vertex. `fade` is how much weather it gets. */
  function put(index, a, r, y, hRim, fade, isTuck) {
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const n1 = fbm(noise, ca * 2.6 + y * 0.07, sa * 2.6 + y * 0.13, 3)
    const n2 = fbm(noise, ca * 6 + 31 + y * 0.2, sa * 6 + 17 - y * 0.15, 2)
    // Ledges: a sine of height, bent by the big noise so they wander rather than ring the
    // rock like a barber's pole. Raised to a power so they are shelves, not ripples.
    const strata = Math.sin(y * 0.8 + n1 * 3)
    const ledge = Math.pow(Math.max(0, strata), 6)
    const rr = Math.max(0.5, r + (n1 * 2.4 + ledge * 1.8) * fade)
    const yy = y + n2 * 0.6 * fade

    positions[index * 3] = ca * rr
    positions[index * 3 + 1] = yy
    positions[index * 3 + 2] = sa * rr

    // Colour: rock with its strata, the soil band across the top wobbling with the noise,
    // darker the deeper it goes, and moss streaks — stretched along y — on the upper half.
    const depthFrac = clamp((hRim - yy) / (hRim + depth), 0, 1)
    if (isTuck) {
      c.copy(soil)
    } else {
      c.copy(rock).multiplyScalar(0.92 + (0.5 + 0.5 * strata) * 0.16 + n2 * 0.1)
      const soilMix = 1 - smooth(depthFrac, 0.06 + n1 * 0.05, 0.17 + n1 * 0.05)
      c.lerp(soil, soilMix)
      c.multiplyScalar(1 - depthFrac * 0.45)
      const mossN = fbm(noise, ca * 7 + 50, sa * 7 + yy * 0.09 + 50, 2)
      const mossAmt = smooth(mossN, 0.12, 0.4) * (1 - smooth(depthFrac, 0.3, 0.7)) * 0.75
      c.lerp(moss, mossAmt)
    }
    colors[index * 3] = c.r
    colors[index * 3 + 1] = c.g
    colors[index * 3 + 2] = c.b
  }

  for (let k = 0; k < S; k++) {
    const a = (k / S) * Math.PI * 2
    const hRim = heightAt(Math.cos(a) * rimRadius, Math.sin(a) * rimRadius)
    const yLip = hRim - LIP_DROP

    // The tuck ring: just inside the rim, just under the ground. No weather here — it has
    // to stay under the terrain, and the lip has to meet it cleanly.
    const rTuck = rimRadius - 1.5
    put(k, a, rTuck, heightAt(Math.cos(a) * rTuck, Math.sin(a) * rTuck) - 0.5, hRim, 0, true)

    // Lip to belly: the flare. The terrain's shelf is a smoothstep, which is √-shaped where
    // it leaves the rim, so the rock flares on a power just under a half and stays outside
    // it all the way down — with the noise budgeted to fit inside the margin.
    for (let i = 0; i < nUpper; i++) {
      const u = i / (nUpper - 1)
      const y = yLip + (yBelly - yLip) * u
      const r = rLip + (rBelly - rLip) * Math.pow(u, 0.55)
      put((1 + i) * S + k, a, r, y, hRim, smooth(u, 0, 0.22))
    }
    // Belly to apex: draws in on a convex curve to a rounded point. Most of this sits in
    // the cloud sea; the part that shows is the roll-under just beneath the belly.
    for (let j = 1; j < nLower; j++) {
      const v = j / nLower
      const y = yBelly + (yApex - yBelly) * v
      const r = rBelly * Math.pow(1 - v * v, 0.7)
      put((1 + nUpper + j - 1) * S + k, a, r, y, hRim, 1 - v)
    }
  }
  // The apex, jittered off-centre so the point is not dead under the middle of the colony.
  const apex = ringCount * S
  positions[apex * 3] = (rand() - 0.5) * 2
  positions[apex * 3 + 1] = yApex
  positions[apex * 3 + 2] = (rand() - 0.5) * 2
  c.copy(rock).multiplyScalar(0.5)
  colors[apex * 3] = c.r
  colors[apex * 3 + 1] = c.g
  colors[apex * 3 + 2] = c.b

  // Faces between consecutive rings, then a fan to the apex. Winding is settled per face
  // against the direction the surface ought to face — outward everywhere, and downward
  // below the belly — which is easier to get right than reasoning about it once.
  const index = []
  const pa = new THREE.Vector3()
  const pb = new THREE.Vector3()
  const pc = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const want = new THREE.Vector3()
  const tri = (i0, i1, i2) => {
    pa.fromArray(positions, i0 * 3)
    pb.fromArray(positions, i1 * 3)
    pc.fromArray(positions, i2 * 3)
    ab.subVectors(pb, pa)
    ac.subVectors(pc, pa)
    ab.cross(ac)
    want.set(pa.x + pb.x + pc.x, 0, pa.z + pb.z + pc.z)
    if (want.lengthSq() > 0.01) want.normalize()
    const my = (pa.y + pb.y + pc.y) / 3
    if (my < yBelly) want.y = -1
    if (ab.dot(want) < 0) index.push(i0, i2, i1)
    else index.push(i0, i1, i2)
  }
  for (let q = 0; q < ringCount - 1; q++) {
    for (let k = 0; k < S; k++) {
      const k1 = (k + 1) % S
      const i0 = q * S + k
      const i1 = q * S + k1
      const i2 = (q + 1) * S + k
      const i3 = (q + 1) * S + k1
      tri(i0, i1, i2)
      tri(i1, i3, i2)
    }
  }
  for (let k = 0; k < S; k++) {
    tri((ringCount - 1) * S + k, (ringCount - 1) * S + ((k + 1) % S), apex)
  }

  const indexed = new THREE.BufferGeometry()
  indexed.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  indexed.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  indexed.setIndex(index)

  // De-index for facets: one colour per face, with a little jitter so neighbouring facets
  // catch the light differently even where the underlying colour is the same.
  const geo = indexed.toNonIndexed()
  indexed.dispose()
  const col = geo.attributes.color
  for (let f = 0; f < col.count; f += 3) {
    const jitter = 1 + (rand() - 0.5) * 0.14
    for (let ch = 0; ch < 3; ch++) {
      const avg = (col.getComponent(f, ch) + col.getComponent(f + 1, ch) + col.getComponent(f + 2, ch)) / 3
      const v = clamp(avg * jitter, 0, 1)
      col.setComponent(f, ch, v)
      col.setComponent(f + 1, ch, v)
      col.setComponent(f + 2, ch, v)
    }
  }
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

// ── roots and vines ───────────────────────────────────────────────────────────────────

/** Segments along a strand, and where the leaf tuft's three leaves attach. */
const STRAND_SEGMENTS = 5
const LEAF_AT = [0.72, 0.84, 0.96]

/**
 * One strand, unit length, hanging down -y from the origin with a gentle S in z: a strip
 * `STRAND_SEGMENTS` long that tapers from about 9cm to nearly nothing, plus three diamond
 * leaves near the tip. `aT` is how far down the strand a vertex is — the sway and the
 * per-instance length both key off it — and `aLeaf` marks the leaves, which the shader
 * collapses to the anchor on any instance that was not dealt a tuft, so one geometry and
 * one draw serve both bare roots and leafy vines.
 */
function buildStrand() {
  const positions = []
  const aT = []
  const aLeaf = []
  const index = []
  const bend = (t) => 0.16 * Math.sin(t * 2.6)

  for (let i = 0; i <= STRAND_SEGMENTS; i++) {
    const t = i / STRAND_SEGMENTS
    // Fat enough to read from the far side of the island; a hair-thin strand at sixty metres is nothing.
    const w = (0.22 * (1 - 0.7 * t) + 0.03) / 2
    positions.push(-w, -t, bend(t), w, -t, bend(t))
    aT.push(t, t)
    aLeaf.push(0, 0)
    if (i < STRAND_SEGMENTS) {
      const l = i * 2
      index.push(l, l + 1, l + 2, l + 1, l + 3, l + 2)
    }
  }

  for (let k = 0; k < LEAF_AT.length; k++) {
    const t = LEAF_AT[k]
    const psi = k * 2.1 + 0.4
    // Leaf direction: out from the strand and a little down; width across it.
    const dx = Math.cos(psi) * 0.36
    const dz = Math.sin(psi) * 0.36 + bend(t)
    const dy = -0.14
    const wx = -Math.sin(psi) * 0.11
    const wz = Math.cos(psi) * 0.11
    const base = positions.length / 3
    positions.push(0, -t, bend(t)) // stem
    positions.push(dx * 0.5 + wx, -t + dy * 0.5, dz * 0.5 + wz) // one edge
    positions.push(dx, -t + dy, dz) // tip
    positions.push(dx * 0.5 - wx, -t + dy * 0.5, dz * 0.5 - wz) // other edge
    aT.push(t, t, t, t)
    aLeaf.push(1, 1, 1, 1)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1))
  geo.setAttribute('aLeaf', new THREE.Float32BufferAttribute(aLeaf, 1))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

const VINE_VERT_PARS = /* glsl */ `
#include <common>
attribute float aT;
attribute float aLeaf;
attribute float aPhase;
attribute vec3 aShape; // length, thickness, has a leaf tuft
uniform float uTime;
varying float vT;
varying float vLeaf;`

const VINE_VERT_MOVE = /* glsl */ `
#include <begin_vertex>
vT = aT;
vLeaf = aLeaf;
// A tuft this instance was not dealt collapses to its anchor and draws nothing.
if ( aLeaf > 0.5 && aShape.z < 0.5 ) transformed = vec3( 0.0 );
// Length and thickness are per instance but not part of the instance matrix, so the leaves
// and the strand's width keep their real size on a long vine and a short one alike.
transformed.y -= aT * ( aShape.x - 1.0 );
transformed.x *= mix( aShape.y, 1.0, aLeaf );
// Sway grows with the square of the distance down the strand: the root stays put, the tip
// wanders. Scaled a little by length, or a stub of a root would thrash like a long one.
float sway = aT * aT * min( 1.0, aShape.x * 0.18 );
transformed.x += sin( uTime * 0.8 + aPhase ) * sway * 0.35;
transformed.z += cos( uTime * 0.55 + aPhase * 1.7 ) * sway * 0.16;`

const VINE_FRAG_PARS = /* glsl */ `
#include <common>
uniform vec3 uLeaf;
varying float vT;
varying float vLeaf;`

const VINE_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
// Darker where it leaves the rock, its own colour by the tip; leaves in the leaf colour.
diffuseColor.rgb *= 0.78 + 0.22 * vT;
diffuseColor.rgb = mix( diffuseColor.rgb, uLeaf, vLeaf * 0.85 );`

/**
 * The sway, installed on a material. Used for the surface and, with the same uniform
 * objects, for the shadow pass's depth material — a vine that sways has to sway in its
 * shadow too. The depth shader has no colour stage, so only the surface gets the tint.
 */
function decorateVine(material, uniforms, key, surface) {
  material.customProgramCacheKey = () => key
  material.onBeforeCompile = (shader) => {
    withCurve(shader)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = splice(splice(shader.vertexShader, '#include <common>', VINE_VERT_PARS), '#include <begin_vertex>', VINE_VERT_MOVE)
    if (surface) {
      shader.fragmentShader = splice(splice(shader.fragmentShader, '#include <common>', VINE_FRAG_PARS), '#include <color_fragment>', VINE_FRAG_COLOR)
    }
  }
  return material
}

/**
 * Plant the strands. Two crops: roots that break out of the lip and lean outward before they
 * hang (or they would hang straight into the belly, which bulges out beneath them), and
 * vines from the underside proper, hanging from the belly's widest band and below, whose
 * tips trail into the cloud. Rooted a little inside the rock so none floats off its face.
 */
function plantVines({ mesh, count, rimRadius, cloudLevel, heightAt, rand, palette }) {
  const yBelly = cloudLevel + BELLY_ABOVE_SEA
  const rLip = rimRadius + LIP
  const rBelly = rimRadius + BELLY
  const phase = new Float32Array(count)
  const shape = new Float32Array(count * 3)
  const color = new Float32Array(count * 3)

  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const qa = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)
  const X = new THREE.Vector3(1, 0, 0)
  const Y = new THREE.Vector3(0, 1, 0)
  const c = new THREE.Color()
  const rootColor = palette.soil.clone().lerp(palette.rock, 0.4)

  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const hRim = heightAt(Math.cos(a) * rimRadius, Math.sin(a) * rimRadius)
    const yLip = hRim - LIP_DROP
    const fromLip = rand() < 0.4
    // Where on the flare it is rooted, as the same `u` the lathe used, so it lands on the rock.
    const u = fromLip ? 0.02 + rand() * 0.13 : 0.55 + rand() * 0.45
    // A metre and a half in: the rock's own noise pulls its face in by up to that much.
    const r = rLip + (rBelly - rLip) * Math.pow(u, 0.55) - 1.5
    p.set(Math.cos(a) * r, yLip + (yBelly - yLip) * u, Math.sin(a) * r)

    // Bend direction (+z) out along the radius, leaning the hang outward by `tilt`, with a
    // spin about its own axis so the strips do not all face the same way.
    const tilt = fromLip ? 0.35 + rand() * 0.4 : rand() * 0.2
    q.setFromAxisAngle(Y, Math.PI / 2 - a)
    q.multiply(qa.setFromAxisAngle(X, -tilt))
    q.multiply(qa.setFromAxisAngle(Y, (rand() - 0.5) * 1.2))
    m.compose(p, q, one)
    mesh.setMatrixAt(i, m)

    phase[i] = rand() * Math.PI * 2
    // Long enough to read as something hanging, from the far side of the island.
    const length = 4 + Math.pow(rand(), 1.3) * 14
    shape[i * 3] = length
    shape[i * 3 + 1] = 0.7 + rand() * 0.8
    shape[i * 3 + 2] = !fromLip && rand() < 0.45 ? 1 : 0

    // Roots are soil-brown, vines the vine colour, both nudged per instance so no two match.
    if (fromLip || rand() < 0.25) c.copy(rootColor)
    else c.copy(palette.vine)
    c.offsetHSL((rand() - 0.5) * 0.04, (rand() - 0.5) * 0.15, (rand() - 0.5) * 0.14)
    color[i * 3] = c.r
    color[i * 3 + 1] = c.g
    color[i * 3 + 2] = c.b
  }

  mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1))
  mesh.geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 3))
  mesh.instanceColor = new THREE.InstancedBufferAttribute(color, 3)
  mesh.instanceMatrix.needsUpdate = true
}

// ── the cloud sea ─────────────────────────────────────────────────────────────────────

/** The dome's cloud noise, verbatim, so the sea and the sky share a visual language. */
const CLOUD_NOISE = /* glsl */ `
float cloudHash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float cloudNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( cloudHash( i ), cloudHash( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( cloudHash( i + vec2( 0.0, 1.0 ) ), cloudHash( i + vec2( 1.0, 1.0 ) ), f.x ),
    f.y );
}
float cloudFbm( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 5; i++ ) {
    s += cloudNoise( p ) * a;
    p = p * 2.03 + vec2( 17.0, 9.0 );
    a *= 0.5;
  }
  return s;
}`

const SEA_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  // The sea projects by hand, so it bends by hand: world position, bent, then the view.
  vec4 mvPosition = viewMatrix * vec4( bcBend( world.xyz ), 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`

const SEA_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uShade;
uniform float uLight;
uniform float uCore;   // radius inside which the sea is solid, in world units
uniform float uFade;   // radius the sea has fully faded out at
varying vec2 vUv;
varying vec3 vWorld;
${CLOUD_NOISE}
void main() {
  // Two sheets of noise sliding different ways: a broad slow swell and a finer, quicker
  // grain over it, so the cover churns rather than scrolling past as one sheet.
  vec2 p1 = vWorld.xz * 0.016 + uTime * vec2( 0.010, 0.004 );
  vec2 p2 = vWorld.xz * 0.045 - uTime * vec2( 0.006, 0.009 );
  float n = cloudFbm( p1 ) * 0.7 + cloudFbm( p2 ) * 0.3;
  float cover = smoothstep( 0.36, 0.64, n );
  // Lit from one side: the noise sampled a step toward the light, differenced against
  // itself, is a cheap slope — bright on the face toward the sun, shaded in the troughs.
  float lit = clamp( ( cloudFbm( p1 + vec2( 0.06, 0.05 ) ) - cloudFbm( p1 ) ) * 6.0 + 0.62, 0.0, 1.0 );
  vec3 col = mix( uShade, uColor, lit ) * mix( 0.86, 1.0, cover ) * uLight;
  // Solid over the island, thinning toward open air — and gone well before the edge.
  float d = length( vWorld.xz );
  float open = smoothstep( uCore, uFade, d );
  float thin = smoothstep( 0.6, 0.8, cloudFbm( vWorld.xz * 0.006 + uTime * 0.002 ) );
  float alpha = mix( 0.82, 1.0, cover );
  alpha *= 1.0 - open * thin * 0.75;
  alpha *= 1.0 - smoothstep( 0.55, 0.98, length( vUv - 0.5 ) * 2.0 );
  gl_FragColor = vec4( col, alpha );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

// ── the puffs ─────────────────────────────────────────────────────────────────────────

/**
 * The sprite: a handful of soft discs overlapping into one lumpy cumulus, white with the
 * shape in the alpha. Computed straight into a DataTexture rather than drawn on a canvas,
 * so it is the same on every platform and needs no DOM to exist — the smoke test builds
 * the island in Node.
 */
function buildPuffTexture() {
  const w = 256
  const h = 128
  const data = new Uint8Array(w * h * 4)
  // (x, y, radius) in texture units, y up. Heaped toward the top, flat along the bottom.
  const lumps = [
    [0.5, 0.5, 0.4],
    [0.3, 0.46, 0.3],
    [0.7, 0.48, 0.31],
    [0.42, 0.66, 0.25],
    [0.62, 0.62, 0.22],
  ]
  for (let y = 0; y < h; y++) {
    const py = (y + 0.5) / h
    for (let x = 0; x < w; x++) {
      const px = (x + 0.5) / w
      let miss = 1
      for (const [lx, ly, lr] of lumps) {
        const d = Math.hypot((px - lx) * 2, (py - ly) * 1.9) / (lr * 2)
        const a = Math.pow(Math.max(0, 1 - d), 1.7)
        miss *= 1 - a
      }
      let alpha = 1 - miss
      // Flat-bottomed, and guaranteed to reach zero before the quad's edge.
      alpha *= smooth(py, 0.04, 0.3)
      alpha *= 1 - smooth(Math.hypot((px - 0.5) * 2, (py - 0.5) * 2.2), 0.72, 1)
      const i = (y * w + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = Math.round(clamp(alpha, 0, 1) * 255)
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

const PUFF_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aSpin;
varying vec2 vUv;
varying float vNear;
void main() {
  vUv = uv;
  // The instance matrix carries where the puff is and how big it is, and nothing else. The
  // anchor is bent like the ground under it; the quad is then built flat in view space,
  // turned a little per instance so the same sprite reads as several.
  mat4 im = modelMatrix * instanceMatrix;
  vec3 anchor = im[ 3 ].xyz;
  float size = length( im[ 0 ].xyz );
  vec4 mvPosition = viewMatrix * vec4( bcBend( anchor ), 1.0 );
  float c = cos( aSpin );
  float s = sin( aSpin );
  mvPosition.xy += vec2( position.x * c - position.y * s, position.x * s + position.y * c ) * size;
  // A puff the camera flies through fades out rather than clipping into a hard edge.
  vNear = smoothstep( 6.0, 16.0, -mvPosition.z );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`

const PUFF_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uMap;
uniform vec3 uColor;
uniform vec3 uShade;
uniform float uLight;
uniform float uOpacity;
varying vec2 vUv;
varying float vNear;
void main() {
  float a = texture2D( uMap, vUv ).a;
  // Lit from above: the crown in the cloud colour, the flat underside in the shade.
  float lit = smoothstep( 0.12, 0.8, vUv.y );
  vec3 col = mix( uShade, uColor, lit ) * uLight;
  gl_FragColor = vec4( col, a * vNear * uOpacity );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

// ── the island ────────────────────────────────────────────────────────────────────────

/**
 * Build the island's underside and everything in the air around it.
 *
 * `heightAt(x, z)` is the terrain sampler; `rimRadius` is where the terrain starts to
 * fall away. `planet.skyIsland` may carry `rock`, `soil`, `vine` and `cloud` colours,
 * `cloudLevel` (the sea's height) and `depth` (how far below zero the apex reaches); each
 * has a default, and the rock defaults to the planet's own rock colour.
 *
 * Returns `{ group, update, dispose }`, plus the meshes and uniform bags for anything that
 * wants to drive them — `setDaylight(day)` dims the clouds after dark.
 */
export function createSkyIsland({ planet, heightAt, rimRadius = 58, seed = 4321, quality = 'medium' }) {
  const tier = QUALITY[quality] || QUALITY.medium
  const cfg = planet.skyIsland || {}
  const cloudLevel = cfg.cloudLevel ?? -28
  const depth = cfg.depth ?? 42
  const palette = {
    rock: new THREE.Color(cfg.rock ?? planet.rock ?? 0x6b5c50),
    soil: new THREE.Color(cfg.soil ?? 0x5a4632),
    vine: new THREE.Color(cfg.vine ?? 0x4f7a3a),
    cloud: new THREE.Color(cfg.cloud ?? planet.clouds?.color ?? 0xffffff),
    groundLow: new THREE.Color(planet.ground?.low ?? 0x4a4a52),
  }
  // Troughs and undersides: the cloud colour, dimmed and pulled a little toward sky-blue.
  const shade = palette.cloud.clone().multiplyScalar(0.78).lerp(new THREE.Color(0x8fa3c0), 0.25)

  const group = new THREE.Group()
  group.name = 'sky-island'

  // ── underside
  const undersideGeo = buildUnderside({
    heightAt,
    rimRadius,
    depth,
    cloudLevel,
    segments: tier.segments,
    rings: tier.rings,
    noise: makeNoise(seed),
    rand: mulberry(seed ^ 0x5a17),
    palette,
  })
  const undersideMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    envMapIntensity: 0.3,
  })
  const underside = new THREE.Mesh(undersideGeo, undersideMat)
  underside.name = 'sky-island-underside'
  underside.castShadow = true
  underside.receiveShadow = true
  group.add(underside)

  // ── vines
  const vineUniforms = {
    uTime: { value: 0 },
    uLeaf: { value: palette.vine.clone().offsetHSL(0.02, 0.1, 0.12) },
  }
  const vineMat = decorateVine(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
    vineUniforms,
    'bc-skyisland-vine',
    true
  )
  const vineDepth = decorateVine(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide }),
    vineUniforms,
    'bc-skyisland-vine:depth',
    false
  )
  const vines = new THREE.InstancedMesh(buildStrand(), vineMat, tier.vines)
  vines.name = 'sky-island-vines'
  vines.customDepthMaterial = vineDepth
  vines.castShadow = quality !== 'low'
  vines.receiveShadow = true
  // Strung right round the rim, so the bounding sphere would be the island anyway.
  vines.frustumCulled = false
  plantVines({ mesh: vines, count: tier.vines, rimRadius, cloudLevel, heightAt, rand: mulberry(seed ^ 0x71ce), palette })
  group.add(vines)

  // ── cloud sea
  const seaUniforms = {
    ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    ...curveUniforms,
    uTime: { value: 0 },
    uColor: { value: palette.cloud.clone() },
    uShade: { value: shade.clone() },
    uLight: { value: 1 },
    uCore: { value: rimRadius + 28 },
    uFade: { value: rimRadius + 110 },
  }
  const seaMat = new THREE.ShaderMaterial({
    uniforms: seaUniforms,
    vertexShader: SEA_VERT,
    fragmentShader: SEA_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
  })
  // Segmented, because the world curve is applied per vertex and a four-vertex sheet
  // cannot bow.
  const seaGeo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, tier.sea, tier.sea)
  seaGeo.rotateX(-Math.PI / 2)
  const sea = new THREE.Mesh(seaGeo, seaMat)
  sea.name = 'sky-island-cloud-sea'
  sea.position.y = cloudLevel
  // Before every other transparent thing: it is the floor of the scene, and three's
  // distance sort would otherwise let a puff or the water draw first and be painted over.
  sea.renderOrder = -20
  sea.frustumCulled = false
  group.add(sea)

  // ── puffs
  const puffTexture = buildPuffTexture()
  const puffUniforms = {
    ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    ...curveUniforms,
    uMap: { value: puffTexture },
    uColor: { value: palette.cloud.clone() },
    uShade: { value: shade.clone() },
    uLight: { value: 1 },
    uOpacity: { value: 0.92 },
  }
  const puffMat = new THREE.ShaderMaterial({
    uniforms: puffUniforms,
    vertexShader: PUFF_VERT,
    fragmentShader: PUFF_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  })
  const puffCount = tier.puffs
  const puffs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 0.5), puffMat, puffCount)
  puffs.name = 'sky-island-puffs'
  puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  puffs.renderOrder = -15
  puffs.frustumCulled = false

  // Flat arrays, laid out once: where each puff orbits, how high, how big, how fast.
  const puffAngle = new Float32Array(puffCount)
  const puffRadius = new Float32Array(puffCount)
  const puffHeight = new Float32Array(puffCount)
  const puffSize = new Float32Array(puffCount)
  const puffRate = new Float32Array(puffCount)
  const puffPhase = new Float32Array(puffCount)
  const puffSpin = new Float32Array(puffCount)
  {
    const rand = mulberry(seed ^ 0xc10d)
    const top = -4
    const bottom = cloudLevel + 4
    for (let i = 0; i < puffCount; i++) {
      puffAngle[i] = rand() * Math.PI * 2
      // Spread out past the rim, with the bigger ones further off and lower down.
      const far = rand()
      puffRadius[i] = rimRadius + 12 + far * 70
      puffHeight[i] = bottom + (top - bottom) * Math.pow(rand(), 0.8)
      puffSize[i] = 6 + rand() * 4 + far * 8
      puffRate[i] = (0.003 + rand() * 0.005) * (rand() < 0.5 ? 1 : -1)
      puffPhase[i] = rand() * Math.PI * 2
      puffSpin[i] = (rand() - 0.5) * 0.5
    }
    puffs.geometry.setAttribute('aSpin', new THREE.InstancedBufferAttribute(puffSpin, 1))
  }
  const puffMatrix = new THREE.Matrix4()
  const placePuffs = (elapsed) => {
    const e = puffMatrix.elements
    for (let i = 0; i < puffCount; i++) {
      const a = puffAngle[i]
      const r = puffRadius[i] + Math.sin(elapsed * 0.11 + puffPhase[i] * 1.3) * 1.5
      const size = puffSize[i]
      puffMatrix.makeTranslation(Math.cos(a) * r, puffHeight[i] + Math.sin(elapsed * 0.25 + puffPhase[i]) * 0.8, Math.sin(a) * r)
      e[0] = size
      e[5] = size
      puffs.setMatrixAt(i, puffMatrix)
    }
    puffs.instanceMatrix.needsUpdate = true
  }
  placePuffs(0)
  group.add(puffs)

  return {
    group,
    meshes: { underside, vines, sea, puffs },
    uniforms: { vines: vineUniforms, sea: seaUniforms, puffs: puffUniforms },

    /** Dim the clouds with the sky: 1 at noon, toward 0 at night. */
    setDaylight(day) {
      const light = 0.18 + 0.82 * clamp(day, 0, 1)
      seaUniforms.uLight.value = light
      puffUniforms.uLight.value = light
    },

    /** Once a frame. The camera is unused for now; the puffs billboard on the GPU. */
    update(dt, elapsed) {
      vineUniforms.uTime.value = elapsed
      seaUniforms.uTime.value = elapsed
      for (let i = 0; i < puffCount; i++) puffAngle[i] += puffRate[i] * dt
      placePuffs(elapsed)
    },

    dispose() {
      group.parent?.remove(group)
      undersideGeo.dispose()
      undersideMat.dispose()
      vines.geometry.dispose()
      vineMat.dispose()
      vineDepth.dispose()
      vines.dispose()
      seaGeo.dispose()
      seaMat.dispose()
      puffs.geometry.dispose()
      puffMat.dispose()
      puffs.dispose()
      puffTexture.dispose()
    },
  }
}
