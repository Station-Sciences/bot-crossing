import test from 'node:test'
import assert from 'node:assert/strict'

import * as THREE from 'three'
import { EMOTE, Emotes, emoteCell, popScale } from '../src/agents/emotes.js'

test('every emote gets its own atlas cell inside the 4x2 grid', () => {
  const seen = new Set()
  for (const index of Object.values(EMOTE)) {
    const { col, row, u, v } = emoteCell(index)
    assert.ok(col >= 0 && col < 4 && row >= 0 && row < 2)
    assert.ok(u >= 0 && u < 1 && v >= 0 && v < 1)
    seen.add(`${col},${row}`)
  }
  assert.equal(seen.size, Object.keys(EMOTE).length)
})

test('the first row of the atlas is the top of the texture', () => {
  assert.equal(emoteCell(0).v, 0.5)
  assert.equal(emoteCell(4).v, 0)
})

test('a pop starts at nothing, overshoots, and settles on one', () => {
  assert.equal(popScale(0), 0)
  assert.equal(popScale(1), 1)
  assert.ok(Math.max(...[0.5, 0.6, 0.7, 0.8].map(popScale)) > 1)
})

/** An emote layer's buffers and mesh, without the atlas (which needs a canvas). */
function bareEmotes(capacity = 4) {
  const e = Object.create(Emotes.prototype)
  const attr = (size) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size)
  Object.assign(e, {
    capacity, state: new WeakMap(), _last: null, _color: new THREE.Color(),
    frames: attr(2), centers: attr(3), sizes: attr(1),
    mesh: { count: 0, instanceColor: attr(3), instanceMatrix: {}, setColorAt() {} },
  })
  return e
}

test('with no bubble to draw, nothing is uploaded: a quiet colony costs no buffer copies', () => {
  const e = bareEmotes()
  const uploads = () => [e.frames, e.centers, e.sizes, e.mesh.instanceColor].map((a) => a.version)
  const bot = { pos: { x: 0, y: 0, z: 0 }, scale: 1, state: 'at-site', phase: 0 }
  e.update([bot], 0, () => -1)
  e.update([bot], 0.1, () => -1)
  assert.deepEqual(uploads(), [0, 0, 0, 0])
  e.update([bot], 0.2, () => EMOTE.chat)
  assert.equal(e.mesh.count, 1)
  assert.deepEqual(uploads(), [1, 1, 1, 1])
  // Shrinking away is still drawn, so still uploaded; once it is gone, the uploads stop.
  e.update([bot], 0.25, () => -1)
  assert.deepEqual(uploads(), [2, 2, 2, 2])
  for (let t = 0.3; t < 2; t += 0.1) e.update([bot], t, () => -1)
  assert.equal(e.mesh.count, 0)
  const after = uploads()
  e.update([bot], 2.1, () => -1)
  assert.deepEqual(uploads(), after)
})

test('the emote layer takes the scene and how many it holds, and nothing else', () => {
  assert.equal(Emotes.length, 2)
})
