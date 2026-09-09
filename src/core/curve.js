import * as THREE from 'three'

/**
 * The world curves away from you.
 *
 * Animal Crossing's signature trick: ground ahead of the camera drops off with the square of
 * how far ahead it is, so the horizon bows and the whole place reads as a small round world
 * rather than a flat plane going on forever. It is done here in *world* space, keyed off the
 * point the camera is looking at, rather than in view space the way most curved-world shaders
 * do it — because the shadow pass renders the same geometry from the sun's point of view, and
 * a bend expressed in the main camera's view space would put every shadow somewhere the object
 * it belongs to is not. Bent in world space, the depth pass bends identically and the shadows
 * stay under their buildings.
 *
 * Two knobs: the bend falls off *ahead* of the focus with one strength and *sideways* with a
 * quarter of it, so the far side of the colony dips like a horizon while the near edge, which
 * is at the bottom of the screen and close to the eye, stays where it is.
 *
 * It is wired into every material at once by patching three's own shader chunks: anything
 * that goes through `project_vertex` bends, which is every built-in material and every
 * `onBeforeCompile` on top of one — buildings, crew, terrain, scatter, water. The handful of
 * shaders that project by hand (billboards, particles) include `bc_curve_pars` and call
 * `bcBend` themselves. Sky, stars and the post chain are pinned to the camera and stay flat.
 *
 * Three's built-in materials pick the uniforms up from a default `onBeforeCompile` set on the
 * material prototype; a material that installs its *own* `onBeforeCompile` has to call
 * `withCurve(shader)` inside it, because that override replaces the prototype's.
 */

export const curveUniforms = {
  /** Where the camera is looking. Only xz is read. */
  uCurveFocus: { value: new THREE.Vector3() },
  /** The camera's forward direction flattened onto the ground, unit length. */
  uCurveForward: { value: new THREE.Vector2(0, 1) },
  /** Drop per unit of distance squared. Zero is a flat world. */
  uCurveAmount: { value: 0 },
}

/** How much the slider is worth: 1.0 on the slider is this much drop per unit². */
export const CURVE_FULL = 0.0055

export const CURVE_PARS = /* glsl */ `
#ifndef BC_CURVE_PARS
#define BC_CURVE_PARS
uniform vec3 uCurveFocus;
uniform vec2 uCurveForward;
uniform float uCurveAmount;
// Drop a world-space point toward the horizon: hard with the square of how far *ahead* of
// the focus it is, gently with how far to either side. C1 at the focus, so nothing kinks.
vec3 bcBend( vec3 p ) {
  vec2 d = p.xz - uCurveFocus.xz;
  float ahead = max( 0.0, dot( d, uCurveForward ) );
  float side = dot( d, d );
  p.y -= uCurveAmount * ( ahead * ahead + side * 0.22 );
  return p;
}
#endif
`

/** Add the curve uniforms to a shader being customised by hand. Idempotent. */
export function withCurve(shader) {
  Object.assign(shader.uniforms, curveUniforms)
  return shader
}

let installed = false

/**
 * Patch three's shader chunks so every material bends. Call once, before anything compiles.
 */
export function installWorldCurve() {
  if (installed) return
  installed = true
  const chunk = THREE.ShaderChunk

  chunk.bc_curve_pars = CURVE_PARS
  // `common` is included by every built-in shader — and by most hand-written ones — in both
  // stages, which is the one place a declaration can go and be certain of arriving. The guard
  // in CURVE_PARS keeps a shader that includes both from declaring twice.
  chunk.common = `${chunk.common}\n${CURVE_PARS}`

  // Three's own project_vertex, with the world position pulled out and bent before the view
  // transform. Batching and instancing land in world space first, exactly as upstream.
  chunk.project_vertex = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
vec4 bcWorldPos = modelMatrix * mvPosition;
bcWorldPos.xyz = bcBend( bcWorldPos.xyz );
mvPosition = viewMatrix * bcWorldPos;
gl_Position = projectionMatrix * mvPosition;
`

  // The world position the shadow, env-map and fog code reads has to be the bent one too, or
  // shadows are looked up where the flat geometry would have been.
  chunk.worldpos_vertex = /* glsl */ `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
	worldPosition.xyz = bcBend( worldPosition.xyz );
#endif
`

  // Built-in materials have no onBeforeCompile of their own, so the prototype's is what runs
  // — and that is where the uniforms every program now declares get their shared values.
  THREE.Material.prototype.onBeforeCompile = function (shader) {
    withCurve(shader)
  }
}

/**
 * Apply the same bend on the CPU, so anything that projects a world point to the screen —
 * picking an astronaut, parking the thread card beside it, hit-testing a name plate — lands
 * where the shader actually drew it.
 */
export function bendPoint(v) {
  const amount = curveUniforms.uCurveAmount.value
  if (amount === 0) return v
  const f = curveUniforms.uCurveFocus.value
  const fwd = curveUniforms.uCurveForward.value
  const dx = v.x - f.x
  const dz = v.z - f.z
  const ahead = Math.max(0, dx * fwd.x + dz * fwd.y)
  const side = dx * dx + dz * dz
  v.y -= amount * (ahead * ahead + side * 0.22)
  return v
}

/** Feed the camera's focus and heading in, once a frame. */
export function setCurveView(focus, azimuth, amount) {
  curveUniforms.uCurveFocus.value.copy(focus)
  // The camera sits at +sin/+cos of the azimuth from the target, so forward is the reverse.
  curveUniforms.uCurveForward.value.set(-Math.sin(azimuth), -Math.cos(azimuth))
  curveUniforms.uCurveAmount.value = amount
}
