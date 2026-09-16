import * as THREE from 'three'
import { bendPoint, curveUniforms } from '../core/curve.js'

// A small local probe supplements the distant sky, only on the crew's glass. Keeping
// the sky as scene.environment avoids reflection feedback and relighting the colony.
export function reflectionUniforms() {
  return {
    uReflectionA: { value: null }, uReflectionB: { value: null },
    uReflectionPosA: { value: new THREE.Vector3() },
    uReflectionPosB: { value: new THREE.Vector3() },
    uReflectionMix: { value: 1 }, uReflectionReady: { value: 0 },
  }
}

export function withLocalReflections(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = `varying vec3 vReflectionPosition;\n${shader.vertexShader}`.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
     vec4 reflectionPosition = vec4( transformed, 1.0 );
     #ifdef USE_INSTANCING
       reflectionPosition = instanceMatrix * reflectionPosition;
     #endif
     vReflectionPosition = ( modelMatrix * reflectionPosition ).xyz;`
  )
  // The glass is nearly polished, so the cube's bilinear/mipmap filtering is enough;
  // no per-agent render, screen-space history, or additional PMREM convolution pass.
  shader.fragmentShader = `
    uniform samplerCube uReflectionA;
    uniform samplerCube uReflectionB;
    uniform vec3 uReflectionPosA;
    uniform vec3 uReflectionPosB;
    uniform float uReflectionMix;
    uniform float uReflectionReady;
    varying vec3 vReflectionPosition;
    vec3 localGlassReflection( vec3 sky, vec3 direction, float roughness ) {
      if ( uReflectionReady <= 0.0 ) return sky;
      float reachA = 1.0 - smoothstep( 3.0, 10.0, distance( vReflectionPosition, uReflectionPosA ) );
      float reachB = 1.0 - smoothstep( 3.0, 10.0, distance( vReflectionPosition, uReflectionPosB ) );
      // A 128px cube has seven mip levels; soften subpixel edges as the visor shrinks.
      float footprint = max( length( dFdx( direction ) ), length( dFdy( direction ) ) );
      float lod = clamp( max( roughness * 7.0, log2( max( 1.0, footprint * 128.0 ) ) ), 0.0, 7.0 );
      vec3 a = textureLod( uReflectionA, direction, lod ).rgb;
      vec3 b = textureLod( uReflectionB, direction, lod ).rgb;
      return mix( sky, mix( mix( sky, a, reachA ), mix( sky, b, reachB ), uReflectionMix ), uReflectionReady );
    }
  \n${shader.fragmentShader}`.replace(
    '#include <envmap_physical_pars_fragment>',
    THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
      'return envMapColor.rgb * envMapIntensity;',
      'return localGlassReflection( envMapColor.rgb, reflectVec, roughness ) * envMapIntensity;'
    )
  )
}

/** One shared, local scenery capture. Six faces are scheduled across six frames, with
 * two buffers: an incomplete cube is never sampled. Complete captures crossfade; during
 * that fade neither buffer is overwritten. Distant agents fall back to the planet sky. */
export class SceneryReflections {
  constructor({ scene, renderer, settings, sky, astronauts, excluded = () => [] }) {
    Object.assign(this, { scene, renderer, settings, sky, astronauts, excluded })
    this.uniforms = astronauts.reflectionUniforms
    this.targets = null
    this.face = -1
    this.published = -1
    this.lastCapture = -Infinity
    this.clock = 0
    this.blend = 1
    this.anchor = new THREE.Vector3()
    this.position = new THREE.Vector3()
    this._point = new THREE.Vector3()
    this._projected = new THREE.Vector3()
    this._matrix = new THREE.Matrix4()
    this.stats = { captures: 0, faces: 0, lastFaceCalls: 0 }
  }

  invalidate() {
    this.face = -1
    this.published = -1
    this.lastCapture = -Infinity
    this.uniforms.uReflectionReady.value = 0
    this.uniforms.uReflectionMix.value = 1
    this.blend = 1
  }

  _allocate() {
    this.targets = [0, 1].map(() => new THREE.WebGLCubeRenderTarget(128, {
      type: THREE.HalfFloatType, generateMipmaps: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    }))
    this.cube = new THREE.CubeCamera(0.06, 500, this.targets[0])
    this.cube.coordinateSystem = this.renderer.coordinateSystem
    this.cube.updateCoordinateSystem()
  }

  _chooseAnchor(focus, camera) {
    let closest = Infinity, chosen = null
    camera.updateMatrixWorld()
    for (const agent of this.astronauts._drawnAgents) {
      if (agent.scale < 0.8) continue
      this.astronauts.parts.visor.getMatrixAt(agent.index, this._matrix)
      this._point.setFromMatrixPosition(this._matrix)
      const bent = bendPoint(this._projected.copy(this._point))
      // Skip reflections when every visor is too small or outside the view.
      if (bent.distanceToSquared(camera.position) > 35 * 35) continue
      bent.project(camera)
      if (Math.abs(bent.x) > 1.15 || Math.abs(bent.y) > 1.15 || bent.z > 1 || bent.z < -1) continue
      const distance = this._point.distanceToSquared(focus)
      const score = agent === this.astronauts.selected ? -1 : distance
      if (score < closest) {
        closest = score; chosen = agent
        this.anchor.copy(this._point)
      }
    }
    return chosen
  }

  update(dt, focus, camera) {
    if (!this.renderer) return
    this.clock += Math.min(Math.max(dt, 0), 0.1)
    if (!this.settings.get('ibl')) {
      if (this.targets) this._release()
      return
    }
    // A quality change disposes the sun's shadow map. Let the main view recreate it
    // before reusing it here: a null comparison shadow sampler is invalid in WebGL.
    if (this.renderer.shadowMap.enabled && this.sky.sun?.castShadow && !this.sky.sun.shadow.map) return
    const u = this.uniforms
    // Changes to mesh capacity rebuild materials, but keep this uniform block alive.
    this.blend = Math.min(1, this.blend + Math.max(dt, 0) / 0.4)
    u.uReflectionMix.value = THREE.MathUtils.smoothstep(this.blend, 0, 1)
    u.uReflectionReady.value = this.published < 0 ? 0 : Math.min(1, u.uReflectionReady.value + Math.max(dt, 0) / 0.4)
    if (this.face < 0) {
      if (this.blend < 1 || !this.scene.environment || !this._chooseAnchor(focus, camera)) return
      const age = this.clock - this.lastCapture
      if (age < 0.7 || (age < 2.5 && this.anchor.distanceToSquared(this.position) < 0.75 ** 2)) return
      if (!this.targets) this._allocate()
      this.writing = this.published === 0 ? 1 : 0
      // Stop sampling the spare buffer before any of its faces are changed.
      if (this.published >= 0) {
        u.uReflectionA.value = u.uReflectionB.value
        u.uReflectionPosA.value.copy(u.uReflectionPosB.value)
      }
      this.position.copy(this.anchor)
      this.cube.position.copy(bendPoint(this.anchor.clone()))
      this.cube.updateMatrixWorld(true)
      this.captureCurve = {
        amount: curveUniforms.uCurveAmount.value,
        focus: curveUniforms.uCurveFocus.value.clone(),
        forward: curveUniforms.uCurveForward.value.clone(),
      }
      this.face = 0
    }
    this._captureFace()
    if (++this.face === 6) {
      const texture = this.targets[this.writing].texture
      // First capture fades in from the sky; later captures blend from the previous cube.
      if (this.published < 0) {
        u.uReflectionA.value = texture
        u.uReflectionPosA.value.copy(this.position)
      }
      u.uReflectionB.value = texture
      u.uReflectionPosB.value.copy(this.position)
      this.published = this.writing
      this.face = -1; this.blend = 0
      u.uReflectionMix.value = 0
      this.lastCapture = this.clock
      this.stats.captures++
    }
  }

  _captureFace() {
    const r = this.renderer, target = this.targets[this.writing]
    const previous = {
      target: r.getRenderTarget(), face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(),
      autoClear: r.autoClear, shadowAuto: r.shadowMap.autoUpdate, shadowNeeds: r.shadowMap.needsUpdate,
      xr: r.xr.enabled, dome: this.sky.dome.position.clone(),
      curve: curveUniforms.uCurveAmount.value,
      focus: curveUniforms.uCurveFocus.value.clone(),
      forward: curveUniforms.uCurveForward.value.clone(),
    }
    const hidden = [this.astronauts.group, this.sky.stars, this.sky.companion, ...this.excluded()]
      .filter(Boolean).map(object => [object, object.visible])
    try {
      for (const [object] of hidden) object.visible = false
      this.sky.dome.position.copy(this.cube.position)
      // Hold the camera-dependent bend steady across all six faces.
      curveUniforms.uCurveAmount.value = this.captureCurve.amount
      curveUniforms.uCurveFocus.value.copy(this.captureCurve.focus)
      curveUniforms.uCurveForward.value.copy(this.captureCurve.forward)
      r.xr.enabled = false
      r.autoClear = true
      r.shadowMap.autoUpdate = false
      r.shadowMap.needsUpdate = false
      target.texture.generateMipmaps = this.face === 5
      r.setRenderTarget(target, this.face)
      const calls = r.info.render.calls
      r.render(this.scene, this.cube.children[this.face])
      this.stats.lastFaceCalls = r.info.autoReset ? r.info.render.calls : r.info.render.calls - calls
      this.stats.faces++
    } finally {
      for (const [object, visible] of hidden) object.visible = visible
      this.sky.dome.position.copy(previous.dome)
      curveUniforms.uCurveAmount.value = previous.curve
      curveUniforms.uCurveFocus.value.copy(previous.focus)
      curveUniforms.uCurveForward.value.copy(previous.forward)
      r.xr.enabled = previous.xr
      r.autoClear = previous.autoClear
      r.shadowMap.autoUpdate = previous.shadowAuto
      r.shadowMap.needsUpdate = previous.shadowNeeds
      r.setRenderTarget(previous.target, previous.face, previous.mip)
    }
  }

  _release() {
    this.invalidate()
    this.uniforms.uReflectionA.value = null
    this.uniforms.uReflectionB.value = null
    for (const target of this.targets || []) target.dispose()
    this.targets = null
    this.cube = null
  }

  dispose() { this._release() }
}
