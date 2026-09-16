import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/** Small-scale, depth-derived contact shading. Uses the actual skinned/curved scene depth,
 * so no override-material geometry pass can disagree with the visible bots or terrain. */
export class OcclusionPass extends Pass {
  constructor(camera) {
    super()
    this.camera = camera
    // Keep the scene's depth attachment where RenderPass left it. An extra composer swap
    // here would make tilt-shift read from its own destination depth on alternate frames.
    this.needsSwap = false
    this.target = null
    this.width = 1
    this.height = 1
    this.material = new THREE.ShaderMaterial({
      name: 'ContactOcclusion', vertexShader, depthTest: false, depthWrite: false,
      uniforms: {
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uProjectionScale: { value: new THREE.Vector2() },
        uStrength: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        uniform sampler2D tDepth;
        uniform vec2 uTexel;
        uniform mat4 uProjectionInverse;
        uniform vec2 uProjectionScale;
        uniform float uStrength;
        varying vec2 vUv;

        vec3 viewPosition(vec2 uv, float depth) {
          vec4 p = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          return p.xyz / max(p.w, 0.000001);
        }
        vec3 positionAt(vec2 uv) {
          return viewPosition(uv, texture2D(tDepth, uv).r);
        }

        void main() {
          float depth = texture2D(tDepth, vUv).r;
          // Sky, and the outermost texel where normal reconstruction has no neighbours.
          if (depth >= 0.999999 || any(lessThan(vUv, uTexel)) || any(greaterThan(vUv, 1.0 - uTexel))) {
            gl_FragColor = vec4(1.0); return;
          }
          vec3 p = viewPosition(vUv, depth);
          vec3 l = positionAt(vUv - vec2(uTexel.x, 0.0));
          vec3 r = positionAt(vUv + vec2(uTexel.x, 0.0));
          vec3 b = positionAt(vUv - vec2(0.0, uTexel.y));
          vec3 t = positionAt(vUv + vec2(0.0, uTexel.y));
          // Choose the neighbour on the same surface at silhouettes. A cross-edge normal
          // would invent dark outlines around every roof and antenna against the sky.
          vec3 dx = abs(l.z - p.z) < abs(r.z - p.z) ? p - l : r - p;
          vec3 dy = abs(b.z - p.z) < abs(t.z - p.z) ? p - b : t - p;
          vec3 n = cross(dx, dy);
          float n2 = dot(n, n);
          if (n2 < 1e-18) { gl_FragColor = vec4(1.0); return; }
          n *= inversesqrt(max(n2, 1e-18));
          if (dot(n, -p) < 0.0) n = -n;

          const float RADIUS = 0.32;
          vec2 uvRadius = uProjectionScale * RADIUS / max(-p.z, 0.01);
          // Smoothly vanish below a pixel, rather than resolve into moving black specks
          // when the user zooms out. Bound the close-up footprint as well.
          float radiusPixels = uvRadius.y / uTexel.y;
          float visibility = smoothstep(0.75, 2.5, radiusPixels);
          uvRadius *= min(1.0, 40.0 / max(radiusPixels, 0.001));
          float occlusion = 0.0;
          // A fixed spiral, with no random rotation, temporal noise or accumulated history.
          // The same camera and geometry always produce exactly the same shading.
          for (int i = 0; i < 16; i++) {
            float f = (float(i) + 0.5) / 16.0;
            float angle = float(i) * 2.39996323;
            vec2 uv = vUv + vec2(cos(angle), sin(angle)) * sqrt(f) * uvRadius;
            if (any(lessThan(uv, uTexel)) || any(greaterThan(uv, 1.0 - uTexel))) continue;
            float sampleDepth = texture2D(tDepth, uv).r;
            if (sampleDepth >= 0.999999) continue;
            vec3 delta = viewPosition(uv, sampleDepth) - p;
            float distance2 = dot(delta, delta);
            float distance = sqrt(max(distance2, 1e-10));
            // Only nearby geometry above the surface can occlude it. Distant buildings
            // behind a silhouette, and flat/convex parts of the suit, contribute nothing.
            float horizon = max(0.0, dot(n, delta) / distance - 0.12);
            float falloff = 1.0 - smoothstep(RADIUS * 0.2, RADIUS, distance);
            occlusion += horizon * falloff;
          }
          float shade = 1.0 - uStrength * visibility * min(0.70, occlusion * (3.0 / 16.0));
          gl_FragColor = vec4(vec3(shade), 1.0);
        }
      `,
    })
    this.multiply = new THREE.ShaderMaterial({
      name: 'ApplyContactOcclusion', vertexShader, depthTest: false, depthWrite: false,
      blending: THREE.MultiplyBlending, premultipliedAlpha: true, transparent: true, toneMapped: false,
      uniforms: { tOcclusion: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) } },
      fragmentShader: /* glsl */ `
        uniform sampler2D tOcclusion;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          // A compact, fixed Gaussian softens sample footprints at high strength without
          // any temporal noise, extra scene draws, or a large halo around silhouettes.
          float shade = 0.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            float weight = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
            shade += texture2D(tOcclusion, vUv + vec2(float(x), float(y)) * uTexel * 1.5).r * weight;
          }
          gl_FragColor = vec4(vec3(shade / 16.0), 1.0);
        }
      `,
    })
    this.quad = new FullScreenQuad(this.material)
    this.setStrength(0)
  }

  setStrength(value) {
    const strength = Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 0
    this.material.uniforms.uStrength.value = strength
    this.enabled = strength > 0
    // Zero is genuinely off: release the extra target and skip both fullscreen draws.
    if (!this.enabled && this.target) {
      this.target.dispose()
      this.target = null
      this.multiply.uniforms.tOcclusion.value = null
    }
  }

  setSize(width, height) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.target?.setSize(this.width, this.height)
    this.material.uniforms.uTexel.value.set(1 / this.width, 1 / this.height)
    this.multiply.uniforms.uTexel.value.copy(this.material.uniforms.uTexel.value)
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.enabled || !readBuffer.depthTexture) return
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(this.width, this.height, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType,
        depthBuffer: false, stencilBuffer: false,
      })
      this.multiply.uniforms.tOcclusion.value = this.target.texture
    }
    const u = this.material.uniforms
    u.tDepth.value = readBuffer.depthTexture
    u.uProjectionInverse.value.copy(this.camera.projectionMatrixInverse)
    const m = this.camera.projectionMatrix.elements
    u.uProjectionScale.value.set(m[0] * 0.5, m[5] * 0.5)
    const autoClear = renderer.autoClear
    try {
      renderer.autoClear = false
      this.quad.material = this.material
      renderer.setRenderTarget(this.target)
      this.quad.render(renderer)
      // Hardware multiplication does not sample the destination colour or depth. The
      // scene's depth remains intact for tilt-shift, and no texture feedback loop occurs.
      this.quad.material = this.multiply
      renderer.setRenderTarget(readBuffer)
      this.quad.render(renderer)
    } finally {
      renderer.autoClear = autoClear
    }
  }

  dispose() {
    this.target?.dispose()
    this.target = null
    this.material.dispose()
    this.multiply.dispose()
    this.quad.dispose()
  }
}
