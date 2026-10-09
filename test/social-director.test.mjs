/**
 * The social director's rules: what counts as an event, what the planner is told about a bot, and
 * where the ball is. The scenes themselves are the planner's (social.test.mjs); the pictures are
 * checked in the browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BALL, ballAt, departureEvents, kickArc, plannerBot, sceneShift, shiftStep, statusEvents, warEvents, zoneOfThread,
} from '../src/game/social-director.js'
import { MOOD_MS, makeScene } from '../src/game/social.js'
import { mulberry32 } from '../src/game/war.js'

const agent = (id, status = 'idle', extra = {}) => ({ id, status, state: 'at-site', pos: { x: 1, y: 0.2, z: 2 }, neighbor: null, war: null, ...extra })
const thread = (id, project = 'repo', extra = {}) => ({ id, project, ...extra })
const friendThread = (id, nid, project = 'repo') => thread(id, project, { neighbor: { id: nid, name: nid } })
const byId = (list) => new Map(list.map((t) => [t.id, t]))
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

test('a thread\'s zone is named as its plot is: the repo at home, nb:<friend>/<repo> for a friend', () => {
  assert.equal(zoneOfThread(thread('a', 'bot-crossing')), 'bot-crossing')
  assert.equal(zoneOfThread(thread('a', '')), 'unknown')
  assert.equal(zoneOfThread({ id: 'a' }), 'unknown')
  assert.equal(zoneOfThread(friendThread('nb:1', 'mark', 'shop')), 'nb:mark/shop')
  assert.equal(zoneOfThread(null), null)
})

test('the planner is told each bot\'s status, place, zone, owner and whether it is at war', () => {
  assert.deepEqual(plannerBot(agent('a'), 'repo'), { id: 'a', status: 'idle', pos: { x: 1, z: 2 }, zone: 'repo', owner: 'home', atWar: false })
  assert.equal(plannerBot(agent('a', 'working')).status, 'working')
  assert.equal(plannerBot(agent('a', 'sleeping')).status, 'sleeping')
  assert.equal(plannerBot(agent('a')).zone, null)
  assert.equal(plannerBot(agent('a', 'idle', { neighbor: { id: 'mark' } })).owner, 'mark')
  assert.equal(plannerBot(agent('a', 'idle', { war: { action: 'march' } })).atWar, true)
  // A copy of where it stands, not the live vector: the planner keeps what it is given.
  const a = agent('a')
  const b = plannerBot(a)
  a.pos.x = 9
  assert.equal(b.pos.x, 1)
})

test('an idle bot that is not out on its feet is away: it would refuse every step', () => {
  for (const state of ['queued', 'spawning', 'leaving', 'held', 'gone']) {
    assert.equal(plannerBot(agent('a', 'idle', { state })).status, 'away', state)
  }
  assert.equal(plannerBot(agent('a', 'idle', { state: 'walking' })).status, 'idle')
  // Busy statuses are passed through as they are: the planner already turns them away.
  assert.equal(plannerBot(agent('a', 'working', { state: 'spawning' })).status, 'working')
})

test('a run that finishes (working to idle) is an event; nothing else is', () => {
  const first = statusEvents(new Map(), [agent('a', 'working'), agent('b', 'idle'), agent('c', 'working'), agent('d', 'sleeping')])
  assert.deepEqual(first.events, [], 'a bot seen for the first time has not changed')
  const next = statusEvents(first.seen, [agent('a', 'idle'), agent('b', 'idle'), agent('c', 'waiting'), agent('d', 'idle'), agent('e', 'idle')])
  assert.deepEqual(next.events, [{ kind: 'finished', id: 'a' }])
  assert.equal(next.seen.get('c'), 'waiting')
  // Waiting on you first, then read: that is not a run just finished.
  assert.deepEqual(statusEvents(next.seen, [agent('c', 'idle')]).events, [])
  // And the same step is only reported once.
  assert.deepEqual(statusEvents(next.seen, [agent('a', 'idle')]).events, [])
})

test('a home thread that is archived, or vanishes from the scan, is a heartbreak for its repo', () => {
  const before = byId([thread('a', 'x'), thread('b', 'x'), thread('c', 'y'), thread('d', 'z')])
  const after = byId([thread('b', 'x')])
  const scan = [thread('a', 'x', { archived: true }), thread('b', 'x'), thread('d', 'z')]
  const events = departureEvents({ before, after, scan, archivedIds: new Set(['d']) })
  assert.deepEqual(events, [
    { kind: 'archived', zone: 'x', owner: 'home' }, // archived flag
    { kind: 'archived', zone: 'y', owner: 'home' }, // gone from the scan
    { kind: 'archived', zone: 'z', owner: 'home' }, // on the archive list
  ])
  // The archive list may come as an array too.
  assert.equal(departureEvents({ before, after, scan, archivedIds: ['d'] }).length, 3)
})

test('a hidden or dormant-folded thread has not gone anywhere, and an errand ending is no loss', () => {
  const before = byId([thread('a', 'x'), thread('p:errand:1', 'x'), thread('b', 'x')])
  const after = byId([thread('b', 'x')])
  // Still scanned, not archived: hidden off the map.
  assert.deepEqual(departureEvents({ before, after, scan: [thread('a', 'x'), thread('b', 'x')] }), [])
})

test('one heartbreak per repo, however many of its threads go at once', () => {
  const before = byId([thread('a', 'x'), thread('b', 'x'), thread('c', 'x'), thread('d', 'y')])
  const events = departureEvents({ before, after: byId([thread('d', 'y')]), scan: [] })
  assert.deepEqual(events, [{ kind: 'archived', zone: 'x', owner: 'home' }])
})

test('a friend\'s thread that drops out of their set is theirs to mourn; a friend going entirely is not', () => {
  const neighborsBefore = byId([friendThread('nb:1', 'mark', 'shop'), friendThread('nb:2', 'mark', 'shop'), friendThread('nb:3', 'sue', 'blog')])
  // Mark loses one thread and keeps one; Sue's whole settlement goes (removed, or offline).
  const neighborsAfter = byId([friendThread('nb:2', 'mark', 'shop')])
  assert.deepEqual(departureEvents({ neighborsBefore, neighborsAfter }), [{ kind: 'archived', zone: 'nb:mark/shop', owner: 'mark' }])
  // Home threads and friends' are kept apart even with the same repo name.
  const both = departureEvents({
    before: byId([thread('a', 'shop')]), after: new Map(), scan: [],
    neighborsBefore, neighborsAfter,
  })
  assert.deepEqual(both.map((e) => e.owner), ['home', 'mark'])
})

test('a battle\'s result: home and the friend it fought, opposite ways round, while it is fresh', () => {
  const now = 1_000_000
  assert.deepEqual(warEvents({ won: true, enemyId: 'mark', endedAt: now - 1000 }, now), [
    { kind: 'warResult', owner: 'home', won: true },
    { kind: 'warResult', owner: 'mark', won: false },
  ])
  assert.deepEqual(warEvents({ won: false, enemyId: 'mark' }, now).map((e) => e.won), [false, true])
  assert.deepEqual(warEvents({ won: true, enemyId: 'mark', endedAt: now - MOOD_MS - 1 }, now), [], 'counted on a later load: no sulk')
  assert.deepEqual(warEvents({ won: true, enemyId: null }, now), [])
})

test('a kick: off the ground, lands once short of the receiver, hops the rest lower, and ends on the ground', () => {
  assert.deepEqual(kickArc(0), { s: 0, h: 0 })
  assert.deepEqual(kickArc(1), { s: 1, h: 0 })
  assert.deepEqual(kickArc(-1), { s: 0, h: 0 })
  assert.deepEqual(kickArc(2), { s: 1, h: 0 })
  const bounce = kickArc(BALL.BOUNCE_K)
  assert.ok(Math.abs(bounce.h) < 1e-9, 'on the ground at the bounce')
  assert.ok(Math.abs(bounce.s - BALL.BOUNCE_S) < 1e-9)
  let last = 0
  let peak1 = 0
  let peak2 = 0
  for (let k = 0.01; k < 1; k += 0.01) {
    const { s, h } = kickArc(k)
    assert.ok(s >= last, 'never rolls back')
    assert.ok(h >= 0, 'never under the ground')
    last = s
    if (k < BALL.BOUNCE_K) peak1 = Math.max(peak1, h)
    else peak2 = Math.max(peak2, h)
  }
  assert.ok(Math.abs(peak1 - BALL.HEIGHT) < 0.01, `first arc peaks at its height (${peak1})`)
  assert.ok(peak2 > 0 && peak2 < peak1 / 2, 'the hop after the bounce is a small one')
  // Slower after the bounce: less ground per unit of time than before it.
  const before = BALL.BOUNCE_S / BALL.BOUNCE_K
  const after = (1 - BALL.BOUNCE_S) / (1 - BALL.BOUNCE_K)
  assert.ok(after < before)
})

/** A game of ball for `n`, the way the planner makes one. */
function ballGame(n, seed = 7) {
  const rand = mulberry32(seed)
  const members = Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, status: 'idle', owner: 'home', zone: 'z', pos: { x: Math.cos(i * 2) * 3, z: Math.sin(i * 2) * 3 },
  }))
  for (;;) {
    const scene = makeScene('play', members, 0, rand)
    if (scene.variant === 'ball') return scene
  }
}

test('the ball waits at the first kicker\'s feet, flies to the receiver\'s, and rests there', () => {
  const scene = ballGame(3)
  const passes = scene.passesFor([])
  const where = (id) => scene.spots[id]
  const game = { passes, spots: scene.spots, centre: scene.centre }
  const [first, second] = passes
  const kicker = scene.spots[first.from]
  const receiver = scene.spots[first.to]

  const waiting = ballAt(game, 0, where)
  assert.equal(waiting.h, 0)
  assert.equal(waiting.flying, false)
  assert.ok(dist(waiting, kicker) <= BALL.FOOT + 1e-9, 'at the kicker\'s feet before the kick')
  assert.ok(dist(waiting, kicker) < dist(waiting, receiver))

  const mid = ballAt(game, first.at + BALL.HIT_MS + BALL.FLIGHT_MS * 0.35, where)
  assert.ok(mid.flying && mid.h > 0.5, 'in the air mid-kick')
  assert.ok(dist(mid, kicker) > BALL.FOOT && dist(mid, receiver) > BALL.FOOT, 'between the two')

  const landed = ballAt(game, first.at + BALL.HIT_MS + BALL.FLIGHT_MS + 10, where)
  assert.equal(landed.flying, false)
  assert.equal(landed.h, 0)
  assert.ok(dist(landed, receiver) <= BALL.FOOT + 1e-9, 'at the receiver\'s feet')
  // Still there until the receiver kicks it on.
  assert.deepEqual(ballAt(game, second.at + BALL.HIT_MS - 1, where), landed)
  // After the last kick it rests with whoever got it.
  const end = ballAt(game, scene.durationMs, where)
  assert.equal(end.flying, false)
  assert.ok(dist(end, scene.spots[passes.at(-1).to]) <= BALL.FOOT + 1e-9)
})

test('the ball follows the players where they actually stand, and goes to the middle with no kicks', () => {
  const scene = ballGame(2)
  const [first] = scene.passes
  const moved = { x: scene.spots[first.to].x + 1, z: scene.spots[first.to].z }
  const where = (id) => (id === first.to ? moved : scene.spots[id])
  const landed = ballAt({ passes: scene.passes, spots: scene.spots, centre: scene.centre }, first.at + BALL.HIT_MS + BALL.FLIGHT_MS, where)
  assert.ok(dist(landed, moved) <= BALL.FOOT + 1e-9)
  // Nobody known to `where`: it falls back to the spots.
  const fallback = ballAt({ passes: scene.passes, spots: scene.spots, centre: scene.centre }, first.at + BALL.HIT_MS + BALL.FLIGHT_MS, () => null)
  assert.ok(dist(fallback, scene.spots[first.to]) <= BALL.FOOT + 1e-9)
  assert.deepEqual(ballAt({ passes: [], spots: scene.spots, centre: { x: 4, z: 5 } }, 3000), { x: 4, z: 5, h: 0, flying: false })
})

test('the ball is never kicked to, or left with, a player who has gone', () => {
  for (const n of [3, 4]) {
    for (let seed = 1; seed <= 20; seed++) {
      const scene = ballGame(n, seed)
      const gone = [scene.cast[1]]
      const passes = scene.passesFor(gone)
      const spot = scene.spots[gone[0]]
      const game = { passes, spots: scene.spots, centre: scene.centre }
      const where = (id) => (gone.includes(id) ? null : scene.spots[id])
      for (let t = 1600; t <= scene.durationMs; t += 50) {
        const p = ballAt(game, t, where)
        // A pass between two others may cross near the gone player's spot in the air, but the
        // ball never comes to rest there.
        if (!p.flying) assert.ok(dist(p, spot) > BALL.FOOT + 0.01, `n=${n} seed=${seed} t=${t}: resting at the gone player`)
      }
      for (const pass of passes) assert.ok(!gone.includes(pass.from) && !gone.includes(pass.to))
    }
  }
})

test('a scene drawn round a building is moved, whole and as little as it can be, onto open ground', () => {
  const rand = mulberry32(3)
  const members = [0, 1, 2, 3].map((i) => ({ id: `g${i}`, status: 'idle', owner: 'home', zone: 'z', pos: { x: Math.cos(i * 1.6) * 3, z: Math.sin(i * 1.6) * 3 } }))
  const scene = makeScene('group', members, 0, rand)
  // Open ground everywhere: it stays put.
  assert.deepEqual(sceneShift(scene, () => true), { x: 0, z: 0 })
  // A round building of radius 1.5 on the ring's middle.
  const dome = { x: scene.centre.x, z: scene.centre.z }
  const clear = (x, z) => Math.hypot(x - dome.x, z - dome.z) > 1.5
  const off = sceneShift(scene, clear)
  assert.ok(off && Math.hypot(off.x, off.z) > 0)
  const r = Math.max(...Object.values(scene.spots).map((p) => Math.hypot(p.x - scene.centre.x, p.z - scene.centre.z)))
  // Every spot and the middle are clear after the move, and the ring has cleared the dome:
  // the least move that does that is the dome's radius plus the ring's, within a step.
  for (const p of [scene.centre, ...Object.values(scene.spots)]) assert.ok(clear(p.x + off.x, p.z + off.z))
  assert.ok(Math.hypot(off.x, off.z) <= 1.5 + r + 0.5 + 1e-9)
  // Nowhere to go: null, and the director plays it where it is.
  assert.equal(sceneShift(scene, () => false), null)
})

test('a heartbreak is not moved for ground between the two that nobody stands on', () => {
  const members = [{ id: 'sad', owner: 'home', pos: { x: 0, z: 0 } }, { id: 'pal', owner: 'home', pos: { x: 6, z: 0 } }]
  const scene = makeScene('heartbreak', members, 0, mulberry32(1))
  // A wall across the middle, clear of both spots: it stays where it is, the sad one unmoved.
  assert.deepEqual(sceneShift(scene, (x) => Math.abs(x - 3) > 0.5), { x: 0, z: 0 })
  // Its own spot in a wall, though, and it moves.
  assert.notDeepEqual(sceneShift(scene, (x, z) => Math.hypot(x, z) > 0.3), { x: 0, z: 0 })
})

test('a step is moved with its scene: goal and faced point, but not a faced bot', () => {
  const off = { x: 2, z: -1 }
  const moved = shiftStep({ goal: { x: 1, z: 1 }, face: { x: 0, z: 0 }, action: 'talk', emote: 'chat', expression: 'happy' }, off)
  assert.deepEqual(moved, { goal: { x: 3, z: 0 }, face: { x: 2, z: -1 }, action: 'talk', emote: 'chat', expression: 'happy' })
  assert.equal(shiftStep({ goal: null, face: 'b1', action: 'sit' }, off).face, 'b1')
  assert.equal(shiftStep({ goal: null, face: 'b1', action: 'sit' }, off).goal, null)
  // A goal still in a wall goes to the nearest clear spot, or stays if there is none.
  const westOfWall = (x) => x < 2.5
  assert.deepEqual(shiftStep({ goal: { x: 1, z: 1 }, face: null, action: 'walk' }, off, westOfWall, () => ({ x: 9, z: 9 })).goal, { x: 9, z: 9 })
  assert.deepEqual(shiftStep({ goal: { x: 1, z: 1 }, face: null, action: 'walk' }, off, westOfWall).goal, { x: 3, z: 0 })
  assert.equal(shiftStep(undefined, off), undefined)
})
