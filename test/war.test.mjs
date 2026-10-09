/**
 * The battle is a pure function of three numbers, and both screens must get the same answer
 * from them — that is the whole of the sync. These tests hold it to that.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHEER_MS, FIGHT_MS, MARCH_MS, MAX_FIGHTERS, battleLive, canFight, downAt, newBattle,
  phaseAt, planBattle, scoreAt, vehiclesFor, warTag,
} from '../src/game/war.js'

test('only idle and sleeping bots fight', () => {
  assert.deepEqual(
    ['idle', 'sleeping', 'working', 'waiting', 'blocked', 'celebrating'].map(canFight),
    [true, true, false, false, false, false]
  )
})

test('the same three numbers give the same battle, every time', () => {
  const a = planBattle({ seed: 1234, attackers: 12, defenders: 9 })
  const b = planBattle({ seed: 1234, attackers: 12, defenders: 9 })
  assert.deepEqual(a, b)
  assert.notDeepEqual(planBattle({ seed: 99, attackers: 12, defenders: 9 }).events, a.events)
})

test('fighters are capped and vehicles follow the numbers', () => {
  const p = planBattle({ seed: 1, attackers: 500, defenders: 3 })
  assert.equal(p.count.attack, MAX_FIGHTERS)
  assert.deepEqual(vehiclesFor(MAX_FIGHTERS), { tanks: 3, helis: 2 })
  assert.deepEqual(vehiclesFor(7), { tanks: 0, helis: 0 })
  assert.deepEqual(vehiclesFor(8), { tanks: 1, helis: 0 })
  assert.deepEqual(vehiclesFor(12), { tanks: 1, helis: 1 })
  assert.deepEqual(vehiclesFor(200), { tanks: 3, helis: 3 })
})

test('the score is the knockouts, and the winner has more standing (ties go to the defender)', () => {
  for (const seed of [1, 2, 3, 42, 777, 90210]) {
    const p = planBattle({ seed, attackers: 6, defenders: 6 })
    const lostA = p.events.filter((e) => e.side === 'attack').length
    const lostD = p.events.filter((e) => e.side === 'defend').length
    assert.deepEqual(p.score, { attack: lostD, defend: lostA })
    const standingA = 6 - lostA
    const standingD = 6 - lostD
    assert.equal(p.winner, standingA > standingD ? 'attack' : 'defend', `seed ${seed}`)
  }
})

test('knockouts are in order, inside the fight, and stop once a side is wiped out', () => {
  const p = planBattle({ seed: 5, attackers: 3, defenders: 20 })
  let last = 0
  for (const e of p.events) {
    assert.ok(e.t >= last && e.t <= FIGHT_MS)
    last = e.t
  }
  const perSide = { attack: [], defend: [] }
  for (const e of p.events) perSide[e.side].push(e.index)
  assert.deepEqual(perSide.attack, perSide.attack.map((_, i) => i))
  assert.deepEqual(perSide.defend, perSide.defend.map((_, i) => i))
  assert.ok(perSide.attack.length <= 3 && perSide.defend.length <= 20)
  assert.equal(p.durationMs, MARCH_MS + p.fightMs + CHEER_MS)
})

test('phases run march, fight, cheer, over', () => {
  const p = planBattle({ seed: 8, attackers: 4, defenders: 4 })
  const s = 1_000_000
  assert.equal(phaseAt(p, s, s - 1).phase, 'pending')
  assert.equal(phaseAt(p, s, s).phase, 'march')
  assert.equal(phaseAt(p, s, s + MARCH_MS).phase, 'fight')
  assert.equal(phaseAt(p, s, s + MARCH_MS + p.fightMs).phase, 'cheer')
  assert.equal(phaseAt(p, s, s + p.durationMs).phase, 'over')
})

test('the live score and who is down follow the clock', () => {
  const p = planBattle({ seed: 3, attackers: 10, defenders: 10 })
  const s = 0
  assert.deepEqual(scoreAt(p, s, MARCH_MS - 1), { attack: 0, defend: 0 })
  assert.deepEqual(scoreAt(p, s, s + p.durationMs), p.score)
  const first = p.events[0]
  assert.equal(downAt(p, first.side, s, MARCH_MS + first.t - 1).has(first.index), false)
  assert.equal(downAt(p, first.side, s, MARCH_MS + first.t).has(first.index), true)
})

test('a target tag is 16 hex, stable per key, and different between keys', async () => {
  const a = await warTag('a'.repeat(32))
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(await warTag('a'.repeat(32)), a)
  assert.notEqual(await warTag('b'.repeat(32)), a)
})

test('a new battle carries what the snapshot needs, and stays live until it has lingered', async () => {
  const b = await newBattle({ targetNeighborId: 'nb_1', targetKey: 'c'.repeat(32), attackers: 5, defenders: 4, now: 1000, seed: 77 })
  assert.match(b.id, /^war_[0-9a-z_]{1,40}$/)
  assert.equal(b.target, await warTag('c'.repeat(32)))
  assert.deepEqual([b.seed, b.startedAt, b.attackers, b.defenders, b.targetNeighborId], [77, 1000, 5, 4, 'nb_1'])
  const end = 1000 + planBattle(b).durationMs
  assert.equal(battleLive(b, end + 29_000), true)
  assert.equal(battleLive(b, end + 31_000), false)
  assert.equal(battleLive(null, 0), false)
})
