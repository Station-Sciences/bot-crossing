import test from 'node:test'
import assert from 'node:assert/strict'
import { ZONE_SWATCHES } from '../src/game/zone-colors.js'
import { mergeState } from '../src/game/merge-state.js'

test('zone swatches are distinct 24-bit colours with names', () => {
  const colors = ZONE_SWATCHES.map((s) => s.color)
  assert.equal(new Set(colors).size, colors.length)
  for (const s of ZONE_SWATCHES) {
    assert.ok(s.name)
    assert.ok(Number.isInteger(s.color) && s.color >= 0 && s.color <= 0xffffff)
  }
})

test('zone colours survive a conflicted save, and a reset here wins', () => {
  const base = { zoneColors: { a: { color: 1 }, gone: { color: 9 } } }
  // This tab picked a colour for b and put `gone` back to automatic; the other tab recoloured a.
  const local = { zoneColors: { a: { color: 1 }, b: { color: 2 } } }
  const remote = { zoneColors: { a: { color: 3 }, gone: { color: 9 } } }
  assert.deepEqual(mergeState(base, local, remote).zoneColors, { a: { color: 3 }, b: { color: 2 } })
})
