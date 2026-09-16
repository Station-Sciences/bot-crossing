import * as THREE from 'three'
import { withCurve } from '../core/curve.js'

/**
 * Water, the Animal Crossing way: turquoise where you can see the bottom, blue where you
 * cannot, a crisp white lace of foam along every shore, and sparkle on the swell at noon.
 *
 * It is one plane and one draw call, built on `MeshPhysicalMaterial` rather than a shader of
 * its own so that it sits *inside* the scene's lighting for free — the sun and its shadow
 * map, the sky-as-HDRI environment, fog, tone mapping, and the world curve, which bends
 * anything that goes through three's `project_vertex`. Writing a bespoke shader would mean
 * re-implementing all of that and then keeping it in step; customising the built-in one
 * through `onBeforeCompile` means only the water-specific parts are ours.
 *
 * Nothing here reads the depth buffer. The one thing the look really needs — how far the
 * bottom is beneath the surface — is baked per vertex from the terrain height field into an
 * `aDepth` attribute when the plane is built. That is what steers the colour ramp, the
 * opacity and the foam bands, and it costs nothing per frame; the price is that the shore
 * is only as fine as the plane's vertex spacing, which the foam's noise-wobbled edges hide.
 *
 * The swell is a sum of a few Gerstner waves, defined once in `WAVES` below and unrolled
 * into the vertex shader as literals, so `heightAt` on the CPU — used to float things —
 * evaluates exactly the surface the GPU draws.
 */

/**
 * The swell. Direction, relative amplitude (these sum to 1, so `waveHeight` is the height
 * of the combined crest), wavelength in metres, and phase speed in metres per second.
 *
 * Four waves at unrelated angles and lengths never line up into a visible grid, which is
 * what a single sine, or two at right angles, always ends up doing on a big flat plane.
 */
const WAVES = [
  { dir: [0.82, 0.57], amp: 0.42, len: 11.0, speed: 1.35 },
  { dir: [-0.44, 0.9], amp: 0.28, len: 6.4, speed: 1.05 },
  { dir: [0.97, -0.24], amp: 0.18, len: 3.7, speed: 0.85 },
  { dir: [-0.62, -0.78], amp: 0.12, len: 2.1, speed: 0.65 },
]
/**
 * How much each crest leans forward. Gerstner waves slide the surface sideways toward the
 * crest as well as lifting it, which is what makes a crest read as a crest rather than as a
 * bump; this is the classic steepness knob, and at 1.0 the crests would fold over.
 */
const STEEPNESS = 0.4
/** The wave height the steepness was tuned at; the lean scales with the height around it. */
const REFERENCE_WAVE_HEIGHT = 0.12

/** How many rings can be in flight at once. Past this the oldest is recycled. */
export const MAX_RIPPLES = 16
/** Seconds a ring lives, and how fast it grows, in metres per second. */
const RIPPLE_LIFE = 2.5
const RIPPLE_SPEED = 2.2

const SEGMENTS = { low: 96, medium: 160, high: 220 }

/**
 * What a planet gets if its `water` block leaves something out. The colours are the Animal
 * Crossing palette more or less verbatim: a saturated turquoise that only ever reads as
 * "shallow", a deep blue with enough green in it not to go inky, and foam that is white
 * but not *pure* white, so it still takes the light.
 */
const DEFAULTS = {
  level: -1.2,
  shallow: 0x5fe0d8,
  deep: 0x1a5fa8,
  foam: 0xf4fbff,
  /** Opacity at the deep end. The shallows sit at about six tenths of it. */
  opacity: 0.92,
  waveHeight: 0.12,
  waveScale: 1,
  speed: 1,
  sparkle: 1,
  ripples: 1,
  /** Self-illumination, for water that is not water: lava glows, the sea does not. */
  glow: 0,
}

// ── the wave function, once, for both sides ───────────────────────────────────────────

const TAU = Math.PI * 2

/**
 * Per-wave constants derived from `WAVES`, shared by the GLSL below and `heightAt`. Rounded
 * *here*, to the precision they are printed into the shader at, so the CPU never evaluates
 * a slightly different wave from the one on screen — a float's worth of drift in a phase
 * speed is a visible bob out of step after a few minutes.
 */
const WAVE_TABLE = WAVES.map((w) => {
  const r = (n) => Number(n.toFixed(6))
  const k = r(TAU / w.len)
  return {
    dx: r(w.dir[0]),
    dz: r(w.dir[1]),
    amp: r(w.amp),
    k,
    omega: r(k * w.speed),
    // Lean per wave: steepness shared across the set, and divided by k because a long
    // wave moves the surface further sideways for the same lean than a short one does.
    lean: r(STEEPNESS / (k * WAVES.length)),
  }
})

/**
 * The vertex-side wave evaluation, unrolled. Takes a point in the plane's own xz (which is
 * world xz — the mesh only ever translates), returns the lift, the sideways Gerstner slide
 * and the analytic normal. The normal comes from the partial derivatives of the height sum
 * rather than from neighbouring vertices, so the lighting is right at any tessellation.
 */
function wavesGLSL() {
  const f = (n) => n.toFixed(6)
  const body = WAVE_TABLE.map(
    (w, i) => `
  // wave ${i}
  k = ${f(w.k)} / uWaveScale;
  ph = k * dot( vec2( ${f(w.dx)}, ${f(w.dz)} ), p ) - ${f(w.omega)} * t;
  s = sin( ph );
  c = cos( ph );
  h += ${f(w.amp)} * s;
  off += vec2( ${f(w.dx)}, ${f(w.dz)} ) * ( ${f(w.lean)} * c );
  slope += vec2( ${f(w.dx)}, ${f(w.dz)} ) * ( ${f(w.amp)} * k * c );`
  )
  return /* glsl */ `
uniform float uWaveHeight;
uniform float uWaveScale;
void bcWaves( vec2 p, float t, out float h, out vec2 off, out vec3 n ) {
  h = 0.0;
  off = vec2( 0.0 );
  vec2 slope = vec2( 0.0 );
  float k, ph, s, c;${body.join('')}
  h *= uWaveHeight;
  slope *= uWaveHeight;
  // The lean scales with the height around its tuning point, so a flat calm has no lean
  // and a heavier swell leans harder, and stays proportionate at any wave scale.
  off *= uWaveScale * ( uWaveHeight / ${f(REFERENCE_WAVE_HEIGHT)} );
  n = normalize( vec3( -slope.x, 1.0, -slope.y ) );
}
`
}

/** Surface lift above `level` at a world point — the same sum the shader evaluates. */
function waveLift(x, z, time, waveHeight, waveScale) {
  let h = 0
  for (const w of WAVE_TABLE) {
    const k = w.k / waveScale
    h += w.amp * Math.sin(k * (w.dx * x + w.dz * z) - w.omega * time)
  }
  return h * waveHeight
}

// ── shader pieces ─────────────────────────────────────────────────────────────────────

/**
 * Value noise for the fragment stage. A sine-free hash on purpose: the classic
 * `fract(sin(dot(...)) * 43758)` falls apart at the magnitudes world coordinates times a
 * sparkle frequency reach, and the failure looks like a grid rather than like a bug.
 */
const NOISE_GLSL = /* glsl */ `
float bcHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float bcNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( bcHash( i ), bcHash( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( bcHash( i + vec2( 0.0, 1.0 ) ), bcHash( i + vec2( 1.0, 1.0 ) ), u.x ),
    u.y );
}
float bcFbm( vec2 p ) {
  float sum = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 3; i++ ) {
    sum += bcNoise( p ) * amp;
    p = p * 2.07 + vec2( 17.3, 9.1 );
    amp *= 0.5;
  }
  return sum;
}
`

const VERTEX_PARS = /* glsl */ `
attribute float aDepth;
uniform float uTime;
varying vec2 vWaterXZ;
varying float vWaterDepth;
${wavesGLSL()}
`

const FRAGMENT_PARS = /* glsl */ `
#define BC_MAX_RIPPLES ${MAX_RIPPLES}
#define BC_RIPPLE_LIFE ${RIPPLE_LIFE.toFixed(3)}
#define BC_RIPPLE_SPEED ${RIPPLE_SPEED.toFixed(3)}
varying vec2 vWaterXZ;
varying float vWaterDepth;
uniform float uTime;
uniform float uElapsed;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec2 uOpacity;
uniform float uSparkle;
uniform float uGlow;
uniform float uRippleStrength;
uniform vec4 uRipples[ BC_MAX_RIPPLES ];
${NOISE_GLSL}
`

/**
 * Colour, opacity and foam, decided as soon as `diffuseColor` exists. Everything downstream
 * — lighting, environment, fog — then treats the result like any other surface.
 *
 * The foam is two bands plus a hairline at the waterline, all keyed off the per-vertex
 * depth with a slow noise wobble on the depth itself, so the bands ripple along the shore
 * instead of tracing the terrain's contour lines. They breathe on a long sine, marching a
 * little up the beach and back, the way the real thing does between one wave and the next.
 */
const FRAGMENT_COLOR = /* glsl */ `
#include <color_fragment>
float bcFoam = 0.0;
vec2 bcRippleTilt = vec2( 0.0 );
{
  float depth = vWaterDepth;
  // Depth-driven ramp. The pow keeps the turquoise wide: with a plain smoothstep the
  // shallows are a thin fringe and the water reads as blue, which is not the look.
  float deepT = pow( smoothstep( 0.0, 3.2, depth ), 0.7 );
  vec3 water = mix( uShallow, uDeep, deepT );
  float alpha = mix( uOpacity.x, uOpacity.y, smoothstep( 0.0, 2.4, depth ) );

  // Foam cannot reach depth 1 even at maximum wobble/breathing. Most of an ocean is
  // deeper, so skip the six shoreline noise octaves there. Gameplay ripples still run.
  if ( depth < 1.0 ) {
    // Shoreline foam. The wobble is on the depth, not the band edges, so all three bands
    // wander together and keep their spacing.
    float wobble = ( bcFbm( vWaterXZ * 0.55 + vec2( uTime * 0.11, -uTime * 0.07 ) ) - 0.5 ) * 0.34;
    float breathe = sin( uTime * 0.55 + vWaterXZ.x * 0.05 + vWaterXZ.y * 0.04 ) * 0.045;
    float d = depth + wobble + breathe;
    // Lace along the very edge, a wide band just off it, and a thinner one further out.
    float line = 1.0 - smoothstep( 0.0, 0.05, d );
    float band1 = smoothstep( 0.11, 0.16, d ) * ( 1.0 - smoothstep( 0.27, 0.34, d ) );
    float band2 = smoothstep( 0.46, 0.51, d ) * ( 1.0 - smoothstep( 0.58, 0.66, d ) );
    // A second, finer noise eats holes in the bands so they are lace rather than stripes.
    float holes = smoothstep( 0.32, 0.6, bcFbm( vWaterXZ * 1.9 + vec2( -uTime * 0.2, uTime * 0.13 ) ) );
    bcFoam = clamp( line + band1 * holes + band2 * holes * 0.8, 0.0, 1.0 );
    // Nothing above the waterline: negative depth is under the terrain and is only ever seen
    // for a frame where a crest lifts the surface through a sliver of beach.
    bcFoam *= step( -0.02, depth );
  }

  // Ripple rings, from whatever gameplay has dropped on the surface lately.
  float rippleFoam = 0.0;
  for ( int i = 0; i < BC_MAX_RIPPLES; i++ ) {
    vec4 rp = uRipples[ i ];
    if ( rp.w <= 0.0 ) continue;
    float age = uElapsed - rp.z;
    if ( age < 0.0 || age > BC_RIPPLE_LIFE ) continue;
    vec2 toP = vWaterXZ - rp.xy;
    float r = length( toP );
    float ringR = age * BC_RIPPLE_SPEED;
    float dr = r - ringR;
    float band = exp( -( dr * dr ) / 0.06 ) * rp.w * ( 1.0 - age / BC_RIPPLE_LIFE );
    rippleFoam += band;
    // The ring is a small hump: its slope leans the normal outward on the leading edge and
    // inward on the trailing one, which is what lets the light pick the ring out.
    bcRippleTilt += ( toP / max( r, 0.001 ) ) * ( dr * band );
  }
  rippleFoam *= uRippleStrength;
  bcRippleTilt *= uRippleStrength * 2.4;
  bcFoam = clamp( bcFoam + rippleFoam * 0.8, 0.0, 1.0 );

  // Night takes the saturation out rather than only the brightness: the lights are already
  // low after dark, and a fully saturated turquoise under a dim sun looks lit from within.
  water = mix( water, water * vec3( 0.55, 0.62, 0.78 ), uNight );

  diffuseColor.rgb = mix( water, uFoam, bcFoam );
  diffuseColor.a = mix( alpha, 1.0, bcFoam );
}
`

/** Foam is matte; the water under it is glass. */
const FRAGMENT_ROUGHNESS = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, 0.75, bcFoam );
`

/**
 * The ripple tilt goes onto the normal in view space, where three keeps it, and the
 * grazing-angle opacity rise happens here because this is the first point the shading
 * normal exists. Water seen edge-on is nearly a mirror; seen from above it is a window.
 */
const FRAGMENT_NORMAL = /* glsl */ `
#include <normal_fragment_begin>
{
  vec3 tilt = ( viewMatrix * vec4( bcRippleTilt.x, 0.0, bcRippleTilt.y, 0.0 ) ).xyz;
  normal = normalize( normal + tilt );
  nonPerturbedNormal = normal;
  // Roundoff can put a dot of unit vectors just above 1. Keep pow's base nonnegative.
  float facing = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
  float fresnel = pow( 1.0 - facing, 3.0 );
  diffuseColor.a = mix( diffuseColor.a, 0.98, fresnel * 0.7 );
}
`

/**
 * Sparkle and glow, added to the emissive term so they survive tone mapping as *light*.
 *
 * The sparkle is two scrolling noise fields thresholded hard and multiplied, which leaves
 * only the pixels where both peak — thin, short-lived, and never the same twice — weighted
 * by how close the surface normal is to the sun's half vector, so glints live where the
 * sun would actually reflect. It is pushed well past 1.0 so the bloom pass catches it; the
 * threshold in the engine is 0.92, and a glint that does not bloom is just a white dot.
 */
const FRAGMENT_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 V = normalize( vViewPosition );
  vec3 L = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  vec3 H = normalize( L + V );
  float glint = pow( max( dot( normal, H ), 0.0 ), 48.0 );
  float day = 1.0 - uNight;

  vec2 sp = vWaterXZ * 5.5;
  float n1 = bcNoise( sp + vec2( uTime * 0.9, -uTime * 0.6 ) );
  float n2 = bcNoise( sp * 1.37 + vec2( -uTime * 0.7, uTime * 0.8 ) + 41.7 );
  float sparkle = smoothstep( 0.74, 0.92, n1 ) * smoothstep( 0.74, 0.92, n2 );
  // Only above the horizon, and only where the sun is actually high enough to glint.
  sparkle *= glint * day * smoothstep( 0.05, 0.3, uSunDir.y ) * uSparkle * ( 1.0 - bcFoam );
  totalEmissiveRadiance += vec3( 1.0, 0.98, 0.92 ) * sparkle * 2.6;

  // Foam is lit from within a little so it pops against the shallows, and the moon lays a
  // cool sheen along the swell after dark — kept under the bloom threshold, so it stays a
  // sheen rather than a glow.
  totalEmissiveRadiance += uFoam * bcFoam * 0.18;
  // Lava: the surface is its own light, brightest in the shallows where the crust is thin,
  // and pulsing slowly so it reads as molten rather than painted.
  totalEmissiveRadiance += diffuseColor.rgb * uGlow * ( 0.75 + 0.25 * bcNoise( vWaterXZ * 0.35 + uTime * 0.05 ) );
  totalEmissiveRadiance += vec3( 0.42, 0.52, 0.72 ) * glint * uNight * 0.28;
}
`

// ── the water ─────────────────────────────────────────────────────────────────────────

/**
 * Build the water for a planet, or nothing if it has none.
 *
 * `heightAt(x, z)` is the terrain height field — the same one the terrain mesh was built
 * from — sampled at every vertex to bake the depth attribute. Returns the mesh, the uniform
 * bag, and the per-frame and gameplay hooks.
 */
export function createWater({ planet, heightAt, size = 340, segments, quality = 'medium' } = {}) {
  if (!planet?.water) return null
  const cfg = { ...DEFAULTS, ...planet.water }
  let segs = segments || SEGMENTS[quality] || SEGMENTS.medium

  const uniforms = {
    uTime: { value: 0 },
    uElapsed: { value: 0 },
    uNight: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uShallow: { value: new THREE.Color(cfg.shallow) },
    uDeep: { value: new THREE.Color(cfg.deep) },
    uFoam: { value: new THREE.Color(cfg.foam) },
    uOpacity: { value: new THREE.Vector2(cfg.opacity * 0.6, cfg.opacity) },
    uWaveHeight: { value: cfg.waveHeight },
    uWaveScale: { value: cfg.waveScale },
    uSparkle: { value: cfg.sparkle },
    uGlow: { value: cfg.glow },
    uRippleStrength: { value: cfg.ripples },
    uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 0, 0)) },
  }

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, // replaced outright in the shader; white keeps the maths honest
    roughness: 0.14,
    metalness: 0,
    ior: 1.33,
    envMapIntensity: 1,
    transparent: true,
    // Depth is written so the terrain and anything wading in it sort correctly against
    // the surface; the price is that transparent things *under* the water drawn later are
    // hidden, which is the right answer for a lake.
    depthWrite: true,
    side: THREE.FrontSide,
    fog: true,
  })
  material.name = 'water'
  material.onBeforeCompile = (shader) => {
    withCurve(shader)
    Object.assign(shader.uniforms, uniforms)

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      // The normal chunk runs before the position chunk, so the swell is evaluated here
      // and the position stage reuses it.
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
float bcLift;
vec2 bcSlide;
bcWaves( position.xz, uTime, bcLift, bcSlide, objectNormal );`
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
transformed.y += bcLift;
transformed.xz += bcSlide;
// The pre-slide xz, so ripple centres and foam noise are anchored to the world and do not
// swim sideways with the swell. The lift is folded into the depth so the foam breathes as
// each crest passes over the beach.
vWaterXZ = position.xz;
vWaterDepth = aDepth + bcLift;`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', FRAGMENT_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAGMENT_ROUGHNESS)
      .replace('#include <normal_fragment_begin>', FRAGMENT_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAGMENT_EMISSIVE)
  }
  // Three keys its program cache on the *source text* of `onBeforeCompile` by default, which
  // works but hashes a closure's worth of GLSL on every material check. A fixed name says the
  // same thing in eight characters.
  material.customProgramCacheKey = () => 'bc-water'

  const mesh = new THREE.Mesh(buildGeometry(size, segs, cfg.level, heightAt), material)
  mesh.name = 'water'
  mesh.position.y = cfg.level
  mesh.receiveShadow = true
  // A see-through sheet throwing a shadow on the lakebed reads as a lid, not as water.
  mesh.castShadow = false
  // Before every other transparent thing. Three sorts transparent objects by distance to
  // their centre, and this one's centre is the middle of the world, so left to chance a
  // splash particle or a name plate hovering over the lake would draw first and then be
  // painted over by the surface.
  mesh.renderOrder = -10

  let elapsedNow = 0
  let nextSlot = 0

  return {
    mesh,
    uniforms,

    /** Once a frame. `night` is the sky's night factor, `sunDir` its sun direction. */
    update(dt, elapsed, camera, night = 0, sunDir = null) {
      elapsedNow = elapsed
      uniforms.uTime.value = elapsed * cfg.speed
      uniforms.uElapsed.value = elapsed
      uniforms.uNight.value = night
      if (sunDir) uniforms.uSunDir.value.copy(sunDir)
      // Retire rings that have faded, so the shader's early-out sees a zero strength rather
      // than doing the age arithmetic for a ring nobody can see.
      for (const rp of uniforms.uRipples.value) {
        if (rp.w > 0 && elapsed - rp.z > RIPPLE_LIFE) rp.w = 0
      }
    },

    /** Drop a ring on the surface at a world xz. Slots are recycled oldest-first. */
    ripple(x, z, strength = 1) {
      uniforms.uRipples.value[nextSlot].set(x, z, elapsedNow, strength)
      nextSlot = (nextSlot + 1) % MAX_RIPPLES
    },

    /**
     * World-space surface height at a point, for anything that floats. The same sum as the
     * vertex shader's lift, minus the Gerstner slide — which moves the surface a hand's
     * width sideways at most, and matters to nothing that bobs.
     */
    heightAt(x, z, elapsed = elapsedNow) {
      return cfg.level + waveLift(x, z, elapsed * cfg.speed, uniforms.uWaveHeight.value, uniforms.uWaveScale.value)
    },

    /** Swap the tessellation. Only the geometry changes; the program is untouched. */
    setQuality(q) {
      const next = SEGMENTS[q] || SEGMENTS.medium
      if (next === segs) return
      segs = next
      mesh.geometry.dispose()
      mesh.geometry = buildGeometry(size, segs, cfg.level, heightAt)
    },

    dispose() {
      mesh.geometry.dispose()
      material.dispose()
      mesh.parent?.remove(mesh)
    },
  }
}

/**
 * A flat plane with the water's depth over the terrain baked in per vertex. Built in xy and
 * laid flat, the way the terrain is, so the two share a vertex layout and the plane's own
 * xz is world xz once the mesh is parked at the origin.
 */
function buildGeometry(size, segments, level, heightAt) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const depth = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    depth[i] = level - heightAt(pos.getX(i), pos.getZ(i))
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1))
  return geo
}
