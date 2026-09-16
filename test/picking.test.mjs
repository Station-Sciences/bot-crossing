import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { projectHitPoint, bodyHitDistance } from '../src/agents/picking.js'
import { bendPoint, setCurveView } from '../src/core/curve.js'

function cameraAt(distance, aspect = 1.5) {
  const camera = new THREE.PerspectiveCamera(38, aspect, 0.5, 900)
  camera.position.set(0, 1, distance)
  camera.lookAt(0, 0.6, 0)
  camera.updateMatrixWorld()
  return camera
}

test('the entire torso-to-boot capsule is clickable at close and distant zoom', () => {
  setCurveView(new THREE.Vector3(), 0, 0)
  for (const distance of [3, 10, 40]) {
    const camera = cameraAt(distance)
    const head = projectHitPoint(new THREE.Vector3(0, 1.1, 0), 0.27, camera, camera.aspect, {})
    const foot = projectHitPoint(new THREE.Vector3(0.2, 0.05, 0), 0.17, camera, camera.aspect, {})
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const x = head.x + (foot.x - head.x) * t
      const y = head.y + (foot.y - head.y) * t
      assert.equal(bodyHitDistance(x, y, head, foot), 0)
    }
    assert.ok(bodyHitDistance(foot.x + foot.radius + 0.2, foot.y, foot) > 0.19)
  }
})

test('projected click regions match portrait/landscape aspect and world curvature', () => {
  setCurveView(new THREE.Vector3(), 0.3, 0.0055)
  for (const aspect of [0.6, 2]) {
    const camera = cameraAt(40, aspect)
    const world = new THREE.Vector3(12, 1, -15)
    const expected = bendPoint(world.clone()).project(camera)
    const hit = projectHitPoint(world.clone(), 0.2, camera, aspect, {})
    assert.ok(Math.abs(hit.x - expected.x * aspect) < 1e-10)
    assert.ok(Math.abs(hit.y - expected.y) < 1e-10)
    assert.equal(bodyHitDistance(expected.x * aspect, expected.y, hit), 0)
  }
  setCurveView(new THREE.Vector3(), 0, 0)
})

test('points behind the camera or outside its depth range are not clickable', () => {
  const camera = cameraAt(3)
  for (const z of [4, -1000]) {
    const hit = projectHitPoint(new THREE.Vector3(0, 1, z), 0.2, camera, camera.aspect, {})
    assert.equal(hit.visible, false)
    assert.equal(bodyHitDistance(hit.x, hit.y, hit), Infinity)
  }
})
