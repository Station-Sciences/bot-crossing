/**
 * The species mapping: who steps off the ship as what.
 *
 * What these guard is the two promises the renderer leans on — the assignment is a pure
 * function of the thread id, and roughly half of any real crew stays human so the aliens
 * have a baseline to read against. The atlas itself is canvas work and can only be judged
 * in a browser; the layout table's *shape* is checked here so a new species cannot point
 * at a face row that does not exist.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { hash, SPECIES, speciesFor } from '../src/agents/species.js'
import { EYE_LAYOUTS, FACE_COUNT, FRAME_COLS, FRAME_ROWS } from '../src/agents/faces.js'

const ids = Array.from({ length: 600 }, (_, i) => `thread-${i}-${(i * 7919).toString(16)}`)

test('assignment is deterministic per id', () => {
  for (const id of ids) assert.equal(speciesFor(hash(id)), speciesFor(hash(id)))
})

test('about half the crew stays human, the rest spread over every alien species', () => {
  const counts = ids.map((id) => speciesFor(hash(id))).reduce((c, s) => ((c[s] = (c[s] || 0) + 1), c), {})
  const human = counts[0] / ids.length
  assert.ok(human > 0.4 && human < 0.6, `human share ${human}`)
  for (let s = 1; s < SPECIES.length; s++) {
    const share = (counts[s] || 0) / ids.length
    assert.ok(share > 0.08 && share < 0.26, `species ${s} share ${share}`)
  }
})

test('every species points at a real face layout, and the atlas has rows for all of them', () => {
  for (const species of SPECIES) {
    assert.ok(species.faceLayout >= 0 && species.faceLayout < EYE_LAYOUTS.length)
  }
  assert.equal(FRAME_ROWS, (FACE_COUNT / FRAME_COLS) * EYE_LAYOUTS.length)
})

test('the human layout is the numbers the sixteen frames were authored against', () => {
  // Anything else and the human rows stop being bit-identical to the pre-species atlas.
  assert.deepEqual(EYE_LAYOUTS[0], { eyes: [[0.31, 0.42], [0.69, 0.42]], s: 1 })
})

test('heights stay inside the 0.85–1.15 band with the per-agent jitter on top', () => {
  for (const species of SPECIES) {
    const eps = 1e-9 // 1.12 + 0.03 lands a float ulp over 1.15; the band is not that strict
    assert.ok(species.height - 0.03 >= 0.85 - eps && species.height + 0.03 <= 1.15 + eps, `height ${species.height}`)
  }
})
