import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { helmetGeometry, visorGeometry, screenGeometry, SCREEN_DEPTH, SCREEN_BULGE, SCREEN_RADIUS } from '../src/agents/model.js'

test('the circular helmet opening exposes a recessed curved screen behind separate glass', () => {
  const radius = 0.48
  const geometries = [visorGeometry(radius), screenGeometry(radius), helmetGeometry(radius)]
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -1))
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const distances = geometries.map(geometry => ray.intersectObject(new THREE.Mesh(geometry, material))[0]?.distance)
  assert.ok(distances.every(Number.isFinite))
  assert.ok(distances[0] + 0.15 < distances[1], 'real air gap between window and screen')
  assert.ok(distances[1] < distances[2], 'shell must not cover the face opening')
  const p = geometries[1].attributes.position
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getY(i))
    const expectedZ = radius * (SCREEN_DEPTH + SCREEN_BULGE * (1 - (r / (radius * SCREEN_RADIUS)) ** 2))
    assert.ok(Math.abs(p.getZ(i) - expectedZ) < 1e-7)
    // Across the opening, the curved tube must remain behind the glass, ahead of the
    // rear shell, and joined to the cavity at its perimeter.
    if (r < radius * SCREEN_RADIUS * 0.98) {
      // Offset from exact shared triangle seams to avoid ray/edge roundoff.
      ray.ray.origin.set(p.getX(i), p.getY(i) + 1e-6, 2)
      const glassDistance = ray.intersectObject(new THREE.Mesh(geometries[0], material))[0]?.distance
      assert.ok(glassDistance + 0.075 < 2 - p.getZ(i), 'curved screen stays inside its protective glass')
    }
  }
  for (const geometry of geometries) {
    for (const attribute of Object.values(geometry.attributes)) assert.ok([...attribute.array].every(Number.isFinite))
    geometry.dispose()
  }
  material.dispose()
})
