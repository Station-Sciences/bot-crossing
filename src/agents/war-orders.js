import { canFight } from '../game/war.js'

/**
 * Battle orders for a bot: the part of war mode that is a rule rather than a picture.
 *
 * The war director hands each fighter an order every frame — where to stand, what to hold,
 * what to do there — and the astronauts carry it out with the same walking, routing and
 * baked clips they use for everything else. What lives here is everything about an order
 * that can be decided without three.js: whether a bot may take one at all, what a messy
 * order means, where it sends the bot, how fast, and which clip and face it wears.
 *
 * Its own module so the rules run under node; astronauts.js cannot load there.
 */

export const WAR_ACTIONS = ['march', 'fight', 'down', 'cheer']
export const WAR_WEAPONS = ['sword', 'gun']

/**
 * Only a bot that is out in the colony and on its feet takes orders. One still in the ship,
 * on the ramp, in your hand, over the edge or heading home is busy with something the player
 * did or the scan said, and a battle never outranks either.
 */
const OBEYING = new Set(['at-site', 'walking'])

/**
 * The rule that keeps war mode honest: a bot whose thread is doing anything — working,
 * waiting on you, blocked, celebrating — never fights, whatever it was told. Checked on
 * every frame, not just when the order is given, because a thread can wake mid-battle.
 */
export const mayObey = (agent) => Boolean(agent) && canFight(agent.status) && OBEYING.has(agent.state)

const finite = (n) => typeof n === 'number' && Number.isFinite(n)
const point = (p) => (p && finite(p.x) && finite(p.z) ? { x: p.x, z: p.z } : null)

/**
 * An order as the bot will keep it, or null if it is not one. Copied rather than kept, so a
 * director that reuses one object for every fighter cannot move them all by editing it.
 */
export function cleanOrders(orders) {
  if (!orders || typeof orders !== 'object') return null
  const goal = point(orders.goal)
  if (!goal || !WAR_ACTIONS.includes(orders.action)) return null
  return {
    goal,
    weapon: WAR_WEAPONS.includes(orders.weapon) ? orders.weapon : null,
    action: orders.action,
    face: point(orders.face),
  }
}

/**
 * Fold a fresh order into the one a bot already holds. The director re-issues orders every
 * frame, so an unchanged action must keep its clock — otherwise a bot told to go down would
 * be hit afresh sixty times a second and never reach the floor.
 */
export function nextOrders(held, clean) {
  const same = held && held.action === clean.action
  return { ...clean, t: same ? held.t : 0, arrived: same ? held.arrived : false }
}

/** How far short of its target a swordsman stops: arm plus blade. */
export const SWORD_REACH = 1.1
/** How close counts as "there", and how far it has to be pushed before it walks back. */
const ARRIVE = 0.7
const REJOIN = 1.8

/**
 * Where the bot should be standing, or null for "where it is". A swordsman closes on what it
 * is facing and stops at arm's length on its own side; everyone else with somewhere to be
 * goes to the goal. A bot that is down or cheering has nowhere to go.
 */
export function warGoal(orders, pos) {
  if (orders.action === 'down' || orders.action === 'cheer') return null
  const face = orders.face
  if (orders.action === 'fight' && orders.weapon !== 'gun' && face) {
    const dx = pos.x - face.x
    const dz = pos.z - face.z
    const d = Math.hypot(dx, dz)
    // Already on top of it: step back along whatever line it came in on, or straight back.
    if (d < 1e-3) return { x: face.x, z: face.z - SWORD_REACH }
    return { x: face.x + (dx / d) * SWORD_REACH, z: face.z + (dz / d) * SWORD_REACH }
  }
  return { x: orders.goal.x, z: orders.goal.z }
}

/**
 * Whether the bot should be walking this frame, given how far its goal is. Arriving is
 * sticky: once there it holds its ground until shoved well off it, so a rank pressed
 * together by its own neighbours stands and fights rather than shuffling on the spot.
 */
export function stepArrival(orders, dist) {
  if (dist === null) return false
  if (orders.arrived ? dist > REJOIN : dist > ARRIVE) {
    orders.arrived = false
    return true
  }
  orders.arrived = true
  return false
}

/**
 * How much faster than its walk the bot goes. A march across the gap is a run; the last few
 * metres, and a swordsman's step in, are a walk.
 */
export function warPace(orders, dist) {
  if (orders.action === 'fight') return dist > 4 ? 1.4 : 1
  return Math.min(1.7, Math.max(1, 1 + (dist - 3) / 6))
}

/** Seconds of being hit before the bot goes over, and how far into Hit_A that is. */
export const HIT_LEN = 0.55
/** The frame of Hit_A where the head is furthest back — the moment to topple from. */
export const HIT_PEAK = 0.33

/**
 * The clip a bot under orders plays. `stride` is the walk or run its feet already need, or
 * null when it is standing; `prev` is the clip it is on, so a raise is only played once.
 * A bot that is down stays down whatever its feet say — it is not going anywhere.
 */
export function warClip(orders, stride, prev) {
  if (orders.action === 'down') return orders.t < HIT_LEN ? 'hit' : 'down'
  if (stride) return stride
  if (orders.action === 'cheer') return 'cheer'
  if (orders.action === 'fight') {
    if (orders.weapon === 'gun') return prev === 'aim' || prev === 'aimUp' ? prev : 'aimUp'
    // A sword is swung, and so is a fist: the hammering clip is the one with a blow in it.
    return 'work'
  }
  return 'idle'
}

/**
 * What its screen shows. Set-jawed on the march and in the fight, wide-eyed as it is hit,
 * crossed out once it is down, and beaming when it has won. A sleeper that has been sent to
 * war is awake for it.
 */
export function warFace(orders, elapsed) {
  switch (orders.action) {
    case 'down':
      return orders.t < HIT_LEN ? 'alert' : 'error'
    case 'cheer':
      return Math.floor(elapsed / 0.45) % 2 ? 'happy' : 'cheer'
    default:
      return 'work'
  }
}
