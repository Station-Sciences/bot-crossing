/**
 * The spawn cap: when threads outnumber astronauts, who gets a body.
 *
 * The regression these guard is the chips lying — a status counted at the top of the screen
 * with no astronaut on the surface to click, because the cut was positional and the loudest
 * thread sorted last.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { capRoster, CHIP_STATUSES, STATUS_ORDER } from '../src/game/roster.js'

let n = 0
const entry = (status) => ({ id: `t${n++}`, status })
const many = (count, status) => Array.from({ length: count }, () => entry(status))
const ids = (list) => list.map((e) => e.id)

test('a roster under the cap is returned untouched, in order', () => {
  const entries = [entry('idle'), entry('working'), entry('sleeping')]
  assert.equal(capRoster(entries, 10), entries)
})

test('the one working thread spawns even when it sorts last — the reported bug', () => {
  const entries = [...many(200, 'idle'), entry('working')]
  const crew = capRoster(entries, 90)
  assert.equal(crew.length, 90)
  assert.ok(crew.some((e) => e.status === 'working'))
})

test('every urgent thread spawns before any idle one when they fit', () => {
  const entries = [...many(100, 'idle'), ...many(51, 'blocked'), ...many(7, 'waiting'), entry('working')]
  const crew = capRoster(entries, 90)
  assert.equal(crew.filter((e) => e.status === 'blocked').length, 51)
  assert.equal(crew.filter((e) => e.status === 'waiting').length, 7)
  assert.equal(crew.filter((e) => e.status === 'working').length, 1)
  assert.equal(crew.filter((e) => e.status === 'idle').length, 90 - 59)
})

test('incoming order is preserved within a status', () => {
  const idles = many(50, 'idle')
  const crew = capRoster([...idles, ...many(5, 'working')], 30)
  const kept = crew.filter((e) => e.status === 'idle')
  assert.deepEqual(ids(kept), ids(idles).slice(0, kept.length))
})

test('one loud status cannot crowd the other chips out entirely', () => {
  const entries = [...many(200, 'blocked'), entry('working'), entry('waiting'), entry('idle')]
  const crew = capRoster(entries, 90)
  for (const status of ['blocked', 'waiting', 'working']) {
    assert.ok(crew.some((e) => e.status === status), `${status} has a representative`)
  }
  // Idle has no chip: nobody can click its representative, so no blocked body is spent on one.
  assert.ok(!crew.some((e) => e.status === 'idle'))
})

test('a dormant thread never costs a chip status its astronaut', () => {
  const crew = capRoster([...many(2, 'blocked'), ...many(2, 'waiting'), entry('sleeping')], 4)
  assert.deepEqual(
    crew.map((e) => e.status),
    ['blocked', 'blocked', 'waiting', 'waiting']
  )
})

test('a status’s lone representative is never evicted to seat another', () => {
  // Cap of 2 cannot hold all three statuses; the two loudest win and neither loses its
  // only body to the third.
  const crew = capRoster([entry('blocked'), entry('waiting'), entry('working')], 2)
  assert.deepEqual(crew.map((e) => e.status), ['blocked', 'waiting'])
})

test('the same scan twice yields the same crew — nobody walks home for nothing', () => {
  const entries = [...many(40, 'idle'), ...many(10, 'blocked'), ...many(40, 'sleeping'), entry('working')]
  assert.deepEqual(ids(capRoster(entries, 30)), ids(capRoster([...entries], 30)))
})

test('the chip statuses mirror the chips the HUD actually draws', () => {
  // STAT_DEFS in hud.js is the other half of this list. hud.js cannot be imported under
  // bare node, so the correspondence is pinned here instead of read from it.
  assert.deepEqual(CHIP_STATUSES, ['blocked', 'waiting', 'working', 'celebrating'])
  for (const status of CHIP_STATUSES) assert.ok(STATUS_ORDER.includes(status), `${status} is ranked`)
})

test('every status statusFor can return has a spawn priority', () => {
  // capRoster ranks unknown statuses last silently; this trips instead when a status is
  // removed from STATUS_ORDER (or renamed in one place) without deciding where it sits in
  // the cut. The list mirrors the returns of statusFor in colony.js.
  for (const status of ['blocked', 'working', 'celebrating', 'waiting', 'sleeping', 'idle']) {
    assert.ok(STATUS_ORDER.includes(status), `${status} is ranked`)
  }
})
