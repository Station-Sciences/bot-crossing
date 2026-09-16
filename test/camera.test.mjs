import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CameraRig } from '../src/core/camera.js'
import { Settings } from '../src/core/settings.js'

// Exercise real perspective rays and input handlers without browser event registration.
class TestRig extends CameraRig { _bind() {} }
function fixture(values = {}) {
  const camera = new THREE.PerspectiveCamera(38, 1.5, 0.5, 900)
  const dom = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }) }
  const rig = new TestRig(camera, dom, { get: key => values[key] })
  const agent = { pos: new THREE.Vector3(3, 0.3, -4) }
  rig.distance = rig.desiredDistance = 12
  rig.setFollow(agent)
  const step = (n = 1) => { for (let i = 0; i < n; i++) rig.update(1 / 60) }
  step(180)
  return { rig, agent, step }
}
const event = (x, y, extra = {}) => ({ pointerId: 1, clientX: x, clientY: y, button: 0, preventDefault() {}, ...extra })
const near = (a, b, message) => assert.ok(a.distanceTo(b) < 1e-7, message || `${a.toArray()} != ${b.toArray()}`)

test('following tracks position and elevation without changing zoom or chosen orbit', () => {
  const { rig, agent, step } = fixture({ autoFrame: true })
  rig.azimuth = rig.desiredAzimuth = 0.2
  rig.polar = rig.desiredPolar = 0.8
  for (let i = 0; i < 180; i++) {
    agent.pos.add(new THREE.Vector3(0.01, 0.002, -0.02))
    rig.setFollow(agent) // selection reconciliation must not recenter or restart easing
    step()
  }
  near(rig.target.clone().sub(agent.pos), new THREE.Vector3(0, 0.65, 0))
  assert.equal(rig.distance, 12)
  assert.equal(rig.azimuth, 0.2)
  assert.equal(rig.polar, 0.8)
})

test('pan offsets persist, including follow movement while a drag is held', () => {
  const { rig, agent, step } = fixture()
  rig._pointerDown(event(450, 300))
  rig._pointerMove(event(525, 320))
  const offset = rig.target.clone().sub(agent.pos)
  assert.ok(Math.hypot(offset.x, offset.z) > 0.5)
  agent.pos.add(new THREE.Vector3(0.2, 0.1, 0.1)); step()
  rig._pointerMove(event(525, 320)) // held pointer must not pull back the follow translation
  near(rig.target.clone().sub(agent.pos), offset)
  rig._pointerUp(event(525, 320))
  agent.pos.x += 1; step(60)
  near(rig.target.clone().sub(agent.pos), offset)
})

test('cursor zoom and orbit work during motion and preserve the resulting framing', () => {
  const { rig, agent, step } = fixture()
  rig._wheel(event(600, 350, { deltaY: -100, deltaMode: 0 }))
  for (let i = 0; i < 90; i++) { agent.pos.x += 0.02; step() }
  assert.ok(rig.distance < 11)
  assert.equal(rig._zoom, null)
  const offset = rig.target.clone().sub(agent.pos)
  rig._pointerDown(event(450, 300, { button: 2 }))
  rig._pointerMove(event(510, 335, { button: 2 }))
  rig._pointerUp(event(510, 335, { button: 2 }))
  for (let i = 0; i < 90; i++) { agent.pos.z += 0.02; step() }
  assert.ok(rig.azimuth < Math.PI / 4 - 0.3)
  near(rig.target.clone().sub(agent.pos), offset)
})

test('touch pinch retains follow and a stationary gesture does not cancel agent motion', () => {
  const { rig, agent, step } = fixture()
  rig._pointerDown(event(400, 300))
  rig._pointerDown(event(500, 300, { pointerId: 2 }))
  rig._pointerMove(event(550, 300, { pointerId: 2 }))
  assert.equal(rig.distance, 8)
  const offset = rig.target.clone().sub(agent.pos)
  agent.pos.add(new THREE.Vector3(0.2, 0.1, -0.1)); step()
  rig._pointerMove(event(550, 300, { pointerId: 2 }))
  near(rig.target.clone().sub(agent.pos), offset)
  assert.equal(rig.following, true)
  assert.equal(rig.wasClick, false)
  rig._pointerUp(event(550, 300, { pointerId: 2 }))
  rig._pointerUp(event(400, 300))
  assert.equal(rig.wasClick, false)
})

test('deselect/disable stops immediately, switching follows the new agent, and re-enable recenters', () => {
  const { rig, agent, step } = fixture({ reducedMotion: true })
  const second = { pos: new THREE.Vector3(-8, 2, 9) }
  const before = rig.camera.position.clone()
  rig.setFollow(second)
  near(rig.camera.position, before, 'switching must glide, not jump')
  step(180)
  near(rig.target.clone().sub(second.pos), new THREE.Vector3(0, 0.65, 0))
  rig.setFollow(null)
  const stopped = rig.camera.position.clone()
  agent.pos.x += 4; second.pos.x += 4; step(60)
  near(rig.camera.position, stopped)
  rig.setFollow(agent); step() // stop even an unfinished initial glide
  rig.setFollow(null)
  const midGlide = rig.camera.position.clone()
  step(60); near(rig.camera.position, midGlide)
  rig.setFollow(agent); step(180)
  near(rig.target.clone().sub(agent.pos), new THREE.Vector3(0, 0.65, 0))
})

test('follow preference defaults off, persists, and does not rebuild rendering or change quality', () => {
  const old = globalThis.localStorage
  let stored = '{}'
  globalThis.localStorage = { getItem: () => stored, setItem() {} }
  try {
    const settings = new Settings()
    assert.equal(settings.get('followSelected'), false)
    settings.onChange((_, scope) => assert.deepEqual(scope, { world: false, render: false }))
    settings.set('followSelected', true)
    assert.equal(settings.get('preset'), 'balanced')
    stored = JSON.stringify(settings.values)
    clearTimeout(settings._saveTimer)
    assert.equal(new Settings().get('followSelected'), true)
  } finally {
    if (old === undefined) delete globalThis.localStorage
    else globalThis.localStorage = old
  }
})
