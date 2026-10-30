import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { CARRY_LIFT, canGrab, carryTo, fallStep, followCarry, grab, homeRunFactor, isAirborne, release, startFall, FALL_DEPTH, FLAIL_RATE, stepCarryPose } from '../src/agents/carry.js'

const bot = (values = {}) => ({
  state: 'at-site',
  stateAge: 7,
  pos: new THREE.Vector3(3, 0, 4),
  vel: new THREE.Vector3(1, 0, 1),
  groundSpeed: 2,
  pathVersion: 5,
  stuckFor: 1,
  homeRun: false,
  ...values,
})

test('only bots that are out in the colony can be picked up', () => {
  for (const state of ['at-site', 'walking']) assert.equal(canGrab(bot({ state })), true, state)
  for (const state of ['queued', 'spawning', 'leaving', 'gone', 'held']) {
    assert.equal(canGrab(bot({ state })), false, state)
  }
})

test('grabbing stops the bot dead and marks it held', () => {
  const a = bot({ state: 'walking' })
  assert.equal(grab(a), true)
  assert.equal(a.state, 'held')
  assert.equal(a.vel.length(), 0)
  assert.equal(a.groundSpeed, 0)
  assert.equal(a.homeRun, false)
})

test('grabbing something that cannot be grabbed changes nothing', () => {
  const a = bot({ state: 'leaving' })
  assert.equal(grab(a), false)
  assert.equal(a.state, 'leaving')
  assert.equal(a.vel.length(), Math.SQRT2)
})

test('carrying sets a target and the bot eases toward it instead of jumping', () => {
  const a = bot()
  grab(a)
  carryTo(a, 10, -6)
  assert.deepEqual([a.pos.x, a.pos.z], [3, 4], 'not moved by the pointer alone')
  followCarry(a, 1 / 60)
  const d1 = Math.hypot(10 - a.pos.x, -6 - a.pos.z)
  assert.ok(d1 > 0 && d1 < Math.hypot(7, 10), 'moved partway')
  for (let i = 0; i < 120; i++) followCarry(a, 1 / 60)
  assert.ok(Math.hypot(10 - a.pos.x, -6 - a.pos.z) < 0.01, 'arrives')
  assert.equal(a.pos.y, 0)
})

test('the ease is frame-rate independent', () => {
  const run = (dt, n) => {
    const a = bot()
    grab(a)
    carryTo(a, 10, 4)
    for (let i = 0; i < n; i++) followCarry(a, dt)
    return a.pos.x
  }
  assert.ok(Math.abs(run(1 / 30, 15) - run(1 / 120, 60)) < 1e-9)
})

test('a free bot ignores carry calls', () => {
  const free = bot()
  carryTo(free, 10, -6)
  followCarry(free, 1 / 60)
  assert.deepEqual([free.pos.x, free.pos.z], [3, 4])
})

test('releasing sends it home as a fresh walk with the home-run speed-up', () => {
  const a = bot()
  grab(a)
  assert.equal(release(a), true)
  assert.equal(a.state, 'walking')
  assert.equal(a.stateAge, 0)
  assert.equal(a.pathVersion, -1)
  assert.equal(a.stuckFor, 0)
  assert.equal(a.homeRun, true)
})

test('releasing a bot that is not held does nothing', () => {
  const a = bot()
  assert.equal(release(a), false)
  assert.equal(a.state, 'at-site')
  assert.equal(a.homeRun, false)
})

test('home-run speed: a stroll when close, a run when far, and never silly', () => {
  assert.equal(homeRunFactor(0), 1)
  assert.equal(homeRunFactor(5), 1)
  // Past the walk/run line (the clip switches at 1.25x walk speed).
  assert.ok(homeRunFactor(20) > 1.25)
  assert.ok(homeRunFactor(10) < homeRunFactor(20))
  assert.equal(homeRunFactor(10_000), homeRunFactor(1_000))
  assert.ok(homeRunFactor(1_000) <= 3)
})

test('the lift is enough to read as picked up', () => {
  assert.ok(CARRY_LIFT > 0.3 && CARRY_LIFT < 2)
})

test('a bot is airborne while held and until it has landed after the drop, never when walking normally', () => {
  const a = bot({ hop: 0 })
  assert.equal(isAirborne(a), false)
  grab(a)
  assert.equal(isAirborne(a), true)
  a.hop = CARRY_LIFT
  release(a)
  assert.equal(isAirborne(a), true, 'still falling')
  a.hop = 0.02
  assert.equal(isAirborne(a), false, 'landed')
  const celebrating = bot({ state: 'walking', hop: 0.25, homeRun: false })
  assert.equal(isAirborne(celebrating), false, 'a happy hop is not a carry')
})

test('a bot dropped over the void falls, and only a held one can start to', () => {
  const free = bot()
  assert.equal(startFall(free), false)
  assert.equal(free.state, 'at-site')
  const a = bot({ hop: CARRY_LIFT })
  grab(a)
  assert.equal(startFall(a), true)
  assert.equal(a.state, 'falling')
  assert.equal(isAirborne(a), true, 'flailing all the way down')
  assert.equal(a.homeRun, false, 'it is not going home, it is going to respawn')
})

test('falling accelerates, and is over once it is well below the island', () => {
  const a = bot({ hop: 0 })
  grab(a)
  startFall(a)
  let prev = 0
  let last = 0
  let frames = 0
  while (!fallStep(a, 1 / 60)) {
    const drop = prev - a.hop
    assert.ok(drop >= last - 1e-9, 'never slows down')
    last = drop
    prev = a.hop
    assert.ok(++frames < 600, 'ends within ten seconds')
  }
  assert.ok(a.hop <= -FALL_DEPTH)
})

test('the flail runs fast enough to read as kicking', () => {
  assert.ok(FLAIL_RATE > 1.2 && FLAIL_RATE <= 2.1)
})

const settle = (a, seconds, dt = 1 / 60) => {
  for (let i = 0; i < seconds / dt; i++) stepCarryPose(a, dt)
}

test('being picked up pops the bot taller, then it springs back', () => {
  const a = bot({ hop: 0 })
  stepCarryPose(a, 1 / 60)
  grab(a)
  let peak = 1
  for (let i = 0; i < 90; i++) {
    a.stateAge += 1 / 60
    stepCarryPose(a, 1 / 60)
    peak = Math.max(peak, a.stretch)
  }
  assert.ok(peak > 1.15, `peak ${peak}`)
  assert.ok(Math.abs(a.stretch - 1) < 0.1, 'settles while still held')
})

test('carried sideways, the body swings out behind like something dangling', () => {
  const a = bot({ hop: CARRY_LIFT })
  grab(a)
  a.glideVx = 6
  a.glideVz = 0
  let lean = 0
  for (let i = 0; i < 30; i++) {
    a.stateAge += 1 / 60
    stepCarryPose(a, 1 / 60)
    lean = Math.min(lean, a.tiltZ)
  }
  assert.ok(lean < -0.1, `top leans toward the travel direction, lean ${lean}`)
  for (let i = 0; i < 600; i++) {
    a.stateAge += 1 / 60
    stepCarryPose(a, 1 / 60)
    assert.ok(Math.abs(a.tiltZ) <= 0.95 && Math.abs(a.tiltX) <= 0.95, 'never folds over')
  }
})

test('a held bot never goes still: it wriggles', () => {
  const a = bot({ hop: CARRY_LIFT })
  grab(a)
  const seen = []
  for (let i = 0; i < 120; i++) {
    a.stateAge += 1 / 60
    stepCarryPose(a, 1 / 60)
    seen.push(a.tiltZ)
  }
  assert.ok(Math.max(...seen) - Math.min(...seen) > 0.1)
})

test('landing squashes the bot, which then recovers', () => {
  const a = bot({ hop: CARRY_LIFT })
  grab(a)
  settle(a, 1)
  release(a)
  a.hop = 0.5
  stepCarryPose(a, 1 / 60)
  a.hop = 0
  let low = 1
  for (let i = 0; i < 90; i++) {
    stepCarryPose(a, 1 / 60)
    low = Math.min(low, a.stretch)
  }
  assert.ok(low < 0.85, `low ${low}`)
  settle(a, 3)
  assert.ok(Math.abs(a.stretch - 1) < 0.01)
  assert.ok(Math.abs(a.tiltX) < 0.01 && Math.abs(a.tiltZ) < 0.01)
})

test('falling tumbles head over heels', () => {
  const a = bot({ hop: 0 })
  grab(a)
  startFall(a)
  settle(a, 1)
  assert.ok(Math.abs(a.tiltX) > Math.PI, `rotated ${a.tiltX}`)
})

test('an ordinary bot is never posed', () => {
  const a = bot({ state: 'walking' })
  settle(a, 2)
  assert.equal(a.tiltX, 0)
  assert.equal(a.tiltZ, 0)
  assert.equal(a.stretch, 1)
})
