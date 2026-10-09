import test from 'node:test'
import assert from 'node:assert/strict'

import { EMOTE, emoteCell, popScale } from '../src/agents/emotes.js'

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
