/**
 * The arsenal: swords, guns, tanks and helicopters built from boxes and cylinders. They are
 * checked for the things the fight relies on — roughly the right size next to a 1.1-tall bot,
 * the moving parts and muzzles that effects hang off, and a clean dispose.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { createSword, createGun, createTank, createHelicopter, createBall, dispose } from '../src/world/arsenal.js'

function size(group) {
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  assert.ok(!box.isEmpty(), 'bounding box is not empty')
  return box.getSize(new THREE.Vector3())
}

// Longest side within +-50% of the intended length.
function nearly(actual, want) {
  assert.ok(actual >= want * 0.5 && actual <= want * 1.5, `${actual} is not within 50% of ${want}`)
}

test('sword is about 0.7 long', () => {
  const g = createSword()
  assert.ok(g.isGroup)
  const s = size(g)
  nearly(Math.max(s.x, s.y, s.z), 0.7)
})

test('ball is about 0.35 across and rests on the ground', () => {
  const g = createBall()
  assert.ok(g.isGroup)
  const s = size(g)
  nearly(Math.max(s.x, s.y, s.z), 0.35)
  const box = new THREE.Box3().setFromObject(g)
  assert.ok(Math.abs(box.min.y) < 0.01, 'bottom sits at y = 0')
  dispose(g)
})

test('gun is about 0.5 long and has a muzzle', () => {
  const g = createGun()
  assert.ok(g.isGroup)
  const s = size(g)
  nearly(Math.max(s.x, s.y, s.z), 0.5)
  assert.ok(g.userData.muzzle?.isObject3D)
})

test('tank is about 3 x 1.8 x 1.2 with a turret, barrel and muzzle', () => {
  const g = createTank(0xc96442)
  const s = size(g)
  nearly(s.z, 3)
  nearly(s.x, 1.8)
  nearly(s.y, 1.2)
  assert.ok(g.userData.turret?.isObject3D)
  assert.ok(g.userData.barrel?.isObject3D)
  assert.ok(g.userData.muzzle?.isObject3D)
  // The barrel pitches on the turret, which yaws on the hull.
  let p = g.userData.barrel
  const chain = []
  while (p) {
    chain.push(p)
    p = p.parent
  }
  assert.ok(chain.includes(g.userData.turret))
})

test('helicopter is about 3.5 long with a 4-unit rotor, a tail rotor and a nose muzzle', () => {
  const g = createHelicopter(0x4aa3df)
  const s = size(g)
  nearly(s.z, 3.5)
  assert.ok(g.userData.rotor?.isObject3D)
  assert.ok(g.userData.tailRotor?.isObject3D)
  assert.ok(g.userData.muzzle?.isObject3D)
  const rotor = new THREE.Box3().setFromObject(g.userData.rotor).getSize(new THREE.Vector3())
  nearly(Math.max(rotor.x, rotor.z), 4)
})

test('dispose frees everything without throwing', () => {
  for (const g of [createSword(), createGun(), createTank(0xff0000), createHelicopter(0x00ff00)]) {
    dispose(g)
  }
})
