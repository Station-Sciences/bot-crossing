/**
 * The social planner: which idle bots get together, when, for what, and what each of them does
 * moment by moment. It is pure and seeded, so every rule in the spec — who may take part, how many
 * scenes, how long, how often, who with — can be held to account here without a renderer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIONS, EMOTES, EXPRESSIONS, AMBIENT, BOTS_PER_SCENE, MAX_SCENES, MOOD_MS, NEAR, REST_MS, SCENE_MS,
  SocialPlanner, canSocialise, makeScene, near, partsAt, pickAmbient, planSocial, sceneLimit, stillValid,
} from '../src/game/social.js'
import { mulberry32 } from '../src/game/war.js'

const bot = (id, extra = {}) => ({
  id, status: 'idle', pos: { x: 0, z: 0 }, zone: 'repo', owner: 'home', atWar: false, restUntil: 0, ...extra,
})
/** `n` bots in a row half a unit apart, ids sorting in creation order. */
const crowd = (n, prefix = 'b', extra = {}) =>
  Array.from({ length: n }, (_, i) => bot(`${prefix}${String(i).padStart(3, '0')}`, { pos: { x: i * 0.5, z: 0 }, ...extra }))
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const KINDS = ['chat', 'group', 'argue', 'heartbreak', 'play']

/**
 * Runs a planner the way the director will: a tick every `dt`, the roster and events as functions
 * of the clock. Checks the invariants that must hold on every tick as it goes — no bot in two live
 * scenes, never more scenes than the limit — and hands back everything that happened.
 */
function simulate({ seed = 1, bots, events = () => [], from = 1000, ms = 300000, dt = 500 }) {
  const planner = new SocialPlanner({ seed })
  const started = []
  const ended = []
  const log = []
  for (let now = from; now <= from + ms; now += dt) {
    const roster = typeof bots === 'function' ? bots(now) : bots
    const out = planner.tick({ now, bots: roster, events: events(now) })
    for (const s of out.start) started.push({ scene: s, now })
    for (const id of out.end) ended.push({ id, now })
    log.push({ now, out })
    const live = planner.active.flatMap((s) => s.cast.filter((id) => !s.gone.includes(id)))
    assert.equal(new Set(live).size, live.length, `a bot is in two scenes at ${now}`)
    assert.ok(out.start.length === 0 || planner.active.length <= sceneLimit(roster), `over the limit at ${now}`)
  }
  return { planner, started, ended, log }
}

// --- who may take part ---

test('only idle bots socialise: never sleeping, working, waiting, blocked or celebrating', () => {
  assert.deepEqual(
    ['idle', 'sleeping', 'working', 'waiting', 'blocked', 'celebrating'].map((status) => canSocialise(bot('a', { status }))),
    [true, false, false, false, false, false]
  )
  assert.equal(canSocialise(undefined), false)
  const others = ['sleeping', 'working', 'waiting', 'blocked', 'celebrating']
  const bots = [...crowd(12, 'i'), ...others.flatMap((status) => crowd(12, status.slice(0, 3), { status }))]
  const { started } = simulate({ bots })
  assert.ok(started.length > 5, 'scenes should happen')
  for (const { scene } of started) for (const id of scene.cast) assert.ok(id.startsWith('i'), `${id} is not idle`)
})

test('only idle bots count toward the limit: five idle among thirty asleep start nothing', () => {
  const bots = [...crowd(5, 'i'), ...crowd(30, 's', { status: 'sleeping' })]
  assert.equal(sceneLimit(bots), 0)
  const { started } = simulate({ bots, events: (now) => (now === 1000 ? [{ kind: 'archived', zone: 'repo', owner: 'home' }] : []) })
  assert.equal(started.length, 0)
})

test('war outranks social: a bot under war orders is never cast', () => {
  const bots = [...crowd(12, 'p'), ...crowd(12, 'w', { atWar: true })]
  assert.equal(canSocialise(bot('a', { atWar: true })), false)
  assert.equal(sceneLimit(bots), 2, 'fighters are not idle bots for the limit either')
  const { started } = simulate({ bots })
  assert.ok(started.length > 3)
  for (const { scene } of started) for (const id of scene.cast) assert.ok(id.startsWith('p'), `${id} is at war`)
})

test('a battle starting ends any scene its fighters were in', () => {
  const bots = crowd(12)
  const rand = mulberry32(3)
  const scene = makeScene('group', bots.slice(0, 4), 1000, rand)
  const atWar = bots.map((b) => ({ ...b, atWar: true }))
  const out = planSocial({ now: 2000, bots: atWar, active: [scene], rand })
  assert.deepEqual(out.end, [scene.id])
  assert.equal(out.start.length, 0)
  assert.equal(out.active.length, 0)
})

// --- a participant leaving ---

test('a participant whose status changes leaves at once; the scene goes on while it still has enough', () => {
  const bots = crowd(12)
  const rand = mulberry32(9)
  const scene = makeScene('group', bots.slice(0, 4), 1000, rand)
  const busy = bots.map((b) => (b.id === scene.cast[1] ? { ...b, status: 'working' } : b))
  assert.equal(stillValid(scene, busy), true, 'three is still a group')
  const out = planSocial({ now: 2000, bots: busy, active: [scene], rand })
  assert.deepEqual(out.end, [])
  assert.deepEqual(out.left, [{ scene: scene.id, id: scene.cast[1] }])
  assert.deepEqual(out.active[0].gone, [scene.cast[1]])
  assert.ok(!(scene.cast[1] in partsAt(out.active[0], 2500)), 'its part has ended')
  assert.equal(Object.keys(partsAt(out.active[0], 2500)).length, 3)
  // It does not drift back in when its thread goes quiet again: its part is over.
  const again = planSocial({ now: 3000, bots, active: out.active, rand })
  assert.deepEqual(again.left, [])
  assert.deepEqual(again.active[0].gone, [scene.cast[1]])
  // A second loss leaves two, which is not a group: the scene ends.
  const twoGone = busy.map((b) => (b.id === scene.cast[2] ? { ...b, status: 'waiting' } : b))
  assert.equal(stillValid(again.active[0], twoGone), false)
  // Even with the first one idle again: it left, so it does not count toward keeping the group going.
  const backButOneMore = bots.map((b) => (b.id === scene.cast[2] ? { ...b, status: 'waiting' } : b))
  assert.equal(stillValid(again.active[0], backButOneMore), false)
  assert.deepEqual(planSocial({ now: 3500, bots: twoGone, active: again.active, rand }).end, [scene.id])
})

test('a two-bot scene ends the moment either bot is needed elsewhere, or disappears', () => {
  const bots = crowd(12)
  for (const kind of ['chat', 'argue', 'heartbreak']) {
    for (const who of [0, 1]) {
      const scene = makeScene(kind, bots.slice(0, 2), 1000, mulberry32(4))
      const changed = bots.map((b) => (b.id === scene.cast[who] ? { ...b, status: 'blocked' } : b))
      assert.equal(stillValid(scene, bots), true)
      assert.equal(stillValid(scene, changed), false, `${kind} without cast[${who}]`)
      assert.equal(stillValid(scene, bots.filter((b) => b.id !== scene.cast[who])), false)
    }
  }
  const play = makeScene('play', bots.slice(0, 3), 1000, mulberry32(4))
  assert.equal(stillValid(play, bots.map((b) => (b.id === play.cast[0] ? { ...b, status: 'sleeping' } : b))), true)
})

test('a scene ends when its time is up', () => {
  const bots = crowd(12)
  const rand = mulberry32(5)
  const scene = makeScene('chat', bots.slice(0, 2), 1000, rand)
  assert.deepEqual(planSocial({ now: 1000 + scene.durationMs - 1, bots, active: [scene], rand, ambientAt: Infinity }).end, [])
  assert.deepEqual(planSocial({ now: 1000 + scene.durationMs, bots, active: [scene], rand, ambientAt: Infinity }).end, [scene.id])
})

// --- limits ---

test('at most one scene per six idle bots', () => {
  const archived = Array.from({ length: 6 }, () => ({ kind: 'archived', zone: 'repo', owner: 'home' }))
  for (const [n, want] of [[5, 0], [6, 1], [11, 1], [12, 2], [17, 2], [18, 3]]) {
    const bots = crowd(n)
    assert.equal(sceneLimit(bots), want)
    const out = planSocial({ now: 1000, bots, events: archived, rand: mulberry32(n) })
    assert.equal(out.start.length, want, `${n} idle bots`)
  }
  assert.equal(BOTS_PER_SCENE, 6)
})

test('never more than eight scenes at once, however many bots are idle', () => {
  assert.equal(MAX_SCENES, 8)
  const bots = crowd(200)
  assert.equal(sceneLimit(bots), 8)
  const archived = Array.from({ length: 20 }, () => ({ kind: 'archived', zone: 'repo', owner: 'home' }))
  assert.equal(planSocial({ now: 1000, bots, events: archived, rand: mulberry32(1) }).start.length, 8)
  const { log } = simulate({ bots, ms: 120000 })
  for (const { out } of log) assert.ok(out.active.length <= 8)
  assert.ok(log.some(({ out }) => out.active.length >= 3), 'the colony should get busy')
})

test('scenes already running count toward the limit', () => {
  const bots = crowd(12)
  const rand = mulberry32(2)
  const running = [makeScene('chat', bots.slice(0, 2), 1000, rand), makeScene('chat', bots.slice(2, 4), 1000, rand)]
  const out = planSocial({ now: 2000, bots, active: running, rand, events: [{ kind: 'archived', zone: 'repo', owner: 'home' }] })
  assert.equal(out.start.length, 0)
})

test('scenes last six to fifteen seconds', () => {
  for (const kind of KINDS) {
    const [lo, hi] = SCENE_MS[kind]
    assert.ok(lo >= 6000 && hi <= 15000 && lo <= hi, kind)
  }
  const bots = crowd(6)
  for (let seed = 1; seed <= 200; seed++) {
    for (const kind of KINDS) {
      const s = makeScene(kind, kind === 'group' ? bots.slice(0, 4) : bots.slice(0, 2), 0, mulberry32(seed))
      assert.ok(s.durationMs >= 6000 && s.durationMs <= 15000, `${kind} ${s.durationMs}`)
    }
  }
  const { started } = simulate({ bots: crowd(40) })
  for (const { scene } of started) assert.ok(scene.durationMs >= 6000 && scene.durationMs <= 15000)
})

// --- rest ---

test('each bot rests thirty to sixty seconds after a scene before its next', () => {
  assert.deepEqual(REST_MS, [30000, 60000])
  const bots = crowd(12)
  const rand = mulberry32(6)
  const scene = makeScene('chat', bots.slice(0, 2), 1000, rand)
  const now = 1000 + scene.durationMs
  const out = planSocial({ now, bots, active: [scene], rand })
  for (const id of scene.cast) {
    assert.ok(out.rest[id] >= now + 30000 && out.rest[id] <= now + 60000, `${id} rests until ${out.rest[id]}`)
    for (const s of out.start) assert.ok(!s.cast.includes(id), 'not straight back into another scene')
  }
  // Over a long run, nobody is cast within thirty seconds of their last part ending.
  const { log } = simulate({ bots: crowd(24), ms: 600000 })
  const lastEnd = new Map()
  const live = new Map()
  for (const { now, out: o } of log) {
    for (const id of o.end) for (const b of live.get(id) ?? []) lastEnd.set(b, now)
    for (const { id } of o.left) lastEnd.set(id, now)
    for (const s of o.start) {
      for (const b of s.cast) assert.ok(!lastEnd.has(b) || now - lastEnd.get(b) >= 30000, `${b} rested ${now - lastEnd.get(b)}`)
      live.set(s.id, s.cast)
    }
  }
})

test('a bot still resting is not cast; one whose rest is over may be', () => {
  const bots = crowd(12).map((b, i) => (i < 11 ? { ...b, restUntil: 5000 } : b))
  const events = [{ kind: 'archived', zone: 'repo', owner: 'home' }]
  const quiet = { rand: mulberry32(1), ambientAt: Infinity }
  assert.equal(planSocial({ ...quiet, now: 4999, bots, events }).start.length, 0, 'one free bot is not enough')
  assert.equal(planSocial({ ...quiet, now: 5000, bots, events }).start.length, 1)
})

// --- proximity ---

test('participants come from the same zone or within about fifteen units, of the same settlement', () => {
  assert.equal(NEAR, 15)
  const a = bot('a', { zone: 'x', pos: { x: 0, z: 0 } })
  assert.equal(near(a, bot('b', { zone: 'x', pos: { x: 100, z: 0 } })), true, 'same zone, however far')
  assert.equal(near(a, bot('b', { zone: 'y', pos: { x: 9, z: 12 } })), true, 'fifteen units')
  assert.equal(near(a, bot('b', { zone: 'y', pos: { x: 12, z: 12 } })), false)
  assert.equal(near(a, bot('b', { zone: 'x', owner: 'mark', pos: { x: 0, z: 0 } })), false, 'never across settlements')
  assert.equal(near(bot('a', { zone: null }), bot('b', { zone: null, pos: { x: 40, z: 0 } })), false, 'no zone is not a shared zone')
})

test('far-apart zones never mix, and friends\' bots socialise only within their own settlement', () => {
  const bots = [
    ...crowd(8, 'h', { zone: 'west' }),
    ...crowd(8, 'e', { zone: 'east' }).map((b) => ({ ...b, pos: { x: b.pos.x + 200, z: 0 } })),
    ...crowd(8, 'm', { owner: 'mark' }),
  ]
  const { started } = simulate({ bots, ms: 600000 })
  assert.ok(started.length > 10)
  const byId = new Map(bots.map((b) => [b.id, b]))
  for (const { scene } of started) {
    const cast = scene.cast.map((id) => byId.get(id))
    assert.equal(new Set(cast.map((b) => b.owner)).size, 1, 'one settlement per scene')
    assert.equal(new Set(cast.map((b) => b.zone)).size, 1, 'zones 200 apart never mix')
    assert.equal(scene.owner, cast[0].owner)
  }
})

// --- ambient ---

test('ambient scenes are picked by weight: chat 45, group 20, play 20, argue 10, heartbreak 5', () => {
  assert.deepEqual(AMBIENT, [['chat', 0.45], ['group', 0.2], ['play', 0.2], ['argue', 0.1], ['heartbreak', 0.05]])
  const at = [[0, 'chat'], [0.4499, 'chat'], [0.45, 'group'], [0.6499, 'group'], [0.65, 'play'], [0.8499, 'play'],
    [0.85, 'argue'], [0.9499, 'argue'], [0.95, 'heartbreak'], [0.99999, 'heartbreak']]
  for (const [r, kind] of at) assert.equal(pickAmbient(r), kind, `r = ${r}`)
  const rand = mulberry32(7)
  const n = 20000
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]))
  for (let i = 0; i < n; i++) counts[pickAmbient(rand())]++
  for (const [kind, w] of AMBIENT) assert.ok(Math.abs(counts[kind] / n - w) < 0.015, `${kind} ${counts[kind] / n}`)
})

test('the ambient mix shows up in a long run, and ambient scenes do not all start at once', () => {
  const { started, log } = simulate({ bots: crowd(48), ms: 1800000 })
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]))
  for (const { scene } of started) counts[scene.kind]++
  for (const kind of KINDS) assert.ok(counts[kind] > 0, `no ${kind} in half an hour`)
  assert.ok(counts.chat > counts.argue && counts.argue > counts.heartbreak, JSON.stringify(counts))
  for (const { out } of log) assert.ok(out.start.length <= 1, 'one ambient scene at a time')
  const times = started.map(({ now }) => now)
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 2000, `ambient scenes ${times[i] - times[i - 1]} ms apart`)
})

// --- events ---

test('an archived thread breaks a repo-mate\'s heart, and the nearest idle bot comes to comfort it', () => {
  const bots = [
    bot('sad', { zone: 'repo', pos: { x: 0, z: 0 } }),
    bot('far', { zone: 'other', pos: { x: 12, z: 0 } }),
    bot('close', { zone: 'other', pos: { x: 3, z: 1 } }),
    bot('busy', { zone: 'other', pos: { x: 1, z: 0 }, status: 'working' }),
    bot('friend', { zone: 'other', owner: 'mark', pos: { x: 0.5, z: 0 } }),
    ...crowd(8, 'x', { zone: 'elsewhere' }).map((b) => ({ ...b, pos: { x: 500, z: b.pos.x } })),
  ]
  const out = planSocial({ now: 1000, bots, events: [{ kind: 'archived', zone: 'repo', owner: 'home' }], rand: mulberry32(1), ambientAt: Infinity })
  assert.equal(out.start.length, 1)
  assert.equal(out.start[0].kind, 'heartbreak')
  assert.deepEqual(out.start[0].cast, ['sad', 'close'])
  // A friend's thread archived breaks a heart in their settlement, not ours.
  const theirs = planSocial({ now: 1000, bots: [...bots, ...crowd(3, 'mk', { owner: 'mark', zone: 'repo' })], events: [{ kind: 'archived', zone: 'repo', owner: 'mark' }], rand: mulberry32(1), ambientAt: Infinity })
  assert.equal(theirs.start.length, 1)
  assert.ok(theirs.start[0].cast.every((id) => id === 'friend' || id.startsWith('mk')))
})

test('an archived thread with nobody idle in its repo, or nobody near to comfort, starts nothing', () => {
  const bots = [bot('lonely', { zone: 'repo' }), ...crowd(11, 'x', { zone: 'elsewhere' }).map((b) => ({ ...b, pos: { x: 500, z: b.pos.x } }))]
  const none = { now: 1000, rand: mulberry32(1), ambientAt: Infinity }
  assert.equal(planSocial({ ...none, bots, events: [{ kind: 'archived', zone: 'repo', owner: 'home' }] }).start.length, 0)
  assert.equal(planSocial({ ...none, bots, events: [{ kind: 'archived', zone: 'gone', owner: 'home' }] }).start.length, 0)
})

test('a thread that finishes a run invites an idle repo-mate to play', () => {
  const bots = [
    bot('done', { zone: 'repo', pos: { x: 0, z: 0 } }),
    bot('mate', { zone: 'repo', pos: { x: 9, z: 0 } }),
    bot('mate2', { zone: 'repo', pos: { x: 14, z: 0 } }),
    bot('stranger', { zone: 'other', pos: { x: 1, z: 0 } }),
    ...crowd(8, 'x', { zone: 'elsewhere' }).map((b) => ({ ...b, pos: { x: 500, z: b.pos.x } })),
  ]
  const out = planSocial({ now: 1000, bots, events: [{ kind: 'finished', id: 'done' }], rand: mulberry32(1), ambientAt: Infinity })
  assert.equal(out.start.length, 1)
  assert.equal(out.start[0].kind, 'play')
  assert.deepEqual(out.start[0].cast, ['done', 'mate'])
  // Still resting, or with no repo-mate free, it plays with nobody.
  const resting = bots.map((b) => (b.id === 'done' ? { ...b, restUntil: 2000 } : b))
  assert.equal(planSocial({ now: 1000, bots: resting, events: [{ kind: 'finished', id: 'done' }], rand: mulberry32(1), ambientAt: Infinity }).start.length, 0)
  const alone = bots.filter((b) => !b.id.startsWith('mate'))
  assert.equal(planSocial({ now: 1000, bots: alone, events: [{ kind: 'finished', id: 'done' }], rand: mulberry32(1), ambientAt: Infinity }).start.length, 0)
})

test('after a battle, for a minute, the losers argue and the winners play', () => {
  const bots = [...crowd(12, 'h'), ...crowd(12, 'm', { owner: 'mark' })]
  const result = [{ kind: 'warResult', owner: 'home', won: false }, { kind: 'warResult', owner: 'mark', won: true }]
  const { started, log } = simulate({ bots, events: (now) => (now === 1000 ? result : []), ms: 240000 })
  const first = log[0].out
  assert.equal(first.start.length, 4, 'event scenes jump the queue, up to the limit')
  assert.ok(first.start.some((s) => s.owner === 'home') && first.start.some((s) => s.owner === 'mark'), 'both sides get a turn')
  assert.deepEqual(first.moods.map((m) => [m.owner, m.won, m.until]), [['home', false, 1000 + MOOD_MS], ['mark', true, 1000 + MOOD_MS]])
  const during = started.filter(({ now }) => now < 1000 + MOOD_MS)
  const after = started.filter(({ now }) => now >= 1000 + MOOD_MS)
  assert.ok(during.length > 4)
  for (const { scene } of during) assert.equal(scene.kind, scene.owner === 'home' ? 'argue' : 'play')
  assert.ok(after.length > 0 && after.some(({ scene }) => scene.kind !== 'argue' && scene.kind !== 'play'), 'then back to ordinary life')
  assert.deepEqual(log.find(({ now }) => now >= 1000 + MOOD_MS).out.moods, [])
})

test('event scenes still obey the limits', () => {
  const bots = crowd(12)
  const busy = [makeScene('chat', bots.slice(0, 2), 0, mulberry32(1)), makeScene('chat', bots.slice(2, 4), 0, mulberry32(2))]
  const events = [{ kind: 'archived', zone: 'repo', owner: 'home' }, { kind: 'finished', id: bots[5].id }]
  assert.equal(planSocial({ now: 1000, bots, events, active: busy, rand: mulberry32(1) }).start.length, 0)
})

// --- what each bot does ---

const isPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.z)
function everyStep(scene, fn) {
  for (let t = -500; t <= scene.durationMs + 500; t += 50) {
    const steps = scene.steps(t)
    assert.deepEqual(Object.keys(steps).sort(), [...scene.cast].sort())
    for (const id of scene.cast) fn(steps[id], id, t)
  }
}

test('every step uses only the vocabulary the bots understand, and never a status look', () => {
  assert.deepEqual(ACTIONS, ['walk', 'talk', 'wave', 'stomp', 'sit', 'stand', 'cheer', 'jump', 'run', 'kick'])
  assert.deepEqual(EMOTES, ['chat', 'angry', 'heartbreak', 'sad', 'love', 'ball', 'music'])
  assert.deepEqual(EXPRESSIONS, ['happy', 'wink', 'grumpy', 'sad', 'love', 'cheer'])
  const bots = crowd(6).map((b, i) => ({ ...b, pos: { x: Math.cos(i) * 4, z: Math.sin(i) * 4 } }))
  for (let seed = 1; seed <= 30; seed++) {
    for (const kind of KINDS) {
      for (const n of kind === 'group' ? [3, 4, 5] : kind === 'play' ? [2, 3, 4] : [2]) {
        const scene = makeScene(kind, bots.slice(0, n), 0, mulberry32(seed))
        everyStep(scene, (s, id, t) => {
          const where = `${kind}/${scene.variant ?? ''} ${id} at ${t}`
          assert.deepEqual(Object.keys(s).sort(), ['action', 'emote', 'expression', 'face', 'goal'], where)
          assert.ok(ACTIONS.includes(s.action), `${where}: action ${s.action}`)
          assert.ok(s.emote === null || EMOTES.includes(s.emote), `${where}: emote ${s.emote}`)
          assert.ok(s.expression === null || EXPRESSIONS.includes(s.expression), `${where}: expression ${s.expression}`)
          assert.ok(s.goal === null || isPoint(s.goal), where)
          assert.ok(s.face === null || isPoint(s.face) || (scene.cast.includes(s.face) && s.face !== id), `${where}: face ${s.face}`)
        })
      }
    }
  }
})

test('a chat: two bots meet, face each other and take turns, then wave', () => {
  const [a, b] = [bot('a', { pos: { x: 0, z: 0 } }), bot('b', { pos: { x: 6, z: 0 } })]
  const s = makeScene('chat', [a, b], 1000, mulberry32(1))
  assert.equal(s.startedAt, 1000)
  assert.ok(dist(s.spots.a, s.spots.b) > 1 && dist(s.spots.a, s.spots.b) < 2, 'close enough to talk')
  const speakers = new Set()
  everyStep(s, (step, id, t) => {
    assert.equal(step.face, id === 'a' ? 'b' : 'a')
    assert.deepEqual(step.goal, s.spots[id])
    if (step.action === 'talk') {
      assert.equal(step.emote, 'chat')
      speakers.add(id)
    }
  })
  assert.deepEqual([...speakers].sort(), ['a', 'b'], 'both get a turn')
  const mid = s.steps(s.durationMs / 2)
  assert.equal([mid.a, mid.b].filter((x) => x.action === 'talk').length, 1, 'one at a time')
  assert.deepEqual([s.steps(s.durationMs).a.action, s.steps(s.durationMs).b.action], ['wave', 'wave'])
})

test('a group chat gathers in a ring round its middle, and the turn hops round it', () => {
  const bots = crowd(5).map((b, i) => ({ ...b, pos: { x: i * 3, z: (i % 2) * 3 } }))
  const s = makeScene('group', bots, 0, mulberry32(1))
  const r = s.cast.map((id) => dist(s.spots[id], s.centre))
  for (const x of r) assert.ok(Math.abs(x - r[0]) < 1e-9 && x > 1 && x < 3)
  const speakers = new Set()
  everyStep(s, (step, id) => {
    assert.deepEqual(step.face, s.centre)
    if (step.action === 'talk') speakers.add(id)
  })
  assert.ok(speakers.size >= 3, 'the turn goes round')
})

test('an argument: a face-off with stomping and grumpy faces, then each walks off its own way', () => {
  const [a, b] = [bot('a', { pos: { x: 0, z: 0 } }), bot('b', { pos: { x: 6, z: 0 } })]
  const s = makeScene('argue', [a, b], 0, mulberry32(1))
  let stomped = false
  everyStep(s, (step) => {
    assert.equal(step.expression, 'grumpy')
    if (step.action === 'stomp') stomped = true
  })
  assert.ok(stomped)
  const mid = s.steps(s.durationMs * 0.4)
  assert.equal(mid.a.face, 'b')
  assert.equal(mid.a.emote, 'angry')
  const end = s.steps(s.durationMs)
  assert.equal(end.a.action, 'walk')
  assert.ok(dist(end.a.goal, end.b.goal) > dist(s.spots.a, s.spots.b) + 6, 'they part')
})

test('heartbreak: one sits down heartbroken, the other comes to comfort it, and it stands up cheered', () => {
  const [sad, pal] = [bot('sad', { pos: { x: 0, z: 0 } }), bot('pal', { pos: { x: 8, z: 0 } })]
  const s = makeScene('heartbreak', [sad, pal], 0, mulberry32(1))
  assert.deepEqual(s.spots.sad, sad.pos, 'it stays where its heart broke')
  assert.ok(dist(s.spots.pal, sad.pos) < 1.2, 'the comforter comes to stand beside it')
  const early = s.steps(200)
  assert.deepEqual([early.sad.action, early.sad.emote, early.sad.expression], ['sit', 'heartbreak', 'sad'])
  const emotes = { sad: new Set(), pal: new Set() }
  everyStep(s, (step, id) => step.emote && emotes[id].add(step.emote))
  assert.deepEqual([...emotes.sad].sort(), ['heartbreak', 'sad'])
  assert.deepEqual([...emotes.pal], ['love'])
  const comfort = s.steps(s.durationMs * 0.6)
  assert.equal(comfort.pal.face, 'sad')
  assert.equal(comfort.sad.action, 'sit')
  const late = s.steps(s.durationMs * 0.8)
  assert.equal(late.sad.action, 'stand')
  assert.equal(late.sad.expression, 'love')
})

test('play with a ball: passes go round the players, and the kicker kicks as each one leaves', () => {
  let s
  for (let seed = 1; !s; seed++) {
    const t = makeScene('play', crowd(3), 0, mulberry32(seed))
    if (t.variant === 'ball') s = t
  }
  assert.ok(s.passes.length >= 3)
  for (let k = 0; k < s.passes.length; k++) {
    const p = s.passes[k]
    assert.notEqual(p.from, p.to)
    if (k) assert.equal(p.from, s.passes[k - 1].to, 'the receiver kicks next')
    if (k) assert.ok(p.at > s.passes[k - 1].at)
    assert.ok(p.at < s.durationMs)
    const step = s.steps(p.at + 10)
    assert.equal(step[p.from].action, 'kick')
    assert.equal(step[p.from].face, p.to)
    assert.equal(step[p.from].emote, 'ball')
  }
  assert.equal(new Set(s.passes.map((p) => p.from)).size, 3, 'everyone gets the ball')
})

test('play at chase: they run round together and jump now and then, cheering', () => {
  let s
  for (let seed = 1; !s; seed++) {
    const t = makeScene('play', crowd(4), 0, mulberry32(seed))
    if (t.variant === 'chase') s = t
  }
  const actions = new Set()
  everyStep(s, (step) => {
    actions.add(step.action)
    assert.ok(step.expression === 'cheer' || step.expression === 'happy')
  })
  assert.ok(actions.has('run') && actions.has('jump'))
  const id = s.cast[0]
  assert.ok(dist(s.steps(3000)[id].goal, s.steps(5000)[id].goal) > 1, 'the goal moves round the circle')
})

// --- determinism ---

test('the same seed and the same colony give the same social life, whatever order the bots come in', () => {
  const bots = [...crowd(30, 'h'), ...crowd(12, 'm', { owner: 'mark' })]
  const events = (now) => (now === 5000 ? [{ kind: 'finished', id: 'h003' }, { kind: 'archived', zone: 'repo', owner: 'mark' }] : [])
  const story = (r) => r.started.map(({ now, scene }) => [now, scene.id, scene.kind, scene.cast, scene.durationMs, scene.steps(3000)])
  const a = simulate({ seed: 11, bots, events, ms: 240000 })
  const b = simulate({ seed: 11, bots: [...bots].reverse(), events, ms: 240000 })
  assert.ok(a.started.length > 10)
  assert.deepEqual(story(a), story(b))
  assert.deepEqual(a.ended, b.ended)
  assert.notDeepEqual(story(simulate({ seed: 12, bots, events, ms: 240000 })), story(a))
})

test('planSocial is pure: it changes none of its inputs', () => {
  const bots = crowd(12)
  const rand = mulberry32(1)
  const active = [makeScene('group', bots.slice(0, 4), 0, rand)]
  const busy = bots.map((b, i) => (i === 0 ? { ...b, status: 'working' } : b))
  const snapshot = JSON.stringify({ busy, active, moods: [] })
  const moods = []
  planSocial({ now: 2000, bots: busy, active, moods, rand, events: [{ kind: 'warResult', owner: 'home', won: true }] })
  assert.equal(JSON.stringify({ busy, active, moods }), snapshot)
})
