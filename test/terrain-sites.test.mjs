import test from 'node:test'
import assert from 'node:assert/strict'
import { GROUND_SIZE, PLANETS, groundSize, setSettlementSites, terrainHeight } from '../src/world/planet.js'

const moon = PLANETS.moon
/** How far the ground rises and falls over a 40 m square — what a plot would have to sit on. */
const spread = (cx, cz = 0) => {
  let lo = Infinity
  let hi = -Infinity
  for (let dx = -20; dx <= 20; dx += 4) {
    for (let dz = -20; dz <= 20; dz += 4) {
      const y = terrainHeight(cx + dx, cz + dz, moon)
      lo = Math.min(lo, y)
      hi = Math.max(hi, y)
    }
  }
  return hi - lo
}

test("a neighbour's site is flat ground, like the home colony", () => {
  setSettlementSites([])
  const before = spread(140)
  // Measured on the Moon: ~0.45 across the home colony, ~10.4 across this patch of hills.
  assert.ok(before > 3, `the far field is hilly to begin with (${before})`)
  setSettlementSites([{ x: 140, z: 0, r: 40 }])
  const after = spread(140)
  assert.ok(after < 1.2, `flat enough to build on: ${after}`)
  assert.ok(after < before / 4, `far flatter than the hills it replaced: ${after} vs ${before}`)
  setSettlementSites([])
  assert.equal(spread(140), before, 'and the hills come back when the neighbour leaves')
})

test('with no neighbours nothing about the ground changes', () => {
  setSettlementSites([])
  assert.equal(groundSize(), GROUND_SIZE)
})

test('the ground grows to hold the furthest neighbour', () => {
  setSettlementSites([{ x: 200, z: 0, r: 30 }])
  assert.equal(groundSize(), 580)
  setSettlementSites([])
})
