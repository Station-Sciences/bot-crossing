/**
 * The social director's rules: what counts as an event, what the planner is told about a bot, and
 * where the ball is. The scenes themselves are the planner's (social.test.mjs); the pictures are
 * checked in the browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  BALL, FINISH_WINDOW_MS, SocialDirector, ballAt, departureEvents, kickArc, plannerBot, sceneShift, sceneStep, shiftStep, statusEvents,
  warEvents, zoneOfThread,
} from '../src/game/social-director.js'
import { hydrateNeighbors } from '../src/game/neighbors.js'
import { MOOD_MS, makeScene, partsAt } from '../src/game/social.js'
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
  const t0 = 1_000_000
  const first = statusEvents(new Map(), [agent('a', 'working'), agent('b', 'idle'), agent('c', 'working'), agent('d', 'sleeping')], t0)
  assert.deepEqual(first.events, [], 'a bot seen for the first time has not changed')
  const next = statusEvents(first.seen, [agent('a', 'idle'), agent('b', 'idle'), agent('c', 'blocked'), agent('d', 'idle'), agent('e', 'idle')], t0 + 1000)
  assert.deepEqual(next.events, [{ kind: 'finished', id: 'a', at: t0 + 1000 }], 'stamped with when it was seen')
  assert.equal(next.seen.get('c').status, 'blocked')
  // Stuck, then sorted out: the run did not finish, it broke.
  assert.deepEqual(statusEvents(next.seen, [agent('c', 'idle')], t0 + 2000).events, [])
  // And the same step is only reported once.
  assert.deepEqual(statusEvents(next.seen, [agent('a', 'idle')], t0 + 2000).events, [])
})

test('a run that ends waiting on you still finished, once you have read it, if that is within ten minutes', () => {
  assert.equal(FINISH_WINDOW_MS, 10 * 60 * 1000)
  const t0 = 1_000_000
  const working = statusEvents(new Map(), [agent('a', 'working'), agent('b', 'working')], t0)
  const unread = statusEvents(working.seen, [agent('a', 'waiting'), agent('b', 'waiting')], t0 + 1000)
  assert.deepEqual(unread.events, [])
  // Still unread on the next scans: the clock runs from when it stopped working, not from the last scan.
  const still = statusEvents(unread.seen, [agent('a', 'waiting'), agent('b', 'waiting')], t0 + 5 * 60 * 1000)
  assert.deepEqual(still.events, [])
  const read = statusEvents(still.seen, [agent('a', 'idle')], t0 + 1000 + FINISH_WINDOW_MS)
  assert.deepEqual(read.events, [{ kind: 'finished', id: 'a', at: t0 + 1000 + FINISH_WINDOW_MS }], 'read within ten minutes')
  const late = statusEvents(still.seen, [agent('b', 'idle')], t0 + 1000 + FINISH_WINDOW_MS + 1)
  assert.deepEqual(late.events, [], 'read after ten minutes: old news')
  // Waiting with no run before it is not a run finishing either.
  const idle = statusEvents(new Map(), [agent('c', 'idle')], t0)
  const asked = statusEvents(idle.seen, [agent('c', 'waiting')], t0 + 1000)
  assert.deepEqual(statusEvents(asked.seen, [agent('c', 'idle')], t0 + 2000).events, [])
})

test('a home thread that is archived, or vanishes from the scan, is a heartbreak for its repo', () => {
  const before = byId([thread('a', 'x'), thread('b', 'x'), thread('c', 'y'), thread('d', 'z')])
  const after = byId([thread('b', 'x')])
  const scan = [thread('a', 'x', { archived: true }), thread('b', 'x'), thread('d', 'z')]
  const events = departureEvents({ before, after, scan, archivedIds: new Set(['d']) }, 7)
  assert.deepEqual(events, [
    { kind: 'archived', zone: 'x', owner: 'home', at: 7 }, // archived flag
    { kind: 'archived', zone: 'y', owner: 'home', at: 7 }, // gone from the scan
    { kind: 'archived', zone: 'z', owner: 'home', at: 7 }, // on the archive list
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
  const events = departureEvents({ before, after: byId([thread('d', 'y')]), scan: [] }, 7)
  assert.deepEqual(events, [{ kind: 'archived', zone: 'x', owner: 'home', at: 7 }])
})

test('a friend\'s thread that drops out of what they share is theirs to mourn; a friend going entirely is not', () => {
  const shop = (nid, ...ids) => [nid, new Map(ids.map((id) => [`nb:${nid}:${id}`, 'shop']))]
  const friendsBefore = new Map([shop('mark', 1, 2), shop('sue', 1)])
  // Mark loses one thread and keeps one; Sue's whole settlement goes (removed, or offline).
  const friendsAfter = new Map([shop('mark', 2)])
  assert.deepEqual(departureEvents({ friendsBefore, friendsAfter }, 5), [{ kind: 'archived', zone: 'nb:mark/shop', owner: 'mark', at: 5 }])
  // Home threads and friends' are kept apart even with the same repo name.
  const both = departureEvents({
    before: byId([thread('a', 'shop')]), after: new Map(), scan: [],
    friendsBefore, friendsAfter,
  })
  assert.deepEqual(both.map((e) => e.owner), ['home', 'mark'])
})

/** What a friend shares, as their snapshot carries it. */
const sharedThread = (n, extra = {}) => ({
  id: `n:${String(n).padStart(16, '0')}`, project: 'shop', harness: 'claude-code', harnessName: 'Claude Code',
  running: false, unread: false, hasError: false, prState: '', lastActivityAt: 5, createdAt: n, sizeBucket: 12, isErrand: false,
  ...extra,
})
/** One poll of Mark's settlement, hydrated the way the page does it. */
const markPoll = (threads, { status = 'online', now = 10_000_000 } = {}) => hydrateNeighbors(
  [{ id: 'mark', slot: 0 }],
  [{ id: 'mark', status, lastSeenAt: 9, snapshot: { v: 1, name: 'Mark', generatedAt: 1, projects: [{ name: 'shop', cells: [[0, 0]] }], threads } }],
  now,
)
const friendsOf = (hydrated) => new Map(hydrated.map((n) => [n.id, n.shared]))
const leaving = (a, b) => departureEvents({ friendsBefore: friendsOf(a), friendsAfter: friendsOf(b) }, 0)

test('a friend\'s errand ending is no loss, nor is their settlement going offline', () => {
  const errand = sharedThread(9, { isErrand: true, running: true })
  const before = markPoll([sharedThread(1), sharedThread(2), errand])
  assert.equal(before[0].shared.size, 2, 'the errand is not among what they share')
  assert.deepEqual(leaving(before, markPoll([sharedThread(1), sharedThread(2)])), [])
  // Away: their errands are dropped from the map, but nothing they share has gone.
  assert.deepEqual(leaving(before, markPoll([sharedThread(1), sharedThread(2), errand], { status: 'away' })), [])
})

test('a friend\'s thread that only drops out of the threads drawn has not gone anywhere', () => {
  const now = 10_000_000
  // Seventy shared, sixty drawn, ranked by how recently each was active: the next poll re-ranks them.
  const all = (fresh) => Array.from({ length: 70 }, (_, i) => sharedThread(i + 1, { lastActivityAt: fresh(i) ? now - 1000 : now - 3_600_000 - i }))
  const first = markPoll(all((i) => i < 60), { now })
  const second = markPoll(all((i) => i >= 10), { now })
  assert.equal(first[0].shared.size, 70, 'every shared thread is known, drawn or not')
  const drawn = (h) => new Set(h[0].threads.map((t) => t.id))
  assert.ok([...drawn(first)].some((id) => !drawn(second).has(id)), 'the drawn set changed')
  assert.deepEqual(leaving(first, second), [])
})

test('a friend who rotates their key changes every id at once: a reset, not a storm of heartbreaks', () => {
  const before = markPoll([1, 2, 3, 4].map((n) => sharedThread(n)))
  const rotated = markPoll([11, 12, 13, 14].map((n) => sharedThread(n)))
  assert.deepEqual(leaving(before, rotated), [])
  // Losing more than half in one poll reads the same way; half or fewer is real.
  assert.deepEqual(leaving(before, markPoll([sharedThread(1)])), [])
  assert.deepEqual(leaving(before, markPoll([sharedThread(1), sharedThread(2)])), [{ kind: 'archived', zone: 'nb:mark/shop', owner: 'mark', at: 0 }])
})

test('a friend\'s thread really leaving is one heartbreak', () => {
  const before = markPoll([1, 2, 3, 4].map((n) => sharedThread(n)))
  assert.deepEqual(leaving(before, markPoll([1, 2, 4].map((n) => sharedThread(n)))), [{ kind: 'archived', zone: 'nb:mark/shop', owner: 'mark', at: 0 }])
})

test('a battle\'s result: home and the friend it fought, opposite ways round, while it is fresh', () => {
  const now = 1_000_000
  assert.deepEqual(warEvents({ won: true, enemyId: 'mark', endedAt: now - 1000 }, now), [
    { kind: 'warResult', owner: 'home', won: true, at: now },
    { kind: 'warResult', owner: 'mark', won: false, at: now },
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

test('a heartbreak is never moved: the sad one sits where it is, and only the comforter finds clear ground', () => {
  const members = [{ id: 'sad', owner: 'home', pos: { x: 0, z: 0 } }, { id: 'pal', owner: 'home', pos: { x: 6, z: 0 } }]
  const scene = makeScene('heartbreak', members, 0, mulberry32(1))
  // A wall across the middle, clear of both spots: it stays where it is, the sad one unmoved.
  assert.deepEqual(sceneShift(scene, (x) => Math.abs(x - 3) > 0.5), { x: 0, z: 0 })
  // The comforter's spot in a wall: still not moved, so the sad one is not dragged off its seat.
  const wall = (x, z) => Math.hypot(x - scene.spots.pal.x, z - scene.spots.pal.z) > 0.3
  assert.deepEqual(sceneShift(scene, wall), { x: 0, z: 0 })
  // Its own spot read as blocked, even: a bot already standing there can sit there.
  assert.deepEqual(sceneShift(scene, (x, z) => Math.hypot(x, z) > 0.3), { x: 0, z: 0 })
  const off = { x: 0, z: 0 }
  const parts = partsAt(scene, 2000)
  const clearSpot = { x: 7, z: 7 }
  assert.deepEqual(sceneStep(scene, 'pal', parts.pal, off, wall, () => clearSpot).goal, clearSpot, 'the comforter goes to clear ground')
  const nowhere = () => false
  assert.deepEqual(sceneStep(scene, 'sad', parts.sad, off, nowhere, () => clearSpot).goal, scene.spots.sad, 'the sad one stays put')
  // Any other scene's steps are treated alike.
  const chat = makeScene('chat', members, 0, mulberry32(1))
  assert.deepEqual(sceneStep(chat, 'sad', partsAt(chat, 2000).sad, off, nowhere, () => clearSpot).goal, clearSpot)
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

/**
 * Enough of a browser for the director's bubbles to build their atlas: nothing is drawn under node,
 * so every canvas call does nothing.
 */
function withFakeCanvas(fn) {
  const ctx = new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => {}) })
  const saved = { document: globalThis.document, Path2D: globalThis.Path2D }
  globalThis.document = { createElement: () => ({ getContext: () => ctx }) }
  globalThis.Path2D = class {}
  try {
    return fn()
  } finally {
    Object.assign(globalThis, saved)
  }
}

function fakeColony(agents) {
  return {
    scene: new THREE.Scene(),
    settings: { get: () => true },
    buildings: new Map(agents.map((a) => [a.id, { plot: 'repo' }])),
    nav: null,
    groundAt: () => 0,
    astronauts: {
      agents,
      byId: new Map(agents.map((a) => [a.id, a])),
      setSceneOrders: () => true,
      clearSceneOrders() {},
    },
  }
}

test('back from a long gap, the director looks afresh: a run that ended while nobody watched is not news', () => {
  const a = agent('a', 'working')
  const director = withFakeCanvas(() => new SocialDirector(fakeColony([a])))
  const t0 = 1_000_000
  director.update(t0)
  a.status = 'idle'
  // A tab left in the background: no frames for forty seconds.
  director.update(t0 + 40_000)
  assert.deepEqual(director.planner.pending, [])
  // While it is watched, the same step is an event (one bot is too few for a scene, so it waits).
  a.status = 'working'
  director.update(t0 + 40_250)
  a.status = 'idle'
  director.update(t0 + 40_500)
  assert.deepEqual(director.planner.pending.map((e) => [e.kind, e.id]), [['finished', 'a']])
  director.dispose()
})

test('an event is stamped when it is noted, so one that sat behind a hidden tab is let go', () => {
  const director = withFakeCanvas(() => new SocialDirector(fakeColony([agent('a')])))
  const t0 = 1_000_000
  director.noteThreads({ before: byId([thread('x', 'repo')]), after: new Map(), scan: [] }, t0)
  director.noteWarResult({ won: true, enemyId: 'mark' }, t0)
  assert.deepEqual(director.events.map((e) => e.at), [t0, t0, t0])
  director.update(t0 + MOOD_MS)
  assert.deepEqual(director.planner.pending, [])
  assert.deepEqual(director.planner.moods, [])
  director.dispose()
})
