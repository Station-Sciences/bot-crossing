import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mayObey, cleanOrders, nextOrders, warGoal, stepArrival, warPace, warClip, warFace, SWORD_REACH, HIT_LEN } from '../src/agents/war-orders.js'

const order = (values = {}) => ({ goal: { x: 10, z: 0 }, weapon: null, action: 'march', face: null, ...values })

test('only an idle or sleeping bot that is out on its feet takes orders', () => {
  for (const status of ['idle', 'sleeping']) {
    for (const state of ['at-site', 'walking']) assert.equal(mayObey({ status, state }), true, `${status} ${state}`)
  }
  // The honesty rule: anything with real work to show is never conscripted.
  for (const status of ['working', 'waiting', 'blocked', 'celebrating', 'leaving', 'spawning', undefined]) {
    assert.equal(mayObey({ status, state: 'at-site' }), false, String(status))
  }
  // Busy with something the player or the scan did.
  for (const state of ['queued', 'spawning', 'held', 'falling', 'leaving', 'gone']) {
    assert.equal(mayObey({ status: 'idle', state }), false, state)
  }
  assert.equal(mayObey(null), false)
})

test('an order is copied and tidied, and nonsense is refused', () => {
  const given = { goal: { x: 1, z: 2, y: 9 }, weapon: 'gun', action: 'fight', face: { x: 3, z: 4 } }
  const clean = cleanOrders(given)
  assert.deepEqual(clean, { goal: { x: 1, z: 2 }, weapon: 'gun', action: 'fight', face: { x: 3, z: 4 } })
  given.goal.x = 99
  assert.equal(clean.goal.x, 1, 'not a reference to the caller\'s object')

  assert.equal(cleanOrders(order({ weapon: 'bazooka' })).weapon, null)
  assert.equal(cleanOrders(order({ face: { x: NaN, z: 0 } })).face, null)
  assert.equal(cleanOrders(order({ face: undefined })).face, null)
  for (const bad of [null, 'march', {}, order({ action: 'dance' }), order({ goal: null }), order({ goal: { x: 1 } }), order({ goal: { x: Infinity, z: 0 } })]) {
    assert.equal(cleanOrders(bad), null, JSON.stringify(bad))
  }
})

test('the same action keeps its clock across re-issues; a new one starts again', () => {
  let held = nextOrders(null, cleanOrders(order({ action: 'down' })))
  assert.equal(held.t, 0)
  held.t = 2.5
  held.arrived = true
  held = nextOrders(held, cleanOrders(order({ action: 'down', goal: { x: 4, z: 4 } })))
  assert.equal(held.t, 2.5, 'still down, not hit again')
  assert.equal(held.arrived, true)
  assert.deepEqual(held.goal, { x: 4, z: 4 }, 'but the rest of the order is the new one')
  held = nextOrders(held, cleanOrders(order({ action: 'cheer' })))
  assert.equal(held.t, 0)
  assert.equal(held.arrived, false)
})

test('a swordsman closes to arm\'s length on its own side of what it faces', () => {
  const o = cleanOrders(order({ action: 'fight', weapon: 'sword', face: { x: 10, z: 0 } }))
  const at = warGoal(o, { x: 0, z: 0 })
  assert.ok(Math.abs(at.x - (10 - SWORD_REACH)) < 1e-9)
  assert.ok(Math.abs(at.z) < 1e-9)
  // Coming from the other side, it stops on that side.
  assert.ok(warGoal(o, { x: 20, z: 0 }).x > 10)
  // On top of it, it still has somewhere sensible to stand.
  const onTop = warGoal(o, { x: 10, z: 0 })
  assert.ok(Math.hypot(onTop.x - 10, onTop.z) > 1)
})

test('a gunner, a marcher and an unarmed bot with no target go to the goal; the down and the cheering stay put', () => {
  assert.deepEqual(warGoal(cleanOrders(order({ action: 'fight', weapon: 'gun', face: { x: 30, z: 0 } })), { x: 0, z: 0 }), { x: 10, z: 0 })
  assert.deepEqual(warGoal(cleanOrders(order()), { x: 0, z: 0 }), { x: 10, z: 0 })
  assert.deepEqual(warGoal(cleanOrders(order({ action: 'fight', weapon: 'sword' })), { x: 0, z: 0 }), { x: 10, z: 0 })
  assert.equal(warGoal(cleanOrders(order({ action: 'down' })), { x: 0, z: 0 }), null)
  assert.equal(warGoal(cleanOrders(order({ action: 'cheer' })), { x: 0, z: 0 }), null)
})

test('arriving is sticky, so a pressed rank holds its ground', () => {
  const o = nextOrders(null, cleanOrders(order()))
  assert.equal(stepArrival(o, 5), true, 'far: walk')
  assert.equal(stepArrival(o, 0.5), false, 'there')
  assert.equal(o.arrived, true)
  assert.equal(stepArrival(o, 1.2), false, 'nudged a little: stays')
  assert.equal(stepArrival(o, 2.5), true, 'shoved well off: walks back')
  assert.equal(o.arrived, false)
  assert.equal(stepArrival(o, null), false, 'nowhere to go: stands')
})

test('a long march is a run, the last stretch a walk', () => {
  const march = cleanOrders(order())
  assert.equal(warPace(march, 1), 1)
  assert.ok(warPace(march, 12) > 1.4)
  assert.ok(warPace(march, 100) <= 1.7)
  const fight = cleanOrders(order({ action: 'fight', weapon: 'sword' }))
  assert.equal(warPace(fight, 2), 1)
  assert.ok(warPace(fight, 8) > 1)
})

test('the clip follows the order, and the feet win unless the bot is down', () => {
  const at = (values, stride = null, prev = null, t = 0) => warClip({ ...nextOrders(null, cleanOrders(order(values))), t }, stride, prev)
  assert.equal(at({}, 'run'), 'run')
  assert.equal(at({}), 'idle')
  assert.equal(at({ action: 'fight', weapon: 'sword' }), 'work')
  assert.equal(at({ action: 'fight', weapon: 'sword' }, 'walk'), 'walk')
  assert.equal(at({ action: 'fight' }), 'work')
  // The raise is played once, then held.
  assert.equal(at({ action: 'fight', weapon: 'gun' }, null, 'idle'), 'aimUp')
  assert.equal(at({ action: 'fight', weapon: 'gun' }, null, 'aimUp'), 'aimUp')
  assert.equal(at({ action: 'fight', weapon: 'gun' }, null, 'aim'), 'aim')
  assert.equal(at({ action: 'cheer', weapon: 'gun' }), 'cheer')
  // Hit, then out cold, whatever its feet are doing.
  assert.equal(at({ action: 'down' }, 'walk', null, 0), 'hit')
  assert.equal(at({ action: 'down' }, 'walk', null, HIT_LEN + 0.01), 'down')
})

test('the face says what is happening to it', () => {
  const o = (values, t = 0) => ({ ...nextOrders(null, cleanOrders(order(values))), t })
  assert.equal(warFace(o({}), 0), 'work')
  assert.equal(warFace(o({ action: 'down' }), 0), 'alert')
  assert.equal(warFace(o({ action: 'down' }, HIT_LEN + 1), 0), 'error')
  const cheers = new Set([0, 0.5, 1, 1.5].map((e) => warFace(o({ action: 'cheer' }), e)))
  assert.deepEqual([...cheers].sort(), ['cheer', 'happy'])
})
