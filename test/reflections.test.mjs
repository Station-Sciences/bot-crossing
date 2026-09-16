import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { SceneryReflections, reflectionUniforms } from '../src/world/reflections.js'
import { curveUniforms } from '../src/core/curve.js'

function fixture() {
  const scene = new THREE.Scene()
  scene.environment = new THREE.Texture()
  const settings = { ibl: true, get(key) { return this[key] } }
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500)
  camera.position.set(0, 1, 3); camera.lookAt(0, 1, 0)
  const focus = new THREE.Vector3(0, 1, 0)
  const excluded = new THREE.Object3D(); excluded.visible = false
  const sky = { dome: new THREE.Object3D(), stars: new THREE.Object3D(), companion: new THREE.Object3D() }
  sky.dome.position.set(0, 3, 9)
  const crew = {
    reflectionUniforms: reflectionUniforms(), group: new THREE.Object3D(),
    _drawnAgents: [{ index: 0, scale: 1 }],
    parts: { visor: { getMatrixAt(index, out) { out.makeTranslation(0, 1, 0) } } },
  }
  const oldTarget = new THREE.WebGLRenderTarget(8, 8)
  const renderer = {
    target: oldTarget, face: 3, mip: 1, coordinateSystem: THREE.WebGLCoordinateSystem,
    autoClear: false, xr: { enabled: true }, shadowMap: { autoUpdate: true, needsUpdate: true },
    info: { autoReset: false, render: { calls: 11 } }, samples: [],
    getRenderTarget() { return this.target }, getActiveCubeFace() { return this.face },
    getActiveMipmapLevel() { return this.mip },
    setRenderTarget(target, face = 0, mip = 0) { Object.assign(this, { target, face, mip }) },
    render() {
      assert.equal(crew.group.visible, false, 'no self-reflections or feedback')
      assert.equal(sky.stars.visible, false)
      assert.equal(excluded.visible, false)
      assert.equal(this.shadowMap.autoUpdate, false, 'do not recalculate shadows for each cube face')
      assert.notEqual(crew.reflectionUniforms.uReflectionA.value, this.target.texture)
      assert.notEqual(crew.reflectionUniforms.uReflectionB.value, this.target.texture)
      this.samples.push(this.face); this.info.render.calls++
    },
  }
  const reflections = new SceneryReflections({ scene, renderer, settings, sky, astronauts: crew, excluded: () => [excluded] })
  const step = (n = 1) => { for (let i = 0; i < n; i++) reflections.update(1 / 60, focus, camera) }
  return { reflections, step, renderer, oldTarget, scene, sky, crew, excluded, settings, camera }
}

test('publish only complete cubes; never render into a cube being sampled, including during fades', () => {
  const { reflections: r, step, renderer, crew } = fixture()
  const u = crew.reflectionUniforms
  step(5)
  assert.equal(r.stats.captures, 0); assert.equal(u.uReflectionReady.value, 0)
  assert.equal(u.uReflectionB.value, null)
  step()
  assert.deepEqual(renderer.samples, [0, 1, 2, 3, 4, 5])
  assert.equal(r.stats.captures, 1)
  const first = u.uReflectionB.value
  step(24)
  assert.ok(u.uReflectionReady.value > 0.99)
  r.lastCapture = -Infinity
  step(6)
  assert.equal(r.stats.captures, 2)
  assert.equal(u.uReflectionA.value, first)
  assert.notEqual(u.uReflectionB.value, first)
  r.lastCapture = -Infinity
  step(10)
  assert.equal(r.stats.faces, 12, 'both buffers remain intact while blending')
  step(20)
  assert.equal(r.stats.captures, 3)
  r.dispose()
})

test('capture restores visibility, render target, XR, shadows, and world bend even on render failure', () => {
  const { reflections: r, step, renderer, oldTarget, sky, crew, excluded } = fixture()
  curveUniforms.uCurveAmount.value = 0.004
  curveUniforms.uCurveFocus.value.set(3, 2, 1)
  const render = renderer.render
  renderer.render = function() { render.call(this); throw new Error('fixture failure') }
  assert.throws(step, /fixture failure/)
  assert.equal(renderer.target, oldTarget); assert.equal(renderer.face, 3); assert.equal(renderer.mip, 1)
  assert.equal(renderer.xr.enabled, true); assert.equal(renderer.autoClear, false)
  assert.equal(renderer.shadowMap.autoUpdate, true); assert.equal(renderer.shadowMap.needsUpdate, true)
  assert.equal(crew.group.visible, true); assert.equal(sky.stars.visible, true); assert.equal(excluded.visible, false)
  assert.deepEqual(sky.dome.position.toArray(), [0, 3, 9])
  assert.equal(curveUniforms.uCurveAmount.value, 0.004)
  assert.deepEqual(curveUniforms.uCurveFocus.value.toArray(), [3, 2, 1])
  curveUniforms.uCurveAmount.value = 0; curveUniforms.uCurveFocus.value.set(0, 0, 0)
  r.dispose()
})

test('disabling IBL frees both buffers; restoring IBL starts with a complete fresh capture', () => {
  const { reflections: r, step, settings } = fixture()
  step(30)
  let disposed = 0
  r.targets.forEach(t => t.addEventListener('dispose', () => disposed++))
  settings.ibl = false; step()
  assert.equal(disposed, 2); assert.equal(r.targets, null)
  assert.equal(r.uniforms.uReflectionReady.value, 0)
  assert.equal(r.uniforms.uReflectionA.value, null)
  settings.ibl = true; step(5)
  assert.equal(r.uniforms.uReflectionReady.value, 0)
  step(25)
  assert.ok(r.uniforms.uReflectionReady.value > 0.99)
  r.dispose()
})

test('overview and offscreen agents do not schedule scenery captures', () => {
  const { reflections: r, step, camera } = fixture()
  camera.position.set(0, 40, 45); camera.lookAt(0, 0, 0)
  step(180)
  assert.equal(r.targets, null)
  camera.position.set(0, 1, 3); camera.lookAt(0, 1, 20)
  step(180)
  assert.equal(r.targets, null)
  r.dispose()
})


test('wait for the main view to rebuild a missing shadow map after a quality change', () => {
  const { reflections: r, step, renderer, sky } = fixture()
  renderer.shadowMap.enabled = true
  sky.sun = { castShadow: true, shadow: { map: null } }
  step(30)
  assert.equal(r.stats.faces, 0)
  assert.equal(r.targets, null)
  sky.sun.shadow.map = new THREE.WebGLRenderTarget(8, 8)
  step(30)
  assert.equal(r.stats.captures, 1)
  assert.ok(r.uniforms.uReflectionReady.value > 0.99)
  sky.sun.shadow.map.dispose()
  r.dispose()
})
