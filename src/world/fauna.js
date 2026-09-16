import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { withCurve } from '../core/curve.js'
import { mulberry } from './planet.js'
import { stepParcel } from './parcel-physics.js'

/**
 * The life layer: birds wheeling over the colony, butterflies in the scatter, fish leaping
 * out of the water, and the colony's own cargo drones ferrying crates from the lander to
 * whoever is building.
 *
 * None of it matters and all of it is what makes the place feel inhabited rather than
 * rendered — it is the secondary animation, the thing your eye catches at the edge of the
 * frame while you are looking at an astronaut.
 *
 * The rules are the colony's usual ones. Every crowd is **one `InstancedMesh`** — a flock of
 * thirty gulls is one draw, and so is a meadow of sixty butterflies — and the CPU only ever
 * decides *where* a creature is. Everything that moves *on* a creature moves in the vertex
 * shader: a wing flaps, a tail wags, a rotor spins, a crate is hidden, all from a single
 * `uTime` write a frame. A vertex carries what it is (`aWing`, `aSpin`, `aCrate`…) and the
 * point it turns about (`aPivot`), exactly the way the turbine rotors in `buildings.js` do,
 * and an instance carries a phase so no two of anything beat in step.
 *
 * Positions are simulated in flat arrays of plain objects allocated once per planet; the
 * per-frame path allocates nothing.
 */

// ── shared uniforms ───────────────────────────────────────────────────────────────────

/**
 * Shared by every fauna material, surface pass and shadow pass alike. One `uTime` write a
 * frame turns every wing, tail and rotor in the colony.
 */
export const faunaUniforms = {
  uTime: { value: 0 },
  /** 1 normally, 0.5 under reduced motion — scales every flap rate in the shader. */
  uMotion: { value: 1 },
}

/** How the `fauna` setting scales every crowd. Off is off; the rest is how many. */
const TIER = { off: 0, low: 0.6, full: 1 }

/** Deck top — the lowest thing a drone should ever count as "the ground" over the colony. */
const DECK = 0.45

// ── the shader ────────────────────────────────────────────────────────────────────────

/**
 * One shader for all four crowds, specialised by `defines` rather than by separate source,
 * which is what lets one `onBeforeCompile` serve every material here. Three folds a
 * material's defines into its program cache key, so a gull's program and a butterfly's
 * never get confused for each other despite sharing this function.
 *
 * Per vertex: `aWing` is 0 for the body, ±1 for a wing (the sign is which side, and it also
 * signs the flap so both wings rise together); `aSpin` marks a rotor and `aPivot` is the
 * hub it turns about — or, for a wing, the hinge line, or for a crate, the point it
 * collapses to when the drone is flying empty. `aAccent` picks a fixed colour (beak, arms,
 * crate) over the instance colour, and `aEmissive` marks the LED.
 *
 * Per instance: `aPhase` de-syncs everything; drones also carry `aCarry` (crate shown or
 * not) and `aRotor` (rotor angle, integrated on the CPU — an angle rather than a rate,
 * because `uTime * rate * throttle` would leap by hundreds of radians the moment the
 * throttle changed, and a drone spooling up would strobe).
 */
const VERT_PARS = /* glsl */ `
#include <common>
// bc:fauna-vert
// Four per-vertex flags share one slot: a drone carries position, normal, its instance
// matrix (four slots), its colour and five of its own, and the WebGL limit on a Mac is
// sixteen — one attribute per float is the difference between a drone and a link error.
attribute vec4 aPart; // wing, spin, emissive, crate
#define aWing aPart.x
#define aSpin aPart.y
#define aEmissive aPart.z
#define aCrate aPart.w
attribute vec3 aPivot;
attribute float aAccent;
attribute float aPhase;
#ifdef BC_DRONE
attribute float aCarry;
attribute float aRotor;
#endif
varying float vEmissive;
varying float vAccent;
varying float vPhase;
uniform float uTime;
uniform float uMotion;

vec3 bcSpinY( vec3 p, vec3 hub, float a ) {
  vec3 r = p - hub;
  float s = sin( a );
  float c = cos( a );
  return hub + vec3( r.x * c + r.z * s, r.y, -r.x * s + r.z * c );
}
vec3 bcSpinZ( vec3 p, vec3 hub, float a ) {
  vec3 r = p - hub;
  float s = sin( a );
  float c = cos( a );
  return hub + vec3( r.x * c - r.y * s, r.x * s + r.y * c, r.z );
}
// A wing hinges on the body's long axis (Z) — that is what lifts a tip up and down. A tail
// fin swings about the vertical (Y).
#if BC_WING_AXIS == 1
#define bcWingSpin bcSpinY
#else
#define bcWingSpin bcSpinZ
#endif

float bcFlap() {
  float t = uTime * uMotion;
  float amp = BC_FLAP_AMP;
  #ifdef BC_GLIDE
  // Flap in bursts and glide between them: a slow second sine, offset per instance, gates
  // the amplitude. Below its threshold the wings simply hold.
  amp *= smoothstep( -0.15, 0.45, sin( t * 0.4 + aPhase * 2.3 ) );
  #endif
  return sin( t * BC_FLAP_RATE + aPhase ) * amp;
}
`

const VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
if ( aWing != 0.0 ) objectNormal = bcWingSpin( objectNormal, vec3( 0.0 ), bcFlap() * aWing );
#ifdef BC_DRONE
if ( aSpin != 0.0 ) objectNormal = bcSpinY( objectNormal, vec3( 0.0 ), aRotor * aSpin );
#endif
`

const VERT_MOVE = /* glsl */ `
#include <begin_vertex>
vEmissive = aEmissive;
vAccent = aAccent;
vPhase = aPhase;
if ( aWing != 0.0 ) transformed = bcWingSpin( transformed, aPivot, bcFlap() * aWing );
#ifdef BC_DRONE
if ( aSpin != 0.0 ) transformed = bcSpinY( transformed, aPivot, aRotor * aSpin );
// An empty drone's crate and cable collapse to a point inside the hull rather than being
// culled — degenerate triangles cost nothing and keep the geometry one piece.
if ( aCrate > 0.5 ) transformed = mix( aPivot, transformed, aCarry );
#endif
`

const FRAG_PARS = /* glsl */ `
#include <common>
// bc:fauna-frag
varying float vEmissive;
varying float vAccent;
varying float vPhase;
uniform float uTime;
uniform vec3 uAccentA;
uniform vec3 uAccentB;
`

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
if ( vAccent > 1.5 ) diffuseColor.rgb = uAccentB;
else if ( vAccent > 0.5 ) diffuseColor.rgb = uAccentA;
`

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
#ifdef BC_DRONE
// A short strobe rather than a pulse, like an aircraft's, and well above 1.0 so bloom
// picks it out. Phase-offset so a parked row does not blink as one.
float bcBlink = step( 0.82, fract( uTime * 0.9 + vPhase * 0.16 ) );
totalEmissiveRadiance += vec3( 2.5, 0.2, 0.16 ) * vEmissive * ( 0.12 + 0.88 * bcBlink );
#endif
`

/**
 * Install the fauna shader on a material. Used for the surface material and, with the very
 * same defines and uniform objects, for the shadow pass's depth material — a wing that
 * flaps has to flap in its shadow too, or the shadow lags the wing.
 */
function decorate(material, defines, uniforms, key) {
  material.defines = { ...defines }
  material.customProgramCacheKey = () => key
  material.onBeforeCompile = (shader) => {
    withCurve(shader)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_PARS)
      .replace('#include <beginnormal_vertex>', VERT_NORMAL)
      .replace('#include <begin_vertex>', VERT_MOVE)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
  }
  return material
}

const glslFloat = (n) => Number(n).toFixed(4)

/**
 * A material pair for one crowd: the standard material and, if it casts shadows, the depth
 * material that goes with it. `rate` is in Hz; the shader wants radians per second.
 */
function crowdMaterials(o) {
  const uniforms = {
    uTime: faunaUniforms.uTime,
    uMotion: faunaUniforms.uMotion,
    uAccentA: { value: new THREE.Color(o.accentA ?? 0x000000) },
    uAccentB: { value: new THREE.Color(o.accentB ?? 0x000000) },
  }
  const defines = {
    BC_WING_AXIS: o.axis === 'y' ? 1 : 0,
    BC_FLAP_RATE: glslFloat((o.rate || 0) * Math.PI * 2),
    BC_FLAP_AMP: glslFloat(o.amp || 0),
  }
  if (o.glide) defines.BC_GLIDE = ''
  if (o.drone) defines.BC_DRONE = ''
  const key = `bc-fauna:${o.name}:${JSON.stringify(defines)}`

  const material = decorate(
    new THREE.MeshStandardMaterial({
      roughness: 0.7,
      metalness: 0,
      // Wings are single quads, so anything with wings has to draw both faces.
      side: o.side ?? THREE.DoubleSide,
    }),
    defines,
    uniforms,
    key
  )
  const depth = o.shadow
    ? decorate(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), defines, uniforms, `${key}:depth`)
    : null
  return { material, depth }
}

// ── geometry ──────────────────────────────────────────────────────────────────────────

const PART = ['aWing', 'aSpin', 'aEmissive', 'aCrate']

/**
 * Stamp a part with the per-vertex attributes the shader reads. Every part gets every
 * attribute, zero where it does not apply, because merging needs the sets to agree. The
 * four flags are packed into one vec4 — see the shader for why.
 */
function tag(geo, t = {}) {
  const n = geo.attributes.position.count
  const part = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) part[i * 4 + k] = t[PART[k]] || 0
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(part, 4))
  geo.setAttribute('aAccent', new THREE.BufferAttribute(new Float32Array(n).fill(t.aAccent || 0), 1))
  const pivot = new Float32Array(n * 3)
  if (t.pivot) {
    for (let i = 0; i < n; i++) {
      pivot[i * 3] = t.pivot[0]
      pivot[i * 3 + 1] = t.pivot[1]
      pivot[i * 3 + 2] = t.pivot[2]
    }
  }
  geo.setAttribute('aPivot', new THREE.BufferAttribute(pivot, 3))
  return geo
}

/**
 * Merging insists every part be indexed or none be, and the addons' rounded box is the
 * one primitive here that is not — so everything is flattened first. These meshes are a
 * few hundred vertices; the index was never buying anything.
 */
function merge(parts) {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p))
  const geo = BufferGeometryUtils.mergeGeometries(flat, false)
  for (const p of parts) p.dispose()
  for (const p of flat) if (!parts.includes(p)) p.dispose()
  return geo
}

/**
 * Uniform scale that takes `aPivot` along. `BufferGeometry.scale()` transforms position
 * and normal and nothing else — miss this and a wing hinges on a line left behind at the
 * unscaled width.
 */
function scaleTagged(geo, s) {
  if (s === 1) return geo
  geo.scale(s, s, s)
  const pivot = geo.getAttribute('aPivot')
  for (let i = 0; i < pivot.array.length; i++) pivot.array[i] *= s
  pivot.needsUpdate = true
  return geo
}

/**
 * A tapered wing quad, flat in XZ with its root on the body's long axis at x = 0 and its
 * tip `span` out to `side`. The tip chord is narrower and swept back, which is most of
 * what separates a gull's wing from a rectangle.
 */
function wingQuad(span, root, tip, sweep, side) {
  const geo = new THREE.BufferGeometry()
  const x = side * span
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, root / 2, 0, 0, -root / 2, x, 0, tip / 2 - sweep, x, 0, -tip / 2 - sweep],
      3
    )
  )
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 1, 1, 0], 2))
  geo.setIndex(side > 0 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2])
  return geo
}

/** Cone pointing along +Z rather than +Y, which is where a beak goes. */
function beakGeometry(r, len) {
  const geo = new THREE.ConeGeometry(r, len, 6)
  geo.rotateX(Math.PI / 2)
  return geo
}

/**
 * The bird species. Proportions are what tell them apart at a distance: a gull is long
 * narrow wings that mostly glide, a swallow is a scrap of a body on swept points, a parrot
 * is round with a long tail, a crow is a crow.
 *
 * `rate` is flaps per second, `speed` metres per second, `turn` how hard it steers.
 * `diurnal` birds do not call at night. `dip` is the gull's habit of skimming the water.
 */
const BIRDS = {
  gull: {
    span: 0.62, root: 0.13, tip: 0.035, sweep: 0.16, body: [0.55, 0.45, 1.5], tail: 0.08,
    rate: 2.6, amp: 0.5, glide: true, speed: 6.0, turn: 1.1, wander: 0.9, dip: true, diurnal: true,
    beak: 0xf0a030, colors: [0xf4f2ee, 0xe8e6e0, 0xd8d6cf],
  },
  parrot: {
    span: 0.46, root: 0.14, tip: 0.05, sweep: 0.1, body: [0.6, 0.5, 1.4], tail: 0.18,
    rate: 5.5, amp: 0.75, glide: false, speed: 5.5, turn: 1.6, wander: 1.4, dip: false, diurnal: true,
    beak: 0x3a3230, colors: [0xe84a3a, 0x3fb54a, 0x3a7fe0, 0xf0c030],
  },
  crow: {
    span: 0.52, root: 0.14, tip: 0.06, sweep: 0.1, body: [0.6, 0.5, 1.5], tail: 0.14,
    rate: 3.6, amp: 0.6, glide: false, speed: 5.5, turn: 1.4, wander: 1.1, dip: false, diurnal: false,
    beak: 0x1c1c22, colors: [0x1e1e26, 0x26262e, 0x2c2a34],
  },
  swallow: {
    span: 0.42, root: 0.1, tip: 0.025, sweep: 0.2, body: [0.5, 0.4, 1.2], tail: 0.16,
    rate: 6.5, amp: 0.65, glide: true, speed: 8.5, turn: 2.6, wander: 2.4, dip: false, diurnal: true,
    beak: 0x2a2a30, colors: [0x2a3c8a, 0x22336e, 0x3a4a9a],
  },
}

/** Body, head, beak, two wings and a tail — about 0.55 long and 1.45 across at size 1. */
function birdGeometry(k) {
  // A scrap of a body and two thin swept wings: at the distance the colony is looked at, a
  // bird is a crescent that flexes, and anything more than that reads as a model.
  const bodyLen = 0.11 * k.body[2]
  const body = new THREE.SphereGeometry(0.11, 8, 6)
  body.scale(k.body[0], k.body[1], k.body[2])
  const head = new THREE.SphereGeometry(0.06, 6, 5)
  head.translate(0, 0.04, bodyLen + 0.01)
  const beak = beakGeometry(0.02, 0.07)
  beak.translate(0, 0.035, bodyLen + 0.08)
  const right = wingQuad(k.span, k.root, k.tip, k.sweep, 1)
  right.translate(0.04, 0.02, 0.0)
  const left = wingQuad(k.span, k.root, k.tip, k.sweep, -1)
  left.translate(-0.04, 0.02, 0.0)
  const tail = new THREE.PlaneGeometry(0.16, k.tail)
  tail.rotateX(-Math.PI / 2)
  tail.translate(0, 0.02, -bodyLen - k.tail / 2 + 0.05)
  return merge([
    tag(body),
    tag(head),
    tag(beak, { aAccent: 1 }),
    tag(right, { aWing: 1, pivot: [0.1, 0.05, 0] }),
    tag(left, { aWing: -1, pivot: [-0.1, 0.05, 0] }),
    tag(tail),
  ])
}

/** A dark sliver of a body and two wings, 0.15 across. */
function butterflyGeometry() {
  const body = new THREE.SphereGeometry(0.018, 6, 4)
  body.scale(1, 1, 3.4)
  const right = wingQuad(0.065, 0.09, 0.055, 0.008, 1)
  right.translate(0.006, 0.004, 0)
  const left = wingQuad(0.065, 0.09, 0.055, 0.008, -1)
  left.translate(-0.006, 0.004, 0)
  return merge([
    tag(body, { aAccent: 1 }),
    tag(right, { aWing: 1, pivot: [0, 0.004, 0] }),
    tag(left, { aWing: -1, pivot: [0, 0.004, 0] }),
  ])
}

/** A plump body, a tail fin that wags and a dorsal fin, about 0.45 long. */
function fishGeometry() {
  const body = new THREE.SphereGeometry(0.1, 9, 7)
  body.scale(0.8, 1, 2.2)
  // The tail is a wing quad stood on its edge: span turned to point back along -Z, chord
  // turned upright.
  const tail = wingQuad(0.14, 0.06, 0.17, 0, 1)
  tail.rotateY(Math.PI / 2)
  tail.rotateZ(Math.PI / 2)
  tail.translate(0, 0, -0.2)
  const dorsal = wingQuad(0.07, 0.1, 0.03, 0.03, 1)
  dorsal.rotateZ(Math.PI / 2)
  dorsal.translate(0, 0.08, 0.02)
  return merge([
    tag(body),
    tag(tail, { aWing: 1, pivot: [0, 0, -0.18], aAccent: 1 }),
    tag(dorsal, { aAccent: 1 }),
  ])
}

/** Rotor rate multipliers: pairs counter-rotate, and none quite match, so they never lock. */
const ROTOR_SPIN = [1, -1.04, 1.08, -0.96]

/**
 * A quadcopter about half a metre across: rounded hull, canopy, four arms with a hub, a
 * hexagonal disc and two blades each, skids, a front LED, and a crate on a cable
 * underneath. The crate and cable are `aCrate` so the shader can fold them away.
 */
function droneGeometry() {
  const parts = []
  const hull = new RoundedBoxGeometry(0.5, 0.2, 0.5, 3, 0.07)
  parts.push(tag(hull))
  const canopy = new THREE.SphereGeometry(0.12, 8, 6)
  canopy.scale(1, 0.6, 1)
  canopy.translate(0, 0.1, 0.02)
  parts.push(tag(canopy, { aAccent: 1 }))

  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1
    const sz = i & 2 ? 1 : -1
    const arm = new THREE.BoxGeometry(0.42, 0.035, 0.05)
    // A box along X turned to point along (sx, sz).
    arm.rotateY(Math.atan2(-sz, sx))
    arm.translate(sx * 0.24, 0.06, sz * 0.24)
    parts.push(tag(arm, { aAccent: 1 }))

    const hx = sx * 0.36
    const hz = sz * 0.36
    const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8)
    hub.translate(hx, 0.09, hz)
    parts.push(tag(hub, { aAccent: 1 }))
    const spin = ROTOR_SPIN[i]
    const disc = new THREE.CylinderGeometry(0.15, 0.15, 0.008, 6)
    disc.translate(hx, 0.115, hz)
    parts.push(tag(disc, { aSpin: spin, pivot: [hx, 0.115, hz], aAccent: 2 }))
    const bladeA = new THREE.BoxGeometry(0.3, 0.01, 0.045)
    bladeA.translate(hx, 0.125, hz)
    parts.push(tag(bladeA, { aSpin: spin, pivot: [hx, 0.125, hz], aAccent: 1 }))
    const bladeB = new THREE.BoxGeometry(0.045, 0.01, 0.3)
    bladeB.translate(hx, 0.125, hz)
    parts.push(tag(bladeB, { aSpin: spin, pivot: [hx, 0.125, hz], aAccent: 1 }))
  }

  for (const sx of [-1, 1]) {
    const skid = new THREE.BoxGeometry(0.03, 0.12, 0.34)
    skid.translate(sx * 0.16, -0.15, 0)
    parts.push(tag(skid, { aAccent: 1 }))
  }

  const led = new THREE.SphereGeometry(0.028, 6, 4)
  led.translate(0, 0.02, 0.27)
  parts.push(tag(led, { aEmissive: 1 }))

  // The collapse point is inside the hull, so a folded crate is out of sight.
  const fold = [0, -0.05, 0]
  const cable = new THREE.BoxGeometry(0.012, 0.36, 0.012)
  cable.translate(0, -0.28, 0)
  parts.push(tag(cable, { aCrate: 1, pivot: fold, aAccent: 1 }))
  const crate = new THREE.BoxGeometry(0.3, 0.3, 0.3)
  crate.translate(0, -0.61, 0)
  parts.push(tag(crate, { aCrate: 1, pivot: fold, aAccent: 2 }))

  return merge(parts)
}

// ── shared scratch ────────────────────────────────────────────────────────────────────

const _dummy = new THREE.Object3D()
const _target = new THREE.Vector3()
const _sep = { x: 0, z: 0 }
const _color = new THREE.Color()
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

/** Build the instanced mesh every crowd shares the shape of. */
function crowdMesh(geo, mats, count, name, shadow) {
  const mesh = new THREE.InstancedMesh(geo, mats.material, count)
  mesh.name = name
  // Bounds are computed from the geometry, not from where the instances have flown to, so
  // culling would clip a flock the moment it left the origin.
  mesh.frustumCulled = false
  mesh.castShadow = shadow
  mesh.receiveShadow = false
  if (mats.depth) mesh.customDepthMaterial = mats.depth
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  return mesh
}

function phaseAttribute(geo, count, rand) {
  const phase = new Float32Array(count)
  for (let i = 0; i < count; i++) phase[i] = rand() * Math.PI * 2
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1))
}

function paint(mesh, count, colors, rand, jitter = 0.06) {
  for (let i = 0; i < count; i++) {
    _color.set(colors[i % colors.length])
    _color.offsetHSL((rand() - 0.5) * 0.02, (rand() - 0.5) * jitter, (rand() - 0.5) * jitter)
    mesh.setColorAt(i, _color)
  }
  mesh.instanceColor.needsUpdate = true
}

// ── birds ─────────────────────────────────────────────────────────────────────────────

/** The flock roams inside this radius of the colony's centre. */
const FLOCK_RANGE = 60

/**
 * A boids-lite flock. Cohesion toward the flock's centroid, alignment with its mean
 * heading, separation from anyone too close, and a pull toward a wandering target that
 * drifts around the colony — plus a soft spring to each bird's own preferred altitude, so
 * the band is a band and not a plane.
 */
class Flock {
  constructor(group, spec, env, seed, tier) {
    this.kind = BIRDS[spec.kind] || BIRDS.gull
    this.env = env
    this.rand = mulberry(seed)
    this.count = Math.max(0, Math.round(spec.count ?? 14))
    this.altitude = spec.altitude || [14, 22]
    this.size = spec.size ?? 1

    const geo = scaleTagged(birdGeometry(this.kind), this.size)
    phaseAttribute(geo, this.count, this.rand)
    this.mats = crowdMaterials({
      name: `bird-${spec.kind}`,
      rate: this.kind.rate,
      amp: this.kind.amp,
      glide: this.kind.glide,
      accentA: this.kind.beak,
      shadow: true,
    })
    this.mesh = crowdMesh(geo, this.mats, this.count, 'birds', true)
    paint(this.mesh, this.count, spec.colors?.length ? spec.colors : this.kind.colors, this.rand)
    group.add(this.mesh)

    this.tx = 0
    this.tz = 0
    this.groundY = 0
    this.retarget = 0
    this._pickTarget()

    const [lo, hi] = this.altitude
    this.birds = []
    this.info = []
    for (let i = 0; i < this.count; i++) {
      const a = this.rand() * Math.PI * 2
      const r = this.rand() * 14
      const alt = lo + this.rand() * (hi - lo)
      const heading = this.rand() * Math.PI * 2
      this.birds.push({
        x: this.tx + Math.cos(a) * r,
        y: this.groundY + alt,
        z: this.tz + Math.sin(a) * r,
        vx: Math.sin(heading) * this.kind.speed,
        vy: 0,
        vz: Math.cos(heading) * this.kind.speed,
        fx: Math.sin(heading) * this.kind.speed,
        fy: 0,
        fz: Math.cos(heading) * this.kind.speed,
        alt,
        heading,
        wander: this.rand() * Math.PI * 2,
        roll: 0,
        dip: 0,
        dipWait: 6 + this.rand() * 20,
        rippled: false,
      })
      this.info.push({ x: 0, y: 0, z: 0 })
    }
    this.callTimer = 4 + this.rand() * 8
    this.setTier(tier)
  }

  setTier(scale) {
    this.active = this.count ? Math.max(1, Math.round(this.count * scale)) : 0
    this.mesh.count = this.active
    this.info.length = this.active
    for (let i = 0; i < this.active; i++) if (!this.info[i]) this.info[i] = { x: 0, y: 0, z: 0 }
  }

  _pickTarget() {
    const a = this.rand() * Math.PI * 2
    const r = Math.sqrt(this.rand()) * FLOCK_RANGE
    this.tx = Math.cos(a) * r
    this.tz = Math.sin(a) * r
    // Altitude is above whatever is under the target — hills at the edge of the range are
    // nine metres tall, and a band measured from sea level would fly a low flock into one.
    const ground = this.env.heightAt(this.tx, this.tz)
    this.groundY = this.env.waterLevel != null ? Math.max(ground, this.env.waterLevel) : ground
    this.retarget = 25
  }

  update(dt, night, hooks, motion) {
    const n = this.active
    if (!n) return
    const b = this.birds
    const k = this.kind
    const env = this.env
    const water = env.waterLevel

    let cx = 0
    let cz = 0
    for (let i = 0; i < n; i++) {
      cx += b[i].x
      cz += b[i].z
    }
    cx /= n
    cz /= n
    this.retarget -= dt
    const tdx = this.tx - cx
    const tdz = this.tz - cz
    if (this.retarget <= 0 || tdx * tdx + tdz * tdz < 100) this._pickTarget()

    // Reynolds' three rules over a *local* neighbourhood, not the whole flock: a bird only
    // knows about the ones near it, which is what lets a flock stretch, split and re-form
    // instead of contracting into a ball around its centroid.
    const cruise = k.speed * motion
    const maxForce = k.speed * k.turn * motion
    const SEE = 9
    const SEE2 = SEE * SEE
    const NEAR2 = 2.4 * 2.4

    for (let i = 0; i < n; i++) {
      const p = b[i]
      let nx = 0, ny = 0, nz = 0, cnt = 0
      let ax = 0, ay = 0, az = 0
      let sx = 0, sy = 0, sz = 0
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const q = b[j]
        const dx = q.x - p.x
        const dy = q.y - p.y
        const dz = q.z - p.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > SEE2) continue
        nx += q.x; ny += q.y; nz += q.z
        ax += q.vx; ay += q.vy; az += q.vz
        cnt++
        if (d2 < NEAR2 && d2 > 1e-4) {
          const f = 1 / d2
          sx -= dx * f; sy -= dy * f; sz -= dz * f
        }
      }
      // Each rule asks for a velocity; the steering is the difference from the one it has.
      let fx = 0, fy = 0, fz = 0
      if (cnt) {
        nx = nx / cnt - p.x; ny = ny / cnt - p.y; nz = nz / cnt - p.z
        fx += nx * 0.06; fy += ny * 0.06; fz += nz * 0.06
        ax = ax / cnt - p.vx; ay = ay / cnt - p.vy; az = az / cnt - p.vz
        fx += ax * 0.35; fy += ay * 0.35; fz += az * 0.35
      }
      fx += sx * 2.2; fy += sy * 2.2; fz += sz * 2.2
      // The wander is a heading that drifts, not a kick every frame: random forces average
      // to a jitter, a slowly turning preference averages to a curve.
      p.wander += (this.rand() - 0.5) * 3.0 * dt
      fx += Math.sin(p.wander) * k.wander * 0.5
      fz += Math.cos(p.wander) * k.wander * 0.5
      // The flock's own errand, and its leash.
      fx += (this.tx - p.x) * 0.02
      fz += (this.tz - p.z) * 0.02
      const r2 = p.x * p.x + p.z * p.z
      if (r2 > FLOCK_RANGE * FLOCK_RANGE) {
        fx -= p.x * 0.05
        fz -= p.z * 0.05
      }

      // The gull's dip: drop to the surface for a few seconds, then climb back.
      if (k.dip && water != null) {
        if (p.dip > 0) {
          p.dip -= dt
          if (!p.rippled && p.y < water + 0.8 && hooks?.ripple) {
            hooks.ripple(p.x, p.z, 0.5)
            p.rippled = true
          }
        } else {
          p.dipWait -= dt
          if (p.dipWait <= 0) {
            if (env.heightAt(p.x, p.z) < water - 0.3) {
              p.dip = 3
              p.rippled = false
              p.dipWait = 10 + this.rand() * 20
            } else p.dipWait = 3
          }
        }
      }
      const wantY = p.dip > 0 ? water + 0.5 : this.groundY + p.alt
      fy += (wantY - p.y) * 0.6 - p.vy * 0.9

      const f2 = fx * fx + fy * fy + fz * fz
      if (f2 > maxForce * maxForce) {
        const s = maxForce / Math.sqrt(f2)
        fx *= s; fy *= s; fz *= s
      }
      p.vx += fx * dt
      p.vy += fy * dt
      p.vz += fz * dt
      // Hold the speed near cruise rather than clamping at the edges of a band: a bird that
      // brakes and surges is a bird being animated; one that carries its speed is flying.
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz) || 1
      const want = cruise * (p.dip > 0 ? 1.15 : 1)
      const s = 1 + (want / sp - 1) * Math.min(1, 2.5 * dt)
      p.vx *= s; p.vy *= s; p.vz *= s
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt

      // Orientation follows a *smoothed* copy of the velocity, so the body never snaps when
      // a steering force flicks the true velocity; the bank comes from the lateral force —
      // the same thing that turns the bird tips it into the turn.
      const lam = Math.min(1, 6 * dt)
      p.fx += (p.vx - p.fx) * lam
      p.fy += (p.vy - p.fy) * lam
      p.fz += (p.vz - p.fz) * lam
      const heading = Math.atan2(p.fx, p.fz)
      const right = -Math.cos(heading) * fx + Math.sin(heading) * fz
      const roll = THREE.MathUtils.clamp(-right / (maxForce || 1) * 0.9, -0.8, 0.8)
      p.roll += (roll - p.roll) * Math.min(1, 3 * dt)

      _dummy.position.set(p.x, p.y, p.z)
      _target.set(p.x + p.fx, p.y + p.fy, p.z + p.fz)
      _dummy.lookAt(_target)
      _dummy.rotateZ(p.roll)
      _dummy.scale.set(1, 1, 1)
      _dummy.updateMatrix()
      this.mesh.setMatrixAt(i, _dummy.matrix)

      const o = this.info[i]
      o.x = p.x
      o.y = p.y
      o.z = p.z
    }
    this.mesh.instanceMatrix.needsUpdate = true

    // One call every six to fifteen seconds, from wherever one of the flock happens to be.
    this.callTimer -= dt
    if (this.callTimer <= 0) {
      this.callTimer = 6 + this.rand() * 9
      if (hooks?.sound && !(k.diurnal && night > 0.5)) {
        const p = b[Math.floor(this.rand() * n)]
        hooks.sound('bird-call', p.x, p.y, p.z)
      }
    }
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mats.material.dispose()
    this.mats.depth?.dispose()
  }
}

// ── butterflies ───────────────────────────────────────────────────────────────────────

const BUTTERFLY_COLORS = [0xf2a93b, 0x6cc4f0, 0xf05a7a, 0xf6e36a, 0xa77ee8, 0xf4f0e6]

/**
 * Butterflies do not go anywhere. Each has an anchor it potters around, drifting between
 * targets a couple of metres apart with a random shove every frame, and now and then hops
 * to a new anchor and a new patch of scatter. Their sim is skipped when they are far from
 * the camera — the flutter is in the shader, so a held butterfly still looks alive.
 */
class Meadow {
  constructor(group, spec, env, seed, tier) {
    this.env = env
    this.rand = mulberry(seed)
    this.count = Math.max(0, Math.round(spec.count ?? 40))

    const geo = butterflyGeometry()
    phaseAttribute(geo, this.count, this.rand)
    this.mats = crowdMaterials({ name: 'butterfly', rate: 14, amp: 1.1, accentA: 0x2a2420, shadow: false })
    this.mesh = crowdMesh(geo, this.mats, this.count, 'butterflies', false)
    paint(this.mesh, this.count, spec.colors?.length ? spec.colors : BUTTERFLY_COLORS, this.rand, 0.1)
    group.add(this.mesh)

    this.flies = []
    for (let i = 0; i < this.count; i++) {
      const f = {
        ax: 0, az: 0, gy: 0,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        tx: 0, ty: 0, tz: 0,
        heading: this.rand() * Math.PI * 2,
        retarget: 0,
        hop: 12 + this.rand() * 25,
      }
      this._hop(f)
      f.x = f.tx
      f.y = f.ty
      f.z = f.tz
      this.flies.push(f)
      this._write(i, f)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.setTier(tier)
  }

  setTier(scale) {
    this.active = this.count ? Math.max(1, Math.round(this.count * scale)) : 0
    this.mesh.count = this.active
  }

  _hop(f) {
    const a = this.rand() * Math.PI * 2
    const r = 6 + Math.sqrt(this.rand()) * 44
    f.ax = Math.cos(a) * r
    f.az = Math.sin(a) * r
    f.hop = 12 + this.rand() * 25
    this._retarget(f)
  }

  _retarget(f) {
    const a = this.rand() * Math.PI * 2
    const r = this.rand() * 2.5
    f.tx = f.ax + Math.cos(a) * r
    f.tz = f.az + Math.sin(a) * r
    // Ground is sampled here, once per target, rather than every frame under every wing.
    f.gy = this.env.heightAt(f.tx, f.tz)
    if (this.env.waterLevel != null) f.gy = Math.max(f.gy, this.env.waterLevel)
    f.ty = f.gy + 0.4 + this.rand() * 1.2
    f.retarget = 0.7 + this.rand() * 1.8
  }

  _write(i, f) {
    _dummy.position.set(f.x, f.y, f.z)
    _dummy.rotation.set(THREE.MathUtils.clamp(-f.vy * 0.3, -0.5, 0.5), f.heading, 0)
    _dummy.scale.set(1, 1, 1)
    _dummy.updateMatrix()
    this.mesh.setMatrixAt(i, _dummy.matrix)
  }

  update(dt, camera, motion) {
    const n = this.active
    if (!n) return
    const cam = camera.position
    const maxSpeed = 1.3 * motion
    for (let i = 0; i < n; i++) {
      const f = this.flies[i]
      const dx = f.x - cam.x
      const dz = f.z - cam.z
      if (dx * dx + dz * dz > 150 * 150) continue

      f.retarget -= dt
      f.hop -= dt
      if (f.hop <= 0) this._hop(f)
      else if (f.retarget <= 0) this._retarget(f)

      // Erratic on purpose: a steady pull toward the target and a shove that changes every
      // frame, which is what a butterfly's path looks like to us.
      const ax = (f.tx - f.x) * 1.8 + (this.rand() - 0.5) * 6
      const ay = (f.ty - f.y) * 3 + (this.rand() - 0.5) * 3
      const az = (f.tz - f.z) * 1.8 + (this.rand() - 0.5) * 6
      const drag = Math.max(0, 1 - 1.4 * dt)
      f.vx = (f.vx + ax * dt) * drag
      f.vy = (f.vy + ay * dt) * drag
      f.vz = (f.vz + az * dt) * drag
      const s2 = f.vx * f.vx + f.vy * f.vy + f.vz * f.vz
      if (s2 > maxSpeed * maxSpeed) {
        const s = maxSpeed / Math.sqrt(s2)
        f.vx *= s
        f.vy *= s
        f.vz *= s
      }
      f.x += f.vx * dt
      f.y += f.vy * dt
      f.z += f.vz * dt
      if (f.y < f.gy + 0.25) f.y = f.gy + 0.25

      if (s2 > 0.01) f.heading += wrapAngle(Math.atan2(f.vx, f.vz) - f.heading) * Math.min(1, 6 * dt)
      this._write(i, f)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mats.material.dispose()
  }
}

// ── fish ──────────────────────────────────────────────────────────────────────────────

const FISH_COLORS = [0x9fc7e0, 0xf0925a, 0xbfd8a8, 0xe8d070]
/** A touch under real gravity, so a leap hangs for a beat at the top — it reads better. */
const FISH_GRAVITY = -7.5

/**
 * The fish are only ever seen in the air. Every few seconds one launches from a point of
 * open water on a ballistic arc, turns along its velocity, and goes back under with a
 * ripple and a splash. Between leaps a fish is a zero-scale instance: still in the draw,
 * costing nothing, hidden.
 */
class Shoal {
  constructor(group, spec, env, seed, tier) {
    this.env = env
    this.rand = mulberry(seed)
    this.count = Math.max(0, Math.round(spec.count ?? 10))

    const geo = fishGeometry()
    phaseAttribute(geo, this.count, this.rand)
    this.mats = crowdMaterials({ name: 'fish', axis: 'y', rate: 8, amp: 0.45, accentA: 0x6a8aa0, shadow: false })
    this.mesh = crowdMesh(geo, this.mats, this.count, 'fish', false)
    paint(this.mesh, this.count, FISH_COLORS, this.rand)
    group.add(this.mesh)

    this.fish = []
    for (let i = 0; i < this.count; i++) {
      this.fish.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, live: false })
      this.mesh.setMatrixAt(i, _zero)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.launchTimer = 1 + this.rand() * 2
    this.setTier(tier)
  }

  setTier(scale) {
    this.active = this.count ? Math.max(1, Math.round(this.count * scale)) : 0
    this.mesh.count = this.active
  }

  _surface(x, z, elapsed) {
    return this.env.waterHeightAt ? this.env.waterHeightAt(x, z, elapsed) : this.env.waterLevel
  }

  _launch(elapsed, hooks) {
    let slot = -1
    for (let i = 0; i < this.active; i++) {
      if (!this.fish[i].live) {
        slot = i
        break
      }
    }
    if (slot < 0) return
    // Somewhere between twenty and ninety metres out, and actually water — a few throws
    // of the dice, and a planet whose sea is all at one bearing simply leaps less often.
    for (let t = 0; t < 8; t++) {
      const a = this.rand() * Math.PI * 2
      const d = 20 + this.rand() * 70
      const x = Math.cos(a) * d
      const z = Math.sin(a) * d
      if (this.env.heightAt(x, z) >= this.env.waterLevel - 0.4) continue
      const f = this.fish[slot]
      const dir = this.rand() * Math.PI * 2
      const h = 0.6 + this.rand() * 1.2
      f.x = x
      f.z = z
      f.y = this._surface(x, z, elapsed) - 0.25
      f.vx = Math.cos(dir) * h
      f.vz = Math.sin(dir) * h
      f.vy = 3 + this.rand() * 2
      f.live = true
      hooks?.ripple?.(x, z, 0.5)
      return
    }
  }

  update(dt, elapsed, hooks, motion) {
    if (!this.active) return
    this.launchTimer -= dt
    if (this.launchTimer <= 0) {
      this.launchTimer = 2.5 + this.rand() * 4
      this._launch(elapsed, hooks)
    }
    for (let i = 0; i < this.active; i++) {
      const f = this.fish[i]
      if (!f.live) continue
      f.vy += FISH_GRAVITY * dt * motion
      f.x += f.vx * dt * motion
      f.y += f.vy * dt * motion
      f.z += f.vz * dt * motion
      const surface = this._surface(f.x, f.z, elapsed)
      if (f.vy < 0 && f.y < surface - 0.1) {
        f.live = false
        this.mesh.setMatrixAt(i, _zero)
        hooks?.ripple?.(f.x, f.z, 1.4)
        hooks?.sound?.('fish-splash', f.x, surface, f.z)
        continue
      }
      _dummy.position.set(f.x, f.y, f.z)
      _target.set(f.x + f.vx, f.y + f.vy, f.z + f.vz)
      _dummy.lookAt(_target)
      _dummy.scale.set(1, 1, 1)
      _dummy.updateMatrix()
      this.mesh.setMatrixAt(i, _dummy.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mats.material.dispose()
  }
}

// ── drones ────────────────────────────────────────────────────────────────────────────

const DRONE_COLORS = [0xf2efe8, 0xf0a05a, 0x6fc4d8]
const DRONE_SPEED = 5
const CRUISE_CLEARANCE = 6
/** Where a parked drone hovers: just high enough that the slung crate clears the apron. */
/** How many dropped crates can be lying about at once, and how long each stays. */
const PARCEL_CAP = 24
const PARCEL_LIFE = 7
const PARK_HEIGHT = 0.85
const PARK_RING = 4.2
/** Rotor speed in radians per second at full throttle; idle is a slow tick-over. */
const ROTOR_RATE = 42
const IDLE_THROTTLE = 0.3

/**
 * The colony's cargo run. A drone waits on the apron beside the lander, picks a site —
 * one that is being built if there is one — climbs to a cruise height that clears any
 * building, flies over, lowers its crate, lets go, and comes home.
 *
 * Cruise is `max(heightAt, deck) + 6`, sampled under the drone as it goes: the tallest
 * building is about 4.5, so the crate never clips a mast, and over open ground the drone
 * follows the terrain rather than flying a fixed plane.
 */
class Fleet {
  constructor(group, spec, env, seed, tier) {
    this.env = env
    this.rand = mulberry(seed)
    this.count = Math.max(0, Math.round(spec.count ?? 3))

    const geo = droneGeometry()
    phaseAttribute(geo, this.count, this.rand)
    this.carry = new THREE.InstancedBufferAttribute(new Float32Array(this.count).fill(1), 1)
    this.carry.setUsage(THREE.DynamicDrawUsage)
    this.rotor = new THREE.InstancedBufferAttribute(new Float32Array(this.count), 1)
    this.rotor.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aCarry', this.carry)
    geo.setAttribute('aRotor', this.rotor)

    this.mats = crowdMaterials({
      name: 'drone',
      drone: true,
      accentA: 0x3a3d44,
      accentB: 0xc9a26a,
      side: THREE.FrontSide,
      shadow: true,
    })
    this.mesh = crowdMesh(geo, this.mats, this.count, 'drones', true)
    paint(this.mesh, this.count, DRONE_COLORS, this.rand, 0.04)
    group.add(this.mesh)

    // The crates once let go of. A drone's own crate is folded into its hull the moment it
    // is "delivered"; what actually lands on the deck is one of these — a small box with
    // its own fall, a couple of bounces, and a quiet fade once it has settled.
    this.parcels = []
    this.parcelMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xc9a26a, roughness: 0.8, metalness: 0.05 }),
      PARCEL_CAP
    )
    this.parcelMesh.count = 0
    this.parcelMesh.castShadow = true
    this.parcelMesh.frustumCulled = false
    this.parcelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    group.add(this.parcelMesh)

    this.pad = { x: 0, y: 0, z: 0 }
    this.door = { x: 0, y: 0, z: 0 }
    this.sites = []
    this.drones = []
    this.pool = []
    for (let i = 0; i < this.count; i++) {
      this.drones.push({
        state: 'parked',
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        homeX: 0, homeZ: 0,
        tx: 0, ty: 0, tz: 0,
        heading: 0, roll: 0, pitch: 0,
        throttle: IDLE_THROTTLE,
        angle: this.rand() * Math.PI * 2,
        timer: 6 + this.rand() * 19,
        carry: 1,
        dropped: false,
        rippleTimer: 0,
      })
      this.pool.push({ x: 0, y: 0, z: 0, busy: false })
    }
    this.info = []
    this._placed = false
    this.setTier(tier)
  }

  setTier(scale) {
    this.active = this.count ? Math.max(1, Math.round(this.count * scale)) : 0
    this.mesh.count = this.active
    this.info.length = 0
    for (let i = 0; i < this.active; i++) this.info.push(this.pool[i])
  }

  setSites(pad, door, sites) {
    this.pad.x = pad.x
    this.pad.y = pad.y
    this.pad.z = pad.z
    this.door.x = door.x
    this.door.y = door.y
    this.door.z = door.z
    this.sites = sites
    // The parking ring sits on the apron, and starts from the ramp side so the drones
    // cluster by the door rather than round the back.
    const start = Math.atan2(door.x - pad.x, door.z - pad.z)
    for (let i = 0; i < this.count; i++) {
      const d = this.drones[i]
      const a = start + ((i + 0.5) / this.count) * Math.PI * 2
      d.homeX = pad.x + Math.sin(a) * PARK_RING
      d.homeZ = pad.z + Math.cos(a) * PARK_RING
      // A drone on the ground goes where the ground now is — the pad only ever moves when
      // the planet does. One in the air simply comes home to the new spot.
      if (d.state === 'parked' || d.state === 'land') {
        d.x = d.homeX
        d.z = d.homeZ
        d.y = pad.y + PARK_HEIGHT
        d.heading = a + Math.PI
        d.state = 'parked'
      }
    }
    this._placed = true
  }

  /** Let the crate go from under the hull. It lands on whatever is below and stays a while. */
  _release(d) {
    if (this.parcels.length >= PARCEL_CAP) this.parcels.shift()
    this.parcels.push({
      x: d.x + (this.rand() - 0.5) * 0.2,
      y: d.y - 0.75,
      z: d.z + (this.rand() - 0.5) * 0.2,
      vx: (this.rand() - 0.5) * 0.4,
      vy: 0,
      vz: (this.rand() - 0.5) * 0.4,
      spin: (this.rand() - 0.5) * 6,
      yaw: this.rand() * Math.PI * 2,
      tilt: 0,
      bounces: 0,
      life: 0,
      landed: false,
    })
  }

  /**
   * Gravity, a bounce or two, a skid, then a fade. `hooks.sound` gets the thud on the first
   * landing, which is the moment the drop actually *happens* rather than the moment the
   * drone let go.
   */
  _updateParcels(dt, hooks) {
    const list = this.parcels
    let n = 0
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]
      p.life += dt
      const surfaceAt = this.env.parcelSurfaceAt || ((x, z) => ({ height: this.env.heightAt(x, z) }))
      if (stepParcel(p, dt, surfaceAt)) hooks?.sound?.('drone-drop', p.x, p.y, p.z)
      // Gone after a while: shrinks away rather than blinking out.
      const fade = THREE.MathUtils.clamp((PARCEL_LIFE - p.life) / 1.2, 0, 1)
      if (fade <= 0) {
        list.splice(i, 1)
        continue
      }
      _dummy.position.set(p.x, p.y, p.z)
      _dummy.rotation.set(p.tilt, p.yaw, 0)
      _dummy.scale.setScalar(fade)
      _dummy.updateMatrix()
      this.parcelMesh.setMatrixAt(n++, _dummy.matrix)
    }
    this.parcelMesh.count = n
    this.parcelMesh.instanceMatrix.needsUpdate = true
  }

  _cruiseY(x, z) {
    return Math.max(this.env.heightAt(x, z), DECK) + CRUISE_CLEARANCE
  }

  /**
   * A building under construction first; failing that, anyone; failing that, nobody. A site
   * another drone is already flying to is passed over while there is any other choice, so
   * the fleet spreads across the colony instead of stacking up over one roof.
   */
  _pickSite(self) {
    const sites = this.sites
    if (!sites.length) return null
    const taken = (site) => {
      for (let i = 0; i < this.active; i++) {
        const o = this.drones[i]
        if (o !== self && o.state !== 'parked' && o.state !== 'land' && o.site === site) return true
      }
      return false
    }
    const pick = (list) => (list.length ? list[Math.floor(this.rand() * list.length)] : null)
    const actives = sites.filter((s) => s.active)
    return pick(actives.filter((s) => !taken(s))) || pick(sites.filter((s) => !taken(s))) || pick(actives) || pick(sites)
  }

  /**
   * Where over the site a drone parks to drop: somewhere on the roof, not the one exact
   * centre every drone would otherwise share.
   */
  _dropSpot(d, site) {
    const a = this.rand() * Math.PI * 2
    const r = 0.4 + this.rand() * Math.max(0.4, (site.radius || 1.4) * 0.55)
    d.site = site
    d.tx = site.x + Math.cos(a) * r
    d.ty = site.y
    d.tz = site.z + Math.sin(a) * r
  }

  /** A shove away from any other airborne drone too close: no two hover in the same air. */
  _separate(d, out) {
    out.x = 0
    out.z = 0
    for (let i = 0; i < this.active; i++) {
      const o = this.drones[i]
      if (o === d || o.state === 'parked') continue
      const dx = d.x - o.x
      const dz = d.z - o.z
      const d2 = dx * dx + dz * dz
      if (d2 > 6.25 || d2 < 1e-4) continue
      const dist = Math.sqrt(d2)
      const k = (1 - dist / 2.5) * 2.2
      out.x += (dx / dist) * k
      out.z += (dz / dist) * k
    }
    return out
  }

  update(dt, elapsed, hooks, motion) {
    const n = this.active
    if (!n || !this._placed) return
    const speed = DRONE_SPEED * motion
    const water = this.env.waterLevel

    for (let i = 0; i < n; i++) {
      const d = this.drones[i]
      let wantY = d.y
      let wantThrottle = 1
      let wantVX = 0
      let wantVZ = 0

      switch (d.state) {
        case 'parked': {
          wantY = this.pad.y + PARK_HEIGHT
          wantThrottle = IDLE_THROTTLE
          d.timer -= dt
          if (d.timer <= 0) {
            const site = this._pickSite(d)
            if (site) {
              this._dropSpot(d, site)
              d.carry = 1
              d.dropped = false
              d.state = 'takeoff'
            } else d.timer = 4 + this.rand() * 6
          }
          break
        }
        case 'takeoff': {
          wantY = this._cruiseY(d.x, d.z)
          if (d.y > wantY - 0.3) d.state = 'cruise'
          break
        }
        case 'cruise':
        case 'return': {
          const gx = d.state === 'cruise' ? d.tx : d.homeX
          const gz = d.state === 'cruise' ? d.tz : d.homeZ
          const dx = gx - d.x
          const dz = gz - d.z
          const dist = Math.hypot(dx, dz)
          wantY = this._cruiseY(d.x, d.z)
          if (dist < 0.4) {
            if (d.state === 'cruise') {
              d.state = 'hover'
              d.timer = 3 + this.rand() * 3
              d.hoverT = d.timer
            } else d.state = 'land'
          } else {
            // Slow into the last few metres so arrival is a settle, not a stop.
            const v = Math.min(speed, 1 + dist * 1.6)
            wantVX = (dx / dist) * v
            wantVZ = (dz / dist) * v
          }
          const sep = this._separate(d, _sep)
          wantVX += sep.x
          wantVZ += sep.z
          break
        }
        case 'hover': {
          d.timer -= dt
          // Sink a little over the site and bob while the crate goes down. Each drone hangs
          // at its own height, and holds its distance from the others, so a busy roof reads
          // as a queue rather than one drone drawn several times.
          const t = 1 - d.timer / d.hoverT
          wantY = this._cruiseY(d.x, d.z) - 1 - Math.sin(t * Math.PI) * 0.6 + (i % 3) * 0.45
          const sep = this._separate(d, _sep)
          wantVX = sep.x
          wantVZ = sep.z
          if (!d.dropped && t > 0.55) {
            d.dropped = true
            d.carry = 0
            this._release(d)
          }
          if (d.timer <= 0) d.state = 'return'
          break
        }
        case 'land': {
          wantY = this.pad.y + PARK_HEIGHT
          if (d.y < wantY + 0.1) {
            d.state = 'parked'
            d.timer = 6 + this.rand() * 19
            d.carry = 1
          }
          break
        }
      }

      // Horizontal: ease toward the wanted velocity. Vertical: a climb or descent capped at
      // a couple of metres a second, so take-off and landing read as such.
      const ax = (wantVX - d.vx) * Math.min(1, 2.5 * dt)
      const az = (wantVZ - d.vz) * Math.min(1, 2.5 * dt)
      d.vx += ax
      d.vz += az
      const climb = d.state === 'takeoff' ? 2.6 : d.state === 'land' ? 1.6 : 2.2
      const dy = THREE.MathUtils.clamp((wantY - d.y) * 2, -climb * motion, climb * motion)
      d.vy += (dy - d.vy) * Math.min(1, 4 * dt)
      d.x += d.vx * dt
      d.y += d.vy * dt
      d.z += d.vz * dt

      // Lean: a quad tips into the direction it is pushing and into the direction it is
      // going, which is what makes it read as flying rather than sliding.
      const s2 = d.vx * d.vx + d.vz * d.vz
      if (s2 > 0.04) d.heading += wrapAngle(Math.atan2(d.vx, d.vz) - d.heading) * Math.min(1, 3 * dt)
      const fx = Math.sin(d.heading)
      const fz = Math.cos(d.heading)
      const forwardV = d.vx * fx + d.vz * fz
      const forwardA = dt > 0 ? (ax * fx + az * fz) / dt : 0
      const sideV = d.vx * fz - d.vz * fx
      const sideA = dt > 0 ? (ax * fz - az * fx) / dt : 0
      const pitch = THREE.MathUtils.clamp(forwardV * 0.045 + forwardA * 0.03, -0.35, 0.35)
      const roll = THREE.MathUtils.clamp(sideV * 0.045 + sideA * 0.03, -0.35, 0.35)
      d.pitch += (pitch - d.pitch) * Math.min(1, 4 * dt)
      d.roll += (roll - d.roll) * Math.min(1, 4 * dt)

      d.throttle += (wantThrottle - d.throttle) * Math.min(1, 1.5 * dt)
      d.angle += ROTOR_RATE * d.throttle * motion * dt
      if (d.angle > 1e4) d.angle -= 1e4
      this.rotor.array[i] = d.angle
      this.carry.array[i] = d.carry

      // Downwash on water: a drone low over the sea stirs it.
      if (water != null && hooks?.ripple) {
        d.rippleTimer -= dt
        if (d.rippleTimer <= 0 && d.y - water < 2.5 && this.env.heightAt(d.x, d.z) < water) {
          d.rippleTimer = 0.15
          hooks.ripple(d.x, d.z, 0.35)
        }
      }

      _dummy.position.set(d.x, d.y, d.z)
      _dummy.rotation.set(0, d.heading, 0)
      _dummy.rotateX(d.pitch)
      _dummy.rotateZ(d.roll)
      _dummy.scale.set(1, 1, 1)
      _dummy.updateMatrix()
      this.mesh.setMatrixAt(i, _dummy.matrix)

      const o = this.pool[i]
      o.x = d.x
      o.y = d.y
      o.z = d.z
      o.busy = d.state !== 'parked'
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.rotor.needsUpdate = true
    this.carry.needsUpdate = true
    this._updateParcels(dt, hooks)
  }

  dispose() {
    this.parcelMesh.removeFromParent()
    this.parcelMesh.geometry.dispose()
    this.parcelMesh.material.dispose()
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mats.material.dispose()
    this.mats.depth?.dispose()
  }
}

// ── the layer ─────────────────────────────────────────────────────────────────────────

const EMPTY = []

/**
 * Owns all four crowds for the current planet, and is the only thing the rest of the
 * colony talks to.
 *
 * `planet.fauna` is the whole recipe:
 *
 *   birds:       { kind: 'gull'|'parrot'|'crow'|'swallow'|'none', count = 14,
 *                  altitude = [14, 22], colors = the species' own, size = 1 }
 *   butterflies: { count = 40, colors = a bright default set }
 *   fish:        { count = 10 }   — ignored unless the environment has a water level
 *   drones:      { count = 3 }
 *
 * A missing key means none of that kind; a missing `fauna` means an empty layer.
 */
export class Fauna {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.group = new THREE.Group()
    this.group.name = 'fauna'
    scene.add(this.group)

    this.env = null
    this.planet = null
    this.flock = null
    this.meadow = null
    this.shoal = null
    this.fleet = null

    this._sites = { pad: { x: 0, y: 0, z: 0 }, door: { x: 0, y: 0, z: 0 }, sites: [] }
    this._tier = TIER[settings.get('fauna')] ?? 1
    this.motion = settings.get('reducedMotion') ? 0.5 : 1
    faunaUniforms.uMotion.value = this.motion
  }

  setPlanet(planet, env) {
    this._clear()
    this.planet = planet
    this.env = env
    const fauna = planet?.fauna
    if (!fauna || !env) return
    const seed = hashString(planet.id || planet.name || 'planet')

    if (fauna.birds && fauna.birds.kind !== 'none' && (fauna.birds.count ?? 14) > 0) {
      this.flock = new Flock(this.group, fauna.birds, env, seed ^ 0x1b1d, this._tier)
    }
    if (fauna.butterflies && (fauna.butterflies.count ?? 40) > 0) {
      this.meadow = new Meadow(this.group, fauna.butterflies, env, seed ^ 0x2c2e, this._tier)
    }
    if (fauna.fish && env.waterLevel != null && (fauna.fish.count ?? 10) > 0) {
      this.shoal = new Shoal(this.group, fauna.fish, env, seed ^ 0x3d3f, this._tier)
    }
    if (fauna.drones && (fauna.drones.count ?? 3) > 0) {
      this.fleet = new Fleet(this.group, fauna.drones, env, seed ^ 0x4e40, this._tier)
      this.fleet.setSites(this._sites.pad, this._sites.door, this._sites.sites)
    }
  }

  /** Where the drones live and where they deliver. Call whenever the roster changes. */
  setSites({ ship, pad, sites }) {
    const s = this._sites
    if (pad) {
      s.pad.x = pad.x
      s.pad.y = pad.y
      s.pad.z = pad.z
    }
    if (ship) {
      s.door.x = ship.x
      s.door.y = ship.y
      s.door.z = ship.z
    } else if (pad) {
      s.door.x = pad.x
      s.door.y = pad.y
      s.door.z = pad.z + 1
    }
    s.sites = sites || []
    this.fleet?.setSites(s.pad, s.door, s.sites)
  }

  update(dt, elapsed, camera, night, hooks) {
    // A tab that was hidden for a minute must not land every fish and drone at once.
    dt = Math.min(dt, 0.1)
    faunaUniforms.uTime.value = elapsed
    const motion = this.motion
    this.flock?.update(dt, night, hooks, motion)
    // Butterflies roost after dark; the fireflies take the night shift.
    if (this.meadow) {
      this.meadow.mesh.visible = night < 0.6
      if (this.meadow.mesh.visible) this.meadow.update(dt, camera, motion)
    }
    this.shoal?.update(dt, elapsed, hooks, motion)
    this.fleet?.update(dt, elapsed, hooks, motion)
  }

  /** `{ x, y, z, busy }` per drone, reused frame to frame — for the rotor whine. */
  get drones() {
    return this.fleet ? this.fleet.info : EMPTY
  }

  /** `{ x, y, z }` per bird in the air, reused frame to frame. */
  get birds() {
    return this.flock ? this.flock.info : EMPTY
  }

  onSettingsChanged(changed) {
    if (changed.has('fauna')) {
      this._tier = TIER[this.settings.get('fauna')] ?? 1
      this.flock?.setTier(this._tier)
      this.meadow?.setTier(this._tier)
      this.shoal?.setTier(this._tier)
      this.fleet?.setTier(this._tier)
    }
    if (changed.has('reducedMotion')) {
      this.motion = this.settings.get('reducedMotion') ? 0.5 : 1
      faunaUniforms.uMotion.value = this.motion
    }
  }

  _clear() {
    this.flock?.dispose()
    this.meadow?.dispose()
    this.shoal?.dispose()
    this.fleet?.dispose()
    this.flock = this.meadow = this.shoal = this.fleet = null
  }

  dispose() {
    this._clear()
    this.group.removeFromParent()
  }
}
