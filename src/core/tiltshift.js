import * as THREE from 'three'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/**
 * Tilt-shift as an actual lens rather than as a filter.
 *
 * The first version of this blurred a fixed band across the *screen*, which is the cheap way
 * the effect is usually faked. It has one fatal tell: it knows nothing about the scene. Zoom
 * into a single building and everything in frame is at the same distance, yet the top and
 * bottom of the picture stay smeared — because the blur was never about the scene, only
 * about where a pixel happened to sit on the glass.
 *
 * So this reads the depth buffer and blurs by how far each pixel is from a **plane of
 * focus**, which is what a camera does. Two consequences worth having:
 *
 *   - Focus follows the camera. The plane sits at whatever the view is orbiting, so the thing
 *     you are looking at is sharp at every zoom, and it is the ground falling away in front
 *     and behind that goes soft.
 *   - The plane can be *tilted*. On a real tilt-shift lens that is the whole trick — tilting
 *     the front element swings the plane of focus out of parallel with the sensor (the
 *     Scheimpflug principle), so a slice of ground running away from you can be held sharp
 *     while everything either side of it falls off. That is what `angle` now means.
 *
 * The miniature illusion comes from the depth of field being far too shallow for the size of
 * the thing you are looking at — your eye reads that as "small and close", not "large and far".
 *
 * ── Why the two passes differ ──
 * A separable gaussian is 2n taps rather than n², so this is a horizontal pass then a vertical
 * one. Only the first reads depth; the second takes the blur amount it computed out of the
 * alpha channel. That is not a micro-optimisation, it is a correctness requirement: after the
 * first pass the composer has swapped buffers, and the target the second pass draws into is
 * the very one the depth texture is attached to. Sampling it there would be a feedback loop.
 */

/** The widest the blur ever gets, as a share of frame height, at full strength. */
const MAX_RADIUS = 0.02

const common = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    /** (1,0) horizontal, (0,1) vertical. */
    uAxis: { value: new THREE.Vector2(1, 0) },
    /** Blur radius in pixels for a pixel fully out of focus. */
    uMaxRadius: { value: 8 },
    /** Distance from the camera to the plane of focus, in world units. */
    uFocusDistance: { value: 30 },
    /** How far from that plane a pixel has to be before it is blurred as hard as it gets. */
    uFocusRange: { value: 20 },
    /** Plane-of-focus tilt in radians. 0 is square to the view, as an ordinary lens is. */
    uTilt: { value: 0 },
    uNear: { value: 0.1 },
    uFar: { value: 500 },
    uTanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(38) / 2) },
    uAspect: { value: 1 },
    uProjectionOffset: { value: new THREE.Vector2() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform vec2 uAxis;
    uniform float uMaxRadius;
    varying vec2 vUv;

    #ifdef COC_FROM_DEPTH
      uniform sampler2D tDepth;
      uniform float uFocusDistance;
      uniform float uFocusRange;
      uniform float uTilt;
      uniform float uNear;
      uniform float uFar;
      uniform float uTanHalfFov;
      uniform float uAspect;
      uniform vec2 uProjectionOffset;

      /** Window depth back to view space. Negative in front of the camera. */
      float viewZOf( float depth ) {
        float ndc = depth * 2.0 - 1.0;
        return -( 2.0 * uNear * uFar ) / ( uFar + uNear - ndc * ( uFar - uNear ) );
      }

      float circleOfConfusion() {
        float depth = texture2D( tDepth, vUv ).x;

        // An unbound depth texture samples as 0, which is the near plane — a distance
        // nothing is ever drawn at. Treating that as "no depth available, leave it sharp"
        // means a half-wired frame shows the scene rather than a full-screen smear.
        if ( depth <= 0.0 ) return 0.0;

        // The sky is at the far plane and has no business anchoring focus — it is simply the
        // furthest thing there is, so it takes the maximum blur and stays there.
        if ( depth >= 0.9999 ) return 1.0;

        float dist = -viewZOf( depth );

        // Rebuild the view-space point. A tilted plane is only meaningful against a real
        // position; measuring along the view axis alone would ignore the tilt entirely.
        vec2 ndc = vUv * 2.0 - 1.0 + uProjectionOffset;
        vec3 viewPos = vec3( ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0 ) * dist;

        // Signed distance to the plane of focus, tilted about the horizontal axis.
        vec3 planeNormal = vec3( 0.0, sin( uTilt ), cos( uTilt ) );
        float signedDist = dot( viewPos - vec3( 0.0, 0.0, -uFocusDistance ), planeNormal );

        return clamp( abs( signedDist ) / max( uFocusRange, 0.0001 ), 0.0, 1.0 );
      }
    #endif

    /**
     * Taps per side. Spacing is the radius over this, so the kernel stays properly sampled
     * at every radius rather than the taps drifting apart as the blur widens — which is what
     * turns a blur into visible copies of the picture.
     */
    const int STEPS = 8;

    void main() {
      #ifdef COC_FROM_DEPTH
        float coc = circleOfConfusion();
      #else
        float coc = texture2D( tDiffuse, vUv ).a;
      #endif

      float radius = uMaxRadius * coc;

      // Under about a third of a pixel there is nothing to gather that the centre tap does
      // not already have, and the whole in-focus band takes this branch.
      if ( radius < 0.35 ) {
        gl_FragColor = vec4( texture2D( tDiffuse, vUv ).rgb, COC_OUT );
        return;
      }

      vec2 unit = uAxis * uTexel;
      vec4 sum = texture2D( tDiffuse, vUv );
      float weight = 1.0;

      for ( int i = 1; i <= STEPS; i++ ) {
        float fraction = float( i ) / float( STEPS );
        float offset = fraction * radius;
        // Sigma is radius/3: the radius cancels out of the Gaussian exponent. These
        // weights are constant, so the compiler can fold them instead of doing eight
        // exponentials per blurred pixel in each pass.
        float w = exp( -4.5 * fraction * fraction );
        sum += texture2D( tDiffuse, vUv + unit * offset ) * w;
        sum += texture2D( tDiffuse, vUv - unit * offset ) * w;
        weight += 2.0 * w;
      }

      gl_FragColor = vec4( ( sum / weight ).rgb, COC_OUT );
    }
  `,
}

/**
 * The pair of passes, already oriented and already told which of them owns the depth read.
 * Kept together so the caller sets a size, a strength or a focus once and both halves agree —
 * a horizontal pass blurring harder than the vertical one reads as smearing, not as defocus.
 */
export function createTiltShift() {
  // The first pass computes the blur amount and hands it on in alpha; the second consumes it.
  const horizontal = new ShaderPass({ ...common, defines: { COC_FROM_DEPTH: '', COC_OUT: 'coc' } })
  const vertical = new ShaderPass({ ...common, defines: { COC_OUT: '1.0' } })
  horizontal.uniforms.uAxis.value.set(1, 0)
  vertical.uniforms.uAxis.value.set(0, 1)

  const passes = [horizontal, vertical]
  const set = (name, value) => {
    for (const p of passes) p.uniforms[name].value = value
  }

  let amount = 0.4
  let frameHeight = 1080
  let focusDistance = 30

  const applyDerived = () => {
    set('uMaxRadius', amount * MAX_RADIUS * frameHeight)
    set('uFocusDistance', focusDistance)
    // The sharp slab is a share of how far away you are focused rather than a fixed depth,
    // so pulling the camera back does not drop the whole colony out of focus at once. Turning
    // the effect up makes it shallower as well as blurrier, which is what a wider aperture
    // actually does — doing only one of the two reads as a smeared photograph.
    set('uFocusRange', focusDistance * (0.8 + (0.08 - 0.8) * amount))
  }

  return {
    passes,
    set enabled(on) {
      for (const p of passes) p.enabled = on
    },
    get enabled() {
      return horizontal.enabled
    },
    /** The depth the scene was drawn with — see the note about which pass may read it. */
    setDepthTexture(texture) {
      horizontal.uniforms.tDepth.value = texture
    },
    /** 0..1, where 1 is `MAX_RADIUS` of frame height and the shallowest focus. */
    setStrength(v) {
      amount = Math.max(0, Math.min(1, v))
      applyDerived()
    },
    /** Degrees, so the caller and the settings panel agree on the unit. */
    setAngle(degrees) {
      set('uTilt', (degrees * Math.PI) / 180)
    },
    /** Whatever the view is orbiting is what should be sharp. */
    setFocusDistance(distance) {
      focusDistance = Math.max(0.1, distance)
      applyDerived()
    },
    /** Projection terms, needed to turn a depth sample back into a view-space position. */
    setCamera(camera) {
      set('uNear', camera.near)
      set('uFar', camera.far)
      set('uAspect', camera.aspect)
      set('uTanHalfFov', Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
      const m = camera.projectionMatrix.elements
      for (const p of passes) p.uniforms.uProjectionOffset.value.set(m[8], m[9])
    },
    /**
     * Texel size follows the drawing buffer so a step of N pixels really is N pixels, and the
     * radius is recomputed from the new height so the effect keeps its apparent size when
     * render scale or the window moves.
     */
    setSize(width, height) {
      frameHeight = Math.max(1, height)
      for (const p of passes) p.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / frameHeight)
      applyDerived()
    },
  }
}
