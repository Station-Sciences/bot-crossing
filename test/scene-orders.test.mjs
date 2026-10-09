import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mayMingle, orderLayer, keepsScene, cleanStep, nextStep, sceneArrival, scenePace, sceneClip, sceneRate, sceneHop, faceTarget, STOMP_EVERY } from '../src/agents/scene-orders.js'
import { ACTIONS, makeScene } from '../src/game/social.js'
import { mulberry32 } from '../src/game/war.js'

const step = (values = {}) => ({ goal: { x: 4, z: 0 }, face: null, action: 'talk', emote: null, expression: null, ...values })

test('only an idle bot out on its feet takes part in a scene — never a sleeper', () => {
  for (const state of ['at-site', 'walking']) assert.equal(mayMingle({ status: 'idle', state }), true, state)
  // Stricter than war: a sleeper is three days quiet and stays sat down.
  for (const status of ['sleeping', 'working', 'waiting', 'blocked', 'celebrating', 'leaving', 'spawning', undefined]) {
    assert.equal(mayMingle({ status, state: 'at-site' }), false, String(status))
  }
  for (const state of ['queued', 'spawning', 'held', 'falling', 'leaving', 'gone']) {
    assert.equal(mayMingle({ status: 'idle', state }), false, state)
  }
  assert.equal(mayMingle(null), false)
})

test('war outranks a scene: a bot with battle orders never keeps a step', () => {
  const bot = { status: 'idle', state: 'at-site', war: null, scene: step() }
  assert.equal(keepsScene(bot), true)
  assert.equal(orderLayer(bot), 'scene')
  bot.war = { action: 'march' }
  assert.equal(keepsScene(bot), false)
  assert.equal(orderLayer(bot), 'war', 'a fighter is a fighter, whatever part it had')
  assert.equal(orderLayer({ status: 'idle', state: 'at-site' }), null, 'no orders: its own life')
  // Re-checked every frame: a thread that wakes mid-chat leaves it.
  assert.equal(keepsScene({ status: 'working', state: 'at-site' }), false)
  assert.equal(keepsScene({ status: 'idle', state: 'held' }), false)
})

test('a step is copied and tidied, and nonsense is refused', () => {
  const given = step({ goal: { x: 1, z: 2, y: 9 }, face: { x: 3, z: 4 }, emote: 'chat', expression: 'grumpy', extra: 1 })
  const clean = cleanStep(given)
  assert.deepEqual(clean, { goal: { x: 1, z: 2 }, face: { x: 3, z: 4 }, action: 'talk', emote: 'chat', expression: 'grumpy' })
  given.goal.x = 99
  assert.equal(clean.goal.x, 1, 'not a reference to the caller\'s object')

  // Every action the planner can ask for is understood.
  for (const action of ACTIONS) assert.ok(cleanStep(step({ action })), action)
  // No goal is "stay put"; a face may be a bot by id.
  assert.equal(cleanStep(step({ goal: null })).goal, null)
  assert.equal(cleanStep(step({ goal: undefined })).goal, null)
  assert.equal(cleanStep(step({ face: 'bot-7' })).face, 'bot-7')
  // Broken extras are dropped; the bot still knows where to be.
  assert.equal(cleanStep(step({ face: { x: NaN, z: 0 } })).face, null)
  assert.equal(cleanStep(step({ face: '' })).face, null)
  assert.equal(cleanStep(step({ emote: 'shrug' })).emote, null)
  assert.equal(cleanStep(step({ expression: 'error' })).expression, null, 'no status face for an emotion')
  // A broken goal, or an action nobody knows, is not a step at all.
  for (const bad of [null, 'talk', {}, step({ action: 'dance' }), step({ action: 'fight' }), step({ goal: { x: 1 } }), step({ goal: { x: Infinity, z: 0 } })]) {
    assert.equal(cleanStep(bad), null, JSON.stringify(bad))
  }
})

test('the same action keeps its clock; arriving sticks while the goal stays put', () => {
  let held = nextStep(null, cleanStep(step({ action: 'stomp' })))
  assert.equal(held.t, 0)
  assert.equal(held.arrived, false)
  held.t = 1.5
  held.arrived = true
  held = nextStep(held, cleanStep(step({ action: 'stomp', emote: 'angry' })))
  assert.equal(held.t, 1.5, 'still mid-stomp, not starting again')
  assert.equal(held.emote, 'angry', 'but the rest of the step is the new one')
  // A chat's turns change the action under a bot already standing there.
  held = nextStep(held, cleanStep(step({ action: 'stand', goal: { x: 4.2, z: 0 } })))
  assert.equal(held.t, 0)
  assert.equal(held.arrived, true)
  // Somewhere new to be is somewhere to walk to.
  held = nextStep(held, cleanStep(step({ action: 'stand', goal: { x: 9, z: 0 } })))
  assert.equal(held.arrived, false)
  held.arrived = true
  held = nextStep(held, cleanStep(step({ action: 'stand', goal: null })))
  assert.equal(held.arrived, false)
})

test('walking to a spot is sticky; a chase never stops while its goal runs on', () => {
  const walk = cleanStep(step({ action: 'walk' }))
  assert.equal(sceneArrival(walk, 5), true)
  assert.equal(sceneArrival(walk, 0.5), false, 'there')
  assert.equal(sceneArrival(walk, 1.2), false, 'nudged by a neighbour, it holds its ground')
  assert.equal(sceneArrival(walk, 3), true, 'shoved well off it, it walks back')

  const chase = cleanStep(step({ action: 'run' }))
  assert.equal(sceneArrival(chase, 0.3), false)
  assert.equal(sceneArrival(chase, 1.2), true, 'not sticky: the goal is already away again')

  const still = cleanStep(step({ goal: null }))
  assert.equal(sceneArrival(still, null), false)
  assert.equal(still.arrived, true, 'no goal is where it already is')

  assert.ok(scenePace(chase) * 2.1 * 0.86 > 2.1 * 1.25, 'even the slowest bot runs fast enough for the run clip')
  assert.equal(scenePace(walk), 1)
})

test('each action plays its own clip once the bot is there, and never the Hit_A stagger', () => {
  const clips = {}
  for (const action of ACTIONS) clips[action] = sceneClip(cleanStep(step({ action })), null, 'idle', true)
  assert.deepEqual(clips, {
    walk: 'idle',
    talk: 'talk',
    wave: 'wave',
    stomp: 'stomp',
    sit: 'sitDown',
    stand: 'idle',
    cheer: 'cheer',
    jump: 'jump',
    run: 'idle',
    kick: 'kick',
  })
  assert.ok(!Object.values(clips).includes('hit'), 'anger is a stomp, not being hit')
  // On the way there, the feet win.
  assert.equal(sceneClip(cleanStep(step({ action: 'talk' })), 'walk', 'idle', true), 'walk')
  assert.equal(sceneClip(cleanStep(step({ action: 'run' })), 'run', 'idle', true), 'run')
})

test('a jump or a kick is played out, and a jump is a leap mid-chase', () => {
  const run = cleanStep(step({ action: 'run' }))
  const jump = cleanStep(step({ action: 'jump' }))
  assert.equal(sceneClip(jump, 'run', 'run', false), 'jump', 'a leap in the middle of a run')
  assert.equal(sceneClip(run, 'run', 'jump', false), 'jump', 'not cut off at the crouch')
  assert.equal(sceneClip(run, 'run', 'jump', true), 'run', 'and back to running once it lands')
  assert.equal(sceneClip(jump, null, 'jump', true), 'jump', 'held on landing, not jumping again')
  // A leap mid-chase is quick; a standing jump, and everything else, plays as authored.
  assert.equal(sceneRate('jump', 'run'), 2)
  assert.equal(sceneRate('jump', null), 1)
  for (const key of ['talk', 'stomp', 'kick', 'cheer', 'wave', 'sitDown']) assert.equal(sceneRate(key, null), 1, key)

  const kick = cleanStep(step({ action: 'kick' }))
  const cheer = cleanStep(step({ action: 'cheer' }))
  assert.equal(sceneClip(kick, null, 'kick', true), 'kick', 'the leg stays up while it is a kick')
  assert.equal(sceneClip(cheer, null, 'kick', false), 'kick', 'a kick under way finishes')
  assert.equal(sceneClip(cheer, null, 'kick', true), 'kickBack', 'then the leg comes down')
  assert.equal(sceneClip(cheer, 'walk', 'kickBack', false), 'kickBack')
  assert.equal(sceneClip(cheer, null, 'kickBack', true), 'cheer')
  assert.equal(sceneClip(kick, null, 'kickBack', true), 'kick', 'and up again for the next pass')
})

test('sitting goes down and stays down; standing up is played through first', () => {
  const sit = cleanStep(step({ action: 'sit' }))
  const stand = cleanStep(step({ action: 'stand' }))
  const cheer = cleanStep(step({ action: 'cheer' }))
  assert.equal(sceneClip(sit, null, 'idle', true), 'sitDown')
  assert.equal(sceneClip(sit, null, 'sitDown', false), 'sitDown')
  assert.equal(sceneClip(sit, null, 'sit', false), 'sit', 'the loop the sit-down hands over to')
  assert.equal(sceneClip(stand, null, 'sit', false), 'standUp')
  assert.equal(sceneClip(cheer, null, 'sitDown', true), 'standUp', 'nobody cheers from the floor')
  assert.equal(sceneClip(cheer, null, 'standUp', false), 'standUp')
  assert.equal(sceneClip(cheer, null, 'standUp', true), 'cheer')
  assert.equal(sceneClip(stand, null, 'standUp', true), 'idle')
})

test('a stomp is a hop off the ground and down hard, again and again; nothing else lifts', () => {
  const stomp = nextStep(null, cleanStep(step({ action: 'stomp' })))
  stomp.arrived = true
  let peak = 0
  let grounded = 0
  for (let t = 0; t < STOMP_EVERY; t += 0.01) {
    stomp.t = t
    const h = sceneHop(stomp)
    assert.ok(h >= 0 && h < 0.1, `${t}: ${h}`)
    peak = Math.max(peak, h)
    if (h === 0) grounded++
  }
  assert.ok(peak > 0.05, 'a hop you can see')
  assert.ok(grounded > 10, 'with a beat on the ground between')
  stomp.t = 0.1
  const once = sceneHop(stomp)
  stomp.t = 0.1 + STOMP_EVERY * 3
  assert.ok(Math.abs(sceneHop(stomp) - once) < 1e-9, 'and again')
  stomp.arrived = false
  assert.equal(sceneHop(stomp), 0, 'not while it is still walking over')
  for (const action of ACTIONS.filter((a) => a !== 'stomp')) {
    const s = nextStep(null, cleanStep(step({ action })))
    s.arrived = true
    s.t = 0.1
    assert.equal(sceneHop(s), 0, action)
  }
})

test('a face is a point, or a bot by id wherever it is now — never itself', () => {
  const where = (id) => ({ a: { x: 1, z: 2 }, b: { x: 5, z: 6 } })[id] || null
  assert.deepEqual(faceTarget({ x: 3, z: 4 }, 'a', where), { x: 3, z: 4 })
  assert.deepEqual(faceTarget('b', 'a', where), { x: 5, z: 6 })
  assert.equal(faceTarget('a', 'a', where), null)
  assert.equal(faceTarget('gone', 'a', where), null)
  assert.equal(faceTarget(null, 'a', where), null)
})

test('every step every scene can produce is one the bots understand', () => {
  const rand = mulberry32(7)
  const bot = (id, x) => ({ id, status: 'idle', pos: { x, z: 0 }, zone: 'z', owner: 'home', atWar: false, restUntil: 0 })
  const cast = [bot('a', 0), bot('b', 2), bot('c', 4), bot('d', 6)]
  for (const kind of ['chat', 'group', 'argue', 'heartbreak', 'play']) {
    for (let n = 0; n < 6; n++) {
      const scene = makeScene(kind, kind === 'group' || kind === 'play' ? cast : cast.slice(0, 2), 0, rand)
      for (let t = 0; t <= scene.durationMs; t += 250) {
        for (const [id, s] of Object.entries(scene.steps(t))) {
          const clean = cleanStep(s)
          assert.ok(clean, `${kind} ${id} at ${t}: ${JSON.stringify(s)}`)
          assert.ok(sceneClip(clean, null, 'idle', true) !== 'hit')
        }
      }
    }
  }
})
