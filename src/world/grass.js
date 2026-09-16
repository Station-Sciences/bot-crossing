import * as THREE from 'three'
import { withCurve } from '../core/curve.js'
import { COLONY_RADIUS, GROUND_SIZE, mulberry } from './planet.js'

/**
 * The meadow: tens of thousands of wispy blades that lean in the wind.
 *
 * The terrain is already green; what it lacks is *movement*. A field that breathes — waves
 * rolling across it, blades fluttering at the edge of the frame — is most of what makes a
 * place read as Animal Crossing rather than as a height map with a texture on it, and it
 * costs almost nothing when it is done the colony's usual way: **one `InstancedMesh`, one
 * draw call**, and the CPU touching nothing but a couple of uniforms a frame.
 *
 * A blade is a nine-vertex tapered strip with a slight forward curl, drawn from both sides
 * because it has no thickness. Every blade is the same strip; where it stands, which way it
 * faces and how tall it is live in its instance matrix, and two floats ride along per
 * instance — a phase so no two blades beat in step, and a tint so no two are quite the same
 * green. Everything that *moves* moves in the vertex shader, driven by a travelling wave
 * plus a slow drifting noise so gusts cross the field rather than pulsing everywhere at
 * once. Colour is a root-to-tip gradient, darkened at the base to ground it.
 *
 * Blades are lit like the carpet they belong to rather than like the flat cards they are:
 * the normal is bent most of the way to straight up, and the double-sided flip three would
 * otherwise apply to the back of a card is undone, so the field shades as one soft surface
 * under the sun instead of a scatter of black and bright slivers.
 *
 * The bend of the world comes for free through `project_vertex`; the one obligation is
 * `withCurve(shader)` in each `onBeforeCompile`, since installing our own replaces the
 * prototype's.
 */

/** Blades at density 1, by quality tier. */
const BLADES = { low: 24000, medium: 50000, high: 90000 }

/** The field: nothing inside the ship apron, and nothing past where the hills take over. */
const RADIUS_MIN = 6
const RADIUS_DENSE = 70
const RADIUS_MAX = 125
/** How much of the field lands in the dense inner disc. The rest thins outward. */
const INNER_SHARE = 0.8

/** Blades grow in small tufts — a meadow is clumpy, and a tuft reads at a distance where a lone blade is a speck. */
const TUFT_MIN = 5
const TUFT_MAX = 9
const TUFT_RADIUS = 0.26

/** Steeper than this (rise over half a metre either way) and the ground is a hillside, not a lawn. */
const MAX_SLOPE = 0.9

/** Tip travel, in world units per unit of blade height, at full wind and full gust. */
const LEAN = 0.5

const glslFloat = (n) => Number(n).toFixed(4)

// ── the shader ────────────────────────────────────────────────────────────────────────

/**
 * Shared by the surface pass and the shadow pass, so a blade's shadow leans with it.
 *
 * Wind is applied in *world* space and folded back into the blade's own frame: the
 * displacement is worked out along the wind direction on the ground, then projected onto
 * the instance's local X and Z axes, which are unit-length in the ground plane bar the
 * ±15% width jitter (which lands as a little extra per-blade variation rather than a bug).
 * The instance matrix then carries it back out. Doing it in local space directly would
 * have every blade blown along its own yaw, which is forty thousand different winds.
 */
const VERT_PARS = /* glsl */ `
#include <common>
// bc:grass-vert
attribute float aPhase;
attribute float aTint;
varying float vHeight;
varying float vTint;
varying float vFade;
uniform float uTime;
uniform float uSway;
uniform vec2 uWindDir;

float bcGrassHash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
// Value noise, -1..1. The slow gust field that rides on top of the travelling wave.
float bcGrassNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = bcGrassHash( i );
  float b = bcGrassHash( i + vec2( 1.0, 0.0 ) );
  float c = bcGrassHash( i + vec2( 0.0, 1.0 ) );
  float d = bcGrassHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 2.0 - 1.0;
}
`

const VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
// bc:grass-normal
// A flat card under a directional light is a hard two-tone. Pulled most of the way to
// straight up, every blade takes roughly the light the ground under it takes, and the
// field reads as a soft carpet with a little sheen on the tips rather than as slats.
objectNormal = normalize( mix( objectNormal, vec3( 0.0, 1.0, 0.0 ), 0.6 ) );
`

const VERT_MOVE = /* glsl */ `
#include <begin_vertex>
// bc:grass-move
{
  vHeight = uv.y;
  vTint = aTint;
  // Where this blade stands, in the world — the wave and the gusts are functions of place.
  vec3 base = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
  vFade = smoothstep( ${glslFloat(COLONY_RADIUS * 0.8)}, ${glslFloat(GROUND_SIZE * 0.36)}, length( base.xz ) );

  float h = length( instanceMatrix[ 1 ].xyz );
  // Squared so the root stays planted and the bend is a curve rather than a hinge.
  float bend = uv.y * uv.y;
  vec2 dir = uWindDir;
  vec2 perp = vec2( -dir.y, dir.x );
  // A wave rolling downwind, about twenty-five metres crest to crest, with a slow-drifting
  // noise field over it so the field gusts in patches instead of pulsing as one.
  float wave = sin( dot( base.xz, dir ) * 0.25 - uTime * 1.6 + aPhase * 0.7 ) * 0.6
             + bcGrassNoise( base.xz * 0.08 + uTime * 0.15 );
  float gust = 0.55 + 0.45 * wave;
  // A quicker side-to-side flutter, out of step per blade and along the blade's length.
  float flutter = sin( uTime * 4.5 + aPhase * 6.2832 + uv.y * 2.0 ) * 0.12;
  vec2 lean = ( dir * gust + perp * flutter ) * uSway * ${glslFloat(LEAN)} * h * bend;

  vec3 d = vec3( lean.x, 0.0, lean.y );
  vec3 ax = normalize( instanceMatrix[ 0 ].xyz );
  vec3 az = normalize( instanceMatrix[ 2 ].xyz );
  transformed.xz += vec2( dot( d, ax ), dot( d, az ) );
  // A blade that leans is an arc, not a shear: the tip dips by about lean² over twice the
  // height it leaned from, in the blade's own units. Clamped so an extreme gust flattens
  // the blade rather than pushing it through the ground.
  float dip = dot( lean, lean ) * 0.5 / ( max( uv.y, 0.05 ) * h * h );
  transformed.y -= min( dip, uv.y * 0.5 );
}
`

const FRAG_PARS = /* glsl */ `
#include <common>
// bc:grass-frag
varying float vHeight;
varying float vTint;
varying float vFade;
uniform vec3 uRoot;
uniform vec3 uTip;
`

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
// bc:grass-color
{
  // Root to tip, biased toward the root so the bright tip colour is a highlight rather
  // than half the blade; ±12% brightness per blade; darker still right at the ground so
  // the base of the field sinks into the terrain instead of floating on it.
  // Perspective interpolation can put the root a fraction below zero on a grazing
  // blade. pow(negative, fractional) is NaN, which bloom spreads into black blocks.
  diffuseColor.rgb = mix( uRoot, uTip, pow( clamp( vHeight, 0.0, 1.0 ), 1.2 ) );
  diffuseColor.rgb *= 0.88 + 0.24 * vTint;
  diffuseColor.rgb *= 0.72 + 0.28 * smoothstep( 0.0, 0.3, vHeight );
  // The terrain darkens toward the horizon so the eye settles on the colony; grass that
  // stayed bright out there would float above its own ground.
  diffuseColor.rgb *= 1.0 - vFade * 0.55;
}
`

const FRAG_FACING = /* glsl */ `
#include <normal_fragment_begin>
// bc:grass-facing
// Three flips a double-sided normal on the back face, which would turn every blade seen
// from behind black. A blade has no back: it is lit from above whichever side we see.
#ifdef DOUBLE_SIDED
normal *= faceDirection;
#endif
`

/**
 * Swap a chunk include for our version of it, loudly. A silent miss here would compile a
 * shader that draws grass standing perfectly still, which is the kind of bug that survives
 * for months; a thrown error the first time the material compiles is the kind that does not.
 */
function splice(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error(`grass: shader has no ${anchor} to patch`)
  return source.replace(anchor, replacement)
}

/**
 * Install the grass shader on a material — the surface material, and with the very same
 * uniform objects the depth material, so one `uTime` write leans the blade and its shadow.
 */
function decorate(material, uniforms, key) {
  material.customProgramCacheKey = () => key
  material.onBeforeCompile = (shader) => {
    withCurve(shader)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = splice(shader.vertexShader, '#include <common>', VERT_PARS)
    shader.vertexShader = splice(shader.vertexShader, '#include <beginnormal_vertex>', VERT_NORMAL)
    shader.vertexShader = splice(shader.vertexShader, '#include <begin_vertex>', VERT_MOVE)
    // The depth pass has no colour to tint and no normal to face; it only needs to lean.
    if (!material.isMeshDepthMaterial) {
      shader.fragmentShader = splice(shader.fragmentShader, '#include <common>', FRAG_PARS)
      shader.fragmentShader = splice(shader.fragmentShader, '#include <color_fragment>', FRAG_COLOR)
      shader.fragmentShader = splice(shader.fragmentShader, '#include <normal_fragment_begin>', FRAG_FACING)
    }
  }
  return material
}

// ── geometry ──────────────────────────────────────────────────────────────────────────

/** Width of each ring of the blade as a share of the root, bottom to top; the tip is a point. */
const TAPER = [1.0, 0.92, 0.72, 0.42]

/**
 * One blade: a strip of four segments, one unit tall, `width` across at the root, meeting at
 * a point. Four segments rather than one so it bends along its length instead of hinging at
 * the ground. It curls a little forward (+Z) at rest, because a dead-straight blade in a
 * field of dead-straight blades looks like a comb.
 */
function bladeGeometry(width) {
  const rows = TAPER.length
  const positions = []
  const uvs = []
  const indices = []
  for (let r = 0; r < rows; r++) {
    const t = r / rows
    const half = (width * TAPER[r]) / 2
    const curl = 0.12 * t * t
    positions.push(-half, t, curl, half, t, curl)
    uvs.push(0, t, 1, t)
  }
  positions.push(0, 1, 0.12)
  uvs.push(0.5, 1)
  const tip = rows * 2
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  indices.push((rows - 1) * 2, (rows - 1) * 2 + 1, tip)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

// ── the preset ────────────────────────────────────────────────────────────────────────

/**
 * Fill in what a planet's `grass` block leaves out. Root and tip fall back to the ground's
 * own low and high colours pushed a little further apart and a little more saturated — the
 * field should sit *on* the terrain's palette, just livelier, or it looks pasted on.
 */
function resolve(planet) {
  const g = planet.grass
  const ground = planet.ground || {}
  const root = new THREE.Color(g.root ?? ground.low ?? 0x2f5a34)
  const tip = new THREE.Color(g.tip ?? ground.high ?? 0x6d9a4a)
  if (g.root === undefined) root.offsetHSL(0, 0.04, -0.05)
  if (g.tip === undefined) tip.offsetHSL(0, 0.04, -0.01)
  const height = Array.isArray(g.height) && g.height.length === 2 ? g.height : [0.25, 0.55]
  return {
    root,
    tip,
    height,
    width: g.width ?? 0.085,
    sway: THREE.MathUtils.clamp(g.sway ?? 0.6, 0, 1),
  }
}

// ── the field ─────────────────────────────────────────────────────────────────────────

/**
 * Plant the meadow.
 *
 * `heightAt(x, z)` is the terrain; `blocked(x, z)` is anywhere grass must not grow — the
 * plots, the ship apron, the water. Placement is deterministic per seed, so the same world
 * grows the same field every time. Returns null when the planet has no `grass` block, so a
 * caller can `if (grass) scene.add(grass.mesh)` and not think about it.
 */
export function createGrass({ planet, heightAt, blocked, density = 1, seed = 777, quality = 'medium' }) {
  if (!planet?.grass) return null
  const preset = resolve(planet)
  const capacity = Math.round((BLADES[quality] ?? BLADES.medium) * THREE.MathUtils.clamp(density, 0, 1))
  if (capacity <= 0) return null

  const rand = mulberry(seed)
  const geometry = bladeGeometry(preset.width)
  const phase = new Float32Array(capacity)
  const tint = new Float32Array(capacity)
  const matrices = new Float32Array(capacity * 16)

  const isBlocked = blocked || (() => false)
  const level = planet.water?.level
  // Grass stops where the sand starts, whatever the caller's `blocked` says about water.
  const shoreline = level !== undefined ? level + (planet.shore?.band ?? 0) * 0.7 + 0.05 : -Infinity

  const dummy = new THREE.Object3D()
  const [hMin, hMax] = preset.height
  let placed = 0

  // Tufts are thrown until the field is full or the throws run out — on a world that is
  // mostly water or mostly steep, most throws land somewhere grass cannot grow.
  const maxThrows = capacity * 3
  for (let i = 0; i < maxThrows && placed < capacity; i++) {
    // Area-uniform over the inner disc; past it the density falls off with distance, so
    // the ground you actually look at is thick and the hills are dusted.
    const a = rand() * Math.PI * 2
    let d
    if (rand() < INNER_SHARE) {
      d = Math.sqrt(THREE.MathUtils.lerp(RADIUS_MIN * RADIUS_MIN, RADIUS_DENSE * RADIUS_DENSE, rand()))
    } else {
      d = RADIUS_DENSE + (RADIUS_MAX - RADIUS_DENSE) * Math.pow(rand(), 1.6)
    }
    const cx = Math.cos(a) * d
    const cz = Math.sin(a) * d

    // Slope, from four extra samples around the tuft rather than around every blade.
    const cy = heightAt(cx, cz)
    if (cy < shoreline) continue
    const sx = heightAt(cx + 0.5, cz) - heightAt(cx - 0.5, cz)
    const sz = heightAt(cx, cz + 0.5) - heightAt(cx, cz - 0.5)
    if (Math.hypot(sx, sz) > MAX_SLOPE) continue

    // Far blades grow taller, as the scatter does: at a hundred metres a half-metre blade
    // is under a pixel, and a field that vanishes with distance looks bald out there.
    const far = THREE.MathUtils.smoothstep(d, COLONY_RADIUS, RADIUS_MAX)
    const tuftTint = rand()
    const tuft = TUFT_MIN + Math.floor(rand() * (TUFT_MAX - TUFT_MIN + 1))
    for (let k = 0; k < tuft && placed < capacity; k++) {
      const ta = rand() * Math.PI * 2
      const tr = Math.sqrt(rand()) * TUFT_RADIUS
      const x = cx + Math.cos(ta) * tr
      const z = cz + Math.sin(ta) * tr
      if (isBlocked(x, z)) continue
      const y = heightAt(x, z)
      if (y < shoreline) continue

      const h = (hMin + rand() * (hMax - hMin)) * (1 + far * 0.8)
      const w = 0.85 + rand() * 0.3
      // Sunk a touch so the root is in the ground, not resting on it, where the ground tilts.
      dummy.position.set(x, y - 0.02, z)
      dummy.rotation.set(0, rand() * Math.PI * 2, 0)
      dummy.scale.set(w, h, w)
      dummy.updateMatrix()
      dummy.matrix.toArray(matrices, placed * 16)
      phase[placed] = rand() * Math.PI * 2
      tint[placed] = tuftTint * 0.75 + rand() * 0.25
      placed++
    }
  }

  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1))
  geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 1))

  const uniforms = {
    uTime: { value: 0 },
    uSway: { value: preset.sway * 0.6 },
    uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
    uRoot: { value: preset.root },
    uTip: { value: preset.tip },
  }

  const material = decorate(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      // A blade is a strip with no thickness; both faces have to draw.
      side: THREE.DoubleSide,
      vertexColors: false,
    }),
    uniforms,
    'bc-grass'
  )
  const depth = decorate(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), uniforms, 'bc-grass:depth')

  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.name = 'grass'
  mesh.instanceMatrix.array.set(matrices)
  mesh.instanceMatrix.needsUpdate = true
  mesh.count = placed
  // The depth material is what would lean the shadows; it is wired up so that turning
  // casting on is a one-line change, but forty thousand blades in the shadow pass is a
  // cost the field cannot justify. It receives the buildings' shadows, and that is enough.
  mesh.customDepthMaterial = depth
  mesh.castShadow = false
  mesh.receiveShadow = true
  // One mesh spans the whole field; a bounding-sphere test would only ever say yes.
  mesh.frustumCulled = false

  let clock = 0
  return {
    mesh,
    uniforms,
    count: placed,
    /** Once a frame. Uniform writes only; nothing on the CPU moves. */
    update(dt, elapsed) {
      clock = elapsed !== undefined ? elapsed : clock + (dt || 0)
      uniforms.uTime.value = clock
    },
    /** How hard the wind blows (0..1, scaled by the planet's own `sway`) and which way. */
    setWind(strength, dirX, dirZ) {
      uniforms.uSway.value = THREE.MathUtils.clamp(strength ?? 0, 0, 1) * preset.sway
      if (dirX !== undefined && dirZ !== undefined && (dirX !== 0 || dirZ !== 0)) {
        uniforms.uWindDir.value.set(dirX, dirZ).normalize()
      }
    },
    dispose() {
      mesh.removeFromParent()
      geometry.dispose()
      material.dispose()
      depth.dispose()
    },
  }
}
