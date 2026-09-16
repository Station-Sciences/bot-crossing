import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Navigation } from '../src/agents/navigation.js'
import { Plot } from '../src/world/plots.js'
import { BuildingSurfaces } from '../src/world/building-surfaces.js'
import { stepParcel } from '../src/world/parcel-physics.js'

const parcel = (values = {}) => ({ x: 0, y: 6, z: 0, vx: 0, vy: 0, vz: 0, spin: 2, yaw: 0.7, tilt: 0, bounces: 0, landed: false, ...values })

test('an obstacle crossing four buckets repels once, including at negative coordinates', () => {
  for (const x of [-4, 0, 4]) {
    const nav = new Navigation()
    nav.rebuild([{ x, z: x, r: 1, keep: 2 }])
    const out = nav.repel({ x: x + 1, z: x }, { x: 0, z: 0 })
    assert.ok(Math.abs(out.x - 3.4) < 1e-10)
    assert.equal(out.z, 0)
    assert.ok(nav.insideKeep(x - 1.9, x))
  }
})

test('a local work walk cannot cut through a building or its shoulder clearance', () => {
  const nav = new Navigation()
  nav.rebuild([{ x: 0, z: 0, r: 1.5, keep: 2 }])
  assert.equal(nav.clearWalk(-3, 0, 3, 0), false)
  assert.equal(nav.clearWalk(-3, 1.8, 3, 1.8), false)
  assert.equal(nav.clearWalk(-3, 3, 3, 3), true)
  const free = nav.nearestClear(0, 0, 6, (x) => x < -2.1)
  assert.ok(free && free.x < -2.1 && !nav.insideKeep(free.x, free.z))
})

test('hex deck containment includes the prop width, not just its centre', () => {
  const plot = Object.create(Plot.prototype)
  plot.localCenters = [{ x: 0, z: 0 }]
  plot.center = { x: 20, z: -10 }
  assert.equal(plot.containsWorld(20, -10), true)
  assert.equal(plot.containsLocal(0, 6.4), true)
  assert.equal(plot.containsLocal(0, 6.4, 0.4), false)
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + i * Math.PI / 3
    assert.ok(plot.containsLocal(Math.cos(a) * 7.6 * 0.992 * 0.58, Math.sin(a) * 7.6 * 0.992 * 0.58, 2))
  }
})

test('roof queries match rotated buildings and the construction sink', () => {
  const geometry = new THREE.BoxGeometry(3, 4, 2)
  geometry.translate(0, 2, 0)
  geometry.computeBoundingBox()
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.position.set(10, 0.45, -6)
  mesh.rotation.y = Math.PI / 4
  mesh.userData.uniforms = { uProgress: { value: 0.5 } }
  const surfaces = new BuildingSurfaces(new Map([['test', { mesh }]]), () => 0.45)
  assert.ok(Math.abs(surfaces.at(10, -6).height - 2.45) < 1e-6)
  mesh.userData.uniforms.uProgress.value = 1
  assert.ok(Math.abs(surfaces.at(10, -6).height - 4.45) < 1e-6)
  assert.equal(surfaces.at(14, -6).height, 0.45)
  geometry.dispose()
  mesh.material.dispose()
})

test('a dropped spinning package bounces and rests on the roof at long frame times', () => {
  const p = parcel()
  let sounds = 0, bounced = false
  const surface = () => ({ height: 2.5, nx: 0, ny: 1, nz: 0 })
  for (let i = 0; i < 100; i++) {
    if (stepParcel(p, 0.1, surface)) sounds++
    if (p.vy > 0) bounced = true
    assert.ok(p.y >= 2.65 - 1e-9)
  }
  assert.ok(bounced)
  assert.equal(sounds, 1)
  assert.equal(p.bounces, 3)
  assert.equal(p.y, 2.65)
  assert.equal(p.vy, 0)
  stepParcel(p, 0.1, () => ({ height: 2.6 }))
  assert.equal(p.y, 2.75)
  for (let i = 0; i < 100; i++) stepParcel(p, 0.1, () => ({ height: 0 }))
  assert.equal(p.y, 0.15)
})

test('roof slope deflects a parcel sideways and a wall reflects horizontal travel', () => {
  const p = parcel({ y: 2.4, vy: -3, spin: 0 })
  stepParcel(p, 0.1, (x) => ({ height: 2 - x * 0.75, nx: 0.6, ny: 0.8, nz: 0 }))
  assert.ok(p.vx > 0)
  const wall = parcel({ x: -0.01, y: 0.8, vx: 2, spin: 0 })
  stepParcel(wall, 1 / 60, (x) => ({ height: x >= 0 ? 2 : 0 }))
  assert.ok(wall.x < 0 && wall.vx < 0)
  assert.ok(wall.y < 1)
})
