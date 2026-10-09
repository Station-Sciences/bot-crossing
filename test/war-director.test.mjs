/**
 * The war director's rules: who fights, where they stand, and who falls when. Everything here is
 * decided without three.js, so it can be held to account under node; the pictures it drives are
 * checked in the browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  eligibleFighters, fillSlots, weaponFor, battleGround, rankSpot, knockoutOrder, downSlots, nearest,
  fighterOrders, tankSpot, heliSpot, homeSide, GUN_DEPTH, SWORD_DEPTH, TANK_DEPTH, WarDirector,
} from '../src/game/war-director.js'
import { MARCH_MS, planBattle } from '../src/game/war.js'
import * as THREE from 'three'

const bot = (id, status = 'idle', extra = {}) => ({ id, status, state: 'at-site', pos: { x: 0, z: 0 }, neighbor: null, ...extra })
const friend = (id, status = 'idle', nid = 'mark') => bot(id, status, { neighbor: { id: nid, name: 'Mark' } })
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

test('home fighters are home bots that may fight, in id order; a friend\'s are only theirs', () => {
  const agents = [
    bot('c'), bot('a', 'sleeping'), bot('b', 'working'), bot('d', 'waiting'), bot('e', 'idle', { state: 'leaving' }),
    friend('nb:mark:2'), friend('nb:mark:1', 'sleeping'), friend('nb:mark:3', 'blocked'), friend('nb:sue:1', 'idle', 'sue'),
  ]
  assert.deepEqual(eligibleFighters(agents, null), ['a', 'c'])
  assert.deepEqual(eligibleFighters(agents, 'mark'), ['nb:mark:1', 'nb:mark:2'])
  assert.deepEqual(eligibleFighters(agents, 'nobody'), [])
})

test('a bot still in the ship, on the ramp or in your hand is not given a part', () => {
  // Every bot on the first roster after a page load is queued or spawning: none of them can take
  // an order yet, so none of them may hold a slot — they join as they step out.
  const agents = [
    bot('a', 'idle', { state: 'queued' }), bot('b', 'sleeping', { state: 'spawning' }),
    bot('c', 'idle', { state: 'held' }), bot('d', 'idle', { state: 'falling' }),
    bot('e', 'idle', { state: 'walking' }), bot('f', 'sleeping'),
    friend('nb:mark:1', 'idle'), friend('nb:mark:2', 'idle'),
  ]
  agents[6].state = 'spawning'
  assert.deepEqual(eligibleFighters(agents, null), ['e', 'f'])
  assert.deepEqual(eligibleFighters(agents, 'mark'), ['nb:mark:2'])
})

test('the first fill is the first `count` by id; after that a fighter keeps its slot', () => {
  let { slots, vacated } = fillSlots([], ['a', 'b', 'c', 'd'], 3)
  assert.deepEqual(slots, ['a', 'b', 'c'])
  assert.deepEqual(vacated, [])

  // `b` wakes up: it leaves, and nobody else shuffles along into a different slot.
  ;({ slots, vacated } = fillSlots(slots, ['a', 'c', 'd'], 3))
  assert.deepEqual(vacated, ['b'])
  assert.deepEqual(slots, ['a', 'd', 'c'], 'the free bot takes the empty slot; a and c stay put')

  // A slot that may not be refilled (its fighter is already down) stays empty.
  ;({ slots, vacated } = fillSlots(['a', null, 'c'], ['a', 'c', 'd'], 3, () => false))
  assert.deepEqual(slots, ['a', null, 'c'])

  // Fewer bots than the plan wants: the rest of the slots are simply empty.
  ;({ slots } = fillSlots([], ['x'], 3))
  assert.deepEqual(slots, ['x', null, null])
})

test('even slots carry guns and odd ones swords', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(weaponFor), ['gun', 'sword', 'gun', 'sword', 'gun'])
})

test('the battle point is just outside the defender, on the line from the attacker', () => {
  const g = battleGround({ from: { x: 0, z: 0 }, to: { x: 100, z: 0 }, toRadius: 20 })
  assert.deepEqual(g.dir, { x: 1, z: 0 })
  assert.ok(Math.abs(g.point.x - 74) < 1e-9 && Math.abs(g.point.z) < 1e-9, JSON.stringify(g.point))
  assert.ok(Math.abs(Math.hypot(g.normal.x, g.normal.z) - 1) < 1e-9)
  assert.ok(Math.abs(g.normal.x * g.dir.x + g.normal.z * g.dir.z) < 1e-9, 'normal is across the line')

  // Too close for the full margin: the point still stays between the two, never behind the attacker.
  const tight = battleGround({ from: { x: 0, z: 0 }, to: { x: 0, z: 20 }, toRadius: 30 })
  assert.ok(tight.point.z > 0 && tight.point.z < 20, JSON.stringify(tight.point))

  // On top of one another: some direction, not NaN.
  const same = battleGround({ from: { x: 5, z: 5 }, to: { x: 5, z: 5 }, toRadius: 10 })
  for (const v of [same.point.x, same.point.z, same.dir.x, same.dir.z]) assert.ok(Number.isFinite(v))
})

test('each side forms up on its own side: swords at the line, guns 6–8 back, nobody on anyone else', () => {
  const g = battleGround({ from: { x: 0, z: 0 }, to: { x: 100, z: 0 }, toRadius: 20 })
  for (const side of ['attack', 'defend']) {
    const n = 30
    const spots = Array.from({ length: n }, (_, i) => rankSpot(g, side, i, n))
    for (const [i, s] of spots.entries()) {
      // Signed distance from the line, positive on this side's own side of it.
      const along = ((s.x - g.point.x) * g.dir.x + (s.z - g.point.z) * g.dir.z) * (side === 'attack' ? -1 : 1)
      if (weaponFor(i) === 'gun') assert.ok(along >= 6 && along <= 8.5, `${side} gun ${i} at ${along}`)
      else assert.ok(along > 0.5 && along <= 3.6, `${side} sword ${i} at ${along}`)
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) assert.ok(dist(spots[i], spots[j]) > 1, `${side} ${i} and ${j} overlap`)
    }
  }
  assert.ok(GUN_DEPTH >= 6 && GUN_DEPTH <= 8 && SWORD_DEPTH < 3)
  // The same slot always gets the same spot: a screen redrawing the formation does not jitter it.
  assert.deepEqual(rankSpot(g, 'attack', 5, 12), rankSpot(g, 'attack', 5, 12))
})

test('knockouts land on a seeded shuffle of the slots, the same on every screen', () => {
  const order = knockoutOrder(42, 'attack', 10)
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(knockoutOrder(42, 'attack', 10), order)
  assert.notDeepEqual(knockoutOrder(42, 'defend', 10), order, 'the two sides do not fall in step')

  const battle = { seed: 42, attackers: 8, defenders: 8, startedAt: 1000 }
  const plan = planBattle(battle)
  const end = battle.startedAt + plan.durationMs
  for (const side of ['attack', 'defend']) {
    const ord = knockoutOrder(battle.seed, side, plan.count[side])
    assert.equal(downSlots(plan, side, battle.startedAt, battle.startedAt + MARCH_MS - 1, ord).size, 0)
    const down = downSlots(plan, side, battle.startedAt, end, ord)
    assert.equal(down.size, plan.events.filter((e) => e.side === side).length)
    for (const e of plan.events.filter((ev) => ev.side === side)) assert.ok(down.has(ord[e.index]))
  }
})

test('the nearest of a list, skipping the empty', () => {
  assert.equal(nearest({ x: 0, z: 0 }, [null, { x: 5, z: 0 }, { x: -2, z: 1 }]).x, -2)
  assert.equal(nearest({ x: 0, z: 0 }, []), null)
})

test('orders through the phases', () => {
  const g = battleGround({ from: { x: 0, z: 0 }, to: { x: 100, z: 0 }, toRadius: 20 })
  const base = { ground: g, side: 'attack', slot: 1, n: 8, winner: 'attack', down: false, target: { x: 80, z: 0 } }
  const spot = rankSpot(g, 'attack', 1, 8)

  const march = fighterOrders({ ...base, phase: 'march' })
  assert.equal(march.action, 'march')
  assert.equal(march.weapon, 'sword')
  assert.deepEqual(march.goal, spot)
  assert.ok(march.face.x > march.goal.x, 'looking across the line, at the enemy')

  const fight = fighterOrders({ ...base, phase: 'fight' })
  assert.equal(fight.action, 'fight')
  assert.deepEqual(fight.face, { x: 80, z: 0 })
  // Nobody left to face: straight ahead.
  assert.ok(fighterOrders({ ...base, phase: 'fight', target: null }).face.x > spot.x)

  assert.equal(fighterOrders({ ...base, phase: 'fight', down: true }).action, 'down')
  assert.equal(fighterOrders({ ...base, phase: 'cheer' }).action, 'cheer')
  assert.equal(fighterOrders({ ...base, phase: 'cheer', down: true }).action, 'down')
  // The side that lost and is still standing falls back to its rank rather than cheering.
  const fallBack = fighterOrders({ ...base, phase: 'cheer', winner: 'defend' })
  assert.equal(fallBack.action, 'march')
  assert.deepEqual(fallBack.goal, spot)

  for (const phase of ['pending', 'over']) assert.equal(fighterOrders({ ...base, phase }), null)
})

test('vehicles start behind their rank, tanks stop 10 short of the line, helicopters circle it', () => {
  const g = battleGround({ from: { x: 0, z: 0 }, to: { x: 100, z: 0 }, toRadius: 20 })
  const across = (p, side) => ((p.x - g.point.x) * g.dir.x + (p.z - g.point.z) * g.dir.z) * (side === 'attack' ? -1 : 1)
  for (const side of ['attack', 'defend']) {
    const start = tankSpot(g, side, 0, 2, 0)
    const there = tankSpot(g, side, 0, 2, 1)
    assert.ok(across(start, side) > across(there, side), 'it rolls toward the line')
    assert.ok(Math.abs(across(there, side) - TANK_DEPTH) < 1e-9)
    assert.equal(TANK_DEPTH, 10)
    assert.ok(dist(tankSpot(g, side, 0, 2, 1), tankSpot(g, side, 1, 2, 1)) > 3, 'two tanks are not parked in each other')

    for (const t of [0, 4, 8, 30, 60]) {
      const h = heliSpot(g, side, 1, t)
      assert.ok(h.height >= 9 && h.height <= 11, `height ${h.height}`)
      assert.ok(Number.isFinite(h.heading))
      if (t >= 8) assert.ok(dist(h, g.point) > 8 && dist(h, g.point) < 20, `orbit radius ${dist(h, g.point)}`)
    }
    // At the start it is over its own side's rank.
    assert.ok(across(heliSpot(g, side, 0, 0), side) > 6)
  }
})

test('which side home is on', () => {
  assert.equal(homeSide('attack'), 'attack')
  assert.equal(homeSide('defend'), 'defend')
  assert.equal(homeSide('nonsense'), null)
})

/** Just enough of a colony for the director to run under node: a scene, the bots, the map. */
function fakeColony(agents, sites, refuse = new Set()) {
  const orders = new Map()
  return {
    orders,
    scene: new THREE.Scene(),
    neighborSites: sites,
    homeReach: () => 20,
    groundAt: () => 0,
    _dustTint: new THREE.Color(),
    particles: { enabled: false, tracer() {}, puff() {}, weld() {}, step() {} },
    astronauts: {
      agents,
      byId: new Map(agents.map((a) => [a.id, a])),
      setWarOrders(id, o) {
        if (o === null || refuse.has(id)) {
          orders.delete(id)
          return o === null
        }
        orders.set(id, o)
        return true
      },
      clearWarOrders() { orders.clear() },
    },
  }
}

test('the battle line is drawn once and holds while the neighbour settlement moves', () => {
  const at = (x, z) => ({ x, y: 0, z })
  const agents = [bot('h1', 'idle', { pos: at(0, 0) }), friend('nb:mark:1', 'idle', 'mark')]
  agents[1].pos = at(100, 0)
  const sites = [{ id: 'mark', x: 100, z: 0, r: 20 }]
  const colony = fakeColony(agents, sites)
  const war = new WarDirector(colony)
  const startedAt = 1_000_000
  war.setBattle({ id: 'war_a', seed: 3, startedAt, attackers: 1, defenders: 1 }, { side: 'attack', enemyNeighborId: 'mark' })
  war.update(0.016, startedAt + 1000)
  const first = { ...war.ground.point }
  assert.ok(Math.abs(first.x - 74) < 1e-9)
  sites[0] = { id: 'mark', x: 40, z: 90, r: 30 }
  war.update(0.016, startedAt + 2000)
  assert.deepEqual(war.ground.point, first, 'the line did not follow the reshuffle')
  // A new battle draws its own line from where things are now.
  war.setBattle({ id: 'war_b', seed: 3, startedAt, attackers: 1, defenders: 1 }, { side: 'attack', enemyNeighborId: 'mark' })
  war.update(0.016, startedAt + 1000)
  assert.notDeepEqual(war.ground.point, first)
  war.dispose()
})

test('a fighter that turns its order down is not in the fight: nobody faces it', () => {
  const at = (x, z) => ({ x, y: 0, z })
  // Two attackers; the nearer one to the defender refuses its order this frame.
  const agents = [
    bot('h1', 'idle', { pos: at(60, 0) }), bot('h2', 'idle', { pos: at(40, 0) }),
    friend('nb:mark:1', 'idle', 'mark'),
  ]
  agents[2].pos = at(80, 0)
  const colony = fakeColony(agents, [{ id: 'mark', x: 100, z: 0, r: 20 }], new Set(['h1']))
  const war = new WarDirector(colony)
  const startedAt = 1_000_000
  war.setBattle({ id: 'war_c', seed: 3, startedAt, attackers: 2, defenders: 1 }, { side: 'attack', enemyNeighborId: 'mark' })
  war.update(0.016, startedAt + MARCH_MS + 100)
  assert.equal(war.slots.attack[0], 'h1', 'it keeps its part for when it can play it')
  const defender = colony.orders.get('nb:mark:1')
  assert.equal(defender.action, 'fight')
  assert.deepEqual(defender.face, { x: 40, z: 0 }, 'faces the bot that is fighting, not the one that refused')
  war.dispose()
})
