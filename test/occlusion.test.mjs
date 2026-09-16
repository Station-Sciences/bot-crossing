import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { OcclusionPass } from '../src/core/occlusion.js'
import { Engine } from '../src/core/engine.js'
import { Settings } from '../src/core/settings.js'

function fixture() {
  const camera = new THREE.PerspectiveCamera(38, 1.6, 0.5, 900)
  const pass = new OcclusionPass(camera)
  pass.setSize(640, 400)
  const read = new THREE.WebGLRenderTarget(640, 400, { depthTexture: new THREE.DepthTexture(640, 400) })
  const write = read.clone()
  const draws = []
  const renderer = {
    autoClear: true, target: null,
    setRenderTarget(target) { this.target = target },
    render(mesh) { draws.push({ target: this.target, material: mesh.material, autoClear: this.autoClear }) },
  }
  return { pass, read, write, renderer, draws }
}

test('AO reads this frame depth, multiplies in place, and never samples an attached texture', () => {
  const { pass, read, write, renderer, draws } = fixture()
  pass.setStrength(0.25); pass.render(renderer, write, read)
  assert.equal(pass.needsSwap, false)
  assert.equal(draws.length, 2)
  assert.equal(draws[0].target, pass.target)
  assert.equal(pass.material.uniforms.tDepth.value, read.depthTexture)
  assert.notEqual(draws[0].target, read)
  assert.equal(draws[1].target, read)
  assert.equal(draws[1].material.uniforms.tDepth, undefined)
  assert.equal(draws[1].material.uniforms.tOcclusion.value, pass.target.texture)
  assert.equal(draws[1].material.depthWrite, false)
  assert.equal(draws[1].material.premultipliedAlpha, true)
  assert.ok(draws.every(d => !d.autoClear))
  assert.equal(renderer.autoClear, true)
  // EffectComposer swaps its buffers between frames; depth must not remain hard-wired.
  pass.render(renderer, read, write)
  assert.equal(pass.material.uniforms.tDepth.value, write.depthTexture)
  pass.dispose(); read.dispose(); write.dispose()
})

test('zero releases AO memory, removes all AO draws, and re-enabling uses the current size', () => {
  const { pass, read, write, renderer, draws } = fixture()
  pass.setStrength(1); pass.render(renderer, write, read)
  let disposed = false
  pass.target.addEventListener('dispose', () => { disposed = true })
  pass.setStrength(0); pass.render(renderer, write, read)
  assert.equal(disposed, true); assert.equal(pass.target, null)
  assert.equal(pass.enabled, false); assert.equal(draws.length, 2)
  pass.setSize(960, 600); pass.setStrength(0.4); pass.render(renderer, write, read)
  assert.equal(pass.target.width, 960); assert.equal(pass.target.height, 600)
  assert.deepEqual(pass.material.uniforms.uTexel.value.toArray(), [1 / 960, 1 / 600])
  pass.dispose(); read.dispose(); write.dispose()
})

test('AO alone enables postprocessing, strength is bounded, and render failures restore autoClear', () => {
  const engine = Object.create(Engine.prototype)
  engine.settings = { get: key => key === 'ambientOcclusion' ? 0.25 : false }
  assert.equal(engine._wantsPost(), true)
  const { pass, read, write, renderer } = fixture()
  for (const value of [NaN, Infinity, -1]) { pass.setStrength(value); assert.equal(pass.enabled, false) }
  pass.setStrength(2); assert.equal(pass.material.uniforms.uStrength.value, 1)
  renderer.render = () => { throw new Error('fixture failure') }
  assert.throws(() => pass.render(renderer, write, read), /fixture failure/)
  assert.equal(renderer.autoClear, true)
  pass.dispose(); read.dispose(); write.dispose()
})

test('saved lightweight presets stay off, and the AO slider emits only a render change', () => {
  const previous = globalThis.localStorage
  try {
    for (const [stored, expected] of [[{ preset: 'low' }, 0], [{ preset: 'potato' }, 0], [{ preset: 'balanced' }, 0.25], [{ preset: 'low', ambientOcclusion: 0.6 }, 0.6]]) {
      globalThis.localStorage = { getItem: () => JSON.stringify(stored), setItem() {} }
      const settings = new Settings()
      assert.equal(settings.get('ambientOcclusion'), expected)
      let event
      settings.onChange((changed, scope) => { event = { changed, scope } })
      settings.set('ambientOcclusion', 0.35)
      assert.deepEqual(event.scope, { world: false, render: true })
      assert.equal(settings.get('preset'), 'custom')
      settings.applyAll({ preset: 'low' })
      assert.equal(settings.get('ambientOcclusion'), 0, 'legacy colony-file settings also keep AO off')
      settings.applyAll({ preset: 'low', ambientOcclusion: 0.6 })
      assert.equal(settings.get('ambientOcclusion'), 0.6, 'an explicit saved slider value wins')
      clearTimeout(settings._saveTimer)
    }
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})
